// api/_demo_ads.js — Tienda DEMO: Meta Ads, Google Ads y Mercado Libre ficticios.
//
// Complemento de api/_demo.js para la publicidad y el gestor de Mercado Libre.
// Una tienda con demo.activo === true NO llama a Meta, Google Ads ni Mercado
// Libre: meta.js, google-ads.js e inventory.js entran por una rama demo
// (metaDemo / gadsDemo / inventarioDemo) que devuelve la MISMA forma que la
// respuesta real, armada con las ventas ficticias (users/{uid}/demo_orders):
//   · gasto diario Meta / Google = gastoAdsDemo(día) (el mismo que usa el Dashboard)
//   · valor atribuido = una parte de la facturación ficticia de la tienda ese día
//   · en cada plataforma hay una campaña floja para que el análisis tenga qué mostrar
// Lo que siembra seedAdsDemo (y borra limpiarAdsDemo):
//   users/{uid}/meta_accounts/demo_meta   → cuenta Meta SIN access_token (ningún cron ni refresh la toca)
//   users/{uid}/demo_ml_questions/{id}    → preguntas pre-venta (ml_questions / ml_answer)
//   users/{uid}/demo_ml_chats/{packId}    → mensajes post-venta (ml_inbox / ml_messages / ml_send_message)
// Lo que se hace en la demo (pausar, cambiar presupuesto, publicar, responder)
// queda en esos docs (demo_overrides / demo_extra / googleAds.demoStatus…) para
// que la demo "responda" en vivo. Nunca se guardan tokens reales ni falsos.
//
// No es un endpoint (el "_" evita que Vercel lo publique).

import { esDemo, leerDemo, gastoAdsDemo, rngDemo, productosDemo, mlOrderDemo } from "./_demo.js";

// ── Detección (cache corto por instancia: evita una lectura extra por request) ──
const _flag = new Map(); // uid → { v, ts }
export async function esTiendaDemo(db, uid) {
  if (!uid) return false;
  const c = _flag.get(uid);
  if (c && Date.now() - c.ts < 20000) return c.v;
  let v = false;
  try { const s = await db.collection("users").doc(String(uid)).get(); v = esDemo(s.data()); }
  catch (_) { return false; } // ante la duda, camino real
  if (_flag.size > 2000) _flag.clear();
  _flag.set(uid, { v, ts: Date.now() });
  return v;
}

// ── Identidades ficticias (valores obviamente falsos) ─────────────────────────
export const DEMO_META = {
  accId: "demo_meta", userName: "Growith Demo", email: "demo@growithapp.com",
  adAccountId: "act_1000000000001", adAccountName: "Growith Demo · Publicidad",
  pageId: "100000000000002", pageName: "Growith Demo",
  igId: "17840000000000001", igUser: "growith.demo",
  pixelId: "1000000000000003", currency: "ARS", tz: "America/Argentina/Buenos_Aires",
};
export const DEMO_GADS = { customer: "1234567890", name: "Growith Demo", currency: "ARS" };
const DEMO_SELLER_ID = "999000111";
const TIENDA_URL = "https://growith-demo.mitiendanube.com";

// ── Utilidades ───────────────────────────────────────────────────────────────
const DIA = 86400000;
const ymdAR = (ms) => new Date(ms - 3 * 3600000).toISOString().slice(0, 10);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const okJ = (body, status = 200) => ({ status, body });
const errJ = (error, status = 400, extra = {}) => ({ status, body: { error, ...extra } });
function hashStr(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
const slug = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const nid = (pref) => pref + String(Date.now()).slice(-9) + String(Math.floor(Math.random() * 90 + 10));

// Días (YYYY-MM-DD, hora AR) del rango, sin pasar de hoy. Tope 400 días.
function diasRango(since, until) {
  const hoy = ymdAR(Date.now());
  let desde = String(since || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) desde = ymdAR(Date.now() - 7 * DIA);
  let hasta = String(until || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(hasta) || hasta > hoy) hasta = hoy;
  const out = [];
  let ms = Date.parse(desde + "T12:00:00Z"); const fin = Date.parse(hasta + "T12:00:00Z");
  while (ms <= fin && out.length < 400) { out.push(new Date(ms).toISOString().slice(0, 10)); ms += DIA; }
  return out;
}

// Imagen del creativo como SVG embebido (no depende de ningún CDN externo).
const PALETAS = [["#6d28d9", "#db2777"], ["#0ea5e9", "#6366f1"], ["#f97316", "#e11d48"], ["#10b981", "#0e7490"], ["#111827", "#4b5563"], ["#a855f7", "#f59e0b"], ["#2563eb", "#14b8a6"], ["#be123c", "#7c2d12"]];
function svgCreativo(titulo, sub, i) {
  const [a, b] = PALETAS[i % PALETAS.length];
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fs = String(titulo).length > 18 ? 34 : 46;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="600" height="600" fill="url(#g)"/><circle cx="470" cy="130" r="150" fill="#ffffff" opacity="0.08"/><text x="300" y="285" font-family="Inter,Arial,sans-serif" font-size="${fs}" font-weight="800" fill="#ffffff" text-anchor="middle">${esc(titulo)}</text><text x="300" y="340" font-family="Inter,Arial,sans-serif" font-size="24" fill="#ffffff" opacity="0.85" text-anchor="middle">${esc(sub)}</text><rect x="210" y="400" width="180" height="52" rx="26" fill="#ffffff"/><text x="300" y="434" font-family="Inter,Arial,sans-serif" font-size="20" font-weight="700" fill="${a}" text-anchor="middle">Comprar</text></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

// ── Ventas de la tienda por día (base del valor atribuido) — cache 60 s ─────
const _ventas = new Map(); // uid → { ts, data }
async function ventasTiendaPorDia(db, uid) {
  if (!db || !uid) return { porDia: new Map(), primer: null, hay: false };
  const c = _ventas.get(uid);
  if (c && Date.now() - c.ts < 60000) return c.data;
  const { ventas } = await leerDemo(db, uid);
  const porDia = new Map(); let primer = null;
  for (const o of ventas) {
    if (o.canal === "ml") continue; // la publicidad de Meta/Google empuja la tienda propia
    const t = Date.parse(o.fecha); if (!isFinite(t)) continue;
    const d = ymdAR(t);
    const x = porDia.get(d) || { rev: 0, n: 0 };
    x.rev += Number(o.total) || 0; x.n += 1; porDia.set(d, x);
    if (!primer || d < primer) primer = d;
  }
  const data = { porDia, primer, hay: porDia.size > 0 };
  if (_ventas.size > 200) _ventas.clear();
  _ventas.set(uid, { ts: Date.now(), data });
  return data;
}

// Parte de la facturación de la tienda que cada plataforma se atribuye
// (ROAS combinado ≈ 3x con las ventas ficticias recientes).
const PARTE_META = 0.4, PARTE_GOOGLE = 0.16;

// Serie diaria de la plataforma: gasto (gastoAdsDemo) + valor/compras atribuidas
// (parte de lo que la tienda facturó ese día). Sin ventas sembradas: ROAS 3.
async function serieAtribuida(db, uid, since, until, plataforma, parte) {
  const { porDia, primer, hay } = await ventasTiendaPorDia(db, uid);
  const dias = []; let S = 0, V = 0, P = 0;
  for (const d of diasRango(since, until)) {
    if (hay && d < primer) continue; // antes de la historia ficticia no había tienda ni pauta
    const s = gastoAdsDemo(d, plataforma);
    const x = porDia.get(d);
    const v = hay ? (x ? x.rev * parte : 0) : s * 3;
    const p = hay ? (x ? x.n * parte : 0) : v / 62000;
    dias.push({ date: d, spend: s, value: v, purchases: p });
    S += s; V += v; P += p;
  }
  return { S, V, P, dias };
}

// ═════════════════════════════════════════════════════════════════════════════
// META ADS
// ═════════════════════════════════════════════════════════════════════════════
// sh = parte del gasto dentro del padre · ro = eficiencia relativa (ROAS).
// La campaña "Test · UGC" (bajo) queda con ROAS < 1 a propósito.
const META_CAMPS = [
  { n: "Ventas · Catálogo Advantage+", obj: "OUTCOME_SALES", sh: 0.40, ro: 1.25, cpm: 4300, ctr: 1.9, fq: 1.6, cbo: 45000, adsets: [
    { n: "Advantage+ · Todo el catálogo", sh: 0.62, ro: 1.05, ads: [
      { n: "Carrusel · Más vendidos", p: "Remera Oversize", sh: 0.58, ro: 1.1 },
      { n: "Imagen · Buzo Canguro", p: "Buzo Canguro", sh: 0.42, ro: 0.88 }] },
    { n: "Advantage+ · Nuevos ingresos", sh: 0.38, ro: 0.93, ads: [
      { n: "Imagen · Lámpara LED", p: "Lámpara LED de escritorio", sh: 0.5, ro: 1.0 },
      { n: "Imagen · Anteojos de Sol", p: "Anteojos de Sol", sh: 0.5, ro: 0.95 }] }] },
  { n: "Remarketing · Visitantes 30 días", obj: "OUTCOME_SALES", sh: 0.17, ro: 1.55, cpm: 7200, ctr: 2.4, fq: 3.2, adsets: [
    { n: "Carrito abandonado 7 días", sh: 0.55, ro: 1.2, bud: 9000, ads: [
      { n: "Dinámico · Te lo dejaste en el carrito", p: "Zapatillas Urban", sh: 1, ro: 1, copy: 2 }] },
    { n: "Visitantes de producto 30 días", sh: 0.45, ro: 0.8, bud: 7500, ads: [
      { n: "Imagen · 3 cuotas sin interés", p: "Mochila Urbana", sh: 0.6, ro: 1.05 },
      { n: "Imagen · Envío gratis", p: "Botella Térmica 750 ml", sh: 0.4, ro: 0.9 }] }] },
  { n: "Prospecting · Intereses moda urbana", obj: "OUTCOME_SALES", sh: 0.28, ro: 0.85, cpm: 3600, ctr: 1.5, fq: 1.5, adsets: [
    { n: "Mujeres 25-44 · Moda", sh: 0.55, ro: 1.1, bud: 15000, ads: [
      { n: "UGC · Remera oversize en 3 looks", p: "Remera Oversize", sh: 0.55, ro: 1.15 },
      { n: "Imagen · Cartera de Cuero", p: "Cartera de Cuero", sh: 0.45, ro: 0.85 }] },
    { n: "Hombres 25-44 · Streetwear", sh: 0.45, ro: 0.88, bud: 12000, ads: [
      { n: "Imagen · Gorra Trucker", p: "Gorra Trucker", sh: 0.5, ro: 0.9 },
      { n: "Imagen · Buzo Canguro Negro", p: "Buzo Canguro", sh: 0.5, ro: 1.1 }] }] },
  { n: "Test · UGC Zapatillas Urban", obj: "OUTCOME_SALES", sh: 0.15, ro: 0.3, cpm: 3900, ctr: 0.8, fq: 1.9, bajo: true, adsets: [
    { n: "Broad · 18-45", sh: 0.6, ro: 0.9, bud: 8500, ads: [
      { n: "UGC · Unboxing zapatillas", p: "Zapatillas Urban", sh: 0.65, ro: 0.8 },
      { n: "UGC · Review en la calle", p: "Zapatillas Urban", sh: 0.35, ro: 1.35 }] },
    { n: "Lookalike 3% compradores", sh: 0.4, ro: 1.15, bud: 5500, ads: [
      { n: "Imagen · Zapatillas Urban 3 colores", p: "Zapatillas Urban", sh: 1, ro: 1 }] }] },
  { n: "Hot Sale · Tráfico (finalizada)", obj: "OUTCOME_TRAFFIC", sh: 0, ro: 0, status: "PAUSED", cpm: 2500, ctr: 1.2, fq: 1.4, adsets: [
    { n: "Todo el país", sh: 1, ro: 1, bud: 10000, ads: [
      { n: "Imagen · Hot Sale 30% OFF", p: "Set de Tazas x4", sh: 1, ro: 1 }] }] },
];

const COPYS = [
  (p) => `🔥 ${p}: el más pedido de la temporada.\n\n✅ Envío gratis desde $60.000\n✅ 3 cuotas sin interés\n✅ Cambios sin costo\n\nPedilo hoy y recibilo en 48 h 👇`,
  (p) => `¿Todavía no probaste ${p}? Calidad premium a precio de fábrica. Stock limitado ⏳`,
  (p) => `Lo viste, te gustó y te lo dejaste en el carrito 👀 ${p} te espera con 10% OFF usando el cupón VUELVE10.`,
  (p) => `${p}: diseño, calidad y garantía. Miles de clientes felices en todo el país ⭐⭐⭐⭐⭐`,
];

// Estructura campañas → conjuntos → anuncios, con pausas/presupuestos cambiados
// en la demo (cfg.demo_overrides) y lo creado desde la demo (cfg.demo_extra).
function metaArbol(cfg = {}) {
  const ov = cfg.demo_overrides || {}; const st = ov.status || {}; const bu = ov.budget || {};
  const camps = [], adsets = [], ads = [];
  META_CAMPS.forEach((c, ci) => {
    const cid = `120210000000${String(ci + 1).padStart(3, "0")}`;
    const cSt = st[cid] || c.status || "ACTIVE";
    camps.push({ id: cid, name: c.n, objective: c.obj, status: cSt, eff: cSt, daily_budget: c.cbo ? (bu[cid] ?? c.cbo) : null, campaign_id: cid });
    c.adsets.forEach((s, si) => {
      const sid = `120210000001${ci + 1}${si + 1}0`;
      const sSt = st[sid] || "ACTIVE";
      const sEff = cSt !== "ACTIVE" ? "CAMPAIGN_PAUSED" : sSt;
      adsets.push({ id: sid, name: s.n, status: sSt, eff: sEff, daily_budget: c.cbo ? null : (bu[sid] ?? s.bud ?? null), campaign_id: cid, adset_id: sid, optimization_goal: c.obj === "OUTCOME_SALES" ? "OFFSITE_CONVERSIONS" : "LINK_CLICKS" });
      s.ads.forEach((a, ai) => {
        const aid = `120210000002${ci + 1}${si + 1}${ai + 1}`;
        const aSt = st[aid] || "ACTIVE";
        const aEff = sEff === "CAMPAIGN_PAUSED" ? "CAMPAIGN_PAUSED" : sEff !== "ACTIVE" ? "ADSET_PAUSED" : aSt;
        ads.push({ id: aid, name: a.n, status: aSt, eff: aEff, campaign_id: cid, adset_id: sid, prod: a.p,
          w: c.sh * s.sh * a.sh, rw: (c.ro || 0) * s.ro * a.ro, cpm: c.cpm, ctr: c.ctr, fq: c.fq, bajo: !!c.bajo, copy: a.copy, idx: ads.length });
      });
    });
  });
  const ex = cfg.demo_extra || {};
  for (const c of ex.campaigns || []) { const s = st[c.id] || c.status || "PAUSED"; camps.push({ ...c, status: s, eff: s, campaign_id: c.id }); }
  for (const s0 of ex.adsets || []) {
    const camp = camps.find(c => c.id === s0.campaign_id); const s = st[s0.id] || s0.status || "PAUSED";
    adsets.push({ ...s0, status: s, eff: camp && camp.status !== "ACTIVE" ? "CAMPAIGN_PAUSED" : s, adset_id: s0.id });
  }
  for (const a0 of ex.ads || []) { const s = st[a0.id] || a0.status || "PAUSED"; ads.push({ ...a0, status: s, eff: s, w: 0, rw: 0, idx: ads.length }); }
  return { camps, adsets, ads };
}

const M0 = () => ({ spend: 0, impressions: 0, clicks: 0, reach: 0, purchases: 0, value: 0 });
// Métricas por anuncio (hoja) para el rango: el gasto total del día se reparte por
// peso; el valor atribuido por peso × eficiencia. Padres = suma de hijos.
function metaHojas(arbol, serie) {
  const nDias = Math.max(1, serie.dias.length);
  const sumVW = arbol.ads.reduce((s, a) => s + a.w * a.rw, 0) || 1;
  const ticket = serie.P > 0 ? serie.V / serie.P : 62000;
  const out = {};
  for (const a of arbol.ads) {
    if (!a.w || !serie.S) { out[a.id] = M0(); continue; }
    const r = rngDemo(hashStr(a.id) + nDias);
    const spend = serie.S * a.w;
    const value = serie.V * (a.w * a.rw) / sumVW;
    const impressions = Math.round(spend / (a.cpm * (0.88 + r() * 0.24)) * 1000);
    const clicks = Math.round(impressions * a.ctr * (0.85 + r() * 0.3) / 100);
    const reach = Math.round(impressions / Math.min(6, a.fq * (1 + Math.min(nDias, 30) / 45)));
    out[a.id] = { spend, impressions, clicks, reach, purchases: Math.round(value / ticket), value };
  }
  return out;
}
function sumM(list) {
  const t = M0();
  for (const m of list) for (const k in t) t[k] += m[k] || 0;
  if (list.length > 1) t.reach = Math.round(t.reach * 0.82); // gente alcanzada por más de un anuncio
  return t;
}
const derivadas = (m) => ({
  spend: r2(m.spend), impressions: m.impressions, clicks: m.clicks,
  ctr: m.impressions ? r2(m.clicks / m.impressions * 100) : 0,
  cpm: m.impressions ? r2(m.spend / m.impressions * 1000) : 0,
  cpc: m.clicks ? r2(m.spend / m.clicks) : 0,
  frequency: m.reach ? r2(m.impressions / m.reach) : 0, reach: m.reach,
  purchases: m.purchases, purchase_value: r2(m.value),
  roas: m.spend ? r2(m.value / m.spend) : 0, cpa: m.purchases ? r2(m.spend / m.purchases) : 0,
});
const filaMeta = (n, m) => ({
  id: n.id, name: n.name, status: n.status, effective_status: n.eff,
  campaign_id: n.campaign_id, adset_id: n.adset_id, ad_id: n.ad_id,
  ...derivadas(m),
  daily_budget: n.daily_budget != null ? Number(n.daily_budget) : null,
  objective: n.objective || null, creative: null,
});

const HORAS = [0.55, 0.35, 0.2, 0.12, 0.08, 0.1, 0.22, 0.45, 0.75, 0.95, 1.05, 1.15, 1.3, 1.25, 1.1, 1.05, 1.08, 1.18, 1.32, 1.5, 1.72, 1.85, 1.65, 1.1];
const SEGMENTOS = {
  age: [["18-24", 0.13, 0.7], ["25-34", 0.35, 1.1], ["35-44", 0.28, 1.15], ["45-54", 0.14, 0.95], ["55-64", 0.07, 0.8], ["65+", 0.03, 0.6]],
  gender: [["Mujeres", 0.58, 1.08], ["Hombres", 0.4, 0.9], ["Sin datos", 0.02, 0.5]],
  placement: [["facebook · feed", 0.28, 1.05], ["instagram · feed", 0.22, 1.15], ["instagram · story", 0.17, 0.9], ["instagram · reels", 0.21, 1.0], ["facebook · marketplace", 0.06, 0.8], ["audience_network · classic", 0.06, 0.35]],
  hour: HORAS.map((w, h) => [`${String(h).padStart(2, "0")}:00`, w, 0.75 + w * 0.3]),
};

async function metaInsightsDemo(db, uid, cfg, q) {
  const level = String(q.level || "campaign");
  if (!["campaign", "adset", "ad"].includes(level)) return errJ("level inválido");
  const since = String(q.since || ymdAR(Date.now() - 7 * DIA));
  const until = String(q.until || ymdAR(Date.now()));
  const arbol = metaArbol(cfg);
  const hojas = metaHojas(arbol, await serieAtribuida(db, uid, since, until, "meta", PARTE_META));
  let nodos = level === "campaign" ? arbol.camps : level === "adset" ? arbol.adsets : arbol.ads.map(a => ({ ...a, ad_id: a.id }));
  const pid = q.parent_id ? String(q.parent_id) : null, pt = q.parent_type ? String(q.parent_type) : null;
  if (pid && (pt === "campaign" || pt === "adset")) nodos = nodos.filter(n => String(n[pt + "_id"]) === pid);
  const metr = (n) => level === "ad" ? hojas[n.id] : sumM(arbol.ads.filter(a => a[level + "_id"] === n.id).map(a => hojas[a.id]));
  const bk = String(q.breakdown || "");
  if (SEGMENTOS[bk]) {
    const segs = SEGMENTOS[bk]; const sw = segs.reduce((s, x) => s + x[1], 0);
    const swf = segs.reduce((s, x) => s + (x[1] / sw) * x[2], 0);
    const rows = [];
    for (const n of nodos) {
      const m = metr(n); if (!m.spend) continue;
      for (const [seg, w0, f] of segs) {
        const w = w0 / sw, wv = (w * f) / swf;
        const mm = { spend: m.spend * w, impressions: Math.round(m.impressions * w), clicks: Math.round(m.clicks * w * Math.sqrt(f)), reach: Math.round(m.reach * w), purchases: Math.round(m.purchases * wv), value: m.value * wv };
        rows.push({ id: n.id, name: n.name, segment: seg, ...derivadas(mm) });
      }
    }
    return okJ({ rows, since, until, level, breakdown: bk });
  }
  const rows = nodos.map(n => filaMeta(n, metr(n))).sort((a, b) => b.spend - a.spend);
  return okJ({ rows, since, until, level });
}

async function metaLibraryDemo(db, uid, cfg, q) {
  const since = String(q.since || ymdAR(Date.now() - 7 * DIA));
  const until = String(q.until || ymdAR(Date.now()));
  const arbol = metaArbol(cfg);
  const hojas = metaHojas(arbol, await serieAtribuida(db, uid, since, until, "meta", PARTE_META));
  const analisis = {};
  try { (await db.collection("users").doc(uid).collection("meta_ad_analyses").get()).docs.forEach(d => { analisis[d.id] = d.data(); }); } catch (_) {}
  const ads = arbol.ads.map(a => {
    const m = hojas[a.id] || M0(); const prod = a.prod || a.name;
    const img = a.thumb || svgCreativo(prod, a.bajo ? "Nuevo drop" : "Envío gratis · 3 cuotas", a.idx);
    const rk = !m.spend ? null : a.bajo ? "BELOW_AVERAGE_35" : a.rw >= 1.2 ? "ABOVE_AVERAGE" : "AVERAGE";
    return {
      id: a.id, name: a.name, status: a.status, effective_status: a.eff, campaign_id: a.campaign_id, adset_id: a.adset_id,
      creative_thumbnail: img, creative_image_hd: img,
      creative_video_url: null, creative_video_id: null, creative_video_embed_html: null, creative_video_embeddable: false, creative_permalink: null,
      creative_body: a.body || COPYS[(a.copy ?? a.idx) % COPYS.length](prod),
      creative_title: a.title || `${prod} | Envío gratis`,
      creative_description: "Comprá online con envío a todo el país",
      creative_link: a.link || `${TIENDA_URL}/productos/${slug(prod)}/`,
      creative_cta: a.cta || "SHOP_NOW", creative_type: "image",
      ...derivadas(m),
      video_p25: null, video_p50: null, video_p75: null, video_p100: null, thruplays: 0,
      quality_ranking: rk, engagement_ranking: rk, conversion_ranking: rk && a.bajo ? "BELOW_AVERAGE_20" : rk,
      analysis: analisis[a.id]?.analysis || null, analyzed_at: analisis[a.id]?.analyzed_at || null,
    };
  });
  return okJ({ ads, since, until, _timings: { demo: true } });
}

function recursosMeta(cfg) {
  const ad_accounts = [{ id: DEMO_META.adAccountId, account_id: DEMO_META.adAccountId.replace("act_", ""), name: DEMO_META.adAccountName, account_status: 1, currency: DEMO_META.currency, timezone_name: DEMO_META.tz }];
  const pages = [{ id: DEMO_META.pageId, name: DEMO_META.pageName, category: "Tienda de ropa y accesorios", instagram_business_account: { id: DEMO_META.igId, username: DEMO_META.igUser }, has_page_token: true }];
  const me = { id: cfg?.user_id || DEMO_META.accId, name: DEMO_META.userName, email: DEMO_META.email };
  const pixels = [{ id: DEMO_META.pixelId, name: "Píxel · Growith Demo", creation_time: "2025-03-02T14:10:00-0300", last_fired_time: new Date(Date.now() - 4 * 60000).toISOString(), is_unavailable: false }];
  return { me, ad_accounts, pages, pixels };
}
function cuentaSegura(cfg) {
  const { access_token, page_access_token, ...s } = cfg || {};
  return { ...s, has_token: true, token_invalid: false, token_expires_at: null, token_refreshed_at: null, demo: true };
}
async function agregarExtra(ref, cfg, tipo, nodos) {
  const ex = { campaigns: [], adsets: [], ads: [], ...(cfg?.demo_extra || {}) };
  ex[tipo] = [...(ex[tipo] || []), ...nodos].slice(-60);
  await ref.set({ demo_extra: ex }, { merge: true });
  if (cfg) cfg.demo_extra = ex;
}
const normUrl = (u) => String(u || "").toLowerCase().split("?")[0].replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");

/**
 * Rama demo de api/meta.js. Devuelve { status, body } o null (= la acción no
 * toca Meta y sigue por el camino real: reglas, productos, creativos, IA…).
 */
export async function metaDemo(db, uid, action, req, opts = {}) {
  const q = req.query || {}; const m = req.method;
  const b = (typeof req.body === "string" ? (() => { try { return JSON.parse(req.body || "{}"); } catch (_) { return {}; } })() : (req.body || {}));
  const is = (a, mm) => action === a && m === mm;
  const userRef = db.collection("users").doc(uid);
  const col = userRef.collection("meta_accounts");
  const accId = q.acc_id ? String(q.acc_id) : null;
  const cargar = async () => {
    if (accId) { const s = await col.doc(accId).get(); if (s.exists) return { ref: s.ref, cfg: s.data() }; }
    const all = await col.get(); const d = all.docs.find(x => x.data()?.demo) || all.docs[0];
    return d ? { ref: d.ref, cfg: d.data() } : { ref: col.doc(DEMO_META.accId), cfg: null };
  };
  const SIN = errJ("La cuenta de Meta de la demo no está creada — regenerá la tienda demo.");

  if (is("accounts", "GET")) {
    const [snap, u] = await Promise.all([col.get(), userRef.get()]);
    const accounts = snap.docs.map(d => cuentaSegura(d.data()));
    return okJ({ accounts, active: u.data()?.meta_active_account || accounts[0]?.id || null });
  }
  // El front sube los creativos directo a graph.facebook.com: con demo:true se
  // saltea esa subida y usa un id de ejemplo (ver handleUploadFile en App.jsx).
  if (is("upload_creds", "GET")) return okJ({ demo: true, ad_account_id: "act_1234567890123", api_version: "v21.0", access_token: "" });
  if (is("connect", "POST")) return errJ("La tienda demo ya tiene Meta conectado con datos de ejemplo.");

  const DEMO_ACTIONS = ["available_ad_accounts", "all_assets", "resources", "select", "set_ad_account", "insights", "ads_library", "video_source", "debug_ad",
    "ad_products_map", "evaluate_rules", "reduce_budget", "set_status", "set_budget", "campaigns", "create_campaign", "create_adset", "create_full",
    "upload_to_meta", "ad_links", "publish", "publisher_video_from_url", "publisher_publish",
    "drive_meta_upload_start", "drive_meta_upload_chunk", "drive_meta_upload_finish"];
  if (!DEMO_ACTIONS.includes(action)) return null;

  const { ref, cfg } = await cargar();
  if (is("available_ad_accounts", "GET")) { const r = recursosMeta(cfg); return okJ({ ad_accounts: r.ad_accounts, pages: r.pages }); }
  if (is("resources", "GET")) { const r = recursosMeta(cfg); return okJ({ me: r.me, ad_accounts: r.ad_accounts, pages: r.pages, pixels: r.pixels.map(p => ({ id: p.id, name: p.name })) }); }
  if (is("all_assets", "GET")) {
    const r = recursosMeta(cfg);
    return okJ({
      me: r.me, ad_accounts: r.ad_accounts, pages: r.pages,
      ig_accounts: [{ id: DEMO_META.igId, username: DEMO_META.igUser, page_id: DEMO_META.pageId, page_name: DEMO_META.pageName }],
      pixels_by_account: { [DEMO_META.adAccountId]: r.pixels },
      active: { ad_account_id: cfg?.ad_account_id || null, page_id: cfg?.page_id || null, ig_account_id: cfg?.ig_account_id || null, pixel_id: cfg?.pixel_id || null },
    });
  }
  if (!cfg) return SIN;

  if (is("select", "POST") || is("set_ad_account", "POST")) {
    const campos = action === "select"
      ? ["ad_account_id", "ad_account_name", "page_id", "page_name", "ig_account_id", "ig_username", "pixel_id", "currency", "timezone_name"]
      : ["ad_account_id", "ad_account_name", "currency", "timezone_name"];
    if (action === "set_ad_account" && !b.ad_account_id) return errJ("Falta ad_account_id");
    const upd = {};
    for (const k of campos) if (b[k] !== undefined && b[k] !== "") upd[k] = b[k];
    await ref.set(upd, { merge: true });
    if (action === "select") await userRef.set({ meta_active_account: ref.id }, { merge: true });
    return okJ({ ok: true, account: cuentaSegura({ ...cfg, ...upd }) });
  }
  if (is("insights", "GET")) return metaInsightsDemo(db, uid, cfg, q);
  if (is("ads_library", "GET")) return metaLibraryDemo(db, uid, cfg, q);
  if (is("video_source", "GET")) return okJ({ source: null, picture: null, permalink: null, embed_html: null, embeddable: false });
  if (is("debug_ad", "GET")) return okJ({ ad_id: q.ad_id || null, demo: true, derived: {} });

  const arbol = metaArbol(cfg);
  const nodo = (id) => arbol.camps.find(c => c.id === id) || arbol.adsets.find(s => s.id === id) || arbol.ads.find(a => a.id === id) || null;

  if (is("ad_products_map", "GET")) {
    const ps = await userRef.collection("meta_products").where("acc_id", "==", accId || ref.id).get();
    const products = ps.docs.map(d => ({ id: d.id, ...d.data() }));
    const ad = {}, adset = {}, campaign = {};
    if (products.length) {
      for (const a of arbol.ads) {
        const link = normUrl(a.link || `${TIENDA_URL}/productos/${slug(a.prod || a.name)}/`);
        const pids = products.filter(p => (p.urls || []).some(u => { const nu = normUrl(u); return nu && (link.includes(nu) || nu.includes(link)); })).map(p => p.id);
        if (!pids.length) continue;
        ad[a.id] = pids;
        adset[a.adset_id] = [...new Set([...(adset[a.adset_id] || []), ...pids])];
        campaign[a.campaign_id] = [...new Set([...(campaign[a.campaign_id] || []), ...pids])];
      }
    }
    return okJ({ products, ad, adset, campaign });
  }
  if (is("evaluate_rules", "POST")) {
    const rs = await userRef.collection("meta_rules").where("acc_id", "==", accId || ref.id).get();
    return okJ({ evaluated: rs.docs.filter(d => d.data()?.active === true).length, actions: 0 });
  }
  if (is("set_status", "POST")) {
    const { node_id, status } = b;
    if (!node_id || !status) return errJ("Faltan node_id o status");
    if (!["ACTIVE", "PAUSED"].includes(status)) return errJ("status inválido");
    await ref.set({ demo_overrides: { status: { [String(node_id)]: status } } }, { merge: true });
    return okJ({ ok: true, node_id, status });
  }
  if (is("reduce_budget", "POST")) {
    const { node_id, pct } = b;
    if (!node_id || !pct) return errJ("Faltan node_id o pct");
    const p = parseFloat(pct);
    if (isNaN(p) || p <= 0 || p >= 100) return errJ("pct debe estar entre 1 y 99");
    const old = Number(nodo(String(node_id))?.daily_budget) || 0;
    if (old <= 0) return errJ("El node no tiene presupuesto editable");
    const nuevo = Math.max(1, Math.round(old * (100 - p) / 100));
    await ref.set({ demo_overrides: { budget: { [String(node_id)]: nuevo } } }, { merge: true });
    return okJ({ ok: true, node_id, field: "daily_budget", old_budget: old, new_budget: nuevo, pct: p });
  }
  if (is("set_budget", "POST")) {
    const { node_id, daily_budget } = b; const monto = parseFloat(daily_budget);
    if (!node_id || !isFinite(monto) || monto <= 0) return errJ("Faltan node_id o daily_budget válido");
    await ref.set({ demo_overrides: { budget: { [String(node_id)]: monto } } }, { merge: true });
    return okJ({ ok: true, node_id, daily_budget: monto });
  }
  if (is("campaigns", "GET")) {
    const cents = (v) => (v ? String(Math.round(Number(v) * 100)) : undefined);
    return okJ({
      campaigns: arbol.camps.map(c => ({ id: c.id, name: c.name, objective: c.objective, status: c.status, effective_status: c.eff, daily_budget: cents(c.daily_budget) })),
      adsets: arbol.adsets.map(s => ({ id: s.id, name: s.name, campaign_id: s.campaign_id, status: s.status, effective_status: s.eff, daily_budget: cents(s.daily_budget), optimization_goal: s.optimization_goal })),
      objectives: opts.objectives || [],
    });
  }
  if (is("create_campaign", "POST")) {
    const { name, objective, cbo_daily_budget_ars, active } = b;
    const c = { id: nid("12022"), name: String(name || "").trim() || `Campaña ${new Date().toLocaleDateString("es-AR")}`, objective: objective || "OUTCOME_SALES", status: active ? "ACTIVE" : "PAUSED", daily_budget: cbo_daily_budget_ars ? parseFloat(cbo_daily_budget_ars) : null };
    await agregarExtra(ref, cfg, "campaigns", [c]);
    return okJ({ ok: true, id: c.id, name: c.name, objective: c.objective, is_cbo: Boolean(cbo_daily_budget_ars) });
  }
  if (is("create_adset", "POST")) {
    const { name, campaign_id, optimization_goal, daily_budget_ars, is_cbo, start_time, active } = b;
    if (!campaign_id) return errJ("Falta campaign_id");
    const s = { id: nid("12023"), name: String(name || "").trim() || `AdSet ${new Date().toLocaleTimeString("es-AR")}`, campaign_id: String(campaign_id), status: active ? "ACTIVE" : "PAUSED", daily_budget: is_cbo ? null : parseFloat(daily_budget_ars || 3000), optimization_goal: optimization_goal || "OFFSITE_CONVERSIONS" };
    await agregarExtra(ref, cfg, "adsets", [s]);
    return okJ({ ok: true, id: s.id, name: s.name, campaign_id: s.campaign_id, start_time: start_time || null });
  }
  if (is("create_full", "POST")) {
    const { name, objective, mode, daily_budget, adsets, active } = b;
    if (!name?.trim()) return errJ("Falta nombre de campaña");
    if (!Array.isArray(adsets) || adsets.length === 0) return errJ("Necesitás al menos 1 adset");
    const isCbo = mode === "cbo";
    if (isCbo && !(parseFloat(daily_budget) > 0)) return errJ("CBO necesita presupuesto > 0");
    const st = active ? "ACTIVE" : "PAUSED";
    const c = { id: nid("12022"), name: name.trim(), objective: objective || "OUTCOME_SALES", status: st, daily_budget: isCbo ? parseFloat(daily_budget) : null };
    const creados = [], errores = [], nodos = [];
    adsets.forEach((a, i) => {
      const nombre = String(a.name || "").trim() || `AdSet ${creados.length + 1}`;
      const bud = parseFloat(a.daily_budget);
      if (!isCbo && !(bud > 0)) { errores.push(`AdSet "${nombre}": presupuesto inválido`); return; }
      const s = { id: nid("12023") + i, name: nombre, campaign_id: c.id, status: st, daily_budget: isCbo ? null : bud, optimization_goal: "OFFSITE_CONVERSIONS" };
      nodos.push(s); creados.push({ id: s.id, name: nombre, start_time: a.start_time || null });
    });
    await agregarExtra(ref, cfg, "campaigns", [c]);
    if (nodos.length) await agregarExtra(ref, cfg, "adsets", nodos);
    return okJ({ ok: true, campaign_id: c.id, campaign_name: c.name, adsets: creados, errors: errores });
  }
  if (is("upload_to_meta", "POST")) {
    const { filename, contentType } = b;
    if (!filename || !b.data_base64) return errJ("Faltan filename o data_base64");
    const isVideo = String(contentType || "").startsWith("video/") || /\.(mp4|mov|m4v|avi|webm)$/i.test(filename);
    if (isVideo) return okJ({ ok: true, kind: "video", id: nid("demo_vid_"), url: null });
    return okJ({ ok: true, kind: "image", hash: "demo" + hashStr(filename + Date.now()).toString(16), url: null, width: 1080, height: 1080 });
  }
  if (is("ad_links", "GET")) {
    const links = new Map();
    for (const a of arbol.ads) {
      if (a.eff !== "ACTIVE") continue;
      const url = a.link || `${TIENDA_URL}/productos/${slug(a.prod || a.name)}/`;
      const k = normUrl(url);
      if (!links.has(k)) links.set(k, { url, count: 0, ad: a.name });
      links.get(k).count++;
    }
    return okJ({ links: [...links.values()].sort((x, y) => y.count - x.count).slice(0, 40) });
  }
  if (is("publish", "POST")) {
    if (!accId) return errJ("Falta acc_id");
    if (!cfg.ad_account_id || !cfg.page_id) return errJ("Configurá ad account y página primero");
    const { creative_id, activate, default_link, default_cta } = b;
    if (!creative_id) return errJ("Falta creative_id");
    const cs = await userRef.collection("meta_creatives").doc(String(creative_id)).get();
    if (!cs.exists) return errJ("Creativo no encontrado", 404);
    const c = cs.data();
    if (!c.copy?.trim()) return errJ("Falta copy en el creativo");
    if (!c.adset_id) return errJ("Falta adset_id en el creativo");
    if (!c.url) return errJ("El creativo no tiene URL de archivo");
    const status = activate ? "ACTIVE" : "PAUSED";
    const adId = nid("12024");
    const thumb = typeof c.url === "string" && /^https?:\/\//.test(c.url) ? c.url : null;
    await agregarExtra(ref, cfg, "ads", [{
      id: adId, name: `${c.filename_base || "ad"} · ${new Date().toLocaleString("es-AR")}`.slice(0, 120),
      adset_id: String(c.adset_id), campaign_id: arbol.adsets.find(s => s.id === String(c.adset_id))?.campaign_id || null, status,
      prod: c.filename_base || "Nuevo anuncio", body: c.copy.trim(), title: c.title || "", link: c.link || default_link || "", cta: c.cta || default_cta || "LEARN_MORE", thumb,
    }]);
    return okJ({ ok: true, ad_id: adId, creative_id: nid("12025"), ig_status: cfg.ig_account_id ? "user" : "fb-only", status });
  }
  if (is("publisher_video_from_url", "POST")) {
    const { url, video_id } = b;
    if (video_id && !url) return okJ({ ok: true, video_id: String(video_id), ready: true, status: "ready" });
    const raw = String(url || "").trim();
    if (!/^https?:\/\//i.test(raw)) return errJ("Pegá un link válido (https://…)");
    return okJ({ ok: true, video_id: nid("demo_vid_"), ready: true, status: "ready", source: /drive\.google\.com|docs\.google\.com/i.test(raw) ? "drive" : "url" });
  }
  if (is("drive_meta_upload_start", "POST")) {
    if (!b.file_id) return errJ("Falta file_id");
    return okJ({ ok: true, session: "demo", video_id: nid("demo_vid_"), size: 1, start: 1, end: 1, name: b.title || "video.mp4", mime: "video/mp4" });
  }
  if (is("drive_meta_upload_chunk", "POST")) return okJ({ ok: true, start: 1, end: 1, done: true });
  if (is("drive_meta_upload_finish", "POST")) return okJ({ ok: true, success: true });
  if (is("publisher_publish", "POST")) {
    if (!cfg.page_id) return errJ("Configurá la Página de Facebook en tu cuenta de Meta");
    const { plan, creative } = b;
    if (!plan?.campaign || !plan?.adset || !plan?.ad) return errJ("Plan incompleto");
    if (!plan.ad.destination_url) return errJ("Falta la URL de destino");
    if (!creative || (!creative.video_id && !creative.image_hash)) return errJ("Falta el creativo (video o imagen)");
    const c = { id: nid("12022"), name: plan.campaign.name || "Growith · Campaña", objective: plan.campaign.objective || "OUTCOME_SALES", status: "PAUSED", daily_budget: null };
    const s = { id: nid("12023"), name: plan.adset.name || "Growith · AdSet", campaign_id: c.id, status: "PAUSED", daily_budget: Math.max(1, Math.round(Number(plan.adset.daily_budget) || 0)), optimization_goal: plan.adset.optimization_goal || "OFFSITE_CONVERSIONS" };
    const a = { id: nid("12024"), name: plan.ad.name || "Growith · Anuncio", adset_id: s.id, campaign_id: c.id, status: "PAUSED", prod: plan.ad.headline || plan.ad.name || "Nuevo anuncio", body: plan.ad.primary_text || "", title: plan.ad.headline || "", link: plan.ad.destination_url, cta: plan.ad.cta || "LEARN_MORE" };
    await agregarExtra(ref, cfg, "campaigns", [c]);
    await agregarExtra(ref, cfg, "adsets", [s]);
    await agregarExtra(ref, cfg, "ads", [a]);
    return okJ({ ok: true, campaign_id: c.id, adset_id: s.id, creative_id: nid("12025"), ad_id: a.id, status: "PAUSED", manager_url: null });
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// GOOGLE ADS
// ═════════════════════════════════════════════════════════════════════════════
// "Búsqueda · Genéricas" queda cerca de ROAS 1 (la floja del análisis).
const GADS_CAMPS = [
  { id: "21000000001", n: "Búsqueda · Marca", ch: "SEARCH", bid: "MAXIMIZE_CONVERSIONS", sh: 0.20, ro: 2.3, cpc: 140, ctr: 9.5, bud: 9000 },
  { id: "21000000002", n: "Performance Max · Catálogo completo", ch: "PERFORMANCE_MAX", bid: "MAXIMIZE_CONVERSION_VALUE", sh: 0.50, ro: 1.0, cpc: 210, ctr: 1.4, bud: 20000 },
  { id: "21000000003", n: "Búsqueda · Genéricas indumentaria", ch: "SEARCH", bid: "MAXIMIZE_CLICKS", sh: 0.30, ro: 0.38, cpc: 330, ctr: 4.2, bud: 12000 },
  { id: "21000000004", n: "Display · Remarketing", ch: "DISPLAY", bid: "TARGET_CPA", sh: 0, ro: 0, cpc: 90, ctr: 0.5, bud: 5000, status: "PAUSED" },
];

export function gadsDemoCuentas() {
  return { accounts: [{ id: DEMO_GADS.customer, name: DEMO_GADS.name, currency: DEMO_GADS.currency, status: "ENABLED", login: null }], errors: [] };
}

// Misma forma que gadsReporteCampanas: { campaigns, daily }.
export async function gadsDemoReporte(db, uid, since, until, g = {}) {
  const st = g?.demoStatus || {};
  const serie = await serieAtribuida(db, uid, since, until, "google", PARTE_GOOGLE);
  const sumVW = GADS_CAMPS.reduce((s, c) => s + c.sh * c.ro, 0) || 1;
  const ticket = serie.P > 0 ? serie.V / serie.P : 62000;
  const fila = (c, spend, value, clicks, impressions) => {
    const conversions = value / ticket;
    return {
      id: c.id, name: c.n, status: st[c.id] || c.status || "ENABLED", channel: c.ch, bidding: c.bid, budget: c.bud ?? null, start: null, end: null,
      spend: r2(spend), impressions, clicks, conversions: r2(conversions), conv_value: r2(value), all_conversions: r2(conversions * 1.15),
      ctr: impressions ? r2(clicks / impressions * 100) : 0, cpc: clicks ? r2(spend / clicks) : 0, cpm: impressions ? r2(spend / impressions * 1000) : 0,
      roas: spend ? r2(value / spend) : 0, cpa: conversions >= 0.01 ? r2(spend / conversions) : 0,
    };
  };
  const campaigns = GADS_CAMPS.map(c => {
    if (!c.sh || !serie.S) return fila(c, 0, 0, 0, 0);
    const r = rngDemo(hashStr(c.id) + serie.dias.length);
    const spend = serie.S * c.sh;
    const clicks = Math.round(spend / (c.cpc * (0.9 + r() * 0.2)));
    const impressions = Math.round(clicks / (c.ctr * (0.9 + r() * 0.2)) * 100);
    return fila(c, spend, serie.V * c.sh * c.ro / sumVW, clicks, impressions);
  });
  for (const e of (Array.isArray(g?.demoExtra) ? g.demoExtra : [])) campaigns.push(fila({ id: e.id, n: e.name, ch: e.channel, bid: e.bidding || "", bud: e.budget, status: e.status }, 0, 0, 0, 0));
  campaigns.sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name));
  const cpcProm = 1 / (GADS_CAMPS.reduce((s, c) => s + (c.sh / c.cpc), 0) || 1);
  const daily = serie.dias.map(d => ({ date: d.date, spend: r2(d.spend), conversions: r2(d.purchases), conv_value: r2(d.value), clicks: Math.round(d.spend / cpcProm) }));
  return { campaigns, daily };
}

/**
 * Rama demo de api/google-ads.js. opts.validar = gadsValidarPublicacion (la misma
 * validación que la publicación real). Devuelve { status, body } o null.
 */
export async function gadsDemo(db, uid, action, req, opts = {}) {
  const m = req.method; const q = req.query || {};
  const body = () => (typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}));
  const ref = db.collection("users").doc(uid);
  const leerG = async () => ((await ref.get()).data()?.googleAds) || {};

  if (action === "status" && m === "GET") {
    const g = await leerG();
    return okJ({ connected: !!g.connected, customers: g.connected ? [DEMO_GADS.customer] : [], connectedAt: g.connectedAt || null, hasCreds: true, hasDevToken: true, demo: true });
  }
  if (action === "accounts" && m === "GET") return okJ({ ...gadsDemoCuentas(), hasDevToken: true });
  if (action === "campaigns" && m === "GET") {
    const customer = String(q.customer || "").replace(/-/g, "");
    const since = String(q.since || "").slice(0, 10), until = String(q.until || "").slice(0, 10);
    if (!customer || !/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) return errJ("Faltan customer / since / until");
    const { campaigns, daily } = await gadsDemoReporte(db, uid, since, until, await leerG());
    return okJ({ campaigns, daily, since, until, customer });
  }
  if (action === "campaign_status" && m === "POST") {
    const b = body();
    const customer = String(b.customer || "").replace(/-/g, "");
    const id = String(b.id || "").replace(/\D/g, "");
    const status = b.status === "ENABLED" ? "ENABLED" : b.status === "PAUSED" ? "PAUSED" : null;
    if (!customer || !id || !status) return errJ("Faltan customer / id / status");
    await ref.set({ googleAds: { demoStatus: { [id]: status } } }, { merge: true });
    return okJ({ ok: true, id, status });
  }
  if (action === "upload_image" && m === "POST") {
    const b = body();
    const customer = String(b.customer || "").replace(/\D/g, "");
    const data = String(b.data || "").replace(/^data:image\/[a-z+.-]+;base64,/i, "");
    if (!customer || !data) return errJ("Faltan customer / data");
    if (data.length > 6_900_000) return errJ("La imagen pesa más de 5 MB", 413);
    return okJ({ ok: true, resourceName: `customers/${customer}/assets/${String(Date.now()).slice(-10)}${Math.floor(Math.random() * 90 + 10)}` });
  }
  if (action === "publish" && m === "POST" && typeof opts.validar === "function") {
    const b = body();
    const customer = String(b.customer || "").replace(/\D/g, "");
    if (!customer) return errJ("Falta la cuenta de Google Ads");
    const { errs, spec } = opts.validar(b);
    if (spec.tipo === "pmax") {
      const rnRe = new RegExp(`^customers/${customer}/assets/\\d+$`);
      const ok = (arr, max) => (Array.isArray(arr) ? arr : []).map(String).filter(x => rnRe.test(x)).slice(0, max);
      if (!ok(spec.land, 20).length) errs.push("Subí al menos una imagen horizontal");
      if (!ok(spec.sq, 20).length) errs.push("Subí al menos una imagen cuadrada");
      if (!ok(spec.logo, 5).length) errs.push("Subí el logo");
    }
    if (errs.length) return errJ(errs.join(" · "), 400, { errores: errs });
    const id = "22" + String(Date.now()).slice(-9);
    const g = await leerG();
    const extra = [...(Array.isArray(g.demoExtra) ? g.demoExtra : []), {
      id, name: spec.nombre, channel: spec.tipo === "pmax" ? "PERFORMANCE_MAX" : "SEARCH",
      bidding: spec.tipo === "pmax" ? (spec.puja === "conv" ? "MAXIMIZE_CONVERSIONS" : "MAXIMIZE_CONVERSION_VALUE") : (spec.puja === "clics" ? "MAXIMIZE_CLICKS" : "MAXIMIZE_CONVERSIONS"),
      status: spec.status, budget: r2(Number(spec.micros) / 1e6),
    }].slice(-30);
    await ref.set({ googleAds: { demoExtra: extra } }, { merge: true });
    return okJ({ ok: true, campaignId: id, resourceName: `customers/${customer}/campaigns/${id}`, status: spec.status, tipo: spec.tipo, nombre: spec.nombre });
  }
  return null; // oauth_start / disconnect / ai_copy (Gemini): camino real
}

// ═════════════════════════════════════════════════════════════════════════════
// MERCADO LIBRE (gestor de api/inventory.js)
// ═════════════════════════════════════════════════════════════════════════════
const permalinkML = (mlId, titulo) => `https://articulo.mercadolibre.com.ar/MLA-${String(mlId).replace(/^MLA/, "")}-${slug(titulo)}-_JM`;
async function leerProductos(ref) { return (await ref.collection("demo_products").get()).docs.map(d => ({ id: d.id, ...d.data() })); }

// Publicaciones de ML (productos con canal ml/ambos) con lo editado en la demo (mlEdit).
function mlItemsDe(productos, ventas) {
  const sold = {};
  for (const o of ventas) if (o.canal === "ml") for (const i of o.items || []) if (i.mlId) sold[i.mlId] = (sold[i.mlId] || 0) + (Number(i.qty) || 1);
  return productos.filter(p => p.canal !== "tienda" && p.mlId).map(p => {
    const e = p.mlEdit || {}; const r = rngDemo(hashStr(p.mlId));
    const base = Math.floor(40 + r() * 260); // ventas históricas previas a la demo
    const listing = e.listing || (r() < 0.45 ? "gold_pro" : "gold_special");
    const health = r2(0.72 + r() * 0.27);
    const titulo = e.titulo || p.nombre;
    return {
      id: p.mlId, title: titulo, permalink: permalinkML(p.mlId, titulo), status: e.status || "active",
      available_quantity: e.stock != null ? Number(e.stock) : (p.variantes || []).reduce((s, v) => s + (Number(v.stock) || 0), 0),
      sold_quantity: (sold[p.mlId] || 0) + base, price: e.precio != null ? Number(e.precio) : Number(p.precio) || 0, currency: "ARS",
      thumbnail: e.thumbnail || p.imagen || null, pictures_count: 3 + Math.floor(r() * 5),
      handling_time: e.handling != null ? Number(e.handling) : null, listing_type: listing, health,
    };
  });
}
function mlEditDe(changes, actual) {
  const e = {};
  if (changes.price != null && !isNaN(Number(changes.price))) e.precio = Number(changes.price);
  if (typeof changes.price_pct === "number") e.precio = Math.round(Number(actual.price || 0) * (1 + changes.price_pct / 100));
  if (changes.available_quantity != null && !isNaN(parseInt(changes.available_quantity))) e.stock = parseInt(changes.available_quantity);
  if (changes.title) e.titulo = String(changes.title).slice(0, 60);
  if (["active", "paused", "closed"].includes(changes.status)) e.status = changes.status;
  const ht = changes.handling_time != null ? changes.handling_time : (changes.sale_terms || []).find(t => t?.id === "MANUFACTURING_TIME")?.value_struct?.number;
  if (ht != null && !isNaN(parseInt(ht))) e.handling = parseInt(ht);
  return e;
}
async function crearPublicacionDemo(ref, item) {
  const titulo = String(item?.title || "").trim().slice(0, 60);
  const precio = Number(item?.price) || 0;
  if (!titulo) throw Object.assign(new Error("Falta el título"), { status: 400 });
  if (!(precio > 0)) throw Object.assign(new Error("Poné un precio válido"), { status: 400 });
  const id = `dp_ml_${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const mlId = "MLA" + (1900000000 + Math.floor(Math.random() * 99999999));
  const sku = (item.attributes || []).find(a => a?.id === "SELLER_SKU")?.value_name || "";
  const foto = (item.pictures || []).map(p => p?.source).find(s => /^https?:\/\//i.test(s || "")) || null;
  await ref.collection("demo_products").doc(id).set({
    id, nombre: titulo, sku, precio, costo: Math.round(precio * 0.42), canal: "ml", mlId, imagen: foto,
    variantes: [{ id: `${id}_v1`, nombre: "Única", sku, stock: parseInt(item.available_quantity) || 1, precio }],
    creadoAt: new Date().toISOString(), mlEdit: { listing: item.listing_type_id || null },
  });
  return { id: mlId, permalink: permalinkML(mlId, titulo), status: "active" };
}

// Categorías de ejemplo para "Publicar en ML" (sin consultar a ML).
const CATS_ML = [
  { re: /remera|buzo|campera|camisa|ropa|pantal|musculosa/i, id: "MLA109282", name: "Remeras, Musculosas y Chombas", dom: "MLA-T_SHIRTS", path: [["MLA1430", "Ropa y Accesorios"]], talle: true },
  { re: /zapat|zapa|botin|calzado/i, id: "MLA109027", name: "Zapatillas", dom: "MLA-SNEAKERS", path: [["MLA1430", "Ropa y Accesorios"], ["MLA1276", "Calzado"]], talle: true },
  { re: /auricular|parlante|bluetooth|audio/i, id: "MLA3697", name: "Auriculares", dom: "MLA-HEADPHONES", path: [["MLA1000", "Electrónica, Audio y Video"], ["MLA409810", "Audio"]] },
  { re: /botella|termo|taza|mate|vaso/i, id: "MLA436380", name: "Botellas Térmicas", dom: "MLA-THERMAL_BOTTLES", path: [["MLA1574", "Hogar, Muebles y Jardín"], ["MLA436246", "Bazar y Cocina"]] },
  { re: /l[aá]mpara|luz|led|velador/i, id: "MLA1582", name: "Lámparas de Escritorio", dom: "MLA-DESK_LAMPS", path: [["MLA1574", "Hogar, Muebles y Jardín"], ["MLA1581", "Iluminación"]] },
  { re: /perfume|fragancia|colonia/i, id: "MLA1271", name: "Perfumes", dom: "MLA-PERFUMES", path: [["MLA1246", "Belleza y Cuidado Personal"]] },
  { re: /anteojo|lente|gafa/i, id: "MLA1912", name: "Anteojos de Sol", dom: "MLA-SUNGLASSES", path: [["MLA1430", "Ropa y Accesorios"], ["MLA1911", "Lentes y Accesorios"]] },
  { re: /mochila|cartera|bolso|billetera/i, id: "MLA1653", name: "Mochilas", dom: "MLA-BACKPACKS", path: [["MLA1430", "Ropa y Accesorios"], ["MLA1652", "Equipaje, Bolsos y Carteras"]] },
  { re: /gorra|sombrero|gorro/i, id: "MLA1461", name: "Gorras", dom: "MLA-CAPS", path: [["MLA1430", "Ropa y Accesorios"], ["MLA1460", "Accesorios de Moda"]] },
];
const CAT_OTROS = { id: "MLA1953", name: "Otros", dom: "MLA-OTHERS", path: [["MLA1953", "Otras categorías"]] };
function atributosCat(cat) {
  const colores = ["Negro", "Blanco", "Gris", "Azul", "Rojo", "Verde", "Beige"].map((n, i) => ({ id: String(52049 + i), name: n }));
  const attrs = [
    { id: "BRAND", name: "Marca", value_type: "string", tags: { required: true } },
    { id: "MODEL", name: "Modelo", value_type: "string", tags: { required: true } },
    { id: "COLOR", name: "Color", value_type: "list", values: colores, tags: { catalog_required: true } },
  ];
  if (cat?.talle) attrs.push({ id: "SIZE", name: "Talle", value_type: "list", values: ["S", "M", "L", "XL", "XXL", "38", "39", "40", "41", "42", "43"].map((n, i) => ({ id: String(3259500 + i), name: n })), tags: { required: true } });
  attrs.push(
    { id: "MATERIAL", name: "Material", value_type: "string", tags: {} },
    { id: "GTIN", name: "Código universal de producto", value_type: "string", tags: {} },
    { id: "PACKAGE_WEIGHT", name: "Peso del paquete", value_type: "number_unit", allowed_units: [{ id: "g", name: "g" }, { id: "kg", name: "kg" }], tags: {} },
  );
  return attrs;
}

/**
 * Rama demo de api/inventory.js (acciones ml_* + catálogo de plataformas).
 * leerBody() se llama SOLO si la acción se atiende acá (así el stream queda
 * intacto para el camino real). Devuelve { status, body } o null.
 */
export async function inventarioDemo(db, uid, action, req, leerBody) {
  const m = req.method; const q = req.query || {};
  const a = String(action || "");
  const PROPIAS = ["list_platform_products", "sync_sales", "import_catalog"];
  if (!a.startsWith("ml_") && !PROPIAS.includes(a)) return null;
  const ref = db.collection("users").doc(uid);
  const body = m === "POST" ? ((await leerBody()) || {}) : {};

  if (a === "sync_sales" && m === "POST") return okJ({ ok: true, processed_orders: 0, items_updated: 0, sales_logged: 0 });
  if (a === "import_catalog" && m === "POST") return okJ({ ok: true, created: 0, linked: 0, unchanged: 0, catalog: 0 });
  if (a === "list_platform_products" && m === "GET") {
    const platform = q.platform || "all";
    const productos = await leerProductos(ref);
    const products = [];
    if (platform === "all" || platform === "tiendanube") for (const p of productos.filter(x => x.canal !== "ml")) {
      products.push({ id: `TN-${p.id}`, platform: "tiendanube", platform_label: "TN", title: p.nombre, sku: p.variantes?.[0]?.sku || p.sku || "", image: p.imagen || null, price: Number(p.precio) || 0,
        variants: (p.variantes || []).map(v => ({ id: String(v.id), title: v.nombre || "Default", sku: v.sku || "" })) });
    }
    if (platform === "all" || platform === "mercadolibre") for (const p of productos.filter(x => x.canal !== "tienda" && x.mlId)) {
      products.push({ id: `ML-${p.mlId}`, platform: "mercadolibre", platform_label: "ML", title: p.mlEdit?.titulo || p.nombre, sku: p.sku || "", image: p.imagen || null, price: Number(p.mlEdit?.precio ?? p.precio) || 0 });
    }
    return okJ({ products, errors: [] });
  }

  // ── Gestor ML ──
  const u = (await ref.get()).data() || {};
  const mlStore = (u.stores || []).find(s => s.type === "mercadolibre") || {};
  const sellerId = String(mlStore.userId || DEMO_SELLER_ID);
  const nick = mlStore.nickname || "GROWITH.DEMO";

  if (a === "ml_diagnose" && m === "GET") {
    const productos = await leerProductos(ref);
    const ids = productos.filter(p => p.canal !== "tienda" && p.mlId).map(p => p.mlId);
    return okJ({ steps: [
      { name: "token", ok: true, userId: sellerId },
      { name: "users/me", ok: true, nickname: nick, site_id: "MLA", user_id: sellerId },
      { name: "items/search?status=active", ok: true, total: ids.length, results_count: ids.length, sample_ids: ids.slice(0, 3) },
    ], suggestion: "Tienda demo: las publicaciones son de ejemplo (no hay conexión real con Mercado Libre)." });
  }
  if (a === "ml_items" && m === "GET") {
    const status = q.status || "active";
    const { productos, ventas } = await leerDemo(db, uid);
    return okJ({ items: mlItemsDe(productos, ventas).filter(i => status === "all" || i.status === status) });
  }
  if ((a === "ml_item_update" || a === "ml_bulk_update") && m === "POST") {
    const ids = a === "ml_item_update" ? (body.item_id ? [String(body.item_id)] : []) : (Array.isArray(body.item_ids) ? body.item_ids.map(String) : []);
    const changes = body.changes;
    if (!ids.length) return errJ(a === "ml_item_update" ? "Falta item_id" : "Faltan item_ids");
    if (!changes || typeof changes !== "object") return errJ(a === "ml_item_update" ? "Falta changes" : "Faltan changes");
    const productos = await leerProductos(ref);
    const items = mlItemsDe(productos, []);
    const batch = db.batch(); const errors = [];
    for (const id of ids) {
      const p = productos.find(x => x.mlId === id); const it = items.find(x => x.id === id);
      if (!p || !it) { errors.push({ item_id: id, ok: false, error: "Publicación no encontrada" }); continue; }
      batch.set(ref.collection("demo_products").doc(p.id), { mlEdit: { ...(p.mlEdit || {}), ...mlEditDe(changes, it) } }, { merge: true });
    }
    await batch.commit();
    if (a === "ml_item_update") return errors.length ? errJ(errors[0].error, 404) : okJ({ ok: true, item_id: ids[0], applied: changes });
    return okJ({ ok: true, total: ids.length, ok_count: ids.length - errors.length, errors });
  }
  if (a === "ml_item_pictures" && m === "POST") {
    const { item_id, picture_urls } = body;
    if (!item_id) return errJ("Falta item_id");
    if (!Array.isArray(picture_urls) || picture_urls.length === 0) return errJ("Faltan picture_urls");
    const urls = picture_urls.filter(x => /^https?:\/\//i.test(x));
    const ps = await ref.collection("demo_products").where("mlId", "==", String(item_id)).limit(1).get();
    if (ps.empty) return errJ("Publicación no encontrada", 404);
    if (urls[0]) await ps.docs[0].ref.set({ mlEdit: { ...(ps.docs[0].data().mlEdit || {}), thumbnail: urls[0] } }, { merge: true });
    return okJ({ ok: true, item_id, pictures_count: urls.length });
  }
  if (a === "ml_seller_info" && m === "GET") {
    const { ventas } = await leerDemo(db, uid);
    const ml = ventas.filter(o => o.canal === "ml");
    const v60 = ml.filter(o => Date.parse(o.fecha) >= Date.now() - 60 * DIA).length;
    const total = ml.length + 1340; const canceled = 9 + Math.round(ml.length * 0.004);
    return okJ({
      ok: true, seller_id: sellerId, site_id: "MLA", nickname: nick,
      permalink: `https://perfil.mercadolibre.com.ar/${encodeURIComponent(nick)}`, registration_date: "2021-04-12T10:22:31.000-04:00",
      reputation: {
        level_id: "5_green", power_seller_status: "platinum",
        transactions: { period: "historic", total, completed: total - canceled, canceled, ratings: { positive: 0.97, neutral: 0.02, negative: 0.01 } },
        metrics: {
          sales: { period: "60 days", completed: v60 },
          claims: { period: "60 days", rate: 0.0061, value: Math.max(1, Math.round(v60 * 0.0061)) },
          delayed_handling_time: { period: "60 days", rate: 0.021, value: Math.round(v60 * 0.021) },
          cancellations: { period: "60 days", rate: 0.0034, value: Math.round(v60 * 0.0034) },
        },
      },
      status: { site_status: "active" },
    });
  }
  if (a === "ml_predict_category" && m === "GET") {
    const txt = String(q.q || "").trim();
    if (!txt) return errJ("Falta q (título)");
    const hits = CATS_ML.filter(c => c.re.test(txt));
    return okJ({ ok: true, suggestions: (hits.length ? hits : [CAT_OTROS]).map(c => ({ category_id: c.id, category_name: c.name, domain_id: c.dom, domain_name: c.name })) });
  }
  if (a === "ml_categories" && m === "GET") {
    const cat = String(q.cat || "").trim();
    if (!cat) return okJ({ ok: true, root: true, categories: [...new Map([...CATS_ML, CAT_OTROS].map(c => [c.path[0][0], { id: c.path[0][0], name: c.path[0][1] }])).values()] });
    const c = [...CATS_ML, CAT_OTROS].find(x => x.id === cat) || { ...CAT_OTROS, id: cat, name: cat };
    return okJ({ ok: true, id: c.id, name: c.name, path_from_root: [...c.path.map(([id, name]) => ({ id, name })), { id: c.id, name: c.name }], children: [], settings: null });
  }
  if (a === "ml_category_attributes" && m === "GET") {
    const cat = String(q.cat || "").trim();
    if (!cat) return errJ("Falta cat");
    return okJ({ ok: true, attributes: atributosCat(CATS_ML.find(x => x.id === cat)) });
  }
  if (a === "ml_listing_types" && m === "GET") return okJ({ ok: true, listing_types: [{ id: "gold_pro", name: "Premium" }, { id: "gold_special", name: "Clásica" }, { id: "free", name: "Gratuita" }] });
  if (a === "ml_upload_picture" && m === "POST") {
    if (!/^data:([^;]+);base64,/.test(String(body.data_url || ""))) return errJ("Falta data_url (imagen base64)");
    return okJ({ ok: true, id: nid("demo_pic_"), url: null });
  }
  if (a === "ml_create_item" && m === "POST") {
    if (!body.item || typeof body.item !== "object") return errJ("Falta item");
    try { return okJ({ ok: true, ...(await crearPublicacionDemo(ref, body.item)) }); }
    catch (e) { return errJ(e.message, e.status || 502); }
  }
  if (a === "ml_create_bulk" && m === "POST") {
    const items = Array.isArray(body.items) ? body.items : null;
    if (!items || !items.length) return errJ("Faltan items");
    if (items.length > 100) return errJ("Máximo 100 por tanda");
    const results = [];
    for (let i = 0; i < items.length; i++) {
      const title = items[i]?.item?.title || `#${i + 1}`;
      try { const c = await crearPublicacionDemo(ref, items[i]?.item || {}); results.push({ ok: true, title, id: c.id, permalink: c.permalink }); }
      catch (e) { results.push({ ok: false, title, error: e.message }); }
    }
    return okJ({ ok: true, total: items.length, ok_count: results.filter(r => r.ok).length, results });
  }
  if (a === "ml_questions" && m === "GET") {
    const status = String(q.status || "UNANSWERED");
    const limit = Math.min(parseInt(q.limit) || 50, 50);
    const [qs, productos] = await Promise.all([ref.collection("demo_ml_questions").get(), leerProductos(ref)]);
    const itemInfo = {};
    for (const it of mlItemsDe(productos, [])) itemInfo[it.id] = { title: it.title, thumbnail: it.thumbnail, permalink: it.permalink, price: it.price };
    const lista = qs.docs.map(d => d.data()).filter(x => x.status === status).sort((x, y) => String(y.date_created).localeCompare(String(x.date_created)));
    return okJ({ ok: true, total: lista.length, questions: lista.slice(0, limit).map(x => ({
      id: x.id, text: x.text, status: x.status, date: x.date_created, item_id: x.item_id, from: x.from?.id || null,
      answer: x.answer?.text || null, answer_date: x.answer?.date_created || null, item: itemInfo[x.item_id] || null })) });
  }
  if (a === "ml_answer" && m === "POST") {
    const question_id = body.question_id; const text = String(body.text || "").trim();
    if (!question_id || !text) return errJ("Falta question_id o text");
    const qref = ref.collection("demo_ml_questions").doc(String(question_id));
    if (!(await qref.get()).exists) return errJ("La pregunta no existe", 404);
    await qref.set({ status: "ANSWERED", answer: { text, date_created: new Date().toISOString() } }, { merge: true });
    return okJ({ ok: true, question_id });
  }
  if (a === "ml_orders" && m === "GET") {
    const limit = Math.min(parseInt(q.limit) || 40, 50);
    const offset = parseInt(q.offset) || 0;
    const { ventas } = await leerDemo(db, uid);
    const ml = ventas.filter(o => o.canal === "ml");
    const orders = ml.slice(offset, offset + limit).map(mlOrderDemo).map(r => ({
      id: r.id, pack_id: r.id, date: r.date_created, status: r.status, total: r.total_amount, currency: "ARS",
      buyer: r.buyer?.nickname || "", buyer_id: r.buyer?.id || null,
      items: (r.order_items || []).map(oi => ({ title: oi.item?.title, qty: oi.quantity, unit_price: oi.unit_price, item_id: oi.item?.id, variation: oi.item?.variation_attributes?.map(v => v.value_name).join(" / ") || "" })),
      shipping_id: r.shipping?.id || null,
    }));
    return okJ({ ok: true, total: ml.length, offset, orders });
  }
  if (a === "ml_inbox" && m === "GET") {
    const cs = await ref.collection("demo_ml_chats").get();
    const conversations = cs.docs.map(d => d.data()).filter(c => (c.messages || []).length).map(c => {
      const msgs = [...c.messages].sort((x, y) => String(x.date).localeCompare(String(y.date)));
      const last = msgs[msgs.length - 1];
      return { pack_id: String(c.pack_id), order_id: c.order_id, date: c.date, status: c.status || "paid", buyer: c.buyer || "", buyer_id: c.buyer_id || null,
        items: c.items || [], last_text: last.text, last_date: last.date, last_mine: last.role === "seller", count: msgs.length, unread: c.unread || 0 };
    }).sort((x, y) => String(y.last_date).localeCompare(String(x.last_date)));
    return okJ({ ok: true, seller_id: sellerId, scanned: conversations.length, conversations });
  }
  if (a === "ml_messages" && m === "GET") {
    const pack = String(q.pack_id || "").trim();
    if (!pack) return errJ("Falta pack_id");
    const cref = ref.collection("demo_ml_chats").doc(pack);
    const s = await cref.get();
    const c = s.exists ? s.data() : null;
    if (c && q.mark_read === "1" && c.unread) await cref.set({ unread: 0 }, { merge: true });
    const buyer = String(c?.buyer_id || "");
    const messages = (c?.messages || []).slice().sort((x, y) => String(x.date).localeCompare(String(y.date))).map(x => ({
      id: x.id, from: x.role === "seller" ? sellerId : buyer, to: x.role === "seller" ? buyer : sellerId, text: x.text || "", date: x.date, mine: x.role === "seller" }));
    return okJ({ ok: true, seller_id: sellerId, messages });
  }
  if (a === "ml_send_message" && m === "POST") {
    const pack = String(body.pack_id || "").trim(); const to = body.to_user_id; const text = String(body.text || "").trim();
    if (!pack || !to || !text) return errJ("Falta pack_id, to_user_id o text");
    const cref = ref.collection("demo_ml_chats").doc(pack);
    const s = await cref.get();
    const msg = { id: nid("msg_"), role: "seller", text, date: new Date().toISOString() };
    if (s.exists) {
      await cref.set({ messages: [...(s.data().messages || []), msg], unread: 0 }, { merge: true });
    } else {
      let info = { buyer: "", items: [], date: msg.date };
      try {
        const od = await ref.collection("demo_orders").doc(pack).get();
        if (od.exists) { const mo = mlOrderDemo({ id: od.id, ...od.data() }); info = { buyer: mo.buyer?.nickname || "", items: (mo.order_items || []).map(oi => ({ title: oi.item?.title, qty: oi.quantity })), date: od.data().fecha || msg.date }; }
      } catch (_) {}
      await cref.set({ pack_id: pack, order_id: pack, buyer_id: String(to), status: "paid", ...info, messages: [msg], unread: 0, demo: true });
    }
    return okJ({ ok: true, pack_id: pack });
  }
  return errJ(`Acción no disponible en la tienda demo: ${a}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// SEMILLA / LIMPIEZA
// ═════════════════════════════════════════════════════════════════════════════
const PREGUNTAS = [
  // [producto, pregunta, respuesta | null (sin responder), horas atrás]
  ["Auriculares Bluetooth", "¡Hola! ¿Son compatibles con iPhone? ¿Cuántas horas dura la batería?", null, 0.6],
  ["Zapatillas Urban", "¿Qué horma tienen? En otras marcas calzo 42, ¿me pido 42 o 43?", null, 2.2],
  ["Remera Oversize", "¿Tenés la blanca en talle L? La necesito para el viernes, ¿llega a Rosario?", null, 5.4],
  ["Botella Térmica 750 ml", "¿Mantiene el agua fría todo el día? ¿Se puede lavar en el lavavajillas?", null, 11],
  ["Buzo Canguro", "¿Es de algodón frisado? ¿Destiñe al lavarlo?", "¡Hola! Sí, es algodón frisado 80/20 y no destiñe. Recomendamos lavarlo del revés con agua fría. ¡Saludos!", 26],
  ["Perfume 100 ml", "¿Es original? ¿Viene con la caja sellada?", "¡Hola! Sí, es 100% original y viene con caja sellada y factura. ¡Te esperamos!", 41],
  ["Lámpara LED de escritorio", "¿Tiene regulador de intensidad? ¿Qué potencia tiene?", "¡Hola! Tiene 3 temperaturas de luz y 5 niveles de intensidad, 10 W. Se carga por USB-C.", 58],
  ["Anteojos de Sol", "¿Tienen protección UV400? ¿Son polarizados?", "¡Hola! Sí, UV400 y lentes polarizados categoría 3. Incluyen estuche y paño.", 77],
  ["Zapatillas Urban", "¿Hacen cambio si no me queda el talle?", "¡Sí! Tenés 30 días para cambiarlas sin cargo por Mercado Libre, solo tienen que estar sin uso.", 102],
  ["Auriculares Bluetooth", "¿Tienen cancelación de ruido?", "¡Hola! Tienen cancelación pasiva y modo ambiente. La batería rinde hasta 30 h con el estuche.", 130],
  ["Remera Oversize", "¿Cuánto mide de largo el talle M?", "¡Hola! El M mide 74 cm de largo y 58 cm de ancho de axila a axila.", 165],
  ["Botella Térmica 750 ml", "¿Hacen factura A?", "¡Hola! Sí, emitimos factura A. Cargá tus datos fiscales al comprar y te llega con el pedido.", 210],
];
// [rol, minutos después de la venta, texto]
const CHATS = [
  { venta: 0, unread: 0, msgs: [["buyer", 25, "¡Hola! Compré recién, ¿me confirmás que sale hoy?"], ["seller", 48, "¡Hola! Gracias por tu compra 🙌 Sale hoy a la tarde y te llega el seguimiento por Mercado Libre."], ["buyer", 55, "Genial, ¡gracias!"]] },
  { venta: 1, unread: 1, msgs: [["buyer", 40, "Buenas, ¿puedo cambiar el color antes de que lo despachen?"]] },
  { venta: 5, unread: 0, msgs: [["seller", 30, "¡Hola! Tu pedido ya está en camino 🚚 Cualquier cosa escribinos por acá."], ["buyer", 2900, "Llegó perfecto y súper bien embalado. ¡Gracias!"], ["seller", 2960, "¡Qué bueno! Si te gustó, tu calificación nos ayuda muchísimo ⭐"]] },
  { venta: 3, unread: 1, msgs: [["buyer", 60, "Hola, necesito factura A a nombre de mi empresa, ¿cómo hago?"], ["seller", 95, "¡Hola! Pasanos razón social y CUIT por acá y te la enviamos en el día."], ["buyer", 130, "Dale, te paso los datos: Estudio Norte SRL, CUIT 30-00000000-0"]] },
  { venta: 8, unread: 0, msgs: [["buyer", 15, "¿El envío es a domicilio o lo tengo que retirar?"], ["seller", 42, "¡Hola! Es a domicilio con Mercado Envíos: te llega en 2 a 4 días hábiles."]] },
  { venta: 12, unread: 2, msgs: [["buyer", 3100, "Hola, me llegó con un golpecito en la caja 😕"], ["seller", 3140, "¡Hola! Qué pena, disculpá. Mandanos una foto y te enviamos otro sin cargo o te devolvemos el dinero, como prefieras."], ["buyer", 3190, "Te mando la foto por acá, prefiero el cambio"], ["buyer", 3192, "¿En cuánto me llegaría el nuevo?"]] },
];

function metaCuentaDemo(nowIso) {
  return {
    id: DEMO_META.accId, user_id: DEMO_META.accId, user_name: DEMO_META.userName, email: DEMO_META.email,
    ad_account_id: DEMO_META.adAccountId, ad_account_name: DEMO_META.adAccountName,
    page_id: DEMO_META.pageId, page_name: DEMO_META.pageName, ig_account_id: DEMO_META.igId, ig_username: DEMO_META.igUser,
    pixel_id: DEMO_META.pixelId, currency: DEMO_META.currency, timezone_name: DEMO_META.tz,
    oauth: false, demo: true, created_at: nowIso, connected_at: nowIso,
    last_test: { ok: true, ts: nowIso, msg: "Cuenta de demostración: datos de ejemplo, sin token de Meta" },
    demo_overrides: { status: {}, budget: {} }, demo_extra: { campaigns: [], adsets: [], ads: [] },
  };
}

async function borrarDocs(db, docs) {
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
}

/**
 * Siembra lo que la demo necesita para Meta / Google Ads / Mercado Libre y
 * devuelve el patch a mergear en users/{tid} (Meta y Google Ads "conectados").
 * Conviene llamarla DESPUÉS de sembrar demo_products / demo_orders (los chats
 * se atan a las ventas de ML más recientes; sin ventas usa pedidos de ejemplo).
 */
export async function seedAdsDemo(db, tid) {
  const ref = db.collection("users").doc(tid);
  const now = Date.now(); const nowIso = new Date(now).toISOString();
  await limpiarAdsDemo(db, tid);

  let productos = await leerProductos(ref);
  if (!productos.length) productos = productosDemo();
  const mlProds = productos.filter(p => p.canal !== "tienda" && p.mlId);
  const batch = db.batch();

  // Meta: cuenta publicitaria de ejemplo (sin access_token)
  batch.set(ref.collection("meta_accounts").doc(DEMO_META.accId), metaCuentaDemo(nowIso));

  // ML: preguntas pre-venta
  if (mlProds.length) PREGUNTAS.forEach(([prod, texto, resp, horas], i) => {
    const p = mlProds.find(x => x.nombre === prod) || mlProds[i % mlProds.length];
    const id = 13000000001 + i;
    const fecha = now - horas * 3600000;
    batch.set(ref.collection("demo_ml_questions").doc(String(id)), {
      id, text: texto, status: resp ? "ANSWERED" : "UNANSWERED", date_created: new Date(fecha).toISOString(),
      item_id: p.mlId, from: { id: 700000 + i * 37 },
      answer: resp ? { text: resp, date_created: new Date(fecha + (20 + i * 7) * 60000).toISOString() } : null, demo: true,
    });
  });

  // ML: mensajes post-venta atados a las ventas de ML más recientes
  let ventasML = [];
  try {
    const os = await ref.collection("demo_orders").where("canal", "==", "ml").get();
    ventasML = os.docs.map(d => ({ id: d.id, ...d.data() })).sort((x, y) => Date.parse(y.fecha) - Date.parse(x.fecha));
  } catch (_) {}
  CHATS.forEach((c, i) => {
    let o = ventasML.length ? ventasML[Math.min(c.venta, ventasML.length - 1)] : null;
    if (o && CHATS.slice(0, i).some(x => ventasML[Math.min(x.venta, ventasML.length - 1)]?.id === o.id)) o = null; // pocas ventas: no repetir
    if (!o && mlProds.length) {
      const p = mlProds[i % mlProds.length]; const v = p.variantes?.[0] || {};
      o = { id: String(2000004900000 + i), fecha: new Date(now - (c.venta + 1) * 20 * 3600000).toISOString(), canal: "ml", medio: "ml_clasica", total: p.precio,
        items: [{ prodId: p.id, varId: v.id || p.id, sku: v.sku || p.sku, nombre: p.nombre, variante: v.nombre || "", qty: 1, precio: p.precio, mlId: p.mlId }], cliente: { nombre: "Comprador" } };
    }
    if (!o) return;
    const mo = mlOrderDemo(o);
    const t0 = Date.parse(o.fecha);
    const n = c.msgs.length;
    const messages = c.msgs.map(([role, min, text], k) => ({
      id: `msg_${o.id}_${k + 1}`, role, text,
      date: new Date(Math.min(t0 + min * 60000, now - (n - k) * 90000)).toISOString(),
    }));
    batch.set(ref.collection("demo_ml_chats").doc(String(o.id)), {
      pack_id: String(o.id), order_id: mo.id, date: o.fecha, status: "paid",
      buyer: mo.buyer?.nickname || "", buyer_id: String(mo.buyer?.id || ""),
      items: (mo.order_items || []).map(oi => ({ title: oi.item?.title, qty: oi.quantity })),
      messages, unread: c.unread, demo: true,
    });
  });
  await batch.commit();
  _ventas.delete(tid); _flag.delete(tid);

  const cuentaG = gadsDemoCuentas().accounts[0];
  return {
    // Meta "conectado": el front mira metaAccounts.length y meta_active_account
    metaAccounts: [{ id: DEMO_META.accId, name: DEMO_META.userName, ad_account_id: DEMO_META.adAccountId, demo: true }],
    meta_active_account: DEMO_META.accId,
    // Google Ads "conectado" SIN refresh_token: nada del camino real (orders.js,
    // mcp.js, refresh de tokens) intenta usarlo; google-ads.js responde por la rama demo.
    googleAds: {
      connected: true, demo: true, demoUid: tid, email: DEMO_META.email, connectedAt: nowIso,
      customers: [DEMO_GADS.customer], customersInfo: [cuentaG], customersInfoAt: nowIso, customersError: null,
      demoStatus: {}, demoExtra: [],
    },
  };
}

/**
 * Borra lo que creó seedAdsDemo (cuenta Meta demo, preguntas y chats de ML) y
 * devuelve el patch para "desconectar" Meta / Google Ads en users/{tid}.
 */
export async function limpiarAdsDemo(db, tid) {
  const ref = db.collection("users").doc(tid);
  const [accs, qs, cs] = await Promise.all([
    ref.collection("meta_accounts").get(),
    ref.collection("demo_ml_questions").get(),
    ref.collection("demo_ml_chats").get(),
  ]);
  await borrarDocs(db, [...accs.docs.filter(d => d.data()?.demo === true), ...qs.docs, ...cs.docs]);
  _ventas.delete(tid);
  return { metaAccounts: [], meta_active_account: null, googleAds: null };
}
