import { createCipheriv } from "crypto";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { guardUid, guardCron, verifyAuth } from "./_auth.js";
import { ensureShopifyToken } from "./integrations/_shared.js";
import { trazasOficialAndreani, trazasDebugAndreani, getGlobalConfig, envioSinIngreso, CASO_MOTIVOS, mailEjecutiva } from "./andreani.js";
import { FieldValue } from "firebase-admin/firestore";
import { esDemo } from "./_demo.js";
import { esNumeroEnvioDemo } from "./_demo_ops.js";

// Mail simple (Resend), best-effort: nunca rompe el cron.
async function mailEnvios(to, subject, html) {
  if (!to || !process.env.RESEND_API_KEY) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.RESEND_FROM || "Growith <onboarding@resend.dev>", to, subject, html }),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch (e) { console.error("[envios mail]", e.message); return false; }
}
const esc = (v) => String(v ?? "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
const mailShell = (titulo, sub, cuerpo) => `<div style="font-family:Inter,system-ui,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#fff;color:#374151">
  <div style="background:linear-gradient(135deg,#6366f1,#a78bfa);padding:22px;border-radius:12px;text-align:center;margin-bottom:22px">
    <div style="font-size:18px;font-weight:700;color:#fff">${esc(titulo)}</div>
    ${sub ? `<div style="font-size:13px;color:rgba(255,255,255,0.85);margin-top:4px">${esc(sub)}</div>` : ""}
  </div>
  ${cuerpo}
  <p style="font-size:12px;color:#9ca3af;text-align:center;margin-top:24px">Growith — Envíos</p>
</div>`;
// Problemas por envío (misma lógica que Seguimientos y Admin) con umbrales por
// cuenta. Lo usa el cron track_all para el badge `enviosProblemasN` y el resumen
// diario al dueño (que además cuenta los seguimientos abandonados a la tienda).
function problemaEnvio(e, ahora, cfg) {
  const dias = iso => { const t = iso ? Date.parse(iso) : NaN; return isFinite(t) ? Math.floor((ahora - t) / 86400000) : null; };
  const sucD = Math.max(1, Number(cfg?.sucursalDias) || 3), quietoD = Math.max(2, Number(cfg?.quietoDias) || 7);
  if (e.categoria === "devolucion" || e.devolucionAt) return { tipo: "devolucion", sev: "red", msg: "está volviendo (devolución)" };
  if (!e.activo) return null;
  if (e.categoria === "visita_fallida") return { tipo: "visita_fallida", sev: "amber", msg: "visita fallida — Andreani reintenta o lo lleva a sucursal" };
  if (e.categoria === "en_sucursal") { const d = dias(e.enSucursalDesde); if (d != null && d >= sucD) return { tipo: "sucursal", sev: d >= sucD + 2 ? "red" : "amber", msg: `en sucursal hace ${d} días sin retirar${d >= sucD + 2 ? " — el plazo está por vencer" : ""}` }; return null; }
  const dEst = dias(e.estadoDesde || e.despachadoAt || e.creado);
  if (e.andreani?.numeroDeEnvio && envioSinIngreso(e)) { const dc = dias(e.andreani?.ts?.toDate ? e.andreani.ts.toDate().toISOString() : e.creado); if (dc != null && dc >= 3) return { tipo: "sin_despacho", sev: "amber", msg: `etiqueta emitida hace ${dc} días y Andreani nunca registró el ingreso` }; return null; }
  if ((e.categoria === "en_camino" || e.categoria === "otro" || e.categoria === "desconocido") && (e.tracking || e.andreani?.numeroDeEnvio) && dEst != null && dEst >= quietoD) return { tipo: "quieto", sev: "amber", msg: `sin movimiento hace ${dEst} días` };
  return null;
}

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
    }),
  });
  return getFirestore();
}

// ── Consulta de tracking Andreani (tracking público v3, sin API contratada) ──
// Factoreada para que la usen el proxy (action=tracking), la página pública
// de seguimiento (action=seguir) y el cron de seguimiento masivo (track_all).
// Los endpoints viejos (tracking.andreani.com v1, clientes.andreani.com,
// api.andreani.com) ya no existen: solo queda v3 y si falla se devuelve null.
const BROWSER_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'es-AR,es;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Origin': 'https://www.andreani.com',
  'Referer': 'https://www.andreani.com/',
};

// La API oficial v1 de trazas devuelve las claves Capitalizadas ("Estado",
// "Fecha", "Evento") y los endpoints públicos en minúscula — se aceptan ambas.
function estadoDeEvento(ev) {
  if (!ev || typeof ev !== 'object') return null;
  return ev.estado || ev.Estado || ev.evento || ev.Evento || ev.descripcion || ev.Descripcion || ev.accion || ev.Accion || ev.motivo || ev.Motivo || null;
}

function extractEstado(d) {
  if (!d || typeof d !== 'object') return null;
  const evs = extractEventos(d);
  if (evs.length > 0) {
    const est = estadoDeEvento(evs[evs.length - 1]);
    if (est) return est;
  }
  return d.estado || d.Estado || d.estadoActual || d.estadoEnvio ||
         d.ultimoEvento?.estado || d.ultimoEvento?.descripcion ||
         d.evento || d.Evento || d.descripcion || null;
}

function extractEventos(d) {
  if (!d || typeof d !== 'object') return [];
  if (Array.isArray(d.eventos)) return d.eventos;
  if (Array.isArray(d.Eventos)) return d.Eventos;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d.historial)) return d.historial;
  if (Array.isArray(d.events)) return d.events;
  return [];
}

// ── Tracking público NUEVO de andreani.com/envio/{n} ──────────────────────
// El sitio consulta tracking-api.andreani.com/api/v3/Tracking?payload=<AES>.
// El payload es AES-256-CBC del JSON {idReceptor,idSistema,userData,numeroAndreani}
// con clave e IV que el propio front publica en su __ENV.js (son públicos:
// el "cifrado" solo ofusca la query, no autentica). Es tracking público: anda
// con envíos de CUALQUIER cuenta, que es lo que necesitamos para los envíos
// viejos emitidos fuera del contrato corporativo.
const AND_PUB_KEY = Buffer.from("12345678901234567890123456789012", "utf8");
const AND_PUB_IV  = Buffer.from("1234567890123456", "utf8");
function andreaniPublicPayload(nro) {
  const body = JSON.stringify({ idReceptor: 1, idSistema: 1, userData: JSON.stringify({ mail: "" }), numeroAndreani: String(nro) });
  const c = createCipheriv("aes-256-cbc", AND_PUB_KEY, AND_PUB_IV);
  return Buffer.concat([c.update(body, "utf8"), c.final()]).toString("base64");
}
// Normaliza la respuesta v3 a {estado, eventos:[{estado,fecha,descripcion}]}.
// Estructura real: {timelines:[{orden,titulo,traducciones:[{traduccion,fechaEvento}]}]}
// — cada timeline es una etapa (Pendiente de ingreso / Ingresado / En camino /
// En sucursal / Entregado) y solo las alcanzadas traen `traducciones`.
// El estado actual = el evento de fecha máxima; su `titulo` es la etapa.
function parseTrackingV3(d) {
  if (!d || typeof d !== "object") return null;
  const tls = Array.isArray(d.timelines) ? d.timelines : (Array.isArray(d.Timelines) ? d.Timelines : []);
  const eventos = [];
  for (const t of tls) {
    const titulo = t.titulo || t.Titulo || "";
    const trads = Array.isArray(t.traducciones) ? t.traducciones : (Array.isArray(t.Traducciones) ? t.Traducciones : []);
    for (const tr of trads) {
      eventos.push({
        estado: titulo,
        descripcion: String(tr.traduccion || tr.Traduccion || "").replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim(),
        fecha: tr.fechaEvento || tr.FechaEvento || "",
        orden: Number(t.orden ?? t.Orden ?? 0),
      });
    }
  }
  if (eventos.length) {
    // Por fecha; si empatan o faltan, gana el de mayor `orden` (etapa más avanzada).
    let mejor = eventos[0], mejorT = -Infinity;
    for (const ev of eventos) {
      const t = ev.fecha ? Date.parse(ev.fecha) : NaN;
      const val = isFinite(t) ? t : -Infinity;
      if (val > mejorT || (val === mejorT && ev.orden >= (mejor.orden || 0))) { mejorT = val; mejor = ev; }
    }
    // "Etapa — detalle": clasificarEstado matchea la etapa (En camino/Entregado/…)
    return { estado: `${mejor.estado}${mejor.descripcion ? " — " + mejor.descripcion : ""}`.trim(), eventos };
  }
  const est = d.estado || d.Estado || d.fechaEstimadaDeEntrega || null;
  return est ? { estado: String(est).replace(/<[^>]+>/g, "").trim(), eventos: [] } : null;
}
// `signal` opcional: el cron pasa el AbortController de la corrida para que un
// fetch colgado no sobreviva al deadline. Se combina con el timeout duro de 8 s.
async function trackAndreaniPublico(nroRaw, signal) {
  const nro = String(nroRaw || "").trim().replace(/\s+/g, "");
  if (!nro) return null;
  try {
    const url = `https://tracking-api.andreani.com/api/v3/Tracking?payload=${encodeURIComponent(andreaniPublicPayload(nro))}`;
    const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000);
    const r = await fetch(url, { headers: BROWSER_HEADERS, signal: sig });
    if (!r.ok) return null;
    const text = await r.text();
    if (text.startsWith("<") || text.startsWith("<!")) return null;
    let d; try { d = JSON.parse(text); } catch { return null; }
    const out = parseTrackingV3(d);
    return out ? { ...out, raw: d, source: "publico_v3" } : null;
  } catch (_) { return null; }
}

// Única vía de scraping: tracking público v3 (la que usa andreani.com hoy).
// Timeout duro de 8 s: los servidores de Andreani a veces dejan la conexión
// colgada y sin esto un solo tracking se comía el budget de la función.
async function trackAndreani(nroRaw, signal) {
  const nro = String(nroRaw || "").trim().replace(/\s+/g, '');
  if (!nro) return null;
  return await trackAndreaniPublico(nro, signal);
}

// Estado más reciente de las trazas OFICIALES (/v1/envios/{n}/trazas).
// La API puede devolver los eventos en cualquier orden: si traen fecha se
// elige el de fecha máxima; si no, el heurístico de siempre (extractEstado).
function fechaDeEvento(ev) {
  const f = ev?.fecha || ev?.Fecha || ev?.fechaHora || ev?.FechaHora || ev?.fechaEvento || ev?.FechaEvento || ev?.timestamp || ev?.date || null;
  // La API oficial puede mandar la fecha como objeto {dia,hora} o similar
  const fStr = (f && typeof f === 'object') ? [f.dia || f.Dia || "", f.hora || f.Hora || ""].join("T") : f;
  const t = fStr ? Date.parse(fStr) : NaN;
  return isFinite(t) ? t : null;
}

function estadoOficial(trazas) {
  if (!trazas) return null;
  const eventos = extractEventos(trazas);
  if (eventos.length) {
    // El de fecha máxima entre los que traen fecha (antes se exigía que TODOS
    // tuvieran fecha y un solo evento sin fecha anulaba la traza completa).
    let mejor = null, mejorT = -Infinity;
    for (const ev of eventos) {
      const t = fechaDeEvento(ev);
      if (t != null && t >= mejorT) { mejorT = t; mejor = ev; }
    }
    const estado = estadoDeEvento(mejor);
    if (estado) return { estado, eventos };
  }
  const estado = extractEstado(trazas);
  return estado ? { estado, eventos } : null;
}

// Clasificación heurística del estado de Andreani → categoría interna.
// (Misma lógica conceptual que mapAndreaniEstado del frontend.)
// Reglas ORDENADAS [fuente de regex, categoría] — la primera que matchea gana.
// El front (mapAndreaniEstado) copia esta misma lista; se exporta al final del
// archivo como GH_ESTADO_REGLAS. Orden y por qué:
//  1. "no ingresado / pendiente de ingreso": antes de en_camino, si no /ingresad/
//     pintaba "En camino" falso.
//  2-3. NEGACIONES primero ("no se pudo entregar", "no entregado", "sin
//     entregar", "rechazado"): contienen "entregad" y antes caían en entregado.
//     Si el texto además habla de devolución/remitente → devolucion; si no →
//     visita_fallida.
//  4. "retirado del cliente / colecta / retiro en origen" = Andreani lo retiró
//     del vendedor: en_camino, NO entregado (antes /retirad/ lo daba por entregado).
//  5. entregado: solo "retirado por el destinatario" o "entregado".
//  6. en_sucursal: "en camino a la sucursal X" / "procesando en la sucursal X"
//     contienen "sucursal" pero TODAVÍA no llegó → lookahead negativo.
//  7-9. devolucion, visita_fallida, en_camino como siempre.
const ESTADO_REGLAS = [
  ["no ingresad|pendiente de ingreso|sin movimientos", "otro"],
  ["(no (se )?(pudo )?entreg|no entregad|sin entregar).*(devoluci|devuelto|regres|remitente|retorn)|rechaz", "devolucion"],
  ["no (se )?(pudo )?entreg|no entregad|sin entregar", "visita_fallida"],
  ["retirado del cliente|colecta|retiro en origen", "en_camino"],
  ["retirado por el destinatario|entregado", "entregado"],
  ["^(?!.*(camino a la sucursal|procesando (tu|el) env|hacia la sucursal)).*(sucursal|disponible.*retiro|retiro.*disponible|para retirar)", "en_sucursal"],
  ["devoluci|devuelto|regres|rehusad", "devolucion"],
  ["visita|no se pudo|ausente|no.*entrega|reprogram", "visita_fallida"],
  ["camino|reparto|distribuc|transito|tránsito|viaje|planta|procesamiento|procesando|admitid|ingresad|recibimos|despachad", "en_camino"],
];
const ESTADO_REGLAS_RX = ESTADO_REGLAS.map(([src, cat]) => [new RegExp(src), cat]);
// Negaciones (reglas 2 y 3): se prueban ANTES de la vía rápida por etapa.
const ESTADO_NEGACIONES_RX = ESTADO_REGLAS_RX.slice(1, 3);
function clasificarEstado(estadoStr) {
  const s = String(estadoStr || "").toLowerCase();
  if (!s) return "desconocido";
  // Vía rápida determinista: el tracking v3 arma el estado como "Etapa — detalle"
  // y la etapa es un valor cerrado. Sin esto, el texto del detalle confunde a la
  // heurística (ej: "Ingresado — Pronto lo enviaremos a la sucursal encargada...").
  const ETAPAS = { "pendiente de ingreso": "otro", "ingresado": "en_camino", "en camino": "en_camino", "en sucursal": "en_sucursal", "entregado": "entregado" };
  const etapa = ETAPAS[s.split(" — ")[0].trim()];
  // "En sucursal" es físico (ya está ahí) aunque el detalle explique que no se
  // pudo entregar; en las demás etapas las negaciones mandan ("Entregado — no
  // se pudo entregar" / "En camino — rechazado, vuelve al remitente").
  if (etapa === "en_sucursal") return etapa;
  for (const [rx, cat] of ESTADO_NEGACIONES_RX) if (rx.test(s)) return cat;
  if (etapa) return etapa;
  for (const [rx, cat] of ESTADO_REGLAS_RX) if (rx.test(s)) return cat;
  return "otro";
}

// ── Subir el tracking a la tienda (Tienda Nube o Shopify) ─────────────────
// Lo comparten el handler HTTP (fulfill desde Envíos) y el cron track_all (cola
// de reintento `tiendaPendiente`). No toca `res`: devuelve
//   { ok, fulfilled, fulfillError, tnOrderId }            si se pudo
//   { ok:false, status, code, error }                     si no
// Shopify manda si está conectado (misma prioridad que orders.js). "Ya estaba
// marcado como enviado" en la tienda NO es error: ok:true + fulfilled:false y
// el tracking queda registrado en Growith para el seguimiento.
async function subirTrackingTienda(db, uid, uData, { orderId, tracking }) {
  const stores = (uData && uData.stores) || [];
  const tnStore = stores.find(s => s.type === "tiendanube");
  const shStore = stores.find(s => s.type === "shopify" && s.accessToken && s.shop) || null;
  if (!orderId || !tracking) return { ok: false, status: 400, code: "params", error: "Faltan orderId o tracking" };
  const trackingUrl = `https://www.andreani.com/envio/${tracking}`;

  // ── Rama Shopify: crea un fulfillment con la API de FulfillmentOrders
  // (equivalente al PUT+fulfill de TN).
  if (shStore) {
    await ensureShopifyToken(db, uid, shStore);
    const shHeaders = { 'X-Shopify-Access-Token': shStore.accessToken, 'Content-Type': 'application/json' };
    const shBase = `https://${shStore.shop}/admin/api/2024-10`;
    // Shopify limita a ~2 req/s por tienda: ante 429 se espera lo que pide
    // (Retry-After) y se reintenta una vez, en vez de fallar el seguimiento.
    const shFetch = async (url, opts) => {
      let r = await fetch(url, opts);
      if (r.status === 429) { const wait = Math.min(5000, Math.max(1000, Number(r.headers.get("retry-after") || 2) * 1000)); await new Promise(x => setTimeout(x, wait)); r = await fetch(url, opts); }
      return r;
    };
    // Sin permiso de fulfillment (tiendas conectadas antes de que Growith lo
    // pidiera): Shopify responde 403 en fulfillment_orders / fulfillments. El
    // mensaje tiene que decir QUÉ hacer, y el front corta el lote (code).
    const sinPermiso = () => ({ ok: false, status: 403, code: "shopify_scope", error: "Shopify no le dio a Growith permiso para marcar envíos (fulfillment). Reconectá Shopify desde Config → Integraciones (vuelve a pedir el permiso) y volvé a enviar los seguimientos: solo se reintentan los que faltan." });
    try {
      // 1. Buscar la orden por número visible (name = "#1001"; algunas tiendas
      //    usan prefijo/sufijo en el nombre → segundo intento sin "#" y, si
      //    tampoco, por order_number en las órdenes recientes)
      const buscar = async (name) => {
        const sr = await shFetch(`${shBase}/orders.json?name=${encodeURIComponent(name)}&status=any&fields=id,order_number,name,fulfillment_status`, { headers: shHeaders });
        if (sr.status === 401 || sr.status === 403) throw Object.assign(new Error("scope"), { scope: true });
        if (!sr.ok) throw new Error(`Shopify search error ${sr.status}`);
        const sd = await sr.json();
        return (sd.orders || []).find(o => String(o.order_number) === String(orderId) || String(o.name || "").replace(/\D/g, "") === String(orderId)) || null;
      };
      let order = await buscar('#' + orderId);
      if (!order) order = await buscar(String(orderId));
      if (!order) {
        // Paginación por cursor (Link: page_info), de la más nueva a la más vieja,
        // hasta 6 páginas de 250 o hasta pasar el número buscado.
        let url = `${shBase}/orders.json?status=any&limit=250&fields=id,order_number,name,fulfillment_status`;
        for (let pag = 0; pag < 6 && url && !order; pag++) {
          const sr = await shFetch(url, { headers: shHeaders });
          if (!sr.ok) break;
          const lst = (await sr.json()).orders || [];
          if (!lst.length) break;
          order = lst.find(o => String(o.order_number) === String(orderId)) || null;
          const minNum = Math.min(...lst.map(o => Number(o.order_number) || Infinity));
          if (minNum < Number(orderId)) break;
          const m = /<([^>]+)>;\s*rel="next"/.exec(sr.headers.get("link") || "");
          url = m ? m[1] : null;
        }
      }
      if (!order) return { ok: false, status: 404, code: "not_found", error: `Pedido #${orderId} no encontrado en Shopify` };
      // Ya marcado como enviado en Shopify (a mano o por otra app): no es un
      // error — el tracking igual queda registrado en Growith para el
      // seguimiento automático, y se avisa que el cliente no recibió mail nuevo.
      if ((order.fulfillment_status || "").toLowerCase() === 'fulfilled') {
        return { ok: true, tnOrderId: String(order.id), fulfilled: false, fulfillError: "ya estaba marcado como enviado en Shopify" };
      }
      // 2. Fulfillment orders abiertos de la orden
      const fr = await shFetch(`${shBase}/orders/${order.id}/fulfillment_orders.json`, { headers: shHeaders });
      if (fr.status === 401 || fr.status === 403) return sinPermiso();
      if (!fr.ok) throw new Error(`Shopify fulfillment_orders error ${fr.status}`);
      const fd = await fr.json();
      // Shopify solo deja crear el fulfillment sobre FO open / in_progress: un
      // FO en espera (on_hold: fraude, pago pendiente) o programado (scheduled)
      // hace fallar el POST entero con 422, así que no se incluye y se avisa.
      const fos = fd.fulfillment_orders || [];
      const abiertos = fos.filter(fo => ["open", "in_progress"].includes((fo.status || "").toLowerCase()));
      if (!abiertos.length) {
        const enEspera = fos.some(fo => ["on_hold", "scheduled"].includes((fo.status || "").toLowerCase()));
        if (enEspera) return { ok: false, status: 400, code: "shopify_hold", error: `El pedido #${orderId} está en espera en Shopify (retenido o programado): liberalo en Shopify y volvé a enviar el seguimiento.` };
        return { ok: false, status: 400, code: "shopify_sin_items", error: `El pedido #${orderId} no tiene items pendientes de despacho en Shopify.` };
      }
      // 3. Crear el fulfillment con tracking + aviso al cliente
      const pr = await shFetch(`${shBase}/fulfillments.json`, {
        method: 'POST', headers: shHeaders,
        body: JSON.stringify({ fulfillment: {
          line_items_by_fulfillment_order: abiertos.map(fo => ({ fulfillment_order_id: fo.id })),
          tracking_info: { number: tracking, url: trackingUrl, company: "Andreani" },
          notify_customer: true,
        } }),
      });
      if (pr.status === 401 || pr.status === 403) return sinPermiso();
      if (!pr.ok) {
        const pd = await pr.json().catch(() => ({}));
        const fulfillError = pd.errors ? JSON.stringify(pd.errors).slice(0, 200) : `Shopify ${pr.status}`;
        return { ok: false, status: 502, code: "shopify_fulfillment", error: `No se pudo crear el fulfillment: ${fulfillError}` };
      }
      return { ok: true, tnOrderId: String(order.id), fulfilled: true, fulfillError: null };
    } catch (e) {
      if (e && e.scope) return sinPermiso();
      return { ok: false, status: 500, code: "shopify_error", error: e.message };
    }
  }

  // ── Rama Tienda Nube ──
  if (!tnStore?.accessToken || !tnStore?.storeId) return { ok: false, status: 403, code: "sin_tienda", error: "Tienda no conectada" };
  const storeId = tnStore.storeId;
  const headers = {
    'Authentication': `bearer ${tnStore.accessToken}`,
    'User-Agent': 'GrowithApp (contacto.growith@gmail.com)',
    'Content-Type': 'application/json',
  };
  // TN limita las llamadas por tienda: un 429 en cualquier paso se informa
  // como tal (con el Retry-After) para que el llamador reintente, no como 500.
  const rateLimit = (r) => ({ ok: false, status: 429, code: "tn_rate_limit", retryAfter: Math.max(1, Number(r.headers.get("retry-after")) || 3), error: "Tienda Nube limitó las llamadas, reintentá en unos segundos" });
  try {
    // 1. Buscar el pedido por número. per_page=30 (antes 5): el q= de TN matchea
    // por substring y con 5 resultados la orden exacta podía quedar afuera
    // (ej: "123" matchea #1123, #1234...) → 404 falso en plena tanda.
    const searchRes = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?q=${orderId}&per_page=30`, { headers });
    if (searchRes.status === 429) return rateLimit(searchRes);
    if (!searchRes.ok) throw new Error(`TN search error ${searchRes.status}`);
    const orders = await searchRes.json();
    const order = Array.isArray(orders) ? orders.find(o => String(o.number) === String(orderId)) : null;
    if (!order) return { ok: false, status: 404, code: "not_found", error: `Pedido #${orderId} no encontrado` };

    const tnOrderId = order.id;
    const shippingStatus = order.shipping_status;
    // Ya enviado en TN (a mano o por otra app): mismo contrato que Shopify —
    // no es error, el tracking queda en Growith y no sale mail nuevo al cliente.
    if (shippingStatus === 'fulfilled' || shippingStatus === 'shipped') {
      return { ok: true, tnOrderId: String(tnOrderId), fulfilled: false, fulfillError: "ya estaba marcado como enviado en Tienda Nube" };
    }

    // 2. PUT para guardar el tracking (siempre funciona con write_orders)
    const putRes = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}`, {
      method: 'PUT', headers,
      body: JSON.stringify({ shipping_tracking_number: tracking, shipping_tracking_url: trackingUrl }),
    });
    if (putRes.status === 429) return rateLimit(putRes);
    const putData = await putRes.json().catch(() => ({}));
    if (!putRes.ok) return { ok: false, status: putRes.status, code: "tn_put", error: putData.message || putData.description || `Error TN ${putRes.status}` };

    // 3. POST /fulfill para marcar como enviado y notificar al cliente.
    // Antes esto era un catch vacío: si TN lo rechazaba, la UI decía "✓ Ok"
    // pero el cliente NO recibía el mail y la orden no quedaba enviada.
    // Ahora el resultado se informa de verdad (fulfilled: true/false).
    let fulfilled = false, fulfillError = null;
    try {
      const fr = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}/fulfill`, {
        method: 'POST', headers,
        body: JSON.stringify({ shipping_tracking_number: tracking, notify_customer: true }),
      });
      if (fr.status === 429) return rateLimit(fr);
      fulfilled = fr.ok;
      if (!fr.ok) { const fd = await fr.json().catch(() => ({})); fulfillError = fd.message || fd.description || `TN ${fr.status}`; }
    } catch (e) { fulfillError = e.message; }
    return { ok: true, tnOrderId: String(tnOrderId), fulfilled, fulfillError };
  } catch (e) {
    return { ok: false, status: 500, code: "tn_error", error: e.message };
  }
}

// ── Página pública de seguimiento (action=seguir): rate limit en memoria por
// IP (20 por minuto). Vive lo que viva la instancia: alcanza para frenar un
// barrido de números, que es lo único que se quiere evitar.
const SEGUIR_RL = new Map();
function seguirRateLimited(ip) {
  const ahora = Date.now();
  if (SEGUIR_RL.size > 5000) SEGUIR_RL.clear();
  const e = SEGUIR_RL.get(ip) || { desde: ahora, n: 0 };
  if (ahora - e.desde > 60000) { e.desde = ahora; e.n = 0; }
  e.n++;
  SEGUIR_RL.set(ip, e);
  return e.n > 20;
}
// Normaliza un evento (v3 público o demo) a lo ÚNICO que se publica:
// fecha / estado / descripcion / sucursal. Nunca datos del destinatario.
function eventoPublico(ev) {
  if (!ev || typeof ev !== "object") return null;
  const t = fechaDeEvento(ev);
  const out = {
    fecha: t != null ? new Date(t).toISOString() : String(ev.fecha || ev.Fecha || ""),
    estado: String(estadoDeEvento(ev) || "").slice(0, 120),
    descripcion: String(ev.descripcion || ev.Descripcion || "").replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 300),
  };
  const suc = ev.sucursal || ev.Sucursal || ev.sucursalNombre || ev.planta || ev.Planta || null;
  if (suc && typeof suc === "string") out.sucursal = suc.slice(0, 120);
  return out.estado || out.descripcion ? out : null;
}

export default async function handler(req, res) {
  { const _o=String(req.headers.origin||""); res.setHeader("Access-Control-Allow-Origin", (["https://www.growithapp.com","https://growithapp.com","https://soluna-gestion.vercel.app"].includes(_o)||_o.endsWith("-soluna1.vercel.app")||_o.startsWith("http://localhost"))?_o:"https://www.growithapp.com"); } // allowlist CORS
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── action=tracking: proxy Andreani para evitar CORS (solo lectura) ──
  // SIN auth a propósito: se llama con `fetch` plano (sin Authorization) desde
  // Reclamos y desde el poller global de Andreani. Solo reenvía a los endpoints
  // públicos de tracking de Andreani con un número que ya trae el llamador: no
  // toca Firestore ni expone datos de la cuenta. Si algún día los llamadores
  // pasan a authFetch, acá va un verifyAuth.
  if (req.query.action === 'tracking') {
    const { tracking } = req.query;
    if (!tracking) return res.status(400).json({ error: 'tracking requerido' });
    const nro = tracking.trim().replace(/\s+/g, '');
    // Modo diagnóstico: devuelve la respuesta CRUDA de la API oficial autenticada
    // (con las credenciales de la plataforma) → detrás de sesión válida, si no
    // cualquiera lo usa como oráculo del endpoint pago de Andreani.
    if (req.query.debug === '1') {
      if (!(await verifyAuth(req))) return res.status(401).json({ error: 'Sesión requerida para el modo diagnóstico' });
      return res.status(200).json(await trazasDebugAndreani(initAdmin(), nro));
    }
    // Tienda DEMO: número de envío ficticio → su traza guardada en demo_tracks
    // (la escriben _demo_ops.js y andreani.js). Nunca se consulta a Andreani.
    if (esNumeroEnvioDemo(nro)) {
      try {
        const dt = await initAdmin().collection("demo_tracks").doc(nro).get();
        if (dt.exists) {
          const x = dt.data() || {};
          return res.status(200).json({ estado: x.estado || null, estadoActual: x.estado || null, ultimoEvento: x.estado ? { estado: x.estado } : null, eventos: Array.isArray(x.eventos) ? x.eventos : [], raw: null, source: "demo" });
        }
      } catch (_) {}
    }
    // PRIMERO la API oficial autenticada (envíos de la cuenta de la plataforma:
    // datos al instante y confiables); si no lo ve (envío ajeno) → scraping.
    let out = null;
    try {
      const of = estadoOficial(await trazasOficialAndreani(initAdmin(), nro));
      if (of) out = { ...of, source: "oficial" };
    } catch (_) { /* sin creds o error: scraping */ }
    if (!out) out = await trackAndreani(nro);
    if (out) {
      console.log(`[andreani] tracking=${nro} estado="${out.estado}" via=${out.source || "scraping"}`);
      return res.status(200).json({ estado: out.estado, estadoActual: out.estado, ultimoEvento: { estado: out.estado }, eventos: out.eventos, raw: out.raw, source: out.source });
    }
    console.log(`[andreani] no se pudo obtener estado para tracking=${nro}`);
    return res.status(200).json({
      estado: null, estadoActual: null, ultimoEvento: null, eventos: [],
      error: 'No se pudo consultar el estado. Verificá el número de tracking.',
      trackingUrl: `https://www.andreani.com/envio/${nro}`,
    });
  }

  // ── action=seguir: página PÚBLICA de seguimiento (sin sesión) ──
  // GET ?numero=<tracking>. Devuelve SOLO lo que Andreani ya muestra a
  // cualquiera con el número (tracking público v3) más el nombre de la tienda
  // y la categoría/estado que el cron ya guardó. NUNCA datos del destinatario
  // (nombre, dirección, mail, teléfono) ni el uid. No escribe en Firestore ni
  // manda mails: las notificaciones siguen siendo cosa del cron.
  if (req.query.action === 'seguir') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });
    const numero = String(req.query.numero || "").trim().replace(/\s+/g, "");
    if (!/^\d{10,20}$/.test(numero)) return res.status(400).json({ error: 'Número de seguimiento inválido' });
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "?";
    if (seguirRateLimited(ip)) return res.status(429).json({ error: 'Demasiadas consultas, esperá un minuto' });
    res.setHeader("Cache-Control", "public, max-age=120");
    try {
      const db = initAdmin();
      const andreaniUrl = `https://www.andreani.com/envio/${numero}`;
      let tienda = null, guardado = null, eventos = [], estado = null;
      // Tienda DEMO: traza ficticia guardada en demo_tracks.
      if (esNumeroEnvioDemo(numero)) {
        try {
          const dt = await db.collection("demo_tracks").doc(numero).get();
          if (dt.exists) { const x = dt.data() || {}; estado = x.estado || null; eventos = (Array.isArray(x.eventos) ? x.eventos : []).map(eventoPublico).filter(Boolean); tienda = "Growith Demo"; }
        } catch (_) {}
      } else {
        // Índice server-only → cuenta dueña (solo para el nombre de la tienda)
        // y el doc del envío (categoría/estado ya calculados por el cron).
        try {
          const idx = await db.collection("andreani_idx").doc(numero).get();
          const ix = idx.exists ? (idx.data() || {}) : null;
          if (ix?.uid) {
            const [uSnap, eSnap] = await Promise.all([
              db.collection("users").doc(String(ix.uid)).get(),
              ix.envioId ? db.collection("users").doc(String(ix.uid)).collection("envios").doc(String(ix.envioId)).get() : Promise.resolve(null),
            ]);
            const u = uSnap.exists ? (uSnap.data() || {}) : {};
            tienda = String(u.businessName || u.storeName || u.nombreTienda || (u.stores || [])[0]?.storeName || (u.stores || [])[0]?.name || "").trim() || null;
            if (eSnap && eSnap.exists) { const e = eSnap.data() || {}; guardado = { categoria: e.categoria || null, estado: e.estadoAndreani || null, entregadoAt: e.entregadoAt || null }; }
          }
        } catch (err) { console.warn("[seguir] índice:", err.message); }
        // En vivo: tracking público v3 (lo mismo que ve cualquiera en andreani.com).
        const out = await trackAndreani(numero);
        if (out) { estado = out.estado; eventos = (out.eventos || []).map(eventoPublico).filter(Boolean); }
      }
      eventos.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
      if (!estado && guardado?.estado) estado = guardado.estado;
      const categoria = estado ? clasificarEstado(estado) : (guardado?.categoria || "desconocido");
      const entregado = categoria === "entregado" || !!guardado?.entregadoAt;
      return res.status(200).json({ numero, tienda, categoria, estado: estado || null, eventos, entregado, andreaniUrl });
    } catch (e) {
      console.error("[seguir]", e.message);
      return res.status(500).json({ error: 'No se pudo consultar el seguimiento' });
    }
  }

  // ── action=track_all: cron de seguimiento de TODOS los envíos activos ──
  // Cada 30 min: para los usuarios con actividad reciente en Envíos, consulta
  // el estado Andreani de sus envíos no finalizados y lo persiste en
  // users/{uid}/envios/{docId}. Las vistas leen Firestore: el tracking deja
  // de depender de que alguien tenga la pestaña abierta.
  // Solo el cron: recorre cuentas ajenas, escribe en Firestore y manda emails.
  if (req.query.action === 'track_all') {
    if (!guardCron(req, res)) return;
    try {
      const db = initAdmin();
      // Deadline global: si Andreani viene lento, cortamos antes del límite de
      // la función (60s) y lo que quedó pendiente lo agarra la próxima corrida.
      const deadline = Date.now() + 45000;
      const quedaTiempo = () => Date.now() < deadline;
      // Los envíos van primero y con muchas cuentas/pedidos se comían TODO el
      // presupuesto: los canjes de esa corrida no se revisaban nunca. Los
      // envíos ahora cortan a los 30s para que los canjes tengan sus ~15s.
      const deadlineEnvios = Date.now() + 30000;
      const quedaTiempoEnvios = () => Date.now() < deadlineEnvios;
      // AbortController global de la corrida: se pasa a los fetch de tracking
      // para que al vencer el deadline se corten los que quedaron en vuelo, en
      // vez de esperar sus 8 s de timeout. Uno por deadline (envíos / canjes).
      const abortEnvios = new AbortController(), abortCanjes = new AbortController();
      const tAbortE = setTimeout(() => abortEnvios.abort(), Math.max(0, deadlineEnvios - Date.now()));
      const tAbortC = setTimeout(() => abortCanjes.abort(), Math.max(0, deadline - Date.now()));
      res.on?.("finish", () => { clearTimeout(tAbortE); clearTimeout(tAbortC); });
      const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
      const ahora = new Date().toISOString();
      const staleCutoff = new Date(Date.now() - 25 * 60000).toISOString();

      // ── Rotación de cuentas por antigüedad del último chequeo ───────────
      // Antes: where(enviosTrackActivo > cutoff).limit(10). Con muchas cuentas
      // ese límite devuelve SIEMPRE las mismas 10 (el orden lo fija el índice)
      // y el resto no se trackea nunca. Ahora la cola se ordena por
      // `enviosTrackAt` — cuándo se revisó esa cuenta por última vez — y las que
      // hace más tiempo no se miran van primero; al procesarlas se reescribe la
      // marca y pasan al fondo. orderBy sobre UN solo campo usa el índice de
      // campo único que Firestore crea solo: NO hace falta índice compuesto.
      const CANDIDATOS   = 60; // cuentas que se miran por corrida
      const MAX_CUENTAS  = 20; // cuántas de esas se trackean de verdad
      const [rotSnap, actSnap] = await Promise.all([
        db.collection("users").orderBy("enviosTrackAt").limit(CANDIDATOS).get(),
        // Las cuentas que todavía NO tienen la marca (recién empezaron a usar
        // Envíos) no aparecen en el orderBy — sin esta segunda query nunca
        // entrarían a la rotación. Una sola desigualdad: tampoco pide índice.
        db.collection("users").where("enviosTrackActivo", ">", cutoff).limit(CANDIDATOS).get(),
      ]);
      const candidatos = [], vistos = new Set();
      for (const d of actSnap.docs) {           // primero las nuevas
        if (d.data().enviosTrackAt) continue;
        candidatos.push(d); vistos.add(d.id);
      }
      for (const d of rotSnap.docs) {           // después, por antigüedad
        if (candidatos.length >= CANDIDATOS) break;
        if (vistos.has(d.id)) continue;
        candidatos.push(d); vistos.add(d.id);
      }
      // Solo se trackean las cuentas con actividad reciente en Envíos; las
      // inactivas se marcan igual para que no tapen la cabeza de la cola.
      const activos = [], marcarUsers = [];
      for (const d of candidatos) {
        // Tiendas DEMO: envíos ficticios — ni Andreani, ni mails al comprador o
        // al dueño, ni anulaciones automáticas. Solo se corre la rotación.
        if (esDemo(d.data())) { marcarUsers.push(d.ref); continue; }
        const act = d.data().enviosTrackActivo || "";
        if (!(act > cutoff)) { marcarUsers.push(d.ref); continue; }
        if (activos.length >= MAX_CUENTAS) break;
        activos.push(d);
      }

      let revisados = 0, actualizados = 0, avisosComprador = 0, digests = 0, anulacionesAuto = [], tiendaReintentos = 0, tiendaAbandonados = 0;
      let cfgGlobal = null; try { cfgGlobal = await getGlobalConfig(db); } catch (_) { cfgGlobal = { anulacionDias: 14 }; }
      for (const uDoc of activos) {
        if (!quedaTiempoEnvios()) break;
        const ud = uDoc.data() || {};
        const cfgU = ud.enviosCfg || {};
        const tiendaNombre = String(ud.storeName || ud.nombreTienda || ud.nombre || "").trim() || "la tienda";
        // ── Cola de reintento de seguimientos a la tienda (`tiendaPendiente`):
        //    el front registra acá los que TN/Shopify no tomaron al emitir y el
        //    cron vuelve a intentar hasta 5 veces (hasta 5 envíos por corrida).
        //    Sin permiso de Shopify (shopify_scope) no tiene sentido insistir:
        //    se abandona y entra al resumen diario del dueño. ──
        let abandonadosAhora = 0;
        try {
          const tpSnap = await uDoc.ref.collection("envios").where("tiendaPendiente.intentos", "<", 5).limit(10).get();
          const cola = tpSnap.docs.filter(d => d.data().tiendaPendiente && !d.data().tiendaPendiente.abandonado).slice(0, 5);
          for (const d of cola) {
            if (!quedaTiempoEnvios()) break;
            const tp = d.data().tiendaPendiente || {};
            const intentos = (Number(tp.intentos) || 0) + 1;
            tiendaReintentos++;
            const r = await subirTrackingTienda(db, uDoc.id, ud, { orderId: String(tp.orderId || d.id), tracking: String(tp.tracking || d.data().tracking || "") });
            if (r.ok) {
              await d.ref.set({ tiendaPendiente: FieldValue.delete(), trackingTienda: { ok: true, ts: ahora, fulfilled: !!r.fulfilled, ...(r.fulfillError ? { fulfillError: String(r.fulfillError).slice(0, 200) } : {}) }, fulfillOk: true }, { merge: true });
              continue;
            }
            const abandonar = r.code === "shopify_scope" || intentos >= 5;
            await d.ref.set({ tiendaPendiente: { ...tp, intentos: abandonar ? 5 : intentos, error: String(r.error || "").slice(0, 300), code: r.code || null, ultimoTs: ahora, ...(abandonar ? { abandonado: true, abandonadoTs: ahora } : {}) } }, { merge: true });
            if (abandonar) { abandonadosAhora++; tiendaAbandonados++; }
            // Rate limit de TN: no seguir martillando en esta corrida.
            if (r.code === "tn_rate_limit") break;
          }
        } catch (err) { console.error("[track_all tiendaPendiente]", err.message); }
        // Envíos activos con tracking, no finalizados, sin chequear hace 25+ min.
        // Sin orderBy (necesitaría índice compuesto): se traen hasta 300 activos y
        // la rotación por lastCheck se hace en memoria — con limit(60) los
        // números de pedido más altos no entraban nunca.
        const envSnap = await uDoc.ref.collection("envios").where("activo", "==", true).limit(300).get();
        const pendientes = envSnap.docs
          // Con tracking (scraping) o emitidos por nuestra API oficial
          // (andreani.numeroDeEnvio) — estos últimos se trackean por API.
          .filter(d => { const e = d.data(); return (e.tracking || e.andreani?.numeroDeEnvio) && (!e.lastCheck || e.lastCheck < staleCutoff); })
          // Rotación también dentro de la cuenta: primero los que hace más
          // tiempo no se miran (antes el orden lo daba Firestore y con 60
          // envíos activos los últimos no se revisaban nunca).
          .sort((a, b) => String(a.data().lastCheck || "").localeCompare(String(b.data().lastCheck || "")))
          .slice(0, 30);
        for (let i = 0; i < pendientes.length; i += 5) {
          if (!quedaTiempoEnvios()) break;
          await Promise.all(pendientes.slice(i, i + 5).map(async d => {
            // Deadline también dentro de la tanda: si ya venció no se arranca
            // otro fetch (el que está en vuelo lo corta el AbortController).
            if (!quedaTiempoEnvios()) return;
            const e = d.data();
            revisados++;
            // Emitidos por nuestra API: PRIMERO la API oficial de trazas
            // (garantizado visible con las credenciales de la plataforma).
            // Si devuelve null o sin trazas → fallback al scraping de siempre.
            const numOficial = e.andreani?.numeroDeEnvio || null;
            let out = null, via = "scraping";
            if (numOficial) {
              const trazas = await trazasOficialAndreani(db, numOficial);
              const of = estadoOficial(trazas);
              if (of) { out = of; via = "oficial"; }
            }
            if (!out && quedaTiempoEnvios()) out = await trackAndreani(e.tracking || numOficial, abortEnvios.signal);
            if (!out) { await d.ref.set({ lastCheck: ahora }, { merge: true }); return; }
            const cat = clasificarEstado(out.estado);
            const upd = { lastCheck: ahora, estadoAndreani: out.estado, categoria: cat, trackVia: via };
            if (out.estado !== e.estadoAndreani) upd.estadoDesde = ahora; // cambió: resetea el reloj de "demorado"
            if (cat === "en_sucursal" && e.categoria !== "en_sucursal") upd.enSucursalDesde = ahora;
            if (cat === "entregado") { upd.activo = false; upd.entregadoAt = ahora; }
            if (cat === "devolucion") { upd.activo = false; upd.devolucionAt = ahora; }
            // Aviso al COMPRADOR (mail) cuando el paquete llega a sucursal, falla
            // una visita o se entrega: una sola vez por categoría
            // (`avisosComprador[cat]` = ts, que se marca SOLO si el mail salió).
            // Si Resend falló, `avisosCompradorFallo[cat]` cuenta los intentos y
            // se reintenta en las próximas corridas, hasta 3 veces.
            const emailComprador = String(e.destinatario?.email || "").trim();
            const fallos = (e.avisosCompradorFallo || {})[cat];
            if (["en_sucursal", "visita_fallida", "entregado"].includes(cat) && emailComprador && cfgU.avisosComprador !== false
                && !(e.avisosComprador || {})[cat] && (Number(fallos?.intentos) || 0) < 3) {
              const trk = numOficial || e.tracking;
              const link = `https://www.andreani.com/envio/${esc(trk)}`;
              const nroPedido = String(e.numero || d.id);
              const pie = `<div style="margin:14px 0;padding:10px 14px;background:#f0fdf4;border-radius:8px;border-left:3px solid #22c55e;font-size:13px">Seguimiento: <strong>${esc(trk)}</strong><br/><a href="${link}" style="color:#6366f1">Ver el estado en Andreani</a></div>
  <p style="font-size:12px;color:#6b7280">Este aviso lo envía Growith en nombre de ${esc(tiendaNombre)}.</p>`;
              let asunto, html;
              if (cat === "entregado") {
                asunto = `Tu pedido #${nroPedido} fue entregado`;
                html = mailShell(`Tu pedido #${nroPedido} fue entregado`, `Pedido de ${tiendaNombre}`,
                  `<p style="font-size:14px">Andreani informa: <strong>${esc(out.estado)}</strong></p>
  <p style="font-size:14px">Gracias por tu compra en ${esc(tiendaNombre)}. Si algo no llegó como esperabas, respondé este mail o escribile a la tienda.</p>
  ${pie}`);
              } else {
                const esSuc = cat === "en_sucursal";
                asunto = esSuc ? `Tu pedido de ${tiendaNombre} te espera en la sucursal de Andreani` : `No pudimos entregar tu pedido de ${tiendaNombre}`;
                html = mailShell(esSuc ? "Tu paquete está en sucursal" : "Visita fallida", `Pedido de ${tiendaNombre}`,
                  `<p style="font-size:14px">Andreani informa: <strong>${esc(out.estado)}</strong></p>
  <p style="font-size:14px">${esSuc
    ? "Ya podés pasar a retirarlo con tu DNI. Los envíos a sucursal tienen unos días de plazo antes de volver al remitente, así que no lo dejes pasar."
    : "El repartidor no encontró a nadie en el domicilio. Andreani suele hacer una segunda visita en los próximos días; si tampoco pueden entregarlo, el paquete queda en la sucursal más cercana para que lo retires."}</p>
  ${pie}`);
              }
              const ok = await mailEnvios(emailComprador, asunto, html);
              if (ok) { upd.avisosComprador = { ...(e.avisosComprador || {}), [cat]: ahora }; avisosComprador++; }
              else upd.avisosCompradorFallo = { ...(e.avisosCompradorFallo || {}), [cat]: { ts: ahora, intentos: (Number(fallos?.intentos) || 0) + 1 } };
            }
            await d.ref.set(upd, { merge: true });
            actualizados++;
          }));
        }
        // ── Por cuenta: problemas del día (badge + resumen al dueño) y
        //    anulación automática de etiquetas nunca ingresadas ──
        try {
          const ahoraMs = Date.now();
          const docsAct = envSnap.docs.map(d => ({ id: d.id, ref: d.ref, e: d.data() }));
          const problemas = docsAct.map(x => ({ ...x, p: problemaEnvio(x.e, ahoraMs, cfgU) })).filter(x => x.p);
          const updU = { enviosProblemasN: problemas.length, enviosProblemasAt: ahora };
          const ultimo = Date.parse(ud.enviosDigestAt || "") || 0;
          // Seguimientos que el cron dejó de reintentar contra la tienda (entre
          // los activos cargados + los abandonados en esta corrida).
          const abandonados = Math.max(docsAct.filter(x => x.e.tiendaPendiente?.abandonado).length, abandonadosAhora);
          if ((problemas.length || abandonados) && cfgU.avisosDueno !== false && ud.email && ahoraMs - ultimo > 20 * 3600000) {
            const filas = problemas.sort((a, b) => (a.p.sev === "red" ? 0 : 1) - (b.p.sev === "red" ? 0 : 1)).slice(0, 15).map(x => {
              const trk = x.e.andreani?.numeroDeEnvio || x.e.tracking || "";
              return `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px"><strong>#${esc(x.e.numero || x.id)}</strong>${x.e.cliente ? " · " + esc(x.e.cliente) : ""}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;color:${x.p.sev === "red" ? "#dc2626" : "#d97706"}">${esc(x.p.msg)}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px">${trk ? `<a href="https://www.andreani.com/envio/${esc(trk)}" style="color:#6366f1">${esc(trk)}</a>` : ""}</td></tr>`;
            }).join("");
            const asuntoDig = problemas.length
              ? `${problemas.length} envío${problemas.length === 1 ? "" : "s"} con problema en ${tiendaNombre}`
              : `${abandonados} seguimiento${abandonados === 1 ? "" : "s"} sin subir a la tienda en ${tiendaNombre}`;
            const ok = await mailEnvios(String(ud.email).trim(), asuntoDig,
              mailShell("Envíos que requieren atención", `${problemas.length + abandonados} en total`,
                `${filas ? `<table style="width:100%;border-collapse:collapse">${filas}</table>` : ""}
  ${problemas.length > 15 ? `<p style="font-size:12px;color:#6b7280">y ${problemas.length - 15} más.</p>` : ""}
  ${abandonados ? `<p style="font-size:13px;margin-top:12px;color:#dc2626"><strong>${abandonados} seguimiento${abandonados === 1 ? "" : "s"} no se pudieron subir a la tienda</strong> (Tienda Nube / Shopify no tomó el tracking tras varios intentos). Abrí Envíos &rarr; Seguimientos y subilos a mano, o reconectá la tienda si Shopify pide permiso.</p>` : ""}
  <p style="font-size:13px;margin-top:14px">Abrí Envíos &rarr; Seguimientos: cada envío tiene su ficha con el historial completo y el botón para pedir una gestión a Andreani. Este resumen llega como máximo una vez por día; se desactiva desde el engranaje de Seguimientos.</p>`));
            if (ok) { updU.enviosDigestAt = ahora; digests++; }
          }
          // Anulación automática: etiqueta emitida hace N días que nunca
          // ingresó → caso interno (origen sistema) para pedir el reintegro a
          // Andreani. Al cliente no se le avisa (decisión de negocio).
          const nDias = Number(cfgGlobal?.anulacionDias) || 14;
          for (const x of docsAct) {
            const e = x.e;
            if (!e.andreani?.numeroDeEnvio || e.andreani?.anulacionAutoTs || !envioSinIngreso(e)) continue;
            const tsEm = e.andreani.ts?.toDate ? e.andreani.ts.toDate().getTime() : Date.parse(e.creado || "");
            if (!isFinite(tsEm) || ahoraMs - tsEm < nDias * 86400000) continue;
            try {
              const dias = Math.floor((ahoraMs - tsEm) / 86400000);
              const casoRef = await db.collection("envios_casos").add({
                uid: uDoc.id, email: String(ud.email || ""), tienda: tiendaNombre === "la tienda" ? "" : tiendaNombre,
                numero: String(e.numero || x.id), numeroDeEnvio: e.andreani.numeroDeEnvio, tracking: e.andreani.numeroDeEnvio, cliente: e.cliente || "",
                localidad: [e.localidad, e.provincia].filter(Boolean).join(", "), esSucursal: !!e.esSucursal,
                motivo: "anulacion", descripcion: `Etiqueta emitida hace ${dias} días sin ingreso a Andreani: pedir anulación y reintegro a Andreani (regla automática de ${nDias} días).`,
                nuevaDireccion: "", fotos: [], estado: "abierto", origen: "sistema", precio: Number(e.andreani.precio) || 0, reintegrado: false, nuevoCliente: false,
                historial: [{ at: ahora, por: "sistema", texto: `Abierto automáticamente: ${dias} días sin ingreso.` }],
                ts: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
              });
              await x.ref.set({ andreani: { anulacionAutoTs: ahora, casoAutoId: casoRef.id } }, { merge: true });
              anulacionesAuto.push({ cuenta: ud.email || uDoc.id, numero: e.numero || x.id, numeroDeEnvio: e.andreani.numeroDeEnvio, precio: Number(e.andreani.precio) || 0, dias });
            } catch (err) { console.error("[track_all anulacion auto]", err.message); }
          }
          await uDoc.ref.set(updU, { merge: true });
        } catch (err) { console.error("[track_all cuenta]", err.message); }
        // ── Anulaciones inmediatas: el saldo se devolvió al instante confiando
        //    en que la etiqueta no se usa. Si igual ingresó a Andreani, aviso al
        //    fundador para debitar a mano (Admin > Saldos). Se chequea a partir
        //    de las 2 h y hasta 3 días después de anulada. ──
        try {
          const anSnap = await uDoc.ref.collection("envios").where("andreani.anulacionInmediata", "==", true).limit(20).get();
          const ahoraMs2 = Date.now();
          for (const d of anSnap.docs) {
            if (!quedaTiempoEnvios()) break;
            const e = d.data();
            if (e.andreani?.anuladaChequeadaTs || e.andreani?.anuladaIngresoTs || !e.andreani?.numeroDeEnvio) continue;
            const tsA = Date.parse(e.andreani?.anuladaAt || "") || 0;
            if (!tsA || ahoraMs2 - tsA < 2 * 3600000) continue;
            const of = estadoOficial(await trazasOficialAndreani(db, e.andreani.numeroDeEnvio));
            const cat = of ? clasificarEstado(of.estado) : null;
            if (cat && ["en_camino", "en_sucursal", "entregado", "devolucion", "visita_fallida"].includes(cat)) {
              await d.ref.set({ andreani: { anuladaIngresoTs: ahora, anuladaIngresoEstado: of.estado } }, { merge: true });
              try {
                const fSnap = await db.collection("users").doc("WJH3ArqDPQcNLha9lOinvkVi9uJ2").get();
                const to = process.env.ALERT_EMAIL || fSnap.data()?.email;
                if (to) await mailEnvios(to, `Etiqueta anulada que igual ingresó — ${e.andreani.numeroDeEnvio}`,
                  mailShell("Anulación inmediata usada", `${ud.email || uDoc.id}`, `<p style="font-size:14px">La cuenta <strong>${esc(ud.email || uDoc.id)}</strong> anuló la etiqueta <strong>${esc(e.andreani.numeroDeEnvio)}</strong> (pedido #${esc(e.numero || d.id)}) con reintegro automático de $${(Number(e.andreani.precio) || 0).toLocaleString("es-AR")}, pero Andreani registra: <strong>${esc(of.estado)}</strong>. Debitá el importe desde Admin › Logística › Saldos.</p>`));
              } catch (_) {}
            } else if (ahoraMs2 - tsA > 3 * 86400000) {
              await d.ref.set({ andreani: { anuladaChequeadaTs: ahora } }, { merge: true });
            }
          }
        } catch (err) { console.error("[track_all anuladas]", err.message); }
        marcarUsers.push(uDoc.ref);
      }
      // Resumen al founder de las anulaciones automáticas abiertas en esta corrida.
      if (anulacionesAuto.length) {
        try { await mailEjecutiva(db, cfgGlobal, anulacionesAuto.map(x => ({ tienda: x.cuenta, numeroDeEnvio: x.numeroDeEnvio, motivo: "anulacion" })), `${anulacionesAuto.length} etiqueta${anulacionesAuto.length === 1 ? "" : "s"} sin usar: pedido de anulación y reintegro`); } catch (_) {}
        try {
          const to = String(cfgGlobal?.emailGestiones || "contacto.growith@gmail.com").trim();
          const total = anulacionesAuto.reduce((a, x) => a + x.precio, 0);
          if (to) await mailEnvios(to, `${anulacionesAuto.length} etiqueta${anulacionesAuto.length === 1 ? "" : "s"} sin usar para pedir reintegro a Andreani`,
            mailShell("Anulaciones automáticas", `$${total.toLocaleString("es-AR")} cobrados a clientes en etiquetas nunca despachadas`,
              `<table style="width:100%;border-collapse:collapse">${anulacionesAuto.map(x => `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px">${esc(x.cuenta)}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px">#${esc(x.numero)} · ${esc(x.numeroDeEnvio)}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;text-align:right">${x.dias} d · $${x.precio.toLocaleString("es-AR")}</td></tr>`).join("")}</table>
  <p style="font-size:13px;margin-top:14px">Los casos están en Admin &rarr; Logística &rarr; Operación &rarr; Gestiones: con un clic armás el WhatsApp para la ejecutiva de Andreani.</p>`));
        } catch (_) {}
      }
      // Marca de rotación de las cuentas consumidas (best-effort: si falla, la
      // próxima corrida vuelve a agarrar las mismas — no se pierde nada).
      try {
        const wb = db.batch();
        for (const ref of marcarUsers.slice(0, 450)) wb.set(ref, { enviosTrackAt: ahora }, { merge: true });
        if (marcarUsers.length) await wb.commit();
      } catch (e) { console.error("[track_all] marca de rotación:", e.message); }

      // ── Canjes con tracking activo (colección top-level "canjes") ──
      // trackDone=false lo setea el frontend al cargar o cambiar un tracking.
      // Acá se persiste el estado en el doc del canje y, cuando el paquete llega
      // a sucursal / se entrega / vuelve, se deja un aviso in-app (trackingAviso)
      // y se manda email al dueño.
      let canjesRevisados = 0, canjesActualizados = 0;
      try {
        // Rotación de canjes: mismo problema que con las cuentas — un limit(60)
        // fijo sobre la colección global devuelve siempre los mismos y, con
        // muchos tenants, la mayoría no se trackea nunca. Se ordena por
        // `trackingLastCheck` ascendente dentro de los que siguen abiertos.
        // ÍNDICE COMPUESTO NECESARIO en Firestore:
        //   colección `canjes` → trackDone ASC, trackingLastCheck ASC
        const CAND_CANJES = 60;
        // La query con orderBy necesita el índice compuesto (trackDone ASC +
        // trackingLastCheck ASC). Si falta o falla, NO puede tumbar el bloque
        // entero: se sigue con la query simple y se rota ordenando en memoria.
        const [rotC, nuevosC] = await Promise.all([
          db.collection("canjes").where("trackDone", "==", false).orderBy("trackingLastCheck").limit(CAND_CANJES).get()
            .catch(e => { console.error("[track_all canjes] query orderBy falló (¿falta el índice?):", e.message); return null; }),
          // Los canjes que nunca se chequearon no tienen el campo y quedan
          // fuera del orderBy: entran por acá, y primero (son los más nuevos).
          db.collection("canjes").where("trackDone", "==", false).limit(200).get(),
        ]);
        const candC = [], vistosC = new Set();
        for (const d of nuevosC.docs) {
          if (d.data().trackingLastCheck) continue;
          if (candC.length >= CAND_CANJES) break;
          candC.push(d); vistosC.add(d.id);
        }
        const rotDocs = rotC ? rotC.docs
          // Fallback sin índice: los mismos docs de la query simple, ordenados
          // en memoria por último chequeo (los más olvidados primero).
          : nuevosC.docs.slice().sort((a, b) => String(a.data().trackingLastCheck || "").localeCompare(String(b.data().trackingLastCheck || "")));
        for (const d of rotDocs) {
          if (candC.length >= CAND_CANJES) break;
          if (vistosC.has(d.id)) continue;
          candC.push(d); vistosC.add(d.id);
        }
        // Tiendas DEMO: sus canjes son ficticios — no se consulta Andreani ni se
        // manda mail; se les corre el reloj para que no ocupen la cola.
        const ownerDemo = new Map();
        const cargarOwners = async (ids) => {
          const faltan = [...new Set(ids.filter(x => x && !ownerDemo.has(String(x))).map(String))];
          for (let i = 0; i < faltan.length; i += 100) {
            const snaps = await db.getAll(...faltan.slice(i, i + 100).map(x => db.collection("users").doc(x)));
            snaps.forEach(s => ownerDemo.set(s.id, esDemo(s.data())));
          }
        };
        await cargarOwners(candC.map(d => d.data().ownerId));
        const canjesDemo = candC.filter(d => ownerDemo.get(String(d.data().ownerId || "")) && d.data().tracking);
        if (canjesDemo.length) {
          const wb = db.batch();
          canjesDemo.forEach(d => wb.set(d.ref, { trackingLastCheck: ahora }, { merge: true }));
          try { await wb.commit(); } catch (_) {}
        }
        const pendCanjes = candC.filter(d => {
          const c = d.data();
          if (ownerDemo.get(String(c.ownerId || ""))) return false;
          // Multi-tenant: `ownerId` es la cuenta dueña del canje. El front lista
          // canjes con where("ownerId","==",uid), así que un canje sin ownerId
          // no le pertenece a nadie: no hay a quién avisarle y no debe tocarse
          // (ni aparecer) desde otra cuenta. Se saltea.
          if (!c.ownerId) return false;
          return c.tracking && String(c.tracking).trim() && (!c.trackingLastCheck || c.trackingLastCheck < staleCutoff);
        }).slice(0, 30);
        const emailCache = {};
        const NOTABLES = {
          en_sucursal:    { titulo: "Listo para retirar en sucursal", asunto: inf => `El canje de ${inf} está en sucursal para retirar` },
          entregado:      { titulo: "Paquete entregado",              asunto: inf => `El canje de ${inf} fue entregado` },
          devolucion:     { titulo: "Devolución en camino",           asunto: inf => `El envío del canje de ${inf} está volviendo` },
          visita_fallida: { titulo: "Visita fallida",                 asunto: inf => `Visita fallida en el canje de ${inf}` },
        };
        for (let i = 0; i < pendCanjes.length; i += 5) {
          if (!quedaTiempo()) break;
          await Promise.all(pendCanjes.slice(i, i + 5).map(async d => {
            const c = d.data();
            canjesRevisados++;
            // Igual que los envíos: PRIMERO la API oficial (los canjes salen de
            // la cuenta Andreani de la plataforma), fallback al scraping.
            let out = null, via = "scraping";
            const ofC = estadoOficial(await trazasOficialAndreani(db, String(c.tracking).trim()));
            if (ofC) { out = ofC; via = "oficial"; }
            if (!out && quedaTiempo()) out = await trackAndreani(c.tracking, abortCanjes.signal);
            if (!out) { await d.ref.set({ trackingLastCheck: ahora }, { merge: true }); return; }
            const cat = clasificarEstado(out.estado);
            const upd = { trackingLastCheck: ahora, trackingEstado: out.estado, trackingCat: cat, trackVia: via };
            if (cat === "entregado") {
              upd.trackDone = true; upd.trackEntregadoAt = ahora;
              // Deja el campo en null (no ausente) para que el recordatorio de
              // contenido pueda buscarlo por índice en vez de barrer la colección.
              if (c.contentReminderAt === undefined) upd.contentReminderAt = null;
              // Auto-avance del pipeline: al confirmarse la entrega, el canje pasa
              // solo a "Contenido pendiente" y arranca el reloj del contenido.
              if (["Por enviar", "Pendiente envío", "Enviado"].includes(c.estado)) upd.estado = "Contenido pendiente";
            }
            if (cat === "devolucion") upd.trackDone = true;
            if (cat !== c.trackingCat && NOTABLES[cat]) {
              upd.trackingAviso = { cat, estado: out.estado, at: ahora, visto: false };
              try {
                const ownerId = c.ownerId;
                if (ownerId && process.env.RESEND_API_KEY) {
                  if (!(ownerId in emailCache)) {
                    const uSnap = await db.collection("users").doc(ownerId).get();
                    emailCache[ownerId] = uSnap.data()?.email || null;
                  }
                  const to = emailCache[ownerId];
                  if (to) {
                    const n = NOTABLES[cat];
                    const inf = c.influencer || "influencer";
                    const nro = String(c.tracking).trim();
                    // mailEnvios/mailShell: mismo shell que Envíos, texto de
                    // usuario (influencer, estado, tracking) escapado con esc().
                    await mailEnvios(to, n.asunto(inf), mailShell(n.titulo, `Canje de ${inf}`,
                      `<p style="font-size:14px">Andreani informa: <strong>${esc(out.estado)}</strong></p>
  <div style="margin:12px 0;padding:10px 14px;background:#f0fdf4;border-radius:8px;border-left:3px solid #22c55e;font-size:13px">Tracking: <strong>${esc(nro)}</strong><br/><a href="https://www.andreani.com/envio/${encodeURIComponent(nro)}" style="color:#6366f1;font-size:12px">Ver seguimiento</a></div>
  ${cat === "en_sucursal" ? '<p style="font-size:13px">Avisale que ya puede pasar a retirarlo: los envíos a sucursal tienen unos días de plazo antes de volver.</p>' : ""}`));
                  }
                }
              } catch (e) { console.error("[track_all canje] email:", e.message); }
            }
            // El aviso in-app puede haber quedado desactualizado (ej: una
            // clasificación vieja lo marcó "en sucursal" y el envío en
            // realidad seguía en camino) — se compara contra el cat GUARDADO
            // EN EL AVISO, no contra trackingCat, para autocorregirse incluso
            // si trackingCat ya había avanzado sin limpiar el aviso.
            if (!upd.trackingAviso && c.trackingAviso && !c.trackingAviso.visto && c.trackingAviso.cat !== cat) {
              upd.trackingAviso = null;
            }
            await d.ref.set(upd, { merge: true });
            canjesActualizados++;
          }));
        }

        // ── Recordatorio de contenido: 5 días después de la entrega, si el
        // influencer todavía no completó el contenido acordado, un email al
        // dueño para que le escriba. Se manda UNA sola vez (contentReminderAt).
        const cutoffRem = new Date(Date.now() - 5 * 86400000).toISOString();
        // Candidatos = canjes en "Contenido pendiente" a los que todavía NO se
        // les mandó el recordatorio. Antes se traían los primeros 100 de la
        // colección global: los ya recordados (contentReminderAt seteado) se
        // quedaban para siempre ocupando la cabeza y, con muchos tenants, los
        // canjes nuevos no entraban nunca.
        // ÍNDICE COMPUESTO NECESARIO en Firestore:
        //   colección `canjes` → estado ASC, contentReminderAt ASC
        const CAND_REM = 60;
        const remDocs = [];
        try {
          const rs = await db.collection("canjes")
            .where("estado", "==", "Contenido pendiente")
            .where("contentReminderAt", "==", null)
            .limit(CAND_REM).get();
          remDocs.push(...rs.docs);
        } catch (e) { console.error("[canje-reminder] query indexada:", e.message); }
        if (remDocs.length < CAND_REM) {
          // Bootstrap / canjes viejos: los que no tienen el campo no matchean el
          // "== null". Se los completa acá y se les deja el campo en null para
          // que a partir de la próxima corrida entren por el índice.
          const vistos = new Set(remDocs.map(d => d.id));
          const legacy = await db.collection("canjes").where("estado", "==", "Contenido pendiente").limit(CAND_REM).get();
          const wb = db.batch(); let nSemilla = 0;
          for (const d of legacy.docs) {
            if (vistos.has(d.id) || d.data().contentReminderAt !== undefined) continue;
            wb.set(d.ref, { contentReminderAt: null }, { merge: true });
            nSemilla++;
            if (remDocs.length < CAND_REM) remDocs.push(d);
          }
          if (nSemilla) { try { await wb.commit(); } catch (_) {} }
        }
        // A quiénes hay que avisarles de verdad.
        const aRecordar = [];
        await cargarOwners(remDocs.map(d => d.data().ownerId));
        const remDemo = [];
        for (const d of remDocs) {
          const c = d.data();
          // Sin ownerId el canje no pertenece a ninguna cuenta: no hay destinatario.
          if (!c.ownerId) continue;
          // Tienda DEMO: sin recordatorio; se marca para que no vuelva a la cola.
          if (ownerDemo.get(String(c.ownerId))) { remDemo.push(d); continue; }
          if (!c.trackEntregadoAt || c.trackEntregadoAt > cutoffRem || c.contentReminderAt) continue;
          // Canjes v2: la verdad son las `piezas` (una por pieza de contenido,
          // estado pendiente|entregada|publicada). Los contadores `contenido[]`
          // quedan como fallback para canjes viejos sin piezas.
          const piezas = Array.isArray(c.piezas) && c.piezas.length ? c.piezas : null;
          const cont = Array.isArray(c.contenido) ? c.contenido : [];
          const acordados = piezas ? piezas.length : cont.reduce((s, x) => s + (Number(x?.acordados) || 0), 0);
          const entregados = piezas ? piezas.filter(p => ["entregada", "publicada"].includes(String(p?.estado || ""))).length : cont.reduce((s, x) => s + (Number(x?.entregados) || 0), 0);
          if (acordados > 0 && entregados >= acordados) continue;
          aRecordar.push({ d, c, acordados, entregados });
        }
        if (remDemo.length) {
          const wb = db.batch();
          remDemo.forEach(d => wb.set(d.ref, { contentReminderAt: ahora }, { merge: true }));
          try { await wb.commit(); } catch (_) {}
        }
        // Envío en lotes concurrentes de 5 (no uno por uno): con muchas cuentas
        // un `for` secuencial se comía el presupuesto de la función, y disparar
        // todos de golpe rompe el rate limit de Resend. allSettled = un email
        // fallado no tumba el resto.
        for (let i = 0; i < aRecordar.length; i += 5) {
          if (!quedaTiempo()) break;
          await Promise.allSettled(aRecordar.slice(i, i + 5).map(async ({ d, c, acordados, entregados }) => {
            await d.ref.set({ contentReminderAt: ahora }, { merge: true });
            if (!c.ownerId || !process.env.RESEND_API_KEY) return;
            if (!(c.ownerId in emailCache)) {
              const uSnap = await db.collection("users").doc(c.ownerId).get();
              emailCache[c.ownerId] = uSnap.data()?.email || null;
            }
            const to = emailCache[c.ownerId];
            if (!to) return;
            const inf = c.influencer || "influencer";
            const dias = Math.round((Date.now() - new Date(c.trackEntregadoAt).getTime()) / 86400000);
            // mailEnvios/mailShell (antes fetch inline a Resend sin escapar).
            await mailEnvios(to, `${inf} debe contenido — entregado hace ${dias} días`, mailShell("Contenido pendiente", `Canje de ${inf}`,
              `<p style="font-size:14px">El paquete de <strong>${esc(inf)}</strong> se entregó hace <strong>${dias} días</strong> y todavía ${acordados > 0 ? `va ${entregados} de ${acordados} piezas de contenido acordadas` : "no marcaste contenido entregado"}.</p>
  <p style="font-size:13px">Buen momento para escribirle y preguntarle cómo viene.</p>`));
          })).then(rs => rs.forEach(r => { if (r.status === "rejected") console.error("[canje-reminder]:", r.reason?.message || r.reason); }));
        }
      } catch (e) { console.error("[track_all canjes]:", e.message); }
      clearTimeout(tAbortE); clearTimeout(tAbortC);
      return res.json({ ok: true, usuarios: activos.length, revisados, actualizados, avisosComprador, digests, anulacionesAuto: anulacionesAuto.length, tiendaReintentos, tiendaAbandonados, canjesRevisados, canjesActualizados });
    } catch (e) {
      console.error("track_all error:", e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Todo lo que sigue opera sobre los datos de UNA cuenta (historial de
  // envíos en Firestore, credenciales de Tienda Nube, fulfillment de pedidos):
  // exige token válido Y atado al uid pedido. Antes alcanzaba con estar
  // logueado con cualquier cuenta y mandar el uid ajeno por query.
  const { uid, orderId, tracking } = req.query;
  if (!uid) return res.status(401).json({ error: "uid requerido" });
  // Miembros de equipo: el refresco de canjes es sección "canjes", el resto "envios".
  if (!(await guardUid(req, res, uid, req.query.action === 'canjes_refresh' ? 'canjes' : 'envios'))) return;

  // ── Historial de envíos en Firestore (vía Admin SDK — no depende de las
  // reglas de seguridad del cliente, que no cubren subcolecciones nuevas) ──
  if (req.query.action === 'envios_list') {
    try {
      const db = initAdmin();
      // Marca de actividad para el cron de tracking. Las tiendas DEMO no entran
      // al cron (sus envíos son ficticios): sin marca.
      const uSnapL = await db.collection("users").doc(uid).get();
      const udL = uSnapL.data() || {};
      const ahoraL = new Date().toISOString();
      // El "heal" de abajo corre como máximo una vez por hora por cuenta
      // (users/{uid}.enviosHealTs), no en cada refresco de la pestaña.
      const healDue = !esDemo(udL) && (Date.now() - (Date.parse(udL.enviosHealTs || "") || 0) > 3600000);
      if (!esDemo(udL)) await db.collection("users").doc(uid).set({ enviosTrackActivo: ahoraL, ...(healDue ? { enviosHealTs: ahoraL } : {}) }, { merge: true });
      const cutoff = new Date(Date.now() - 60 * 86400000).toISOString();
      const col = db.collection("users").doc(uid).collection("envios");
      const snap = await col.where("creado", ">", cutoff).get();
      const envios = {};
      snap.forEach(d => { envios[d.id] = d.data(); });
      // Emitidos por la API de Andreani que nunca entraron al seguimiento:
      // sin `creado` no salían en el listado y sin `activo` el cron no los
      // miraba. Se activan acá, del lado del servidor, para que aparezcan en
      // Seguimientos aunque el cliente no vuelva a emitir nada. El tracking a
      // la tienda (fulfill + mail) lo completa el front (activarSeguimientoApi).
      if (healDue) try {
        const orf = await col.where("andreani.numeroDeEnvio", ">", "").get();
        const b = db.batch(); let n = 0;
        orf.forEach(d => {
          const e = d.data();
          if (e.activo === true || e.entregadoAt || e.devolucionAt || e.tracking) return;
          const numero = String(e.andreani.numeroDeEnvio);
          const patch = { numero: d.id, tracking: numero, activo: true, estado: "despachado", despachadoAt: e.despachadoAt || ahoraL, creado: e.creado || ahoraL, apiHeal: true };
          b.set(d.ref, patch, { merge: true }); envios[d.id] = { ...e, ...patch }; n++;
        });
        if (n) { await b.commit(); console.log(`[envios_list] ${n} envío(s) API activados para seguimiento (uid ${uid})`); }
      } catch (e) { console.warn("[envios_list] heal API:", e.message); }
      return res.json({ envios });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  if (req.query.action === 'envios_registrar' && req.method === 'POST') {
    try {
      const body = await new Promise(resolve => { let d = ""; req.on("data", c => d += c); req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch (_) { resolve({}); } }); });
      const items = Array.isArray(body.envios) ? body.envios.slice(0, 400) : [];
      const db = initAdmin();
      const ahora = new Date().toISOString();
      const colR = db.collection("users").doc(uid).collection("envios");
      for (let i = 0; i < items.length; i += 20) {
        const lote = items.slice(i, i + 20).filter(e => String(e?.numero || "").trim());
        if (!lote.length) continue;
        // Una lectura por lote (getAll) para NO pisar `creado` en los docs que
        // ya existen: antes cada re-registro lo movía a "ahora" y el historial
        // de 60 días se estiraba solo.
        const existentes = new Map();
        try {
          const snaps = await db.getAll(...lote.map(e => colR.doc(String(e.numero).trim())));
          snaps.forEach(s => { if (s.exists) existentes.set(s.id, s.data() || {}); });
        } catch (err) { console.warn("[envios_registrar] getAll:", err.message); }
        await Promise.all(lote.map(e => {
          const numero = String(e.numero || "").trim();
          const docData = {};
          for (const k of ["tnId","cliente","esSucursal","provincia","localidad","total","skus","estado","activo","tracking","fulfillOk","verificado","tnDone"]) {
            if (e[k] !== undefined) docData[k] = e[k];
          }
          // Productos con cantidad (para "SKU en la etiqueta" al reimprimir desde Seguimientos).
          if (Array.isArray(e.productos)) docData.productos = e.productos.slice(0, 40).map(p => ({ sku: String(p?.sku || "").slice(0, 60), nombre: String(p?.nombre || "").slice(0, 80), cantidad: Number(p?.cantidad) || 1 }));
          if (e.destinatario && typeof e.destinatario === "object") {
            docData.destinatario = { nombre: String(e.destinatario.nombre || "").slice(0, 120), email: String(e.destinatario.email || "").trim().slice(0, 160), telefono: String(e.destinatario.telefono || "").slice(0, 25) };
          }
          // Cola de reintento a la tienda (el cron track_all la procesa):
          // {orderId, tracking, error} → se guarda con intentos:0. `null` la borra
          // (ej: el usuario lo subió a mano).
          if (e.tiendaPendiente === null) docData.tiendaPendiente = FieldValue.delete();
          else if (e.tiendaPendiente && typeof e.tiendaPendiente === "object") {
            docData.tiendaPendiente = { orderId: String(e.tiendaPendiente.orderId || numero).slice(0, 40), tracking: String(e.tiendaPendiente.tracking || e.tracking || "").trim().slice(0, 40), error: String(e.tiendaPendiente.error || "").slice(0, 300), intentos: 0, ts: ahora };
          }
          docData.numero = numero;
          if (e.estado === "despachado") docData.despachadoAt = ahora;
          if (e.verificado) docData.verificadoAt = ahora;
          const prev = existentes.get(numero);
          docData.creado = prev?.creado || ahora;
          return colR.doc(numero).set(docData, { merge: true });
        }));
      }
      return res.json({ ok: true, guardados: items.length });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── action=canjes_refresh: refresco EN VIVO del tracking de canjes al abrir
  // la sección — misma vía que el cron (API oficial → scraping) sin esperar
  // los 30 min. El onSnapshot del front pinta el cambio al instante.
  if (req.query.action === 'canjes_refresh' && req.method === 'POST') {
    try {
      const body = await new Promise(resolve => { let d = ""; req.on("data", c => d += c); req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch (_) { resolve({}); } }); });
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 15).map(String) : [];
      if (!ids.length) return res.json({ ok: true, actualizados: 0 });
      const db = initAdmin();
      // Tienda DEMO: canjes ficticios, no se consulta Andreani.
      if (esDemo((await db.collection("users").doc(uid).get()).data())) return res.json({ ok: true, actualizados: 0 });
      const ahora = new Date().toISOString();
      let actualizados = 0;
      for (let i = 0; i < ids.length; i += 3) {
        await Promise.all(ids.slice(i, i + 3).map(async id => {
          try {
            const ref = db.collection("canjes").doc(id);
            const snap = await ref.get();
            if (!snap.exists) return;
            const c = snap.data();
            if (c.ownerId !== uid) return;
            // trackDone===true = ya finalizado; undefined (canje viejo sin
            // backfill) SÍ se trackea, era el caso que quedaba afuera.
            if (!c.tracking || !String(c.tracking).trim() || c.trackDone === true) return;
            let est = null, via = "scraping";
            const of = estadoOficial(await trazasOficialAndreani(db, String(c.tracking).trim()));
            if (of) { est = of; via = "oficial"; }
            if (!est) est = await trackAndreani(String(c.tracking).trim());
            if (!est) { await ref.set({ trackingLastCheck: ahora }, { merge: true }); return; }
            const cat = clasificarEstado(est.estado);
            const upd = { trackingLastCheck: ahora, trackingEstado: est.estado, trackingCat: cat, trackVia: via };
            if (cat === "entregado") {
              upd.trackDone = true; upd.trackEntregadoAt = ahora;
              if (c.contentReminderAt === undefined) upd.contentReminderAt = null;
              if (["Por enviar", "Pendiente envío", "Enviado"].includes(c.estado)) upd.estado = "Contenido pendiente";
            }
            if (cat === "devolucion") upd.trackDone = true;
            // Aviso in-app (el mail queda a cargo del cron; acá la dueña está EN la app viéndolo)
            if (cat !== c.trackingCat && ["en_sucursal", "entregado", "devolucion", "visita_fallida"].includes(cat)) {
              upd.trackingAviso = { cat, estado: est.estado, at: ahora, visto: false };
            }
            // Autocorrección: compara contra el cat guardado EN EL AVISO (no
            // trackingCat) para limpiar avisos ya obsoletos por una clasificación
            // vieja, incluso si trackingCat ya había avanzado sin limpiarlos.
            if (!upd.trackingAviso && c.trackingAviso && !c.trackingAviso.visto && c.trackingAviso.cat !== cat) {
              upd.trackingAviso = null;
            }
            await ref.set(upd, { merge: true });
            actualizados++;
          } catch (_) { /* un canje con error no frena el resto */ }
        }));
      }
      return res.json({ ok: true, actualizados });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── Credenciales de la cuenta: solo para `pack` (TN) y para saber si la
  // tienda es DEMO. La subida del tracking vive en subirTrackingTienda().
  let uData = {}, tiendaDemo = false, db;
  try {
    db = initAdmin();
    const userSnap = await db.collection("users").doc(uid).get();
    uData = userSnap.exists ? (userSnap.data() || {}) : {};
    tiendaDemo = esDemo(uData);
  } catch(e) {
    console.error("Firebase error:", e.message);
    return res.status(500).json({ error: "Error al obtener credenciales" });
  }
  const stores = tiendaDemo ? [] : (uData.stores || []);
  const tnStore = stores.find(s => s.type === "tiendanube" && s.accessToken && s.storeId) || null;
  const shStore = stores.find(s => s.type === "shopify" && s.accessToken && s.shop) || null;

  // Tienda DEMO: nada sale a Tienda Nube ni a Shopify (ni tracking ni mail al
  // comprador) — respuesta de éxito inocua con el mismo shape.
  if (tiendaDemo) {
    if (req.query.action === 'pack') return res.status(200).json({ ok: true, order: orderId || null, demo: true });
    if (!orderId || !tracking) return res.status(400).json({ error: "Faltan orderId o tracking" });
    return res.status(200).json({ ok: true, order: orderId, tracking, tnOrderId: String(orderId), fulfilled: true, fulfillError: null, demo: true });
  }

  // ── action=pack: marcar pedido como empaquetado en TN (sin salir de Growith) ──
  // Recibe el ID REAL de la orden de TN (no el número visible). Shopify manda
  // si está conectado (misma prioridad que orders.js) y ahí no aplica.
  if (req.query.action === 'pack') {
    if (shStore) return res.status(400).json({ error: "Marcar empaquetado no aplica a Shopify (se hace desde el fulfillment)." });
    if (!tnStore) return res.status(403).json({ error: "Tienda no conectada" });
    if (!orderId) return res.status(400).json({ error: "Falta orderId" });
    try {
      const headers = { 'Authentication': `bearer ${tnStore.accessToken}`, 'User-Agent': 'GrowithApp (contacto.growith@gmail.com)', 'Content-Type': 'application/json' };
      const r = await fetch(`https://api.tiendanube.com/v1/${tnStore.storeId}/orders/${orderId}/pack`, { method: 'POST', headers });
      if (r.status === 429) return res.status(429).json({ error: "Tienda Nube limitó las llamadas, reintentá en unos segundos", code: "tn_rate_limit", retryAfter: Math.max(1, Number(r.headers.get("retry-after")) || 3) });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        return res.status(r.status).json({ error: d.message || d.description || `Error TN ${r.status}` });
      }
      return res.status(200).json({ ok: true, order: orderId });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── Sin action: subir el tracking a la tienda (Shopify o Tienda Nube) ──
  // La lógica está en subirTrackingTienda (compartida con la cola de reintento
  // del cron); acá solo se traduce a HTTP con los mismos códigos de siempre:
  // 403 shopify_scope / sin tienda, 400 shopify_hold, 404, 429 tn_rate_limit,
  // 502 fulfillment, 500 error; "ya estaba enviado" = 200 con fulfilled:false.
  if (!orderId || !tracking) return res.status(400).json({ error: "Faltan orderId o tracking" });
  if (!shStore && !tnStore) return res.status(403).json({ error: "Tienda no conectada" });
  const r = await subirTrackingTienda(db, uid, uData, { orderId: String(orderId), tracking: String(tracking) });
  if (!r.ok) {
    const body = { error: r.error || "No se pudo subir el tracking" };
    if (r.code && ["shopify_scope", "shopify_hold", "tn_rate_limit"].includes(r.code)) body.code = r.code;
    if (r.retryAfter) body.retryAfter = r.retryAfter;
    return res.status(r.status || 500).json(body);
  }
  return res.status(200).json({ ok: true, order: orderId, tracking, tnOrderId: r.tnOrderId, fulfilled: !!r.fulfilled, fulfillError: r.fulfillError || null });
}

// Lista ORDENADA de reglas [fuente de regex, categoría] que usa clasificarEstado
// (más la vía rápida por etapa v3: pendiente de ingreso→otro, ingresado→en_camino,
// en camino→en_camino, en sucursal→en_sucursal, entregado→entregado; las dos
// reglas de negación se prueban antes de la etapa salvo "en sucursal"). El
// front (mapAndreaniEstado) copia esta misma lista para clasificar igual.
export const GH_ESTADO_REGLAS = ESTADO_REGLAS.map(([src, cat]) => [src, cat]);
