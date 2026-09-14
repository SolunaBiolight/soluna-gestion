// api/tiktok-ads.js
// TikTok Ads (Marketing API v1.3): análisis de campañas + "Publicar en TikTok".
// La conexión (OAuth por redirección) vive en integrations.js (platform=tiktokads)
// + tiktok-ads-callback.js; el token long-lived queda en users/{uid}.tiktokAds.
//
// Acciones:
//   accounts        GET  → cuentas publicitarias (nombre, moneda, estado); guarda la moneda para el Dashboard
//   campaigns       GET  → campañas + métricas del rango (+ serie diaria si el rango es ≤ 30 días)
//   campaign_status POST → ENABLE / DISABLE
//   pub_config      GET  → píxeles e identidades (nombre + foto) para el publicador
//   upload_image    POST → imagen JPEG (avatar / portada) → image_id
//   identity_create POST → identidad CUSTOMIZED_USER (nombre + avatar)
//   video_chunk     POST → trozo del video (≤ 2,4 MB) guardado temporal en Firestore (tiktok_uploads)
//   video_finish    POST → arma el video, lo sube a TikTok (UPLOAD_BY_FILE + MD5) → video_id (+ portada)
//   publish         POST → campaña + grupo de anuncios + anuncios. La campaña queda PAUSADA por default.
// Los videos no pasan enteros por el server (tope de 4,5 MB de body en Vercel): el
// navegador los manda en trozos y video_finish los junta.
//
// Permisos de la app de TikTok for Business: Ad Account Management, Reporting,
// Ads Management, Creative Management y Pixel (Measurement).

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createHash, randomBytes } from "crypto";
import { guardUid } from "./_auth.js";

const TT_API = "https://business-api.tiktok.com/open_api/v1.3";

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({
    credential: cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
    }),
  });
  return getFirestore();
}

// Países → location_ids de TikTok (IDs de GeoNames).
const TT_GEOS = { AR: "3865483", UY: "3439705", CL: "3895114", PY: "3437598", BO: "3923057", PE: "3932488", CO: "3686110", EC: "3658394", MX: "3996063", ES: "2510769", US: "6252001" };
const TT_EVENTOS = ["SHOPPING", "ON_WEB_ORDER", "INITIATE_ORDER", "ON_WEB_CART"]; // pago completado · pedido · inicio de pago · carrito
const TT_CTAS = ["SHOP_NOW", "LEARN_MORE", "ORDER_NOW", "SIGN_UP", "CONTACT_US", "VIEW_NOW"];
const TT_EDADES = ["AGE_18_24", "AGE_25_34", "AGE_35_44", "AGE_45_54", "AGE_55_100"]; // solo adultos
const PARTE = 900_000; // bytes por doc de Firestore (tope 1 MiB)
const num = (v) => parseFloat(v) || 0;
const gLen = (s) => [...String(s || "")].length;
const parseBody = (req) => (typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}));
const httpErr = (status, msg, extra = {}) => Object.assign(new Error(msg), { status, ...extra });

// Error de TikTok ({code, message}) → castellano.
function ttError(j, status) {
  const code = j?.code, msg = String(j?.message || `HTTP ${status}`);
  const friendly =
    (code === 40105 || code === 40104 || /access.?token|token.*(invalid|expired)/i.test(msg)) ? "TikTok rechazó la sesión — desvinculá y volvé a conectar TikTok Ads en Configuración → Integraciones." :
    (code === 40001 || /permission|scope|not authoriz|no auth/i.test(msg)) ? "La app de TikTok de Growith no tiene permiso para esta acción: hay que sumar los permisos de publicación en el portal de TikTok for Business y volver a conectar TikTok Ads." :
    (code === 40100 || /too many|rate limit|qps/i.test(msg)) ? "TikTok está limitando las consultas — probá de nuevo en un minuto." :
    null;
  return httpErr(status >= 400 && status < 500 ? status : 400, friendly ? `${friendly} (TikTok: ${msg.slice(0, 200)})` : `TikTok: ${msg.slice(0, 300)}`, { tiktokCode: code });
}

// Llamada a la Marketing API. GET: los arrays van como JSON en el query. Los IDs de
// TikTok pasan 2^53: se comillan antes de parsear para no perder dígitos.
async function tt(method, path, token, { query, body, form } = {}) {
  const u = new URL(`${TT_API}${path}`);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
  const r = await fetch(u.toString(), { method, headers: { "Access-Token": token, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : form });
  const txt = await r.text().catch(() => "");
  let j;
  try { j = JSON.parse(txt.replace(/([:\[,]\s*)(\d{16,})(?=\s*[,\]}])/g, '$1"$2"')); } catch { j = { code: -1, message: `HTTP ${r.status}` }; }
  if (j.code !== 0) throw ttError(j, r.status);
  return j.data || {};
}

async function ttReport(token, advertiser, { dataLevel, dimensions, metrics, since, until }) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const d = await tt("GET", "/report/integrated/get/", token, { query: { advertiser_id: advertiser, report_type: "BASIC", data_level: dataLevel, dimensions, metrics, start_date: since, end_date: until, page, page_size: 1000 } });
    out.push(...(d.list || []));
    if (!d.page_info || page >= (d.page_info.total_page || 1)) break;
  }
  return out;
}

async function ttInfoCuentas(token, ids) {
  if (!ids.length) return [];
  return (await tt("GET", "/advertiser/info/", token, { query: { advertiser_ids: ids } })).list || [];
}

// Gasto del período por cuenta, en la moneda de cada cuenta (lo usa orders.js para
// el Dashboard y el P&L). → { cuentas:[{advertiser, currency, spend}], errs }
export async function ttGastoPeriodo(t, since, until) {
  const advs = (t?.advertisers || []).slice(0, 5);
  const cuentas = [], errs = [];
  let monedas = Object.fromEntries(advs.filter(a => a.currency).map(a => [String(a.id), a.currency]));
  if (advs.some(a => !a.currency)) {
    try { for (const x of await ttInfoCuentas(t.access_token, advs.map(a => String(a.id)))) monedas[String(x.advertiser_id)] = x.currency; } catch (e) { errs.push(e.message); }
  }
  for (const a of advs) {
    try {
      const rows = await ttReport(t.access_token, String(a.id), { dataLevel: "AUCTION_ADVERTISER", dimensions: ["advertiser_id"], metrics: ["spend"], since, until });
      cuentas.push({ advertiser: String(a.id), currency: monedas[String(a.id)] || null, spend: rows.reduce((s, r) => s + num(r.metrics?.spend), 0) });
    } catch (e) { errs.push(e.message); }
  }
  return { cuentas, errs };
}

async function ttConexion(db, uid) {
  const ref = db.collection("users").doc(uid);
  const t = (await ref.get()).data()?.tiktokAds || null;
  if (!t?.access_token) throw httpErr(400, "TikTok Ads no está conectado en esta tienda.", { noConectado: true });
  return { ref, t };
}
function ttAdv(t, id) {
  const a = String(id || t.advertiser_id || t.advertisers?.[0]?.id || "").replace(/\D/g, "");
  if (!a || !(t.advertisers || []).some(x => String(x.id) === a)) throw httpErr(400, "Esa cuenta publicitaria no está en tu conexión de TikTok.");
  return a;
}

async function ttSubirImagen(token, adv, buf, nombre) {
  const fd = new FormData();
  fd.append("advertiser_id", adv);
  fd.append("upload_type", "UPLOAD_BY_FILE");
  fd.append("image_signature", createHash("md5").update(buf).digest("hex"));
  fd.append("file_name", `${String(nombre || "imagen").replace(/[^\w.\- ]+/g, "").trim().slice(0, 60) || "imagen"}-${Date.now().toString(36)}.jpg`);
  fd.append("image_file", new Blob([buf], { type: "image/jpeg" }), "imagen.jpg");
  const d = await tt("POST", "/file/image/ad/upload/", token, { form: fd });
  const id = d.image_id || (Array.isArray(d) ? d[0]?.image_id : null) || d.list?.[0]?.image_id;
  if (!id) throw httpErr(502, "TikTok no devolvió la imagen subida — probá de nuevo.");
  return String(id);
}

async function ttBorrarSubida(db, ref) {
  try {
    const ps = await ref.collection("partes").get();
    for (let i = 0; i < ps.docs.length; i += 400) { const bt = db.batch(); ps.docs.slice(i, i + 400).forEach(d => bt.delete(d.ref)); await bt.commit(); }
    await ref.delete();
  } catch (e) { console.warn("tiktok upload cleanup:", e.message); }
}

// Valida lo que manda el publicador. → { errs, spec }
export function ttValidarPublicacion(b) {
  const errs = [];
  const objetivo = b.objetivo === "trafico" ? "trafico" : "ventas";
  const nombre = String(b.nombre || "").replace(/\s+/g, " ").trim();
  if (!nombre) errs.push("Poné un nombre a la campaña"); else if (gLen(nombre) > 250) errs.push("El nombre de la campaña es muy largo");
  const url = String(b.url || "").trim();
  let urlOk = false; try { const u = new URL(url); urlOk = /^https?:$/.test(u.protocol) && u.hostname.includes("."); } catch { }
  if (!urlOk) errs.push("La URL de destino no es válida (tiene que empezar con https://)");
  const presupuesto = Math.round(Number(b.presupuesto) * 100) / 100;
  if (!(presupuesto > 0)) errs.push("Poné un presupuesto diario mayor a 0");
  const identity = String(b.identity_id || "").replace(/\D/g, "");
  if (!identity) errs.push("Elegí o creá la identidad (nombre y foto con la que sale el anuncio)");
  const pixel = String(b.pixel_id || "").replace(/\D/g, "");
  if (objetivo === "ventas" && !pixel) errs.push("Para Ventas en la web elegí el píxel de TikTok (o cambiá a Tráfico)");
  const ads = (Array.isArray(b.ads) ? b.ads : []).map((a, i) => ({
    video_id: String(a?.video_id || "").trim(), image_id: String(a?.image_id || "").trim(),
    texto: String(a?.texto || "").replace(/\s+/g, " ").trim(), nombre: String(a?.nombre || `Anuncio ${i + 1}`).replace(/\s+/g, " ").trim().slice(0, 100),
  }));
  if (!ads.length) errs.push("Subí al menos un video");
  if (ads.length > 20) errs.push("Máximo 20 videos por campaña");
  ads.forEach((a, i) => {
    if (!a.video_id || !a.image_id) errs.push(`Video ${i + 1}: falta subirlo a TikTok`);
    if (!a.texto) errs.push(`Video ${i + 1}: falta el texto del anuncio`); else if (gLen(a.texto) > 100) errs.push(`Video ${i + 1}: el texto pasa los 100 caracteres`);
  });
  return { errs, spec: {
    objetivo, nombre, url, presupuesto, identity, pixel,
    evento: TT_EVENTOS.includes(b.evento) ? b.evento : "SHOPPING",
    geo: TT_GEOS[b.pais] || TT_GEOS.AR,
    cta: TT_CTAS.includes(b.cta) ? b.cta : "SHOP_NOW",
    ads, activar: b.activar === true,
  } };
}

// Cuerpos de campaign/create, adgroup/create y ad/create (separado para testearlo).
export function ttCuerpos(adv, spec, startUtc) {
  const ventas = spec.objetivo === "ventas";
  return {
    campaign: { advertiser_id: adv, campaign_name: spec.nombre, objective_type: ventas ? "WEB_CONVERSIONS" : "TRAFFIC", budget_mode: "BUDGET_MODE_INFINITE", operation_status: spec.activar ? "ENABLE" : "DISABLE" },
    adgroup: (campaign_id) => ({
      advertiser_id: adv, campaign_id, adgroup_name: `${spec.nombre} · Grupo 1`,
      promotion_type: "WEBSITE", placement_type: "PLACEMENT_TYPE_NORMAL", placements: ["PLACEMENT_TIKTOK"],
      location_ids: [spec.geo], age_groups: TT_EDADES, gender: "GENDER_UNLIMITED",
      budget_mode: "BUDGET_MODE_DAY", budget: spec.presupuesto,
      schedule_type: "SCHEDULE_FROM_NOW", schedule_start_time: startUtc,
      pacing: "PACING_MODE_SMOOTH", bid_type: "BID_TYPE_NO_BID",
      ...(ventas ? { optimization_goal: "CONVERT", billing_event: "OCPM", pixel_id: spec.pixel, optimization_event: spec.evento } : { optimization_goal: "CLICK", billing_event: "CPC" }),
      operation_status: "ENABLE",
    }),
    ad: (adgroup_id) => ({
      advertiser_id: adv, adgroup_id,
      creatives: spec.ads.map(a => ({
        ad_name: a.nombre, ad_format: "SINGLE_VIDEO", identity_type: "CUSTOMIZED_USER", identity_id: spec.identity,
        video_id: a.video_id, image_ids: [a.image_id], ad_text: a.texto, call_to_action: spec.cta, landing_page_url: spec.url,
      })),
    }),
  };
}

// Campañas con métricas del rango (+ serie diaria ≤ 30 días). La usan la sección
// TikTok Ads y el conector de Claude (api/mcp.js).
export async function ttReporteCampanas(t, adv, since, until) {
  const tok = t.access_token;
  // 1) Todas las campañas (aunque no hayan gastado en el rango)
  const base = [];
  try {
    for (let page = 1; page <= 5; page++) {
      const d = await tt("GET", "/campaign/get/", tok, { query: { advertiser_id: adv, page, page_size: 1000 } });
      base.push(...(d.list || []));
      if (!d.page_info || page >= (d.page_info.total_page || 1)) break;
    }
  } catch (e) { if (e.tiktokCode === 40001 || e.tiktokCode === 40105) throw e; console.error("tiktok campaign/get:", e.message); }
  // 2) Métricas del rango. Las de compras van aparte: si la cuenta no las reporta, la tabla sale igual.
  const met = await ttReport(tok, adv, { dataLevel: "AUCTION_CAMPAIGN", dimensions: ["campaign_id"], metrics: ["spend", "impressions", "clicks", "conversion"], since, until });
  let compras = [], hayCompras = true;
  try { compras = await ttReport(tok, adv, { dataLevel: "AUCTION_CAMPAIGN", dimensions: ["campaign_id"], metrics: ["complete_payment", "total_complete_payment_rate"], since, until }); } catch (e) { hayCompras = false; console.warn("tiktok compras:", e.message); }
  const byId = {};
  const fila = (id, name = id) => byId[id] || (byId[id] = { id, name, status: "", objective: "", budget: null, spend: 0, impressions: 0, clicks: 0, conversions: 0, purchases: 0, value: 0 });
  for (const c of base) {
    if (c.operation_status === "DELETE" || /DELETE/.test(String(c.secondary_status || ""))) continue;
    const r = fila(String(c.campaign_id), c.campaign_name || String(c.campaign_id));
    r.status = c.operation_status === "ENABLE" ? "ENABLED" : "PAUSED";
    r.objective = c.objective_type || "";
    r.budget = c.budget_mode && c.budget_mode !== "BUDGET_MODE_INFINITE" && c.budget ? num(c.budget) : null;
  }
  for (const m of met) {
    const r = fila(String(m.dimensions?.campaign_id || ""));
    r.spend += num(m.metrics?.spend); r.impressions += parseInt(m.metrics?.impressions) || 0; r.clicks += parseInt(m.metrics?.clicks) || 0; r.conversions += num(m.metrics?.conversion);
  }
  for (const m of compras) {
    const r = fila(String(m.dimensions?.campaign_id || ""));
    r.purchases += num(m.metrics?.complete_payment); r.value += num(m.metrics?.total_complete_payment_rate);
  }
  const campaigns = Object.values(byId).filter(r => r.status || r.spend > 0).map(r => ({
    ...r, spend: +r.spend.toFixed(2), value: +r.value.toFixed(2), conversions: +r.conversions.toFixed(2), purchases: +r.purchases.toFixed(2),
    ctr: r.impressions ? +((r.clicks / r.impressions) * 100).toFixed(2) : 0,
    cpc: r.clicks ? +(r.spend / r.clicks).toFixed(2) : 0,
    cpm: r.impressions ? +((r.spend / r.impressions) * 1000).toFixed(2) : 0,
    cpa: r.conversions ? +(r.spend / r.conversions).toFixed(2) : 0,
    roas: r.spend && r.value ? +(r.value / r.spend).toFixed(2) : 0,
  })).sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name));
  // 3) Serie diaria: TikTok limita stat_time_day a 30 días por consulta.
  let daily = [];
  if ((Date.parse(until) - Date.parse(since)) / 86400000 <= 29) {
    try {
      const d = await ttReport(tok, adv, { dataLevel: "AUCTION_ADVERTISER", dimensions: ["stat_time_day"], metrics: ["spend", "conversion", "clicks"], since, until });
      daily = d.map(r => ({ date: String(r.dimensions?.stat_time_day || "").slice(0, 10), spend: +num(r.metrics?.spend).toFixed(2), conversions: num(r.metrics?.conversion), clicks: parseInt(r.metrics?.clicks) || 0 })).sort((a, b) => a.date.localeCompare(b.date));
    } catch (e) { console.warn("tiktok daily:", e.message); }
  }
  return { campaigns, daily, hayCompras };
}

export default async function handler(req, res) {
  { const _o = String(req.headers.origin || ""); res.setHeader("Access-Control-Allow-Origin", (["https://www.growithapp.com", "https://growithapp.com", "https://soluna-gestion.vercel.app"].includes(_o) || _o.endsWith("-soluna1.vercel.app") || _o.startsWith("http://localhost")) ? _o : "https://www.growithapp.com"); } // allowlist CORS
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = req.query?.action;
  const uid = req.query?.uid;
  if (!uid) return res.status(400).json({ error: "Falta uid" });
  if (!(await guardUid(req, res, uid))) return;

  try {
    const db = initAdmin();

    if (action === "accounts" && req.method === "GET") {
      const { ref, t } = await ttConexion(db, uid);
      const ids = (t.advertisers || []).map(a => String(a.id)).slice(0, 50);
      let info = [], infoErr = null;
      try { info = await ttInfoCuentas(t.access_token, ids); } catch (e) { infoErr = e.message; }
      const byId = Object.fromEntries(info.map(x => [String(x.advertiser_id), x]));
      const accounts = (t.advertisers || []).map(a => {
        const x = byId[String(a.id)] || {};
        return { id: String(a.id), name: x.name || a.name || String(a.id), currency: x.currency || a.currency || "", status: x.status || "", timezone: x.display_timezone || x.timezone || "" };
      });
      // La moneda queda guardada para que el Dashboard (orders.js) no la pida cada vez.
      if (info.length) ref.set({ tiktokAds: { ...t, advertisers: accounts.map(a => ({ id: a.id, name: a.name, currency: a.currency })) } }, { merge: true }).catch(() => {});
      return res.json({ accounts, advertiser_id: t.advertiser_id || accounts[0]?.id || null, infoErr });
    }

    if (action === "campaigns" && req.method === "GET") {
      const { t } = await ttConexion(db, uid);
      const adv = ttAdv(t, req.query.advertiser);
      const since = String(req.query.since || "").slice(0, 10), until = String(req.query.until || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) return res.status(400).json({ error: "Faltan since / until" });
      const r = await ttReporteCampanas(t, adv, since, until);
      return res.json({ ...r, since, until, advertiser: adv });
    }

    if (action === "campaign_status" && req.method === "POST") {
      const b = parseBody(req);
      const { t } = await ttConexion(db, uid);
      const adv = ttAdv(t, b.advertiser);
      const id = String(b.id || "").replace(/\D/g, "");
      const op = b.status === "ENABLE" ? "ENABLE" : b.status === "DISABLE" ? "DISABLE" : null;
      if (!id || !op) return res.status(400).json({ error: "Faltan id / status" });
      await tt("POST", "/campaign/status/update/", t.access_token, { body: { advertiser_id: adv, campaign_ids: [id], operation_status: op } });
      return res.json({ ok: true, id, status: op === "ENABLE" ? "ENABLED" : "PAUSED" });
    }

    if (action === "pub_config" && req.method === "GET") {
      const { t } = await ttConexion(db, uid);
      const adv = ttAdv(t, req.query.advertiser);
      const [pix, ids] = await Promise.allSettled([
        tt("GET", "/pixel/list/", t.access_token, { query: { advertiser_id: adv, page_size: 20 } }),
        tt("GET", "/identity/get/", t.access_token, { query: { advertiser_id: adv, identity_type: "CUSTOMIZED_USER", page_size: 100 } }),
      ]);
      const pixels = pix.status === "fulfilled" ? (pix.value.pixels || pix.value.list || []).map(p => ({ id: String(p.pixel_id), name: p.pixel_name || p.name || String(p.pixel_id) })) : [];
      const identities = ids.status === "fulfilled" ? (ids.value.identity_list || ids.value.list || []).map(i => ({ id: String(i.identity_id), name: i.display_name || "", avatar: i.profile_image || i.avatar_icon || "" })) : [];
      return res.json({ pixels, identities, errores: [pix, ids].filter(x => x.status === "rejected").map(x => x.reason?.message || "error") });
    }

    if (action === "upload_image" && req.method === "POST") {
      const b = parseBody(req);
      const { t } = await ttConexion(db, uid);
      const adv = ttAdv(t, b.advertiser);
      const buf = Buffer.from(String(b.data || "").replace(/^data:image\/[a-z+.-]+;base64,/i, ""), "base64");
      if (!buf.length) return res.status(400).json({ error: "Falta la imagen" });
      if (buf.length > 3_000_000) return res.status(413).json({ error: "La imagen es muy pesada" });
      return res.json({ ok: true, image_id: await ttSubirImagen(t.access_token, adv, buf, b.name) });
    }

    if (action === "identity_create" && req.method === "POST") {
      const b = parseBody(req);
      const { t } = await ttConexion(db, uid);
      const adv = ttAdv(t, b.advertiser);
      const nombre = String(b.display_name || "").replace(/\s+/g, " ").trim();
      const imageId = String(b.image_id || "").trim();
      if (!nombre || gLen(nombre) > 40) return res.status(400).json({ error: "El nombre de la identidad tiene que tener entre 1 y 40 caracteres" });
      if (!imageId) return res.status(400).json({ error: "Falta la foto de la identidad" });
      const d = await tt("POST", "/identity/create/", t.access_token, { body: { advertiser_id: adv, display_name: nombre, image_uri: imageId } });
      if (!d.identity_id) throw httpErr(502, "TikTok no devolvió la identidad creada — probá de nuevo.");
      return res.json({ ok: true, identity: { id: String(d.identity_id), name: nombre } });
    }

    if (action === "video_chunk" && req.method === "POST") {
      const b = parseBody(req);
      const { t } = await ttConexion(db, uid);
      const idx = parseInt(b.index), total = parseInt(b.total);
      if (!(idx >= 0) || !(total > 0) || total > 60 || idx >= total) return res.status(400).json({ error: "Parte de video inválida" });
      const buf = Buffer.from(String(b.data || ""), "base64");
      if (!buf.length || buf.length > 2_600_000) return res.status(413).json({ error: "Parte de video inválida" });
      const col = db.collection("tiktok_uploads");
      let upId = String(b.uploadId || "").replace(/[^a-f0-9]/g, "");
      if (!upId) {
        if (idx !== 0) return res.status(400).json({ error: "Falta uploadId" });
        const adv = ttAdv(t, b.advertiser);
        // Subidas abandonadas de este usuario (más de 6 h): se limpian acá.
        try { const viejas = await col.where("uid", "==", uid).limit(20).get(); for (const d of viejas.docs) if (Date.parse(d.data().createdAt || 0) < Date.now() - 6 * 3600e3) await ttBorrarSubida(db, d.ref); } catch (_) {}
        upId = randomBytes(12).toString("hex");
        await col.doc(upId).set({ uid, advertiser: adv, name: String(b.name || "video").slice(0, 120), mime: String(b.mime || "video/mp4").slice(0, 40), total, createdAt: new Date().toISOString() });
      } else {
        const s = await col.doc(upId).get();
        if (!s.exists || s.data().uid !== uid) return res.status(404).json({ error: "La subida del video venció — volvé a intentar." });
      }
      const bt = db.batch();
      for (let k = 0, off = 0; off < buf.length; k++, off += PARTE) bt.set(col.doc(upId).collection("partes").doc(`${String(idx).padStart(3, "0")}_${k}`), { d: buf.subarray(off, off + PARTE) });
      await bt.commit();
      return res.json({ ok: true, uploadId: upId });
    }

    if (action === "video_finish" && req.method === "POST") {
      const b = parseBody(req);
      const { t } = await ttConexion(db, uid);
      const ref = db.collection("tiktok_uploads").doc(String(b.uploadId || "").replace(/[^a-f0-9]/g, "") || "x");
      const s = await ref.get();
      if (!s.exists || s.data().uid !== uid) return res.status(404).json({ error: "La subida del video venció — volvé a intentar." });
      const meta = s.data();
      try {
        const adv = ttAdv(t, meta.advertiser);
        const docs = (await ref.collection("partes").get()).docs.sort((a, c) => a.id.localeCompare(c.id));
        if (new Set(docs.map(d => d.id.split("_")[0])).size !== meta.total) return res.status(400).json({ error: "Faltan partes del video — volvé a subirlo." });
        const buf = Buffer.concat(docs.map(d => { const v = d.data().d; return Buffer.isBuffer(v) ? v : Buffer.from(v?.toUint8Array ? v.toUint8Array() : v); }));
        const fd = new FormData();
        fd.append("advertiser_id", adv);
        fd.append("upload_type", "UPLOAD_BY_FILE");
        fd.append("video_signature", createHash("md5").update(buf).digest("hex"));
        fd.append("file_name", `${String(meta.name || "video").replace(/\.[a-z0-9]+$/i, "").replace(/[^\w.\- ]+/g, "").trim().slice(0, 60) || "video"}-${Date.now().toString(36)}`);
        fd.append("video_file", new Blob([buf], { type: meta.mime || "video/mp4" }), meta.name || "video.mp4");
        const d = await tt("POST", "/file/video/ad/upload/", t.access_token, { form: fd });
        const v = Array.isArray(d) ? d[0] : (d.list?.[0] || d);
        if (!v?.video_id) throw httpErr(502, "TikTok no devolvió el video subido — probá de nuevo.");
        // Portada: el cuadro que capturó el navegador (TikTok la pide en los anuncios de video).
        let image_id = null;
        const cover = Buffer.from(String(b.cover || "").replace(/^data:image\/[a-z+.-]+;base64,/i, ""), "base64");
        if (cover.length) image_id = await ttSubirImagen(t.access_token, adv, cover, `Portada ${meta.name || ""}`);
        return res.json({ ok: true, video_id: String(v.video_id), image_id, width: v.width || null, height: v.height || null, duration: v.duration || null });
      } finally { await ttBorrarSubida(db, ref); }
    }

    if (action === "publish" && req.method === "POST") {
      const b = parseBody(req);
      const { t } = await ttConexion(db, uid);
      const adv = ttAdv(t, b.advertiser);
      const { errs, spec } = ttValidarPublicacion(b);
      if (errs.length) return res.status(400).json({ error: errs.join(" · "), errores: errs });
      const tok = t.access_token;
      const startUtc = new Date(Date.now() + 10 * 60000).toISOString().slice(0, 19).replace("T", " ");
      const cuerpos = ttCuerpos(adv, spec, startUtc);
      const camp = await tt("POST", "/campaign/create/", tok, { body: cuerpos.campaign }).catch(e => { throw httpErr(e.status, `Campaña: ${e.message}`); });
      const campaignId = String(camp.campaign_id || "");
      if (!campaignId) throw httpErr(502, "TikTok no devolvió la campaña creada — probá de nuevo.");
      let paso = "Grupo de anuncios";
      try {
        const ag = await tt("POST", "/adgroup/create/", tok, { body: cuerpos.adgroup(campaignId) });
        const adgroupId = String(ag.adgroup_id || "");
        if (!adgroupId) throw httpErr(502, "TikTok no devolvió el grupo de anuncios creado.");
        paso = "Anuncios";
        const ad = await tt("POST", "/ad/create/", tok, { body: cuerpos.ad(adgroupId) });
        return res.json({ ok: true, campaignId, adgroupId, adIds: (ad.ad_ids || []).map(String), status: spec.activar ? "ENABLED" : "PAUSED", objetivo: spec.objetivo, nombre: spec.nombre });
      } catch (e) {
        // TikTok no tiene transacciones: si falla después de crear la campaña, se
        // borra para no dejar una campaña vacía en la cuenta.
        try { await tt("POST", "/campaign/status/update/", tok, { body: { advertiser_id: adv, campaign_ids: [campaignId], operation_status: "DELETE" } }); } catch (_) {}
        throw httpErr(e.status, `${paso}: ${e.message}`);
      }
    }

    return res.status(400).json({ error: "Acción inválida" });
  } catch (e) {
    console.error("tiktok-ads error:", e.message);
    return res.status(e.status && e.status >= 400 && e.status < 500 ? e.status : 502).json({ error: e.message, ...(e.noConectado ? { code: "no_conectado" } : {}) });
  }
}
