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
      habilitados: Array.isArray(d.habilitados) ? d.habilitados : [],
    };
  } catch (_) {
    return { markupPct: 0, markupFijo: 0, descuentoPct: 0, habilitados: [] };
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
async function cotizarAndreani(db, env, { tipo, cpDestino, bultos }) {
  const params = new URLSearchParams();
  params.set("cpDestino", String(cpDestino));
  params.set("contrato", contratoDe(env, tipo));
  params.set("cliente", env.cliente);
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
  return { tarifaTotal: total, pesoAforado: data.pesoAforado ?? null, raw: data };
}

function costoConDescuento(tarifaTotal, cfg) {
  return tarifaTotal * (1 - (cfg.descuentoPct || 0) / 100);
}
function precioConMarkup(tarifaTotal, cfg) {
  return Math.ceil(costoConDescuento(tarifaTotal, cfg) * (1 + cfg.markupPct / 100) + cfg.markupFijo);
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
      const [cfg, snap, esAdmin] = await Promise.all([
        getGlobalConfig(db), userRef.get(), isPlatformAdmin(db, uid),
      ]);
      const d = snap.exists ? snap.data() : {};
      const origen = d.andreaniOrigen || null;
      const remitente = d.andreaniRemitente || null;
      const origenConfigurado = !!(origen?.codigoPostal && origen?.calle && origen?.localidad && remitente?.nombreCompleto && remitente?.documentoNumero);
      return res.json({
        ok: true,
        enabled: esAdmin || cfg.habilitados.includes(uid),
        saldo: Math.round(Number(d.andreaniSaldo) || 0),
        origenConfigurado,
        origen, remitente,
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
      return res.json({ ok: true, origen: o, remitente: rmt });
    }

    // ── sucursales ────────────────────────────────────────────────────────
    if (action === "sucursales") {
      const cp = String(body.cp || "").replace(/\D/g, "");
      if (!cp) return res.status(400).json({ error: "cp requerido" });
      const cacheRef = db.collection("andreani_config").doc(`suc_${cp}`);
      try {
        const hit = await cacheRef.get();
        if (hit.exists) {
          const d = hit.data();
          if (Array.isArray(d.sucursales) && Date.now() - (d.ts || 0) < SUC_TTL_MS) {
            return res.json({ sucursales: d.sucursales, cached: true });
          }
        }
      } catch (_) {}
      const r = await andreaniFetch(db, env, `/v2/sucursales?codigoPostal=${encodeURIComponent(cp)}&canal=B2C`);
      if (!r.ok) return res.status(502).json({ error: await andreaniError(r, "No se pudieron obtener las sucursales") });
      const raw = await r.json();
      const lista = Array.isArray(raw) ? raw : (raw?.sucursales || []);
      const sucursales = lista.map(s => ({
        id: s.id,
        codigo: s.codigo ?? null,
        descripcion: s.descripcion || "",
        direccion: s.direccion || null,
        horarioDeAtencion: s.horarioDeAtencion || "",
      }));
      try { await cacheRef.set({ ts: Date.now(), sucursales }); } catch (_) {}
      return res.json({ sucursales });
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

      const cot = await cotizarAndreani(db, env, { tipo, cpDestino, bultos });
      const precio = precioConMarkup(cot.tarifaTotal, cfg);
      const out = {
        precio,
        pesoAforado: cot.pesoAforado,
        saldo: Math.round(Number(snap.data()?.andreaniSaldo) || 0),
      };
      // El costo real solo lo ven los admins — los clientes NUNCA ven la tarifa.
      if (esAdmin) {
        out.tarifaAndreani = cot.tarifaTotal; // tarifa de lista (con IVA)
        out.costoEstimado = Math.round(costoConDescuento(cot.tarifaTotal, cfg)); // con descuento cta cte
        out.descuentoPct = cfg.descuentoPct;
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
      const cot = await cotizarAndreani(db, env, { tipo, cpDestino, bultos });
      const precio = precioConMarkup(cot.tarifaTotal, cfg);

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

      return res.json({
        ok: true,
        numeroDeEnvio,
        precio,
        saldoRestante,
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
    const adminActions = ["admin_acreditar", "admin_config", "admin_movimientos", "admin_saldos"];
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

      if (action === "admin_config") {
        const gRef = db.collection("andreani_config").doc("global");
        if (req.method === "POST" && (body.markupPct !== undefined || body.markupFijo !== undefined || body.habilitados !== undefined || body.descuentoPct !== undefined)) {
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
          if (body.habilitados !== undefined) {
            if (!Array.isArray(body.habilitados)) return res.status(400).json({ error: "habilitados debe ser un array de uids" });
            upd.habilitados = body.habilitados.map(String).filter(Boolean);
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

      if (action === "admin_saldos") {
        // Con saldo > 0 (inequality sobre un solo campo: no requiere índice
        // compuesto) + los habilitados en la config aunque tengan saldo 0.
        const cfg = await getGlobalConfig(db);
        const conSaldo = await db.collection("users").where("andreaniSaldo", ">", 0).get();
        const porUid = new Map();
        conSaldo.docs.forEach(d => {
          const dd = d.data();
          porUid.set(d.id, { uid: d.id, email: dd.email || "", saldo: Math.round(Number(dd.andreaniSaldo) || 0) });
        });
        const faltantes = cfg.habilitados.filter(u => !porUid.has(u));
        if (faltantes.length) {
          const snaps = await Promise.all(faltantes.map(u => db.collection("users").doc(u).get()));
          snaps.forEach((s, i) => {
            porUid.set(faltantes[i], {
              uid: faltantes[i],
              email: s.exists ? (s.data().email || "") : "",
              saldo: s.exists ? Math.round(Number(s.data().andreaniSaldo) || 0) : 0,
              habilitado: true,
            });
          });
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
