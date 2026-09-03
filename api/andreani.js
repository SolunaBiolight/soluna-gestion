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

import { randomBytes, createHmac } from "crypto";
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
      // % del valor declarado que Andreani factura como seguro (contrato
      // vigente: 1%). No lleva el descuento de lista.
      seguroPct: Math.min(Math.max(d.seguroPct === undefined ? 1 : Number(d.seguroPct) || 0, 0), 10),
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
    return { markupPct: 0, markupFijo: 0, descuentoPct: 0, seguroPct: 1, sucursalOrigen: "", habilitados: [], datosPago: { alias: "", titular: "", cbu: "" } };
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
  // Coordenadas: Andreani las manda con distintos nombres según el endpoint —
  // se prueban todas las formas conocidas. Sin coords la sucursal igual sirve
  // (solo no participa del orden por distancia).
  const g = s.coordenadas || s.geoCoordenada || s.geolocalizacion || s.geoLocalizacion || s.direccion?.coordenadas || {};
  const lat = parseFloat(g.latitud ?? g.lat ?? s.latitud ?? s.direccion?.latitud);
  const lng = parseFloat(g.longitud ?? g.lng ?? g.long ?? s.longitud ?? s.direccion?.longitud);
  return {
    id: s.id,
    codigo: s.codigo ?? null,
    numero: s.numero ?? null,
    descripcion: s.descripcion || "",
    direccion: s.direccion || null,
    horarioDeAtencion: s.horarioDeAtencion || "",
    lat: isFinite(lat) ? lat : null,
    lng: isFinite(lng) ? lng : null,
  };
}

// Distancia en metros entre dos coordenadas (haversine).
function distanciaM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = d => d * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

async function sucursalesPorCp(db, env, cp) {
  // suc2_: el slim viejo cacheado no traía lat/lng (orden por distancia)
  const cacheRef = db.collection("andreani_config").doc(`suc2_${cp}`);
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
async function sucursalesTodas(db, env, force = false) {
  const cacheRef = db.collection("andreani_config").doc("suc_all2"); // v2: con lat/lng
  if (!force) try {
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

// ─── Mercado Pago: carga de saldo automática ───────────────────────────────
// El cliente paga la carga con Checkout Pro; MP nos notifica al webhook
// (action=mp_webhook, público) y ahí se acredita SOLO, con la misma
// transacción idempotente que usa el admin. Env: MP_ACCESS_TOKEN (+
// MP_WEBHOOK_SECRET para validar la firma de las notificaciones).

const MP_BASE = "https://api.mercadopago.com";
const APP_BASE = "https://www.growithapp.com";

async function mpWebhook(req, res, db, body) {
  const token = process.env.MP_ACCESS_TOKEN || "";
  if (!token) return res.status(200).json({ ok: true, skip: "mp_no_configurado" });
  // El id del pago llega en distintos formatos según la versión del aviso:
  // ?data.id=… (webhooks), {data:{id}} (body), ?id=…&topic=payment (IPN
  // legacy) o {resource:".../payments/123"}. Antes solo se leían los dos
  // primeros y el resto se descartaba → cargas MP que quedaban "pendientes".
  const dataId = String(
    req.query?.["data.id"] || body?.data?.id || req.query?.id || body?.id
    || (String(body?.resource || req.query?.resource || "").match(/(\d+)\s*$/) || [])[1] || ""
  ).trim();
  // Firma: x-signature "ts=...,v1=HMAC(id:<data.id>;request-id:<x-request-id>;ts:<ts>;)"
  // NO es eliminatoria: MP manda variantes del manifiesto según el origen del
  // aviso y rechazarlas perdía notificaciones reales. La seguridad de verdad
  // está más abajo — NUNCA se acredita por el aviso: se consulta el pago real
  // contra la API de MP con nuestro token, y solo cuenta si está aprobado y
  // coincide con una carga pendiente por el monto exacto (idempotente).
  const secret = process.env.MP_WEBHOOK_SECRET || "";
  if (secret) {
    const sig = String(req.headers["x-signature"] || "");
    const ts = (sig.match(/ts=([^,]+)/) || [])[1] || "";
    const v1 = (sig.match(/v1=([a-f0-9]+)/) || [])[1] || "";
    const reqId = String(req.headers["x-request-id"] || "");
    const variantes = [
      `id:${dataId.toLowerCase()};request-id:${reqId};ts:${ts};`,
      `id:${dataId.toLowerCase()};ts:${ts};`, // sin request-id (MP lo omite a veces)
    ];
    const okFirma = !!v1 && variantes.some(m => createHmac("sha256", secret).update(m).digest("hex") === v1);
    if (!okFirma) console.warn(`[mp_webhook] firma no coincide (dataId=${dataId} ts=${!!ts} v1=${!!v1} reqId=${!!reqId}) — sigo igual, la validación real es contra la API`);
  }
  const type = String(req.query?.type || body?.type || body?.topic || req.query?.topic || body?.action || "");
  if (!/payment|merchant_order/.test(type)) return res.status(200).json({ ok: true, skip: type || "sin_tipo" });
  // Sin id legible (formato desconocido) o aviso de merchant_order: en vez de
  // descartar, reconciliar TODAS las cargas MP pendientes contra la API.
  if (!dataId || /merchant_order/.test(type)) {
    try { const rr = await mpReconciliarCargas(db); console.log("[mp_webhook] sin data.id → reconciliadas:", JSON.stringify(rr)); return res.status(200).json({ ok: true, reconciliado: rr }); }
    catch (e) { console.error("[mp_webhook] reconciliar:", e.message); return res.status(500).json({ error: e.message }); }
  }
  // Consultar el pago REAL contra la API — nunca se confía en la notificación.
  const pr = await fetch(`${MP_BASE}/v1/payments/${encodeURIComponent(dataId)}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
  });
  if (!pr.ok) return res.status(pr.status === 404 ? 200 : 502).json({ error: `MP HTTP ${pr.status}` });
  const pago = await pr.json();
  // Devolución/contracargo de un pago ya acreditado: débito compensatorio.
  if (["refunded", "charged_back"].includes(pago.status)) {
    const r3 = await mpContracargo(db, String(pago.external_reference || ""), pago);
    if (r3.error) { console.error("[mp_webhook contracargo]", r3.error); return res.status(500).json({ error: r3.error }); }
    return res.status(200).json({ ok: true, ...(r3.debitada ? { contracargo: true } : {}) });
  }
  if (pago.status !== "approved") return res.status(200).json({ ok: true, status: pago.status });
  const cargaId = String(pago.external_reference || "");
  if (!cargaId) return res.status(200).json({ ok: true, skip: "sin_external_reference" });
  const r2 = await mpAcreditarCarga(db, cargaId, pago);
  if (r2.error) { console.error("[mp_webhook]", r2.error); return res.status(500).json({ error: r2.error }); } // 5xx → MP reintenta
  return res.status(200).json({ ok: true, ...(r2.acreditada ? { acreditada: true } : {}), ...(r2.revision ? { revision: true } : {}) });
}

// Acredita una carga MP pendiente contra un pago APROBADO ya verificado por
// API. Transacción idempotente por estado (webhook y cron pueden llamarla a la
// vez sin acreditar doble). Devuelve {acreditada}|{revision}|{skip}|{error}.
async function mpAcreditarCarga(db, cargaId, pago) {
  const cRef = db.collection("andreani_cargas").doc(cargaId);
  let out = null;
  let montoInfo = null; // para escribir el motivo FUERA de la transacción (un write dentro de una tx abortada se rollbackea)
  try {
    out = await db.runTransaction(async (tx) => {
      const s = await tx.get(cRef);
      if (!s.exists) throw new Error("SKIP");
      const c = s.data();
      if (c.estado !== "pendiente") throw new Error("SKIP"); // MP reintenta: idempotente por estado
      const monto = Math.round(Number(c.monto) || 0);
      const pagado = Number(pago.transaction_amount) || 0;
      if (Math.abs(pagado - monto) > 1 || String(pago.currency_id || "ARS") !== "ARS") {
        // El monto/moneda aprobados no son los de la carga: NO acreditar solo — a revisión.
        montoInfo = { pagado, monto, moneda: String(pago.currency_id || "ARS") };
        throw new Error("MONTO");
      }
      const tRef = db.collection("users").doc(c.uid);
      const uSnap = await tx.get(tRef);
      if (!uSnap.exists) throw new Error("SKIP");
      const saldo = Math.round(Number(uSnap.data()?.andreaniSaldo) || 0);
      const nuevo = saldo + monto;
      tx.update(cRef, { estado: "acreditada", acreditadaBy: "mp", mpPaymentId: String(pago.id), resueltaTs: FieldValue.serverTimestamp() });
      tx.set(tRef, { andreaniSaldo: nuevo }, { merge: true });
      tx.set(tRef.collection("andreani_mov").doc(), {
        tipo: "credito", monto, saldoDespues: nuevo,
        nota: `Carga Mercado Pago ${c.ref}`, mpPaymentId: String(pago.id), ts: FieldValue.serverTimestamp(),
      });
      return { email: c.email || "", monto, ref: c.ref, saldo: nuevo };
    });
  } catch (e) {
    if (e.message === "SKIP") return { skip: true };
    if (e.message === "MONTO") {
      // Estado "revision": sale del filtro de pendientes (el cron dejaba de
      // acreditarla pero la re-encontraba cada 10 min y re-mandaba el mail).
      // El motivo se escribe FUERA de la tx abortada, si no se perdía.
      try {
        await cRef.update({
          estado: "revision",
          motivo: `MP aprobó $${(montoInfo?.pagado ?? 0).toLocaleString("es-AR")}${montoInfo?.moneda && montoInfo.moneda !== "ARS" ? " " + montoInfo.moneda : ""} y la carga es de $${(montoInfo?.monto ?? 0).toLocaleString("es-AR")} — revisar en Admin`,
          mpPaymentId: String(pago.id),
        });
      } catch (_) {}
      try {
        const f = await db.collection("users").doc(FOUNDERS[0]).get();
        const to = f.exists ? String(f.data().email || "").trim() : "";
        if (to) await sendEmail({ to, subject: `Pago MP con monto distinto — revisar carga ${cargaId}`, html: `<p>El pago ${pago.id} de Mercado Pago no coincide con el monto de la carga ${cargaId}. Revisala en Admin → Envíos.</p>` });
      } catch (_) {}
      return { revision: true };
    }
    return { error: e.message };
  }
  if (out?.email) {
    try {
      await sendEmail({
        to: out.email, subject: `Se acreditó tu carga de $${out.monto.toLocaleString("es-AR")}`,
        html: `<div style="font-family:Inter,system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fff;color:#374151">
  <div style="font-size:18px;font-weight:700;color:#111827;margin-bottom:16px">Carga acreditada</div>
  <p style="font-size:14px">Tu pago por Mercado Pago (<strong>${out.ref}</strong>, $${out.monto.toLocaleString("es-AR")}) ya está disponible. Saldo actual: <strong>$${out.saldo.toLocaleString("es-AR")}</strong>.</p>
  <p style="font-size:13px">Ya podés emitir etiquetas desde la sección Env&iacute;os de Growith.</p>
  <p style="font-size:12px;color:#9ca3af;text-align:center;margin-top:24px">Growith — Env&iacute;os</p>
</div>`,
      });
    } catch (_) {}
  }
  return { acreditada: true };
}

// Devolución/contracargo de MP sobre una carga YA acreditada: se debita el
// monto del saldo (puede quedar negativo — es deuda del usuario, visible en el
// ledger) y se avisa al founder. Idempotente por flag `contracargo`.
async function mpContracargo(db, cargaId, pago) {
  if (!cargaId) return { skip: true };
  const cRef = db.collection("andreani_cargas").doc(cargaId);
  let out = null;
  try {
    out = await db.runTransaction(async (tx) => {
      const s = await tx.get(cRef);
      if (!s.exists) throw new Error("SKIP");
      const c = s.data();
      if (c.estado !== "acreditada" || c.contracargo) throw new Error("SKIP");
      if (c.mpPaymentId && String(c.mpPaymentId) !== String(pago.id)) throw new Error("SKIP");
      const monto = Math.round(Number(c.monto) || 0);
      const tRef = db.collection("users").doc(c.uid);
      const uSnap = await tx.get(tRef);
      if (!uSnap.exists) throw new Error("SKIP");
      const saldo = Math.round(Number(uSnap.data()?.andreaniSaldo) || 0);
      const nuevo = saldo - monto;
      tx.update(cRef, { contracargo: true, estado: "contracargo", motivo: `MP informó ${pago.status} del pago ${pago.id}`, resueltaTs: FieldValue.serverTimestamp() });
      tx.set(tRef, { andreaniSaldo: nuevo }, { merge: true });
      tx.set(tRef.collection("andreani_mov").doc(), {
        tipo: "contracargo", monto, saldoDespues: nuevo,
        nota: `Contracargo/devolución MP de la carga ${c.ref}`, mpPaymentId: String(pago.id), ts: FieldValue.serverTimestamp(),
      });
      return { uid: c.uid, email: c.email || "", monto, ref: c.ref, saldo: nuevo };
    });
  } catch (e) {
    if (e.message === "SKIP") return { skip: true };
    return { error: e.message };
  }
  try {
    const f = await db.collection("users").doc(FOUNDERS[0]).get();
    const to = f.exists ? String(f.data().email || "").trim() : "";
    if (to) await sendEmail({ to, subject: `Contracargo MP: $${out.monto.toLocaleString("es-AR")} (${out.ref})`, html: `<p>Mercado Pago informó ${pago.status} del pago ${pago.id} (carga ${out.ref} de ${out.email || out.uid}). Se debitó el saldo: quedó en $${out.saldo.toLocaleString("es-AR")}${out.saldo < 0 ? " (NEGATIVO — deuda del usuario)" : ""}.</p>` });
  } catch (_) {}
  return { debitada: true };
}

// Backstop del webhook: reconcilia cargas MP pendientes contra la API de MP.
// Si el webhook se perdió (firma, caída, config), el cron de cada 10 minutos
// acredita igual. La llama api/check-payments.js.
export async function mpReconciliarCargas(db, soloUid) {
  const token = process.env.MP_ACCESS_TOKEN || "";
  if (!token) return { skip: "mp_no_configurado" };
  const res = { revisadas: 0, acreditadas: 0, revision: 0 };
  // Con soloUid (llamada inline desde la acción `cargas`): SOLO las cargas del
  // usuario — el barrido global de todos los tenants es del cron; hacerlo
  // dentro del request de un usuario podía exceder el timeout de la function.
  const snap = soloUid
    ? await db.collection("andreani_cargas").where("uid", "==", soloUid).limit(200).get()
    : await db.collection("andreani_cargas").where("estado", "==", "pendiente").limit(50).get();
  const ahora = Date.now();
  const pendientesMp = snap.docs.filter(d => {
    const c = d.data();
    const ts = c.ts?.toMillis?.() || 0;
    return c.estado === "pendiente" && c.metodo === "mp" && (!ts || ahora - ts < 7 * 86400000);
  });
  for (const d of pendientesMp) {
    res.revisadas++;
    try {
      const pr = await fetch(`${MP_BASE}/v1/payments/search?external_reference=${encodeURIComponent(d.id)}&sort=date_created&criteria=desc`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
      });
      if (!pr.ok) { console.warn(`[mp_reconciliar] search HTTP ${pr.status} para ${d.id}`); continue; }
      const j = await pr.json();
      const aprobado = (j.results || []).find(p => p.status === "approved");
      if (!aprobado) continue;
      const r = await mpAcreditarCarga(db, d.id, aprobado);
      if (r.acreditada) { res.acreditadas++; console.log(`[mp_reconciliar] ✓ carga ${d.id} acreditada (pago ${aprobado.id})`); }
      else if (r.revision) res.revision++;
      else if (r.error) console.error(`[mp_reconciliar] ${d.id}:`, r.error);
    } catch (e) { console.error(`[mp_reconciliar] ${d.id}:`, e.message); }
  }
  return res;
}

// Andreani no manda coordenadas para la mayoría de sus sucursales: se
// geocodifican acá (georef, mismo motor que las direcciones de pedidos) y se
// cachean en andreani_config/suc_geocode {id:{la,lo}|{f:ts}}. Máx 60 por
// llamada (lotes de 10) para no pasar el timeout; se completa en llamadas
// sucesivas. Los fallos se reintentan recién a los 7 días.
async function geocodeSucursalesFaltantes(db, entries, statsOut) {
  const ref = db.collection("andreani_config").doc("suc_geocode");
  let cache = {};
  try { const h = await ref.get(); if (h.exists) cache = h.data().m || {}; } catch (_) {}
  const ahora = Date.now();
  // Fallos: se reintentan a la hora (antes 7 días — un rate-limit de georef
  // dejaba toda la zona marcada como imposible durante una semana).
  const pend = entries.filter(s => s.la == null && s.c && !(cache[String(s.id)]?.la != null) && !(cache[String(s.id)]?.f && ahora - cache[String(s.id)].f < 3600000)).slice(0, 60);
  // georef directo (sin nominatim): rápido y sin rate-limit agresivo
  const georef = async (dir, provincia, localidad) => {
    const u = new URL("https://apis.datos.gob.ar/georef/api/direcciones");
    u.searchParams.set("direccion", dir); u.searchParams.set("max", "1");
    if (provincia) u.searchParams.set("provincia", provincia);
    if (localidad) u.searchParams.set("localidad", localidad);
    const r = await fetch(u, { signal: AbortSignal.timeout(5000) });
    if (r.status === 429) throw new Error("rate");
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    const ub = j?.direcciones?.[0]?.ubicacion;
    return (ub && isFinite(ub.lat) && isFinite(ub.lon)) ? { lat: +ub.lat, lng: +ub.lon } : null;
  };
  let ok = 0, fail = 0, rate = 0;
  for (let i = 0; i < pend.length; i += 4) {
    await Promise.all(pend.slice(i, i + 4).map(async s => {
      const cpS = String(s.p || "").replace(/\D/g, "");
      const esCaba = /^1[0-4]\d\d$/.test(cpS) || /capital federal|ciudad aut|caba/i.test(nrmTxt(s.l || ""));
      const dir = `${s.c} ${s.n || ""}`.trim();
      const sinVia = dir.replace(/^(avenida|avda\.?|av\.?|calle|diagonal|diag\.?|pasaje|pje\.?|boulevard|bulevar|bv\.?|blvd\.?|ruta)\s+/i, "").trim();
      try {
        let g = await georef(dir, esCaba ? "Ciudad Autónoma de Buenos Aires" : "", esCaba ? "" : (s.l || ""));
        if (!g && sinVia !== dir) g = await georef(sinVia, esCaba ? "Ciudad Autónoma de Buenos Aires" : "", esCaba ? "" : (s.l || ""));
        if (!g && !esCaba) g = await georef(dir, "", "");
        if (g) { cache[String(s.id)] = { la: g.lat, lo: g.lng }; ok++; }
        else { cache[String(s.id)] = { f: ahora }; fail++; }
      } catch (e) { if (String(e.message).includes("rate")) rate++; else fail++; /* no se cachea: reintenta la próxima */ }
    }));
    if (rate) break; // georef nos frenó: seguir en la próxima llamada
  }
  if (ok || fail) { try { await ref.set({ m: cache, ts: ahora }); } catch (_) {} }
  const conCache = entries.filter(s => s.la != null || cache[String(s.id)]?.la != null).length;
  if (statsOut) Object.assign(statsOut, { zona: entries.length, geocodificadas: conCache, pendientes: pend.length, ok, fail, rate });
  console.log(`[cercanas] zona=${entries.length} conCoords=${conCache} intentadas=${pend.length} ok=${ok} fail=${fail} rate=${rate}`);
  return entries.map(s => (s.la == null && cache[String(s.id)]?.la != null) ? { ...s, la: cache[String(s.id)].la, lo: cache[String(s.id)].lo } : s);
}

// Listado geo minificado (solo lo que hace falta para rankear por distancia):
// el listado completo slim supera el límite de 1MB de Firestore, este entra.
async function sucursalesGeo(db, env, force = false) {
  const cacheRef = db.collection("andreani_config").doc("suc_geo");
  if (!force) try {
    const hit = await cacheRef.get();
    if (hit.exists) {
      const d = hit.data();
      if (Array.isArray(d.s) && d.s.length && Date.now() - (d.ts || 0) < SUC_TTL_MS) return d.s;
    }
  } catch (_) {}
  const todas = await sucursalesTodas(db, env, force);
  const s = todas.map(x => ({
    id: x.id, d: x.descripcion || "", c: x.direccion?.calle || "", n: x.direccion?.numero || "",
    l: x.direccion?.localidad || "", p: x.direccion?.codigoPostal || "", la: x.lat, lo: x.lng,
  }));
  try { await cacheRef.set({ ts: Date.now(), s }); } catch (_) {}
  return s;
}

// Geocodificación directa de la dirección del pedido: no depende de que el
// punto exista en ningún listado. georef (API oficial argentina, sin key) y
// Nominatim/OSM de respaldo.
async function geocodeDireccion({ dir, loc, prov, cp }) {
  const clean = s => String(s || "").replace(/\bs\/?n\.?\b/gi, " ").replace(/\s+/g, " ").trim();
  dir = clean(dir); loc = clean(loc); prov = clean(prov);
  // Sufijos de unidad ("Local 9 y 10", "Piso 2 Dpto B") confunden al geocoder
  // y devuelven anclas en cualquier lado — solo calle y altura.
  dir = dir.replace(/[,\s]+(local(?:es)?|piso|dpto\.?|depto\.?|departamento|oficina|of\.|uf|galeria|galería|timbre|casa|pb|entre|e\/|esq\.?|esquina)\b[\s\S]*$/i, "").trim();
  cp = String(cp || "").replace(/\D/g, "");
  if (!dir) return null;
  // TN manda CABA como "C.A.B.A."/"Capital Federal" con provincia "Buenos Aires"
  const esCaba = /c\.?\s*a\.?\s*b\.?\s*a|capital federal|ciudad aut/i.test(loc + " " + prov) || /^1[0-4]\d\d$/.test(cp);
  const tryGeoref = async (params) => {
    const u = new URL("https://apis.datos.gob.ar/georef/api/direcciones");
    u.searchParams.set("direccion", dir);
    u.searchParams.set("max", "1");
    for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
    const r = await fetch(u, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    const ub = j?.direcciones?.[0]?.ubicacion;
    return (ub && isFinite(ub.lat) && isFinite(ub.lon)) ? { lat: +ub.lat, lng: +ub.lon } : null;
  };
  try {
    const provQ = esCaba ? "Ciudad Autónoma de Buenos Aires" : prov;
    let g = await tryGeoref({ provincia: provQ, localidad: esCaba ? "" : loc });
    if (!g && !esCaba && loc) g = await tryGeoref({ provincia: provQ });
    // georef no encuentra "Avenida Juramento 2385" pero sí "Juramento 2385":
    // reintento sin el prefijo de vía.
    const sinVia = dir.replace(/^(avenida|avda\.?|av\.?|calle|diagonal|diag\.?|pasaje|pje\.?|boulevard|bulevar|bv\.?|blvd\.?|ruta)\s+/i, "").trim();
    if (!g && sinVia && sinVia !== dir) {
      const dirOrig = dir; dir = sinVia;
      g = await tryGeoref({ provincia: provQ, localidad: esCaba ? "" : loc });
      if (!g && !esCaba && loc) g = await tryGeoref({ provincia: provQ });
      dir = dirOrig;
    }
    if (g) return g;
  } catch (_) {}
  try {
    const qq = [dir, loc, prov, cp, "Argentina"].filter(Boolean).join(", ");
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ar&q=${encodeURIComponent(qq)}`,
      { headers: { "User-Agent": "Growith/1.0 (gestion e-commerce AR)" }, signal: AbortSignal.timeout(6000) });
    const j = r.ok ? await r.json().catch(() => null) : null;
    const hit = Array.isArray(j) && j[0];
    if (hit && isFinite(+hit.lat) && isFinite(+hit.lon)) return { lat: +hit.lat, lng: +hit.lon };
  } catch (_) {}
  return null;
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
    // valorDeclarado negativo podía producir un precio negativo (débito que
    // ACREDITA saldo) — se rechaza acá y además hay piso en precioConMarkup.
    if (b.kilos <= 0 || b.largoCm <= 0 || b.altoCm <= 0 || b.anchoCm <= 0 || b.valorDeclarado < 0) return null;
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

// Diagnóstico del endpoint oficial de trazas: status + primeros bytes de la
// respuesta, sin ocultar errores. Solo para el modo debug del proxy.
export async function trazasDebugAndreani(db, numeroDeEnvio) {
  try {
    const env = andreaniEnv();
    if (!env) return { error: "sin_env" };
    const num = String(numeroDeEnvio || "").trim().replace(/\s+/g, "");
    const r = await andreaniFetch(db, env, `/v1/envios/${encodeURIComponent(num)}/trazas`);
    const text = await r.text();
    return { status: r.status, body: text.slice(0, 400) };
  } catch (e) {
    return { error: e.message };
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
  const seguroContrato = (c.valorDeclarado || 0) * ((cfg.seguroPct ?? 1) / 100) * 1.21;
  return distribucion * desc + seguroContrato;
}
function precioConMarkup(cot, cfg) {
  // Piso de $1: un precio 0 o negativo jamás debe llegar al débito de saldo.
  return Math.max(1, Math.ceil(costoConDescuento(cot, cfg) * (1 + cfg.markupPct / 100) + cfg.markupFijo));
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
  { const _o = String(req.headers.origin || ""); res.setHeader("Access-Control-Allow-Origin", (["https://www.growithapp.com","https://growithapp.com","https://soluna-gestion.vercel.app"].includes(_o) || /^https:\/\/[a-z0-9-]+-soluna1\.vercel\.app$/.test(_o) || /^http:\/\/localhost(:\d+)?$/.test(_o)) ? _o : "https://www.growithapp.com"); } // allowlist CORS (regex anclada: "evil-soluna1.vercel.app" y "localhost.evil.com" no pasan)
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
      try { body = raw ? JSON.parse(raw) : {}; }
      catch (_) { return res.status(400).json({ error: "Body JSON inválido" }); }
    }

    const action = body.action || req.query?.action;
    if (!action) return res.status(400).json({ error: "action requerida" });

    // Toda acción que ESCRIBE exige POST (un GET con token en un prefetch o un
    // log no debe poder mutar estado). emitir y sucursal_origen ya lo chequean adentro.
    const ACCIONES_POST = new Set(["save_origen", "carga_solicitar", "carga_mp", "carga_cancelar", "admin_acreditar", "admin_carga_acreditar", "admin_carga_rechazar"]);
    if (ACCIONES_POST.has(action) && req.method !== "POST") return res.status(405).json({ error: "POST requerido" });

    // Webhook de Mercado Pago: lo llama MP, no un usuario — sin sesión
    // Firebase. Se valida con la firma HMAC de MP (MP_WEBHOOK_SECRET).
    if (action === "mp_webhook") return await mpWebhook(req, res, db, body);

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

    // ── validar_sucursales_tpl: ¿los nombres del desplegable del Excel siguen
    // operativos? El template es la única lista que acepta el importador y
    // está desactualizada: un punto dado de baja hace que Andreani rechace el
    // archivo ENTERO sin explicación (HOP Avenida Rivadavia 255, #6188,
    // 3/9/2026). Se contrasta cada nombre contra el listado oficial vivo.
    if (action === "validar_sucursales_tpl") {
      const nombres = Array.isArray(body.nombres) ? body.nombres.map(String).filter(Boolean).slice(0, 300) : [];
      if (!nombres.length) return res.json({ faltantes: [] });
      const N = s => nrmTxt(s).toUpperCase().replace(/[^A-Z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
      const STOP = new Set(["PUNTO", "ANDREANI", "HOP", "PICKIT", "SUCURSAL", "ESPACIO", "AVENIDA", "AVDA", "CALLE", "GENERAL", "GRAL", "CENTRO"]);
      const partes = t => { const n = N(t); return { n, nums: [...new Set([...n.matchAll(/\d{2,}/g)].map(x => x[0]))], words: n.split(" ").filter(w => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)) }; };
      const existe = (todas, tpl) => {
        const p = partes(tpl);
        if (!p.n) return true;
        for (const s of todas) {
          const hay = N([s.descripcion, s.direccion?.calle, s.direccion?.numero, s.direccion?.localidad].filter(v => v != null && v !== "").join(" "));
          if (hay === p.n || hay.includes(p.n)) return true;
          if (!p.nums.length && !p.words.length) return true; // nada comparable: no bloquear
          const toks = new Set(hay.split(" "));
          const numsOk = p.nums.every(x => toks.has(x));          // número exacto (255 ≠ 2550)
          const wordsOk = p.nums.length ? p.words.some(w => hay.includes(w)) : p.words.every(w => hay.includes(w));
          if (numsOk && wordsOk) return true;
        }
        return false;
      };
      try {
        let todas = await sucursalesTodas(db, env);
        let faltantes = nombres.filter(t => !existe(todas, t));
        // El cache del listado dura 7 días: antes de acusar, refrescar en vivo.
        if (faltantes.length) {
          try { todas = await sucursalesTodas(db, env, true); faltantes = faltantes.filter(t => !existe(todas, t)); } catch (_) {}
        }
        return res.json({ faltantes, total_oficial: todas.length });
      } catch (e) { return res.status(502).json({ error: e.message }); }
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

    // ── sucursales_cercanas: sucursales ordenadas por distancia al punto de
    // retiro ORIGINAL del pedido. El ancla se calcula GEOCODIFICANDO la
    // dirección del pedido (dir/loc/prov/cp) — no depende de que el punto
    // exista en ningún listado. Fallbacks: tokens del punto en el listado
    // oficial → centroide del CP → aproximación por CP sin distancias.
    if (action === "sucursales_cercanas") {
      const q = nrmTxt(String(body.q || "").trim());
      const cp = String(body.cp || "").replace(/\D/g, "");
      const dir = String(body.dir || "").trim();
      const loc = String(body.loc || "").trim();
      const prov = String(body.prov || "").trim();
      // Candidatas: listado geo completo (minificado y cacheado); si no está
      // disponible, al menos las del CP.
      let geo = [];
      const geoStats = {};
      try { geo = await sucursalesGeo(db, env); } catch (_) {}
      // Caché "envenenada": si menos de la mitad de las sucursales tiene
      // coordenadas, el ranking por distancia solo puede mostrar esas pocas
      // (se vio: todas las cercanas a 1100 km, en Misiones — #6207). Se
      // reconstruye desde Andreani salteando la caché.
      if (geo.length > 50 && geo.filter(x => x.la != null).length < geo.length * 0.5) {
        try {
          const geo2 = await sucursalesGeo(db, env, true);
          if (geo2.filter(x => x.la != null).length > geo.filter(x => x.la != null).length) geo = geo2;
        } catch (_) {}
      }
      // Coordenadas de la ZONA del pedido (mismo CP / localidad / CABA): las
      // que falten se geocodifican con georef y quedan cacheadas — Andreani
      // no manda coords y sin esto las "cercanas" eran las únicas con coords
      // (Misiones, a 1100 km — #6207).
      try {
        const esCabaZ = /c\.?\s*a\.?\s*b\.?\s*a|capital federal|ciudad aut/i.test(loc + " " + prov) || /^1[0-4]\d\d$/.test(cp);
        const locZ = nrmTxt(loc);
        const enZona = geo.filter(s => (cp && String(s.p || "").replace(/\D/g, "") === cp)
          || (esCabaZ ? (/^1[0-4]\d\d$/.test(String(s.p || "").replace(/\D/g, "")) || /capital federal|ciudad aut|caba/i.test(nrmTxt(s.l || "")))
                      : (locZ && nrmTxt(s.l || "").includes(locZ))));
        if (enZona.some(s => s.la == null)) {
          const enriq = await geocodeSucursalesFaltantes(db, enZona, geoStats);
          const byId = new Map(enriq.map(s => [String(s.id), s]));
          geo = geo.map(s => byId.get(String(s.id)) || s);
        }
      } catch (_) {}
      if (!geo.length && cp) {
        try {
          geo = (await sucursalesPorCp(db, env, cp)).map(x => ({
            id: x.id, d: x.descripcion || "", c: x.direccion?.calle || "", n: x.direccion?.numero || "",
            l: x.direccion?.localidad || "", p: x.direccion?.codigoPostal || "", la: x.lat, lo: x.lng,
          }));
        } catch (e) { return res.status(502).json({ error: e.message }); }
      }
      const expand = s => ({
        id: s.id, descripcion: s.d,
        direccion: { calle: s.c, numero: s.n, localidad: s.l, codigoPostal: s.p },
        lat: s.la ?? null, lng: s.lo ?? null,
      });
      // 1) Ancla: geocodificación directa de la dirección del pedido.
      let origen = null;
      geoStats.dir = dir; geoStats.loc = loc;
      if (dir) {
        const g = await geocodeDireccion({ dir, loc, prov, cp });
        if (g) { origen = { ...g, descripcion: dir }; geoStats.origenSrc = "geocode"; }
        else geoStats.origenSrc = "geocode_fallo";
      }
      // 2) …tokens del punto en el listado oficial…
      if (!origen && q.length >= 2) {
        const tokens = q.split(/\s+/).filter(Boolean);
        const cand = geo.filter(s => {
          const hay = nrmTxt([s.d, s.c, s.n, s.l].filter(Boolean).join(" "));
          return tokens.every(t => hay.includes(t));
        }).filter(s => s.la != null);
        if (cand.length) { origen = { lat: cand[0].la, lng: cand[0].lo, descripcion: cand[0].d }; geoStats.origenSrc = "tokens"; }
      }
      // 3) Centroide de las sucursales del CP del pedido: fallback de ancla y
      // TAMBIÉN control de cordura del geocoder — una dirección con texto raro
      // puede geocodificar a cientos de km del CP real del comprador (se vio
      // "Calle 49 621 Local 9 y 10" de La Plata anclada cerca de Misiones).
      // Coordenadas válidas = dentro de Argentina. Andreani manda basura para
      // algunas sucursales (lat/lng cambiados, ceros): promediarlas movía el
      // "centroide de cordura" a cualquier lado y ESE centroide reemplazaba al
      // ancla correcta del geocoder (#6207: 1ra candidata a 1093 km).
      const enAR = (la, lo) => isFinite(la) && isFinite(lo) && la <= -21 && la >= -56 && lo <= -53 && lo >= -74;
      geo = geo.map(s => (s.la != null && !enAR(s.la, s.lo)) ? { ...s, la: null, lo: null } : s);
      if (origen && !enAR(origen.lat, origen.lng)) { geoStats.origenSrc = (geoStats.origenSrc || "") + "_fueraAR"; origen = null; }
      const mediana = arr => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
      const esCabaQ = /c\.?\s*a\.?\s*b\.?\s*a|capital federal|ciudad aut/i.test(loc + " " + prov) || /^1[0-4]\d\d$/.test(cp);
      let cpCent = null;
      if (esCabaQ) {
        cpCent = { lat: -34.6037, lng: -58.3816, descripcion: "CABA" }; // centro fijo, no depende de datos
      } else if (cp) {
        const delCp = geo.filter(s => String(s.p || "").replace(/\D/g, "") === cp && s.la != null);
        if (delCp.length) cpCent = { lat: mediana(delCp.map(s => s.la)), lng: mediana(delCp.map(s => s.lo)), descripcion: `CP ${cp}` };
      }
      if (!cpCent && loc) {
        const locN = nrmTxt(loc);
        const deLoc = geo.filter(s => s.la != null && locN && nrmTxt(s.l || "").includes(locN));
        if (deLoc.length >= 3) cpCent = { lat: mediana(deLoc.map(s => s.la)), lng: mediana(deLoc.map(s => s.lo)), descripcion: loc };
      }
      geoStats.ancla = origen ? `${origen.lat.toFixed(3)},${origen.lng.toFixed(3)}` : null;
      geoStats.centro = cpCent ? `${cpCent.descripcion} ${cpCent.lat.toFixed(3)},${cpCent.lng.toFixed(3)}` : null;
      if (origen && cpCent && distanciaM(origen.lat, origen.lng, cpCent.lat, cpCent.lng) > 150000) { geoStats.origenSrc = (geoStats.origenSrc || "") + "→centro"; origen = cpCent; }
      if (!origen) origen = cpCent;
      // El listado oficial repite la misma sucursal con variantes (CP, tildes,
      // "C.A.B.A." vs nombre largo): dedupe por descripción + número de calle.
      const dedupe = arr => {
        const vistos = new Set();
        return arr.filter(s => {
          const num = (String(s.c || "") + " " + String(s.n || "")).match(/\d{2,}/);
          const k = nrmTxt(s.d).replace(/[^a-z0-9]/g, "") + "|" + (num ? num[0] : "");
          if (vistos.has(k)) return false;
          vistos.add(k);
          return true;
        });
      };
      const conCoords = geo.filter(s => s.la != null).length;
      const stats = { todas: geo.length, conCoords, geo: geoStats };
      if (origen && conCoords) {
        const conDist = dedupe(geo
          .filter(s => s.la != null)
          .map(s => ({ ...s, distM: distanciaM(origen.lat, origen.lng, s.la, s.lo) }))
          .sort((a, b) => a.distM - b.distM))
          .slice(0, 40)
          .map(s => ({ ...expand(s), distM: s.distM }));
        // Cordura del resultado: si la MÁS cercana está a más de 300 km, el
        // ranking no sirve (coords parciales) → aproximación por localidad.
        geoStats.primerKm = conDist.length ? Math.round(conDist[0].distM / 1000) : null;
        geoStats.conCoords = conCoords;
        if (conDist.length && conDist[0].distM <= 300000) {
          return res.json({ sucursales: conDist, origen: origen.descripcion, stats });
        }
      }
      // Aproximación por localidad (sin CP o sin coords útiles): CABA por
      // rango de CP 1000-1499 o nombre; otras por texto de localidad.
      {
        const esCabaL = /c\.?\s*a\.?\s*b\.?\s*a|capital federal|ciudad aut/i.test(loc + " " + prov);
        const locN = nrmTxt(loc);
        const deLoc = geo.filter(s => esCabaL
          ? (/^1[0-4]\d\d$/.test(String(s.p || "").replace(/\D/g, "")) || /capital federal|ciudad aut|caba/i.test(nrmTxt(s.l || "")))
          : (locN && nrmTxt(s.l || "").includes(locN)));
        if (deLoc.length) {
          const lista = dedupe(deLoc).slice(0, 40).map(expand);
          return res.json({ sucursales: lista, origen: esCabaL ? "CABA" : loc, aproximado: true, stats });
        }
      }
      // Sin coordenadas o sin ancla: aproximación por CP (mismo CP primero,
      // después el resto de la misma localidad).
      if (cp) {
        const mismoCp = geo.filter(s => String(s.p || "").replace(/\D/g, "") === cp);
        const locCp = nrmTxt(mismoCp[0]?.l || loc || "");
        const mismaLoc = locCp ? geo.filter(s => nrmTxt(s.l || "") === locCp && !mismoCp.includes(s)) : [];
        const lista = dedupe([...mismoCp, ...mismaLoc]).slice(0, 40).map(expand);
        if (lista.length) return res.json({ sucursales: lista, origen: `CP ${cp}`, aproximado: true, stats });
      }
      return res.json({ sucursales: [], sinOrigen: true, stats });
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
          // Marca de auditoría: la tarifa depende de esta sucursal; si su CP no
          // coincide con el del origen declarado, dejar registro visible.
          const cpOri = String((await userRef.get()).data()?.andreaniOrigen?.codigoPostal || "").replace(/\D/g, "");
          const cpSucO = String(s.direccion?.codigoPostal || "").replace(/\D/g, "");
          const sucOrigen = { ...s, confirmada: true, ts: Date.now(), ...(cpOri && cpSucO && cpOri !== cpSucO ? { cpDistintoDelOrigen: true } : {}) };
          if (sucOrigen.cpDistintoDelOrigen) console.warn(`[andreani] uid=${uid} confirmó sucursal origen CP ${cpSucO} distinta del CP declarado ${cpOri}`);
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

      // El CP que define la tarifa se deriva SIEMPRE del destino REAL — nunca
      // del campo suelto del body (se podía cotizar con un CP barato y emitir
      // la etiqueta a otro caro: la diferencia la absorbía la plataforma).
      let cpTarifa = cpDestino;
      let sucDestinoOficial = null;
      if (tipo === "sucursal") {
        let listaOk = false;
        try {
          const todas = await sucursalesTodas(db, env);
          listaOk = true;
          sucDestinoOficial = todas.find(x => String(x.id) === String(destino.sucursalId)) || null;
        } catch (_) {}
        if (listaOk && !sucDestinoOficial) {
          try { sucDestinoOficial = (await sucursalesPorCp(db, env, cpDestino)).find(x => String(x.id) === String(destino.sucursalId)) || null; } catch (_) {}
        }
        if (listaOk && !sucDestinoOficial) return res.status(400).json({ error: "La sucursal destino no existe en el listado oficial de Andreani — volvé a elegirla." });
        const cpSuc = String(sucDestinoOficial?.direccion?.codigoPostal || "").replace(/\D/g, "");
        if (cpSuc) cpTarifa = cpSuc;
      } else {
        cpTarifa = String(destino.postal.codigoPostal).replace(/\D/g, "") || cpDestino;
      }

      // b. RE-COTIZAR server-side — nunca confiar en el precio del cliente.
      const cot = await cotizarAndreani(db, env, { tipo, cpDestino: cpTarifa, bultos, sucursalOrigen: sucOrigenDe(uData, cfg) });
      const precio = precioConMarkup(cot, cfg);

      // c. Débito en transacción (saldo + movimiento) CON idempotencia adentro:
      // dos requests concurrentes con el mismo envioId (dos pestañas, dos
      // colaboradoras) serializan acá — el segundo ve el lock o el número ya
      // emitido. El check rápido de arriba (fuera de tx) queda como fast-path.
      const movRef = movCol.doc();
      let saldoRestante;
      try {
        saldoRestante = await db.runTransaction(async (tx) => {
          // Firestore exige TODAS las lecturas antes que las escrituras.
          if (envioRef) {
            const eSnap = await tx.get(envioRef);
            const ea = eSnap.exists ? eSnap.data()?.andreani : null;
            if (ea?.numeroDeEnvio) { const err = new Error("ya_emitido"); err.yaEmitido = ea; throw err; }
            const lockTs = Number(ea?.emitiendoTs || 0);
            if (lockTs && Date.now() - lockTs < 120000) { const err = new Error("emision_en_curso"); err.enCurso = true; throw err; }
          }
          const s = await tx.get(userRef);
          const saldo = Math.round(Number(s.data()?.andreaniSaldo) || 0);
          if (saldo < precio) {
            const err = new Error("saldo_insuficiente");
            err.saldoInsuficiente = { saldo, precio };
            throw err;
          }
          const nuevo = saldo - precio;
          if (envioRef) tx.set(envioRef, { andreani: { emitiendoTs: Date.now() } }, { merge: true });
          tx.set(userRef, { andreaniSaldo: nuevo }, { merge: true });
          tx.set(movRef, {
            tipo: "debito",
            monto: precio,
            saldoDespues: nuevo,
            nota: `Etiqueta Andreani ${tipo === "sucursal" ? "a sucursal" : "a domicilio"} · CP ${cpTarifa}`,
            envioId: envioId || null,
            ts: FieldValue.serverTimestamp(),
          });
          return nuevo;
        });
      } catch (e) {
        if (e.saldoInsuficiente) {
          return res.status(402).json({ error: "saldo_insuficiente", ...e.saldoInsuficiente });
        }
        if (e.yaEmitido) {
          return res.json({ ok: true, yaEmitido: true, numeroDeEnvio: e.yaEmitido.numeroDeEnvio, precio: e.yaEmitido.precio ?? null, saldoRestante: null, fechaEstimadaDeEntrega: e.yaEmitido.fechaEstimadaDeEntrega ?? null });
        }
        if (e.enCurso) {
          return res.status(409).json({ error: "Este envío se está emitiendo en este momento (otra pestaña o compañera). Esperá unos segundos y actualizá." });
        }
        throw e;
      }

      // d. Crear la orden en Andreani. Si falla → reverso.
      // Andreani rechaza caracteres especiales en los campos de texto (&, !,
      // paréntesis, tildes según el campo) — se sanitiza igual que el XLSX:
      // solo letras, números, espacios y . , - para que ninguna etiqueta rebote.
      const limpiarTxt = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9\s.,-]/g, " ").replace(/\s{2,}/g, " ").trim();
      const contrato = contratoDe(env, tipo);
      const destinoBody = tipo === "sucursal"
        ? { sucursal: { id: Number(destino.sucursalId) } }
        : { postal: {
            codigoPostal: String(destino.postal.codigoPostal).trim(),
            calle:        limpiarTxt(destino.postal.calle),
            numero:       String(destino.postal.numero).trim(),
            localidad:    limpiarTxt(destino.postal.localidad),
            region:       limpiarTxt(destino.postal.region),
            pais: "Argentina",
            componentesDeDireccion: [
              { meta: "piso", contenido: limpiarTxt(piso || destino.postal.piso || "") },
              { meta: "departamento", contenido: limpiarTxt(departamento || destino.postal.departamento || "") },
            ],
          } };
      const personaDe = (p) => ({
        nombreCompleto: limpiarTxt(p.nombreCompleto),
        email: String(p.email || "").trim(),
        documentoTipo: "DNI",
        documentoNumero: String(p.documentoNumero || "").replace(/[.\-\s]/g, ""),
        telefonos: [{ tipo: 1, numero: String(p.telefono || "").trim() }],
      });
      const orden = {
        contrato,
        origen: { postal: {
          codigoPostal: origen.codigoPostal, calle: limpiarTxt(origen.calle), numero: origen.numero,
          localidad: limpiarTxt(origen.localidad), region: limpiarTxt(origen.region || ""), pais: "Argentina",
        } },
        destino: destinoBody,
        remitente: personaDe(remitente),
        destinatario: [personaDe(destinatario)],
        productoAEntregar: limpiarTxt(productoAEntregar) || "Paquete",
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

      // `ambiguo` = no sabemos si Andreani creó la orden o no (timeout/red, o
      // respuesta 2xx sin número). En ese caso NO se reversa automático: si la
      // orden SÍ se creó, el reverso regalaba la etiqueta y la plataforma
      // pagaba el costo real sin registro. Se retiene el débito, se marca el
      // envío como dudoso y se avisa al admin para conciliar contra Andreani.
      let ordenData = null, ordenErr = null, ambiguo = false;
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
            ambiguo = true;
          }
        }
      } catch (e) {
        ordenErr = e.message || "Error de red contra Andreani";
        ambiguo = true;
      }

      if (!ordenData) {
        if (ambiguo) {
          // Débito retenido + marca de emisión dudosa. El lock de 2 min evita
          // un reintento inmediato que podría duplicar la orden real.
          try { await movRef.set({ dudoso: true, nota: `Etiqueta Andreani ${tipo} · CP ${cpTarifa} — EMISIÓN DUDOSA: ${String(ordenErr).slice(0, 180)}` }, { merge: true }); } catch (_) {}
          if (envioRef) { try { await envioRef.set({ andreani: { dudosoTs: Date.now(), emitiendoTs: FieldValue.delete() } }, { merge: true }); } catch (_) {} }
          try {
            const f = await db.collection("users").doc(FOUNDERS[0]).get();
            const to = f.exists ? String(f.data().email || "").trim() : "";
            if (to) await sendEmail({ to, subject: `Emisión Andreani DUDOSA — conciliar (uid ${uid})`, html: `<p>La emisión del envío ${envioId || "(sin id)"} de ${uData.email || uid} falló de forma ambigua (${String(ordenErr).slice(0, 200)}). El débito de $${precio.toLocaleString("es-AR")} quedó RETENIDO. Verificá en el panel de Andreani si la orden se creó: si NO existe, acreditale el monto desde Admin → Envíos; si existe, avisale el número al usuario.</p>` });
          } catch (_) {}
          return res.status(502).json({ error: `No pudimos confirmar si Andreani emitió la etiqueta (${String(ordenErr).slice(0, 160)}). Para que no se emita ni cobre dos veces, el débito quedó retenido y el equipo de Growith ya fue avisado para resolverlo — no reintentes por ahora.`, dudoso: true });
        }
        // Andreani respondió que NO (rechazo claro): reverso del débito.
        const revRef = movCol.doc();
        try {
          await db.runTransaction(async (tx) => {
            const s = await tx.get(userRef);
            const saldo = Math.round(Number(s.data()?.andreaniSaldo) || 0);
            const nuevo = saldo + precio;
            tx.set(userRef, { andreaniSaldo: nuevo }, { merge: true });
            if (envioRef) tx.set(envioRef, { andreani: { emitiendoTs: FieldValue.delete() } }, { merge: true });
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
        emitiendoTs: FieldValue.delete(), // liberar el lock de emisión
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
            costo: FieldValue.increment(Math.round(costoConDescuento(cot, cfg))), // costo Andreani por cliente (conciliación fin de mes)
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

      // Verificación independiente del destino: resolver el id emitido contra
      // el listado oficial y devolver qué sucursal ES realmente, para que el
      // frontend lo compare contra el punto que eligió el cliente en la tienda.
      let sucursalDestino = null;
      if (tipo === "sucursal") {
        // Ya se resolvió antes de cotizar (define el CP de tarifa); fallback al
        // lookup viejo por si la lista falló en aquel momento.
        let s = sucDestinoOficial;
        if (!s) {
          try {
            const todas = await sucursalesTodas(db, env);
            s = todas.find(x => String(x.id) === String(destino.sucursalId));
            if (!s && cpDestino) s = (await sucursalesPorCp(db, env, cpDestino)).find(x => String(x.id) === String(destino.sucursalId));
          } catch (_) {}
        }
        if (s) sucursalDestino = { id: s.id, descripcion: s.descripcion || "", direccion: s.direccion || null };
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
        sucursalDestino,
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
      // Máx 3 pendientes por cuenta (filtrado en memoria: where por un solo campo;
      // limit alto para que las pendientes no queden fuera de la ventana con historial largo)
      const propias = await cargasCol.where("uid", "==", uid).limit(200).get();
      // Las cargas MP pendientes son checkouts abandonados: no bloquean el cupo
      const pendientes = propias.docs.filter(x => x.data().estado === "pendiente" && x.data().metodo !== "mp");
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

    // Carga con Mercado Pago: crea la carga + preferencia de Checkout Pro y
    // devuelve el link de pago. La acreditación la hace el webhook solo.
    if (action === "carga_mp") {
      const mpTok = process.env.MP_ACCESS_TOKEN || "";
      if (!mpTok) return res.status(500).json({ error: "Mercado Pago no está configurado todavía (falta MP_ACCESS_TOKEN en Vercel)." });
      const cfg = await getGlobalConfig(db);
      const esAdmin = await isPlatformAdmin(db, uid);
      if (!esAdmin && !cfg.habilitados.includes(uid)) return res.status(403).json({ error: "Tu cuenta no tiene Andreani prepago habilitado." });
      const monto = Math.round(Number(body.monto));
      if (!isFinite(monto) || monto < 1000) return res.status(400).json({ error: "El monto mínimo de carga es $1.000." });
      if (monto > 10000000) return res.status(400).json({ error: "Monto demasiado alto." });
      const cargasCol = db.collection("andreani_cargas");
      const propias = await cargasCol.where("uid", "==", uid).limit(200).get();
      const mpPend = propias.docs.filter(x => x.data().estado === "pendiente" && x.data().metodo === "mp");
      if (mpPend.length >= 5) return res.status(400).json({ error: "Tenés varios pagos de Mercado Pago sin terminar. Cancelá alguno (✕) y volvé a intentar." });
      const ref = "MP-" + Array.from(randomBytes(4)).map(b => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
      const uSnap = await userRef.get();
      const email = String(uSnap.data()?.email || user.email || "").trim();
      const docRef = await cargasCol.add({
        uid, email, monto, ref, estado: "pendiente", metodo: "mp", ts: FieldValue.serverTimestamp(),
      });
      const pref = {
        items: [{ id: "carga-saldo", title: `Growith — Carga de saldo de envíos (${ref})`, quantity: 1, unit_price: monto, currency_id: "ARS" }],
        external_reference: docRef.id,
        metadata: { uid, carga_id: docRef.id },
        notification_url: `${APP_BASE}/api/andreani?action=mp_webhook`,
        back_urls: { success: `${APP_BASE}/?mp=ok#/envios`, pending: `${APP_BASE}/?mp=pending#/envios`, failure: `${APP_BASE}/?mp=error#/envios` },
        auto_return: "approved",
        statement_descriptor: "GROWITH",
        ...(email ? { payer: { email } } : {}),
      };
      const r = await fetch(`${MP_BASE}/checkout/preferences`, {
        method: "POST",
        headers: { Authorization: `Bearer ${mpTok}`, "Content-Type": "application/json", "X-Idempotency-Key": docRef.id },
        body: JSON.stringify(pref),
        signal: AbortSignal.timeout(12000),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d?.init_point) {
        await docRef.update({ estado: "cancelada", motivo: "No se pudo crear el checkout de MP" }).catch(() => {});
        return res.status(502).json({ error: `Mercado Pago no aceptó el pago (HTTP ${r.status}): ${String(d?.message || "").slice(0, 200)}` });
      }
      await docRef.update({ mpPreferenceId: String(d.id || "") }).catch(() => {});
      return res.json({ ok: true, init_point: d.init_point, carga: { id: docRef.id, ref, monto, estado: "pendiente", metodo: "mp" } });
    }

    if (action === "cargas") {
      const cfg = await getGlobalConfig(db);
      // Oportunista: si el usuario tiene cargas MP pendientes, reconciliarlas
      // contra la API de MP acá mismo — así al abrir el modal de saldo el pago
      // aprobado se acredita al instante, sin esperar webhook ni cron.
      try { await mpReconciliarCargas(db, uid); } catch (e) { console.warn("[cargas] reconciliar:", e.message); }
      const snap = await db.collection("andreani_cargas").where("uid", "==", uid).limit(200).get();
      const cargas = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.ts?.toMillis?.() || 0) - (a.ts?.toMillis?.() || 0))
        .slice(0, 10)
        .map(c => ({ id: c.id, ref: c.ref, monto: c.monto, estado: c.estado, metodo: c.metodo || "transfer", ts: c.ts?.toMillis?.() || null, motivo: c.motivo || "" }));
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

      // Cargas de saldo pendientes o en revisión (monto de MP distinto) de
      // todas las cuentas (where por un campo, operador "in").
      if (action === "admin_cargas") {
        const snap = await db.collection("andreani_cargas").where("estado", "in", ["pendiente", "revision"]).limit(50).get();
        const cargas = snap.docs.map(d => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (a.ts?.toMillis?.() || 0) - (b.ts?.toMillis?.() || 0))
          .map(c => ({ id: c.id, uid: c.uid, email: c.email || "", ref: c.ref, monto: c.monto, ts: c.ts?.toMillis?.() || null, estado: c.estado, motivo: c.motivo || "" }));
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
          // "revision" (monto MP distinto) también se puede acreditar a mano
          if (c.estado !== "pendiente" && c.estado !== "revision") throw new Error(`Esa carga ya está ${c.estado}.`);
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
          if (s.data().estado !== "pendiente" && s.data().estado !== "revision") throw new Error(`Esa carga ya está ${s.data().estado}.`);
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
            // La lista se REEMPLAZA completa: log del diff para poder auditar
            // un vaciado accidental desde Admin.
            try {
              const prev = (await gRef.get()).data()?.habilitados || [];
              const out = prev.filter(u => !upd.habilitados.includes(u));
              if (out.length) console.warn(`[andreani] admin_config quitó habilitados: ${out.join(",")} (por ${adm.user.uid})`);
            } catch (_) {}
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
        // Saldo CARGADO en el mes por cliente (cargas acreditadas, por resueltaTs)
        const [y, m] = mes.split("-").map(Number);
        const desdeMs = new Date(Date.UTC(y, m - 1, 1, 3)).getTime(); // 00:00 AR
        const hastaMs = new Date(Date.UTC(y, m, 1, 3)).getTime();
        const cargasPorUid = {};
        let cargadoTotal = 0, cargasN = 0;
        try {
          const cs = await db.collection("andreani_cargas").where("estado", "==", "acreditada").limit(1000).get();
          cs.docs.forEach(c => {
            const cd = c.data();
            const t = cd.resueltaTs?.toMillis?.() || cd.ts?.toMillis?.() || 0;
            if (t < desdeMs || t >= hastaMs) return;
            const monto = Math.round(Number(cd.monto) || 0);
            cargasPorUid[cd.uid] = cargasPorUid[cd.uid] || { monto: 0, n: 0 };
            cargasPorUid[cd.uid].monto += monto; cargasPorUid[cd.uid].n++;
            cargadoTotal += monto; cargasN++;
          });
        } catch (_) {}
        // Cuentas = las que emitieron + las que cargaron + las habilitadas
        const cfgS = await getGlobalConfig(db);
        const uids = [...new Set([...Object.keys(porUid), ...Object.keys(cargasPorUid), ...cfgS.habilitados])].slice(0, 60);
        const info = {};
        if (uids.length) {
          try {
            const snaps = await db.getAll(...uids.map(u => db.collection("users").doc(u)));
            snaps.forEach(s => { if (s.exists) info[s.id] = { email: s.data().email || "", saldo: Math.round(Number(s.data().andreaniSaldo) || 0) }; });
          } catch (_) {}
        }
        const cuentas = uids.map(u => ({
          uid: u,
          email: info[u]?.email || "",
          monto: Math.round(Number(porUid[u]?.monto) || 0),
          etiquetas: Number(porUid[u]?.etiquetas) || 0,
          costo: Math.round(Number(porUid[u]?.costo) || 0),
          cargado: cargasPorUid[u]?.monto || 0,
          cargas: cargasPorUid[u]?.n || 0,
          saldo: info[u]?.saldo ?? 0,
          habilitado: cfgS.habilitados.includes(u),
        })).sort((a, b) => b.monto - a.monto || b.cargado - a.cargado);
        const facturado = Math.round(Number(d.facturado) || 0);
        const costoReal = Math.round(Number(d.costoReal) || 0);
        return res.json({
          mes,
          facturado,
          costoReal,
          margen: facturado - costoReal,
          etiquetas: Number(d.etiquetas) || 0,
          cargadoTotal, cargasN,
          saldoTotal: cuentas.reduce((a, c) => a + (c.saldo || 0), 0),
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
