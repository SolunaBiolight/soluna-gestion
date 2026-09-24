// api/andreani.js — Integración con la API oficial de Andreani (logística AR)
//
// Modelo de negocio: UNA sola cuenta Andreani a nivel plataforma (env vars).
// Los clientes de Growith pagan cada etiqueta con un saldo prepago (billetera
// en Firestore). El precio que ve el cliente = tarifa Andreani con IVA + markup
// (configurable por admin en andreani_config/global). El costo real de la
// plataforma NUNCA se le muestra a un cliente (solo a admins).
//
// Seguridad:
//  - Casi todas las acciones exigen ID token de Firebase (verifyAuth). La
//    identidad del que opera sale del token; la TIENDA sobre la que se opera
//    sale de X-Growith-Tienda / uid validada con requireUid(…, "envios").
//    Las acciones admin_* quedan atadas al uid del token (requireAdmin).
//  - Sin sesión (autenticadas de otra forma): mp_webhook (consulta el pago
//    real contra la API de MP), portal_ejecutiva* (token del portal),
//    hop_index_cron y saldo_cron (CRON_SECRET vía guardCron).
//  - `emitir` re-cotiza server-side (jamás se confía en el precio del front) y
//    debita en transacción. Si Andreani RECHAZA claro se reversa; si la
//    respuesta es AMBIGUA (timeout, 2xx sin número) el débito queda RETENIDO
//    y el envío marcado `dudosoTs` hasta que un admin lo resuelva
//    (admin_dudoso_resolver). Si un reverso falla: `reversoPendiente` en el
//    movimiento + mail al fundador.
//  - Etiquetas y trazas verifican pertenencia: primero andreani_idx (server-only).
//
// Firestore:
//  - users/{uid}.andreaniSaldo (number, pesos enteros), .andreaniOrigen /
//    .andreaniRemitente / .andreaniSucOrigen, .andreaniMarkup {markupPct,
//    markupFijo} (override por cliente, admin_markup_cliente), .enviosCfg
//  - users/{uid}/andreani_mov/{autoId} — ledger {tipo: debito|credito|reverso|
//    contracargo, monto, saldoDespues, envioId?, numeroDeEnvio?, dudoso?,
//    reversoPendiente?, ...}
//  - users/{uid}/envios/{envioId}.andreani — {numeroDeEnvio, precio, tipo,
//    emitiendoTs (lock), dudosoTs/dudosoResuelto, anulada, anuladaIngresoTs…}
//  - andreani_idx/{numeroDeEnvio} — {uid, envioId, precio, costo, tipo, mes,
//    ts, anulada?, reintegro?, facturado?} (pertenencia + conciliación)
//  - andreani_cargas/{id} — cargas de saldo {uid, monto, ref, metodo, estado:
//    pendiente|acreditada|revision|cancelada|rechazada|contracargo}
//  - envios_casos/{id} — gestiones ante Andreani (ver CASO_MOTIVOS)
//  - andreani_config/global — {markupPct, markupFijo, descuentoPct,
//    seguroPct, habilitados:[uid], datosPago, ejecutiva*, anulacionDias…}
//  - andreani_config/token — cache del token de login (TTL 12h)
//  - andreani_config/stats_{YYYY-MM} — rentabilidad mensual (+ porUid)
//  - andreani_config/conciliacion_{YYYY-MM} — resumen de admin_conciliar
//  - andreani_config/hop_idx_meta, hop_idx_{n}, hop_idx_build_{n} — índice HOP (_hop.js)
//  - cachés: suc2_{cp}, suc_all2, suc_geo2, suc_geocode, rates_suc12_* y
//    rates_{uid}_{cp}_{kg}_{valor} (checkout Shopify). Versiones viejas
//    (suc_{cp}, suc_all, suc_geo, geo_ck_*, rates_suc1..11_*,
//    suc_b2c_checkout1/2) se purgan con admin_cache_purge.

import { randomBytes, createHmac } from "crypto";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, FieldPath } from "firebase-admin/firestore";
import { ghPuntoDeClave, ghConflictoPunto, ghCoincidePunto, ghConflictoTpl } from "./_suc_match.js";
import { ensureShopifyToken } from "./integrations/_shared.js";
import { verifyAuth, requireAdmin, requireUid, readOnlyBlock, guardCron, isFounder } from "./_auth.js";
import { esDemo } from "./_demo.js";
import { hopIndexTodas, hopIndexPorCp, hopIndexSweep, hopIndexOrigen, hopIndexFotoTs, conHop } from "./_hop.js";
import { numeroEnvioDemo, precioEtiquetaDemo, registrarTrackDemo, trazaDemo } from "./_demo_ops.js";

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

export function andreaniEnv() {
  const user     = process.env.ANDREANI_USER;
  const pass     = process.env.ANDREANI_PASS;
  const cliente  = process.env.ANDREANI_CLIENTE;
  const contratoEstandar = process.env.ANDREANI_CONTRATO_ESTANDAR;
  const contratoSucursal = process.env.ANDREANI_CONTRATO_SUCURSAL;
  // Contrato de canal HOP (opcional): desde el 23/9/2026 Andreani valida el punto
  // contra el contrato y los puntos HOP son de canal HOP ("El canal del request
  // no coincide con el contrato"). Si la cuenta tiene ese contrato, va acá.
  const contratoHop = String(process.env.ANDREANI_CONTRATO_HOP || "").trim() || null;
  if (!user || !pass || !cliente || !contratoEstandar || !contratoSucursal) return null;
  return { user, pass, cliente, contratoEstandar, contratoSucursal, contratoHop };
}
function contratoDe(env, tipo, hop = false) {
  if (tipo === "sucursal" && hop && env.contratoHop) return env.contratoHop;
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
export async function andreaniFetch(db, env, path, opts = {}) {
  let token = await getAndreaniToken(db, env);
  const doFetch = (tk) => fetchTimeout(`${ANDREANI_BASE}${path}`, {
    ...opts,
    headers: { ...(opts.headers || {}), "x-authorization-token": tk },
  });
  // Reintentos: ante 429 o 5xx (o red caída) se espera y se reintenta hasta 2
  // veces. Un POST (crear orden) solo se reintenta por 429: un 5xx después de
  // crear la orden es ambiguo y lo maneja el flujo "dudoso" de emitir.
  const esPost = String(opts.method || "GET").toUpperCase() === "POST";
  const reintentable = (st) => st === 429 || (!esPost && st >= 500 && st <= 504);
  const esperas = [700, 1800];
  let r = null, ultimoErr = null;
  for (let intento = 0; intento <= esperas.length; intento++) {
    try {
      r = await doFetch(token);
      ultimoErr = null;
      if (r.status === 401) {
        token = await getAndreaniToken(db, env, true);
        r = await doFetch(token);
      }
      if (!reintentable(r.status) || intento === esperas.length) return r;
    } catch (e) {
      ultimoErr = e;
      if (esPost || intento === esperas.length) throw e;
    }
    await new Promise(rs => setTimeout(rs, esperas[intento]));
  }
  if (ultimoErr) throw ultimoErr;
  return r;
}

// Extrae un mensaje legible del body de error de Andreani.
async function andreaniError(r, contexto) {
  let detalle = "";
  try {
    const txt = await r.text();
    try {
      const j = JSON.parse(txt);
      // ASP.NET ProblemDetails: { title: "One or more validation errors occurred.", errors: { "Campo.Sub": ["msg"] } }
      // El título solo no sirve para nada: se listan los campos con su mensaje.
      let campos = "";
      if (j.errors && typeof j.errors === "object" && !Array.isArray(j.errors)) campos = Object.entries(j.errors).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`).join("; ");
      else if (Array.isArray(j.errors)) campos = j.errors.map(e => (e.field || e.campo ? `${e.field || e.campo}: ` : "") + (e.message || e.detail || e.mensaje || JSON.stringify(e))).join("; ");
      const titulo = j.message || j.detail || j.title || j.error || "";
      detalle = campos ? (titulo && !/validation errors/i.test(titulo) ? `${titulo} — ${campos}` : campos) : (titulo || txt);
    } catch (_) { detalle = txt; }
    console.error(`[andreani] ${contexto} HTTP ${r.status}: ${String(txt).slice(0, 1500)}`);
  } catch (_) {}
  return `${contexto} (HTTP ${r.status})${detalle ? `: ${String(detalle).slice(0, 500)}` : ""}`;
}

// ─── Identificador de la sucursal destino en la orden ─────────────────────
// 23/9/2026: Andreani dejó de aceptar destino.sucursal.id numérico ("could not
// be converted to System.String"). 24/9: con el id como texto, las sucursales
// comunes salen pero los puntos HOP responden "Sucursal con idgla 18628 no
// encontrada": el id 10000+n del HOP no es un idgla (el objeto trae
// idgla_integra 0). No hay documentación de qué identificador quieren, así
// que se prueban variantes en orden y la que funciona queda recordada por tipo
// (hop / oficial) en andreani_config/global.sucVariante. Solo se reintenta
// ante un 400 que habla del identificador: cualquier otro error corta.
const idglaDe = (s, k) => { const v = Number(s?.raw?.[k]); return isFinite(v) && v > 0 ? String(v) : null; };
const SUC_VARIANTES = {
  idglaIntegra: s => (idglaDe(s, "idgla_integra") ? { id: idglaDe(s, "idgla_integra") } : null),
  idglaAlertran: s => (idglaDe(s, "idgla_alertran") ? { id: idglaDe(s, "idgla_alertran") } : null),
  id: s => ({ id: String(s.id ?? "").trim() }),
  codigo: s => (s.codigo ? { id: String(s.codigo).trim() } : null),
  numero: s => (s.numero != null && String(s.numero).trim() ? { id: String(s.numero).trim() } : null),
  nomenclatura: s => (s.codigo ? { nomenclatura: String(s.codigo).trim() } : null),
  idNomenclatura: s => (s.codigo ? { id: String(s.id ?? "").trim(), nomenclatura: String(s.codigo).trim() } : null),
  idDescripcion: s => ({ id: String(s.id ?? "").trim(), descripcion: String(s.descripcion || "").trim() }),
};
const SUC_ORDEN = { hop: ["idglaIntegra", "idglaAlertran", "codigo", "numero", "nomenclatura", "id", "idNomenclatura", "idDescripcion"], oficial: ["id", "idglaIntegra", "idglaAlertran", "codigo", "nomenclatura", "idNomenclatura", "numero", "idDescripcion"] };
export function sucVariantes(suc, preferida) {
  const tipo = suc?.hop || /^HOP/i.test(String(suc?.codigo || "")) || Number(suc?.id) >= 11000 ? "hop" : "oficial";
  const orden = [...SUC_ORDEN[tipo]]; if (preferida && orden.includes(preferida)) { orden.splice(orden.indexOf(preferida), 1); orden.unshift(preferida); }
  const out = []; const vistos = new Set();
  for (const k of orden) { const v = SUC_VARIANTES[k](suc || {}); if (!v) continue; const key = JSON.stringify(v); if (vistos.has(key)) continue; vistos.add(key); out.push({ nombre: k, sucursal: v }); }
  return { tipo, variantes: out };
}
export function sucIdsResumen(s) {
  const r = s?.raw || {};
  return [`id ${s?.id ?? "?"}`, s?.codigo ? `código ${s.codigo}` : "", s?.numero != null ? `número ${s.numero}` : "", r.idgla_integra != null ? `idgla_integra ${r.idgla_integra}` : "", r.idgla_alertran != null ? `idgla_alertran ${r.idgla_alertran}` : "", r.datosAdicionales?.sucursalAbastecedora?.id ? `abastecedora ${r.datosAdicionales.sucursalAbastecedora.id}` : ""].filter(Boolean).join(", ");
}
// ¿El rechazo es por el identificador de la sucursal (y no por otra cosa)?
export function esErrorIdSucursal(status, txt) {
  if (status !== 400) return false;
  const t = String(txt || "").toLowerCase();
  return /sucursal[^.]{0,60}no encontrad|idgla|destino\.sucursal|sucursal\.id|sucursal[^.]{0,40}(inv[aá]lid|inexistent)/.test(t);
}
let _sucVarianteMem = {};
// Última vez que un HOP falló con TODAS las variantes: durante 30 min los HOP
// siguientes prueban solo dos formas (no diez segundos por fila para nada).
let _hopFallaAt = 0;

// ─── Markup / habilitación (andreani_config/global) ────────────────────────

export async function getGlobalConfig(db) {
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
      // Ejecutiva de cuenta de Andreani: los casos (reclamos, anulaciones) se
      // le mandan por WhatsApp desde Admin con el texto ya armado.
      ejecutivaWa: String(d.ejecutivaWa || "").replace(/\D/g, "").slice(0, 20),
      ejecutivaNombre: String(d.ejecutivaNombre || "").trim().slice(0, 60),
      // Etiquetas emitidas que nunca ingresaron a Andreani en N días: se abre
      // solo un caso de anulación para pedir el reintegro a Andreani.
      anulacionDias: Math.min(Math.max(Math.round(Number(d.anulacionDias) || 14), 3), 90),
      // Mail de operaciones: recibe las gestiones nuevas y las anulaciones automáticas.
      emailGestiones: String(d.emailGestiones || "contacto.growith@gmail.com").trim().slice(0, 160),
      // Portal de la ejecutiva (#/andreani/<token>): recibe un mail por cada
      // gestión nueva y resuelve todo desde ahí. El token lo genera ejecutivaTokenAsegurar.
      ejecutivaEmail: String(d.ejecutivaEmail || "").trim().slice(0, 160),
      ejecutivaToken: String(d.ejecutivaToken || "").trim(),
    };
  } catch (_) {
    return { markupPct: 0, markupFijo: 0, descuentoPct: 0, seguroPct: 1, sucursalOrigen: "", habilitados: [], datosPago: { alias: "", titular: "", cbu: "" }, ejecutivaWa: "", ejecutivaNombre: "", anulacionDias: 14, emailGestiones: "contacto.growith@gmail.com", ejecutivaEmail: "", ejecutivaToken: "" };
  }
}

// ── Casos (gestiones ante Andreani) ─────────────────────────────────────────
// Colección raíz `envios_casos`: {uid, email, tienda, numero (pedido), numeroDeEnvio,
// tracking, cliente, motivo, descripcion, fotos[], nuevaDireccion, estado,
// origen: cliente|sistema, precio, reintegrado, historial[], ts, updatedAt}.
export const CASO_MOTIVOS = {
  demora:      "Demorado, sin movimiento o no llegó",
  danado:      "Llegó dañado o incompleto",
  entrega:     "Entregado mal o devolución injustificada",
  cambio:      "Cambiar domicilio o reprogramar la entrega",
  anulacion:   "Anular etiqueta sin usar",
  otro:        "Otra gestión",
};
export const CASO_ESTADOS = ["abierto", "enviado", "respondido", "resuelto", "rechazado"];
const CASO_ESTADO_LABEL = { abierto: "Abierto", enviado: "Enviado a Andreani", respondido: "Andreani respondió", resuelto: "Resuelto", rechazado: "Rechazado" };
// Una etiqueta se puede anular solo si Andreani nunca registró el ingreso del paquete.
export function envioSinIngreso(e) {
  if (!e || !e.andreani?.numeroDeEnvio) return false;
  if (e.entregadoAt || e.devolucionAt || e.andreani?.anulada) return false;
  const cat = e.categoria || "";
  if (["en_camino", "en_sucursal", "entregado", "devolucion", "visita_fallida"].includes(cat)) return false;
  const txt = String(e.estadoAndreani || "");
  return !txt || /no ingresad|pendiente de ingreso|sin movimientos/i.test(txt);
}
function casoSlim(id, c) {
  return {
    id, uid: c.uid, email: c.email || "", tienda: c.tienda || "", numero: c.numero || "", numeroDeEnvio: c.numeroDeEnvio || "", tracking: c.tracking || "",
    cliente: c.cliente || "", localidad: c.localidad || "", motivo: c.motivo || "otro", motivoLabel: CASO_MOTIVOS[c.motivo] || "Otra gestión",
    descripcion: c.descripcion || "", nuevaDireccion: c.nuevaDireccion || "", fotos: Array.isArray(c.fotos) ? c.fotos.length : 0,
    estado: c.estado || "abierto", estadoLabel: CASO_ESTADO_LABEL[c.estado] || c.estado || "", origen: c.origen || "cliente",
    precio: Number(c.precio) || 0, reintegrado: !!c.reintegrado, nuevoCliente: !!c.nuevoCliente, nuevoAndreani: !!c.nuevoAndreani,
    historial: Array.isArray(c.historial) ? c.historial.slice(-30) : [],
    ts: c.ts?.toMillis?.() || null, updatedAt: c.updatedAt?.toMillis?.() || null,
  };
}
const PORTAL_ORIGIN = "https://www.growithapp.com";
export async function ejecutivaTokenAsegurar(db, regenerar) {
  const ref = db.collection("andreani_config").doc("global");
  const snap = await ref.get();
  let tok = String(snap.data()?.ejecutivaToken || "").trim();
  if (!tok || regenerar) {
    tok = randomBytes(16).toString("hex");
    await ref.set({ ejecutivaToken: tok, ejecutivaTokenTs: FieldValue.serverTimestamp() }, { merge: true });
  }
  return tok;
}
export const portalEjecutivaLink = (tok) => `${PORTAL_ORIGIN}/#/andreani/${tok}`;
// Mail a la ejecutiva con una o varias gestiones + link al portal (best-effort).
export async function mailEjecutiva(db, cfg, casos, titulo) {
  const to = String(cfg?.ejecutivaEmail || "").trim();
  if (!to || !casos?.length) return false;
  const tok = await ejecutivaTokenAsegurar(db);
  const esc = v => String(v ?? "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const filas = casos.slice(0, 20).map(c => `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px"><strong>${esc(c.tienda || c.email || "Cliente Growith")}</strong></td><td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px"><a href="https://www.andreani.com/envio/${esc(c.numeroDeEnvio || c.tracking)}" style="color:#6366f1">${esc(c.numeroDeEnvio || c.tracking)}</a></td><td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px">${esc(CASO_MOTIVOS[c.motivo] || c.motivo)}</td></tr>`).join("");
  const html = `<div style="font-family:Inter,system-ui,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#fff;color:#374151">
  <div style="font-size:18px;font-weight:700;color:#111827;margin-bottom:6px">${esc(titulo)}</div>
  <p style="font-size:13px;color:#6b7280;margin:0 0 16px">Gestiones de clientes de Growith sobre envíos emitidos con la cuenta de Soluna.</p>
  <table style="width:100%;border-collapse:collapse;margin-bottom:18px">${filas}</table>
  ${casos.length > 20 ? `<p style="font-size:12px;color:#6b7280">y ${casos.length - 20} más.</p>` : ""}
  <p style="text-align:center;margin:22px 0"><a href="${portalEjecutivaLink(tok)}" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:10px">Abrir el portal de gestiones</a></p>
  <p style="font-size:12px;color:#6b7280">En el portal ves el detalle, las fotos y el historial de cada gestión, y respondés directamente: el cliente recibe tu respuesta al instante. Guardá el link, es siempre el mismo.</p>
  <p style="font-size:12px;color:#9ca3af;text-align:center;margin-top:24px">Growith — Envíos</p>
</div>`;
  const r = await sendEmail({ to, subject: titulo, html });
  return !!r?.ok;
}
// ── Portal público de la ejecutiva: sin sesión, autenticado por token ──
async function portalEjecutiva(req, res, db, body, action) {
  const cfg = await getGlobalConfig(db);
  const tok = String(body.token || "").trim();
  if (!cfg.ejecutivaToken || tok.length < 20 || tok !== cfg.ejecutivaToken) return res.status(403).json({ error: "Link inválido o vencido. Pedile uno nuevo a Growith." });
  const col = db.collection("envios_casos");
  if (action === "portal_ejecutiva") {
    const [ab, ce] = await Promise.all([
      col.where("estado", "in", ["abierto", "enviado", "respondido"]).limit(200).get(),
      col.where("estado", "in", ["resuelto", "rechazado"]).limit(200).get(),
    ]);
    const slim = d => { const c = casoSlim(d.id, d.data()); delete c.email; delete c.uid; return { ...c, esSucursal: !!d.data().esSucursal }; };
    // Las gestiones de tiendas DEMO nunca le llegan a la ejecutiva.
    const real = d => d.data().demo !== true;
    const abiertos = ab.docs.filter(real).map(slim).sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const cerrados = ce.docs.filter(real).map(slim).sort((a, b) => (b.updatedAt || b.ts || 0) - (a.updatedAt || a.ts || 0)).slice(0, 60);
    return res.json({ ok: true, abiertos, cerrados, nombre: cfg.ejecutivaNombre || "" });
  }
  if (action === "portal_ejecutiva_fotos") {
    const snap = await col.doc(String(body.id || "")).get();
    if (!snap.exists || snap.data().demo === true) return res.status(404).json({ error: "Gestión no encontrada" });
    return res.json({ ok: true, fotos: Array.isArray(snap.data().fotos) ? snap.data().fotos : [] });
  }
  if (action === "portal_ejecutiva_responder") {
    if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
    const id = String(body.id || "").trim();
    const estado = ["respondido", "resuelto", "rechazado"].includes(body.estado) ? String(body.estado) : "respondido";
    const texto = String(body.texto || "").trim().slice(0, 1500);
    if (!id || !texto) return res.status(400).json({ error: "Escribí la respuesta." });
    const ref = col.doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "Gestión no encontrada" });
    const c = snap.data();
    if (c.demo === true) return res.status(404).json({ error: "Gestión no encontrada" });
    const evento = { at: new Date().toISOString(), por: "andreani", estado, texto };
    await ref.set({ estado, nuevoCliente: false, nuevoAndreani: true, historial: FieldValue.arrayUnion(evento), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    const lbl = CASO_ESTADO_LABEL[estado] || estado;
    const escT = v => String(v ?? "").replace(/</g, "&lt;");
    // Al cliente (no en las anulaciones automáticas): respuesta directa de Andreani.
    if (c.origen !== "sistema" && c.email) {
      try { await sendEmail({ to: c.email, subject: `Andreani respondió tu gestión (${c.tracking || c.numeroDeEnvio}): ${lbl}`, html: `<div style="font-family:Inter,system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fff;color:#374151">
  <div style="font-size:18px;font-weight:700;color:#111827;margin-bottom:16px">${lbl}</div>
  <p style="font-size:14px">Gestión por el envío <strong>${escT(c.tracking || c.numeroDeEnvio)}</strong> (pedido #${escT(c.numero)}) — ${escT(CASO_MOTIVOS[c.motivo] || "")}.</p>
  <p style="font-size:13px;white-space:pre-wrap;background:#f9fafb;border-radius:8px;padding:10px 14px"><strong>Andreani:</strong> ${escT(texto)}</p>
  <p style="font-size:13px">Podés responder desde Envíos &rarr; Seguimientos &rarr; el envío &rarr; Gestiones.</p>
  <p style="font-size:12px;color:#9ca3af;text-align:center;margin-top:24px">Growith — Envíos</p>
</div>` }); } catch (_) {}
    }
    // A operaciones: para ver la respuesta y, si es una anulación aprobada, hacer el reintegro desde Admin.
    if (cfg.emailGestiones) {
      try { await sendEmail({ to: cfg.emailGestiones, subject: `Andreani respondió: ${CASO_MOTIVOS[c.motivo] || c.motivo} · ${c.tienda || c.email || ""} → ${lbl}`, html: `<div style="font-family:Inter,system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fff;color:#374151">
  <div style="font-size:18px;font-weight:700;color:#111827;margin-bottom:16px">Andreani respondió por el portal</div>
  <p style="font-size:14px"><strong>${escT(c.tienda || c.email || "")}</strong> · envío <strong>${escT(c.numeroDeEnvio || c.tracking)}</strong> · ${escT(CASO_MOTIVOS[c.motivo] || "")} → <strong>${lbl}</strong></p>
  <p style="font-size:13px;white-space:pre-wrap;background:#f9fafb;border-radius:8px;padding:10px 14px">${escT(texto)}</p>
  ${c.motivo === "anulacion" && estado === "resuelto" && !c.reintegrado ? '<p style="font-size:13px;color:#b45309"><strong>Anulación aprobada:</strong> hacé el reintegro al saldo del cliente desde Admin &rarr; Logística &rarr; Gestiones (Cambiar estado &rarr; Resuelto &rarr; Reintegrar).</p>' : ""}
  <p style="font-size:12px;color:#9ca3af;text-align:center;margin-top:24px">Growith — Envíos</p>
</div>` }); } catch (_) {}
    }
    return res.json({ ok: true, estado });
  }
  return res.status(400).json({ error: "acción inválida" });
}
// Data URL base64 válida de alguno de los `tipos`, con tope sobre el LARGO DEL
// STRING base64 (lo que ocupa en Firestore), no sobre los bytes decodificados.
function validarDataUrl(v, maxChars, tipos) {
  const str = String(v || "");
  const m = str.match(/^data:([a-z0-9.+\/-]+);base64,([A-Za-z0-9+\/=]+)$/i);
  if (!m) return null;
  if (!tipos.some(t => m[1].toLowerCase().startsWith(t))) return null;
  if (m[2].length > maxChars) return null;
  return str;
}
const FOTOS_MAX_CHARS = 700000;       // suma de todas las fotos de un caso
const COMPROBANTE_MAX_CHARS = 650000; // comprobante de una carga
const HISTORIAL_MAX = 200;            // entradas de envios_casos.historial
const ERR_FOTOS_PESO = "Las fotos pesan demasiado (máx. 700 KB entre todas): sacá alguna o reducí la calidad.";

// ¿Es admin de la plataforma? Mismo criterio que _auth.requireAdmin, pero sin
// re-verificar el token (ya lo verificamos): users/{uid}.isAdmin, ADMIN_UIDS
// (env) o fundadores. _auth.js exporta isFounder pero no la lista: el uid del
// fundador hace falta acá para los mails operativos (mailFundador).
const FOUNDERS = ["WJH3ArqDPQcNLha9lOinvkVi9uJ2"];
// Mail operativo al fundador (users/{FOUNDERS[0]}.email). Best-effort, nunca tira.
// `clave`: tope por tema. El primer mail sale al instante; los siguientes del
// mismo tema en la hora siguiente se suprimen y se cuentan (system/mail_tope/{clave}),
// y el próximo que salga dice cuántos hubo. Si Andreani se degrada, antes era
// un mail por cada etiqueta intentada.
async function mailFundador(db, subject, html, clave) {
  try {
    const f = await db.collection("users").doc(FOUNDERS[0]).get();
    const to = f.exists ? String(f.data().email || "").trim() : "";
    if (!to) return false;
    let extra = "";
    if (clave) {
      const ref = db.collection("system").doc("mail_tope").collection("temas").doc(clave);
      const dec = await db.runTransaction(async tx => {
        const s = await tx.get(ref); const d = s.data() || {};
        if (Date.now() - (Number(d.lastAt) || 0) < 3600000) { tx.set(ref, { suprimidos: (Number(d.suprimidos) || 0) + 1 }, { merge: true }); return { skip: true }; }
        tx.set(ref, { lastAt: Date.now(), suprimidos: 0 }, { merge: true }); return { skip: false, suprimidos: Number(d.suprimidos) || 0 };
      });
      if (dec.skip) return false;
      if (dec.suprimidos > 0) extra = `<p style="color:#b45309"><strong>+${dec.suprimidos}</strong> aviso${dec.suprimidos !== 1 ? "s" : ""} del mismo tipo suprimido${dec.suprimidos !== 1 ? "s" : ""} en la última hora (se manda uno por hora como máximo).</p>`;
    }
    const r = await sendEmail({ to, subject, html: html + extra });
    return !!r?.ok;
  } catch (_) { return false; }
}

// Nombres del desplegable del Excel de Andreani que el importador RECHAZA
// (punto dado de baja, confirmado con un rechazo real). Se suma a
// andreani_config/tpl_baja (admin_tpl_baja). Ver validar_sucursales_tpl.
const TPL_BAJA_SEED = [
  "PUNTO ANDREANI HOP AVENIDA RIVADAVIA 255", // #6188, 3/9/2026 — Andreani rechazó el lote entero por este punto
];
// Registro de acciones admin (colección admin_log, la misma que usa tareas.js).
async function logAdminAndreani(db, adminUid, action, targetUid, detalle, data) {
  try {
    let targetEmail = null;
    if (targetUid) { try { const s = await db.collection("users").doc(String(targetUid)).get(); targetEmail = s.exists ? (s.data().email || null) : null; } catch (_) {} }
    await db.collection("admin_log").add({ adminUid, action, targetUid: targetUid || null, targetEmail, detalle: String(detalle || "").slice(0, 300), data: data || null, at: FieldValue.serverTimestamp() });
  } catch (e) { console.warn("[admin_log]", e.message); }
}
export async function isPlatformAdmin(db, uid) {
  if (isFounder(uid)) return true;
  const envAdmins = String(process.env.ADMIN_UIDS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (envAdmins.includes(uid)) return true;
  try {
    const snap = await db.collection("users").doc(uid).get();
    return snap.exists && snap.data().isAdmin === true;
  } catch (_) { return false; }
}

// ─── Sucursales (por CP y listado completo para el buscador) ───────────────

export function slimSucursal(s) {
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
export function distanciaM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = d => d * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

export async function sucursalesPorCp(db, env, cp) {
  // suc2_: el slim viejo cacheado no traía lat/lng (orden por distancia)
  const cacheRef = db.collection("andreani_config").doc(`suc2_${cp}`);
  try {
    const hit = await cacheRef.get();
    if (hit.exists) {
      const d = hit.data();
      if (Array.isArray(d.sucursales) && Date.now() - (d.ts || 0) < SUC_TTL_MS) return conHop(d.sucursales, await hopIndexPorCp(db, cp));
    }
  } catch (_) {}
  const r = await andreaniFetch(db, env, `/v2/sucursales?codigoPostal=${encodeURIComponent(cp)}&canal=B2C`);
  if (!r.ok) throw new Error(await andreaniError(r, "No se pudieron obtener las sucursales"));
  const raw = await r.json();
  const lista = Array.isArray(raw) ? raw : (raw?.sucursales || []);
  const sucursales = lista.map(slimSucursal);
  try { await cacheRef.set({ ts: Date.now(), sucursales }); } catch (_) {}
  // Puntos HOP: Andreani no los lista para nuestra cuenta pero sí los resuelve
  // por id — se suman desde el índice propio (api/_hop.js), después de la caché.
  return conHop(sucursales, await hopIndexPorCp(db, cp));
}

// Listado COMPLETO (para el buscador de sucursal de origen). Cacheado 7 días.
export async function sucursalesTodas(db, env, force = false, { sinHop = false } = {}) {
  const cacheRef = db.collection("andreani_config").doc("suc_all2"); // v2: con lat/lng
  if (!force) try {
    const hit = await cacheRef.get();
    if (hit.exists) {
      const d = hit.data();
      if (Array.isArray(d.sucursales) && d.sucursales.length && Date.now() - (d.ts || 0) < SUC_TTL_MS) return sinHop ? d.sucursales : conHop(d.sucursales, await hopIndexTodas(db));
    }
  } catch (_) {}
  const r = await andreaniFetch(db, env, `/v2/sucursales`);
  if (!r.ok) throw new Error(await andreaniError(r, "No se pudo obtener el listado de sucursales"));
  const raw = await r.json();
  const lista = Array.isArray(raw) ? raw : (raw?.sucursales || []);
  const sucursales = lista.map(slimSucursal);
  try { await cacheRef.set({ ts: Date.now(), sucursales }); } catch (_) { /* si supera 1MB queda sin cache */ }
  return sinHop ? sucursales : conHop(sucursales, await hopIndexTodas(db));
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
    // El webhook es público: sin throttle, cualquier POST anónimo disparaba una
    // reconciliación completa (50 lecturas + 50 requests a MP). Máximo una por minuto.
    try {
      const tRef = db.collection("system").doc("mp_webhook");
      const puede = await db.runTransaction(async (tx) => { const s = await tx.get(tRef); const last = Number(s.data()?.reconciliadoTs || 0); if (Date.now() - last < 60000) return false; tx.set(tRef, { reconciliadoTs: Date.now() }, { merge: true }); return true; });
      if (!puede) return res.status(200).json({ ok: true, skip: "throttle" });
    } catch (_) {}
    try { const rr = await mpReconciliarCargas(db); console.log("[mp_webhook] sin data.id → reconciliadas:", JSON.stringify(rr)); return res.status(200).json({ ok: true, reconciliado: rr }); }
    catch (e) { console.error("[mp_webhook] reconciliar:", e.message); return res.status(500).json({ error: e.message }); }
  }
  // Consultar el pago REAL contra la API — nunca se confía en la notificación.
  const pr = await fetch(`${MP_BASE}/v1/payments/${encodeURIComponent(dataId)}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
  });
  if (!pr.ok) return res.status(pr.status === 404 ? 200 : 502).json({ error: `MP HTTP ${pr.status}` });
  const pago = await pr.json();
  // Devolución/contracargo (total o PARCIAL: el pago sigue "approved" con
  // transaction_amount_refunded > 0) de un pago ya acreditado: débito compensatorio.
  const reembolsado = Number(pago.transaction_amount_refunded) || 0;
  if (["refunded", "charged_back"].includes(pago.status) || reembolsado > 0) {
    const r3 = await mpContracargo(db, String(pago.external_reference || ""), pago);
    if (r3.error) { console.error("[mp_webhook contracargo]", r3.error); return res.status(500).json({ error: r3.error }); }
    if (pago.status !== "approved" || r3.debitada) return res.status(200).json({ ok: true, ...(r3.debitada ? { contracargo: true } : {}) });
  }
  if (pago.status !== "approved") return res.status(200).json({ ok: true, status: pago.status });
  const cargaId = String(pago.external_reference || "");
  if (!cargaId) return res.status(200).json({ ok: true, skip: "sin_external_reference" });
  const r2 = await mpAcreditarCarga(db, cargaId, pago);
  if (r2.error) { console.error("[mp_webhook]", r2.error); return res.status(500).json({ error: r2.error }); } // 5xx → MP reintenta
  return res.status(200).json({ ok: true, ...(r2.acreditada ? { acreditada: true } : {}), ...(r2.revision ? { revision: true } : {}) });
}

// Consulta en MP si hay un pago APROBADO para una carga (por external_reference).
// Devuelve el pago, null si no hay, o lanza si MP no responde.
async function mpBuscarPagoAprobado(token, cargaId) {
  const pr = await fetch(`${MP_BASE}/v1/payments/search?external_reference=${encodeURIComponent(cargaId)}&sort=date_created&criteria=desc`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
  });
  if (!pr.ok) throw new Error(`MP search HTTP ${pr.status}`);
  const j = await pr.json();
  return (j.results || []).find(p => p.status === "approved") || null;
}

// Acredita una carga MP pendiente contra un pago APROBADO ya verificado por
// API. Transacción idempotente por estado (webhook y cron pueden llamarla a la
// vez sin acreditar doble). Devuelve {acreditada}|{revision}|{skip}|{error}.
async function mpAcreditarCarga(db, cargaId, pago) {
  const cRef = db.collection("andreani_cargas").doc(cargaId);
  let out = null;
  let montoInfo = null; // para escribir el motivo FUERA de la transacción (un write dentro de una tx abortada se rollbackea)
  let cancelada = null; // pago aprobado sobre una carga cancelada/rechazada → revisión + mail (fuera de la tx)
  try {
    out = await db.runTransaction(async (tx) => {
      const s = await tx.get(cRef);
      if (!s.exists) throw new Error("SKIP");
      const c = s.data();
      // El cliente canceló (o el admin rechazó) la carga pero MP igual aprobó
      // el pago: hay plata cobrada sin saldo. No se acredita solo: a revisión
      // y aviso al fundador. Idempotente: la segunda vez ya está en "revision".
      if (c.estado === "cancelada" || c.estado === "rechazada") {
        tx.update(cRef, { estado: "revision", motivo: "pago aprobado en MP sobre una carga cancelada", estadoPrevio: c.estado, mpPaymentId: String(pago.id), mpMonto: Number(pago.transaction_amount) || 0, revisionTs: FieldValue.serverTimestamp() });
        cancelada = { uid: c.uid, email: c.email || "", monto: Math.round(Number(c.monto) || 0), ref: c.ref, pagado: Number(pago.transaction_amount) || 0 };
        return null;
      }
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
      await mailFundador(db, `Pago MP con monto distinto — revisar carga ${cargaId}`, `<p>El pago ${pago.id} de Mercado Pago no coincide con el monto de la carga ${cargaId}. Revisala en Admin → Envíos.</p>`);
      return { revision: true };
    }
    return { error: e.message };
  }
  if (cancelada) {
    await mailFundador(db, `Pago MP aprobado sobre una carga CANCELADA — $${cancelada.pagado.toLocaleString("es-AR")} (${cancelada.ref})`,
      `<p>Mercado Pago aprobó el pago <strong>${pago.id}</strong> por $${cancelada.pagado.toLocaleString("es-AR")} de la carga <strong>${cargaId}</strong> (${cancelada.ref}, $${cancelada.monto.toLocaleString("es-AR")}) de ${cancelada.email || cancelada.uid} (uid ${cancelada.uid}), pero la carga estaba cancelada. Quedó en revisión: acreditala o devolvé el pago desde Admin → Logística → Cargas.</p>`);
    return { revision: true, cancelada: true };
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

// Devolución/contracargo de MP sobre una carga YA acreditada: se debita del
// saldo lo reembolsado (puede quedar negativo — es deuda del usuario, visible
// en el ledger) y se avisa al founder. Reembolso PARCIAL (pago "approved" con
// transaction_amount_refunded < monto): se debita solo lo reembolsado.
// Idempotente por monto acumulado: la carga guarda `contracargoMonto` y se
// debita únicamente la diferencia con lo que MP informa ahora.
async function mpContracargo(db, cargaId, pago) {
  if (!cargaId) return { skip: true };
  const cRef = db.collection("andreani_cargas").doc(cargaId);
  let out = null;
  try {
    out = await db.runTransaction(async (tx) => {
      const s = await tx.get(cRef);
      if (!s.exists) throw new Error("SKIP");
      const c = s.data();
      if (!["acreditada", "contracargo"].includes(c.estado)) throw new Error("SKIP");
      if (c.mpPaymentId && String(c.mpPaymentId) !== String(pago.id)) throw new Error("SKIP");
      const monto = Math.round(Number(c.monto) || 0);
      const reembolsadoMp = Math.round(Number(pago.transaction_amount_refunded) || 0);
      const total = ["refunded", "charged_back"].includes(pago.status) && reembolsadoMp <= 0;
      // Objetivo acumulado: todo el monto (devolución total/contracargo) o lo reembolsado hasta ahora.
      const objetivo = Math.min(monto, total ? monto : reembolsadoMp);
      const previo = Math.round(Number(c.contracargoMonto) || (c.contracargo ? monto : 0));
      const diff = objetivo - previo;
      if (diff <= 0) throw new Error("SKIP");
      const parcial = objetivo < monto;
      const tRef = db.collection("users").doc(c.uid);
      const uSnap = await tx.get(tRef);
      if (!uSnap.exists) throw new Error("SKIP");
      const saldo = Math.round(Number(uSnap.data()?.andreaniSaldo) || 0);
      const nuevo = saldo - diff;
      tx.update(cRef, {
        contracargoMonto: objetivo, contracargo: !parcial, estado: parcial ? "acreditada" : "contracargo",
        motivo: parcial ? `MP reembolsó $${objetivo.toLocaleString("es-AR")} de $${monto.toLocaleString("es-AR")} (pago ${pago.id})` : `MP informó ${pago.status} del pago ${pago.id}`,
        ...(parcial ? {} : { resueltaTs: FieldValue.serverTimestamp() }),
      });
      tx.set(tRef, { andreaniSaldo: nuevo }, { merge: true });
      tx.set(tRef.collection("andreani_mov").doc(), {
        tipo: "contracargo", monto: diff, saldoDespues: nuevo,
        nota: parcial ? `reembolso parcial MP de la carga ${c.ref}` : `Contracargo/devolución MP de la carga ${c.ref}`, mpPaymentId: String(pago.id), ts: FieldValue.serverTimestamp(),
      });
      return { uid: c.uid, email: c.email || "", monto: diff, parcial, ref: c.ref, saldo: nuevo };
    });
  } catch (e) {
    if (e.message === "SKIP") return { skip: true };
    return { error: e.message };
  }
  await mailFundador(db, `${out.parcial ? "Reembolso parcial" : "Contracargo"} MP: $${out.monto.toLocaleString("es-AR")} (${out.ref})`,
    `<p>Mercado Pago informó ${out.parcial ? "un reembolso parcial" : pago.status} del pago ${pago.id} (carga ${out.ref} de ${out.email || out.uid}). Se debitó $${out.monto.toLocaleString("es-AR")} del saldo: quedó en $${out.saldo.toLocaleString("es-AR")}${out.saldo < 0 ? " (NEGATIVO — deuda del usuario)" : ""}.</p>`);
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
  // También las CANCELADAS por MP de las últimas 48 h: el cliente cancela desde
  // Growith pero el pago pudo aprobarse igual — mpAcreditarCarga las pasa a revisión.
  const col = db.collection("andreani_cargas");
  const docs = soloUid
    ? (await col.where("uid", "==", soloUid).limit(200).get()).docs
    : [...(await col.where("estado", "==", "pendiente").limit(50).get()).docs,
       ...(await col.where("estado", "==", "cancelada").limit(50).get().catch(() => ({ docs: [] }))).docs];
  const ahora = Date.now();
  const pendientesMp = docs.filter(d => {
    const c = d.data();
    if (c.metodo !== "mp") return false;
    const ts = c.ts?.toMillis?.() || 0;
    if (c.estado === "pendiente") return !ts || ahora - ts < 7 * 86400000;
    if (c.estado === "cancelada") return !!ts && ahora - ts < 48 * 3600000;
    return false;
  });
  for (const d of pendientesMp) {
    res.revisadas++;
    try {
      let aprobado;
      try { aprobado = await mpBuscarPagoAprobado(token, d.id); }
      catch (e) { console.warn(`[mp_reconciliar] ${e.message} para ${d.id}`); continue; }
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
  const cacheRef = db.collection("andreani_config").doc("suc_geo2"); // v2: con puntos HOP
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
export async function geocodeDireccion({ dir, loc, prov, cp }) {
  const clean = s => String(s || "").replace(/\bs\/?n\.?\b/gi, " ").replace(/\s+/g, " ").trim();
  dir = clean(dir); loc = clean(loc); prov = clean(prov);
  // Sufijos de unidad ("Local 9 y 10", "Piso 2 Dpto B") confunden al geocoder
  // y devuelven anclas en cualquier lado — solo calle y altura.
  dir = dir.replace(/[,\s]+entre\s+\S[\s\S]*?\s+y\s+[\s\S]*$/i, "").replace(/[,\s]+(local(?:es)?|piso|dpto\.?|depto\.?|departamento|oficina|of\.|uf|galeria|galería|timbre|casa|pb|e\/|esq\.?|esquina)\b[\s\S]*$/i, "").trim();
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

// ── Localidades oficiales de Andreani (GET /v1/localidades) ─────────────────
// Andreani pidió que la dupla localidad/provincia salga de su catálogo y no del
// texto de la tienda (llegaban direcciones enteras en "localidad"). El catálogo
// es uno solo para todo el país (~30k filas, 3.5MB): se baja una vez por
// instancia y se indexa por código postal; se renueva cada 24 h.
let _locCat = null; // { ts, byCp: Map<cp, [{localidad, provincia, partido}]> }
async function catalogoLocalidades() {
  if (_locCat && Date.now() - _locCat.ts < 24 * 3600000) return _locCat.byCp;
  const r = await fetchTimeout(`${ANDREANI_BASE}/v1/localidades`, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`localidades HTTP ${r.status}`);
  const arr = await r.json();
  const byCp = new Map();
  for (const x of (Array.isArray(arr) ? arr : [])) {
    const item = { localidad: String(x.localidad || "").trim(), provincia: String(x.provincia || "").trim(), partido: String(x.partido || "").trim() };
    if (!item.localidad) continue;
    for (const cp of (x.codigosPostales || [])) { const k = String(cp).trim(); if (!byCp.has(k)) byCp.set(k, []); byCp.get(k).push(item); }
  }
  _locCat = { ts: Date.now(), byCp };
  return byCp;
}
// Elige la localidad oficial para un CP a partir de los textos que manda la
// tienda (localidad, ciudad, provincia). Devuelve null si no puede resolver.
async function resolverLocalidad(cp, textos = [], region = "") {
  try {
    const byCp = await catalogoLocalidades();
    const cands = byCp.get(String(cp || "").trim()) || [];
    if (!cands.length) return null;
    const toks = s => nrmTxt(s).split(/[^a-z0-9]+/).filter(t => t.length > 1);
    const textoToks = new Set(textos.flatMap(t => toks(t)));
    const regionN = nrmTxt(region);
    let mejor = null, mejorScore = 0;
    for (const c of cands) {
      const ct = toks(c.localidad).filter(t => !["barrio", "de", "del", "la", "el", "los", "las"].includes(t));
      if (!ct.length) continue;
      let hit = 0; for (const t of ct) if (textoToks.has(t)) hit++;
      let score = hit / ct.length;
      if (score > 0 && regionN && nrmTxt(c.provincia).includes(regionN.split(" ")[0])) score += 0.1;
      if (score > mejorScore) { mejorScore = score; mejor = c; }
    }
    if (mejor && mejorScore >= 0.5) return { ...mejor, score: mejorScore, cands: cands.length };
    // Sin coincidencia por texto: única opción, o la de la misma provincia
    // más "genérica" (sin " - barrio"), o la primera del catálogo.
    if (cands.length === 1) return { ...cands[0], score: 0, cands: 1 };
    const prov = regionN ? cands.filter(c => nrmTxt(c.provincia).includes(regionN.split(" ")[0]) || regionN.includes(nrmTxt(c.provincia).split(" ")[0])) : [];
    const pool = prov.length ? prov : cands;
    const sinBarrio = pool.filter(c => !c.localidad.includes(" - "));
    const elegido = (sinBarrio.length ? sinBarrio : pool).slice().sort((a, b) => a.localidad.length - b.localidad.length)[0];
    return { ...elegido, score: 0, cands: cands.length };
  } catch (e) { console.warn("[andreani] resolverLocalidad:", e.message); return null; }
}

export function normalizarBultos(bultos) {
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
export async function cotizarAndreani(db, env, { tipo, cpDestino, bultos, sucursalOrigen, hop = false }) {
  const params = new URLSearchParams();
  params.set("cpDestino", String(cpDestino));
  params.set("contrato", contratoDe(env, tipo, hop));
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
export function sucOrigenDe(uData, cfg) {
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

// Alias: el modo debug del proxy de trazas (update-shipping.js) lo importa;
// devuelve las mismas trazas crudas que el endpoint oficial (o null).
export const trazasDebugAndreani = trazasOficialAndreani;

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
export function precioConMarkup(cot, cfg) {
  // Piso de $1: un precio 0 o negativo jamás debe llegar al débito de saldo.
  return Math.max(1, Math.ceil(costoConDescuento(cot, cfg) * (1 + cfg.markupPct / 100) + cfg.markupFijo));
}
// Markup por cliente: users/{uid}.andreaniMarkup {markupPct?, markupFijo?}
// pisa el global SOLO con números válidos (0..200 % y 0..100000 $). Se usa en
// toda cotización/emisión (y en el checkout de Shopify) pasando el user doc.
export function cfgParaCuenta(cfg, uData) {
  const m = uData?.andreaniMarkup;
  if (!m || typeof m !== "object") return cfg;
  const out = { ...cfg };
  const pct = Number(m.markupPct), fijo = Number(m.markupFijo);
  if (m.markupPct != null && isFinite(pct) && pct >= 0 && pct <= 200) out.markupPct = pct;
  if (m.markupFijo != null && isFinite(fijo) && fijo >= 0 && fijo <= 100000) out.markupFijo = Math.round(fijo);
  return out;
}

// ─── Pertenencia de un envío (etiqueta/trazas) ─────────────────────────────

// Un usuario solo puede operar sobre numeroDeEnvio que estén en SU ledger o en
// SUS envíos. Queries de igualdad simple sobre subcolecciones chicas (sin
// índices compuestos).
async function envioPerteneceAlUid(db, uid, numero) {
  const num = String(numero);
  // Primero el índice raíz (solo lo escribe el servidor): es la prueba fuerte.
  // Ledger y envíos quedan como respaldo para etiquetas anteriores al índice.
  try {
    const idx = await db.collection("andreani_idx").doc(num).get();
    if (idx.exists) return String(idx.data()?.uid || "") === String(uid);
  } catch (_) {}
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

// Motor de cercanías (lo usan la acción sucursales_cercanas y el checkout de
// Shopify): ancla = geocodificación de la dirección → tokens → centroide del
// CP/localidad; ranking por distancia con dedupe. Devuelve {sucursales,
// origen, aproximado?, sinOrigen?, stats, error?} — nunca lanza.
export async function sucursalesCercanasCore(db, env, body) {
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
    } catch (e) { return { sucursales: [], error: e.message }; }
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
      return { sucursales: conDist, origen: origen.descripcion, stats };
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
      return { sucursales: lista, origen: esCabaL ? "CABA" : loc, aproximado: true, stats };
    }
  }
  // Sin coordenadas o sin ancla: aproximación por CP (mismo CP primero,
  // después el resto de la misma localidad).
  if (cp) {
    const mismoCp = geo.filter(s => String(s.p || "").replace(/\D/g, "") === cp);
    const locCp = nrmTxt(mismoCp[0]?.l || loc || "");
    const mismaLoc = locCp ? geo.filter(s => nrmTxt(s.l || "") === locCp && !mismoCp.includes(s)) : [];
    const lista = dedupe([...mismoCp, ...mismaLoc]).slice(0, 40).map(expand);
    if (lista.length) return { sucursales: lista, origen: `CP ${cp}`, aproximado: true, stats };
  }
  return { sucursales: [], sinOrigen: true, stats };

}

// ─── Tienda DEMO ───────────────────────────────────────────────────────────
// Una tienda con users/{uid}.demo.activo no toca la API de Andreani (salvo el
// listado de sucursales, solo lectura), ni la billetera, ni manda mails:
// estado, cotización, emisión, etiqueta, trazas y cargas se simulan con las
// MISMAS respuestas que el flujo real. La etiqueta "emitida" queda en
// users/{uid}/envios como una real (Seguimientos la muestra) y su traza en
// demo_tracks (la lee update-shipping action=tracking). Sin débito: el saldo
// ficticio no cambia. Devuelve true si respondió; false = seguir por el
// camino normal (que para una demo solo lee/escribe Firestore).
const DATOS_PAGO_DEMO = { alias: "growith.demo.envios", titular: "Growith Demo SRL", cbu: "0000003100012345678901" };

// Rótulo 10×15 cm con la marca "demostración" (pdf-lib, sin API).
async function etiquetaDemoPdf(numero, e, uData) {
  const { PDFDocument, StandardFonts, rgb, degrees } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const W = 283.46, H = 425.2;
  const page = doc.addPage([W, H]);
  const fB = await doc.embedFont(StandardFonts.HelveticaBold);
  const fR = await doc.embedFont(StandardFonts.Helvetica);
  const limpio = (s) => String(s ?? "").replace(/[^\x20-\x7E\xA0-\xFF]/g, "").slice(0, 60);
  const txt = (s, x, y, size, font = fR, color = rgb(0, 0, 0)) => page.drawText(limpio(s), { x, y, size, font, color });
  page.drawText("DEMO", { x: 40, y: 120, size: 110, font: fB, color: rgb(0.9, 0.9, 0.9), rotate: degrees(35) });
  page.drawRectangle({ x: 0, y: H - 44, width: W, height: 44, color: rgb(0.1, 0.1, 0.12) });
  txt("ETIQUETA DE DEMOSTRACIÓN", 14, H - 24, 13, fB, rgb(1, 1, 1));
  txt("No válida para despachar · Growith Demo", 14, H - 37, 8, fR, rgb(0.85, 0.85, 0.85));
  txt("Envío N°", 14, H - 66, 9);
  txt(numero, 14, H - 86, 18, fB);
  // Código de barras decorativo a partir de los dígitos
  let bx = 14;
  for (const ch of String(numero).replace(/\D/g, "")) {
    const d = Number(ch);
    for (const w of [1 + (d % 3), 1 + ((d + 1) % 2), 2 + (d % 2)]) { page.drawRectangle({ x: bx, y: H - 150, width: w, height: 52, color: rgb(0, 0, 0) }); bx += w + 1.6; }
    if (bx > W - 20) break;
  }
  const a = e?.andreani || {};
  const esSuc = a.tipo === "sucursal" || !!e?.esSucursal;
  let y = H - 176;
  txt("DESTINATARIO", 14, y, 8, fB); y -= 15;
  txt(e?.destinatario?.nombre || e?.cliente || "", 14, y, 12, fB); y -= 14;
  txt(esSuc ? "Retiro en sucursal Andreani" : "Entrega a domicilio", 14, y, 9); y -= 12;
  txt([e?.localidad, e?.provincia].filter(Boolean).join(", "), 14, y, 9); y -= 22;
  const o = uData?.andreaniOrigen || {}, r = uData?.andreaniRemitente || {};
  txt("REMITENTE", 14, y, 8, fB); y -= 14;
  txt(r.nombreCompleto || "Growith Demo", 14, y, 10); y -= 12;
  txt([[o.calle, o.numero].filter(Boolean).join(" "), o.localidad, o.codigoPostal ? "CP " + o.codigoPostal : ""].filter(Boolean).join(", "), 14, y, 9); y -= 22;
  txt(`Pedido #${e?.numero || ""}  ·  ${esSuc ? "A sucursal" : "A domicilio"}${a.fechaEstimadaDeEntrega ? "  ·  Entrega estimada " + String(a.fechaEstimadaDeEntrega).slice(0, 10) : ""}`, 14, y, 8);
  page.drawRectangle({ x: 8, y: 8, width: W - 16, height: H - 16, borderColor: rgb(0, 0, 0), borderWidth: 1 });
  return Buffer.from(await doc.save()).toString("base64");
}

async function accionAndreaniDemo({ req, res, db, uid, action, body, uData }) {
  const responder = (payload, status = 200) => { res.status(status).json(payload); return true; };
  const userRef = db.collection("users").doc(uid);
  const saldo = Math.round(Number(uData.andreaniSaldo) || 0);
  const origen = uData.andreaniOrigen || null, remitente = uData.andreaniRemitente || null;
  const estimadas = Math.floor(saldo / 8500);
  const pesoDe = (bultos) => Math.round(bultos.reduce((s, b) => s + Math.max(b.kilos, (b.largoCm * b.altoCm * b.anchoCm) / 4000), 0) * 100) / 100;
  const ERR_BULTOS = "bultos inválidos: cada bulto necesita kilos, largoCm, altoCm y anchoCm mayores a 0.";

  if (action === "status") {
    return responder({
      ok: true, enabled: true, saldo, etiquetasEstimadas: estimadas, saldoBajo: estimadas < 5,
      origenConfigurado: !!(origen?.codigoPostal && origen?.calle && origen?.localidad && remitente?.nombreCompleto && remitente?.documentoNumero),
      origen, remitente, sucOrigen: uData.andreaniSucOrigen || null, esAdmin: false,
    });
  }

  if (action === "cotizar") {
    const tipo = body.tipo === "sucursal" ? "sucursal" : "domicilio";
    const cpDestino = String(body.cpDestino || "").replace(/\D/g, "");
    const bultos = normalizarBultos(body.bultos);
    if (!cpDestino) return responder({ error: "cpDestino requerido" }, 400);
    if (!bultos) return responder({ error: ERR_BULTOS }, 400);
    const peso = pesoDe(bultos);
    return responder({ precio: precioEtiquetaDemo(tipo, cpDestino, peso), pesoAforado: peso, saldo });
  }

  if (action === "emitir") {
    if (req.method !== "POST") return responder({ error: "POST requerido" }, 405);
    const { envioId = null, destino, destinatario } = body;
    const tipo = body.tipo === "sucursal" ? "sucursal" : "domicilio";
    if (!/^[\w.\-]{1,80}$/.test(String(envioId || ""))) return responder({ error: "envioId inválido: la etiqueta tiene que corresponder a un pedido." }, 400);
    const cpDestino = String(body.cpDestino || "").replace(/\D/g, "");
    const bultos = normalizarBultos(body.bultos);
    if (!cpDestino) return responder({ error: "cpDestino requerido" }, 400);
    if (!bultos) return responder({ error: ERR_BULTOS }, 400);
    if (!destinatario?.nombreCompleto) return responder({ error: "destinatario.nombreCompleto requerido" }, 400);
    if (tipo === "sucursal") {
      if (!destino?.sucursalId) return responder({ error: "destino.sucursalId requerido para envío a sucursal" }, 400);
    } else {
      const p = destino?.postal;
      if (!p?.codigoPostal || !p?.calle || !p?.numero || !p?.localidad) return responder({ error: "destino.postal necesita codigoPostal, calle, numero y localidad" }, 400);
    }
    if (!origen?.codigoPostal || !origen?.calle || !remitente?.nombreCompleto || !remitente?.documentoNumero) {
      return responder({ error: "Falta configurar la dirección de origen y los datos del remitente (chip Saldo de envíos → Datos del remitente).", code: "origen_no_configurado" }, 400);
    }
    const envioRef = userRef.collection("envios").doc(String(envioId));
    const ya = (await envioRef.get()).data()?.andreani;
    if (ya?.numeroDeEnvio) {
      return responder({ ok: true, yaEmitido: true, numeroDeEnvio: ya.numeroDeEnvio, precio: ya.precio ?? null, saldoRestante: saldo, fechaEstimadaDeEntrega: ya.fechaEstimadaDeEntrega ?? null });
    }
    // Sucursal destino contra el listado oficial (solo lectura), igual que la
    // verificación del flujo real; si no se puede consultar, sigue sin ella.
    let cpTarifa = cpDestino, sucursalDestino = null;
    if (tipo === "sucursal") {
      const envA = andreaniEnv();
      if (envA) {
        try {
          const s = (await sucursalesTodas(db, envA)).find(x => String(x.id) === String(destino.sucursalId));
          if (s) {
            sucursalDestino = { id: s.id, descripcion: s.descripcion || "", direccion: s.direccion || null };
            cpTarifa = String(s.direccion?.codigoPostal || "").replace(/\D/g, "") || cpDestino;
          }
        } catch (_) {}
      }
    } else {
      cpTarifa = String(destino.postal.codigoPostal).replace(/\D/g, "") || cpDestino;
    }
    const precio = precioEtiquetaDemo(tipo, cpTarifa, pesoDe(bultos));
    const numeroDeEnvio = numeroEnvioDemo();
    const fechaEstimadaDeEntrega = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    await envioRef.set({
      andreani: { numeroDeEnvio, estado: "Pendiente", precio, tipo, fechaEstimadaDeEntrega, ts: FieldValue.serverTimestamp(), demo: true },
      destinatario: {
        nombre: String(destinatario.nombreCompleto || "").trim().slice(0, 120),
        email: String(destinatario.email || "").trim().slice(0, 160),
        telefono: String(destinatario.telefono || "").replace(/[^\d+]/g, "").slice(0, 25),
      },
    }, { merge: true });
    await registrarTrackDemo(db, uid, numeroDeEnvio, envioId, trazaDemo([["pendiente", Date.now()]]));
    return responder({ ok: true, numeroDeEnvio, precio, saldoRestante: saldo, etiquetasEstimadas: estimadas, saldoBajo: false, fechaEstimadaDeEntrega, estado: "Pendiente", sucursalDestino });
  }

  if (action === "etiqueta") {
    const numero = String(body.numero || "").trim();
    if (!numero) return responder({ error: "numero requerido" }, 400);
    let e = null;
    for (const campo of ["andreani.numeroDeEnvio", "tracking"]) {
      const q = await userRef.collection("envios").where(campo, "==", numero).limit(1).get();
      if (!q.empty) { e = q.docs[0].data(); break; }
    }
    if (!e) return responder({ error: "Ese envío no pertenece a tu cuenta." }, 403);
    return responder({ pdf: await etiquetaDemoPdf(numero, e, uData), demo: true });
  }

  if (action === "trazas") {
    const numero = String(body.numero || "").trim();
    if (!/^[\w.\-]{1,80}$/.test(numero)) return responder({ error: "numero requerido" }, 400);
    const dt = await db.collection("demo_tracks").doc(numero).get();
    if (!dt.exists || dt.data().uid !== uid) return responder({ error: "Ese envío no pertenece a tu cuenta." }, 403);
    return responder({ trazas: { eventos: Array.isArray(dt.data().eventos) ? dt.data().eventos : [] } });
  }

  // Billetera: sin cargas reales (ni transferencias registradas ni Mercado Pago).
  if (action === "carga_solicitar") {
    const monto = Math.round(Number(body.monto));
    if (!isFinite(monto) || monto < 1000) return responder({ error: "El monto mínimo de carga es $1.000." }, 400);
    if (monto > 10000000) return responder({ error: "Monto demasiado alto." }, 400);
    const ref = "GW-" + Array.from(randomBytes(4)).map(b => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
    return responder({ ok: true, carga: { id: "demo_" + Date.now().toString(36), ref, monto, estado: "pendiente" }, datosPago: DATOS_PAGO_DEMO });
  }
  if (action === "carga_mp") return responder({ error: "En la tienda demo no se cobran cargas con Mercado Pago (no se mueve plata real)." }, 400);
  if (action === "cargas") return responder({ ok: true, cargas: [], datosPago: DATOS_PAGO_DEMO });
  if (action === "carga_comprobante" || action === "carga_cancelar") return responder({ ok: true });

  return false;
}

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
    const ACCIONES_POST = new Set(["save_origen", "carga_solicitar", "carga_mp", "carga_cancelar", "carga_comprobante", "caso_crear", "caso_comentar", "anular_inmediata", "admin_acreditar", "admin_carga_acreditar", "admin_carga_rechazar", "admin_caso_estado", "admin_conciliar", "admin_idx_backfill", "admin_dudoso_resolver", "admin_anulada_debitar", "admin_cache_purge", "admin_markup_cliente"]);
    if (ACCIONES_POST.has(action) && req.method !== "POST") return res.status(405).json({ error: "POST requerido" });

    // Webhook de Mercado Pago: lo llama MP, no un usuario — sin sesión
    // Firebase. Se valida con la firma HMAC de MP (MP_WEBHOOK_SECRET).
    if (action === "mp_webhook") return await mpWebhook(req, res, db, body);
    // Portal de la ejecutiva de Andreani: sin sesión Firebase, autenticado por token.
    if (action === "portal_ejecutiva" || action === "portal_ejecutiva_fotos" || action === "portal_ejecutiva_responder") return await portalEjecutiva(req, res, db, body, action);
    // Índice de puntos HOP: barrido por tandas de /v2/sucursales/{id} (cron de
    // Vercel, CRON_SECRET). Ver api/_hop.js. Avisa al fundador (máx. una vez
    // por día, hop_idx_meta.ultimoAvisoTs) si una vuelta se descarta / falla
    // mucho, o si seguimos sirviendo la foto del repo y ya tiene más de 7 días.
    if (action === "hop_index_cron") {
      if (!guardCron(req, res)) return;
      const envC = andreaniEnv();
      if (!envC) return res.status(500).json({ error: "andreani_no_configurado" });
      const out = await hopIndexSweep(db, (id) => andreaniFetch(db, envC, `/v2/sucursales/${id}`));
      try {
        const avisos = [];
        if (out.ok === false) avisos.push(`La corrida del índice HOP falló: ${out.error || "sin detalle"}.`);
        await hopIndexTodas(db); // carga el origen real en esta instancia
        const edadFoto = Date.now() - (hopIndexFotoTs() || 0);
        if (hopIndexOrigen() === "foto" && edadFoto > 7 * 86400000) avisos.push(`El índice HOP sigue sirviendo la foto del repo (api/_hop_index.json) de hace ${Math.floor(edadFoto / 86400000)} días: ninguna vuelta completa del cron la reemplazó.`);
        if (avisos.length) {
          const metaRef = db.collection("andreani_config").doc("hop_idx_meta");
          const ultimo = Number((await metaRef.get()).data()?.ultimoAvisoTs) || 0;
          if (Date.now() - ultimo > 86400000) {
            await metaRef.set({ ultimoAvisoTs: Date.now() }, { merge: true });
            await mailFundador(db, "Índice de puntos HOP — atención", `<p>${avisos.join("</p><p>")}</p><p>Revisá Admin › Sistema › Índice HOP (cursor, última vuelta) y la sonda de Andreani.</p>`);
          }
        }
      } catch (e) { console.warn("[hop_index_cron] aviso:", e.message); }
      return res.json(out);
    }
    // Aviso proactivo de saldo bajo (cron diario): cada cuenta habilitada con
    // users/{uid}.enviosCfg.saldoBajoUmbral > 0 recibe un mail cuando el saldo
    // queda por debajo, como mucho cada 20 h (users/{uid}.saldoBajoAvisoTs).
    if (action === "saldo_cron") {
      if (!guardCron(req, res)) return;
      const cfgS = await getGlobalConfig(db);
      const out = { revisadas: 0, avisadas: 0, errores: 0 };
      const t0 = Date.now();
      for (const u of cfgS.habilitados) {
        if (Date.now() - t0 > 40000) { out.truncado = true; break; }
        try {
          const uRef = db.collection("users").doc(String(u));
          const ud = (await uRef.get()).data();
          if (!ud || esDemo(ud)) continue;
          out.revisadas++;
          const saldo = Math.round(Number(ud.andreaniSaldo) || 0);
          const umbral = Math.round(Number(ud.enviosCfg?.saldoBajoUmbral) || 0);
          if (!(umbral > 0) || saldo >= umbral) continue;
          if (Date.now() - (Number(ud.saldoBajoAvisoTs) || 0) <= 20 * 3600000) continue;
          const destinos = [...new Set([String(ud.email || "").trim(), ...(Array.isArray(ud.notifEmails) ? ud.notifEmails.map(x => String(x || "").trim()) : [])].filter(Boolean))];
          if (!destinos.length) continue;
          await uRef.set({ saldoBajoAvisoTs: Date.now() }, { merge: true });
          const html = `<div style="font-family:Inter,system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fff;color:#374151">
  <div style="font-size:18px;font-weight:700;color:#111827;margin-bottom:16px">Saldo de envíos bajo</div>
  <p style="font-size:14px">Tu saldo de envíos Andreani es <strong>$${saldo.toLocaleString("es-AR")}</strong>, por debajo del umbral de aviso que configuraste (<strong>$${umbral.toLocaleString("es-AR")}</strong>).</p>
  <p style="font-size:13px">Para seguir emitiendo sin interrupciones, cargá saldo desde Envíos &rarr; Saldo de envíos en Growith.</p>
  <p style="font-size:12px;color:#9ca3af;text-align:center;margin-top:24px">Growith — Envíos</p>
</div>`;
          await Promise.allSettled(destinos.map(to => sendEmail({ to, subject: `Saldo de envíos bajo: $${saldo.toLocaleString("es-AR")}`, html })));
          out.avisadas++;
        } catch (e) { out.errores++; console.warn("[saldo_cron]", u, e.message); }
      }
      return res.json({ ok: true, ...out, ms: Date.now() - t0 });
    }

    // Todas las acciones exigen sesión válida. La identidad sale del TOKEN.
    const user = await verifyAuth(req);
    if (!user) return res.status(401).json({ error: "Sesión inválida. Recargá la página e iniciá sesión de nuevo." });
    // "Ver como cliente" (token de impersonación): nada que escriba.
    const ro = readOnlyBlock(req, user);
    if (ro) return res.status(ro.code).json({ error: ro.error, readOnly: true });
    // Multi-tenant: la TIENDA sobre la que se opera (billetera, envíos,
    // seguimientos, casos) es la activa en el navegador — una colaboradora o un
    // perfil multi-tienda emite con el saldo de la tienda, no con el suyo. El
    // front la manda en X-Growith-Tienda (o uid en body/query). requireUid
    // verifica que el token tenga acceso a esa cuenta con la sección Envíos.
    // Las acciones admin_* siguen atadas al uid del token.
    let uid = user.uid;
    const tiendaUid = String(body.uid || req.query?.uid || req.headers["x-growith-tienda"] || "").trim();
    // Consultas de catálogo (sucursales, localidades): no tocan datos de la
    // cuenta, las usan también Canjes y el checkout — sin exigir la sección.
    const CATALOGO = new Set(["sucursales", "sucursales_buscar", "sucursales_cercanas", "sucursal_por_id", "validar_sucursales_tpl"]);
    if (tiendaUid && tiendaUid !== user.uid && !String(action).startsWith("admin_") && !CATALOGO.has(String(action))) {
      const g = await requireUid(req, tiendaUid, "envios");
      if (!g.ok) return res.status(g.code).json({ error: g.error });
      uid = tiendaUid;
    }

    // ── Tienda DEMO: antes de todo lo que toca Andreani, la billetera o mails ──
    let uDemo = null;
    if (!String(action).startsWith("admin_") && !CATALOGO.has(String(action))) {
      const sDemo = await db.collection("users").doc(uid).get();
      if (esDemo(sDemo.data())) uDemo = sDemo.data();
    }
    if (uDemo && (await accionAndreaniDemo({ req, res, db, uid, action, body, uData: uDemo }))) return;

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
          const lista = (await sucursalesPorCp(db, env, o.codigoPostal)).filter(s => !s.hop);
          if (lista.length) {
            sucOrigen = { ...lista[0], confirmada: false, ts: Date.now() };
            await userRef.set({ andreaniSucOrigen: sucOrigen }, { merge: true });
          }
        }
      } catch (_) { /* best-effort: sin sugerencia el front ofrece el buscador */ }
      return res.json({ ok: true, origen: o, remitente: rmt, sucOrigen });
    }

    // ── sucursales ────────────────────────────────────────────────────────
    // ── Memoria de puntos de retiro ─────────────────────────────────────────
    // Clave = ghPuntoKey del front (nombre|calle|número|CP del punto que eligió
    // el cliente en la tienda). Dos niveles:
    //  · propia: users/{owner}/envios_cfg/punto_map {entries} — sincroniza la
    //    elección manual entre dispositivos y miembros de la cuenta.
    //  · global: andreani_config/punto_map_global {entries} — SOLO elecciones
    //    verificadas (misma calle y número que el punto), así una elección
    //    equivocada nunca se propaga a todas las cuentas. El admin la puede podar.
    if (action === "punto_map_get" || action === "punto_map_set" || action === "punto_map_del" || action === "punto_map_sync") {
      // La tienda (body/query uid o X-Growith-Tienda) ya pasó por requireUid
      // arriba: `uid` es el owner validado con la sección Envíos.
      const owner = uid;
      const propioRef = db.collection("users").doc(owner).collection("envios_cfg").doc("punto_map");
      const globalRef = db.collection("andreani_config").doc("punto_map_global");
      if (action === "punto_map_get") {
        const [p, g] = await Promise.all([propioRef.get().catch(() => null), globalRef.get().catch(() => null)]);
        return res.json({ ok: true, propio: p?.exists ? (p.data().entries || {}) : {}, global: g?.exists ? (g.data().entries || {}) : {} });
      }
      if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
      // punto_map_sync: sube de una vez las memorias que el navegador tenía en
      // localStorage de antes de la sincronización (10/sep) y el servidor no
      // tiene. Solo propias (nunca global: no están verificadas). body.entries
      // = {key: {tpl?|oficial?}} — máx. 300, mismo saneo que punto_map_set.
      if (action === "punto_map_sync") {
        const src = body.entries && typeof body.entries === "object" && !Array.isArray(body.entries) ? body.entries : {};
        const cur = (await propioRef.get().catch(() => null))?.data()?.entries || {};
        const nuevas = {};
        for (const [k0, datos] of Object.entries(src).slice(0, 300)) {
          const key = String(k0 || "").trim().slice(0, 400);
          if (!key || cur[key] || !datos || typeof datos !== "object") continue;
          const e = { ts: Number(datos.ts) || Date.now(), migrada: true,
            ...(datos.tpl ? { tpl: String(datos.tpl).slice(0, 200) } : {}),
            ...(datos.oficial && typeof datos.oficial === "object" ? { oficial: {
              id: datos.oficial.id ?? null, codigo: datos.oficial.codigo ?? null, numero: datos.oficial.numero ?? null,
              descripcion: String(datos.oficial.descripcion || "").slice(0, 200),
              direccion: datos.oficial.direccion && typeof datos.oficial.direccion === "object" ? {
                calle: String(datos.oficial.direccion.calle || "").slice(0, 120), numero: String(datos.oficial.direccion.numero || "").slice(0, 20),
                localidad: String(datos.oficial.direccion.localidad || "").slice(0, 80), codigoPostal: String(datos.oficial.direccion.codigoPostal || "").slice(0, 12),
              } : null,
            } } : {}) };
          if (e.tpl || e.oficial) nuevas[key] = e;
        }
        const n = Object.keys(nuevas).length;
        if (n) await propioRef.set({ entries: nuevas }, { merge: true });
        return res.json({ ok: true, subidas: n });
      }
      const key = String(body.key || "").trim().slice(0, 400);
      if (!key) return res.status(400).json({ error: "key requerida" });
      if (action === "punto_map_del") {
        await propioRef.set({ entries: {} }, { merge: true });
        await propioRef.update(new FieldPath("entries", key), FieldValue.delete()).catch(() => {});
        return res.json({ ok: true });
      }
      const datos = body.datos && typeof body.datos === "object" ? body.datos : {};
      const entry = {
        ts: Date.now(),
        ...(datos.tpl ? { tpl: String(datos.tpl).slice(0, 200) } : {}),
        ...(datos.oficial && typeof datos.oficial === "object" ? { oficial: {
          id: datos.oficial.id ?? null, codigo: datos.oficial.codigo ?? null, numero: datos.oficial.numero ?? null,
          descripcion: String(datos.oficial.descripcion || "").slice(0, 200),
          direccion: datos.oficial.direccion && typeof datos.oficial.direccion === "object" ? {
            calle: String(datos.oficial.direccion.calle || "").slice(0, 120), numero: String(datos.oficial.direccion.numero || "").slice(0, 20),
            localidad: String(datos.oficial.direccion.localidad || "").slice(0, 80), codigoPostal: String(datos.oficial.direccion.codigoPostal || "").slice(0, 12),
          } : null,
        } } : {}),
      };
      if (!entry.tpl && !entry.oficial) return res.status(400).json({ error: "datos requeridos" });
      await propioRef.set({ entries: { [key]: entry } }, { merge: true });
      // A la memoria global solo si el front verificó el match estricto y hay id oficial.
      let global = false;
      if (body.verificado === true && entry.oficial && entry.oficial.id != null) {
        let email = "", ownerDemo = false;
        try { const od = (await db.collection("users").doc(owner).get()).data(); email = od?.email || ""; ownerDemo = esDemo(od); } catch (_) {}
        // Tienda DEMO: sus puntos de retiro son ficticios — nunca a la memoria global.
        if (!ownerDemo && !uDemo) {
          const punto = body.punto && typeof body.punto === "object" ? { nombre: String(body.punto.nombre || "").slice(0, 120), dir: String(body.punto.dir || "").slice(0, 160), loc: String(body.punto.loc || "").slice(0, 80), cp: String(body.punto.cp || "").slice(0, 12) } : null;
          await globalRef.set({ entries: { [key]: { ...entry, by: owner, byEmail: email, punto } } }, { merge: true });
          global = true;
        }
      }
      return res.json({ ok: true, global });
    }

    if (action === "sucursales") {
      const cp = String(body.cp || "").replace(/\D/g, "");
      if (!cp) return res.status(400).json({ error: "cp requerido" });
      try {
        return res.json({ sucursales: await sucursalesPorCp(db, env, cp) });
      } catch (e) {
        return res.status(502).json({ error: e.message });
      }
    }

    // ── validar_sucursales_tpl: ¿algún nombre del desplegable del Excel está
    // DADO DE BAJA? El template es la única lista que acepta el importador y
    // lista puntos que ya no operan: con uno adentro Andreani rechaza el
    // archivo ENTERO sin explicación (HOP Avenida Rivadavia 255, #6188,
    // 3/9/2026). No se puede contrastar contra la API oficial: /v2/sucursales
    // NO trae muchos puntos HOP que el Excel sí acepta (probado el 3/9: 7 HOP
    // válidos acusados como faltantes). Por eso la fuente es una lista de
    // bajas CONFIRMADAS (rechazo real de Andreani): seed en código +
    // andreani_config/tpl_baja {nombres:[]} que administra el admin.
    if (action === "validar_sucursales_tpl") {
      const nombres = Array.isArray(body.nombres) ? body.nombres.map(String).filter(Boolean).slice(0, 300) : [];
      if (!nombres.length) return res.json({ faltantes: [] });
      const K = s => nrmTxt(s).replace(/\s+/g, " ").trim();
      let extra = [];
      try { const d = (await db.collection("andreani_config").doc("tpl_baja").get()).data(); extra = Array.isArray(d?.nombres) ? d.nombres : []; } catch (_) {}
      const baja = new Set([...TPL_BAJA_SEED, ...extra].map(K));
      return res.json({ faltantes: nombres.filter(t => baja.has(K(t))), fuente: "bajas_confirmadas" });
    }

    // ── admin_tpl_baja: agregar/quitar nombres del desplegable dados de baja
    // (solo admin). body: { agregar:[...], quitar:[...] }
    if (action === "admin_tpl_baja") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
      if (!(await isPlatformAdmin(db, uid))) return res.status(403).json({ error: "Solo admin" });
      const ref = db.collection("andreani_config").doc("tpl_baja");
      const cur = (await ref.get()).data()?.nombres || [];
      const K = s => nrmTxt(s).replace(/\s+/g, " ").trim();
      const quitar = new Set((Array.isArray(body.quitar) ? body.quitar : []).map(K));
      const agregar = (Array.isArray(body.agregar) ? body.agregar : []).map(String).map(s => s.trim()).filter(Boolean);
      const out = [...new Map([...cur.filter(n => !quitar.has(K(n))), ...agregar].map(n => [K(n), n])).values()].slice(0, 500);
      if (agregar.length || quitar.size) {
        await ref.set({ nombres: out, updatedAt: new Date().toISOString(), by: uid });
        await logAdminAndreani(db, uid, "sucursales_baja", null, [agregar.length ? "Agregó: " + agregar.join(", ") : "", quitar.size ? "Quitó: " + [...quitar].join(", ") : ""].filter(Boolean).join(" · "));
      }
      return res.json({ ok: true, nombres: out, seed: TPL_BAJA_SEED });
    }

    // ── sucursal_por_id: la sucursal oficial por id (pedidos del checkout de
    // Shopify traen el id en el código del método de envío: ANDREANI_SUC_<id>).
    if (action === "sucursal_por_id") {
      const id = String(body.id || "").trim();
      if (!id) return res.status(400).json({ error: "id requerido" });
      const cp = String(body.cp || "").replace(/\D/g, "");
      let s = null;
      try { if (cp) s = (await sucursalesPorCp(db, env, cp)).find(x => String(x.id) === id) || null; } catch (_) {}
      if (!s) { try { s = (await sucursalesTodas(db, env)).find(x => String(x.id) === id) || null; } catch (e) { return res.status(502).json({ error: e.message }); } }
      return res.json({ sucursal: s });
    }

    // ── admin_hop_prueba: crea una orden REAL a un punto HOP probando cada
    //    identificador posible (id, código, número, uuid del sitio público, …)
    //    hasta que Andreani acepte uno. Sin débito ni doc de envío: destinatario
    //    = el propio remitente y "NO DESPACHAR"; sin ingreso a la red, Andreani
    //    no la factura. Es la forma de descubrir qué espera su API sin adivinar.
    if (action === "admin_hop_prueba") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
      if (!(await isPlatformAdmin(db, uid))) return res.status(403).json({ error: "Solo admin" });
      const sid = String(body.sucursalId || "").replace(/\D/g, ""); if (!sid) return res.status(400).json({ error: "Poné el id del punto (ej. 18615)." });
      const uData = (await db.collection("users").doc(uid).get()).data() || {};
      const origen = uData.andreaniOrigen, remitente = uData.andreaniRemitente;
      if (!origen?.codigoPostal || !origen?.calle || !remitente?.nombreCompleto || !remitente?.documentoNumero) return res.status(400).json({ error: "Tu cuenta no tiene origen y remitente cargados (Envíos → Datos del remitente)." });
      const rv = await andreaniFetch(db, env, `/v2/sucursales/${sid}`); const vivo = rv.ok ? await rv.json().catch(() => null) : null;
      if (!vivo) return res.status(400).json({ error: `Andreani no resuelve /v2/sucursales/${sid} (HTTP ${rv.status}).` });
      // Identificador del sitio público (uuid) y puntoDeTerceroId, por coordenadas.
      let uuid = null, pub = null;
      try { const lat = vivo.coordenadas?.latitud, lng = vivo.coordenadas?.longitud;
        if (lat && lng) { const rp = await fetchTimeout(`https://www.andreani.com/api/sucursales/byCoordenadas?lat=${lat}&lng=${lng}`, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } }); const jp = await rp.json().catch(() => null); const arr = Array.isArray(jp) ? jp : [];
          pub = arr.find(x => String(x.puntoDeTerceroId) === sid || String(x.idSucursal) === sid) || arr.find(x => String(x.descripcion || "").trim().toUpperCase() === String(vivo.descripcion || "").trim().toUpperCase()) || null; uuid = pub?.id || null; } } catch (_) {}
      const limpiarTxt = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9\s.,-]/g, " ").replace(/\s{2,}/g, " ").trim();
      const locOrigen = await resolverLocalidad(origen.codigoPostal, [origen.localidad], origen.region).catch(() => null);
      const personaDe = (p) => ({ nombreCompleto: limpiarTxt(p.nombreCompleto), email: String(p.email || "").trim(), documentoTipo: "DNI", documentoNumero: String(p.documentoNumero || "").replace(/[.\-\s]/g, ""), telefonos: [{ tipo: 1, numero: String(p.telefono || "").trim() }] });
      const base = { contrato: env.contratoSucursal,
        origen: { postal: { codigoPostal: origen.codigoPostal, calle: limpiarTxt(origen.calle), numero: origen.numero, localidad: limpiarTxt(locOrigen ? locOrigen.localidad : origen.localidad), region: limpiarTxt(locOrigen ? locOrigen.provincia : (origen.region || "")), pais: "Argentina" } },
        remitente: personaDe(remitente), destinatario: [personaDe({ ...remitente, nombreCompleto: "PRUEBA API GROWITH NO DESPACHAR" })], productoAEntregar: "PRUEBA API - NO DESPACHAR",
        bultos: [{ kilos: 0.2, largoCm: 10, altoCm: 5, anchoCm: 10, volumenCm: 500, valorDeclaradoSinImpuestos: 826, valorDeclaradoConImpuestos: 1000, referencias: [{ meta: "detalle", contenido: "PRUEBA API - NO DESPACHAR" }, { meta: "idCliente", contenido: "prueba-hop" }] }] };
      const abast = vivo.datosAdicionales?.sucursalAbastecedora || null;
      // Documentación oficial (api-sucursales-v2-0.xlsx): "/sucursales?contrato=" y
      // "/puntos-de-tercero?contrato=" listan las sucursales y PD3 "asignadas al
      // servicio", con "ID de la sucursal" e "ID no unificado (propiedad id)". El
      // punto que acepta la orden tiene que salir de AHÍ: se busca el mismo HOP en
      // esos listados y se prueban sus ids antes que nada.
      const listas = {}; const deListado = [];
      const mismo = x => x && (String(x.codigo || "").toUpperCase() === String(vivo.codigo || "").toUpperCase() || String(x.descripcion || "").replace(/\s+/g, " ").trim().toUpperCase() === String(vivo.descripcion || "").replace(/\s+/g, " ").trim().toUpperCase() || String(x.id) === sid || (vivo.numero != null && String(x.numero) === String(vivo.numero) && /HOP/i.test(String(x.codigo || x.descripcion || ""))));
      for (const [k, path] of [["sucursales_contrato_suc", `/v2/sucursales?contrato=${encodeURIComponent(env.contratoSucursal)}`], ["pd3_contrato_suc", `/v2/puntos-de-tercero?contrato=${encodeURIComponent(env.contratoSucursal)}`], ["sucursales_contrato_dom", `/v2/sucursales?contrato=${encodeURIComponent(env.contratoEstandar)}`], ["pd3_contrato_dom", `/v2/puntos-de-tercero?contrato=${encodeURIComponent(env.contratoEstandar)}`], ["pd3_sin_contrato", "/v2/puntos-de-tercero"]]) {
        try { const r = await andreaniFetch(db, env, path); const txt = await r.text().catch(() => ""); let j = null; try { j = JSON.parse(txt); } catch (_) {}
          const arr = Array.isArray(j) ? j : (Array.isArray(j?.sucursales) ? j.sucursales : (Array.isArray(j?.puntos) ? j.puntos : (Array.isArray(j?.data) ? j.data : [])));
          const hit = arr.find(mismo) || null; const hops = arr.filter(x => /HOP/i.test(String(x?.codigo || "") + " " + String(x?.descripcion || "")));
          listas[k] = { status: r.status, n: arr.length, hops: hops.length, keys: arr[0] ? Object.keys(arr[0]) : [], hop: hit, ejemploHop: hops[0] || null, ejemplo: hit ? null : (arr[0] || null), cuerpo: arr.length ? null : txt.slice(0, 300) };
          if (hit) for (const [kk, v] of Object.entries(hit)) { if (/id/i.test(kk) && (typeof v === "string" || typeof v === "number") && String(v).trim() && String(v) !== "0") deListado.push([`listado:${k}.${kk}`, { id: String(v).trim() }]); }
        } catch (e) { listas[k] = { error: e.message }; }
      }
      const todas = [
        ...((() => { const c = String(body.contrato || "").replace(/D/g, "") || env.contratoHop; return c ? [["contratoAlt+id", { id: String(vivo.id) }, c], ["contratoAlt+numero", { id: String(vivo.numero || "") }, c], ["contratoAlt+codigo", { id: String(vivo.codigo || "") }, c], ["contratoAlt+madre", { id: String(abast?.id ?? "") }, c]] : []; })()),
        ...deListado,
        ["id", { id: String(vivo.id) }],
        ["codigo", vivo.codigo ? { id: String(vivo.codigo) } : null],
        ["numero", vivo.numero != null ? { id: String(vivo.numero) } : null],
        ["uuid_sitio", uuid ? { id: String(uuid) } : null],
        ["puntoDeTerceroId", pub?.puntoDeTerceroId != null ? { id: String(pub.puntoDeTerceroId) } : null],
        ["id+nomenclatura", vivo.codigo ? { id: String(vivo.id), nomenclatura: String(vivo.codigo) } : null],
        ["id+nomenclatura+descripcion+direccion", { id: String(vivo.id), nomenclatura: String(vivo.codigo || ""), descripcion: String(vivo.descripcion || ""), direccion: vivo.direccion || undefined }],
      ].filter(v => v[1] && v[1].id);
      const pedidas = Array.isArray(body.variantes) && body.variantes.length ? todas.filter(v => body.variantes.includes(v[0])) : todas;
      const resultados = [];
      for (const [nombre, suc, contratoAlt] of pedidas) {
        try {
          const r = await andreaniFetch(db, env, "/v2/ordenes-de-envio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...base, ...(contratoAlt ? { contrato: contratoAlt } : {}), destino: { sucursal: suc } }) });
          const txt = await r.text().catch(() => "");
          let numero = null; try { numero = JSON.parse(txt)?.bultos?.[0]?.numeroDeEnvio || null; } catch (_) {}
          resultados.push({ variante: nombre, enviado: suc, status: r.status, ok: r.ok, numeroDeEnvio: numero, respuesta: txt.slice(0, 500) });
          if (r.ok) break;
        } catch (e) { resultados.push({ variante: nombre, enviado: suc, status: 0, ok: false, respuesta: e.message }); }
      }
      const exito = resultados.find(x => x.ok) || null;
      const resumen = { at: Date.now(), sucursalId: sid, contratoHopConfigurado: !!env.contratoHop, contratoAlt: String(body.contrato || "").replace(/D/g, "") ? "(probado)" : null, listas, vivo: { id: vivo.id, codigo: vivo.codigo, numero: vivo.numero, idgla_integra: vivo.idgla_integra, idgla_alertran: vivo.idgla_alertran, canal: vivo.canal, tipo: vivo.datosAdicionales?.tipo, abastecedora: abast }, uuid, pub: pub ? { id: pub.id, idSucursal: pub.idSucursal, puntoDeTerceroId: pub.puntoDeTerceroId, tipo: pub.tipo } : null, resultados, exito };
      try { await db.collection("andreani_config").doc("hop_prueba").set(JSON.parse(JSON.stringify(resumen)), { merge: false }); } catch (e) { console.warn("[admin_hop_prueba] no se guardó el resumen:", e.message); }
      console.log("[admin_hop_prueba]", JSON.stringify(resumen).slice(0, 3000));
      return res.json(resumen);
    }
    // ── admin_hop_prueba2: segunda ronda. (A) listados por contrato con canal /
    //    tipo / CP para ver si los HOP aparecen bajo otro filtro; (B) órdenes con
    //    los campos de la especificación que nunca mandamos: metadatos de la
    //    sucursal destino, nomenclatura del HOP sobre la sucursal madre,
    //    tipoDeServicio, y destino postal con componente "puntoDeTercero". Cada
    //    orden aceptada dice a qué sucursal de distribución fue: si aparece el HOP,
    //    esa es la forma. Máximo 4 órdenes reales "NO DESPACHAR", sin débito.
    if (action === "admin_hop_prueba2") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
      if (!(await isPlatformAdmin(db, uid))) return res.status(403).json({ error: "Solo admin" });
      const sid = String(body.sucursalId || "").replace(/\D/g, ""); if (!sid) return res.status(400).json({ error: "Poné el id del punto (ej. 18615)." });
      const uData = (await db.collection("users").doc(uid).get()).data() || {};
      const origen = uData.andreaniOrigen, remitente = uData.andreaniRemitente;
      if (!origen?.codigoPostal || !remitente?.nombreCompleto) return res.status(400).json({ error: "Tu cuenta no tiene origen y remitente cargados." });
      const rv = await andreaniFetch(db, env, `/v2/sucursales/${sid}`); const vivo = rv.ok ? await rv.json().catch(() => null) : null;
      if (!vivo) return res.status(400).json({ error: `Andreani no resuelve /v2/sucursales/${sid} (HTTP ${rv.status}).` });
      const cpHop = String(vivo.direccion?.codigoPostal || "").replace(/\D/g, ""); const abast = vivo.datosAdicionales?.sucursalAbastecedora || null;
      const C = encodeURIComponent(env.contratoSucursal), D = encodeURIComponent(env.contratoEstandar);
      // (A) listados
      const listas = {};
      const esDealer = x => /dealer/i.test(String(x?.datosAdicionales?.tipo || x?.tipo || "")) || /^HOP\d/i.test(String(x?.codigo || ""));
      for (const [k, path] of [
        ["suc_contrato_canalHOP", `/v2/sucursales?contrato=${C}&canal=HOP`], ["suc_contrato_canalB2C", `/v2/sucursales?contrato=${C}&canal=B2C`], ["suc_contrato_tipoDealer", `/v2/sucursales?contrato=${C}&tipo=DEALER`],
        ["suc_contrato_cpHop", `/v2/sucursales?contrato=${C}&codigoPostal=${cpHop}`], ["pd3_contrato_cpHop", `/v2/puntos-de-tercero?contrato=${C}&codigoPostal=${cpHop}`], ["pd3_contrato_canalHOP", `/v2/puntos-de-tercero?contrato=${C}&canal=HOP`],
        ["pd3_contratoDom_cpHop", `/v2/puntos-de-tercero?contrato=${D}&codigoPostal=${cpHop}`], ["suc_sinContrato_cpHop_canalHOP", `/v2/sucursales?codigoPostal=${cpHop}&canal=HOP`], ["suc_contrato_id", `/v2/sucursales?contrato=${C}&id=${sid}`], ["suc_contrato_codigo", `/v2/sucursales?contrato=${C}&codigo=${encodeURIComponent(vivo.codigo || "")}`],
      ]) {
        try { const r = await andreaniFetch(db, env, path); const txt = await r.text().catch(() => ""); let j = null; try { j = JSON.parse(txt); } catch (_) {}
          const arr = Array.isArray(j) ? j : (Array.isArray(j?.sucursales) ? j.sucursales : (Array.isArray(j?.puntos) ? j.puntos : (Array.isArray(j?.data) ? j.data : (j && typeof j === "object" && j.id ? [j] : []))));
          const dealers = arr.filter(esDealer); const hit = arr.find(x => String(x?.id) === sid || String(x?.codigo || "").toUpperCase() === String(vivo.codigo || "").toUpperCase()) || null;
          listas[k] = { status: r.status, n: arr.length, dealers: dealers.length, esteHop: hit ? { id: hit.id, codigo: hit.codigo, numero: hit.numero, idgla_integra: hit.idgla_integra, idgla_alertran: hit.idgla_alertran } : null, ejemploDealer: dealers[0] ? { id: dealers[0].id, codigo: dealers[0].codigo, descripcion: dealers[0].descripcion, idgla_integra: dealers[0].idgla_integra, idgla_alertran: dealers[0].idgla_alertran } : null, cuerpo: arr.length ? null : txt.slice(0, 200) };
        } catch (e) { listas[k] = { error: e.message }; }
      }
      // (B) órdenes
      const limpiarTxt = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9\s.,-]/g, " ").replace(/\s{2,}/g, " ").trim();
      const locOrigen = await resolverLocalidad(origen.codigoPostal, [origen.localidad], origen.region).catch(() => null);
      const personaDe = (p) => ({ nombreCompleto: limpiarTxt(p.nombreCompleto), email: String(p.email || "").trim(), documentoTipo: "DNI", documentoNumero: String(p.documentoNumero || "").replace(/[.\-\s]/g, ""), telefonos: [{ tipo: 1, numero: String(p.telefono || "").trim() }] });
      const base = { contrato: env.contratoSucursal,
        origen: { postal: { codigoPostal: origen.codigoPostal, calle: limpiarTxt(origen.calle), numero: origen.numero, localidad: limpiarTxt(locOrigen ? locOrigen.localidad : origen.localidad), region: limpiarTxt(locOrigen ? locOrigen.provincia : (origen.region || "")), pais: "Argentina" } },
        remitente: personaDe(remitente), destinatario: [personaDe({ ...remitente, nombreCompleto: "PRUEBA API GROWITH NO DESPACHAR" })], productoAEntregar: "PRUEBA API - NO DESPACHAR",
        bultos: [{ kilos: 0.2, largoCm: 10, altoCm: 5, anchoCm: 10, volumenCm: 500, valorDeclaradoSinImpuestos: 826, valorDeclaradoConImpuestos: 1000, referencias: [{ meta: "detalle", contenido: "PRUEBA API - NO DESPACHAR" }, { meta: "idCliente", contenido: "prueba-hop" }] }] };
      const metas = [["puntoDeTercero", sid], ["idPuntoDeTercero", sid], ["puntoDeTerceroId", sid], ["pd3", sid], ["idPd3", sid], ["puntoHop", vivo.codigo || ""], ["hop", String(vivo.numero || "")], ["sucursalDeEntrega", sid], ["sucursalEntrega", vivo.codigo || ""], ["nomenclatura", vivo.codigo || ""]].map(([meta, contenido]) => ({ meta, contenido }));
      const dirHop = vivo.direccion || {};
      const intentos = [
        ["madre+metadatos", { ...base, destino: { sucursal: { id: String(abast?.id ?? ""), datosAdicionales: { metadatos: metas } } } }],
        ["madre+nomenclaturaHOP", { ...base, destino: { sucursal: { id: String(abast?.id ?? ""), nomenclatura: String(vivo.codigo || ""), descripcion: String(vivo.descripcion || ""), direccion: dirHop } } }],
        ["hop+tipoDeServicio=HOP", { ...base, tipoDeServicio: "HOP", destino: { sucursal: { id: sid } } }],
        ["hop+tipoDeServicio=PD3", { ...base, tipoDeServicio: "PD3", destino: { sucursal: { id: sid } } }],
        ["postalHOP+componente", { ...base, destino: { postal: { codigoPostal: String(dirHop.codigoPostal || cpHop), calle: limpiarTxt(dirHop.calle), numero: String(dirHop.numero || ""), localidad: limpiarTxt(dirHop.localidad), region: limpiarTxt(dirHop.provincia || ""), pais: "Argentina", componentesDeDireccion: [{ meta: "puntoDeTercero", contenido: sid }, { meta: "puntoHop", contenido: String(vivo.codigo || "") }, { meta: "observaciones", contenido: `ENTREGAR EN ${vivo.descripcion || ""}` }] } } }],
      ].filter(x => !/madre/.test(x[0]) || abast?.id != null);
      const resultados = []; let creadas = 0;
      for (const [nombre, cuerpo] of intentos) {
        if (creadas >= 4) { resultados.push({ variante: nombre, saltada: "tope de órdenes de prueba" }); continue; }
        try {
          const r = await andreaniFetch(db, env, "/v2/ordenes-de-envio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cuerpo) });
          const txt = await r.text().catch(() => ""); let j = null; try { j = JSON.parse(txt); } catch (_) {}
          if (r.ok) creadas++;
          resultados.push({ variante: nombre, destinoEnviado: cuerpo.destino, tipoDeServicio: cuerpo.tipoDeServicio || null, status: r.status, ok: r.ok, numeroDeEnvio: j?.bultos?.[0]?.numeroDeEnvio || null, sucursalDeDistribucion: j?.sucursalDeDistribucion || null, sucursalDeImposicion: j?.sucursalDeImposicion || null, sucursalAbastecedora: j?.sucursalAbastecedora || null, esHop: /HOP/i.test(JSON.stringify(j?.sucursalDeDistribucion || {})), respuesta: r.ok ? null : txt.slice(0, 400) });
        } catch (e) { resultados.push({ variante: nombre, status: 0, ok: false, respuesta: e.message }); }
      }
      const exito = resultados.find(x => x.esHop) || null;
      const resumen = { at: Date.now(), sucursalId: sid, cpHop, abastecedora: abast, listas, resultados, exito };
      try { await db.collection("andreani_config").doc("hop_prueba2").set(JSON.parse(JSON.stringify(resumen)), { merge: false }); } catch (e) { console.warn("[admin_hop_prueba2]", e.message); }
      console.log("[admin_hop_prueba2]", JSON.stringify(resumen).slice(0, 4000));
      return res.json(resumen);
    }
    // ── admin_hop_index: estado del índice de puntos HOP (y correr una tanda a mano).
    if (action === "admin_hop_index") {
      if (!(await isPlatformAdmin(db, uid))) return res.status(403).json({ error: "Solo admin" });
      const meta = (await db.collection("andreani_config").doc("hop_idx_meta").get()).data() || null;
      let corrida = null;
      if (req.method === "POST" && body.correr) corrida = await hopIndexSweep(db, (id) => andreaniFetch(db, env, `/v2/sucursales/${id}`));
      const lista = await hopIndexTodas(db);
      return res.json({ meta, n: lista.length, origen: hopIndexOrigen(), corrida });
    }

    // ── admin_probe: diagnóstico de la API de Andreani (solo admin). Permite
    // probar variantes de /v2/sucursales (canal, tipo, CP) para ver qué
    // devuelve la cuenta real — p.ej. dónde están los puntos HOP.
    if (action === "admin_probe") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
      if (!(await isPlatformAdmin(db, uid))) return res.status(403).json({ error: "Solo admin" });
      // {CONTRATO_SUC} / {CONTRATO_DOM} se reemplazan en el servidor: los
      // números de contrato no viajan al navegador.
      const path = String(body.path || "").trim().replace(/\{CONTRATO_SUC\}/g, encodeURIComponent(env.contratoSucursal)).replace(/\{CONTRATO_DOM\}/g, encodeURIComponent(env.contratoEstandar)).replace(/\{CONTRATO_HOP\}/g, encodeURIComponent(env.contratoHop || ""));
      if (!/^\/v[12]\/(sucursales|puntos-de-tercero|tarifas|localidades|provincias)(\/|\?|$)/.test(path)) return res.status(400).json({ error: "Solo se permite /v1|v2/sucursales, puntos-de-tercero, tarifas, localidades o provincias" });
      const t0 = Date.now();
      const r = await andreaniFetch(db, env, path);
      const txt = await r.text();
      let j = null; try { j = JSON.parse(txt); } catch (_) {}
      const lista = Array.isArray(j) ? j : (Array.isArray(j?.sucursales) ? j.sucursales : null);
      const cuenta = k => { const m = new Map(); for (const x of lista || []) { const v = String(x?.[k] ?? ""); m.set(v, (m.get(v) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15); };
      return res.json({
        status: r.status, ms: Date.now() - t0, count: lista ? lista.length : null,
        keys: lista?.[0] ? Object.keys(lista[0]) : null,
        porTipo: lista ? { tipoDeSucursal: cuenta("tipoDeSucursal"), tipo: cuenta("tipo"), canal: cuenta("canal") } : null,
        hop: lista ? lista.filter(x => /hop/i.test(String(x?.descripcion || "") + " " + String(x?.tipoDeSucursal || x?.tipo || ""))).length : null,
        sample: lista ? lista.slice(0, 3) : null,
        raw: lista ? null : txt.slice(0, 1500),
      });
    }

    // ── sucursales_buscar (buscador global: nombre, calle, número, localidad, CP)
    if (action === "sucursales_buscar") {
      const q = nrmTxt(String(body.q || "").trim());
      if (q.length < 2) return res.status(400).json({ error: "q requiere al menos 2 caracteres" });
      let todas;
      try { todas = await sucursalesTodas(db, env); }
      catch (e) { return res.status(502).json({ error: e.message }); }
      const tokens = q.split(/\s+/).filter(Boolean);
      let out = [];
      const sinHop = body.sinHop === "1" || body.sinHop === true; // buscador de sucursal de ORIGEN
      for (const s of todas) {
        if (sinHop && s.hop) continue;
        const hay = nrmTxt([s.descripcion, s.codigo, s.numero, s.direccion?.calle, s.direccion?.numero, s.direccion?.localidad, s.direccion?.codigoPostal].filter(Boolean).join(" "));
        if (tokens.every(t => hay.includes(t))) out.push(s);
      }
      // Las que matchean por NOMBRE primero (el front cruza contra el texto del
      // Excel) y recién después se corta: antes se cortaba a 20 en orden de
      // listado y el punto buscado podía quedar afuera.
      const enDesc = s => tokens.every(t => nrmTxt(s.descripcion || "").includes(t));
      out.sort((a, b) => (enDesc(b) ? 1 : 0) - (enDesc(a) ? 1 : 0));
      out = out.slice(0, 80);
      return res.json({ sucursales: out });
    }

    // ── sucursales_cercanas: sucursales ordenadas por distancia al punto de
    // retiro ORIGINAL del pedido. El ancla se calcula GEOCODIFICANDO la
    // dirección del pedido (dir/loc/prov/cp) — no depende de que el punto
    // exista en ningún listado. Fallbacks: tokens del punto en el listado
    // oficial → centroide del CP → aproximación por CP sin distancias.
    if (action === "sucursales_cercanas") {
      const out = await sucursalesCercanasCore(db, env, body);
      if (out.error) return res.status(502).json({ error: out.error });
      return res.json(out);
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
          if (s.hop) return res.status(400).json({ error: "Un punto HOP no puede ser la sucursal de origen: elegí una sucursal Andreani." });
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

      const [cfgG, snap, esAdmin] = await Promise.all([
        getGlobalConfig(db), userRef.get(), isPlatformAdmin(db, uid),
      ]);
      if (!esAdmin && !cfgG.habilitados.includes(uid)) return res.status(403).json({ error: "Tu cuenta no tiene habilitado Envíos Andreani. Contactá al soporte." });
      const cfg = cfgParaCuenta(cfgG, snap.data());

      const cot = await cotizarAndreani(db, env, { tipo, cpDestino, bultos, sucursalOrigen: sucOrigenDe(snap.data(), cfg), hop: body.hop === true });
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
      // Presupuesto de tiempo + tiempos por etapa (se loguean al salir, con
      // éxito o error): la function tiene 60 s y NUNCA hay que debitar si
      // Andreani ya se comió la mayor parte.
      const tEmitir0 = Date.now();
      const etapas = {};
      let tEtapa = tEmitir0;
      const marcar = (k) => { const ahora = Date.now(); etapas[k] = (etapas[k] || 0) + (ahora - tEtapa); tEtapa = ahora; };
      try {
      const { envioId = null, destino, destinatario, productoAEntregar, piso, departamento } = body;
      const tipo = body.tipo === "sucursal" ? "sucursal" : "domicilio";
      // Precio que el usuario vio y aceptó en la cotización (si lo manda): si
      // el precio real supera ese valor (markup cambiado, sucursal en otro CP),
      // no se cobra sin que lo vuelva a confirmar.
      const precioAceptado = Math.round(Number(body.precioAceptado) || 0);
      if (!/^[\w.\-]{1,80}$/.test(String(envioId || ""))) return res.status(400).json({ error: "envioId inválido: la etiqueta tiene que corresponder a un pedido." });
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
      const [cfgG, snap, esAdmin] = await Promise.all([
        getGlobalConfig(db), userRef.get(), isPlatformAdmin(db, uid),
      ]);
      if (!esAdmin && !cfgG.habilitados.includes(uid)) return res.status(403).json({ error: "Tu cuenta no tiene habilitado Envíos Andreani. Contactá al soporte." });
      const uData = snap.exists ? snap.data() : {};
      const cfg = cfgParaCuenta(cfgG, uData); // markup por cliente, si lo tiene
      const origen = uData.andreaniOrigen;
      const remitente = uData.andreaniRemitente;
      if (!origen?.codigoPostal || !origen?.calle || !remitente?.nombreCompleto || !remitente?.documentoNumero) {
        return res.status(400).json({ error: "Falta configurar la dirección de origen y los datos del remitente (chip Saldo de envíos → Datos del remitente).", code: "origen_no_configurado" });
      }
      // La sucursal desde la que se despacha tiene que estar CONFIRMADA por el
      // usuario antes de emitir (la tarifa depende del origen).
      if (!uData.andreaniSucOrigen?.confirmada) {
        return res.status(400).json({ error: "Confirmá desde qué sucursal Andreani despachás tus envíos (chip Saldo de envíos → Sucursal de despacho) y reintentá.", code: "sucursal_origen_no_confirmada" });
      }

      // Toda emisión va atada a un pedido: es lo que protege contra la doble
      // emisión (lock + idempotencia por envioId) y lo que ve Seguimientos.
      if (!envioId || !String(envioId).trim()) return res.status(400).json({ error: "envioId requerido: la etiqueta tiene que corresponder a un pedido." });
      const envioRef = userRef.collection("envios").doc(String(envioId));

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
        // Primero el listado del CP (barato: un doc cacheado + índice HOP);
        // el listado completo solo si ahí no está. Fail-closed: sin ningún
        // listado no se emite.
        let listaOk = false;
        const buscar = (lista) => lista.find(x => String(x.id) === String(destino.sucursalId)) || null;
        try { sucDestinoOficial = buscar(await sucursalesPorCp(db, env, cpDestino)); listaOk = true; } catch (_) {}
        if (!sucDestinoOficial) {
          try { sucDestinoOficial = buscar(await sucursalesTodas(db, env)); listaOk = true; } catch (_) {}
        }
        marcar("listado");
        if (!listaOk) return res.status(502).json({ error: "No pudimos validar la sucursal destino contra el listado de Andreani. Reintentá en un minuto.", code: "sucursal_no_validada" });
        if (!sucDestinoOficial) return res.status(400).json({ error: "La sucursal destino no existe en el listado oficial de Andreani — volvé a elegirla." });
        // Punto HOP (sale del índice propio, no del listado de Andreani): se
        // confirma EN VIVO contra /v2/sucursales/{id} antes de debitar —
        // fail-closed: si Andreani no responde, no se emite.
        if (sucDestinoOficial.hop) {
          let rv = null;
          try { rv = await andreaniFetch(db, env, `/v2/sucursales/${encodeURIComponent(String(destino.sucursalId))}`); } catch (_) {}
          marcar("hop");
          if (!rv) return res.status(502).json({ error: "No pudimos confirmar el punto HOP contra Andreani. Reintentá en un minuto.", code: "sucursal_no_validada" });
          if (rv.status === 404) return res.status(400).json({ error: "Andreani ya no tiene activo ese punto HOP: elegí otro punto o sucursal y avisale al cliente.", code: "hop_inactivo" });
          if (!rv.ok) return res.status(502).json({ error: `Andreani respondió ${rv.status} al confirmar el punto HOP. Reintentá en un minuto.`, code: "sucursal_no_validada" });
          const vivo = await rv.json().catch(() => null);
          if (vivo?.direccion) sucDestinoOficial = { ...sucDestinoOficial, ...slimSucursal(vivo), hop: true, raw: vivo };
          if (vivo) console.log(`[emitir] HOP ${destino.sucursalId} vivo: ${JSON.stringify({ id: vivo.id, codigo: vivo.codigo, numero: vivo.numero, idgla_integra: vivo.idgla_integra, idgla_alertran: vivo.idgla_alertran, canal: vivo.canal, tipo: vivo.datosAdicionales?.tipo, abastecedora: vivo.datosAdicionales?.sucursalAbastecedora })}`);
        }
        // 24/9/2026: Andreani valida la orden contra las sucursales y PD3 asignadas
        // al CONTRATO, y el nuestro no tiene los puntos HOP (dealers) asignados:
        // "Sucursal con idgla N no encontrada" para cualquier identificador. Cuando
        // todas las variantes fallan queda hopApiCaidoAt y durante 6 h los HOP se
        // rechazan sin cotizar ni debitar; después se vuelve a probar (si Andreani
        // habilitó los puntos, se emite y la marca se limpia sola).
        if (sucDestinoOficial.hop) {
          const caidoAt = env.contratoHop ? 0 : Math.max(_hopFallaAt || 0, Number(cfgG?.hopApiCaidoAt) || 0);
          if (caidoAt && Date.now() - caidoAt < 6 * 3600000) return res.status(400).json({ error: "Andreani no acepta puntos HOP con nuestro contrato por API: su listado de puntos asignados al contrato no incluye los HOP (desde el 23/9 lo validan). Emití este pedido con \"Generar etiquetas\" (Excel) o a mano en el portal de Andreani. No se debitó nada.", code: "hop_no_habilitado" });
        }
        const cpSuc = String(sucDestinoOficial?.direccion?.codigoPostal || "").replace(/\D/g, "");
        if (cpSuc) cpTarifa = cpSuc;
      } else {
        cpTarifa = String(destino.postal.codigoPostal).replace(/\D/g, "") || cpDestino;
      }

      // b. RE-COTIZAR server-side — nunca confiar en el precio del cliente.
      const cot = await cotizarAndreani(db, env, { tipo, cpDestino: cpTarifa, bultos, sucursalOrigen: sucOrigenDe(uData, cfg), hop: !!sucDestinoOficial?.hop });
      marcar("cotizar");
      const precio = precioConMarkup(cot, cfg);
      if (precioAceptado > 0 && precio > Math.round(precioAceptado * 1.02) + 1) {
        return res.status(409).json({ error: `El precio de esta etiqueta cambió: cotizada en $${precioAceptado.toLocaleString("es-AR")}, ahora cuesta $${precio.toLocaleString("es-AR")}. Volvé a cotizar para confirmar.`, code: "precio_cambio", precio, precioAceptado });
      }

      // Todo lo LENTO que no depende del débito va ANTES de la transacción:
      // así, si Vercel cortara la función, corta sin haber cobrado.
      const limpiarTxt = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9\s.,-]/g, " ").replace(/\s{2,}/g, " ").trim();
      const contrato = contratoDe(env, tipo, !!sucDestinoOficial?.hop);
      let locDestino = null, locOrigen = null;
      if (tipo !== "sucursal") locDestino = await resolverLocalidad(destino.postal.codigoPostal, [destino.postal.localidad, destino.postal.ciudad, destino.postal.partido], destino.postal.region);
      locOrigen = await resolverLocalidad(origen.codigoPostal, [origen.localidad], origen.region);
      marcar("localidades");
      if (locDestino) console.log(`[andreani] localidad destino CP ${destino.postal.codigoPostal}: "${destino.postal.localidad}" → "${locDestino.localidad}" (${locDestino.provincia}, score ${locDestino.score.toFixed(2)} de ${locDestino.cands})`);
      const destinoBody = tipo === "sucursal"
        ? { sucursal: { id: String(destino.sucursalId).trim() } } // Andreani (24/sep/2026) rechaza el id numérico: "could not be converted to System.String"
        : { postal: {
            codigoPostal: String(destino.postal.codigoPostal).trim(),
            calle:        limpiarTxt(destino.postal.calle),
            numero:       String(destino.postal.numero).trim(),
            localidad:    limpiarTxt(locDestino ? locDestino.localidad : destino.postal.localidad),
            region:       limpiarTxt(locDestino ? locDestino.provincia : destino.postal.region),
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
          localidad: limpiarTxt(locOrigen ? locOrigen.localidad : origen.localidad), region: limpiarTxt(locOrigen ? locOrigen.provincia : (origen.region || "")), pais: "Argentina",
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
          valorDeclaradoSinImpuestos: Math.round(b.valorDeclarado / 1.21),
          valorDeclaradoConImpuestos: b.valorDeclarado,
          referencias: [
            { meta: "detalle", contenido: String(productoAEntregar || "Paquete") },
            { meta: "idCliente", contenido: String(envioId || uid) },
          ],
        })),
      };

      // c. Débito en transacción (saldo + movimiento) CON idempotencia adentro:
      // dos requests concurrentes con el mismo envioId (dos pestañas, dos
      // colaboradoras) serializan acá — el segundo ve el lock o el número ya
      // emitido. El check rápido de arriba (fuera de tx) queda como fast-path.
      // Presupuesto: si Andreani ya consumió más de 35 s (listado, HOP,
      // cotización), no se debita — el POST de la orden no llegaría a tiempo.
      if (Date.now() - tEmitir0 > 35000) {
        return res.status(503).json({ error: "Andreani tardó demasiado en responder y no se emitió la etiqueta (no se debitó saldo). Reintentá en un minuto.", code: "andreani_lento" });
      }
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
            // Emisión anterior DUDOSA (no sabemos si Andreani la creó): no se
            // vuelve a emitir hasta que Growith concilie — duplicar es peor.
            if (ea?.dudosoTs && !ea?.dudosoResuelto) { const err = new Error("emision_dudosa"); err.dudoso = true; throw err; }
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
        marcar("debito");
        if (e.saldoInsuficiente) {
          return res.status(402).json({ error: "saldo_insuficiente", ...e.saldoInsuficiente });
        }
        if (e.yaEmitido) {
          return res.json({ ok: true, yaEmitido: true, numeroDeEnvio: e.yaEmitido.numeroDeEnvio, precio: e.yaEmitido.precio ?? null, saldoRestante: null, fechaEstimadaDeEntrega: e.yaEmitido.fechaEstimadaDeEntrega ?? null });
        }
        if (e.enCurso) {
          return res.status(409).json({ error: "Este envío se está emitiendo en este momento (otra pestaña o compañera). Esperá unos segundos y actualizá.", code: "en_curso" });
        }
        if (e.dudoso) {
          return res.status(409).json({ error: "Este pedido tiene una emisión anterior sin confirmar: el equipo de Growith la está conciliando con Andreani para que no se cobre dos veces. Revisá Seguimientos más tarde.", code: "dudoso" });
        }
        throw e;
      }
      marcar("debito");

      // d. Crear la orden en Andreani (la orden ya está armada arriba). Si falla → reverso.
      // `ambiguo` = no sabemos si Andreani creó la orden o no (timeout/red, o
      // respuesta 2xx sin número). En ese caso NO se reversa automático: si la
      // orden SÍ se creó, el reverso regalaba la etiqueta y la plataforma
      // pagaba el costo real sin registro. Se retiene el débito, se marca el
      // envío como dudoso y se avisa al admin para conciliar contra Andreani.
      let ordenData = null, ordenErr = null, ambiguo = false, varianteOk = null;
      try {
        // A sucursal: se prueban los identificadores en orden (ver SUC_VARIANTES);
        // a domicilio es una sola llamada.
        const kindSuc = sucDestinoOficial && (sucDestinoOficial.hop || Number(sucDestinoOficial.id) >= 11000) ? "hop" : "oficial";
        // Con contrato HOP configurado (24/9: comprobado que acepta el id de siempre), el id va primero.
        const sv = tipo === "sucursal" && sucDestinoOficial ? sucVariantes(sucDestinoOficial, _sucVarianteMem[kindSuc] || cfgG?.sucVariante?.[kindSuc] || (kindSuc === "hop" && env.contratoHop ? "id" : undefined)) : null;
        const hopEnFalla = !!(sv && sv.tipo === "hop" && Date.now() - _hopFallaAt < 30 * 60000);
        const intentos = sv ? sv.variantes.slice(0, hopEnFalla ? 2 : sv.variantes.length).map(v => ({ nombre: v.nombre, body: { ...orden, destino: { sucursal: v.sucursal } } })) : [{ nombre: "", body: orden }];
        const probadas = [];
        for (let k = 0; k < intentos.length; k++) {
          const it = intentos[k];
          const r = await andreaniFetch(db, env, "/v2/ordenes-de-envio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(it.body) });
          if (r.ok) {
            ordenData = await r.json();
            if (!ordenData?.bultos?.[0]?.numeroDeEnvio) { ordenErr = `Andreani no devolvió número de envío: ${JSON.stringify(ordenData).slice(0, 300)}`; ordenData = null; ambiguo = true; }
            else { varianteOk = it.nombre; ordenErr = null; }
            break;
          }
          const txt = await r.text().catch(() => "");
          const rr = { status: r.status, text: async () => txt };
          ordenErr = await andreaniError(rr, "Andreani rechazó la orden de envío");
          probadas.push(`${it.nombre || "domicilio"}${it.nombre ? `=${JSON.stringify(it.body.destino.sucursal)}` : ""} → ${String(txt).replace(/\s+/g, " ").slice(0, 90)}`);
          // Solo se sigue si el rechazo es por el identificador y quedan variantes.
          if (!sv || k === intentos.length - 1 || !esErrorIdSucursal(r.status, txt)) break;
          console.log(`[emitir] sucursal ${sucDestinoOficial?.id} variante "${it.nombre}" rechazada (${String(txt).slice(0, 120)}) → pruebo "${intentos[k + 1].nombre}"`);
        }
        if (ordenErr && sv && probadas.length > 1) {
          const detalle = `[${sucIdsResumen(sucDestinoOficial)}] ${probadas.join(" | ")}`;
          console.error(`[emitir] sucursal ${sucDestinoOficial?.id} sin identificador válido: ${detalle}`);
          if (sv.tipo === "hop") {
            _hopFallaAt = Date.now();
            db.collection("andreani_config").doc("global").set({ hopApiCaidoAt: Date.now() }, { merge: true }).catch(() => {});
            ordenErr = `Andreani no acepta puntos HOP con nuestro contrato por API: su listado de puntos asignados al contrato no incluye los HOP (desde el 23/9 lo validan; probamos ${probadas.length} identificadores). Emití este pedido con "Generar etiquetas" (Excel) o a mano en el portal de Andreani. No se debitó nada.`;
          } else ordenErr += ` — Se probaron ${probadas.length} formas de identificar la sucursal: ${detalle}`;
          try { await envioRef.set({ emisionDetalle: { ts: Date.now(), detalle: detalle.slice(0, 1500) } }, { merge: true }); } catch (_) {}
        }
        if (sv && varianteOk) {
          const kind = sv.tipo;
          if (kind === "hop" && (_hopFallaAt || cfgG?.hopApiCaidoAt)) { _hopFallaAt = 0; db.collection("andreani_config").doc("global").set({ hopApiCaidoAt: null }, { merge: true }).catch(() => {}); console.log("[emitir] HOP por API vuelve a funcionar"); }
          if (_sucVarianteMem[kind] !== varianteOk) {
            _sucVarianteMem[kind] = varianteOk;
            console.log(`[emitir] sucursal ${kind}: identificador que acepta Andreani = "${varianteOk}"`);
            db.collection("andreani_config").doc("global").set({ sucVariante: { [kind]: varianteOk, at: Date.now() } }, { merge: true }).catch(() => {});
          }
        }
      } catch (e) {
        ordenErr = e.message || "Error de red contra Andreani";
        ambiguo = true;
      }
      marcar("post");

      if (!ordenData) {
        if (ambiguo) {
          // Débito retenido + marca de emisión dudosa. El lock de 2 min evita
          // un reintento inmediato que podría duplicar la orden real.
          try { await movRef.set({ dudoso: true, nota: `Etiqueta Andreani ${tipo} · CP ${cpTarifa} — EMISIÓN DUDOSA: ${String(ordenErr).slice(0, 180)}` }, { merge: true }); } catch (_) {}
          if (envioRef) { try { await envioRef.set({ andreani: { dudosoTs: Date.now(), emitiendoTs: FieldValue.delete() } }, { merge: true }); } catch (_) {} }
          await mailFundador(db, `Emisión Andreani DUDOSA — conciliar (uid ${uid})`, `<p>La emisión del envío ${envioId || "(sin id)"} de ${uData.email || uid} falló de forma ambigua (${String(ordenErr).slice(0, 200)}). El débito de $${precio.toLocaleString("es-AR")} quedó RETENIDO. Verificá en el panel de Andreani si la orden se creó y resolvela desde Admin → Logística → Limbo (admin_dudoso_resolver): "no existe" devuelve el saldo, "existe" registra el número.</p>`, "dudosa");
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
          // Rastro en el movimiento (Admin > Saldos lo lista) + mail al fundador.
          console.error(`[andreani] REVERSO FALLIDO uid=${uid} precio=${precio}:`, e2.message);
          try { await movRef.set({ reversoPendiente: true, nota: `Etiqueta Andreani ${tipo} · CP ${cpTarifa} — RECHAZADA y el reverso falló: ${String(e2.message).slice(0, 160)}` }, { merge: true }); } catch (_) {}
          try { await envioRef.set({ andreani: { emitiendoTs: FieldValue.delete() } }, { merge: true }); } catch (_) {}
          await mailFundador(db, `Reverso de saldo FALLIDO — acreditar a mano (uid ${uid})`, `<p>Andreani rechazó la etiqueta del pedido ${envioId} de ${uData.email || uid} y el reverso de $${precio.toLocaleString("es-AR")} falló (${String(e2.message).slice(0, 200)}). Acreditá el saldo a mano desde Admin › Logística › Saldos.</p>`);
          return res.status(502).json({ error: `${ordenErr} — además falló la devolución del saldo: ya avisamos al equipo de Growith, que lo acredita a mano.` });
        }
        try { await envioRef.set({ emisionError: { ts: Date.now(), msg: String(ordenErr).slice(0, 600), tipo, cp: cpTarifa || null } }, { merge: true }); } catch (_) {}
        return res.status(502).json({ error: ordenErr, reversado: true });
      }

      // e. Guardar resultado + completar el movimiento con el número de envío.
      const numeroDeEnvio = String(ordenData.bultos[0].numeroDeEnvio);
      const andreaniInfo = {
        numeroDeEnvio,
        estado: ordenData.estado || "Pendiente",
        precio,
        tipo,
        fechaEstimadaDeEntrega: ordenData.fechaEstimadaDeEntrega || null,
        emitiendoTs: FieldValue.delete(), // liberar el lock de emisión
        ts: FieldValue.serverTimestamp(),
      };
      // Contacto del destinatario: lo usa el cron para avisarle "está en
      // sucursal" / "visita fallida" por mail (si la cuenta lo tiene activo).
      const destinatarioSlim = {
        nombre: String(destinatario.nombreCompleto || "").trim().slice(0, 120),
        email: String(destinatario.email || "").trim().slice(0, 160),
        telefono: String(destinatario.telefono || "").replace(/[^\d+]/g, "").slice(0, 25),
      };
      // Movimiento + envío + índice en UN batch atómico (antes eran tres
      // writes sueltos: si fallaba el del envío, la etiqueta quedaba huérfana y
      // el reintento emitía otra). Con reintentos; si aun así falla, el número
      // se guarda como sea y se avisa al fundador — nunca se pierde.
      const idxRef = db.collection("andreani_idx").doc(numeroDeEnvio);
      const idxData = { uid, envioId: String(envioId), precio, costo: Math.round(costoConDescuento(cot, cfg)), tipo, mes: mesAR(), ts: FieldValue.serverTimestamp() };
      let guardado = false, errGuardado = null;
      for (let intento = 0; intento < 3 && !guardado; intento++) {
        try {
          const b = db.batch();
          b.set(movRef, { numeroDeEnvio }, { merge: true });
          b.set(envioRef, { andreani: andreaniInfo, destinatario: destinatarioSlim }, { merge: true });
          b.set(idxRef, idxData, { merge: true });
          await b.commit();
          guardado = true;
        } catch (e) { errGuardado = e; await new Promise(r => setTimeout(r, 400 * (intento + 1))); }
      }
      if (!guardado) {
        console.error(`[andreani] GUARDADO POST-EMISIÓN FALLIDO uid=${uid} envio=${numeroDeEnvio}:`, errGuardado?.message);
        try { await envioRef.set({ andreani: { numeroDeEnvio, precio, tipo, dudosoTs: Date.now(), emitiendoTs: FieldValue.delete() } }, { merge: true }); } catch (_) {}
        await mailFundador(db, `Etiqueta emitida sin registro completo — ${numeroDeEnvio} (uid ${uid})`, `<p>Andreani emitió el envío <strong>${numeroDeEnvio}</strong> del pedido ${envioId} de ${uData.email || uid} por $${precio.toLocaleString("es-AR")}, pero el guardado en Firestore falló (${String(errGuardado?.message || "").slice(0, 200)}). Revisá users/${uid}/envios/${envioId}, andreani_mov e andreani_idx.</p>`);
      }

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
      } finally {
        // Una línea por emisión (éxito o error) con el tiempo de cada etapa.
        const ms = k => etapas[k] ?? "-";
        console.log(`[emitir] uid=${uid} etapas ms: listado=${ms("listado")} hop=${ms("hop")} cotizar=${ms("cotizar")} localidades=${ms("localidades")} debito=${ms("debito")} post=${ms("post")} total=${Date.now() - tEmitir0}`);
      }
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
      if (body.comprobante && !validarDataUrl(body.comprobante, COMPROBANTE_MAX_CHARS, ["image/", "application/pdf"])) return res.status(400).json({ error: "El comprobante tiene que ser una imagen o PDF de hasta 650 KB: reducí la calidad o adjuntalo después desde la carga." });
      const comprobante = validarDataUrl(body.comprobante, COMPROBANTE_MAX_CHARS, ["image/", "application/pdf"]);
      const docRef = await cargasCol.add({
        uid, email, monto, ref, estado: "pendiente", ts: FieldValue.serverTimestamp(),
        ...(comprobante ? { comprobante, comprobanteTs: FieldValue.serverTimestamp() } : {}),
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

    // Adjuntar (o reemplazar) el comprobante de una carga por transferencia propia.
    if (action === "carga_comprobante") {
      const id = String(body.id || "").trim();
      const comprobante = validarDataUrl(body.comprobante, COMPROBANTE_MAX_CHARS, ["image/", "application/pdf"]);
      if (!id || !comprobante) return res.status(400).json({ error: "Adjuntá una imagen o PDF de hasta 650 KB." });
      const ref = db.collection("andreani_cargas").doc(id);
      const snap = await ref.get();
      if (!snap.exists || snap.data().uid !== uid) return res.status(404).json({ error: "Carga no encontrada" });
      if (!["pendiente", "revision"].includes(snap.data().estado)) return res.status(400).json({ error: "Esa carga ya fue resuelta." });
      await ref.set({ comprobante, comprobanteTs: FieldValue.serverTimestamp() }, { merge: true });
      return res.json({ ok: true });
    }

    // ── Anulación inmediata ("me equivoqué recién"): dentro de los 30 minutos
    //    de emitida y sin ingreso a Andreani, el usuario anula solo y el saldo
    //    vuelve al instante (Andreani no factura etiquetas que nunca ingresan).
    //    Queda registrada como caso resuelto para que Admin la vea; si después
    //    el paquete igual ingresa, track_all lo marca como contracargo pendiente.
    if (action === "anular_inmediata") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
      const numero = String(body.numero || "").trim();
      if (!/^[\w.\-]{1,80}$/.test(numero)) return res.status(400).json({ error: "numero requerido" });
      const eRef = userRef.collection("envios").doc(numero);
      const eSnap = await eRef.get();
      if (!eSnap.exists) return res.status(404).json({ error: "No encontramos ese envío." });
      const e = eSnap.data();
      const numeroDeEnvio = String(e.andreani?.numeroDeEnvio || "");
      if (!numeroDeEnvio) return res.status(400).json({ error: "Ese pedido no tiene una etiqueta emitida desde Growith." });
      if (e.andreani?.anulada) return res.status(400).json({ error: "Esa etiqueta ya está anulada." });
      const tsEm = e.andreani?.ts?.toMillis ? e.andreani.ts.toMillis() : (e.andreani?.ts?._seconds ? e.andreani.ts._seconds * 1000 : Date.parse(e.andreani?.ts || "") || 0);
      const VENTANA_MS = 30 * 60000;
      if (!tsEm || Date.now() - tsEm > VENTANA_MS) return res.status(400).json({ error: "La anulación inmediata vale solo dentro de los 30 minutos de emitida. Después, abrí una gestión de anulación desde la ficha del envío.", code: "fuera_de_ventana" });
      if (!envioSinIngreso(e)) return res.status(400).json({ error: "El paquete ya ingresó a la red de Andreani: la etiqueta no se puede anular." });
      const monto = Math.round(Number(e.andreani?.precio) || 0);
      if (!(monto > 0)) return res.status(400).json({ error: "El envío no tiene precio registrado: abrí una gestión de anulación." });
      const movRef2 = movCol.doc();
      const casoRef = db.collection("envios_casos").doc();
      const ahoraIso = new Date().toISOString();
      const uSnapA = await userRef.get(); const udA = uSnapA.data() || {};
      const tiendaA = String(udA.storeName || udA.nombreTienda || udA.nombre || "").trim();
      const nuevoSaldo = await db.runTransaction(async (tx) => {
        const [uS, eS] = await Promise.all([tx.get(userRef), tx.get(eRef)]);
        if (eS.data()?.andreani?.anulada) throw Object.assign(new Error("Esa etiqueta ya está anulada."), { userFacing: true });
        const saldo = Math.round(Number(uS.data()?.andreaniSaldo) || 0);
        // Tienda DEMO: la etiqueta era simulada (no se debitó) — no hay saldo que
        // devolver ni índice/stats de la plataforma que tocar.
        const nuevo = uDemo ? saldo : saldo + monto;
        if (!uDemo) {
          tx.set(userRef, { andreaniSaldo: nuevo }, { merge: true });
          tx.set(movRef2, { tipo: "reverso", monto, saldoDespues: nuevo, nota: `Anulación inmediata de la etiqueta ${numeroDeEnvio}`, numeroDeEnvio, envioId: numero, ts: FieldValue.serverTimestamp() });
        }
        tx.set(eRef, { activo: false, andreani: { anulada: true, anuladaAt: ahoraIso, anulacionInmediata: true } }, { merge: true });
        if (!uDemo) {
          tx.set(db.collection("andreani_idx").doc(numeroDeEnvio), { anulada: true, reintegro: monto, anuladaAt: ahoraIso, inmediata: true }, { merge: true });
          tx.set(db.collection("andreani_config").doc(`stats_${mesAR()}`), { reintegros: FieldValue.increment(monto), porUid: { [uid]: { reintegros: FieldValue.increment(monto) } } }, { merge: true });
        }
        tx.set(casoRef, {
          uid, email: uDemo ? "" : String(udA.email || user.email || "").trim(), tienda: tiendaA,
          numero, numeroDeEnvio, tracking: numeroDeEnvio, cliente: e.cliente || "", localidad: [e.localidad, e.provincia].filter(Boolean).join(", "),
          esSucursal: !!e.esSucursal, motivo: "anulacion", descripcion: "Anulación inmediata (dentro de los 30 minutos, sin ingreso)", nuevaDireccion: "", fotos: [],
          estado: "resuelto", origen: "cliente", precio: monto, reintegrado: true, reintegroMonto: monto, nuevoCliente: false, nuevoAndreani: false, inmediata: true,
          historial: [{ at: ahoraIso, por: "cliente", texto: "Anulación inmediata de la etiqueta" }, { at: ahoraIso, por: "sistema", estado: "resuelto", texto: `${monto.toLocaleString("es-AR")} reintegrados al saldo automáticamente` }],
          ts: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
          ...(uDemo ? { demo: true } : {}),
        });
        return nuevo;
      });
      if (uDemo) { try { await registrarTrackDemo(db, uid, numeroDeEnvio, numero, trazaDemo([["pendiente", tsEm], ["anulada", Date.now()]])); } catch (_) {} }
      return res.json({ ok: true, saldoRestante: nuevoSaldo, monto });
    }

    // ── Casos: gestiones ante Andreani (reclamos, cambios, anulaciones) ──
    if (action === "casos") {
      const snap = await db.collection("envios_casos").where("uid", "==", uid).limit(150).get();
      const casos = snap.docs.map(d => casoSlim(d.id, d.data())).sort((a, b) => (b.updatedAt || b.ts || 0) - (a.updatedAt || a.ts || 0));
      return res.json({ ok: true, casos, motivos: CASO_MOTIVOS });
    }
    if (action === "caso_crear") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
      const numero = String(body.numero || "").trim();
      const motivo = CASO_MOTIVOS[body.motivo] ? String(body.motivo) : "otro";
      const descripcion = String(body.descripcion || "").trim().slice(0, 1500);
      const nuevaDireccion = String(body.nuevaDireccion || "").trim().slice(0, 300);
      if (!numero) return res.status(400).json({ error: "numero requerido" });
      if (!descripcion && motivo !== "anulacion") return res.status(400).json({ error: "Contanos qué pasó (una o dos líneas alcanzan)." });
      if (motivo === "cambio" && !nuevaDireccion) return res.status(400).json({ error: "Indicá la nueva dirección o la fecha en que pueden entregar." });
      const eSnap = await userRef.collection("envios").doc(numero).get();
      if (!eSnap.exists) return res.status(404).json({ error: "No encontramos ese envío en tu historial." });
      const e = eSnap.data();
      const numeroDeEnvio = e.andreani?.numeroDeEnvio || "";
      const tracking = e.tracking || numeroDeEnvio || "";
      if (!tracking) return res.status(400).json({ error: "Ese envío todavía no tiene número de seguimiento." });
      if (motivo === "anulacion") {
        if (!numeroDeEnvio) return res.status(400).json({ error: "Solo se pueden anular etiquetas emitidas desde Growith." });
        if (!envioSinIngreso(e)) return res.status(400).json({ error: "El paquete ya ingresó a la red de Andreani: la etiqueta no se puede anular." });
      }
      if (motivo === "danado") {
        const desde = e.entregadoAt ? Date.parse(e.entregadoAt) : NaN;
        if (isFinite(desde) && Date.now() - desde > 3 * 86400000) return res.status(400).json({ error: "Andreani solo toma reclamos por daños dentro de las 48 horas de la entrega." });
      }
      // Tope sobre el largo base64 (lo que ocupa en el doc): cada foto y la suma de todas.
      const fotosRaw = (Array.isArray(body.fotos) ? body.fotos : []).slice(0, 4);
      const fotos = fotosRaw.map(f => validarDataUrl(f, FOTOS_MAX_CHARS, ["image/"])).filter(Boolean);
      if (fotos.length < fotosRaw.filter(f => /^data:image\//i.test(String(f || ""))).length) return res.status(400).json({ error: ERR_FOTOS_PESO });
      if (fotos.reduce((s, f) => s + f.length, 0) > FOTOS_MAX_CHARS) return res.status(400).json({ error: ERR_FOTOS_PESO });
      if (motivo === "danado" && fotos.length === 0) return res.status(400).json({ error: "Para un reclamo por daño Andreani exige fotos: del paquete con la etiqueta visible y del producto dañado." });
      // Un caso abierto por envío y motivo; máximo 20 casos abiertos por cuenta.
      const abiertos = await db.collection("envios_casos").where("uid", "==", uid).limit(200).get();
      const vivos = abiertos.docs.filter(d => ["abierto", "enviado", "respondido"].includes(d.data().estado));
      if (vivos.length >= 20) return res.status(400).json({ error: "Tenés 20 gestiones abiertas: esperá a que se resuelvan antes de abrir otra." });
      const dup = vivos.find(d => d.data().numero === numero && d.data().motivo === motivo);
      if (dup) return res.status(400).json({ error: "Ya hay una gestión abierta por este envío con ese motivo.", id: dup.id });
      const uSnap = await userRef.get();
      const ud = uSnap.data() || {};
      const tienda = String(ud.storeName || ud.nombreTienda || ud.nombre || "").trim();
      const ahoraIso = new Date().toISOString();
      const docRef = await db.collection("envios_casos").add({
        uid, email: uDemo ? "" : String(ud.email || user.email || "").trim(), tienda,
        numero, numeroDeEnvio, tracking, cliente: e.cliente || "", localidad: [e.localidad, e.provincia].filter(Boolean).join(", "),
        esSucursal: !!e.esSucursal, motivo, descripcion, nuevaDireccion, fotos,
        estado: "abierto", origen: "cliente", precio: Number(e.andreani?.precio) || 0, reintegrado: false, nuevoCliente: true,
        historial: [{ at: ahoraIso, por: "cliente", texto: descripcion || "Solicitud de anulación de etiqueta" }],
        ts: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        ...(uDemo ? { demo: true } : {}),
      });
      // Tienda DEMO: la gestión queda registrada (se ve en Seguimientos) pero no
      // le llega a la ejecutiva de Andreani ni a operaciones.
      if (uDemo) return res.json({ ok: true, id: docRef.id });
      const cfgE = await getGlobalConfig(db);
      // A la ejecutiva de Andreani: mail con el link al portal (best-effort).
      try {
        await mailEjecutiva(db, cfgE, [{ tienda, email: ud.email, numeroDeEnvio, tracking, motivo }], `Gestión nueva de ${tienda || "un cliente de Growith"}: ${CASO_MOTIVOS[motivo]}`);
      } catch (_) {}
      // Aviso al mail de operaciones (best-effort).
      try {
        const to = cfgE.emailGestiones;
        if (to) await sendEmail({
          to, subject: `Gestión Andreani nueva: ${CASO_MOTIVOS[motivo]} · ${tienda || ud.email || uid}`,
          html: `<div style="font-family:Inter,system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fff;color:#374151">
  <div style="font-size:18px;font-weight:700;color:#111827;margin-bottom:16px">Nueva gestión ante Andreani</div>
  <p style="font-size:14px"><strong>${tienda || ud.email || uid}</strong> abrió una gestión por el envío <strong>${tracking}</strong> (pedido #${numero}).</p>
  <p style="font-size:14px">Motivo: <strong>${CASO_MOTIVOS[motivo]}</strong></p>
  ${descripcion ? `<p style="font-size:13px;white-space:pre-wrap">${descripcion.replace(/</g, "&lt;")}</p>` : ""}
  <p style="font-size:13px">Desde Admin &rarr; Logística &rarr; Operación armás el WhatsApp para la ejecutiva con un clic.</p>
  <p style="font-size:12px;color:#9ca3af;text-align:center;margin-top:24px">Growith — Envíos</p>
</div>`,
        });
      } catch (_) {}
      return res.json({ ok: true, id: docRef.id });
    }
    if (action === "caso_comentar") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
      const id = String(body.id || "").trim();
      const texto = String(body.texto || "").trim().slice(0, 1000);
      if (!id || !texto) return res.status(400).json({ error: "Escribí el comentario." });
      const ref = db.collection("envios_casos").doc(id);
      const snap = await ref.get();
      if (!snap.exists || snap.data().uid !== uid) return res.status(404).json({ error: "Gestión no encontrada" });
      if ((Array.isArray(snap.data().historial) ? snap.data().historial.length : 0) >= HISTORIAL_MAX) return res.status(400).json({ error: "Esta gestión ya tiene demasiados comentarios: abrí una nueva si hace falta seguir." });
      await ref.set({ historial: FieldValue.arrayUnion({ at: new Date().toISOString(), por: "cliente", texto }), nuevoCliente: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return res.json({ ok: true });
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
      const pre = await ref.get();
      if (!pre.exists || pre.data().uid !== uid) return res.status(404).json({ error: "Carga no encontrada." });
      if (pre.data().estado !== "pendiente") return res.status(400).json({ error: "Esa carga ya fue procesada." });
      // Carga por Mercado Pago: antes de cancelar, preguntarle a MP si el pago
      // ya está aprobado (el webhook puede llegar después del click). Si lo
      // está, se acredita en vez de cancelar. Si MP no responde, se cancela
      // igual pero queda marcada para que la reconciliación la rescate.
      let cancelSinVerificar = false;
      if (pre.data().metodo === "mp") {
        const mpTok = process.env.MP_ACCESS_TOKEN || "";
        if (mpTok) {
          try {
            const aprobado = await mpBuscarPagoAprobado(mpTok, id);
            if (aprobado) {
              const r = await mpAcreditarCarga(db, id, aprobado);
              if (r.acreditada || r.revision) return res.json({ ok: true, acreditada: !!r.acreditada, ...(r.revision ? { revision: true } : {}) });
            }
          } catch (e) { console.warn("[carga_cancelar] MP no respondió:", e.message); cancelSinVerificar = true; }
        }
      }
      await db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (!s.exists || s.data().uid !== uid) throw new Error("Carga no encontrada.");
        if (s.data().estado !== "pendiente") throw new Error("Esa carga ya fue procesada.");
        tx.update(ref, { estado: "cancelada", resueltaTs: FieldValue.serverTimestamp(), ...(cancelSinVerificar ? { cancelSinVerificar: true } : {}) });
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
    const adminActions = ["admin_acreditar", "admin_config", "admin_movimientos", "admin_saldos", "admin_stats", "admin_cargas", "admin_carga_acreditar", "admin_carga_rechazar", "admin_carga_comprobante", "admin_punto_map", "admin_punto_map_audit", "admin_tn_probe", "admin_envios", "admin_envios_problemas", "admin_casos", "admin_caso_fotos", "admin_caso_estado", "admin_conciliar", "admin_idx_backfill", "admin_ejecutiva_token", "admin_dudoso_resolver", "admin_limbo", "admin_anulada_debitar", "admin_cache_purge", "admin_markup_cliente"];
    if (adminActions.includes(action)) {
      const adm = await requireAdmin(req);
      if (!adm.ok) return res.status(adm.code).json({ error: adm.error });

      // Envíos de UNA cuenta (ficha del cliente): etiquetas de los últimos N días
      // con su estado de seguimiento. Solo lo que el panel muestra.
      const slimEnvio = (id, e) => ({
        id, numero: e.numero || id, tnId: e.tnId || null, cliente: e.cliente || "", localidad: e.localidad || "", provincia: e.provincia || "",
        esSucursal: !!e.esSucursal, creado: e.creado || null, despachadoAt: e.despachadoAt || null, entregadoAt: e.entregadoAt || null, devolucionAt: e.devolucionAt || null,
        categoria: e.categoria || null, estadoAndreani: e.estadoAndreani || null, estadoDesde: e.estadoDesde || null, enSucursalDesde: e.enSucursalDesde || null,
        activo: e.activo === true, tracking: e.tracking || null, total: e.total || null, apiHeal: !!e.apiHeal, lastCheck: e.lastCheck || null,
        andreani: e.andreani ? { numeroDeEnvio: e.andreani.numeroDeEnvio || null, precio: Number(e.andreani.precio) || 0, tipo: e.andreani.tipo || null, fechaEstimadaDeEntrega: e.andreani.fechaEstimadaDeEntrega || null, ts: e.andreani.ts?.toMillis?.() || null, dudoso: !!e.andreani.dudosoTs } : null,
      });
      // Clasificación de problemas (misma lógica que la pestaña Seguimientos del cliente).
      const problemaDe = (e, ahora) => {
        const dias = iso => { const t = iso ? Date.parse(iso) : NaN; return isFinite(t) ? Math.floor((ahora - t) / 86400000) : null; };
        const num = e.andreani?.numeroDeEnvio;
        if (e.categoria === "devolucion" || e.devolucionAt) return { tipo: "devolucion", sev: "red", msg: "está volviendo (devolución)" };
        if (!e.activo) return null;
        if (e.categoria === "visita_fallida") return { tipo: "visita_fallida", sev: "amber", msg: "visita fallida — puede reintentarse o ir a sucursal" };
        if (e.categoria === "en_sucursal") { const d = dias(e.enSucursalDesde); if (d != null && d >= 3) return { tipo: "sucursal", sev: d >= 5 ? "red" : "amber", msg: `en sucursal hace ${d} días sin retirar${d >= 5 ? " — el plazo está por vencer" : ""}` }; return null; }
        const dEst = dias(e.estadoDesde || e.despachadoAt || e.creado);
        const sinIngreso = !e.estadoAndreani || /no ingresad|pendiente de ingreso|sin movimientos/i.test(String(e.estadoAndreani));
        if (num && sinIngreso) { const dc = dias(e.andreani?.ts ? new Date(e.andreani.ts).toISOString() : e.creado); if (dc != null && dc >= 3) return { tipo: "sin_despacho", sev: "amber", msg: `etiqueta emitida hace ${dc} días y Andreani nunca registró el ingreso del paquete` }; return null; }
        if ((e.categoria === "en_camino" || e.categoria === "otro" || e.categoria === "desconocido") && dEst != null && dEst >= 7) return { tipo: "quieto", sev: "amber", msg: `sin movimiento hace ${dEst} días` };
        return null;
      };
      if (action === "admin_envios") {
        const targetUid = String(body.uid || "").trim();
        if (!targetUid) return res.status(400).json({ error: "uid requerido" });
        const dias = Math.min(365, Math.max(7, Number(body.dias) || 90));
        const cutoff = new Date(Date.now() - dias * 86400000).toISOString();
        const col = db.collection("users").doc(targetUid).collection("envios");
        // Dos fuentes: por fecha de creación Y por número de envío de la API.
        // Las etiquetas emitidas por API que nunca entraron al seguimiento no
        // tienen `creado` (caso Leo: 5 etiquetas y la ficha marcaba 0). Acá se
        // activan igual que en envios_list, así el cron las trackea aunque el
        // cliente no vuelva a abrir Envíos.
        const [uSnap, snap, apiSnap] = await Promise.all([
          db.collection("users").doc(targetUid).get(),
          // Del más nuevo al más viejo: sin orderBy, el límite dejaba los 500 más
          // VIEJOS de la ventana (shineboost: 3000 pedidos en 90 días y se veían 500).
          col.where("creado", ">", cutoff).orderBy("creado", "desc").limit(4000).get(),
          col.where("andreani.numeroDeEnvio", ">", "").limit(2000).get().catch(() => ({ docs: [] })),
        ]);
        const ahora = Date.now();
        const docs = new Map();
        snap.docs.forEach(d => docs.set(d.id, d.data()));
        let heal = 0;
        try {
          const ahoraIso = new Date(ahora).toISOString();
          const b = db.batch();
          apiSnap.docs.forEach(d => {
            const e = d.data();
            if (!docs.has(d.id)) docs.set(d.id, e);
            if (e.activo === true || e.entregadoAt || e.devolucionAt || e.tracking) return;
            const patch = { numero: d.id, tracking: String(e.andreani.numeroDeEnvio), activo: true, estado: "despachado", despachadoAt: e.despachadoAt || ahoraIso, creado: e.creado || (e.andreani?.ts?.toDate?.() ? e.andreani.ts.toDate().toISOString() : ahoraIso), apiHeal: true };
            b.set(d.ref, patch, { merge: true }); docs.set(d.id, { ...e, ...patch }); heal++;
          });
          if (heal) await b.commit();
        } catch (e) { console.warn("[admin_envios] heal API:", e.message); }
        const fechaDe = e => e.creado || (e.andreani?.ts?.toDate?.() ? e.andreani.ts.toDate().toISOString() : "");
        const envios = [...docs.entries()].filter(([, e]) => !fechaDe(e) || fechaDe(e) > cutoff)
          .map(([id, e]) => { const s = slimEnvio(id, e); s.creado = s.creado || fechaDe(e) || null; s.problema = problemaDe(e, ahora); return s; })
          .sort((a, b) => String(b.creado || "").localeCompare(String(a.creado || "")));
        const ud = uSnap.exists ? uSnap.data() : {};
        return res.json({ ok: true, dias, envios, total: envios.length, truncado: snap.size >= 4000, activados: heal, saldo: Math.round(Number(ud.andreaniSaldo) || 0), email: ud.email || "", habilitado: (await getGlobalConfig(db)).habilitados.includes(targetUid), trackActivo: ud.enviosTrackActivo || null });
      }
      // Envíos con problema en TODA la plataforma: mismas cuentas que rota el cron
      // de seguimiento (activas en Envíos los últimos 45 días), envíos activos.
      if (action === "admin_envios_problemas") {
        const t0 = Date.now();
        const cutoffU = new Date(t0 - 45 * 86400000).toISOString();
        const uSnap = await db.collection("users").where("enviosTrackActivo", ">", cutoffU).limit(150).get();
        const out = []; let cuentas = 0, revisados = 0, truncado = false;
        for (const u of uSnap.docs) {
          if (Date.now() - t0 > 20000) { truncado = true; break; }
          if (esDemo(u.data())) continue; // tiendas DEMO: envíos ficticios
          cuentas++;
          const ud = u.data();
          let eSnap;
          try { eSnap = await u.ref.collection("envios").where("activo", "==", true).limit(80).get(); } catch (_) { continue; }
          for (const d of eSnap.docs) {
            revisados++;
            const e = d.data();
            const p = problemaDe(e, Date.now());
            if (p) out.push({ ...slimEnvio(d.id, e), problema: p, uid: u.id, email: ud.email || "" });
          }
        }
        // Devoluciones recientes ya cerradas (activo=false) no entran: el cliente ya las vio en su tablero.
        const orden = { red: 0, amber: 1 };
        out.sort((a, b) => (orden[a.problema.sev] - orden[b.problema.sev]) || String(b.creado || "").localeCompare(String(a.creado || "")));
        return res.json({ ok: true, envios: out, cuentas, revisados, truncado, ahora: Date.now() });
      }

      // Memoria global de puntos: listar y podar (POST {quitar:key}).
      if (action === "admin_punto_map") {
        const gRef = db.collection("andreani_config").doc("punto_map_global");
        const quitar = req.method === "POST" ? String(body.quitar || "").trim() : "";
        if (quitar) {
          await gRef.update(new FieldPath("entries", quitar), FieldValue.delete()).catch(() => {});
          await logAdminAndreani(db, adm.user.uid, "punto_map_global", null, `Quitó de la memoria global: ${quitar.slice(0, 120)}`);
        }
        const g = await gRef.get();
        const entries = g.exists ? (g.data().entries || {}) : {};
        const lista = Object.entries(entries).map(([key, v]) => ({ key, ...v })).sort((a, b) => (b.ts || 0) - (a.ts || 0));
        return res.json({ ok: true, entries: lista });
      }

      // ── admin_punto_map_audit: revisa TODAS las memorias de puntos (propias de
      // cada cuenta + global) con el mismo detector de contradicciones del
      // matcheo. Una elección manual equivocada guardada se reusa en silencio en
      // cada pedido futuro al mismo punto — esto las saca a la luz.
      // GET → lista; POST {quitar:[{uid,key}], quitarGlobal:[key]} → borra.
      // ── admin_tn_probe: GET crudo a la API de Tienda Nube con el token de una
      // cuenta (por email o uid). Solo lectura y solo rutas de diagnóstico:
      // órdenes, transacciones de una orden y proveedores de pago. Para saber
      // qué informa TN de las comisiones de pago (merchant_charges / rates).
      if (action === "admin_tn_probe") {
        if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
        const path = String(body.path || "").trim();
        const plataforma = body.plataforma === "shopify" ? "shopify" : "tiendanube";
        if (plataforma === "shopify" ? !/^\/orders(\/\d+\/transactions)?\.json(\?[^\s]*)?$/.test(path) : !/^\/(orders(\/\d+(\/transactions)?)?|payment_providers|payment\/providers(\/[\w-]+)?)(\?[^\s]*)?$/.test(path)) return res.status(400).json({ error: plataforma === "shopify" ? "Solo /orders.json y /orders/{id}/transactions.json" : "Solo /orders, /orders/{id}, /orders/{id}/transactions, /payment_providers" });
        let target = String(body.uid || "").trim();
        const email = String(body.email || "").trim().toLowerCase();
        if (!target && email) { const q = await db.collection("users").where("email", "==", email).limit(1).get(); target = q.empty ? "" : q.docs[0].id; }
        if (!target) return res.status(400).json({ error: "uid o email requerido" });
        const ud = (await db.collection("users").doc(target).get()).data() || {};
        const t0 = Date.now();
        let r, tn;
        if (plataforma === "shopify") {
          const sh = (ud.stores || []).find(s => s.type === "shopify" && s.shop);
          if (!sh) return res.status(400).json({ error: "Esa cuenta no tiene Shopify conectada" });
          await ensureShopifyToken(db, target, sh);
          if (!sh.accessToken) return res.status(400).json({ error: "Shopify sin token válido — reconectar" });
          tn = { storeId: sh.shop };
          r = await fetch(`https://${sh.shop}/admin/api/2024-10${path}`, { headers: { "X-Shopify-Access-Token": sh.accessToken }, signal: AbortSignal.timeout(12000) });
        } else {
          tn = (ud.stores || []).find(s => s.type === "tiendanube" && s.accessToken && s.storeId);
          if (!tn) return res.status(400).json({ error: "Esa cuenta no tiene Tienda Nube conectada" });
          r = await fetch(`https://api.tiendanube.com/v1/${tn.storeId}${path}`, { headers: { Authentication: `bearer ${tn.accessToken}`, "User-Agent": "GrowithApp (contacto.growith@gmail.com)" }, signal: AbortSignal.timeout(12000) });
        }
        const txt = await r.text();
        let j = null; try { j = JSON.parse(txt); } catch (_) {}
        await logAdminAndreani(db, adm.user.uid, "tn_probe", target, path);
        return res.json({ status: r.status, ms: Date.now() - t0, storeId: tn.storeId, scopes: tn.scope || tn.scopes || null, json: j != null ? (Array.isArray(j) ? j.slice(0, 5) : j) : null, raw: j == null ? txt.slice(0, 2000) : null, count: Array.isArray(j) ? j.length : null });
      }

      if (action === "admin_punto_map_audit") {
        const gRef = db.collection("andreani_config").doc("punto_map_global");
        if (req.method === "POST") {
          const quitar = Array.isArray(body.quitar) ? body.quitar.slice(0, 200) : [];
          const quitarGlobal = Array.isArray(body.quitarGlobal) ? body.quitarGlobal.map(String).slice(0, 200) : [];
          let n = 0;
          for (const q of quitar) {
            const u = String(q?.uid || "").trim(), k = String(q?.key || "").trim();
            if (!u || !k) continue;
            await db.collection("users").doc(u).collection("envios_cfg").doc("punto_map").update(new FieldPath("entries", k), FieldValue.delete()).then(() => n++).catch(() => {});
          }
          for (const k of quitarGlobal) { if (k) await gRef.update(new FieldPath("entries", k), FieldValue.delete()).then(() => n++).catch(() => {}); }
          if (n) await logAdminAndreani(db, adm.user.uid, "punto_map_audit", null, `Quitó ${n} memoria(s) de puntos con contradicción`);
          return res.json({ ok: true, quitadas: n });
        }
        const out = [];
        const diag = { cgDocs: 0, cgPuntoMap: 0, cgIds: [], globalExists: false, globalN: 0, uids: [] };
        const evaluar = (uid, key, v, global) => {
          const punto = ghPuntoDeClave(key);
          const row = { uid, key, global, punto, ts: v?.ts || null, tpl: v?.tpl || null, oficial: v?.oficial || null, byEmail: v?.byEmail || null, conflicto: null, coincide: false };
          if (punto && v?.oficial) { row.conflicto = ghConflictoPunto(punto, v.oficial); row.coincide = ghCoincidePunto(punto, v.oficial); }
          else if (punto && v?.tpl) { row.conflicto = ghConflictoTpl(punto, v.tpl); }
          out.push(row);
        };
        try {
          const cg = await db.collectionGroup("envios_cfg").get();
          diag.cgDocs = cg.size;
          for (const d of cg.docs) {
            if (diag.cgIds.length < 8 && !diag.cgIds.includes(d.id)) diag.cgIds.push(d.id);
            if (d.id !== "punto_map") continue;
            diag.cgPuntoMap++;
            const uid = d.ref.parent.parent?.id || "";
            if (diag.uids.length < 20) diag.uids.push(uid);
            for (const [k, v] of Object.entries(d.data()?.entries || {})) evaluar(uid, k, v, false);
          }
        } catch (e) { return res.status(502).json({ error: "No se pudo leer las memorias: " + e.message }); }
        const g = await gRef.get();
        diag.globalExists = g.exists; diag.globalN = Object.keys(g.exists ? (g.data().entries || {}) : {}).length;
        for (const [k, v] of Object.entries(g.exists ? (g.data().entries || {}) : {})) evaluar(v?.by || "", k, v, true);
        const emails = {};
        for (const uid of new Set(out.map(r => r.uid).filter(Boolean))) { try { emails[uid] = (await db.collection("users").doc(uid).get()).data()?.email || ""; } catch (_) {} }
        for (const r of out) r.email = emails[r.uid] || r.byEmail || "";
        const rank = r => r.conflicto?.grave ? 0 : r.conflicto ? 1 : r.coincide ? 3 : 2;
        out.sort((a, b) => rank(a) - rank(b) || (b.ts || 0) - (a.ts || 0));
        return res.json({ ok: true, diag, entries: out, resumen: { total: out.length, graves: out.filter(r => r.conflicto?.grave).length, dudosas: out.filter(r => r.conflicto && !r.conflicto.grave).length, sinVerificar: out.filter(r => !r.conflicto && !r.coincide).length, verificadas: out.filter(r => r.coincide).length } });
      }

      if (action === "admin_acreditar") {
        const targetUid = String(body.uid || "").trim();
        const monto = Math.round(Number(body.monto));
        const nota = String(body.nota || "").trim();
        const esReintegro = body.tipo === "reintegro";
        if (!targetUid) return res.status(400).json({ error: "uid requerido" });
        if (!isFinite(monto) || monto === 0) return res.status(400).json({ error: "monto inválido (entero distinto de 0; negativo para ajustes)" });
        if (esReintegro && (monto <= 0 || !nota)) return res.status(400).json({ error: "Un reintegro necesita monto positivo y motivo." });
        const tRef = db.collection("users").doc(targetUid);
        const tMov = tRef.collection("andreani_mov").doc();
        const nuevoSaldo = await db.runTransaction(async (tx) => {
          const s = await tx.get(tRef);
          if (!s.exists) throw new Error("El usuario no existe.");
          const saldo = Math.round(Number(s.data()?.andreaniSaldo) || 0);
          const nuevo = saldo + monto;
          tx.set(tRef, { andreaniSaldo: nuevo }, { merge: true });
          tx.set(tMov, {
            tipo: esReintegro ? "reverso" : "credito",
            monto,
            saldoDespues: nuevo,
            nota: esReintegro ? `Reintegro: ${nota}` : (nota || (monto > 0 ? "Acreditación de saldo" : "Ajuste de saldo")),
            numeroDeEnvio: String(body.numeroDeEnvio || "").trim() || null,
            adminUid: adm.user.uid,
            ts: FieldValue.serverTimestamp(),
          });
          return nuevo;
        });
        await logAdminAndreani(db, adm.user.uid, esReintegro ? "reintegrar_saldo" : (monto > 0 ? "acreditar_saldo" : "ajustar_saldo"), targetUid, `${monto > 0 ? "+" : ""}$${monto.toLocaleString("es-AR")} · saldo ${nuevoSaldo.toLocaleString("es-AR")}${nota ? " · " + nota : ""}`);
        return res.json({ ok: true, uid: targetUid, saldo: nuevoSaldo });
      }

      // Cargas de saldo pendientes o en revisión (monto de MP distinto) de
      // todas las cuentas (where por un campo, operador "in").
      if (action === "admin_cargas") {
        const snap = await db.collection("andreani_cargas").where("estado", "in", ["pendiente", "revision"]).limit(50).get();
        const cargas = snap.docs.map(d => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (a.ts?.toMillis?.() || 0) - (b.ts?.toMillis?.() || 0))
          .map(c => ({ id: c.id, uid: c.uid, email: c.email || "", ref: c.ref, monto: c.monto, ts: c.ts?.toMillis?.() || null, estado: c.estado, motivo: c.motivo || "", metodo: c.metodo || "transferencia", tieneComprobante: !!c.comprobante }));
        return res.json({ ok: true, cargas });
      }
      if (action === "admin_carga_comprobante") {
        const id = String(body.id || "").trim();
        const snap = id ? await db.collection("andreani_cargas").doc(id).get() : null;
        if (!snap || !snap.exists) return res.status(404).json({ error: "Carga no encontrada" });
        return res.json({ ok: true, comprobante: snap.data().comprobante || null, ref: snap.data().ref || "", monto: snap.data().monto || 0 });
      }

      // ── Casos: cola de gestiones ante Andreani de toda la plataforma ──
      if (action === "admin_casos") {
        const todos = body.todos === "1" || body.todos === true;
        const snap = todos
          ? await db.collection("envios_casos").orderBy("ts", "desc").limit(200).get().catch(() => db.collection("envios_casos").limit(200).get())
          : await db.collection("envios_casos").where("estado", "in", ["abierto", "enviado", "respondido"]).limit(200).get();
        // Las gestiones de tiendas DEMO no son operación real: fuera del panel.
        const casos = snap.docs.filter(d => d.data().demo !== true).map(d => casoSlim(d.id, d.data())).sort((a, b) => (b.updatedAt || b.ts || 0) - (a.updatedAt || a.ts || 0));
        const cfg = await getGlobalConfig(db);
        const tokE = await ejecutivaTokenAsegurar(db);
        return res.json({ ok: true, casos, ejecutivaWa: cfg.ejecutivaWa, ejecutivaNombre: cfg.ejecutivaNombre, ejecutivaEmail: cfg.ejecutivaEmail, portalLink: portalEjecutivaLink(tokE) });
      }
      if (action === "admin_ejecutiva_token") {
        const regenerar = req.method === "POST" && (body.regenerar === true || body.regenerar === "1");
        const tokE = await ejecutivaTokenAsegurar(db, regenerar);
        if (regenerar) await logAdminAndreani(db, adm.user.uid, "portal_ejecutiva_token", null, "Regeneró el link del portal de la ejecutiva");
        return res.json({ ok: true, link: portalEjecutivaLink(tokE) });
      }
      if (action === "admin_caso_fotos") {
        const id = String(body.id || "").trim();
        const snap = id ? await db.collection("envios_casos").doc(id).get() : null;
        if (!snap || !snap.exists) return res.status(404).json({ error: "Caso no encontrado" });
        return res.json({ ok: true, fotos: Array.isArray(snap.data().fotos) ? snap.data().fotos : [] });
      }
      // Cambiar el estado de un caso (+ nota al historial, + reintegro al
      // saldo si es una anulación resuelta a favor). Avisa al cliente por mail,
      // salvo en los casos que abrió el sistema (anulaciones automáticas).
      if (action === "admin_caso_estado") {
        const id = String(body.id || "").trim();
        const estado = CASO_ESTADOS.includes(body.estado) ? String(body.estado) : "";
        const nota = String(body.nota || "").trim().slice(0, 1000);
        const reintegrar = body.reintegrar === true || body.reintegrar === "1";
        if (!id || !estado) return res.status(400).json({ error: "id y estado válidos requeridos" });
        const ref = db.collection("envios_casos").doc(id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: "Caso no encontrado" });
        const c = snap.data();
        let reintegro = null;
        if (reintegrar && !c.reintegrado) {
          const tRef = db.collection("users").doc(c.uid);
          const eRef = tRef.collection("envios").doc(String(c.numero));
          const tMov = tRef.collection("andreani_mov").doc();
          reintegro = await db.runTransaction(async (tx) => {
            const [uS, eS, cS] = await Promise.all([tx.get(tRef), tx.get(eRef), tx.get(ref)]);
            const e = eS.exists ? eS.data() : {};
            // Idempotencia adentro de la tx: dos admins clickeando a la vez no
            // reintegran dos veces (antes el chequeo estaba afuera).
            if (cS.exists && cS.data()?.reintegrado) throw new Error("Ese caso ya fue reintegrado.");
            const monto = Math.round(Number(c.precio) || Number(e.andreani?.precio) || 0);
            if (!(monto > 0)) throw new Error("El envío no tiene precio registrado: hacé el reintegro a mano desde Saldos.");
            if (e.andreani?.anulada) throw new Error("Esa etiqueta ya fue anulada y reintegrada.");
            const saldo = Math.round(Number(uS.data()?.andreaniSaldo) || 0);
            const nuevo = saldo + monto;
            tx.set(ref, { reintegrado: true, reintegroMonto: monto }, { merge: true });
            // Conciliación y stats: la etiqueta anulada deja de contar como cobrada.
            if (c.numeroDeEnvio) tx.set(db.collection("andreani_idx").doc(String(c.numeroDeEnvio)), { anulada: true, reintegro: monto, anuladaAt: new Date().toISOString() }, { merge: true });
            tx.set(db.collection("andreani_config").doc(`stats_${mesAR()}`), { reintegros: FieldValue.increment(monto), porUid: { [c.uid]: { reintegros: FieldValue.increment(monto) } } }, { merge: true });
            tx.set(tRef, { andreaniSaldo: nuevo }, { merge: true });
            tx.set(tMov, { tipo: "reverso", monto, saldoDespues: nuevo, nota: `Reintegro por anulación de etiqueta ${c.numeroDeEnvio || ""}`.trim(), numeroDeEnvio: c.numeroDeEnvio || null, envioId: String(c.numero), adminUid: adm.user.uid, casoId: id, ts: FieldValue.serverTimestamp() });
            if (eS.exists) tx.set(eRef, { activo: false, andreani: { anulada: true, anuladaAt: new Date().toISOString() } }, { merge: true });
            return { monto, saldo: nuevo };
          });
        }
        const evento = { at: new Date().toISOString(), por: "admin", estado, texto: nota || (reintegro ? `Etiqueta anulada y ${reintegro.monto.toLocaleString("es-AR")} reintegrados al saldo` : CASO_ESTADO_LABEL[estado]) };
        await ref.set({ estado, nuevoCliente: false, nuevoAndreani: false, ...(reintegro ? { reintegrado: true, reintegroMonto: reintegro.monto } : {}), historial: FieldValue.arrayUnion(evento), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        await logAdminAndreani(db, adm.user.uid, "caso_envio", c.uid, `${CASO_MOTIVOS[c.motivo] || c.motivo} · ${c.numeroDeEnvio || c.tracking || ""} → ${CASO_ESTADO_LABEL[estado] || estado}${reintegro ? ` · reintegro $${reintegro.monto.toLocaleString("es-AR")}` : ""}`, { casoId: id, estado, nota });
        // Mail al cliente (no en las anulaciones que abrió el sistema).
        if (c.origen !== "sistema" && c.email) {
          try {
            await sendEmail({
              to: c.email, subject: `Tu gestión con Andreani (${c.tracking || c.numeroDeEnvio}): ${CASO_ESTADO_LABEL[estado] || estado}`,
              html: `<div style="font-family:Inter,system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fff;color:#374151">
  <div style="font-size:18px;font-weight:700;color:#111827;margin-bottom:16px">${CASO_ESTADO_LABEL[estado] || estado}</div>
  <p style="font-size:14px">Gestión por el envío <strong>${c.tracking || c.numeroDeEnvio}</strong> (pedido #${c.numero}) — ${CASO_MOTIVOS[c.motivo] || ""}.</p>
  ${nota ? `<p style="font-size:13px;white-space:pre-wrap;background:#f9fafb;border-radius:8px;padding:10px 14px">${nota.replace(/</g, "&lt;")}</p>` : ""}
  ${reintegro ? `<p style="font-size:14px">Se reintegraron <strong>$${reintegro.monto.toLocaleString("es-AR")}</strong> a tu saldo de envíos.</p>` : ""}
  <p style="font-size:13px">Podés ver el detalle en Envíos &rarr; Seguimientos &rarr; el envío &rarr; Gestiones.</p>
  <p style="font-size:12px;color:#9ca3af;text-align:center;margin-top:24px">Growith — Envíos</p>
</div>`,
            });
          } catch (_) {}
        }
        return res.json({ ok: true, estado, reintegro });
      }

      // ── Limbo: todo lo que quedó a medias y necesita una decisión humana ──
      // dudosos (débito retenido sin saber si Andreani creó la orden),
      // reversos pendientes (rechazo claro pero el reverso falló), cargas en
      // revisión (MP con monto distinto o sobre una carga cancelada) y
      // anuladas con ingreso (anulación inmediata con reintegro, pero el
      // paquete igual entró a Andreani). Máx. 50 por lista.
      if (action === "admin_limbo") {
        const t0 = Date.now();
        const cfgL = await getGlobalConfig(db);
        const uids = new Set(cfgL.habilitados.map(String));
        try { (await db.collection("users").where("andreaniSaldo", ">", 0).select("email").get()).docs.forEach(d => uids.add(d.id)); } catch (_) {}
        const dudosos = [], reversosPendientes = [], anuladasConIngreso = [];
        const emails = {};
        let truncado = false;
        const msDe = v => v?.toMillis?.() || (typeof v === "number" ? v : null);
        for (const u of [...uids].slice(0, 80)) {
          if (Date.now() - t0 > 40000) { truncado = true; break; }
          const uRef = db.collection("users").doc(u);
          const eCol = uRef.collection("envios");
          try {
            const [uS, dS, aS, rS] = await Promise.all([
              uRef.get(),
              eCol.where("andreani.dudosoTs", ">", 0).limit(50).get(),
              eCol.where("andreani.anuladaIngresoTs", ">", 0).limit(50).get(),
              uRef.collection("andreani_mov").where("reversoPendiente", "==", true).limit(50).get(),
            ]);
            const ud = uS.exists ? uS.data() : {};
            if (esDemo(ud)) continue;
            emails[u] = ud.email || "";
            for (const d of dS.docs) {
              const e = d.data(), a = e.andreani || {};
              if (a.dudosoResuelto) continue;
              if (dudosos.length < 50) dudosos.push({ uid: u, email: emails[u], envioId: d.id, pedido: e.numero || d.id, cliente: e.cliente || "", precio: Number(a.precio) || 0, tipo: a.tipo || null, numeroDeEnvio: a.numeroDeEnvio || null, dudosoTs: a.dudosoTs || null });
            }
            for (const d of aS.docs) {
              const e = d.data(), a = e.andreani || {};
              if (a.anuladaDebitada) continue;
              if (anuladasConIngreso.length < 50) anuladasConIngreso.push({ uid: u, email: emails[u], envioId: d.id, pedido: e.numero || d.id, cliente: e.cliente || "", precio: Number(a.precio) || 0, numeroDeEnvio: a.numeroDeEnvio || null, anuladaAt: a.anuladaAt || null, anuladaIngresoTs: a.anuladaIngresoTs || null, anuladaIngresoEstado: a.anuladaIngresoEstado || null });
            }
            for (const d of rS.docs) {
              const m = d.data();
              if (reversosPendientes.length < 50) reversosPendientes.push({ uid: u, email: emails[u], movId: d.id, envioId: m.envioId || null, monto: Number(m.monto) || 0, nota: m.nota || "", ts: msDe(m.ts) });
            }
          } catch (e) { console.warn("[admin_limbo]", u, e.message); }
        }
        let cargasRevision = [];
        try {
          const cs = await db.collection("andreani_cargas").where("estado", "==", "revision").limit(50).get();
          cargasRevision = cs.docs.map(d => { const c = d.data(); return { id: d.id, uid: c.uid, email: c.email || "", ref: c.ref, monto: Number(c.monto) || 0, metodo: c.metodo || "transferencia", motivo: c.motivo || "", estadoPrevio: c.estadoPrevio || null, mpPaymentId: c.mpPaymentId || null, mpMonto: c.mpMonto ?? null, ts: msDe(c.ts) }; });
        } catch (_) {}
        return res.json({ ok: true, dudosos, reversosPendientes, cargasRevision, anuladasConIngreso, cuentas: uids.size, truncado, ms: Date.now() - t0 });
      }

      // ── Resolver una emisión DUDOSA (débito retenido). body {uid, envioId,
      // resultado:"existe"|"no_existe", numeroDeEnvio?}. "no_existe": reverso
      // del débito original; "existe": se registra el número de Andreani
      // (envío + índice + movimiento) y la etiqueta pasa a seguimiento.
      if (action === "admin_dudoso_resolver") {
        const targetUid = String(body.uid || "").trim();
        const envioId = String(body.envioId || "").trim();
        const resultado = body.resultado === "existe" ? "existe" : (body.resultado === "no_existe" ? "no_existe" : "");
        const numeroBody = String(body.numeroDeEnvio || "").replace(/\D/g, "");
        if (!targetUid || !/^[\w.\-]{1,80}$/.test(envioId) || !resultado) return res.status(400).json({ error: "uid, envioId y resultado (existe|no_existe) requeridos" });
        const tRef = db.collection("users").doc(targetUid);
        const eRef = tRef.collection("envios").doc(envioId);
        const tMov = tRef.collection("andreani_mov").doc();
        // Débito original (el más reciente con ese envioId); si no está, vale el precio del envío.
        let debito = null;
        try {
          const q = await tRef.collection("andreani_mov").where("envioId", "==", envioId).limit(20).get();
          debito = q.docs.map(d => ({ id: d.id, ...d.data() })).filter(m => m.tipo === "debito").sort((a, b) => (b.ts?.toMillis?.() || 0) - (a.ts?.toMillis?.() || 0))[0] || null;
        } catch (_) {}
        const ahoraIso = new Date().toISOString();
        const out = await db.runTransaction(async (tx) => {
          const [uS, eS] = await Promise.all([tx.get(tRef), tx.get(eRef)]);
          if (!eS.exists) throw new Error("El envío no existe.");
          const e = eS.data(), a = e.andreani || {};
          if (!a.dudosoTs) throw new Error("Ese envío no tiene una emisión dudosa.");
          if (a.dudosoResuelto) throw new Error("Esa emisión dudosa ya fue resuelta.");
          const movOrig = debito ? tRef.collection("andreani_mov").doc(debito.id) : null;
          if (resultado === "no_existe") {
            const monto = Math.round(Number(debito?.monto) || Number(a.precio) || 0);
            if (!(monto > 0)) throw new Error("No se encontró el débito original ni el precio del envío: acreditá a mano desde Saldos.");
            const saldo = Math.round(Number(uS.data()?.andreaniSaldo) || 0);
            const nuevo = saldo + monto;
            tx.set(tRef, { andreaniSaldo: nuevo }, { merge: true });
            tx.set(tMov, { tipo: "reverso", monto, saldoDespues: nuevo, nota: `Reverso: la emisión dudosa del pedido ${envioId} no existe en Andreani`, envioId, adminUid: adm.user.uid, dudosoDe: debito?.id || null, ts: FieldValue.serverTimestamp() });
            tx.set(eRef, { andreani: { dudosoResuelto: true, dudosoResultado: "no_existe", dudosoResueltoAt: ahoraIso, emitiendoTs: FieldValue.delete() } }, { merge: true });
            if (movOrig) tx.set(movOrig, { dudosoResuelto: "no_existe" }, { merge: true });
            return { monto, saldo: nuevo };
          }
          const numero = numeroBody || String(a.numeroDeEnvio || "").replace(/\D/g, "");
          if (!numero) throw new Error("Indicá el número de envío que figura en Andreani.");
          const precio = Math.round(Number(a.precio) || Number(debito?.monto) || 0);
          // Mismo shape que escribe `emitir` en andreani_idx (costo real
          // desconocido: la cotización no se guardó — null, la conciliación lo
          // toma de la factura).
          tx.set(db.collection("andreani_idx").doc(numero), { uid: targetUid, envioId, precio, costo: null, tipo: a.tipo || null, mes: mesAR(), ts: FieldValue.serverTimestamp(), dudosoResuelto: true }, { merge: true });
          tx.set(eRef, {
            ...(e.tracking ? {} : { numero: e.numero || envioId, tracking: numero, activo: true, estado: "despachado", despachadoAt: e.despachadoAt || ahoraIso, creado: e.creado || ahoraIso, apiHeal: true }),
            andreani: { numeroDeEnvio: numero, precio, dudosoResuelto: true, dudosoResultado: "existe", dudosoResueltoAt: ahoraIso, emitiendoTs: FieldValue.delete(), ...(a.ts ? {} : { ts: FieldValue.serverTimestamp() }) },
          }, { merge: true });
          if (movOrig) tx.set(movOrig, { numeroDeEnvio: numero, dudosoResuelto: "existe" }, { merge: true });
          tx.set(db.collection("andreani_config").doc(`stats_${mesAR()}`), { facturado: FieldValue.increment(precio), etiquetas: FieldValue.increment(1), porUid: { [targetUid]: { monto: FieldValue.increment(precio), etiquetas: FieldValue.increment(1) } } }, { merge: true });
          return { numeroDeEnvio: numero, precio };
        });
        await logAdminAndreani(db, adm.user.uid, "dudoso_resolver", targetUid, `Pedido ${envioId} → ${resultado === "existe" ? `existe (${out.numeroDeEnvio})` : `no existe · reverso $${out.monto.toLocaleString("es-AR")}`}`, { envioId, resultado, ...out });
        return res.json({ ok: true, resultado, ...out });
      }

      // ── Anulada con ingreso: la anulación inmediata devolvió el saldo pero
      // el paquete igual entró a Andreani (track_all marcó anuladaIngresoTs).
      // Se vuelve a debitar el precio. Idempotente (andreani.anuladaDebitada).
      if (action === "admin_anulada_debitar") {
        const targetUid = String(body.uid || "").trim();
        const envioId = String(body.envioId || "").trim();
        if (!targetUid || !/^[\w.\-]{1,80}$/.test(envioId)) return res.status(400).json({ error: "uid y envioId requeridos" });
        const tRef = db.collection("users").doc(targetUid);
        const eRef = tRef.collection("envios").doc(envioId);
        const tMov = tRef.collection("andreani_mov").doc();
        const ahoraIso = new Date().toISOString();
        const out = await db.runTransaction(async (tx) => {
          const [uS, eS] = await Promise.all([tx.get(tRef), tx.get(eRef)]);
          if (!eS.exists) throw new Error("El envío no existe.");
          const a = eS.data().andreani || {};
          if (!a.anuladaIngresoTs) throw new Error("Andreani no registró ingreso para esa etiqueta anulada.");
          if (a.anuladaDebitada) return { ya: true, monto: Math.round(Number(a.precio) || 0) };
          const monto = Math.round(Number(a.precio) || 0);
          if (!(monto > 0)) throw new Error("El envío no tiene precio registrado: debitá a mano desde Saldos.");
          const saldo = Math.round(Number(uS.data()?.andreaniSaldo) || 0);
          const nuevo = saldo - monto;
          tx.set(tRef, { andreaniSaldo: nuevo }, { merge: true });
          tx.set(tMov, { tipo: "debito", monto, saldoDespues: nuevo, nota: "etiqueta anulada con ingreso a Andreani", envioId, numeroDeEnvio: a.numeroDeEnvio || null, adminUid: adm.user.uid, ts: FieldValue.serverTimestamp() });
          tx.set(eRef, { andreani: { anuladaDebitada: true, anuladaDebitadaAt: ahoraIso } }, { merge: true });
          if (a.numeroDeEnvio) tx.set(db.collection("andreani_idx").doc(String(a.numeroDeEnvio)), { anulada: false, reintegro: 0, debitadaTrasAnulacion: true }, { merge: true });
          tx.set(db.collection("andreani_config").doc(`stats_${mesAR()}`), { reintegros: FieldValue.increment(-monto), porUid: { [targetUid]: { reintegros: FieldValue.increment(-monto) } } }, { merge: true });
          return { monto, saldo: nuevo };
        });
        if (!out.ya) await logAdminAndreani(db, adm.user.uid, "anulada_debitar", targetUid, `Pedido ${envioId}: etiqueta anulada con ingreso, debitados $${out.monto.toLocaleString("es-AR")} · saldo ${out.saldo.toLocaleString("es-AR")}`);
        return res.json({ ok: true, ...out });
      }

      // ── Markup por cliente: users/{uid}.andreaniMarkup {markupPct, markupFijo}.
      // body {uid, markupPct|null, markupFijo|null}; null borra ese override.
      if (action === "admin_markup_cliente") {
        const targetUid = String(body.uid || "").trim();
        if (!targetUid) return res.status(400).json({ error: "uid requerido" });
        const tRef = db.collection("users").doc(targetUid);
        const cur = (await tRef.get()).data();
        if (!cur) return res.status(404).json({ error: "El usuario no existe." });
        const prev = (cur.andreaniMarkup && typeof cur.andreaniMarkup === "object") ? cur.andreaniMarkup : {};
        const nuevo = { ...prev };
        if (body.markupPct !== undefined) {
          if (body.markupPct === null || body.markupPct === "") delete nuevo.markupPct;
          else { const v = Number(body.markupPct); if (!isFinite(v) || v < 0 || v > 200) return res.status(400).json({ error: "markupPct inválido (0-200)" }); nuevo.markupPct = v; }
        }
        if (body.markupFijo !== undefined) {
          if (body.markupFijo === null || body.markupFijo === "") delete nuevo.markupFijo;
          else { const v = Math.round(Number(body.markupFijo)); if (!isFinite(v) || v < 0 || v > 100000) return res.status(400).json({ error: "markupFijo inválido (0-100000)" }); nuevo.markupFijo = v; }
        }
        const vacio = nuevo.markupPct === undefined && nuevo.markupFijo === undefined;
        await tRef.set({ andreaniMarkup: vacio ? FieldValue.delete() : nuevo }, { merge: true });
        await logAdminAndreani(db, adm.user.uid, "markup_cliente", targetUid, vacio ? "Quitó el markup propio (vuelve al global)" : `Markup propio: ${nuevo.markupPct !== undefined ? nuevo.markupPct + " %" : "global"} + $${nuevo.markupFijo !== undefined ? nuevo.markupFijo : "global"}`, vacio ? null : nuevo);
        return res.json({ ok: true, uid: targetUid, andreaniMarkup: vacio ? null : nuevo });
      }

      // ── Purga de cachés viejas de andreani_config (versiones anteriores del
      // slim de sucursales, geocodificación vieja, rates_suc1..11 y
      // cotizaciones del checkout de más de 7 días). Solo ids (listDocuments),
      // se lee contenido únicamente para el ts de las rates_. Tope 2.000/llamada.
      if (action === "admin_cache_purge") {
        const col = db.collection("andreani_config");
        const PATRONES = [
          ["suc_cp", /^suc_\d{4}$/], ["suc_all", /^suc_all$/], ["suc_geo", /^suc_geo$/], ["geo_ck", /^geo_ck_/],
          ["rates_suc_viejas", /^rates_suc([1-9]|1[01])_/], ["suc_b2c_checkout", /^suc_b2c_checkout[12]$/],
        ];
        const TOPE = 2000, LOTE = 400;
        const refs = await col.listDocuments();
        const borrados = Object.fromEntries(PATRONES.map(([k]) => [k, 0]).concat([["rates_viejas", 0]]));
        const aBorrar = [];
        const ratesTs = [];
        for (const r of refs) {
          const p = PATRONES.find(([, rx]) => rx.test(r.id));
          if (p) { if (aBorrar.length < TOPE) { aBorrar.push(r); borrados[p[0]]++; } continue; }
          if (/^rates_/.test(r.id)) ratesTs.push(r);
        }
        // rates_*: hace falta el ts → se leen de a 100 (solo hasta llenar el tope).
        const corte = Date.now() - 7 * 86400000;
        let restantes = aBorrar.length >= TOPE;
        for (let i = 0; i < ratesTs.length && aBorrar.length < TOPE; i += 100) {
          const snaps = await db.getAll(...ratesTs.slice(i, i + 100), { fieldMask: ["ts"] });
          for (const s of snaps) {
            if (aBorrar.length >= TOPE) { restantes = true; break; }
            const ts = Number(s.data()?.ts) || 0;
            if (s.exists && ts < corte) { aBorrar.push(s.ref); borrados.rates_viejas++; }
          }
        }
        for (let i = 0; i < aBorrar.length; i += LOTE) {
          const b = db.batch();
          aBorrar.slice(i, i + LOTE).forEach(r => b.delete(r));
          await b.commit();
        }
        const total = aBorrar.length;
        if (total) await logAdminAndreani(db, adm.user.uid, "cache_purge", null, `Borró ${total} caché(s) de andreani_config`, borrados);
        return res.json({ ok: true, total, borrados, restantes });
      }

      // ── Conciliación contra la factura de Andreani ──
      // Recibe filas {numero, costo} (del detalle de facturación que manda
      // Andreani; body.mes YYYY-MM opcional) y las cruza por número de envío
      // con el índice de emisiones. Persistente: cada número encontrado queda
      // con andreani_idx/{numero}.facturado {costoFactura, mes, ts, diff} y el
      // resumen en andreani_config/conciliacion_{mes}. También lista lo emitido
      // en el mes que la factura NO trae (sin anuladas con reintegro).
      if (action === "admin_conciliar") {
        const filas = (Array.isArray(body.filas) ? body.filas : []).slice(0, 600)
          .map(f => ({ numero: String(f.numero || "").replace(/\D/g, ""), costo: Math.round(Number(f.costo) || 0) }))
          .filter(f => f.numero.length >= 10);
        if (!filas.length) return res.status(400).json({ error: "No hay números de envío en el archivo." });
        const out = [], coinciden = [], diferencias = [], noEmitidos = [];
        const facturadoSet = new Set();
        const mesesIdx = new Map();
        let encontrados = 0, cobrado = 0, facturado = 0, costoModelo = 0;
        const escrituras = [];
        for (let i = 0; i < filas.length; i += 100) {
          const refs = filas.slice(i, i + 100).map(f => db.collection("andreani_idx").doc(f.numero));
          const snaps = await db.getAll(...refs);
          snaps.forEach((sn, j) => {
            const f = filas[i + j];
            const d = sn.exists ? sn.data() : null;
            if (!d) { noEmitidos.push(f.numero); out.push({ numero: f.numero, costoFactura: f.costo, uid: null, envioId: null, precio: null, costoModelo: null, mes: null, diff: null }); return; }
            const costoIdx = Number(d.costo) || 0;
            const diff = costoIdx - f.costo;
            encontrados++; cobrado += Number(d.precio) || 0; facturado += f.costo; costoModelo += costoIdx;
            facturadoSet.add(f.numero);
            if (d.mes) mesesIdx.set(d.mes, (mesesIdx.get(d.mes) || 0) + 1);
            (diff === 0 ? coinciden : diferencias).push({ numero: f.numero, uid: d.uid || null, envioId: d.envioId || null, costoIdx, costoFactura: f.costo, diff, anulada: !!d.anulada });
            out.push({ numero: f.numero, costoFactura: f.costo, uid: d.uid || null, envioId: d.envioId || null, precio: Number(d.precio) || 0, costoModelo: costoIdx, mes: d.mes || null, diff });
            escrituras.push({ ref: sn.ref, costoFactura: f.costo, diff });
          });
        }
        // Mes de la conciliación: el que manda el admin, si no el más frecuente del índice, si no el actual.
        const mes = /^\d{4}-\d{2}$/.test(String(body.mes || "")) ? String(body.mes)
          : ([...mesesIdx.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || mesAR());
        const tsNow = Date.now();
        for (let i = 0; i < escrituras.length; i += 400) {
          const b = db.batch();
          escrituras.slice(i, i + 400).forEach(w => b.set(w.ref, { facturado: { costoFactura: w.costoFactura, mes, ts: tsNow, diff: w.diff } }, { merge: true }));
          await b.commit();
        }
        // Emitidas ese mes que la factura no trae (excluye anuladas con reintegro y lo ya facturado).
        let emitidosNoFacturados = [];
        try {
          const q = await db.collection("andreani_idx").where("mes", "==", mes).limit(3000).get();
          emitidosNoFacturados = q.docs.filter(d => {
            const x = d.data();
            if (facturadoSet.has(d.id) || x.facturado) return false;
            if (x.anulada && Number(x.reintegro) > 0) return false;
            return true;
          }).map(d => { const x = d.data(); return { numero: d.id, uid: x.uid || null, envioId: x.envioId || null, precio: Number(x.precio) || 0, costoIdx: Number(x.costo) || 0, tipo: x.tipo || null, ts: x.ts?.toMillis?.() || null }; });
        } catch (e) { console.warn("[admin_conciliar] emitidos del mes:", e.message); }
        const resumen = { total: filas.length, encontrados, noEncontrados: filas.length - encontrados, coinciden: coinciden.length, diferencias: diferencias.length, emitidosNoFacturados: emitidosNoFacturados.length, cobrado, facturado, costoModelo, diffTotal: costoModelo - facturado, margenReal: cobrado - facturado };
        try { await db.collection("andreani_config").doc(`conciliacion_${mes}`).set({ ts: tsNow, mes, adminUid: adm.user.uid, totales: resumen }, { merge: true }); } catch (e) { console.warn("[admin_conciliar] resumen:", e.message); }
        await logAdminAndreani(db, adm.user.uid, "conciliar_factura", null, `Factura ${mes}: ${filas.length} filas · ${encontrados} en el índice · ${diferencias.length} con diferencia · ${emitidosNoFacturados.length} emitidas sin facturar`, resumen);
        return res.json({ ok: true, mes, filas: out, resumen, coinciden, diferencias, noEmitidos, emitidosNoFacturados });
      }
      // Reconstruye el índice andreani_idx para etiquetas emitidas antes de
      // que existiera (lee los envíos por API de las cuentas habilitadas).
      if (action === "admin_idx_backfill") {
        const cfg = await getGlobalConfig(db);
        const uids = [...new Set([...cfg.habilitados, ...FOUNDERS])];
        let escritos = 0, vistos = 0; const t0 = Date.now();
        for (const u of uids) {
          if (Date.now() - t0 > 40000) break;
          let snap; try { snap = await db.collection("users").doc(u).collection("envios").limit(1500).get(); } catch (_) { continue; }
          const wb = [];
          for (const d of snap.docs) {
            const e = d.data(); const num = e.andreani?.numeroDeEnvio; if (!num) continue; vistos++;
            wb.push({ num, data: { uid: u, envioId: d.id, precio: Number(e.andreani.precio) || 0, tipo: e.andreani.tipo || null, mes: e.andreani.ts?.toDate ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit" }).format(e.andreani.ts.toDate()) : null, ts: e.andreani.ts || FieldValue.serverTimestamp() } });
          }
          for (let i = 0; i < wb.length; i += 400) {
            const b = db.batch();
            wb.slice(i, i + 400).forEach(x => b.set(db.collection("andreani_idx").doc(x.num), x.data, { merge: true }));
            await b.commit(); escritos += Math.min(400, wb.length - i);
          }
        }
        return res.json({ ok: true, cuentas: uids.length, vistos, escritos });
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
        await logAdminAndreani(db, adm.user.uid, "acreditar_carga", out.uid, `Carga ${out.ref} $${out.monto.toLocaleString("es-AR")} acreditada · saldo ${out.saldo.toLocaleString("es-AR")}`);
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
        try { const cs = await cRef.get(); await logAdminAndreani(db, adm.user.uid, "rechazar_carga", cs.data()?.uid, `Carga ${cs.data()?.ref || id} rechazada${motivo ? ": " + motivo : ""}`); } catch (_) {}
        return res.json({ ok: true });
      }

      if (action === "admin_config") {
        const gRef = db.collection("andreani_config").doc("global");
        if (req.method === "POST" && (body.markupPct !== undefined || body.markupFijo !== undefined || body.habilitados !== undefined || body.descuentoPct !== undefined || body.seguroPct !== undefined || body.sucursalOrigen !== undefined || body.datosPago !== undefined)) {
          const upd = {};
          if (body.markupPct !== undefined) {
            const v = Number(body.markupPct);
            if (!isFinite(v) || v < 0 || v > 200) return res.status(400).json({ error: "markupPct inválido (0-200)" });
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
          if (body.ejecutivaEmail !== undefined) upd.ejecutivaEmail = String(body.ejecutivaEmail || "").trim().slice(0, 160);
          if (body.emailGestiones !== undefined) upd.emailGestiones = String(body.emailGestiones || "").trim().slice(0, 160);
          if (body.ejecutivaWa !== undefined) upd.ejecutivaWa = String(body.ejecutivaWa || "").replace(/\D/g, "").slice(0, 20);
          if (body.ejecutivaNombre !== undefined) upd.ejecutivaNombre = String(body.ejecutivaNombre || "").trim().slice(0, 60);
          if (body.anulacionDias !== undefined) {
            const v = Math.round(Number(body.anulacionDias));
            if (!isFinite(v) || v < 3 || v > 90) return res.status(400).json({ error: "anulacionDias inválido (3-90)" });
            upd.anulacionDias = v;
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
          const cambios = Object.keys(upd).filter(k => k !== "habilitados");
          await logAdminAndreani(db, adm.user.uid, "config_envios", null, (cambios.length ? "Cambió " + cambios.join(", ") : "") + (upd.habilitados ? ` · ${upd.habilitados.length} cuenta(s) habilitada(s)` : ""), cambios.length ? Object.fromEntries(cambios.map(k => [k, upd[k]])) : null);
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
          if (esDemo(dd)) return; // tienda DEMO: saldo ficticio, no es plata de la plataforma
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
    // Mensajes de Andreani / de negocio ya vienen en castellano y sirven al
    // usuario; los internos (Firestore, login de Andreani, variables) no.
    const m = String(e?.message || "");
    const interno = !m || /firestore|grpc|deadline|unavailable|permission|ANDREANI_|ECONN|ETIMEDOUT|fetch failed|is not a function|undefined|null/i.test(m);
    return res.status(500).json({ error: interno ? "Error interno de Growith. Reintentá en un minuto; si sigue, avisanos." : m });
  }
}
