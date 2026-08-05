// api/andreani.js — Integración con la API oficial de Andreani (logística AR)
//
// Modelo de negocio: UNA sola cuenta Andreani a nivel plataforma (env vars).
// Los clientes de Growith pagan cada etiqueta con un saldo prepago (billetera
// en Firestore). El precio que ve el cliente = tarifa Andreani con IVA + markup
// (configurable por admin en andreani_config/global). El costo real de la
// plataforma NUNCA se le muestra a un cliente (solo a admins).
//
// Seguridad:
//  - Todas las acciones exigen ID token de Firebase (verifyAuth). La identidad
//    sale SIEMPRE del token, nunca de un uid mandado por el cliente.
//  - `emitir` re-cotiza server-side (jamás se confía en el precio del front) y
//    debita en transacción; si Andreani falla después del débito se hace un
//    reverso automático (segunda transacción + movimiento tipo "reverso").
//  - Etiquetas y trazas verifican pertenencia: solo podés bajar envíos tuyos.
//
// Firestore:
//  - users/{uid}.andreaniSaldo (number, pesos enteros)
//  - users/{uid}.andreaniOrigen / .andreaniRemitente (config del usuario)
//  - users/{uid}/andreani_mov/{autoId} — ledger {tipo, monto, saldoDespues, ...}
//  - andreani_config/global — {markupPct, markupFijo, habilitados:[uid]}
//  - andreani_config/token — cache del token de login (TTL 12h)
//  - andreani_config/suc_{cp} — cache de sucursales por CP (TTL 7 días)

import { randomBytes } from "crypto";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { verifyAuth, requireAdmin } from "./_auth.js";

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
  })});
  return getFirestore();
}

// ─── Config Andreani (todo por env vars, nada hardcodeado) ─────────────────

const ANDREANI_BASE = "https://apis.andreani.com";
const TOKEN_TTL_MS = 12 * 3600000;      // 12 horas
const SUC_TTL_MS   = 7 * 86400000;      // 7 días
const FETCH_TIMEOUT_MS = 25000;         // 25s por request a Andreani

function andreaniEnv() {
  const user     = process.env.ANDREANI_USER;
  const pass     = process.env.ANDREANI_PASS;
  const cliente  = process.env.ANDREANI_CLIENTE;
  const contratoEstandar = process.env.ANDREANI_CONTRATO_ESTANDAR;
  const contratoSucursal = process.env.ANDREANI_CONTRATO_SUCURSAL;
  if (!user || !pass || !cliente || !contratoEstandar || !contratoSucursal) return null;
  return { user, pass, cliente, contratoEstandar, contratoSucursal };
}

function contratoDe(env, tipo) {
  return tipo === "sucursal" ? env.contratoSucursal : env.contratoEstandar;
}

// ─── HTTP hacia Andreani (timeout 25s + token cacheado + retry ante 401) ───

async function fetchTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Andreani no respondió a tiempo (timeout 25s). Probá de nuevo en unos minutos.");
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// Login: GET /login con Basic auth; el token viene en el header
// x-authorization-token de la respuesta. Se cachea en andreani_config/token.
async function andreaniLogin(db, env) {
  const basic = Buffer.from(`${env.user}:${env.pass}`).toString("base64");
  const r = await fetchTimeout(`${ANDREANI_BASE}/login`, {
    headers: { Authorization: `Basic ${basic}` },
  });
  const token = r.headers.get("x-authorization-token");
  if (!r.ok || !token) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Login Andreani falló (HTTP ${r.status}). Verificá ANDREANI_USER/ANDREANI_PASS. ${txt.slice(0, 200)}`);
  }
  try {
    await db.collection("andreani_config").doc("token").set({ token, ts: Date.now() });
  } catch (_) { /* cache best-effort */ }
  return token;
}

async function getAndreaniToken(db, env, force = false) {
  if (!force) {
    try {
      const snap = await db.collection("andreani_config").doc("token").get();
      if (snap.exists) {
        const d = snap.data();
        if (d.token && Date.now() - (d.ts || 0) < TOKEN_TTL_MS) return d.token;
      }
    } catch (_) {}
  }
  return andreaniLogin(db, env);
}

// Request autenticado con retry: ante 401 re-loguea UNA vez y reintenta.
async function andreaniFetch(db, env, path, opts = {}) {
  let token = await getAndreaniToken(db, env);
  const doFetch = (tk) => fetchTimeout(`${ANDREANI_BASE}${path}`, {
    ...opts,
    headers: { ...(opts.headers || {}), "x-authorization-token": tk },
  });
  let r = await doFetch(token);
  if (r.status === 401) {
    token = await getAndreaniToken(db, env, true);
    r = await doFetch(token);
  }
  return r;
}

// Extrae un mensaje legible del body de error de Andreani.
async function andreaniError(r, contexto) {
  let detalle = "";
  try {
    const txt = await r.text();
    try {
      const j = JSON.parse(txt);
      detalle = j.message || j.detail || j.title || j.error ||
        (Array.isArray(j.errors) ? j.errors.map(e => e.message || e.detail || JSON.stringify(e)).join("; ") : "") ||
        txt;
    } catch (_) { detalle = txt; }
  } catch (_) {}
  return `${contexto} (HTTP ${r.status})${detalle ? `: ${String(detalle).slice(0, 400)}` : ""}`;
}

// ─── Markup / habilitación (andreani_config/global) ────────────────────────

async function getGlobalConfig(db) {
  try {
    const snap = await db.collection("andreani_config").doc("global").get();
    const d = snap.exists ? snap.data() : {};
    return {
      markupPct:  Number(d.markupPct)  || 0,
      markupFijo: Number(d.markupFijo) || 0,
      // Descuento comercial de la cuenta Andreani de la plataforma (p.ej. 30 = -30%).
      // /v1/tarifas devuelve tarifa de lista; el descuento se aplica en cta corriente,
      // así que lo modelamos acá para que costo y precio reflejen la realidad.
      descuentoPct: Math.min(Math.max(Number(d.descuentoPct) || 0, 0), 90),
      // % del valor declarado que Andreani factura como seguro (propuesta
      // comercial: 2%). No lleva el descuento de lista.
      seguroPct: Math.min(Math.max(d.seguroPct === undefined ? 2 : Number(d.seguroPct) || 0, 0), 10),
      // Código de sucursal de imposición (desde dónde se despacha). /v1/tarifas
      // tarifa distinto según origen; sin esto puede asumir otro y dar de más.
      sucursalOrigen: String(d.sucursalOrigen || "").trim(),
      habilitados: Array.isArray(d.habilitados) ? d.habilitados : [],
      // Datos de la cuenta donde los clientes transfieren las cargas de saldo.
      // Configurable desde Admin: hoy la cuenta de Soluna, mañana la de la
      // sociedad o el CVU de un PSP sin tocar nada más.
      datosPago: (d.datosPago && typeof d.datosPago === "object") ? {
        alias:   String(d.datosPago.alias || "").trim(),
        titular: String(d.datosPago.titular || "").trim(),
        cbu:     String(d.datosPago.cbu || "").trim(),
      } : { alias: "", titular: "", cbu: "" },
    };
  } catch (_) {
    return { markupPct: 0, markupFijo: 0, descuentoPct: 0, seguroPct: 2, sucursalOrigen: "", habilitados: [], datosPago: { alias: "", titular: "", cbu: "" } };
  }
}

// ¿Es admin de la plataforma? Mismo criterio que _auth.requireAdmin, pero sin
// re-verificar el token (ya lo verificamos): users/{uid}.isAdmin, ADMIN_UIDS
// (env) o fundadores.
const FOUNDERS = ["WJH3ArqDPQcNLha9lOinvkVi9uJ2"];
async function isPlatformAdmin(db, uid) {
  if (FOUNDERS.includes(uid)) return true;
  const envAdmins = String(process.env.ADMIN_UIDS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (envAdmins.includes(uid)) return true;
  try {
    const snap = await db.collection("users").doc(uid).get();
    return snap.exists && snap.data().isAdmin === true;
  } catch (_) { return false; }
}

// ─── Sucursales (por CP y listado completo para el buscador) ───────────────

function slimSucursal(s) {
  return {
    id: s.id,
    codigo: s.codigo ?? null,
    numero: s.numero ?? null,
    descripcion: s.descripcion || "",
    direccion: s.direccion || null,
    horarioDeAtencion: s.horarioDeAtencion || "",
  };
}

async function sucursalesPorCp(db, env, cp) {
  const cacheRef = db.collection("andreani_config").doc(`suc_${cp}`);
  try {
    const hit = await cacheRef.get();
    if (hit.exists) {
      const d = hit.data();
      if (Array.isArray(d.sucursales) && Date.now() - (d.ts || 0) < SUC_TTL_MS) return d.sucursales;
    }
  } catch (_) {}
  const r = await andreaniFetch(db, env, `/v2/sucursales?codigoPostal=${encodeURIComponent(cp)}&canal=B2C`);
  if (!r.ok) throw new Error(await andreaniError(r, "No se pudieron obtener las sucursales"));
  const raw = await r.json();
  const lista = Array.isArray(raw) ? raw : (raw?.sucursales || []);
  const sucursales = lista.map(slimSucursal);
  try { await cacheRef.set({ ts: Date.now(), sucursales }); } catch (_) {}
  return sucursales;
}

// Listado COMPLETO (para el buscador de sucursal de origen). Cacheado 7 días.
async function sucursalesTodas(db, env) {
  const cacheRef = db.collection("andreani_config").doc("suc_all");
  try {
    const hit = await cacheRef.get();
    if (hit.exists) {
      const d = hit.data();
      if (Array.isArray(d.sucursales) && d.sucursales.length && Date.now() - (d.ts || 0) < SUC_TTL_MS) return d.sucursales;
    }
  } catch (_) {}
  const r = await andreaniFetch(db, env, `/v2/sucursales`);
  if (!r.ok) throw new Error(await andreaniError(r, "No se pudo obtener el listado de sucursales"));
  const raw = await r.json();
  const lista = Array.isArray(raw) ? raw : (raw?.sucursales || []);
  const sucursales = lista.map(slimSucursal);
  try { await cacheRef.set({ ts: Date.now(), sucursales }); } catch (_) { /* si supera 1MB queda sin cache */ }
  return sucursales;
}

const nrmTxt = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// ─── Cotización (compartida entre `cotizar` y `emitir`) ────────────────────

function normalizarBultos(bultos) {
  const arr = Array.isArray(bultos) ? bultos : [];
  const out = arr.map(b => ({
    kilos:  Number(b.kilos)  || 0,
    largoCm: Number(b.largoCm) || 0,
    altoCm:  Number(b.altoCm)  || 0,
    anchoCm: Number(b.anchoCm) || 0,
    valorDeclarado: Math.round(Number(b.valorDeclarado) || 0),
  }));
  if (!out.length) return null;
  for (const b of out) {
    if (b.kilos <= 0 || b.largoCm <= 0 || b.altoCm <= 0 || b.anchoCm <= 0) return null;
  }
  return out;
}

// GET /v1/tarifas — bultos en formato indexado plano bultos[i][campo].
// Devuelve {tarifaTotal (número, con IVA), pesoAforado, raw}.
async function cotizarAndreani(db, env, { tipo, cpDestino, bultos, sucursalOrigen }) {
  const params = new URLSearchParams();
  params.set("cpDestino", String(cpDestino));
  params.set("contrato", contratoDe(env, tipo));
  params.set("cliente", env.cliente);
  if (sucursalOrigen) params.set("sucursalOrigen", String(sucursalOrigen));
  bultos.forEach((b, i) => {
    params.set(`bultos[${i}][volumen]`, String(b.largoCm * b.altoCm * b.anchoCm));
    params.set(`bultos[${i}][kilos]`, String(b.kilos));
    params.set(`bultos[${i}][valorDeclarado]`, String(b.valorDeclarado));
  });
  const r = await andreaniFetch(db, env, `/v1/tarifas?${params.toString()}`);
  if (!r.ok) throw new Error(await andreaniError(r, "No se pudo cotizar el envío"));
  const data = await r.json();
  const total = parseFloat(data?.tarifaConIva?.total);
  if (!isFinite(total) || total <= 0) {
    throw new Error(`Andreani devolvió una tarifa inválida: ${JSON.stringify(data).slice(0, 300)}`);
  }
  // Desglose: la propuesta comercial firmada dice que el seguro se factura
  // al seguroPct% del valor declarado SIN el descuento de lista, así que
  // necesitamos separar el componente seguro del de distribución.
  const seguroApi = parseFloat(data?.tarifaConIva?.seguroDistribucion);
  const valorDeclarado = bultos.reduce((s, b) => s + (parseFloat(b.valorDeclarado) || 0), 0);
  return {
    tarifaTotal: total,
    seguroApi: isFinite(seguroApi) && seguroApi >= 0 ? seguroApi : null,
    valorDeclarado,
    pesoAforado: data.pesoAforado ?? null,
    raw: data,
  };
}

// Sucursal de origen efectiva para tarifar: la confirmada por el usuario;
// fallback al valor global de config (legacy) o nada.
function sucOrigenDe(uData, cfg) {
  const so = uData?.andreaniSucOrigen;
  if (so?.confirmada) return String(so.numero || so.codigo || so.id || "") || cfg.sucursalOrigen || "";
  return cfg.sucursalOrigen || "";
}

// ─── Tracking oficial (named export para update-shipping.js) ───────────────

// Trae las trazas crudas de un envío por la API oficial autenticada.
// NUNCA tira: devuelve null si faltan env vars, si Andreani falla o si la
// respuesta no es JSON — el caller decide el fallback (scraping).
export async function trazasOficialAndreani(db, numeroDeEnvio) {
  try {
    const env = andreaniEnv();
    if (!env) return null;
    const num = String(numeroDeEnvio || "").trim().replace(/\s+/g, "");
    if (!num) return null;
    const r = await andreaniFetch(db, env, `/v1/envios/${encodeURIComponent(num)}/trazas`);
    if (!r.ok) return null;
    const data = await r.json();
    return data ?? null;
  } catch (_) {
    return null;
  }
}

// ─── Email (mismo patrón Resend que check-expiring.js) ─────────────────────

async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return { error: "missing" };
  const from = process.env.RESEND_FROM || "Growith <onboarding@resend.dev>";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json();
    if (!r.ok) { console.error("[andreani] email error:", data?.message); return { error: data?.message }; }
    return { ok: true, id: data.id };
  } catch (e) {
    console.error("[andreani] email fetch error:", e.message);
    return { error: e.message };
  }
}

// Mes actual en hora Argentina, formato YYYY-MM (para stats mensuales).
function mesAR() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit",
  }).format(new Date());
}

// Costo real según la propuesta comercial firmada (jul/2026):
// - distribución = tarifa de lista − descuentoPct (30% en el contrato)
// - seguro = seguroPct% del valor declarado (2% en el contrato), SIN descuento,
//   + IVA (las tarifas del contrato son sin IVA y acá trabajamos con IVA).
// Si la API no desglosa el seguro, fallback al modelo anterior (descuento
// sobre el total) para no inventar un seguro que quizás ya está adentro.
function costoConDescuento(cot, cfg) {
  const c = typeof cot === "number" ? { tarifaTotal: cot, seguroApi: null, valorDeclarado: 0 } : cot;
  const desc = 1 - (cfg.descuentoPct || 0) / 100;
  if (c.seguroApi == null) return c.tarifaTotal * desc;
  const distribucion = Math.max(0, c.tarifaTotal - c.seguroApi);
  const seguroContrato = (c.valorDeclarado || 0) * ((cfg.seguroPct ?? 2) / 100) * 1.21;
  return distribucion * desc + seguroContrato;
}
function precioConMarkup(cot, cfg) {
  return Math.ceil(costoConDescuento(cot, cfg) * (1 + cfg.markupPct / 100) + cfg.markupFijo);
}

// ─── Pertenencia de un envío (etiqueta/trazas) ─────────────────────────────

// Un usuario solo puede operar sobre numeroDeEnvio que estén en SU ledger o en
// SUS envíos. Queries de igualdad simple sobre subcolecciones chicas (sin
// índices compuestos).
async function envioPerteneceAlUid(db, uid, numero) {
  const num = String(numero);
  try {
    const mov = await db.collection("users").doc(uid).collection("andreani_mov")
      .where("numeroDeEnvio", "==", num).limit(1).get();
    if (!mov.empty) return true;
  } catch (_) {}
  try {
    const env = await db.collection("users").doc(uid).collection("envios")
      .where("andreani.numeroDeEnvio", "==", num).limit(1).get();
    if (!env.empty) return true;
  } catch (_) {}
  return false;
}

// ─── Handler ───────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  { const _o = String(req.headers.origin || ""); res.setHeader("Access-Control-Allow-Origin", (["https://www.growithapp.com","https://growithapp.com","https://soluna-gestion.vercel.app"].includes(_o) || _o.endsWith("-soluna1.vercel.app") || _o.startsWith("http://localhost")) ? _o : "https://www.growithapp.com"); } // allowlist CORS
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const db = initAdmin();

    let body;
    if (req.method === "GET") {
      body = req.query;
    } else if (req.body && typeof req.body === "object") {
      body = req.body;
    } else {
      const raw = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", c => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString()));
        req.on("error", reject);
      });
      body = raw ? JSON.parse(raw) : {};
    }

    const action = body.action || req.query?.action;
    if (!action) return res.status(400).json({ error: "action requerida" });

    // Todas las acciones exigen sesión válida. La identidad sale del TOKEN.
    const user = await verifyAuth(req);
    if (!user) return res.status(401).json({ error: "Sesión inválida. Recargá la página e iniciá sesión de nuevo." });
    const uid = user.uid;

    const env = andreaniEnv();
    if (!env) return res.status(500).json({ error: "andreani_no_configurado", detail: "Faltan variables de entorno de Andreani (ANDREANI_USER/PASS/CLIENTE/CONTRATO_*)." });

    const userRef = db.collection("users").doc(uid);
    const movCol  = userRef.collection("andreani_mov");

    // ── status ────────────────────────────────────────────────────────────
    if (action === "status") {
      const [cfg, snap, esAdmin, movSnap] = await Promise.all([
        getGlobalConfig(db), userRef.get(), isPlatformAdmin(db, uid),
        movCol.orderBy("ts", "desc").limit(20).get().catch(() => null),
      ]);
      const d = snap.exists ? snap.data() : {};
      const origen = d.andreaniOrigen || null;
      const remitente = d.andreaniRemitente || null;
      const origenConfigurado = !!(origen?.codigoPostal && origen?.calle && origen?.localidad && remitente?.nombreCompleto && remitente?.documentoNumero);
      const saldo = Math.round(Number(d.andreaniSaldo) || 0);
      // Estimación de etiquetas restantes: promedio de los últimos débitos.
      let etiquetasEstimadas = null;
      if (movSnap) {
        const debitos = movSnap.docs.map(x => x.data()).filter(m => m.tipo === "debito").slice(0, 10);
        if (debitos.length) {
          const avg = debitos.reduce((s, m) => s + (Number(m.monto) || 0), 0) / debitos.length;
          if (avg > 0) etiquetasEstimadas = Math.floor(saldo / avg);
        }
      }
      return res.json({
        ok: true,
        enabled: esAdmin || cfg.habilitados.includes(uid),
        saldo,
        etiquetasEstimadas,
        saldoBajo: etiquetasEstimadas != null && etiquetasEstimadas < 5,
        origenConfigurado,
        origen, remitente,
        sucOrigen: d.andreaniSucOrigen || null,
        esAdmin,
      });
    }

    // ── save_origen ───────────────────────────────────────────────────────
    if (action === "save_origen") {
      const { origen, remitente } = body;
      if (!origen || typeof origen !== "object" || !remitente || typeof remitente !== "object") {
        return res.status(400).json({ error: "origen y remitente requeridos" });
      }
      const o = {
        codigoPostal: String(origen.codigoPostal || "").trim(),
        calle:        String(origen.calle || "").trim(),
        numero:       String(origen.numero || "").trim(),
        localidad:    String(origen.localidad || "").trim(),
        region:       String(origen.region || "").trim(),
      };
      const rmt = {
        nombreCompleto:  String(remitente.nombreCompleto || "").trim(),
        documentoNumero: String(remitente.documentoNumero || "").replace(/[.\-\s]/g, ""),
        email:           String(remitente.email || "").trim(),
        telefono:        String(remitente.telefono || "").trim(),
      };
      if (!o.codigoPostal || !o.calle || !o.numero || !o.localidad) return res.status(400).json({ error: "El origen necesita código postal, calle, número y localidad." });
      if (!rmt.nombreCompleto || !rmt.documentoNumero) return res.status(400).json({ error: "El remitente necesita nombre completo y documento." });
      await userRef.set({ andreaniOrigen: o, andreaniRemitente: rmt }, { merge: true });
      // Sugerencia automática de sucursal de origen: la del CP del remitente.
      // No pisa una sucursal ya confirmada por el usuario.
      let sucOrigen = null;
      try {
        const prev = (await userRef.get()).data()?.andreaniSucOrigen;
        if (prev?.confirmada) {
          sucOrigen = prev;
        } else {
          const lista = await sucursalesPorCp(db, env, o.codigoPostal);
          if (lista.length) {
            sucOrigen = { ...lista[0], confirmada: false, ts: Date.now() };
            await userRef.set({ andreaniSucOrigen: sucOrigen }, { merge: true });
          }
        }
      } catch (_) { /* best-effort: sin sugerencia el front ofrece el buscador */ }
      return res.json({ ok: true, origen: o, remitente: rmt, sucOrigen });
    }

    // ── sucursales ────────────────────────────────────────────────────────
    if (action === "sucursales") {
      const cp = String(body.cp || "").replace(/\D/g, "");
      if (!cp) return res.status(400).json({ error: "cp requerido" });
      try {
        return res.json({ sucursales: await sucursalesPorCp(db, env, cp) });
      } catch (e) {
        return res.status(502).json({ error: e.message });
      }
    }

    // ── sucursales_buscar (buscador global: nombre, calle, número, localidad, CP)
    if (action === "sucursales_buscar") {
      const q = nrmTxt(String(body.q || "").trim());
      if (q.length < 2) return res.status(400).json({ error: "q requiere al menos 2 caracteres" });
      let todas;
      try { todas = await sucursalesTodas(db, env); }
      catch (e) { return res.status(502).json({ error: e.message }); }
      const tokens = q.split(/\s+/).filter(Boolean);
      const out = [];
      for (const s of todas) {
        const hay = nrmTxt([s.descripcion, s.codigo, s.numero, s.direccion?.calle, s.direccion?.numero, s.direccion?.localidad, s.direccion?.codigoPostal].filter(Boolean).join(" "));
        if (tokens.every(t => hay.includes(t))) {
          out.push(s);
          if (out.length >= 20) break;
        }
      }
      return res.json({ sucursales: out });
    }

    // ── sucursal_origen (desde dónde se emiten los envíos del usuario) ─────
    if (action === "sucursal_origen") {
      if (req.method === "POST") {
        // Confirmar la sugerida, o elegir otra por id del listado oficial.
        if (body.sucursalId != null) {
          let todas;
          try { todas = await sucursalesTodas(db, env); }
          catch (e) { return res.status(502).json({ error: e.message }); }
          const s = todas.find(x => String(x.id) === String(body.sucursalId));
          if (!s) return res.status(400).json({ error: "sucursalId no encontrado en el listado oficial" });
          const sucOrigen = { ...s, confirmada: true, ts: Date.now() };
          await userRef.set({ andreaniSucOrigen: sucOrigen }, { merge: true });
          return res.json({ ok: true, sucursal: sucOrigen });
        }
        if (body.confirmar) {
          const snap = await userRef.get();
          const so = snap.data()?.andreaniSucOrigen;
          if (!so?.id) return res.status(400).json({ error: "No hay sucursal de origen sugerida para confirmar" });
          const sucOrigen = { ...so, confirmada: true, ts: Date.now() };
          await userRef.set({ andreaniSucOrigen: sucOrigen }, { merge: true });
          return res.json({ ok: true, sucursal: sucOrigen });
        }
        return res.status(400).json({ error: "Mandá sucursalId o confirmar:true" });
      }
      const snap = await userRef.get();
      return res.json({ sucursal: snap.data()?.andreaniSucOrigen || null });
    }

    // ── cotizar ───────────────────────────────────────────────────────────
    if (action === "cotizar") {
      const tipo = body.tipo === "sucursal" ? "sucursal" : "domicilio";
      const cpDestino = String(body.cpDestino || "").replace(/\D/g, "");
      const bultos = normalizarBultos(body.bultos);
      if (!cpDestino) return res.status(400).json({ error: "cpDestino requerido" });
      if (!bultos) return res.status(400).json({ error: "bultos inválidos: cada bulto necesita kilos, largoCm, altoCm y anchoCm mayores a 0." });

      const [cfg, snap, esAdmin] = await Promise.all([
        getGlobalConfig(db), userRef.get(), isPlatformAdmin(db, uid),
      ]);
      if (!esAdmin && !cfg.habilitados.includes(uid)) return res.status(403).json({ error: "Tu cuenta no tiene habilitado Envíos Andreani. Contactá al soporte." });

      const cot = await cotizarAndreani(db, env, { tipo, cpDestino, bultos, sucursalOrigen: sucOrigenDe(snap.data(), cfg) });
      const precio = precioConMarkup(cot, cfg);
      const out = {
        precio,
        pesoAforado: cot.pesoAforado,
        saldo: Math.round(Number(snap.data()?.andreaniSaldo) || 0),
      };
      // El costo real solo lo ven los admins — los clientes NUNCA ven la tarifa.
      if (esAdmin) {
        out.tarifaAndreani = cot.tarifaTotal; // tarifa de lista (con IVA)
        out.seguroApi = cot.seguroApi;        // componente seguro de la lista (con IVA), null si no desglosa
        out.costoEstimado = Math.round(costoConDescuento(cot, cfg)); // distribución − desc + seguro contractual
        out.descuentoPct = cfg.descuentoPct;
        out.seguroPct = cfg.seguroPct;
      }
      return res.json(out);
    }

    // ── emitir ────────────────────────────────────────────────────────────
    if (action === "emitir") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
      const { envioId = null, destino, destinatario, productoAEntregar, piso, departamento } = body;
      const tipo = body.tipo === "sucursal" ? "sucursal" : "domicilio";
      const cpDestino = String(body.cpDestino || "").replace(/\D/g, "");
      const bultos = normalizarBultos(body.bultos);

      if (!cpDestino) return res.status(400).json({ error: "cpDestino requerido" });
      if (!bultos) return res.status(400).json({ error: "bultos inválidos: cada bulto necesita kilos, largoCm, altoCm y anchoCm mayores a 0." });
      if (!destinatario?.nombreCompleto) return res.status(400).json({ error: "destinatario.nombreCompleto requerido" });
      if (tipo === "sucursal") {
        if (!destino?.sucursalId) return res.status(400).json({ error: "destino.sucursalId requerido para envío a sucursal" });
      } else {
        const p = destino?.postal;
        if (!p?.codigoPostal || !p?.calle || !p?.numero || !p?.localidad) {
          return res.status(400).json({ error: "destino.postal necesita codigoPostal, calle, numero y localidad" });
        }
      }

      // a. Habilitación + origen configurado
      const [cfg, snap, esAdmin] = await Promise.all([
        getGlobalConfig(db), userRef.get(), isPlatformAdmin(db, uid),
      ]);
      if (!esAdmin && !cfg.habilitados.includes(uid)) return res.status(403).json({ error: "Tu cuenta no tiene habilitado Envíos Andreani. Contactá al soporte." });
      const uData = snap.exists ? snap.data() : {};
      const origen = uData.andreaniOrigen;
      const remitente = uData.andreaniRemitente;
      if (!origen?.codigoPostal || !origen?.calle || !remitente?.nombreCompleto || !remitente?.documentoNumero) {
        return res.status(400).json({ error: "origen_no_configurado", detail: "Configurá tu dirección de origen y datos de remitente antes de emitir (acción save_origen)." });
      }
      // La sucursal desde la que se despacha tiene que estar CONFIRMADA por el
      // usuario antes de emitir (la tarifa depende del origen).
      if (!uData.andreaniSucOrigen?.confirmada) {
        return res.status(400).json({ error: "sucursal_origen_no_confirmada", detail: "Confirmá desde qué sucursal Andreani despachás tus envíos antes de emitir etiquetas." });
      }

      const envioRef = envioId ? userRef.collection("envios").doc(String(envioId)) : null;

      // f. IDEMPOTENCIA: si el envío ya fue emitido, devolver lo guardado.
      if (envioRef) {
        const eSnap = await envioRef.get();
        const ya = eSnap.exists ? eSnap.data()?.andreani : null;
        if (ya?.numeroDeEnvio) {
          return res.json({
            ok: true, yaEmitido: true,
            numeroDeEnvio: ya.numeroDeEnvio,
            precio: ya.precio ?? null,
            saldoRestante: Math.round(Number(uData.andreaniSaldo) || 0),
            fechaEstimadaDeEntrega: ya.fechaEstimadaDeEntrega ?? null,
          });
        }
      }

      // b. RE-COTIZAR server-side — nunca confiar en el precio del cliente.
      const cot = await cotizarAndreani(db, env, { tipo, cpDestino, bultos, sucursalOrigen: sucOrigenDe(uData, cfg) });
      const precio = precioConMarkup(cot, cfg);

      // c. Débito en transacción (saldo + movimiento).
      const movRef = movCol.doc();
      let saldoRestante;
      try {
        saldoRestante = await db.runTransaction(async (tx) => {
          const s = await tx.get(userRef);
          const saldo = Math.round(Number(s.data()?.andreaniSaldo) || 0);
          if (saldo < precio) {
            const err = new Error("saldo_insuficiente");
            err.saldoInsuficiente = { saldo, precio };
            throw err;
          }
          const nuevo = saldo - precio;
          tx.set(userRef, { andreaniSaldo: nuevo }, { merge: true });
          tx.set(movRef, {
            tipo: "debito",
            monto: precio,
            saldoDespues: nuevo,
            nota: `Etiqueta Andreani ${tipo === "sucursal" ? "a sucursal" : "a domicilio"} · CP ${cpDestino}`,
            envioId: envioId || null,
            ts: FieldValue.serverTimestamp(),
          });
          return nuevo;
        });
      } catch (e) {
        if (e.saldoInsuficiente) {
          return res.status(402).json({ error: "saldo_insuficiente", ...e.saldoInsuficiente });
        }
        throw e;
      }

      // d. Crear la orden en Andreani. Si falla → reverso.
      const contrato = contratoDe(env, tipo);
      const destinoBody = tipo === "sucursal"
        ? { sucursal: { id: Number(destino.sucursalId) } }
        : { postal: {
            codigoPostal: String(destino.postal.codigoPostal).trim(),
            calle:        String(destino.postal.calle).trim(),
            numero:       String(destino.postal.numero).trim(),
            localidad:    String(destino.postal.localidad).trim(),
            region:       String(destino.postal.region || "").trim(),
            pais: "Argentina",
            componentesDeDireccion: [
              { meta: "piso", contenido: String(piso || destino.postal.piso || "") },
              { meta: "departamento", contenido: String(departamento || destino.postal.departamento || "") },
            ],
          } };
      const personaDe = (p) => ({
        nombreCompleto: String(p.nombreCompleto || "").trim(),
        email: String(p.email || "").trim(),
        documentoTipo: "DNI",
        documentoNumero: String(p.documentoNumero || "").replace(/[.\-\s]/g, ""),
        telefonos: [{ tipo: 1, numero: String(p.telefono || "").trim() }],
      });
      const orden = {
        contrato,
        origen: { postal: {
          codigoPostal: origen.codigoPostal, calle: origen.calle, numero: origen.numero,
          localidad: origen.localidad, region: origen.region || "", pais: "Argentina",
        } },
        destino: destinoBody,
        remitente: personaDe(remitente),
        destinatario: [personaDe(destinatario)],
        productoAEntregar: String(productoAEntregar || "Paquete"),
        bultos: bultos.map(b => ({
          kilos: b.kilos,
          largoCm: b.largoCm,
          altoCm: b.altoCm,
          anchoCm: b.anchoCm,
          volumenCm: b.largoCm * b.altoCm * b.anchoCm,
          valorDeclaradoConImpuestos: b.valorDeclarado,
          referencias: [
            { meta: "detalle", contenido: String(productoAEntregar || "Paquete") },
            { meta: "idCliente", contenido: String(envioId || uid) },
          ],
        })),
      };

      let ordenData = null, ordenErr = null;
      try {
        const r = await andreaniFetch(db, env, "/v2/ordenes-de-envio", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(orden),
        });
        if (!r.ok) ordenErr = await andreaniError(r, "Andreani rechazó la orden de envío");
        else {
          ordenData = await r.json();
          if (!ordenData?.bultos?.[0]?.numeroDeEnvio) {
            ordenErr = `Andreani no devolvió número de envío: ${JSON.stringify(ordenData).slice(0, 300)}`;
            ordenData = null;
          }
        }
      } catch (e) {
        ordenErr = e.message || "Error de red contra Andreani";
      }

      if (!ordenData) {
        // Reverso: segunda transacción que acredita lo debitado + movimiento.
        const revRef = movCol.doc();
        try {
          await db.runTransaction(async (tx) => {
            const s = await tx.get(userRef);
            const saldo = Math.round(Number(s.data()?.andreaniSaldo) || 0);
            const nuevo = saldo + precio;
            tx.set(userRef, { andreaniSaldo: nuevo }, { merge: true });
            tx.set(revRef, {
              tipo: "reverso",
              monto: precio,
              saldoDespues: nuevo,
              nota: `Reverso: la emisión falló — ${String(ordenErr).slice(0, 200)}`,
              envioId: envioId || null,
              ts: FieldValue.serverTimestamp(),
            });
          });
        } catch (e2) {
          // El reverso falló: NO ocultar — el saldo quedó debitado sin envío.
          console.error(`[andreani] REVERSO FALLIDO uid=${uid} precio=${precio}:`, e2.message);
          return res.status(502).json({ error: `${ordenErr} — ADEMÁS falló el reverso del saldo: contactá al soporte con este mensaje.` });
        }
        return res.status(502).json({ error: ordenErr, reversado: true });
      }

      // e. Guardar resultado + completar el movimiento con el número de envío.
      const numeroDeEnvio = String(ordenData.bultos[0].numeroDeEnvio);
      const andreaniInfo = {
        numeroDeEnvio,
        estado: ordenData.estado || "Pendiente",
        precio,
        contrato,
        tipo,
        fechaEstimadaDeEntrega: ordenData.fechaEstimadaDeEntrega || null,
        ts: FieldValue.serverTimestamp(),
      };
      const writes = [movRef.set({ numeroDeEnvio }, { merge: true })];
      if (envioRef) writes.push(envioRef.set({ andreani: andreaniInfo }, { merge: true }));
      await Promise.all(writes);

      // Stats mensuales de rentabilidad (best-effort, fuera de la transacción).
      try {
        await db.collection("andreani_config").doc(`stats_${mesAR()}`).set({
          facturado: FieldValue.increment(precio),
          costoReal: FieldValue.increment(Math.round(costoConDescuento(cot, cfg))),
          etiquetas: FieldValue.increment(1),
          porUid: { [uid]: {
            monto: FieldValue.increment(precio),
            etiquetas: FieldValue.increment(1),
          } },
        }, { merge: true });
      } catch (e) { console.error("[andreani] stats:", e.message); }

      // Alerta de saldo bajo: si lo que queda alcanza para menos de 5 etiquetas
      // al precio recién cobrado, aviso por mail (best-effort, throttle 24h).
      const etiquetasEstimadas = precio > 0 ? Math.floor(saldoRestante / precio) : null;
      const saldoBajo = etiquetasEstimadas != null && etiquetasEstimadas < 5;
      if (saldoBajo) {
        try {
          const lastTs = Number(uData.andreaniAvisoSaldoTs) || 0;
          if (Date.now() - lastTs > 24 * 3600000) {
            await userRef.set({ andreaniAvisoSaldoTs: Date.now() }, { merge: true });
            const destinos = new Set();
            if (uData.email) destinos.add(String(uData.email).trim());
            if (process.env.ALERT_EMAIL) {
              destinos.add(String(process.env.ALERT_EMAIL).trim());
            } else {
              try {
                const f = await db.collection("users").doc(FOUNDERS[0]).get();
                if (f.exists && f.data().email) destinos.add(String(f.data().email).trim());
              } catch (_) {}
            }
            const html = `<div style="font-family:Inter,system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fff;color:#374151">
  <div style="font-size:18px;font-weight:700;color:#111827;margin-bottom:16px">Saldo de envíos bajo</div>
  <p style="font-size:14px">La cuenta ${uData.email || uid} emitió una etiqueta Andreani y el saldo restante es <strong>$${saldoRestante.toLocaleString("es-AR")}</strong>.</p>
  <p style="font-size:14px">Al precio de la última etiqueta ($${precio.toLocaleString("es-AR")}) alcanza para aproximadamente <strong>${etiquetasEstimadas} etiqueta${etiquetasEstimadas === 1 ? "" : "s"} más</strong>.</p>
  <p style="font-size:13px">Para seguir emitiendo sin interrupciones, cargá saldo desde la sección Envíos de Growith o contactá al soporte para acreditar una recarga.</p>
  <p style="font-size:12px;color:#9ca3af;text-align:center;margin-top:24px">Growith — Envíos</p>
</div>`;
            await Promise.allSettled([...destinos].filter(Boolean).map(to =>
              sendEmail({ to, subject: "Saldo de envíos bajo en Growith", html })
            ));
          }
        } catch (e) { console.error("[andreani] aviso saldo bajo:", e.message); }
      }

      return res.json({
        ok: true,
        numeroDeEnvio,
        precio,
        saldoRestante,
        etiquetasEstimadas,
        saldoBajo,
        fechaEstimadaDeEntrega: ordenData.fechaEstimadaDeEntrega || null,
        estado: ordenData.estado || "Pendiente",
      });
    }

    // ── etiqueta ──────────────────────────────────────────────────────────
    if (action === "etiqueta") {
      const numero = String(body.numero || "").trim();
      if (!numero) return res.status(400).json({ error: "numero requerido" });
      const esAdmin = await isPlatformAdmin(db, uid);
      if (!esAdmin && !(await envioPerteneceAlUid(db, uid, numero))) {
        return res.status(403).json({ error: "Ese envío no pertenece a tu cuenta." });
      }
      const r = await andreaniFetch(db, env, `/v2/ordenes-de-envio/${encodeURIComponent(numero)}/etiquetas`);
      if (r.status === 404) return res.json({ pending: true });
      if (!r.ok) return res.status(502).json({ error: await andreaniError(r, "No se pudo obtener la etiqueta") });
      const ct = String(r.headers.get("content-type") || "");
      const buf = Buffer.from(await r.arrayBuffer());
      // Si la orden sigue "Pendiente" la etiqueta puede no estar lista todavía.
      if (!buf.length || (!ct.includes("pdf") && !buf.slice(0, 5).toString().startsWith("%PDF"))) {
        return res.json({ pending: true });
      }
      return res.json({ pdf: buf.toString("base64") });
    }

    // ── saldo ─────────────────────────────────────────────────────────────
    if (action === "saldo") {
      const [snap, movSnap] = await Promise.all([
        userRef.get(),
        movCol.orderBy("ts", "desc").limit(50).get(),
      ]);
      return res.json({
        saldo: Math.round(Number(snap.data()?.andreaniSaldo) || 0),
        movimientos: movSnap.docs.map(d => ({ _id: d.id, ...d.data() })),
      });
    }

    // ── Cargas de saldo (transferencia + referencia única) ────────────────
    // Colección top-level andreani_cargas: {uid, email, monto, ref, estado,
    // ts, resueltaTs?, adminUid?, motivo?}. Queries solo por UN campo (uid o
    // estado) para no necesitar índices compuestos.
    if (action === "carga_solicitar") {
      const cfg = await getGlobalConfig(db);
      const esAdmin = await isPlatformAdmin(db, uid);
      if (!esAdmin && !cfg.habilitados.includes(uid)) return res.status(403).json({ error: "Tu cuenta no tiene Andreani prepago habilitado." });
      const monto = Math.round(Number(body.monto));
      if (!isFinite(monto) || monto < 1000) return res.status(400).json({ error: "El monto mínimo de carga es $1.000." });
      if (monto > 10000000) return res.status(400).json({ error: "Monto demasiado alto." });
      const cargasCol = db.collection("andreani_cargas");
      // Máx 3 pendientes por cuenta (filtrado en memoria: where por un solo campo)
      const propias = await cargasCol.where("uid", "==", uid).limit(30).get();
      const pendientes = propias.docs.filter(x => x.data().estado === "pendiente");
      if (pendientes.length >= 3) return res.status(400).json({ error: "Ya tenés 3 cargas pendientes. Cancelá alguna o esperá a que se acrediten." });
      const ref = "GW-" + Array.from(randomBytes(4)).map(b => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
      const uSnap = await userRef.get();
      const email = String(uSnap.data()?.email || user.email || "").trim();
      const docRef = await cargasCol.add({
        uid, email, monto, ref, estado: "pendiente", ts: FieldValue.serverTimestamp(),
      });
      // Aviso al admin (best-effort): hay una carga esperando acreditación.
      try {
        const f = await db.collection("users").doc(FOUNDERS[0]).get();
        const to = f.exists ? String(f.data().email || "").trim() : "";
        if (to) {
          await sendEmail({
            to, subject: `Carga de saldo pendiente: $${monto.toLocaleString("es-AR")} (${ref})`,
            html: `<div style="font-family:Inter,system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fff;color:#374151">
  <div style="font-size:18px;font-weight:700;color:#111827;margin-bottom:16px">Nueva carga de saldo pendiente</div>
  <p style="font-size:14px">La cuenta <strong>${email || uid}</strong> informó una transferencia de <strong>$${monto.toLocaleString("es-AR")}</strong> con referencia <strong>${ref}</strong>.</p>
  <p style="font-size:13px">Verificá el ingreso en la cuenta y acreditala desde Admin &rarr; Env&iacute;os &rarr; Cargas pendientes.</p>
  <p style="font-size:12px;color:#9ca3af;text-align:center;margin-top:24px">Growith — Env&iacute;os</p>
</div>`,
          });
        }
      } catch (_) {}
      return res.json({ ok: true, carga: { id: docRef.id, ref, monto, estado: "pendiente" }, datosPago: cfg.datosPago });
    }

    if (action === "cargas") {
      const cfg = await getGlobalConfig(db);
      const snap = await db.collection("andreani_cargas").where("uid", "==", uid).limit(30).get();
      const cargas = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.ts?.toMillis?.() || 0) - (a.ts?.toMillis?.() || 0))
        .slice(0, 10)
        .map(c => ({ id: c.id, ref: c.ref, monto: c.monto, estado: c.estado, ts: c.ts?.toMillis?.() || null, motivo: c.motivo || "" }));
      return res.json({ ok: true, cargas, datosPago: cfg.datosPago });
    }

    if (action === "carga_cancelar") {
      const id = String(body.id || "").trim();
      if (!id) return res.status(400).json({ error: "id requerido" });
      const ref = db.collection("andreani_cargas").doc(id);
      await db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (!s.exists || s.data().uid !== uid) throw new Error("Carga no encontrada.");
        if (s.data().estado !== "pendiente") throw new Error("Esa carga ya fue procesada.");
        tx.update(ref, { estado: "cancelada", resueltaTs: FieldValue.serverTimestamp() });
      });
      return res.json({ ok: true });
    }

    // ── trazas ────────────────────────────────────────────────────────────
    if (action === "trazas") {
      const numero = String(body.numero || "").trim();
      if (!numero) return res.status(400).json({ error: "numero requerido" });
      const esAdmin = await isPlatformAdmin(db, uid);
      if (!esAdmin && !(await envioPerteneceAlUid(db, uid, numero))) {
        return res.status(403).json({ error: "Ese envío no pertenece a tu cuenta." });
      }
      const r = await andreaniFetch(db, env, `/v1/envios/${encodeURIComponent(numero)}/trazas`);
      if (!r.ok) return res.status(502).json({ error: await andreaniError(r, "No se pudieron obtener las trazas") });
      const data = await r.json();
      return res.json({ trazas: data });
    }

    // ── ACCIONES ADMIN ────────────────────────────────────────────────────
    const adminActions = ["admin_acreditar", "admin_config", "admin_movimientos", "admin_saldos", "admin_stats", "admin_cargas", "admin_carga_acreditar", "admin_carga_rechazar"];
    if (adminActions.includes(action)) {
      const adm = await requireAdmin(req);
      if (!adm.ok) return res.status(adm.code).json({ error: adm.error });

      if (action === "admin_acreditar") {
        const targetUid = String(body.uid || "").trim();
        const monto = Math.round(Number(body.monto));
        const nota = String(body.nota || "").trim();
        if (!targetUid) return res.status(400).json({ error: "uid requerido" });
        if (!isFinite(monto) || monto === 0) return res.status(400).json({ error: "monto inválido (entero distinto de 0; negativo para ajustes)" });
        const tRef = db.collection("users").doc(targetUid);
        const tMov = tRef.collection("andreani_mov").doc();
        const nuevoSaldo = await db.runTransaction(async (tx) => {
          const s = await tx.get(tRef);
          if (!s.exists) throw new Error("El usuario no existe.");
          const saldo = Math.round(Number(s.data()?.andreaniSaldo) || 0);
          const nuevo = saldo + monto;
          tx.set(tRef, { andreaniSaldo: nuevo }, { merge: true });
          tx.set(tMov, {
            tipo: "credito",
            monto,
            saldoDespues: nuevo,
            nota: nota || (monto > 0 ? "Acreditación de saldo" : "Ajuste de saldo"),
            adminUid: adm.user.uid,
            ts: FieldValue.serverTimestamp(),
          });
          return nuevo;
        });
        return res.json({ ok: true, uid: targetUid, saldo: nuevoSaldo });
      }

      // Cargas de saldo pendientes de todas las cuentas (where por un campo).
      if (action === "admin_cargas") {
        const snap = await db.collection("andreani_cargas").where("estado", "==", "pendiente").limit(50).get();
        const cargas = snap.docs.map(d => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (a.ts?.toMillis?.() || 0) - (b.ts?.toMillis?.() || 0))
          .map(c => ({ id: c.id, uid: c.uid, email: c.email || "", ref: c.ref, monto: c.monto, ts: c.ts?.toMillis?.() || null }));
        return res.json({ ok: true, cargas });
      }

      // Acreditar una carga: transacción única — marca la carga como acreditada
      // Y suma el saldo con su movimiento en el ledger. Idempotente por estado.
      if (action === "admin_carga_acreditar") {
        const id = String(body.id || "").trim();
        if (!id) return res.status(400).json({ error: "id requerido" });
        const cRef = db.collection("andreani_cargas").doc(id);
        const out = await db.runTransaction(async (tx) => {
          const s = await tx.get(cRef);
          if (!s.exists) throw new Error("Carga no encontrada.");
          const c = s.data();
          if (c.estado !== "pendiente") throw new Error(`Esa carga ya está ${c.estado}.`);
          const tRef = db.collection("users").doc(c.uid);
          const uSnap = await tx.get(tRef);
          if (!uSnap.exists) throw new Error("El usuario de la carga no existe.");
          const saldo = Math.round(Number(uSnap.data()?.andreaniSaldo) || 0);
          const nuevo = saldo + Math.round(Number(c.monto) || 0);
          tx.update(cRef, { estado: "acreditada", adminUid: adm.user.uid, resueltaTs: FieldValue.serverTimestamp() });
          tx.set(tRef, { andreaniSaldo: nuevo }, { merge: true });
          tx.set(tRef.collection("andreani_mov").doc(), {
            tipo: "credito", monto: Math.round(Number(c.monto) || 0), saldoDespues: nuevo,
            nota: `Carga de saldo ${c.ref}`, adminUid: adm.user.uid, ts: FieldValue.serverTimestamp(),
          });
          return { uid: c.uid, email: c.email || "", monto: Math.round(Number(c.monto) || 0), ref: c.ref, saldo: nuevo };
        });
        // Aviso al cliente (best-effort)
        if (out.email) {
          try {
            await sendEmail({
              to: out.email, subject: `Se acreditó tu carga de $${out.monto.toLocaleString("es-AR")}`,
              html: `<div style="font-family:Inter,system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fff;color:#374151">
  <div style="font-size:18px;font-weight:700;color:#111827;margin-bottom:16px">Carga acreditada</div>
  <p style="font-size:14px">Tu carga <strong>${out.ref}</strong> de <strong>$${out.monto.toLocaleString("es-AR")}</strong> ya está disponible. Saldo actual: <strong>$${out.saldo.toLocaleString("es-AR")}</strong>.</p>
  <p style="font-size:13px">Ya podés emitir etiquetas desde la sección Env&iacute;os de Growith.</p>
  <p style="font-size:12px;color:#9ca3af;text-align:center;margin-top:24px">Growith — Env&iacute;os</p>
</div>`,
            });
          } catch (_) {}
        }
        return res.json({ ok: true, ...out });
      }

      if (action === "admin_carga_rechazar") {
        const id = String(body.id || "").trim();
        const motivo = String(body.motivo || "").trim().slice(0, 200);
        if (!id) return res.status(400).json({ error: "id requerido" });
        const cRef = db.collection("andreani_cargas").doc(id);
        await db.runTransaction(async (tx) => {
          const s = await tx.get(cRef);
          if (!s.exists) throw new Error("Carga no encontrada.");
          if (s.data().estado !== "pendiente") throw new Error(`Esa carga ya está ${s.data().estado}.`);
          tx.update(cRef, { estado: "rechazada", motivo, adminUid: adm.user.uid, resueltaTs: FieldValue.serverTimestamp() });
        });
        return res.json({ ok: true });
      }

      if (action === "admin_config") {
        const gRef = db.collection("andreani_config").doc("global");
        if (req.method === "POST" && (body.markupPct !== undefined || body.markupFijo !== undefined || body.habilitados !== undefined || body.descuentoPct !== undefined || body.seguroPct !== undefined || body.sucursalOrigen !== undefined || body.datosPago !== undefined)) {
          const upd = {};
          if (body.markupPct !== undefined) {
            const v = Number(body.markupPct);
            if (!isFinite(v) || v < 0) return res.status(400).json({ error: "markupPct inválido" });
            upd.markupPct = v;
          }
          if (body.markupFijo !== undefined) {
            const v = Math.round(Number(body.markupFijo));
            if (!isFinite(v) || v < 0) return res.status(400).json({ error: "markupFijo inválido" });
            upd.markupFijo = v;
          }
          if (body.descuentoPct !== undefined) {
            const v = Number(body.descuentoPct);
            if (!isFinite(v) || v < 0 || v > 90) return res.status(400).json({ error: "descuentoPct inválido (0-90)" });
            upd.descuentoPct = v;
          }
          if (body.seguroPct !== undefined) {
            const v = Number(body.seguroPct);
            if (!isFinite(v) || v < 0 || v > 10) return res.status(400).json({ error: "seguroPct inválido (0-10)" });
            upd.seguroPct = v;
          }
          if (body.sucursalOrigen !== undefined) {
            upd.sucursalOrigen = String(body.sucursalOrigen || "").trim().slice(0, 20);
          }
          if (body.habilitados !== undefined) {
            if (!Array.isArray(body.habilitados)) return res.status(400).json({ error: "habilitados debe ser un array de uids" });
            upd.habilitados = body.habilitados.map(String).filter(Boolean);
          }
          if (body.datosPago !== undefined) {
            const p = body.datosPago || {};
            upd.datosPago = {
              alias:   String(p.alias || "").trim().slice(0, 60),
              titular: String(p.titular || "").trim().slice(0, 80),
              cbu:     String(p.cbu || "").replace(/\D/g, "").slice(0, 22),
            };
          }
          await gRef.set(upd, { merge: true });
        }
        const cfg = await getGlobalConfig(db);
        return res.json({ ok: true, ...cfg });
      }

      if (action === "admin_movimientos") {
        const targetUid = String(body.uid || "").trim();
        if (!targetUid) return res.status(400).json({ error: "uid requerido" });
        const [s, movSnap] = await Promise.all([
          db.collection("users").doc(targetUid).get(),
          db.collection("users").doc(targetUid).collection("andreani_mov").orderBy("ts", "desc").limit(100).get(),
        ]);
        return res.json({
          uid: targetUid,
          saldo: Math.round(Number(s.data()?.andreaniSaldo) || 0),
          movimientos: movSnap.docs.map(d => ({ _id: d.id, ...d.data() })),
        });
      }

      if (action === "admin_stats") {
        // Rentabilidad mensual de etiquetas: andreani_config/stats_{YYYY-MM}.
        const mes = /^\d{4}-\d{2}$/.test(String(body.mes || "")) ? String(body.mes) : mesAR();
        const snap = await db.collection("andreani_config").doc(`stats_${mes}`).get();
        const d = snap.exists ? snap.data() : {};
        const porUid = (d.porUid && typeof d.porUid === "object") ? d.porUid : {};
        const uids = Object.keys(porUid).slice(0, 30);
        const emails = {};
        if (uids.length) {
          try {
            const snaps = await db.getAll(...uids.map(u => db.collection("users").doc(u)));
            snaps.forEach(s => { if (s.exists) emails[s.id] = s.data().email || ""; });
          } catch (_) { /* sin emails: se devuelven solo uids */ }
        }
        const cuentas = uids.map(u => ({
          uid: u,
          email: emails[u] || "",
          monto: Math.round(Number(porUid[u]?.monto) || 0),
          etiquetas: Number(porUid[u]?.etiquetas) || 0,
        })).sort((a, b) => b.monto - a.monto);
        const facturado = Math.round(Number(d.facturado) || 0);
        const costoReal = Math.round(Number(d.costoReal) || 0);
        return res.json({
          mes,
          facturado,
          costoReal,
          margen: facturado - costoReal,
          etiquetas: Number(d.etiquetas) || 0,
          cuentas,
        });
      }

      if (action === "admin_saldos") {
        // Con saldo > 0 (inequality sobre un solo campo: no requiere índice
        // compuesto) + los habilitados en la config aunque tengan saldo 0
        // + SIEMPRE el propio admin (para poder acreditarse a sí mismo)
        // + búsqueda opcional por email exacto (&email=) para cargar cualquier cuenta.
        const cfg = await getGlobalConfig(db);
        const conSaldo = await db.collection("users").where("andreaniSaldo", ">", 0).get();
        const porUid = new Map();
        conSaldo.docs.forEach(d => {
          const dd = d.data();
          porUid.set(d.id, { uid: d.id, email: dd.email || "", saldo: Math.round(Number(dd.andreaniSaldo) || 0) });
        });
        const faltantes = [...new Set([...cfg.habilitados, uid])].filter(u => !porUid.has(u));
        if (faltantes.length) {
          const snaps = await Promise.all(faltantes.map(u => db.collection("users").doc(u).get()));
          snaps.forEach((s, i) => {
            porUid.set(faltantes[i], {
              uid: faltantes[i],
              email: s.exists ? (s.data().email || "") : "",
              saldo: s.exists ? Math.round(Number(s.data().andreaniSaldo) || 0) : 0,
            });
          });
        }
        const email = String(body.email || "").trim().toLowerCase();
        if (email) {
          try {
            const q = await db.collection("users").where("email", "==", email).limit(5).get();
            q.docs.forEach(d => {
              if (!porUid.has(d.id)) {
                const dd = d.data();
                porUid.set(d.id, { uid: d.id, email: dd.email || "", saldo: Math.round(Number(dd.andreaniSaldo) || 0) });
              }
            });
            if (q.empty) return res.json({ cuentas: [], busqueda: email, sinResultados: true, markupPct: cfg.markupPct, markupFijo: cfg.markupFijo });
            const soloMatch = [...porUid.values()].filter(c => (c.email || "").toLowerCase() === email)
              .map(c => ({ ...c, habilitado: cfg.habilitados.includes(c.uid) }));
            return res.json({ cuentas: soloMatch, busqueda: email, markupPct: cfg.markupPct, markupFijo: cfg.markupFijo });
          } catch (e) {
            return res.status(500).json({ error: "No se pudo buscar por email: " + e.message });
          }
        }
        const cuentas = [...porUid.values()].map(c => ({ ...c, habilitado: cfg.habilitados.includes(c.uid) }))
          .sort((a, b) => b.saldo - a.saldo);
        return res.json({ cuentas, markupPct: cfg.markupPct, markupFijo: cfg.markupFijo });
      }
    }

    return res.status(400).json({ error: `Acción desconocida: ${action}` });
  } catch (e) {
    console.error("[andreani]", e);
    return res.status(500).json({ error: e.message || "Error interno" });
  }
}
