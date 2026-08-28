import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getValidMLToken } from "./integrations.js";
import { guardUid, guardCron, isCronRequest } from "./_auth.js";

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

// ─── Rendimiento helpers (antiguo rendimiento.js) ────────────────────────
const META_V = "v23.0"; // mantener sincronizada con api/meta.js y api/meta-callback.js
const META_BASE = `https://graph.facebook.com/${META_V}`;

async function metaGet(path, params, token) {
  const url = new URL(`${META_BASE}/${path}`);
  url.searchParams.set("access_token", token);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString());
  const j = await r.json();
  if (j.error) throw new Error(`Meta API: ${j.error.message}`);
  return j;
}

async function fetchMetaDailySpend(cfg, since, until, errRef) {
  if (!cfg?.access_token || !cfg.ad_account_id) return {};
  try {
    const res = await metaGet(`${cfg.ad_account_id}/insights`, {
      level: "account",
      fields: "spend,actions,action_values,purchase_roas,impressions,clicks,reach",
      "time_range[since]": since, "time_range[until]": until,
      time_increment: "1",
      action_attribution_windows: JSON.stringify(["1d_click","1d_view"]),
      limit: "90",
    }, cfg.access_token);
    const byDate = {};
    for (const row of (res.data || [])) {
      const date = row.date_start; if (!date) continue;
      byDate[date] = {
        spend: parseFloat(row.spend) || 0,
        roas: parseFloat((row.purchase_roas || [])[0]?.value) || 0,
        purchases: parseFloat((row.actions || []).find(a => a.action_type==="purchase")?.value || 0),
        purchaseVal: parseFloat((row.action_values || []).find(a => a.action_type==="purchase")?.value || 0),
        impressions: parseInt(row.impressions) || 0, clicks: parseInt(row.clicks) || 0, reach: parseInt(row.reach) || 0,
      };
    }
    return byDate;
  } catch(e) {
    console.error("Meta daily spend error:", e.message);
    if (errRef && /expired|invalid.*token|oauth|session|\b190\b|access token/i.test(e.message||"")) errRef.expired = true;
    return {};
  }
}

// ── Cotización histórica del dólar, día por día ─────────────────────────
// El Ad Spend de Meta se factura en USD (habitualmente al tipo cripto) y se
// trae día por día — convertirlo con UNA sola cotización actual distorsiona
// los días viejos cuando el dólar se mueve. Serie completa por "casa"
// (oficial/blue/bolsa=mep/cripto), cacheada en memoria por instancia warm
// (los valores de días pasados no cambian; el de hoy se refresca solo).
const _dolarHistCache = new Map(); // casa -> { ts, map: Map(fecha->venta) }
const _mlAdvCache = new Map(); // uid -> { ts, id: advertiser_id, site } (Mercado Ads)
const _DOLAR_HIST_TTL = 3600000; // 1h — alcanza para no repegar en cada request
async function fetchDolarHistorico(casa) {
  const hit = _dolarHistCache.get(casa);
  if (hit && Date.now() - hit.ts < _DOLAR_HIST_TTL) return hit.map;
  try {
    const r = await fetch(`https://api.argentinadatos.com/v1/cotizaciones/dolares/${casa}`);
    const j = await r.json();
    const map = new Map();
    for (const row of (Array.isArray(j) ? j : [])) {
      const v = parseFloat(row.venta);
      if (row.fecha && isFinite(v) && v > 0) map.set(row.fecha, v);
    }
    if (map.size) { _dolarHistCache.set(casa, { ts: Date.now(), map }); return map; }
  } catch (e) { console.error("Dólar histórico error:", e.message); }
  return hit?.map || new Map(); // si falla y había cache vieja, mejor eso que nada
}
// Cotización de una fecha puntual: exacta si existe, sino el día hábil
// anterior más cercano (fines de semana/feriados no siempre tienen registro
// para oficial/blue/mep — cripto cotiza todos los días).
// Id de documento para el registro del warmer. Firestore no admite "/" en los
// ids, y las claves de caché pueden traer fechas y separadores.
function warmDocId(uid, key) {
  return `${uid}__${String(key||"").replace(/[^\w.-]/g, "_")}`.slice(0, 400);
}

function dolarDeFecha(map, fecha) {
  if (map.has(fecha)) return map.get(fecha);
  let d = fecha;
  for (let i = 0; i < 7; i++) {
    d = new Date(new Date(d + "T12:00:00Z").getTime() - 86400000).toISOString().slice(0, 10);
    if (map.has(d)) return map.get(d);
  }
  return null;
}

function buildRendRows(since, until, dailyRevenue, dailyOrders, metaDailySpend, commission) {
  const allDates = new Set([...Object.keys(dailyRevenue), ...Object.keys(dailyOrders), ...Object.keys(metaDailySpend)]);
  const start = new Date(since + "T12:00:00"); const end = new Date(until + "T12:00:00");
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) allDates.add(d.toISOString().slice(0,10));
  return [...allDates].sort().map(date => {
    const revenue = dailyRevenue[date] || 0; const orders = dailyOrders[date] || 0;
    const adSpend = metaDailySpend[date]?.spend || 0; const netRevenue = revenue * (1 - commission);
    const profit = netRevenue - adSpend; const roas = adSpend > 0 ? revenue / adSpend : 0;
    const trueRoas = adSpend > 0 ? netRevenue / adSpend : 0; const cpa = orders > 0 ? adSpend / orders : 0;
    return {
      Fecha: date, "Ordenes > $0": orders, Revenue: revenue, "Ad Spend": adSpend,
      "Net Revenue": parseFloat(netRevenue.toFixed(2)), Profit: parseFloat(profit.toFixed(2)),
      "Profit Margin": revenue > 0 ? parseFloat((profit/revenue).toFixed(6)) : 0,
      ROAS: parseFloat(roas.toFixed(4)), "True ROAS": parseFloat(trueRoas.toFixed(4)),
      CPA: parseFloat(cpa.toFixed(2)),
      _impressions: metaDailySpend[date]?.impressions || 0, _clicks: metaDailySpend[date]?.clicks || 0,
      _reach: metaDailySpend[date]?.reach || 0,
    };
  });
}

function computeRendTotals(rows) {
  const t = rows.reduce((acc, r) => ({
    orders: acc.orders + (r["Ordenes > $0"] || 0), revenue: acc.revenue + (r.Revenue || 0),
    adSpend: acc.adSpend + (r["Ad Spend"] || 0), netRevenue: acc.netRevenue + (r["Net Revenue"] || 0),
    profit: acc.profit + (r.Profit || 0), impressions: acc.impressions + (r._impressions || 0),
    clicks: acc.clicks + (r._clicks || 0),
  }), {orders:0,revenue:0,adSpend:0,netRevenue:0,profit:0,impressions:0,clicks:0});
  return { ...t, roas: t.adSpend>0?t.revenue/t.adSpend:0, trueRoas: t.adSpend>0?t.netRevenue/t.adSpend:0,
    cpa: t.orders>0?t.adSpend/t.orders:0, profitMargin: t.revenue>0?t.profit/t.revenue:0,
    ctr: t.impressions>0?t.clicks/t.impressions:0 };
}

function computeRendDow(rows) {
  const DAYS = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];
  const agg = Array.from({length:7}, (_,i) => ({dow:i, label:DAYS[i], revenue:0, adSpend:0, profit:0, orders:0, days:0}));
  rows.forEach(r => {
    const d = new Date(r.Fecha + "T12:00:00").getDay();
    agg[d].revenue += r.Revenue||0; agg[d].adSpend += r["Ad Spend"]||0;
    agg[d].profit += r.Profit||0; agg[d].orders += r["Ordenes > $0"]||0; agg[d].days++;
  });
  return agg.map(d => ({ ...d, avgRevenue: d.days>0?d.revenue/d.days:0, avgProfit: d.days>0?d.profit/d.days:0, avgOrders: d.days>0?d.orders/d.days:0 }));
}
// ─── fin Rendimiento helpers ──────────────────────────────────────────────

// Sin fallback — se requiere uid válido con tienda conectada

async function fetchPage(storeId, accessToken, extraParams, page, perPage=200) {
  const headers = {
    'Authentication': `bearer ${accessToken}`,
    'User-Agent': 'GrowithApp (contacto.growith@gmail.com)'
  };
  const url = `https://api.tiendanube.com/v1/${storeId}/orders?per_page=${perPage}&page=${page}${extraParams ? "&" + extraParams : ""}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`TN API error ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// Cuenta órdenes leyendo el header X-Total-Count de TN (1 request de ~1KB en vez
// de paginar payloads completos). Devuelve null si el header no viene, para que
// el caller caiga al conteo paginado.
async function fetchTNCount(storeId, accessToken, extraParams = "") {
  const headers = {
    'Authentication': `bearer ${accessToken}`,
    'User-Agent': 'GrowithApp (contacto.growith@gmail.com)'
  };
  const url = `https://api.tiendanube.com/v1/${storeId}/orders?per_page=1&page=1${extraParams ? "&" + extraParams : ""}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) return 0;
  if (!res.ok) throw new Error(`TN API error ${res.status}`);
  const total = parseInt(res.headers.get("x-total-count"), 10);
  return Number.isFinite(total) ? total : null;
}

// Cache en memoria por instancia warm de Vercel — absorbe las llamadas duplicadas
// que hacen Home y Envíos al mismo tab con segundos de diferencia, sin re-pegar a TN.
const _tabCache = new Map();
const _TAB_CACHE_TTL = 60000;
function tabCacheGet(key) {
  const e = _tabCache.get(key);
  if (e && Date.now() - e.ts < _TAB_CACHE_TTL) return e.body;
  if (e) _tabCache.delete(key);
  return null;
}
function tabCacheSet(key, body) {
  if (_tabCache.size > 200) _tabCache.clear();
  _tabCache.set(key, { ts: Date.now(), body });
}

// Variante rápida: TN tarda ~14s en generar una página de 200 órdenes completas,
// pero ~4s una de 50. Con el count del header sabemos cuántas páginas de 50 pedir
// en paralelo → una sola ronda de ~4-5s en vez de 14-19s.
// Una página que falla (429/timeout de TN) se reintenta; si vuelve a fallar se
// TIRA error. Antes se tragaba como [] y una página fallida del medio devolvía
// la lista truncada como si fuera completa — pedidos invisibles que no se
// despachaban, cacheados 24h sin ningún indicio.
async function fetchPageRetry(storeId, accessToken, extraParams, page, perPage) {
  try { return await fetchPage(storeId, accessToken, extraParams, page, perPage); }
  catch (_) {
    await new Promise(r => setTimeout(r, 700));
    return await fetchPage(storeId, accessToken, extraParams, page, perPage);
  }
}
async function fetchAllPagesFast(storeId, accessToken, extraParams = "", perPage = 50) {
  let total = null;
  try { total = await fetchTNCount(storeId, accessToken, extraParams); } catch (_) {}
  if (total === 0) return [];
  const maxPage = total ? Math.min(Math.ceil(total / perPage), 40) : 20;
  const pages = await Promise.all(
    Array.from({ length: maxPage }, (_, i) =>
      fetchPageRetry(storeId, accessToken, extraParams, i + 1, perPage)
    )
  );
  let all = [];
  for (const pg of pages) { all = all.concat(pg); if (pg.length < perPage) break; }
  if (total != null && all.length < total && all.length < maxPage * perPage) {
    // Sanity: el count dijo más de lo que juntamos y no fue por el tope de páginas
    console.warn(`[orders] TN parcial: count=${total} juntadas=${all.length}`);
  }
  return all;
}

async function fetchAllPages(storeId, accessToken, extraParams = "") {
  const first = await fetchPage(storeId, accessToken, extraParams, 1);
  if (first.length === 0 || first.length < 200) return first;
  const extras = await Promise.all(
    [2,3,4,5,6,7,8,9,10].map(p =>
      fetchPageRetry(storeId, accessToken, extraParams, p, 200)
    )
  );
  let all = [...first];
  for (const page of extras) {
    if (page.length === 0) break;
    all = all.concat(page);
    if (page.length < 200) break;
  }
  return all;
}

export default async function handler(req, res) {
  { const _o=String(req.headers.origin||""); res.setHeader("Access-Control-Allow-Origin", (["https://www.growithapp.com","https://growithapp.com","https://soluna-gestion.vercel.app"].includes(_o)||/^https:\/\/[a-z0-9-]+-soluna1\.vercel\.app$/.test(_o)||/^http:\/\/localhost(:\d+)?$/.test(_o))?_o:"https://www.growithapp.com"); } // allowlist CORS (regex anclada)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { uid, tab, countOnly, q, action } = req.query;
  // `countOnly` llega como '1' desde unos llamadores y como 'true' desde otros:
  // se normaliza UNA vez y todas las ramas cortan por esta variable. (Antes el
  // gate de auth miraba '1' y las ramas comparaban con 'true', así que un
  // countOnly=1 sin sesión devolvía el listado completo de pedidos con PII.)
  const _countOnly = countOnly === 'true' || countOnly === '1';

  // ── Autorización ──
  // Todo lo que devuelve este endpoint pertenece a UNA cuenta: pedidos con
  // nombre/DNI/teléfono/dirección, métricas, cupones. Se exige token válido Y
  // atado al uid pedido, sin excepciones por tab/acción/countOnly. Va ANTES
  // del cache de tabs para que tampoco se sirvan respuestas cacheadas.
  // Único camino sin sesión de usuario: los crons, que corren server-side con
  // CRON_SECRET y necesitan operar sobre uids ajenos (warm_margenes recalcula
  // la caché de Márgenes llamándose a sí mismo con action=daily_metrics).
  // ── Portal público de cupón (token compartible, sin sesión) ─────────────
  // El dueño de un código de descuento ve SUS ventas y comisión en tiempo
  // real. El token vive en cupon_links/{token} = {uid, code, comisionPct,
  // mpComision, influencer}. Devuelve SOLO agregados del cupón — nunca PII.
  if (action === 'cupon_publico') {
    const token = String(req.query.token || "").trim();
    if (!/^[a-f0-9]{20,64}$/.test(token)) return res.status(400).json({ error: "token inválido" });
    const db = initAdmin();
    const linkSnap = await db.collection("cupon_links").doc(token).get();
    if (!linkSnap.exists) return res.status(404).json({ error: "Este link no existe o fue dado de baja." });
    const link = linkSnap.data();
    const uSnap = await db.collection("users").doc(link.uid).get();
    const stores = uSnap.exists ? (uSnap.data().stores || []) : [];
    const tn = stores.find(s => s.type === "tiendanube" && s.accessToken && s.storeId);
    const shp = stores.find(s => s.type === "shopify" && s.accessToken && s.shop);
    if (!tn && !shp) return res.status(503).json({ error: "La tienda no está conectada en este momento." });
    const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const mesAct = hoy.slice(0, 7);
    // Rango libre (desde/hasta YYYY-MM-DD) del selector de período; fallback:
    // mes (YYYY-MM) de links viejos, y sin nada → mes en curso.
    const isoRe = /^\d{4}-\d{2}-\d{2}$/;
    let desde = String(req.query.desde || "").trim();
    let hasta = String(req.query.hasta || "").trim();
    if (!isoRe.test(desde) || !isoRe.test(hasta)) {
      const mesQ = String(req.query.mes || "").trim();
      const mes = /^\d{4}-(0[1-9]|1[0-2])$/.test(mesQ) ? mesQ : mesAct;
      desde = mes + "-01";
      const finMes = new Date(+mes.slice(0, 4), +mes.slice(5, 7), 0).getDate();
      hasta = mes === mesAct ? hoy : `${mes}-${String(finMes).padStart(2, "0")}`;
    }
    if (hasta > hoy) hasta = hoy;
    if (desde > hasta) return res.status(400).json({ error: "rango inválido" });
    if ((new Date(hasta) - new Date(desde)) / 86400000 > 400) return res.status(400).json({ error: "El rango máximo es de un año." });
    const code = String(link.code || "").toUpperCase().trim();
    // Cache en Firestore por rango: un período que ya terminó no cambia nunca
    // (TTL 24h por las dudas); uno que incluye hoy, 3 min. Abrir el link o
    // cambiar el período pega acá casi siempre en vez del barrido de TN.
    const cacheRef = db.collection("cupon_links").doc(token).collection("cache").doc(`${desde}_${hasta}`);
    const ttl = hasta < hoy ? 24 * 3600000 : 3 * 60000;
    // Modo diagnóstico (&debug=1): saltea la caché y devuelve qué rama corrió,
    // el status HTTP de cada página y cuántas órdenes/códigos vio — solo
    // agregados, sin PII. Para depurar "el panel muestra 0" sin acceso a logs.
    const _dbg = req.query.debug === "1" ? { rama: tn ? "tiendanube" : "shopify", paginas: [], codigos: {} } : null;
    try {
      const hit = await cacheRef.get();
      if (!_dbg && hit.exists && Date.now() - (hit.data().ts || 0) < ttl) return res.status(200).json(hit.data().resp);
    } catch (_) {}
    let usos = 0, ventas = 0, descuento = 0;
    if (tn) {
      const tnHeaders = { 'Authentication': `bearer ${tn.accessToken}`, 'User-Agent': 'GrowithApp (contacto.growith@gmail.com)' };
      const urlPg = (p) => `https://api.tiendanube.com/v1/${tn.storeId}/orders?payment_status=paid&per_page=200&page=${p}&fields=id,coupon,total,discount_coupon&created_at_min=${encodeURIComponent(desde + "T00:00:00-0300")}&created_at_max=${encodeURIComponent(hasta + "T23:59:59-0300")}`;
      // Una página fallida (429/timeout de TN) se reintenta; si vuelve a fallar
      // devuelve null — NUNCA [] silencioso: antes un 429 en la página 1
      // cortaba el barrido, respondía ceros y encima los cacheaba ("no cargan
      // los datos" del panel de la influencer).
      const fetchPgUna = async (p) => {
        const r = await fetch(urlPg(p), { headers: tnHeaders, signal: AbortSignal.timeout(15000) });
        if (_dbg && (r.status !== 404 || p === 1)) _dbg.paginas.push({ p, status: r.status });
        if (r.status === 404) return []; // más allá de la última página
        if (!r.ok) throw new Error(`TN HTTP ${r.status}`);
        const j = await r.json();
        if (_dbg) _dbg.paginas[_dbg.paginas.length - 1].ordenes = Array.isArray(j) ? j.length : -1;
        return Array.isArray(j) ? j : [];
      };
      const fetchPg = async (p) => {
        try { return await fetchPgUna(p); }
        catch (_) {
          await new Promise(r => setTimeout(r, 700));
          try { return await fetchPgUna(p); }
          catch (e) { if (_dbg) _dbg.paginas.push({ p, error: String(e?.message || e).slice(0, 80) }); return null; }
        }
      };
      // Lotes de 5 páginas en paralelo (antes era secuencial: hasta 15 round-trips)
      let allOrders = [], falloTn = false;
      for (let start = 1; start <= 15; start += 5) {
        const chunk = await Promise.all([0, 1, 2, 3, 4].map(i => fetchPg(start + i)));
        let fin = false;
        for (const pg of chunk) {
          if (pg === null) { falloTn = true; fin = true; break; }
          allOrders = allOrders.concat(pg);
          if (pg.length < 200) { fin = true; break; }
        }
        if (fin) break;
      }
      if (falloTn) {
        const resp503 = { error: "La tienda no respondió en este momento — tocá Actualizar en unos segundos." };
        if (_dbg) resp503.debug = _dbg;
        return res.status(503).json(resp503);
      }
      for (const o of allOrders) {
        for (const c of (Array.isArray(o.coupon) ? o.coupon : [])) {
          const cc = (c.code || "").toUpperCase().trim();
          // Solo contamos el código pedido: mapear TODOS filtraría los demás
          // cupones del tenant a cualquiera que tenga un link público.
          if (_dbg && cc === code) _dbg.codigos[cc] = (_dbg.codigos[cc] || 0) + 1;
          if (cc !== code) continue;
          usos++; ventas += parseFloat(o.total || 0); descuento += parseFloat(o.discount_coupon || 0);
        }
      }
      if (_dbg) _dbg.totalOrdenes = allOrders.length;
    } else {
      // Shopify: mismo agregado leyendo discount_codes[] con paginación por cursor.
      const shHeaders = { 'X-Shopify-Access-Token': shp.accessToken, 'Content-Type': 'application/json' };
      let url = `https://${shp.shop}/admin/api/2024-10/orders.json?limit=250&status=any&financial_status=paid&fields=id,total_price,discount_codes,cancelled_at&created_at_min=${encodeURIComponent(desde + "T00:00:00-0300")}&created_at_max=${encodeURIComponent(hasta + "T23:59:59-0300")}`;
      let safety = 0, falloShp = false;
      while (url && safety < 12) {
        safety++;
        try {
          const r = await fetch(url, { headers: shHeaders, signal: AbortSignal.timeout(15000) });
          if (!r.ok) { falloShp = true; break; }
          const d = await r.json();
          for (const o of (d.orders || [])) {
            if (o.cancelled_at) continue;
            for (const c of (o.discount_codes || [])) {
              if ((c.code || "").toUpperCase().trim() !== code) continue;
              usos++; ventas += parseFloat(o.total_price || 0); descuento += parseFloat(c.amount || 0);
            }
          }
          const lk = r.headers.get("Link") || "";
          const nx = lk.match(/<([^>]+)>;\s*rel="next"/);
          url = nx ? nx[1] : null;
        } catch (_) { falloShp = true; break; }
      }
      // Igual que la rama TN: nunca responder (ni cachear) ceros falsos
      if (falloShp) return res.status(503).json({ error: "La tienda no respondió en este momento — tocá Actualizar en unos segundos." });
    }
    const pct = Number(link.comisionPct) || 0;
    const neto = (ventas - descuento) * (1 - (Number(link.mpComision) || 0) / 100);
    const resp = {
      ok: true, code, influencer: link.influencer || "",
      periodo: { desde, hasta },
      usos, ventas: Math.round(ventas), descuento: Math.round(descuento),
      neto: Math.round(neto), comisionPct: pct, comision: Math.round(neto * (pct / 100)),
    };
    if (_dbg) return res.status(200).json({ ...resp, _debug: _dbg }); // sin cachear
    try { await cacheRef.set({ ts: Date.now(), resp }); } catch (_) {}
    return res.status(200).json(resp);
  }

  if (action === 'warm_margenes') {
    if (!guardCron(req, res)) return;
  } else if (!isCronRequest(req)) {
    if (!uid) return res.status(401).json({ error: "uid requerido" });
    // Sección exigida a los miembros de equipo según la acción: las métricas
    // del Dashboard son "margenes", los cupones "canjes", el resto "envios".
    const _seccion = (action === 'daily_metrics') ? 'margenes'
      : (action === 'coupons' || action === 'cupon_link') ? 'canjes'
      : 'envios';
    if (!(await guardUid(req, res, uid, _seccion))) return;
  }

  // Cache 60s para los tabs de listado. `fresh=1` (botón Sincronizar) lo saltea.
  const _cacheableTabs = ['total', 'cobrar', 'empaquetar', 'enviar'];
  const _fresh = req.query.fresh === '1' || req.query.fresh === 'true';
  const _cacheKey = (!action && !q && uid && _cacheableTabs.includes(tab))
    ? `${uid}|${tab}|${_countOnly ? '1' : ''}|${req.query.quick || ''}`
    : null;
  if (_cacheKey && !_fresh) {
    const hit = tabCacheGet(_cacheKey);
    if (hit) {
      res.setHeader('X-Growith-Cache', 'hit');
      return res.status(200).json(hit);
    }
  }
  if (_cacheKey) {
    const _origJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode === 200 && Array.isArray(body)) tabCacheSet(_cacheKey, body);
      return _origJson(body);
    };
  }

  // ── Rendimiento: financial dashboard (antiguo /api/rendimiento) ──────────
  if (action === 'daily_metrics') {
    if (!uid) return res.status(400).json({ error: "Falta uid" });
    try {
      const db = initAdmin();
      const days = parseInt(req.query.days) || 30;
      // Día actual en zona Argentina (UTC-3) — alinea con api/stock.js (argTodayParts)
      // para que el rango no se corra de día (antes se calculaba en UTC y stock.js
      // lo reinterpretaba como AR, desalineando el revenue vs el tab Análisis).
      const argToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
      const addDays = (ymd, n) => { const [y,m,d]=ymd.split("-").map(Number); return new Date(Date.UTC(y,m-1,d)+n*86400000).toISOString().slice(0,10); };
      const until = req.query.date_to || argToday;
      const since = req.query.date_from || addDays(argToday, -(days-1));
      const span = Math.round((Date.parse(until+"T00:00:00Z") - Date.parse(since+"T00:00:00Z"))/86400000); // nº de días - 1
      const prevUntil = addDays(since, -1);
      const prevSince = addDays(prevUntil, -span);
      // ── Capa de caché estilo Escalafy ──
      // El cálculo en vivo tarda 30-50s (TN rate-limitada + Meta + ML + MP): eso
      // NO puede estar en el camino del render. El dashboard pide primero
      // `cache=only` (respuesta guardada en Firestore, ~300ms) y pinta al
      // instante; después revalida en vivo de fondo. Un cron (warm_margenes,
      // cada 5 min) mantiene la caché fresca para que lo "instantáneo" también
      // sea reciente.
      const cacheKey = req.query.date_from ? `${since}_${until}` : `d${days}`;
      const cacheRef = db.collection("users").doc(uid).collection("margenes_cache").doc(cacheKey);
      if (req.query.cache === "only") {
        // Registrar el rango en el warmer APENAS se detecta el miss (antes se
        // registraba recién al final del cálculo exitoso): así el cron
        // warm_margenes (cada 5 min) calienta este rango aunque el primer
        // intento en vivo timeoutee y nunca llegue a escribir la caché.
        // lastWarm en época 0 lo pone al frente de la cola del warmer.
        const registrarMiss = async () => {
          try {
            await db.collection("system_warm_margenes").doc(warmDocId(uid, cacheKey)).set({
              uid, key: cacheKey,
              days: req.query.date_from ? null : days,
              date_from: req.query.date_from || null, date_to: req.query.date_to || null,
              lastAccess: new Date().toISOString(),
              lastWarm: new Date(0).toISOString(),
            }, { merge: true });
          } catch(e) { console.error("margenes warm miss set error:", e.message); }
        };
        const cs = await cacheRef.get();
        if (!cs.exists) { await registrarMiss(); return res.json({ noCache: true }); }
        const cd = cs.data() || {};
        try {
          const body = JSON.parse(cd.body || "{}");
          body.cachedAt = cd.cachedAt || null;
          return res.json(body);
        } catch(_) { await registrarMiss(); return res.json({ noCache: true }); }
      }
      const userSnap = await db.collection("users").doc(uid).get();
      const userData = userSnap.data() || {};
      const stores = userData.stores || [];
      // Con varios ML conectados: qué cuenta se usa para leer los pagos de MP
      // (comisiones de Shopify) y cuál para importar las ventas de ML. Vacío =
      // primera cuenta (comportamiento de siempre con 1 solo ML).
      const mlMpAcc     = String(userData.margenesMlMp || "") || null;
      const mlVentasAcc = String(userData.margenesMlVentas || "") || null;
      // El OAuth guarda type "mercadolibre" (integrations.js) — el chequeo viejo
      // por "meli" nunca matcheaba y Mercado Ads automático quedaba siempre en 0.
      const hasML = stores.some(s => s.type === "mercadolibre" || s.type === "meli");
      async function fetchStock(from, to) {
        // Sin catch silencioso: si la fuente de ventas falla, es MUCHO mejor
        // devolver un error explícito ("reintentá") que un dashboard con
        // facturación parcial que parece real. Con datos parciales el mismo
        // rango devolvía $39M/$64M/$12M en llamadas consecutivas.
        const stockUrl = new URL(`https://${req.headers.host}/api/stock`);
        stockUrl.searchParams.set("uid", uid); stockUrl.searchParams.set("action", "products");
        stockUrl.searchParams.set("date_from", from); stockUrl.searchParams.set("date_to", to);
        // /api/stock exige auth: este subrequest es server→server, así que va
        // con el CRON_SECRET (que stock.js acepta vía isCronRequest). El uid ya
        // fue validado contra el token del usuario en el gate de arriba.
        const stockHeaders = { host: req.headers.host, Authorization: `Bearer ${process.env.CRON_SECRET || ''}` };
        // Primero la caché del snapshot de stock (misma clave from_to que usa
        // stock.js): un rango CERRADO (until < hoy AR — el período previo de
        // cualquier rango siempre lo está) es inmutable, la caché sirve sin
        // importar su edad; un rango que incluye hoy solo si tiene <10 min.
        // Sin caché válida → cálculo en vivo como siempre. Esto le saca 15-50s
        // ×2 períodos al camino crítico de daily_metrics.
        let j = null, jcFallback = null;
        try {
          const cacheUrl = new URL(stockUrl); cacheUrl.searchParams.set("cache", "only");
          const rc = await fetch(cacheUrl.toString(), { headers: stockHeaders });
          if (rc.ok) {
            const jc = await rc.json();
            if (!jc.noCache && !jc.error && jc.daily_revenue) {
              jcFallback = jc; // último snapshot completo — plan B si TN/ML no responden
              const rangoCerrado = String(to) < argToday;
              const edadMs = jc.cachedAt ? (Date.now() - Date.parse(jc.cachedAt)) : Infinity;
              // Un rango cerrado solo es inmutable si el snapshot se ESCRIBIÓ después
              // de la medianoche AR que cierra el rango. Un snapshot guardado mientras
              // el día seguía en curso (ej. mirando "Hoy" a las 19:00 → clave
              // 2026-08-09_2026-08-09) congelaba un conteo parcial para siempre: al
              // día siguiente "Ayer" mostraba 21 ventas cuando TN tenía 31.
              const cerradoCompleto = rangoCerrado && jc.cachedAt
                && Date.parse(jc.cachedAt) >= Date.parse(`${String(to).slice(0,10)}T23:59:59-03:00`);
              // fresh=1 (botón Actualizar): saltea TODA la caché — la del día actual
              // (para ver ventas al segundo) Y la de rangos cerrados. Antes los rangos
              // cerrados se servían de caché aun con fresh, pero una DEVOLUCIÓN de ML
              // cae días después de la venta (cuando el día ya cerró) y tiene que
              // BORRAR la venta original de su día → el rango cerrado NO es realmente
              // inmutable. Al recalcular en vivo se reescribe el snapshot corregido,
              // así los loads siguientes (sin fresh) vuelven a ser rápidos y ya sin la
              // venta devuelta. La navegación normal (sin fresh) mantiene el caché.
              if (!_fresh && (cerradoCompleto || (isFinite(edadMs) && edadMs < 10 * 60000))) j = jc;
            }
          }
        } catch (_) { /* la caché es un atajo — si falla, se calcula en vivo */ }
        if (!j) {
          // TN/ML lentos a ráfagas (timeout de 45s en stock → 504): si el cálculo
          // en vivo falla y hay un snapshot COMPLETO previo, mejor servir ese
          // marcando su edad (la UI avisa) que tirar TODO el dashboard con 500.
          // Datos PARCIALES siguen prohibidos — el fallback es un snapshot íntegro.
          let jr = null, failMsg = null;
          try {
            const r = await fetch(stockUrl.toString(), { headers: stockHeaders });
            if (!r.ok) failMsg = `No se pudieron traer las ventas (HTTP ${r.status}). Reintentá en unos segundos.`;
            else { jr = await r.json(); if (jr.error) { failMsg = `Ventas: ${jr.error}`; jr = null; } }
          } catch (_) { failMsg = "No se pudieron traer las ventas (red). Reintentá en unos segundos."; }
          if (jr) j = jr;
          else if (jcFallback) { j = jcFallback; j._degradado = jcFallback.cachedAt || "sin fecha"; }
          else throw new Error(failMsg || "No se pudieron traer las ventas.");
        }
        // Combinar TN/Shopify + Mercado Libre (ML viene aparte en ml_data),
        // igual que el tab Análisis del front (mergeDaily). Antes se ignoraba ML
        // → facturación incompleta en el tab Márgenes.
        const dailyRevenue = { ...(j.daily_revenue||{}) };
        const dailyOrders  = { ...(j.daily_orders||{}) };
        const mlRev = j.ml_data?.daily_revenue || {};
        const mlOrd = j.ml_data?.daily_orders  || {};
        for (const [day,v] of Object.entries(mlRev)) dailyRevenue[day] = (dailyRevenue[day]||0) + (v||0);
        for (const [day,v] of Object.entries(mlOrd)) dailyOrders[day]  = (dailyOrders[day]||0)  + (v||0);
        return { dailyRevenue, dailyOrders, raw: j, degradado: j._degradado || null };
      }
      // Comisión REAL de Mercado Pago en ventas que NO son ML (Shopify/TN vía MP
      // Checkout). Con el token de ML se consultan los pagos de MP y se suma el
      // fee_details de los pagos de tienda (external_reference alfanumérico tipo
      // rXXX = receipt_id de la transacción Shopify). Se excluyen: ML (ref
      // numérica, ya contada en sale_fee), cashback, INSTORE, y no aprobados.
      async function fetchMPCommission(sinceYmd, untilYmd) {
        try {
          if (mlMpAcc === "__none__") return { fee:0, rev:0, feeByRef:{} }; // ninguna cuenta lee MP
          const tok = await getValidMLToken(db, uid, mlMpAcc); // cuenta de MP (Shopify)
          if (!tok?.accessToken) return { fee:0, rev:0 };
          const begin = `${sinceYmd}T00:00:00.000-03:00`, end = `${untilYmd}T23:59:59.999-03:00`;
          let fee = 0, rev = 0, offset = 0; const feeByRef = {}; const feeByPayId = {};
          // Cashflow real de MP: profit ≠ caja. money_release_date dice cuándo MP
          // libera cada pago (0-18 días). Se acumula el NETO recibido (post fees)
          // liberado vs retenido, sobre TODOS los pagos aprobados de la cuenta en
          // el rango (tienda + ML). También: costo de financiación en cuotas
          // (fee_details type financing_fee) y retenciones impositivas que MP
          // aplica en la liquidación (taxes/charges) — informativas, para que el
          // usuario verifique que su % de impuestos las contempla.
          let liberado = 0, retenido = 0, financingFee = 0, retenciones = 0;
          const ahora = new Date().toISOString();
          for (let i=0; i<25; i++) {
            const url = `https://api.mercadopago.com/v1/payments/search?sort=date_created&criteria=desc&range=date_created&begin_date=${encodeURIComponent(begin)}&end_date=${encodeURIComponent(end)}&limit=100&offset=${offset}`;
            const r = await fetch(url, { headers: { Authorization: `Bearer ${tok.accessToken}` } });
            if (!r.ok) break;
            const j = await r.json();
            const results = j.results || [];
            for (const p of results) {
              const ref = String(p.external_reference || "");
              const esRegular = p.status==="approved" && p.operation_type==="regular_payment";
              // Índice por payment_id (TODOS los aprobados, incluidas suscripciones
              // recurring_payment): las órdenes de Recurrentes guardan su mp_payment_id
              // y no matchean por external_reference, así que se cruzan por ID directo.
              if (p.status==="approved") {
                const fId = (p.fee_details||[]).filter(fd=>fd.fee_payer!=="payer").reduce((s,fd)=>s+(parseFloat(fd.amount)||0),0);
                if (fId>0) feeByPayId[String(p.id)] = fId;
              }
              if (esRegular && !/^cashback|^INSTORE/i.test(ref)) {
                const neto = parseFloat(p.transaction_details?.net_received_amount);
                const monto = isFinite(neto) && neto>0 ? neto : (parseFloat(p.transaction_amount)||0);
                const rel = p.money_release_date ? String(p.money_release_date) : null;
                if (rel && rel > ahora) retenido += monto; else liberado += monto;
                financingFee += (p.fee_details||[]).filter(fd=>fd.type==="financing_fee").reduce((s,fd)=>s+(parseFloat(fd.amount)||0),0);
                retenciones  += (p.charges_details||[]).filter(c=>String(c.type||"").toLowerCase()==="tax").reduce((s,c)=>s+(parseFloat(c?.amounts?.original)||0),0)
                              + (parseFloat(p.taxes_amount)||0);
              }
              if (esRegular && /[a-zA-Z]/.test(ref) && !/^cashback|^INSTORE/i.test(ref)) {
                // Solo los fees que paga el VENDEDOR (collector). Excluimos el
                // financing_fee de cuotas que paga el COMPRADOR (fee_payer "payer") —
                // sino la comisión se dispara (ej: $57.920 cuando el cargo real de MP
                // fue $7.185 porque las cuotas las financia el cliente).
                const f = (p.fee_details||[]).filter(fd=>fd.fee_payer!=="payer").reduce((s,fd)=>s+(parseFloat(fd.amount)||0),0);
                fee += f;
                rev += parseFloat(p.transaction_amount)||0; // revenue cobrado por MP (para no doble-contar el % en estas ventas)
                feeByRef[ref] = (feeByRef[ref]||0) + f; // comisión real de MP por receipt_id (= external_reference)
              }
            }
            offset += results.length;
            if (results.length < 100 || offset >= (j.paging?.total||0)) break;
          }
          return { fee, rev, feeByRef, feeByPayId, cashflow:{ liberado:+liberado.toFixed(2), retenido:+retenido.toFixed(2) }, financingFee:+financingFee.toFixed(2), retenciones:+retenciones.toFixed(2) };
        } catch(_) { return { fee:0, rev:0, feeByRef:{}, feeByPayId:{} }; }
      }
      const metaAccountsSnap = await db.collection("users").doc(uid).collection("meta_accounts").get();
      // Solo exige token: fetchMetaAll descubre las cuentas publicitarias vía
      // /me/adaccounts, así que no necesita ad_account_id pre-elegido. (Antes el
      // filtro exigía ad_account_id y una reconexión que lo borraba dejaba el
      // Ad Spend en $0 aunque el token estuviera perfecto.)
      const metaAccounts = metaAccountsSnap.docs.map(d => d.data()).filter(a => a.access_token);
      const metaErr = {};
      // Suma el gasto de TODAS las cuentas publicitarias que el token puede ver
      // (CP5, CP7, etc.) — las descubre con /me/adaccounts, así no hay que
      // agregar cada CP a mano en la app. Antes usaba solo metaAccounts[0], por
      // eso daba Ad Spend $0 al cambiar de CP.
      // Si tenés VARIAS tiendas en la misma app, elegís en Costos qué cuenta de
      // Meta es la de ESTA tienda (margenesMetaAdAccount) → el margen usa SOLO ese
      // ad spend, no la suma de todas. Sin elegir, suma todas (como antes).
      // Puede ser una LISTA de cuentas elegidas (multi-selección). Fallback al
      // campo viejo (single) y, si no hay nada, suma todas.
      const metaAccChosenList = (Array.isArray(userData.margenesMetaAdAccounts) ? userData.margenesMetaAdAccounts : (userData.margenesMetaAdAccount ? [userData.margenesMetaAdAccount] : []))
        .map(x => String(x||"").trim()).filter(Boolean);
      // Cotización para convertir cuentas de Meta que facturan en USD — Meta
      // devuelve "spend" en la moneda PROPIA de cada ad account, no en ARS.
      // Sumar cuentas ARS + USD sin convertir sub-representa brutalmente el
      // gasto real (ej. USD 35.000 sumados como si fueran $35.000 ARS, ~1300x
      // menos de lo real). Se usa el dólar HISTÓRICO de cada día del período
      // (default: cripto, el más común para pautar) en vez de una cotización
      // única — así el gasto de una semana atrás no se recalcula con el dólar
      // de hoy cada vez que se mueve. Config propia (margenesDolarAds),
      // independiente del dólar de Costos Adicionales.
      const CASA_POR_TIPO = { oficial:"oficial", blue:"blue", mep:"bolsa", cripto:"cripto" };
      const dolarAdsCfg = userData.margenesDolarAds || {};
      const dolarAdsTipo = dolarAdsCfg.tipo || "cripto";
      // El "ajuste/cometa" del dólar de Ads: si no se configuró uno propio (0 o
      // vacío), HEREDA el ajuste del dólar de Costos Adicionales. Así la cometa que
      // el usuario carga arriba (ej. +2%) también se le suma al gasto de Ads —
      // "el dólar del día + la cometa" — sin tener que repetirla. Un ajuste propio
      // en el panel de Ads (≠ 0) siempre gana sobre el heredado.
      const costosAjustePct = parseFloat((userData.margenesDolar||{}).ajuste)||0;
      const adsAjustePropio = parseFloat(dolarAdsCfg.ajuste);
      const dolarAdsAjuste = ((isFinite(adsAjustePropio) && adsAjustePropio!==0 ? adsAjustePropio : costosAjustePct)||0)/100;
      const dolarAdsManual = (parseFloat(dolarAdsCfg.valor)||0) * (1 + dolarAdsAjuste);
      const dolarAdsHistProm = dolarAdsTipo !== "manual" && CASA_POR_TIPO[dolarAdsTipo]
        ? fetchDolarHistorico(CASA_POR_TIPO[dolarAdsTipo])
        : Promise.resolve(null);
      // Fallback si la serie histórica no está disponible (API caída, red, etc.):
      // valor manual de Ads → cotización de Costos → nunca dejar el Ad Spend en $0
      // por un problema de datos externos.
      const dolarCostosBase = parseFloat((userData.margenesDolar||{}).valor)||0;
      const dolarCostosEf = dolarCostosBase * (1 + costosAjustePct/100);
      // Fallback = dólar de Costos base × (1 + ajuste efectivo de Ads). Se parte del
      // valor BASE (no del efectivo) para no aplicar la cometa dos veces cuando el
      // ajuste de Ads se hereda del de Costos.
      const dolarAdsFallback = dolarAdsManual > 0 ? dolarAdsManual : (dolarCostosBase > 0 ? dolarCostosBase * (1 + dolarAdsAjuste) : 0);
      let dolarAdsHistDias = -1; // diagnóstico: cuántos días tiene la serie (-1 = no aplica)
      // Desglose del Ad Spend del período ACTUAL (para el panel "cómo se compone
      // la inversión" del dashboard): gasto original por moneda según Meta,
      // convertido a ARS, cotización promedio usada y días sin cotización.
      const adsBd = { porMoneda:{}, convertido:0, sinCotiz:0, rateSum:0, rateDias:0, feeMonto:0 };
      // Fee adicional POR CUENTA de Meta (recargo tarjeta/agencia). margenesMetaAdFees
      // = { adAccountId: % }. Migración: si no hay % por cuenta, se usa el fee global
      // legacy (margenesDolar.feeAdSpend) para TODAS las cuentas — así nadie pierde su %.
      const metaFees = (userData.margenesMetaAdFees && typeof userData.margenesMetaAdFees==="object" && !Array.isArray(userData.margenesMetaAdFees)) ? userData.margenesMetaAdFees : {};
      const legacyMetaFeePct = parseFloat(userData.margenesDolar?.feeAdSpend)||0;
      const metaFeeFor = (accId) => { const bare=String(accId).replace(/^act_/,""); const v = (metaFees[bare]!=null)?metaFees[bare]:(metaFees["act_"+bare]!=null?metaFees["act_"+bare]:null); return ((v!=null?parseFloat(v):legacyMetaFeePct)||0)/100; };
      async function fetchMetaAll(s, u, eRef, bdCollect) {
        if (!metaAccounts.length) return {};
        const token = metaAccounts[0].access_token;
        let accounts = []; // [{id, currency}]
        if (metaAccChosenList.length) {
          accounts = metaAccChosenList.map(id => ({ id: id.startsWith("act_") ? id : "act_" + id, currency: null }));
          // Necesitamos la moneda de cada una para convertir — se resuelve abajo si falta.
        } else {
          try {
            const acc = await metaGet("me/adaccounts", { fields: "account_id,name,currency", limit: "100" }, token);
            accounts = (acc.data||[]).map(a => ({ id: "act_" + a.account_id, currency: a.currency || null }));
          } catch(e) { console.error("Meta adaccounts list error:", e.message); }
          if (!accounts.length) accounts = metaAccounts.map(a => ({ id: a.ad_account_id, currency: null })).filter(a => a.id);
        }
        // Si vino sin moneda (lista elegida a mano o fallback), la resolvemos 1x c/u.
        const sinMoneda = accounts.filter(a => !a.currency);
        if (sinMoneda.length) {
          await Promise.all(sinMoneda.map(async a => {
            try { const info = await metaGet(a.id, { fields: "currency" }, token); a.currency = info.currency || "ARS"; }
            catch (_) { a.currency = "ARS"; }
          }));
        }
        const histMap = await dolarAdsHistProm;
        dolarAdsHistDias = histMap ? histMap.size : -1;
        const arr = await Promise.all(accounts.map(async a => {
          const bd = await fetchMetaDailySpend({ access_token: token, ad_account_id: a.id }, s, u, eRef);
          const curCode = String(a.currency || "ARS").toUpperCase();
          if (a.currency && a.currency !== "ARS") {
            for (const [fecha, v] of Object.entries(bd)) {
              // UN SOLO DÓLAR OPERATIVO: el usuario compra USDT siempre en el mismo
              // lugar, así que el gasto en USD se pasa a ARS con la MISMA cotización
              // efectiva de Costos ($ del día + cometa) que todo lo demás del
              // dashboard. Solo si no hay dólar de Costos configurado se cae al
              // histórico día por día del dólar de Ads (o su manual/fallback), para
              // no dejar el Ad Spend en $0 por falta de config.
              let rate = dolarCostosEf > 0 ? dolarCostosEf : null;
              if (rate == null) {
                if (dolarAdsTipo === "manual") rate = dolarAdsManual > 0 ? dolarAdsManual : null;
                else { const base = histMap ? dolarDeFecha(histMap, fecha) : null; rate = base != null ? base * (1 + dolarAdsAjuste) : null; }
                if (!rate && dolarAdsFallback > 0) rate = dolarAdsFallback;
              }
              if (!rate) { if (bdCollect) bdCollect.sinCotiz++; delete bd[fecha]; continue; } // sin NINGUNA cotización: se excluye, no se suma mal
              const orig = v.spend||0;
              if (bdCollect) {
                bdCollect.porMoneda[curCode] = (bdCollect.porMoneda[curCode]||0) + orig;
                bdCollect.convertido += orig * rate;
                bdCollect.rateSum += rate; bdCollect.rateDias++;
              }
              v.spend = orig * rate;
              v.purchaseVal = (v.purchaseVal||0) * rate;
            }
          } else if (bdCollect) {
            for (const v of Object.values(bd)) {
              bdCollect.porMoneda.ARS = (bdCollect.porMoneda.ARS||0) + (v.spend||0);
              bdCollect.convertido += v.spend||0;
            }
          }
          // Fee adicional POR CUENTA sobre el spend ya convertido a ARS. Se hornea
          // acá; el feeAd global queda en 0 para no duplicar.
          const accFee = metaFeeFor(a.id);
          if (accFee) for (const v of Object.values(bd)) { const add=(v.spend||0)*accFee; if(bdCollect) bdCollect.feeMonto += add; v.spend=(v.spend||0)+add; }
          return bd;
        }));
        const merged = {};
        for (const bd of arr) for (const [d,v] of Object.entries(bd)) {
          const m = merged[d] || (merged[d] = { spend:0, impressions:0, clicks:0, reach:0, purchases:0, purchaseVal:0 });
          m.spend+=v.spend||0; m.impressions+=v.impressions||0; m.clicks+=v.clicks||0; m.reach+=v.reach||0; m.purchases+=v.purchases||0; m.purchaseVal+=v.purchaseVal||0;
        }
        return merged;
      }
      // Techo duro para toda la carga: metaGet() no tiene timeout propio (fetch
      // nativo sin AbortController) y puede colgarse sin límite si Meta responde
      // lento. Sin este freno, la función entera se cuelga hasta que Vercel la
      // mata en seco (0 bytes al cliente) en vez de devolver un error claro.
      // Mercado Ads y Google Ads (×2 períodos) no dependen de nada de la fase
      // anterior: van dentro del MISMO Promise.all en vez de una segunda tanda
      // secuencial. Ambas funciones (declaradas más abajo — hoisting) atrapan
      // sus errores y devuelven null → el dashboard sale sin ese gasto, igual
      // que antes.
      const mlAdsDebug = {};
      let gadsDiag = null; // por qué Google Ads no devolvió gasto (se muestra como aviso en el Dashboard)
      const gadsAttr = {}; // conversiones/valor atribuidos por Google, por rango: {"since_until": {conv, convValue}}
      const [curr, prev, metaCurr, metaPrev, mpCommCurr, mpCommPrev, mlAdsAutoCurr, mlAdsAutoPrev, gAdsAutoCurr, gAdsAutoPrev] = await Promise.race([
        Promise.all([
          fetchStock(since, until), fetchStock(prevSince, prevUntil),
          fetchMetaAll(since, until, metaErr, adsBd), fetchMetaAll(prevSince, prevUntil),
          fetchMPCommission(since, until), fetchMPCommission(prevSince, prevUntil),
          fetchMlAdsSpend(since, until, mlAdsDebug), fetchMlAdsSpend(prevSince, prevUntil),
          fetchGoogleAdsAuto(since, until), fetchGoogleAdsAuto(prevSince, prevUntil),
        ]),
        new Promise((_, rej) => setTimeout(() => rej(new Error("Tiempo agotado trayendo métricas (55s) — la tienda, Meta o Mercado Libre están respondiendo muy lento. Reintentá en unos segundos.")), 55000)),
      ]);
      // commission=0: las filas se re-derivan después con el motor real
      // (alinearRowsExacto) — el % legacy quedó eliminado.
      let rows = buildRendRows(since, until, curr.dailyRevenue, curr.dailyOrders, metaCurr, 0);
      let prevRows = buildRendRows(prevSince, prevUntil, prev.dailyRevenue, prev.dailyOrders, metaPrev, 0);
      let totals = computeRendTotals(rows); let prevTotals = computeRendTotals(prevRows);

      // ── Capas de costo configuradas en Márgenes → margen real estilo Escalafy ──
      const cogsMap   = userData.margenesCogs && typeof userData.margenesCogs==="object" && !Array.isArray(userData.margenesCogs) ? userData.margenesCogs : {};
      // COGS por producto/variante. Formatos soportados (retrocompatibles):
      //   • número / string       → $ fijo (siempre)
      //   • { t:"pct", v }         → % del precio de venta (siempre)
      //   • { hist:[{desde,hasta?,v,t}] } → HISTORIAL por fecha: cada tramo vale
      //     entre `desde` y `hasta` (YYYY-MM-DD). Si `hasta` está vacío el tramo
      //     corre hasta el próximo cambio (o hasta hoy si es el último). Una venta
      //     toma el costo que regía SU fecha (los proveedores cambian precio).
      //   • [ {desde,hasta?,v,t}, ... ] → mismo historial en forma de array pelado.
      // `fecha` (YYYY-MM-DD de la orden) elige el tramo. Sin fecha → el más nuevo.
      const cogsCosto = (entry, price, fecha) => {
        if (entry == null) return 0;
        const val = (t, v) => { const p = parseFloat(v); if (!isFinite(p)) return 0; return t === "pct" ? (parseFloat(price)||0)*(p/100) : p; };
        const hist = Array.isArray(entry) ? entry : (entry && Array.isArray(entry.hist) ? entry.hist : null);
        if (hist) {
          const sorted = hist.filter(h => h && h.v != null && String(h.v).trim() !== "").sort((a,b)=>String(a.desde||"").localeCompare(String(b.desde||"")));
          if (!sorted.length) return 0;
          let chosen = null;
          if (fecha) {
            for (const h of sorted) {
              if (String(h.desde||"") <= fecha) {
                // `hasta` explícito vencido → este tramo ya no aplica a esa fecha.
                if (h.hasta && String(h.hasta) < fecha) continue;
                chosen = h;
              } else break;
            }
            if (!chosen) chosen = sorted[0]; // antes del 1er tramo (o en un hueco) → el más viejo
          } else chosen = sorted[sorted.length-1]; // sin fecha → el vigente (más nuevo)
          return val(chosen.t, chosen.v);
        }
        if (typeof entry === "object") return val(entry.t, entry.v);
        const n = parseFloat(entry); return isFinite(n) ? n : 0;
      };
      // Resolver de key CANÓNICA por catálogo: mapea el item de una orden a la key
      // actual de su variante por variant_id (estable ante rename/cambio de SKU) y,
      // si no, por SKU. Así ventas viejas y nuevas de la misma variante se unifican.
      const makeKeyResolver = (raw) => {
        const byVid = {}, bySku = {};
        for (const p of (raw?.products||[])) for (const v of (p.variants||[])) {
          const canon = v.sku || String(v.id);
          if (byVid[String(v.id)] == null) byVid[String(v.id)] = canon;
          if (v.sku && bySku[v.sku] == null) bySku[v.sku] = canon;
        }
        return (it) => (it.vid != null && byVid[String(it.vid)]) || bySku[it.key] || it.key;
      };
      // ── Índice de costos por CUALQUIER identificador ──────────────────────
      // El costo puede quedar cargado bajo el SKU o bajo el variant_id, y la venta
      // puede traer como key el SKU o el variant_id (según si tenía SKU al momento
      // de la orden). Antes se buscaba SOLO por la key canónica → si no coincidían
      // exactamente, COGS 0. Ahora se indexa por SKU y variant_id (normalizados,
      // sin espacios de más) apuntando al MISMO costo, y la venta lo encuentra por
      // cualquiera de los dos. Las publicaciones de ML ("ml:id") entran igual.
      const _norm = s => String(s == null ? "" : s).trim();
      const _costIdxCache = new WeakMap();
      const costIndexOf = (raw) => {
        if (!raw) return {};
        if (_costIdxCache.has(raw)) return _costIdxCache.get(raw);
        const idx = {};
        for (const [k, entry] of Object.entries(cogsMap)) { if (entry != null) idx[_norm(k)] = entry; }
        for (const p of (raw?.products || [])) for (const v of (p.variants || [])) {
          const sku = _norm(v.sku), vid = _norm(v.id);
          const entry = (sku && idx[sku] != null) ? idx[sku] : (vid && idx[vid] != null ? idx[vid] : null);
          if (entry == null) continue;
          if (sku && idx[sku] == null) idx[sku] = entry;
          if (vid && idx[vid] == null) idx[vid] = entry;
        }
        _costIdxCache.set(raw, idx);
        return idx;
      };
      const costEntryOf = (idx, it) => {
        const kk = _norm(it.key);
        if (kk && idx[kk] != null) return idx[kk];
        if (it.vid != null) { const vv = _norm(it.vid); if (vv && idx[vv] != null) return idx[vv]; }
        return null;
      };
      // COGS total POR ORDEN (fecha-aware) separado por canal. Antes se calculaba
      // unidades_vendidas_del_período × costo_actual — eso ignora los cambios de
      // costo por fecha. Ahora se recorre orden por orden y cada una toma el costo
      // que regía su día. Con costos SIN historial da idéntico al método viejo.
      const _cogsCache = new WeakMap();
      const cogsPorCanal = (raw) => {
        if (!raw) return { tienda: 0, ml: 0 };
        if (_cogsCache.has(raw)) return _cogsCache.get(raw);
        const rk = makeKeyResolver(raw);
        const idx = costIndexOf(raw);
        const priceByKey = {};
        for (const p of (raw?.products||[])) for (const v of (p.variants||[])) { const k=v.sku||String(v.id); if (priceByKey[k]==null) priceByKey[k]=v.price; }
        const priceMl = {};
        for (const m of (raw?.ml_data?.ml_products||[])) priceMl["ml:"+m.id]=m.price;
        let tienda = 0, ml = 0;
        for (const o of (raw?.orders_detail||[])) {
          const f = String(o.fecha||"").slice(0,10);
          for (const it of (o.items||[])) { const c=cogsCosto(costEntryOf(idx, it), priceByKey[rk(it)], f); if (c>0) tienda += c*(it.qty||0); }
        }
        for (const o of (raw?.ml_data?.ml_orders_detail||[])) {
          if (o.refunded) continue;
          const f = String(o.fecha||"").slice(0,10);
          for (const it of (o.items||[])) { const c=cogsCosto(costEntryOf(idx, it), priceMl[it.key], f); if (c>0) ml += c*(it.qty||0); }
        }
        const res = { tienda, ml };
        _cogsCache.set(raw, res);
        return res;
      };
      const comCfg    = userData.margenesComisionesCfg || {};
      const metodos   = comCfg.metodos && typeof comCfg.metodos==="object" ? comCfg.metodos : {};
      const envioProm = parseFloat(userData.margenesEnvioProm) || 0;
      // Config de envío v2: la tienda puede usar el costo REAL de cada orden
      // (shipping_cost_owner de TN) en vez del promedio; ML Flex puede tener su
      // propio costo por envío distinto del promedio de tienda.
      const envioCfg = userData.margenesEnvioCfg && typeof userData.margenesEnvioCfg==="object" ? userData.margenesEnvioCfg : {};
      const envioModoTienda = envioCfg.modoTienda === "orden" ? "orden" : "fijo";
      const envioMlFlex = (envioCfg.mlFlex!=null && envioCfg.mlFlex!=="" && isFinite(parseFloat(envioCfg.mlFlex))) ? parseFloat(envioCfg.mlFlex) : null;
      // Fulfillment: costo fijo por paquete despachado (lo que cobra el fulfillment
      // por orden). Se suma a la logística de CADA orden (tienda y ML).
      const fulfillFee = parseFloat(envioCfg.fulfillment) || 0;
      // Gasto de Mercado Ads cargado por períodos: [{desde, hasta, monto}].
      // Cada período se promedia por día (monto / días) y se toma el solape con
      // el rango del dashboard. Ej: 10/06–19/06 $1.000.000 = $100.000/día.
      const mlAdsList = Array.isArray(userData.margenesMlAds) ? userData.margenesMlAds : [];
      // Gasto de Google Ads por períodos (carga manual — la API oficial requiere
      // developer token aprobado por Google; cuando esté, esto pasa a automático
      // igual que Mercado Ads). Misma estructura: [{desde, hasta, monto}].
      const googleAdsList = Array.isArray(userData.margenesGoogleAds) ? userData.margenesGoogleAds : [];
      // ── Mercado Ads AUTOMÁTICO (Product Ads API) ──
      // Si la cuenta de ML tiene Product Ads, el gasto real del período se trae
      // solo: advertisers (Api-Version 1) → campaigns/search con metrics=cost
      // (Api-Version 2). Si la API falla o no hay campañas, rige el gasto manual
      // cargado por períodos (mlAdsPeriodo) — nunca se suman los dos.
      // dbg: colector de diagnóstico (solo el período actual lo pasa) — sin él
      // cada `return null` era invisible y "Ad Spend ML en $0" no se podía debuggear.
      async function fetchMlAdsSpend(sinceR, untilR, dbg) {
        const D = (step, extra) => { if (dbg) { dbg.step = step; Object.assign(dbg, extra||{}); } };
        try {
          if (!hasML) { D("sin_cuenta_ml"); return null; }
          const tokML = mlVentasAcc === "__none__" ? null : await getValidMLToken(db, uid, mlVentasAcc);
          if (!tokML?.accessToken) { D("sin_token"); return null; }
          let adv = _mlAdvCache.get(uid);
          if (!adv || Date.now() - adv.ts > 3600000) {
            const r = await fetch("https://api.mercadolibre.com/advertising/advertisers?product_id=PADS", { headers: { Authorization: `Bearer ${tokML.accessToken}`, "Api-Version": "1" } });
            if (!r.ok) { D("advertisers_http", { status: r.status, body: (await r.text().catch(()=>"")).slice(0,300) }); return null; }
            const j = await r.json();
            const a = (j.advertisers || [])[0];
            if (!a?.advertiser_id) { D("sin_advertiser", { body: JSON.stringify(j).slice(0,300) }); return null; }
            adv = { ts: Date.now(), id: a.advertiser_id, site: a.site_id || "MLA" };
            _mlAdvCache.set(uid, adv);
          }
          const url = `https://api.mercadolibre.com/marketplace/advertising/${adv.site}/advertisers/${adv.id}/product_ads/campaigns/search?limit=50&metrics=cost&metrics_summary=true&date_from=${sinceR}&date_to=${untilR}`;
          const r2 = await fetch(url, { headers: { Authorization: `Bearer ${tokML.accessToken}`, "Api-Version": "2" } });
          if (!r2.ok) { D("campaigns_http", { status: r2.status, advertiser: adv.id, site: adv.site, body: (await r2.text().catch(()=>"")).slice(0,300) }); return null; }
          const j2 = await r2.json();
          let cost = parseFloat(j2?.metrics_summary?.cost);
          if (!isFinite(cost)) cost = (j2.results || []).reduce((s, c) => s + (parseFloat(c?.metrics?.cost) || 0), 0);
          D("ok", { cost: isFinite(cost)?cost:null, campanias: (j2.results||[]).length });
          return isFinite(cost) && cost > 0 ? +cost.toFixed(2) : null;
        } catch (e) { D("exception", { error: String(e.message).slice(0,200) }); console.error("Mercado Ads spend error:", e.message); return null; }
      }
      function adsPeriodoDe(list, sinceR, untilR) {
        let total = 0;
        for (const e of list) {
          const d = e.desde, h = e.hasta, m = parseFloat(e.monto) || 0;
          if (!d || !h || m <= 0 || h < d) continue;
          const entryDays = Math.round((new Date(h) - new Date(d)) / 86400000) + 1;
          if (entryDays <= 0) continue;
          const lo = d > sinceR ? d : sinceR;
          const hi = h < untilR ? h : untilR;
          if (lo <= hi) {
            const overlap = Math.round((new Date(hi) - new Date(lo)) / 86400000) + 1;
            total += (m / entryDays) * overlap;
          }
        }
        return total;
      }
      const mlAdsPeriodo = (s,u) => adsPeriodoDe(mlAdsList, s, u);
      const fijos     = Array.isArray(userData.margenesCostosFijos) ? userData.margenesCostosFijos : [];
      const dolarCfg  = userData.margenesDolar || {};
      const factExt   = Array.isArray(userData.margenesFactExterna) ? userData.margenesFactExterna : [];
      const fijosMensual = fijos.reduce((s,f)=>s+(parseFloat(f.monto)||0),0);
      // Costos variables = % de la facturación (ej: 2% a un growth partner).
      const costosVar = Array.isArray(userData.margenesCostosVar) ? userData.margenesCostosVar : [];
      const pctVar = costosVar.reduce((s,v)=>s+(parseFloat(v.pct)||0),0)/100;
      // ── Costos Adicionales v2 ──────────────────────────────────────────
      // Entradas: {nombre, categoria, tipo:"fijo"|"variable", moneda:"ARS"|"USD",
      // monto|pct, recurrente, desde, hasta, sumaAds}. Los fijos recurrentes se
      // prorratean por día (monto/30); los fijos por período reparten el monto en
      // sus días; los variables son % del revenue. USD se convierte con la
      // cotización (con su ajuste manual). sumaAds=true → va al Ad Spend, no a
      // Costos Adicionales (afecta ROAS/CPA como en Escalafy).
      // Conviven con los campos legacy margenesCostosFijos/Var hasta que el panel
      // los migre (al guardar el panel nuevo, los legacy quedan vacíos).
      const costosAdicList = Array.isArray(userData.margenesCostosAdic) ? userData.margenesCostosAdic : [];
      const dolarValorEf = (parseFloat(dolarCfg.valor)||0) * (1 + (parseFloat(dolarCfg.ajuste)||0)/100);
      function costosAdicPeriodo(sinceR, untilR, revenueR) {
        let gasto = 0, gastoAds = 0;
        for (const c of costosAdicList) {
          const enUsd = c.moneda === "USD";
          if (enUsd && !(dolarValorEf > 0)) continue; // sin cotización no hay conversión
          const conv = enUsd ? dolarValorEf : 1;
          if (c.tipo === "variable") {
            const p = parseFloat(c.pct) || 0;
            if (p <= 0) continue;
            if ((c.desde && c.desde > untilR) || (c.hasta && c.hasta < sinceR)) continue;
            const g = revenueR * (p/100);
            if (c.sumaAds) gastoAds += g; else gasto += g;
            continue;
          }
          const m = (parseFloat(c.monto) || 0) * conv;
          if (m <= 0) continue;
          const lo = (c.desde && c.desde > sinceR) ? c.desde : sinceR;
          const hi = (c.hasta && c.hasta < untilR) ? c.hasta : untilR;
          if (lo > hi) continue;
          const overlap = Math.round((new Date(hi) - new Date(lo)) / 86400000) + 1;
          if (overlap <= 0) continue;
          let g = 0;
          if (c.recurrente || !c.desde || !c.hasta) {
            g = (m/30) * overlap;        // mensual recurrente, prorrateado por día
          } else {
            const entryDays = Math.round((new Date(c.hasta) - new Date(c.desde)) / 86400000) + 1;
            if (entryDays <= 0) continue;
            g = (m/entryDays) * overlap; // monto único repartido en su período
          }
          if (c.sumaAds) gastoAds += g; else gasto += g;
        }
        return { gasto, gastoAds };
      }
      const pctImp    = (parseFloat(comCfg.impuestos)||0)/100;
      // Impuestos de ML separados de los de la tienda (fallback: mismo % de tienda).
      const pctImpML  = (comCfg.impuestosML!=null && comCfg.impuestosML!=="") ? (parseFloat(comCfg.impuestosML)||0)/100 : pctImp;
      const pctPlat   = (parseFloat(comCfg.shopify)||0)/100;
      const metPcts   = Object.values(metodos).map(m=>parseFloat(m.pct)||0).filter(x=>x>0);
      const pctPago   = metPcts.length ? (metPcts.reduce((a,b)=>a+b,0)/metPcts.length)/100 : 0;
      // Comisión de pago POR MÉTODO: cada venta usa la tasa de SU método real
      // (ej: transferencia 1,21%), no el promedio. metodos está keyed por nombre
      // de gateway (= o.pay). Match exacto y, si no, normalizado/parcial.
      const normPay = s => String(s||"").toLowerCase().replace(/[^a-z0-9]/g,"");
      const metodosNorm = {};
      for (const [k,v] of Object.entries(metodos)) { const p = parseFloat(v?.pct); if (isFinite(p) && p>0) metodosNorm[normPay(k)] = p/100; }
      // Comisión de Mercado Pago explícita (para órdenes MP sin fee real matcheado,
      // ej: todas las de TN). Sin configurar = 0 — el promedio de otros métodos
      // (transferencia, etc.) no representa a MP.
      const mpPctCfg = (parseFloat(comCfg.mpPct)||0)/100;
      const esMPPay = s => /mercadopago|mercadolibre/.test(normPay(s));
      function pctPagoFor(payStr) {
        const np = normPay(payStr);
        if (!np) return pctPago;
        if (metodosNorm[np] != null) return metodosNorm[np];
        for (const [k,v] of Object.entries(metodosNorm)) { if (k && (k.includes(np) || np.includes(k))) return v; }
        if (esMPPay(payStr)) return mpPctCfg;
        return pctPago;
      }
      // Impuesto por método de pago: sustituye el % de tienda para esas ventas
      // (ej: pagos personalizados/efectivo con otra carga impositiva).
      const metodosImpNorm = {};
      for (const [k,v] of Object.entries(metodos)) { if (v && v.imp!=null && v.imp!=="") { const ip = parseFloat(v.imp); if (isFinite(ip)) metodosImpNorm[normPay(k)] = ip/100; } }
      function impFor(payStr) {
        const np = normPay(payStr);
        if (!np) return pctImp;
        if (metodosImpNorm[np] != null) return metodosImpNorm[np];
        for (const [k,v] of Object.entries(metodosImpNorm)) { if (k && (k.includes(np) || np.includes(k))) return v; }
        return pctImp;
      }
      const feeAd     = 0; // el fee adicional ahora es POR CUENTA (horneado en fetchMetaAll)

      function aplicarCostos(tot, raw, sinceR, untilR, dias, mpComm, mlEnvio, mlAdsAuto, gAdsAuto) {
        // COGS = costo por producto/variante, ORDEN por ORDEN (cada una toma el
        // costo vigente a su fecha; con costos sin historial = método viejo exacto).
        const _cg = cogsPorCanal(raw);
        const cogs = _cg.tienda + _cg.ml;
        const storeRev = Object.values(raw?.daily_revenue||{}).reduce((a,b)=>a+b,0);
        const factRows = factExt.filter(r => r.fecha && r.fecha>=sinceR && r.fecha<=untilR);
        const factExtTot = factRows.reduce((s,r)=>s+(parseFloat(r.monto)||0),0);
        const factExtOrd = factRows.reduce((s,r)=>s+(parseInt(r.ord)||0),0);
        const revenue   = (tot.revenue||0) + factExtTot;
        const ordersTot = (tot.orders||0) + factExtOrd;
        // Impuestos: % de tienda sobre (tienda + externa) y % propio de ML sobre
        // ML. Los métodos con impuesto propio sustituyen el % de tienda en SUS ventas.
        const mlRev = Object.values(raw?.ml_data?.daily_revenue||{}).reduce((a,b)=>a+b,0);
        let impuestos = Math.max(0, revenue - mlRev) * pctImp + mlRev * pctImpML;
        for (const o of (raw?.orders_detail||[])) {
          const rate = impFor(o.pay);
          if (rate !== pctImp) impuestos += (parseFloat(o.revenue)||0) * (rate - pctImp);
        }
        // Comisión de plataforma = % configurado del store (Shopify/TN) + comisión
        // REAL de Mercado Libre (sale_fee de cada orden, ya incluye el pago de MP).
        const comML     = parseFloat(raw?.ml_data?.ml_commission)||0;
        const comPlat   = storeRev * pctPlat + comML;
        // Comisión de pago = comisión REAL de MP (sus ventas) + % configurado SOLO
        // sobre las ventas que NO pasaron por MP (transferencia, etc.). Antes el %
        // se aplicaba a TODO el revenue y encima se sumaba MP → doble-conteo.
        const comPago   = parseFloat(mpComm)||0; // ya viene como shopifyPayComm (solo esta tienda)
        // Envío tienda: costo REAL por orden (si está el modo "orden" y hay detalle)
        // o promedio × órdenes. ML: Flex a su costo propio, Mercado Envíos al real.
        const storeOrders = Object.values(raw?.daily_orders||{}).reduce((a,b)=>a+b,0);
        const envioTienda = (envioModoTienda==="orden" && (raw?.orders_detail||[]).length)
          ? (raw.orders_detail||[]).reduce((s,o)=>s+(parseFloat(o.envioCosto)||0),0)
          : storeOrders * envioProm;
        // Fulfillment por paquete: se aplica a cada orden real (tienda + ML),
        // no a la facturación externa.
        const mlOrders  = Object.values(raw?.ml_data?.daily_orders||{}).reduce((a,b)=>a+b,0);
        const fulfill   = fulfillFee * (storeOrders + mlOrders);
        const envio     = envioTienda + (parseFloat(mlEnvio)||0) + fulfill;
        // Costos adicionales: legacy (fijos mensuales + % variable) + lista v2.
        const adic      = costosAdicPeriodo(sinceR, untilR, revenue);
        const costosAdic= (dias>0 ? (fijosMensual/30)*dias : 0) + revenue*pctVar + adic.gasto;
        // Ad Spend general = Meta (con fee del dólar) + Mercado Ads manual prorrateado
        // + costos adicionales marcados como inversión publicitaria (sumaAds).
        const adSpendMeta = (tot.adSpend||0) * (1+feeAd);
        // Mercado Ads: gasto REAL de la API si está disponible; sino el manual.
        const adSpendMl   = (mlAdsAuto!=null) ? mlAdsAuto : mlAdsPeriodo(sinceR, untilR);
        // Google Ads: gasto REAL de la API si la cuenta está conectada y hay
        // developer token; sino la carga manual por períodos (prorrateada por día).
        const adSpendGoogle = (gAdsAuto!=null) ? gAdsAuto : adsPeriodoDe(googleAdsList, sinceR, untilR);
        const adSpendEf = adSpendMeta + adSpendMl + adSpendGoogle + adic.gastoAds;
        const profit    = revenue - cogs - impuestos - comPlat - comPago - envio - costosAdic - adSpendEf;
        // Net Revenue = TODO descontado menos la pauta (contribución antes de ads).
        // Así la cascada es limpia: Revenue → Net Revenue → (− pauta) → Profit,
        // y True ROAS (netRevenue/adSpend) se lee directo: ≥1x = la pauta gana plata.
        const netRevenue= profit + adSpendEf;
        return { ...tot,
          revenue, orders: ordersTot, adSpend: adSpendEf, adSpendMeta: +adSpendMeta.toFixed(2), adSpendMl: +adSpendMl.toFixed(2), adSpendGoogle: +adSpendGoogle.toFixed(2), adSpendExtra: +adic.gastoAds.toFixed(2), netRevenue: +netRevenue.toFixed(2), profit: +profit.toFixed(2),
          costoProductos: +cogs.toFixed(2), impuestos: +impuestos.toFixed(2),
          comisionPlataforma: +comPlat.toFixed(2), comisionPago: +comPago.toFixed(2),
          costoEnvio: +envio.toFixed(2), fulfillment: +fulfill.toFixed(2), costosAdicionales: +costosAdic.toFixed(2),
          facturacionExterna: +factExtTot.toFixed(2), facturacionExternaOrd: factExtOrd,
          profitMargin: revenue>0 ? profit/revenue : 0,
          roas: adSpendEf>0 ? revenue/adSpendEf : 0,
          trueRoas: adSpendEf>0 ? netRevenue/adSpendEf : 0,
          cpa: ordersTot>0 ? adSpendEf/ordersTot : 0,
          aov: ordersTot>0 ? revenue/ordersTot : 0,
          aovNeto: ordersTot>0 ? netRevenue/ordersTot : 0,
          mer: revenue>0 ? adSpendEf/revenue : 0,
          // Break even REAL contando TODOS los costos (incluidos los fijos): es la
          // contribución antes de pauta = profit + adSpend. Si da negativo, el CPA
          // break even queda negativo a propósito: significa que perdés incluso con
          // CPA $0 (los costos ya superan al revenue) — es una señal válida.
          breakEvenRoas: (profit + adSpendEf)>0 ? revenue/(profit + adSpendEf) : 0,
          cpaBreakEven: ordersTot>0 ? (profit + adSpendEf)/ordersTot : 0,
        };
      }
      // ── Envío de ML: el COSTO REAL que ML le cobra al vendedor ──
      // Mercado Envíos: /shipments/{id}/costs → senders[].cost = lo que ML le
      // cobra al VENDEDOR de verdad: con los descuentos por reputación aplicados
      // y en $0 si el envío lo pagó el comprador. Antes usábamos
      // shipping_option.list_cost (tarifa plena) y el costo quedaba INFLADO
      // (ej: $3.1M vs ~$2.2M reales en un rango de 19 días). Fallback si /costs
      // falla: list_cost (mejor pasarse que $0). Flex (self_service, el vendedor
      // le paga al correo por fuera) → costo propio configurado.
      const mlLogi = {};
      // Diagnóstico del costo de envío ML: cuántos shipments resolvieron por cada
      // fuente + una respuesta cruda de /costs de muestra (para auditar campos).
      const mlEnvioDebug = { costsOk:0, costsFallback:0, flex:0, sumCost:0, sumSave:0, sample:null, cacheHits:0 };
      try {
        const tokML = mlVentasAcc === "__none__" ? null : await getValidMLToken(db, uid, mlVentasAcc); // cuenta de ventas ML
        if (tokML?.accessToken) {
          const allIds = [...new Set([
            ...(curr.raw?.ml_data?.ml_orders_detail||[]),
            ...(prev.raw?.ml_data?.ml_orders_detail||[]),
          ].map(o=>o.shippingId).filter(Boolean))].slice(0, 400);
          // Caché persistente: el costo de un envío YA DESPACHADO es inmutable —
          // se guarda {shippingId: {lt, cost}} en margenes_meta/ml_shipping_costs
          // (doc único) y los ids conocidos se saltan por completo (0 requests).
          const shipCostsRef = db.collection("users").doc(uid).collection("margenes_meta").doc("ml_shipping_costs");
          let shipCostsKnown = {};
          try { const scs = await shipCostsRef.get(); if (scs.exists) shipCostsKnown = (scs.data()||{}).map || {}; } catch(_) {}
          const nuevos = {};
          const ids = [];
          for (const id of allIds) {
            const k = shipCostsKnown[id];
            if (k && typeof k === "object" && isFinite(parseFloat(k.cost))) {
              mlLogi[id] = { lt: k.lt || null, cost: parseFloat(k.cost) || 0 };
              mlEnvioDebug.cacheHits++;
              if (mlLogi[id].lt === "self_service") mlEnvioDebug.flex++; else { mlEnvioDebug.costsOk++; mlEnvioDebug.sumCost += mlLogi[id].cost; }
            } else ids.push(id);
          }
          for (let i=0; i<ids.length; i+=20) {
            const rs = await Promise.all(ids.slice(i,i+20).map(async id => {
              try {
                // /shipments/{id} y /shipments/{id}/costs en PARALELO (antes iban
                // encadenados por item — el lote tardaba el doble). Para Flex la
                // respuesta de /costs no se usa; el costo extra es despreciable
                // frente a la mitad de latencia por lote.
                const [r, rc] = await Promise.all([
                  fetch(`https://api.mercadolibre.com/shipments/${id}`, { headers: { Authorization:`Bearer ${tokML.accessToken}` } }),
                  fetch(`https://api.mercadolibre.com/shipments/${id}/costs`, { headers: { Authorization:`Bearer ${tokML.accessToken}` } }).catch(()=>null),
                ]);
                if (!r.ok) return [id, null];
                const j = await r.json();
                const lt = j.logistic_type || null;
                let cost = parseFloat(j.shipping_option?.list_cost) || 0;
                if (lt === "self_service") { mlEnvioDebug.flex++; }
                else {
                  let ok = false;
                  try {
                    if (rc && rc.ok) {
                      const jc = await rc.json();
                      if (Array.isArray(jc.senders) && jc.senders.length) {
                        cost = jc.senders.reduce((s,x)=>s+(parseFloat(x.cost)||0),0);
                        mlEnvioDebug.sumCost += cost;
                        mlEnvioDebug.sumSave += jc.senders.reduce((s,x)=>s+(parseFloat(x.save)||0),0);
                        if (!mlEnvioDebug.sample) mlEnvioDebug.sample = JSON.stringify(jc).slice(0,900);
                        ok = true;
                      }
                    }
                  } catch(_) {}
                  if (ok) mlEnvioDebug.costsOk++; else mlEnvioDebug.costsFallback++;
                }
                // Solo se cachea lo inmutable: envíos ya despachados/entregados.
                // Un envío pendiente puede cambiar de costo hasta el despacho.
                if (/^(shipped|delivered|not_delivered)$/.test(String(j.status||""))) nuevos[id] = { lt, cost };
                return [id, { lt, cost }];
              } catch(_) { return [id, null]; }
            }));
            for (const [id,v] of rs) if (v) mlLogi[id] = v;
          }
          // Escritura best-effort al final. Cap del doc: con ~8000 entradas
          // (~400KB) deja de crecer — nunca acercarse al límite de 1MB/doc.
          if (Object.keys(nuevos).length && Object.keys(shipCostsKnown).length < 8000) {
            try { await shipCostsRef.set({ map: nuevos }, { merge: true }); } catch(_) {}
          }
        }
      } catch(_) {}
      const mlEnvioDe  = o => {
        // Venta devuelta/reembolsada: ML anula el cargo de envío en la facturación
        // ("Anulaciones de cargos") — no es un costo real, no se cuenta.
        if (o?.refunded) return 0;
        const s = mlLogi[o?.shippingId];
        if (!s) return 0;
        // Flex: costo propio configurado (fallback: promedio de tienda) · Mercado Envíos: costo real
        return s.lt === "self_service" ? (envioMlFlex!=null ? envioMlFlex : envioProm) : (s.cost || 0);
      };
      const mlEnvioTot = raw => (raw?.ml_data?.ml_orders_detail||[]).reduce((s,o)=>s+mlEnvioDe(o),0);

      // ── Comisión REAL de MP por venta (Shopify) — matcheo por receipt_id ──
      // Se resuelve ANTES de los totales para que el agregado sume SOLO las ventas
      // de ESTA tienda (no el total del MP, que con MP compartido entre tiendas/ML
      // incluye pagos ajenos). Se cachea en Firestore; cada orden se consulta 1 vez.
      const feeByRef = mpCommCurr.feeByRef || {};
      const feeByRefPrev = mpCommPrev.feeByRef || {};
      // Fee real de MP por payment_id — para cruzar las órdenes de Recurrentes
      // (suscripciones) que guardan su mp_payment_id y no matchean por ref.
      const feeByPayId = mpCommCurr.feeByPayId || {};
      const feeByPayIdPrev = mpCommPrev.feeByPayId || {};
      // Fee real de una orden: prioridad al fee exacto embebido (saleFee), después
      // el cruce por payment_id, después el cruce por ref. Null = usar el %.
      const realMpDe = (o, fbRef, fbPay) => {
        if (parseFloat(o.saleFee) > 0) return parseFloat(o.saleFee);
        // Suscripciones Recurrentes: payment_id explícito en la orden.
        if (o.mpPayId && fbPay && fbPay[o.mpPayId] != null) return parseFloat(fbPay[o.mpPayId]) || 0;
        // Ventas normales de MP: mpRefCache guarda el payment_id del receipt de la
        // transacción Shopify. Se prueba tanto el índice por payment_id (el que
        // matchea de verdad) como el de external_reference, en ese orden.
        const ref = mpRefCache[o.id];
        if (ref) {
          if (fbPay && fbPay[ref] != null) return parseFloat(fbPay[ref]) || 0;
          if (fbRef && fbRef[ref] != null) return parseFloat(fbRef[ref]) || 0;
        }
        return null;
      };
      const mpRefCache = (userData.margenesMpRefs && typeof userData.margenesMpRefs==="object" && !Array.isArray(userData.margenesMpRefs)) ? { ...userData.margenesMpRefs } : {};
      const shStoreRef = (userData.stores||[]).find(s => s.type==="shopify");
      if (shStoreRef?.shop && shStoreRef?.accessToken) {
        const tsPend = f => { const s=String(f||""); if(!s) return 0; const t=Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(s)?s:s+"-03:00"); return isNaN(t)?0:t; };
        const pend = [...(curr.raw?.orders_detail||[]), ...(prev.raw?.orders_detail||[])]
          .filter(o => /mercado\s*pago/i.test(o.pay||"") && !mpRefCache[o.id])
          .sort((a,b)=>tsPend(b.fecha)-tsPend(a.fecha))
          .slice(0, 40);
        let changed = false;
        for (let i=0; i<pend.length; i+=8) {
          const rs = await Promise.all(pend.slice(i,i+8).map(async o => {
            try {
              const r = await fetch(`https://${shStoreRef.shop}/admin/api/2024-10/orders/${o.id}/transactions.json`, { headers: { "X-Shopify-Access-Token": shStoreRef.accessToken } });
              if (!r.ok) return [o.id, null];
              const j = await r.json();
              const ok = (j.transactions||[]).filter(t => t.kind==="sale" && t.status==="success");
              const t = ok[ok.length-1];
              const ref = t?.receipt?.id || t?.receipt?.payment_id || null;
              return [o.id, ref ? String(ref) : null];
            } catch(_) { return [o.id, null]; }
          }));
          for (const [id,ref] of rs) { if (ref) { mpRefCache[id] = ref; changed = true; } }
        }
        if (changed) { try { await db.collection("users").doc(uid).set({ margenesMpRefs: mpRefCache }, { merge:true }); } catch(_) {} }
      }
      // Comisión de pago de Shopify: por orden, si matcheó su pago de MP real (por
      // receipt_id) usamos ESE fee; sino el % configurado del método. Suma SOLO las
      // órdenes de esta tienda → nunca arrastra otras tiendas/ML del MP compartido.
      function shopifyPayComm(raw, feeMap, feeMapPay) {
        let s = 0;
        for (const o of (raw?.orders_detail||[])) {
          const rev = parseFloat(o.revenue)||0;
          const realMp = realMpDe(o, feeMap, feeMapPay);
          s += (realMp!=null) ? realMp : rev * pctPagoFor(o.pay);
        }
        return s;
      }

      // ── Google Ads AUTOMÁTICO (Google Ads API) ──
      // Con la cuenta conectada (users/{uid}.googleAds.refresh_token) y las
      // credenciales en Vercel, el gasto real sale de GAQL (metrics.cost_micros).
      // Cualquier falta (token, credenciales, permisos) → null → rige el manual.
      async function fetchGoogleAdsAuto(sinceR, untilR) {
        try {
          const g = userData.googleAds;
          const cid = process.env.GOOGLE_ADS_CLIENT_ID, cs = process.env.GOOGLE_ADS_CLIENT_SECRET, dt = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
          if (!g?.refresh_token || !cid || !cs || !dt) {
            if (g?.refresh_token && !dt) gadsDiag = "falta el developer token en Vercel";
            return null;
          }
          const tr = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client_id: cid, client_secret: cs, refresh_token: g.refresh_token, grant_type: "refresh_token" }),
          });
          if (!tr.ok) { gadsDiag = `Google rechazó la sesión (HTTP ${tr.status}) — desvinculá y volvé a conectar Google Ads`; return null; }
          const at = (await tr.json()).access_token;
          if (!at) { gadsDiag = "Google no devolvió token de acceso — reconectá Google Ads"; return null; }
          // Self-healing de cuentas: si la conexión se hizo antes de que Google
          // aprobara el developer token, el callback guardó customers=[] y nadie
          // volvía a resolverlas — el gasto quedaba en manual para siempre. Acá
          // se re-listan y se persisten para las próximas cargas.
          let customers = g.customers || [];
          if (!customers.length) {
            // v25 (ago 2026): Google pasó a releases mensuales — v18 murió y devolvía
            // 404 en todo. Si esto vuelve a dar 404 en el futuro, subir la versión acá
            // y en google-ads-callback.js (developers.google.com/google-ads/api/docs/sunset-dates).
            const cr = await fetch("https://googleads.googleapis.com/v25/customers:listAccessibleCustomers", {
              headers: { Authorization: `Bearer ${at}`, "developer-token": dt },
            });
            if (cr.ok) {
              customers = ((await cr.json()).resourceNames || []).map(r => String(r).replace("customers/", ""));
              if (customers.length) db.collection("users").doc(uid).set({ googleAds: { ...g, customers } }, { merge: true }).catch(()=>{});
              else gadsDiag = "la cuenta de Google conectada no tiene cuentas de Google Ads accesibles";
            } else {
              const txt = (await cr.text().catch(()=>"" )).slice(0, 300);
              gadsDiag = `Google Ads API rechazó el listado de cuentas (HTTP ${cr.status}${/DEVELOPER_TOKEN/i.test(txt) ? " — developer token sin aprobar por Google" : ""})`;
              console.error("gads listAccessibleCustomers HTTP", cr.status, txt.slice(0,200));
            }
          }
          let total = 0, any = false;
          const searchErrs = [];
          for (const c of (customers || []).slice(0, 5)) {
            const cn = String(c).replace(/^customers\//, "").replace(/-/g, "");
            const r = await fetch(`https://googleads.googleapis.com/v25/customers/${cn}/googleAds:search`, {
              method: "POST",
              headers: { Authorization: `Bearer ${at}`, "developer-token": dt, "Content-Type": "application/json",
                ...(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ? { "login-customer-id": String(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID).replace(/-/g, "") } : {}) },
              body: JSON.stringify({ query: `SELECT metrics.cost_micros, metrics.conversions, metrics.conversions_value, segments.date FROM customer WHERE segments.date BETWEEN '${sinceR}' AND '${untilR}'` }),
            });
            if (!r.ok) {
              const txt = (await r.text().catch(()=>"" )).slice(0, 1200);
              searchErrs.push(`HTTP ${r.status}${/DEVELOPER_TOKEN_NOT_APPROVED/i.test(txt) ? " (developer token sin aprobar)" : /DEVELOPER_TOKEN_PROHIBITED/i.test(txt) ? " (el developer token no puede usarse con este proyecto de Google Cloud)" : /USER_PERMISSION_DENIED/i.test(txt) ? " (la cuenta Google conectada no tiene acceso directo a esa cuenta de Ads — puede faltar login-customer-id del MCC)" : /CUSTOMER_NOT_ENABLED/i.test(txt) ? " (la cuenta de Ads está desactivada)" : /REQUESTED_METRICS_FOR_MANAGER/i.test(txt) ? " (cuenta administrador MCC, sin métricas propias)" : ""}`);
              console.error("gads search HTTP", r.status, txt);
              continue;
            }
            const j = await r.json();
            for (const row of (j.results || [])) {
              total += (parseFloat(row.metrics?.costMicros) || 0) / 1e6; any = true;
              const k = `${sinceR}_${untilR}`;
              const a = gadsAttr[k] || (gadsAttr[k] = { conv: 0, convValue: 0 });
              a.conv += parseFloat(row.metrics?.conversions) || 0;
              a.convValue += parseFloat(row.metrics?.conversionsValue) || 0;
            }
          }
          if (!any && !gadsDiag) {
            gadsDiag = searchErrs.length ? `la consulta de gasto falló: ${searchErrs[0]}` : (customers.length ? "la API respondió sin gasto para el período" : gadsDiag);
          }
          return any ? +total.toFixed(2) : null;
        } catch (e) { gadsDiag = gadsDiag || ("error de red: " + e.message); console.error("Google Ads spend error:", e.message); return null; }
      }

      // Gasto real de Mercado Ads y Google Ads (API): ya se trajo en el
      // Promise.all principal de arriba (mlAdsAutoCurr/Prev, gAdsAutoCurr/Prev).
      totals     = aplicarCostos(totals,     curr.raw, since,     until,     span+1, shopifyPayComm(curr.raw, feeByRef, feeByPayId),     mlEnvioTot(curr.raw), mlAdsAutoCurr, gAdsAutoCurr);
      prevTotals = aplicarCostos(prevTotals, prev.raw, prevSince, prevUntil, span+1, shopifyPayComm(prev.raw, feeByRefPrev, feeByPayIdPrev), mlEnvioTot(prev.raw), mlAdsAutoPrev, gAdsAutoPrev);

      // ── Comparativa estilo Shopify: "Hoy" vs AYER HASTA LA MISMA HORA ──
      // Con rango = hoy, comparar el día parcial contra ayer COMPLETO infla los
      // deltas. Se arma prevTotalsHora (solo informativo — prevTotals queda
      // intacto para gráficos/canales): ventas y órdenes de ayer REALES hasta la
      // hora actual (hora AR de cada orden), costos proporcionales a esas ventas,
      // y pauta prorrateada por hora del día (corre todo el día). El front usa
      // esto SOLO para los chips de comparación de las cards.
      let prevTotalsHora = null, prevHasta = null;
      if (since === argToday && until === argToday) {
        try {
          const horaFmt = new Intl.DateTimeFormat("en-GB",{timeZone:"America/Argentina/Buenos_Aires",hour:"2-digit",minute:"2-digit",hour12:false});
          prevHasta = horaFmt.format(new Date()); // "08:20"
          const [hN,mN] = prevHasta.split(":").map(Number);
          const minsAhora = hN*60 + mN;
          const fTime = Math.max(0.01, Math.min(1, minsAhora/1440));
          const minAR = f => { const s=String(f||""); if(!s) return null; const t=Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(s)?s:s+"-03:00"); if(isNaN(t)) return null; const [h,m]=horaFmt.format(new Date(t)).split(":").map(Number); return h*60+m; };
          // Ventas de ayer hasta esta hora (tienda + ML) — hora real de cada orden
          let revH = 0, ordH = 0, revDia = 0, ordDia = 0;
          for (const o of [...(prev.raw?.orders_detail||[]), ...(prev.raw?.ml_data?.ml_orders_detail||[])]) {
            if (o.refunded) continue; // devoluciones ML: excluidas de los totales, también acá
            const r = parseFloat(o.revenue)||0;
            revDia += r; ordDia++;
            const m = minAR(o.fecha);
            if (m == null || m <= minsAhora) { revH += r; ordH++; }
          }
          // Fracción real de ventas transcurridas a esta hora (fallback: fracción del día)
          const fRev = revDia > 0 ? Math.min(1, revH/revDia) : fTime;
          const fOrd = ordDia > 0 ? Math.min(1, ordH/ordDia) : fTime;
          const revenueH = +((prevTotals.revenue||0) * fRev).toFixed(2);
          const ordersH  = Math.round((prevTotals.orders||0) * fOrd);
          const adSpendH = +((prevTotals.adSpend||0) * fTime).toFixed(2);
          // Costos proporcionales a las ventas × fRev; fijos/adicionales × fTime
          const costesH  = ((prevTotals.costoProductos||0) + (prevTotals.impuestos||0) + (prevTotals.comisionPlataforma||0) + (prevTotals.comisionPago||0) + (prevTotals.costoEnvio||0)) * fRev
                         + (prevTotals.costosAdicionales||0) * fTime;
          const profitH  = +(revenueH - costesH - adSpendH).toFixed(2);
          const netRevH  = +(profitH + adSpendH).toFixed(2);
          prevTotalsHora = {
            revenue: revenueH, orders: ordersH, adSpend: adSpendH, profit: profitH, netRevenue: netRevH,
            profitMargin: revenueH>0 ? profitH/revenueH : 0,
            roas: adSpendH>0 ? revenueH/adSpendH : 0,
            trueRoas: adSpendH>0 ? netRevH/adSpendH : 0,
            cpa: ordersH>0 ? adSpendH/ordersH : 0,
            aov: ordersH>0 ? revenueH/ordersH : 0,
            breakEvenRoas: netRevH>0 ? revenueH/netRevH : 0,
            cpaBreakEven: ordersH>0 ? netRevH/ordersH : 0,
          };
        } catch (_) { prevTotalsHora = null; prevHasta = null; /* comparación normal si algo falla */ }
      }

      // ── Filas diarias alineadas con el motor real ──
      // Antes las filas usaban la "commission" legacy (aprox. 3%/10%): los
      // sparklines y deltas diarios NO cerraban contra los totales reales.
      // Ahora: (1) la facturación externa entra a su día; (2) los costos
      // proporcionales al revenue (COGS, impuestos, comisiones, envío) se
      // aplican por día con la tasa real del período; (3) los adicionales se
      // prorratean por día; (4) el Ad Spend diario incluye fee del dólar y el
      // reparto diario de Mercado Ads + costos marcados como pauta.
      // La suma de las filas = el total del motor.
      function mergeFactExtRows(rowsArr) {
        if (!factExt.length) return rowsArr;
        const byF = {};
        for (const r of factExt) if (r.fecha) { const e = byF[r.fecha] || (byF[r.fecha] = {m:0,o:0}); e.m += parseFloat(r.monto)||0; e.o += parseInt(r.ord)||0; }
        return rowsArr.map(r => { const e = byF[r.Fecha]; return e ? { ...r, Revenue: +((r.Revenue||0)+e.m).toFixed(2), "Ordenes > $0": (r["Ordenes > $0"]||0)+e.o } : r; });
      }
      function alinearRows(rowsArr, tot, dias) {
        const rev = tot.revenue || 0;
        const ratioDesc  = rev>0 ? ((tot.impuestos||0)+(tot.comisionPlataforma||0)+(tot.comisionPago||0))/rev : 0;
        const ratioCosto = rev>0 ? ((tot.costoProductos||0)+(tot.costoEnvio||0))/rev : 0;
        const fijoDia      = dias>0 ? (tot.costosAdicionales||0)/dias : 0;
        const adRepartoDia = dias>0 ? ((tot.adSpendMl||0)+(tot.adSpendGoogle||0)+(tot.adSpendExtra||0))/dias : 0;
        return rowsArr.map(r => {
          const revD = r.Revenue||0;
          const adD  = (r["Ad Spend"]||0)*(1+feeAd) + adRepartoDia;
          const profitD = revD*(1-ratioDesc-ratioCosto) - fijoDia - adD;
          const netD = profitD + adD; // neto = contribución antes de pauta
          const ordD = r["Ordenes > $0"]||0;
          return { ...r, "Ad Spend": +adD.toFixed(2), "Net Revenue": +netD.toFixed(2), Profit: +profitD.toFixed(2),
            "Profit Margin": revD>0 ? parseFloat((profitD/revD).toFixed(6)) : 0,
            ROAS: adD>0 ? parseFloat((revD/adD).toFixed(4)) : 0,
            "True ROAS": adD>0 ? parseFloat((netD/adD).toFixed(4)) : 0,
            CPA: ordD>0 ? parseFloat((adD/ordD).toFixed(2)) : 0 };
        });
      }
      // dias = cantidad real de filas, no span+1: Meta a veces devuelve un día
      // de más/menos en los daily insights (time_range se interpreta en el huso
      // horario de la cuenta publicitaria, no en el nuestro), y esa fila extra
      // entra al Set de allDates de buildRendRows. Prorratear con la cantidad
      // real de filas evita que costosAdicionales quede levemente sobre/sub
      // contado en la suma diaria vs el total.

      // ── Costos VARIABLES reales por día (desde cada orden) ──
      // Antes el profit diario era proporcional (revenue del día × ratio del
      // período): un día que vendió solo productos de bajo margen mostraba el
      // mismo margen % que el resto. Ahora COGS/impuestos/comisiones/envío se
      // computan orden por orden a su fecha real. El pequeño residuo (fact.
      // externa, redondeos, fórmula agregada de impuestos) se reparte por
      // revenue para que la suma diaria siga cerrando EXACTA contra el total.
      function costosDiarios(raw) {
        const porDia = {};                       // fecha -> costo variable del día
        const chContrib = { tienda:{}, ml:{} };  // fecha -> contribución (rev-costos, sin pauta) por canal
        const priceByKey = {};
        for (const p of (raw?.products||[])) for (const v of (p.variants||[])) { const k=v.sku||String(v.id); if (priceByKey[k]==null) priceByKey[k]=v.price; }
        const rk = makeKeyResolver(raw);
        const idx = costIndexOf(raw);
        const cogsDe = o => (o.items||[]).reduce((s,it)=>s+cogsCosto(costEntryOf(idx, it), priceByKey[rk(it)], String(o.fecha||"").slice(0,10))*(it.qty||0),0);
        const add = (fecha, ch, cost, rev) => {
          const f = String(fecha||"").slice(0,10); if (!f) return;
          porDia[f] = (porDia[f]||0) + cost;
          chContrib[ch][f] = (chContrib[ch][f]||0) + (rev - cost);
        };
        for (const o of (raw?.orders_detail||[])) {
          const rev=parseFloat(o.revenue)||0, cogs=cogsDe(o), imp=rev*impFor(o.pay);
          const env=((envioModoTienda==="orden")?(parseFloat(o.envioCosto)||0):envioProm)+fulfillFee;
          const realMp=realMpDe(o, feeByRef, feeByPayId);
          const comis=(realMp!=null)?(rev*pctPlat+realMp):(rev*(pctPlat+pctPagoFor(o.pay)));
          add(o.fecha, "tienda", cogs+imp+comis+env, rev);
        }
        for (const o of (raw?.ml_data?.ml_orders_detail||[])) {
          if (o.refunded) continue; // devoluciones/contracargos ML: fuera de los totales (processML ya las excluye)
          const rev=parseFloat(o.revenue)||0;
          add(o.fecha, "ml", cogsDe(o) + rev*pctImpML + (parseFloat(o.saleFee)||0) + mlEnvioDe(o)+fulfillFee, rev);
        }
        return { porDia, chContrib };
      }
      function alinearRowsExacto(rowsArr, tot, dias, porDia) {
        const rev = tot.revenue || 0;
        const totVar = (tot.costoProductos||0)+(tot.impuestos||0)+(tot.comisionPlataforma||0)+(tot.comisionPago||0)+(tot.costoEnvio||0);
        const sumDc = Object.values(porDia).reduce((a,b)=>a+b,0);
        const residRatio = rev>0 ? (totVar - sumDc)/rev : 0;
        const ratioDesc  = rev>0 ? ((tot.impuestos||0)+(tot.comisionPlataforma||0)+(tot.comisionPago||0))/rev : 0;
        const fijoDia      = dias>0 ? (tot.costosAdicionales||0)/dias : 0;
        const adRepartoDia = dias>0 ? ((tot.adSpendMl||0)+(tot.adSpendGoogle||0)+(tot.adSpendExtra||0))/dias : 0;
        return rowsArr.map(r => {
          const revD = r.Revenue||0;
          const adD  = (r["Ad Spend"]||0)*(1+feeAd) + adRepartoDia;
          const costD = (porDia[r.Fecha]||0) + revD*residRatio;
          const profitD = revD - costD - fijoDia - adD;
          const netD = profitD + adD; // neto = contribución antes de pauta
          const ordD = r["Ordenes > $0"]||0;
          return { ...r, "Ad Spend": +adD.toFixed(2), "Net Revenue": +netD.toFixed(2), Profit: +profitD.toFixed(2),
            "Profit Margin": revD>0 ? parseFloat((profitD/revD).toFixed(6)) : 0,
            ROAS: adD>0 ? parseFloat((revD/adD).toFixed(4)) : 0,
            "True ROAS": adD>0 ? parseFloat((netD/adD).toFixed(4)) : 0,
            CPA: ordD>0 ? parseFloat((adD/ordD).toFixed(2)) : 0 };
        });
      }
      const cdCurr = costosDiarios(curr.raw);
      const rowsPreAlign = mergeFactExtRows(rows);
      const prevRowsPreAlign = mergeFactExtRows(prevRows);
      rows     = alinearRowsExacto(rowsPreAlign, totals, rowsPreAlign.length || (span+1), cdCurr.porDia);
      prevRows = alinearRows(prevRowsPreAlign, prevTotals, prevRowsPreAlign.length || (span+1));
      const byDow = computeRendDow(rows);

      // ── Desglose por canal (Tienda vs Mercado Libre) para los tableros ──
      // adSpend: Tienda = Meta Ads (toda la pauta de Meta empuja la tienda);
      // ML = publicidad de Mercado Ads (pendiente de integrar; por ahora 0).
      function canal(raw, isMl, mpComm, adSpend, mlEnv, mpRev) {
        const dr = isMl ? (raw?.ml_data?.daily_revenue||{}) : (raw?.daily_revenue||{});
        const dord = isMl ? (raw?.ml_data?.daily_orders||{}) : (raw?.daily_orders||{});
        const rev = Object.values(dr).reduce((a,b)=>a+b,0);
        const ord = Object.values(dord).reduce((a,b)=>a+b,0);
        const cogs = isMl ? cogsPorCanal(raw).ml : cogsPorCanal(raw).tienda;
        // Impuestos: tienda con su % (+ ajuste por método), ML con el suyo.
        let impuestos;
        if (isMl) { impuestos = rev*pctImpML; }
        else {
          impuestos = rev*pctImp;
          for (const o of (raw?.orders_detail||[])) {
            const rate = impFor(o.pay);
            if (rate !== pctImp) impuestos += (parseFloat(o.revenue)||0) * (rate - pctImp);
          }
        }
        // Comisión separada como en el general: Plataforma vs Pago.
        const comPlat = isMl ? (parseFloat(raw?.ml_data?.ml_commission)||0) : rev*pctPlat;
        const comPago = isMl ? 0 : (parseFloat(mpComm)||0); // mpComm ya = shopifyPayComm de esta tienda
        const comis = comPlat + comPago;
        const envio = (isMl
          ? (parseFloat(mlEnv)||0)
          : ((envioModoTienda==="orden" && (raw?.orders_detail||[]).length)
              ? (raw.orders_detail||[]).reduce((s,o)=>s+(parseFloat(o.envioCosto)||0),0)
              : ord*envioProm)) + fulfillFee*ord;
        const ads = parseFloat(adSpend)||0;
        const profit = rev - cogs - impuestos - comis - envio - ads;
        const netRev = profit + ads; // neto = contribución antes de pauta
        return { orders:ord, revenue:+rev.toFixed(2), netRevenue:+netRev.toFixed(2), adSpend:+ads.toFixed(2),
          costoProductos:+cogs.toFixed(2), impuestos:+impuestos.toFixed(2),
          comisiones:+comis.toFixed(2), comisionPlataforma:+comPlat.toFixed(2), comisionPago:+comPago.toFixed(2),
          costoEnvio:+envio.toFixed(2), costosAdicionales:0,
          profit:+profit.toFixed(2), margin: rev>0?profit/rev:0,
          roas: ads>0?rev/ads:0, trueRoas: ads>0?netRev/ads:0,
          cpa: ord>0?ads/ord:0, cpaBreakEven: ord>0?(profit+ads)/ord:0,
          mer: rev>0?ads/rev:0, breakEvenRoas: (profit+ads)>0?rev/(profit+ads):0,
          aov: ord>0?rev/ord:0, aovNeto: ord>0?netRev/ord:0 };
      }
      const byChannel = {
        // Fila propia de Google Ads para la tabla de Canales: el gasto es real
        // (API) y órdenes/revenue son las conversiones ATRIBUIDAS POR GOOGLE
        // (su modelo) — no se pueden cruzar con las órdenes de la tienda, así
        // que la fila se marca como atribución de Google. Sin conexión o sin
        // gasto en el período no aparece.
        google: (()=>{
          const ads = totals.adSpendGoogle||0;
          if (!(ads>0) || gAdsAutoCurr==null) return null;
          const a = gadsAttr[`${since}_${until}`] || null;
          const conv = a ? Math.round(a.conv||0) : 0;
          const cval = a ? (a.convValue||0) : 0;
          return { adSpend:+ads.toFixed(2), atribGoogle:true,
            ...(conv>0||cval>0 ? {
              orders: conv, revenue:+cval.toFixed(2),
              roas: +(cval/ads).toFixed(2),
              cpa: conv>0 ? +(ads/conv).toFixed(2) : undefined,
              aov: conv>0 ? +(cval/conv).toFixed(2) : undefined,
            } : {}) };
        })(),
        tienda: canal(curr.raw, false, shopifyPayComm(curr.raw, feeByRef, feeByPayId), totals.adSpendMeta + (totals.adSpendGoogle||0), 0, mpCommCurr.rev),
        ml:     canal(curr.raw, true,  0, totals.adSpendMl, mlEnvioTot(curr.raw), 0),
        tiendaPrev: canal(prev.raw, false, shopifyPayComm(prev.raw, feeByRefPrev, feeByPayIdPrev), prevTotals.adSpendMeta + (prevTotals.adSpendGoogle||0), 0, mpCommPrev.rev),
        mlPrev:     canal(prev.raw, true,  0, prevTotals.adSpendMl, mlEnvioTot(prev.raw), 0),
        platform: curr.raw?.platform || (curr.raw?.products?.[0]?.platform) || "tiendanube",
        hasMl: !!(curr.raw?.ml_data),
      };
      // Series diarias POR CANAL — para que las vistas Tienda/ML tengan su
      // propio gráfico de evolución (revenue y órdenes del canal, día a día).
      const byChannelDaily = {
        tienda: { revenue: curr.raw?.daily_revenue||{}, orders: curr.raw?.daily_orders||{}, contrib: cdCurr.chContrib.tienda },
        ml:     { revenue: curr.raw?.ml_data?.daily_revenue||{}, orders: curr.raw?.ml_data?.daily_orders||{}, contrib: cdCurr.chContrib.ml },
      };


      // Nombre legible producto+variante. Regla: si el producto tiene VARIAS
      // variantes, se muestra "Producto · <nombre de variante>", y si la variante
      // no tiene nombre real (Default/Default Title) se cae al SKU — NUNCA al id
      // random. Si el producto tiene una sola variante (Default Title), se muestra
      // solo el nombre del producto (sin el "· Default Title" feo).
      const prodLabel = (p, v) => {
        const nombre = p.nombre || v.sku || String(v.id);
        const multiVar = (p.variants || []).length > 1;
        const vn = String(v.nombre || "").trim();
        const vnReal = vn && vn !== "Default" && vn !== "Default Title" ? vn : "";
        const sku = String(v.sku || "").trim();
        // suffix: nombre de variante real; si no y es multi-variante, el SKU.
        const suffix = vnReal || (multiVar ? sku : "");
        return nombre + (suffix ? " · " + suffix : "");
      };
      // Nombres legibles por key (sku/variant/publicación ML) — para el detalle
      // de cada venta (drill-down) y la tabla de productos.
      const nameByKeyGlobal = {};
      for (const p of (curr.raw?.products||[])) for (const v of (p.variants||[])) { const k=v.sku||String(v.id); if (nameByKeyGlobal[k]==null) nameByKeyGlobal[k]=prodLabel(p,v); }
      for (const m of (curr.raw?.ml_data?.ml_products||[])) { if (nameByKeyGlobal["ml:"+m.id]==null) nameByKeyGlobal["ml:"+m.id]=m.nombre||("ML "+m.id); }

      // ── Venta por venta: cada orden con sus costos reales ──
      function buildSales(raw) {
        const list = [];
        // Precio de venta por key (sku/variant id) para poder resolver COGS en %.
        const priceByKey = {};
        for (const p of (raw?.products||[])) for (const v of (p.variants||[])) { const k=v.sku||String(v.id); if (priceByKey[k]==null) priceByKey[k]=v.price; }
        const rk = makeKeyResolver(raw);
        const idx = costIndexOf(raw);
        const cogsDe = o => (o.items||[]).reduce((s,it)=>s+cogsCosto(costEntryOf(idx, it), priceByKey[rk(it)], String(o.fecha||"").slice(0,10))*(it.qty||0),0);
        const itemsDe = items => (items||[]).map(it=>{ const k=rk(it); return { n: nameByKeyGlobal[k]||it.n||k, q: it.qty||0 }; });
        for (const o of (raw?.orders_detail||[])) {
          const rev=parseFloat(o.revenue)||0, cogs=cogsDe(o), imp=rev*impFor(o.pay);
          const env = ((envioModoTienda==="orden") ? (parseFloat(o.envioCosto)||0) : envioProm) + fulfillFee;
          // Comisión = % plataforma + comisión de pago: fee exacto embebido, cruce
          // por payment_id (Recurrentes) o por receipt_id; si no, el % configurado.
          const realMp = realMpDe(o, feeByRef, feeByPayId);
          const comis = (realMp!=null) ? (rev*pctPlat + realMp) : (rev*(pctPlat+pctPagoFor(o.pay)));
          const profit=rev-cogs-imp-comis-env;
          list.push({ id:o.id, nombre:o.nombre, fecha:o.fecha, canal:(curr.raw?.platform==="shopify"?"Shopify":"Tienda Nube"), revenue:+rev.toFixed(2), cogs:+cogs.toFixed(2), impuestos:+imp.toFixed(2), comisiones:+comis.toFixed(2), envio:+env.toFixed(2), profit:+profit.toFixed(2), margin: rev>0?profit/rev:0,
            pay:o.pay||"", cust:o.cust||"", items:itemsDe(o.items), feeReal: realMp!=null });
        }
        for (const o of (raw?.ml_data?.ml_orders_detail||[])) {
          if (o.refunded) continue; // devoluciones/contracargos ML: no van en la tabla (los totales ya las excluyen)
          const rev=parseFloat(o.revenue)||0, cogs=cogsDe(o), imp=rev*pctImpML, comis=parseFloat(o.saleFee)||0, env=mlEnvioDe(o)+fulfillFee;
          const profit=rev-cogs-imp-comis-env;
          list.push({ id:o.id, nombre:o.nombre, fecha:o.fecha, canal:o.shippingId&&mlLogi[o.shippingId]?.lt==="self_service"?"ML Flex":"Mercado Libre", revenue:+rev.toFixed(2), cogs:+cogs.toFixed(2), impuestos:+imp.toFixed(2), comisiones:+comis.toFixed(2), envio:+env.toFixed(2), profit:+profit.toFixed(2), margin: rev>0?profit/rev:0,
            pay:"Mercado Pago", cust:o.cust||"", items:itemsDe(o.items), feeReal: true, mlLink:`https://www.mercadolibre.com.ar/ventas/${o.id}/detalle` });
        }
        // Orden por INSTANTE real, no por texto: cada canal trae la fecha en un
        // formato distinto (TN hora AR sin offset, Shopify -03:00, ML -04:00) y
        // el compare lexicográfico mandaba las ventas recién caídas de ML abajo.
        // Sin offset en el string se asume hora Argentina (-03:00).
        const tsDe = f => { const s=String(f||""); if(!s) return 0; const t=Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(s)?s:s+"-03:00"); return isNaN(t)?0:t; };
        list.sort((a,b)=>tsDe(b.fecha)-tsDe(a.fecha));
        return list.slice(0, 600);
      }
      const sales = buildSales(curr.raw);

      // ── Rentabilidad por producto/SKU ──
      // Los costos por orden (impuestos, comisiones, envío) se reparten entre los
      // items de la orden por peso precio×cantidad; el COGS es directo por item.
      // NO incluye Ad Spend (es a nivel cuenta): es margen de contribución.
      function buildByProduct(raw) {
        const nameByKey = {}, priceByKey = {};
        for (const p of (raw?.products||[])) for (const v of (p.variants||[])) {
          const k = v.sku || String(v.id);
          if (nameByKey[k]==null) nameByKey[k] = prodLabel(p, v);
          if (priceByKey[k]==null) priceByKey[k] = parseFloat(v.price)||0;
        }
        for (const m of (raw?.ml_data?.ml_products||[])) { if (nameByKey["ml:"+m.id]==null) nameByKey["ml:"+m.id] = m.nombre || ("ML "+m.id); }
        // Canonicaliza cada item a la key actual de su variante (por variant_id
        // estable, luego SKU) para que rename/cambio de SKU no parta el recuento.
        const rk = makeKeyResolver(raw);
        const idx = costIndexOf(raw);
        const agg = {};
        // fallbackName = nombre embebido en la orden (it.n): se usa solo si la
        // variante ya no está en el catálogo, así nunca mostramos el id pelado.
        const slot = (key, canal, fallbackName) => agg[key] || (agg[key] = { key, nombre:nameByKey[key]||fallbackName||key, canal, units:0, orders:0, revenue:0, cogs:0, impuestos:0, comisiones:0, envio:0, sinCogs:false });
        const repartir = (o, items, imp, comis, env, canal, mlKey) => {
          const rev = parseFloat(o.revenue)||0;
          const f = String(o.fecha||"").slice(0,10);
          const its = (items||[]).map(it=>{ const k=rk(it); return { ...it, k, w:(priceByKey[k]||0)*(it.qty||0) }; });
          let wSum = its.reduce((s,it)=>s+it.w,0);
          if (wSum<=0) { its.forEach(it=>it.w=it.qty||0); wSum = its.reduce((s,it)=>s+it.w,0)||1; }
          for (const it of its) {
            const sh = it.w/wSum;
            const a = slot(it.k, canal, it.n);
            const entry = costEntryOf(idx, it);
            a.units += it.qty||0; a.orders += 1;
            a.revenue += rev*sh; a.impuestos += imp*sh; a.comisiones += comis*sh; a.envio += env*sh;
            a.cogs += cogsCosto(entry, priceByKey[it.k], f)*(it.qty||0);
            if (entry == null) a.sinCogs = true; // alguna venta de este producto no matcheó costo
          }
        };
        for (const o of (raw?.orders_detail||[])) {
          const rev = parseFloat(o.revenue)||0;
          const ref = mpRefCache[o.id];
          const realMp = (ref && feeByRef[ref]!=null) ? feeByRef[ref] : null;
          const comis = (realMp!=null) ? (rev*pctPlat + realMp) : (rev*(pctPlat+pctPagoFor(o.pay)));
          const env = ((envioModoTienda==="orden") ? (parseFloat(o.envioCosto)||0) : envioProm) + fulfillFee;
          repartir(o, o.items, rev*impFor(o.pay), comis, env, "tienda");
        }
        for (const o of (raw?.ml_data?.ml_orders_detail||[])) {
          if (o.refunded) continue; // devoluciones/contracargos ML: fuera del desglose por producto
          const rev = parseFloat(o.revenue)||0;
          repartir(o, o.items, rev*pctImpML, parseFloat(o.saleFee)||0, mlEnvioDe(o)+fulfillFee, "ml");
        }
        return Object.values(agg).map(a=>{
          const profit = a.revenue - a.cogs - a.impuestos - a.comisiones - a.envio;
          return { ...a, revenue:+a.revenue.toFixed(2), cogs:+a.cogs.toFixed(2), impuestos:+a.impuestos.toFixed(2),
            comisiones:+a.comisiones.toFixed(2), envio:+a.envio.toFixed(2), profit:+profit.toFixed(2),
            margin: a.revenue>0 ? profit/a.revenue : 0, sinCogs: a.sinCogs };
        }).sort((x,y)=>y.revenue-x.revenue).slice(0, 200);
      }
      const byProduct = buildByProduct(curr.raw);

      // ── Clientes nuevos vs recurrentes ──
      // "Recurrente" = compró también en el período anterior (aprox.: la ventana
      // de comparación es el período previo, no todo el historial).
      const allOrdersDe = raw => [...(raw?.orders_detail||[]), ...(raw?.ml_data?.ml_orders_detail||[])];
      const custKey = o => String(o.cust||"").trim().toLowerCase();
      const prevCust = new Set(allOrdersDe(prev.raw).map(custKey).filter(Boolean));
      const ordersByCust = {}; let custSinDato = 0;
      for (const o of allOrdersDe(curr.raw)) { const c = custKey(o); if (!c) { custSinDato++; continue; } ordersByCust[c] = (ordersByCust[c]||0)+1; }
      let custNuevos = 0, custRecurrentes = 0;
      for (const c of Object.keys(ordersByCust)) { if (prevCust.has(c)) custRecurrentes++; else custNuevos++; }
      const custTotal = custNuevos + custRecurrentes;
      const clientes = { nuevos:custNuevos, recurrentes:custRecurrentes, total:custTotal, sinDato:custSinDato,
        repeatRate: custTotal>0 ? custRecurrentes/custTotal : 0,
        repitenEnPeriodo: Object.values(ordersByCust).filter(n=>n>1).length };

      // ── Serie del dólar del período (para el modo USD del dashboard) ──
      const histMapFinal = await dolarAdsHistProm.catch(()=>null);
      // Un solo dólar operativo para todo el dashboard: el modo "Mostrar en dólares"
      // usa la MISMA cotización efectiva de Costos que se usa para el gasto de Ads y
      // los costos USD. Fallback al histórico día por día solo si no hay dólar de
      // Costos configurado.
      const dolarSerie = {};
      if (dolarCostosEf > 0) {
        for (let d = since; d <= until; d = addDays(d, 1)) dolarSerie[d] = dolarCostosEf;
      } else if (histMapFinal && histMapFinal.size) {
        for (let d = since; d <= until; d = addDays(d, 1)) { const v = dolarDeFecha(histMapFinal, d); if (v) dolarSerie[d] = v; }
      }
      const dolarActual = dolarCostosEf > 0 ? dolarCostosEf : ((histMapFinal && dolarDeFecha(histMapFinal, until)) || dolarAdsFallback || 0);

      // ── Calidad del dato / configuración — para que el dashboard diga cuándo
      // el número puede no ser exacto en vez de mostrarlo con pinta de real ──
      const sinCogsNombres = [];
      const _idxCurr = costIndexOf(curr.raw);
      for (const p of (curr.raw?.products||[])) for (const v of (p.variants||[])) {
        const has = _idxCurr[_norm(v.sku)] != null || _idxCurr[_norm(v.id)] != null;
        if ((v.units_sold||0)>0 && !has) sinCogsNombres.push(prodLabel(p, v));
      }
      for (const m of (curr.raw?.ml_data?.ml_products||[])) { if ((m.units||0)>0 && cogsMap["ml:"+m.id]==null) sinCogsNombres.push("ML · "+(m.nombre||m.id)); }
      const rawQ = curr.raw?.quality || {};
      const quality = {
        productosSinCogs: sinCogsNombres.length,
        productosSinCogsNombres: sinCogsNombres.slice(0,6),
        impuestosSinConfig: !(pctImp>0),
        envioSinConfig: envioModoTienda==="fijo" && !(envioProm>0),
        mpSinConfig: !(mpPctCfg>0) && (curr.raw?.orders_detail||[]).some(o=>esMPPay(o.pay) && !mpRefCache[o.id]),
        dolarAdsHistorico: dolarAdsHistDias>0,
        tnTruncated: !!rawQ.tn_truncated, mlTruncated: !!rawQ.ml_truncated,
        canceladasExcluidas: rawQ.cancelled_excluded||0,
        reembolsosParciales: rawQ.partial_refund_orders||0,
        mlDevueltas: (curr.raw?.ml_data?.ml_orders_detail||[]).filter(o=>o.refunded).length,
      };

      // Desglose de facturación TN: revenue = neto (bruto − descuento) + envío
      // cobrado al cliente — igual que la facturación que reporta el admin de TN.
      // Acá exponemos cada componente para que el total siempre sea auditable.
      const fB = curr.raw?.facturacion || null;
      const envioClienteTot = (curr.raw?.orders_detail||[]).reduce((s,o)=>s+(parseFloat(o.envioCliente)||0),0);
      const facturacionBreakdown = fB ? {
        bruto: fB.bruto, descuento: fB.descuento, neto: fB.neto,
        envioCliente: +envioClienteTot.toFixed(2),
        conEnvio: +(fB.neto + envioClienteTot).toFixed(2),
      } : null;
      // Desglose del Ad Spend de Meta: gasto original por moneda → conversión a
      // ARS (cotización histórica por día) → fee sobre pauta → total del dashboard.
      const adSpendBreakdown = Object.keys(adsBd.porMoneda).length ? {
        porMoneda: Object.fromEntries(Object.entries(adsBd.porMoneda).map(([k,v])=>[k, +v.toFixed(2)])),
        convertido: +adsBd.convertido.toFixed(2),
        cotizTipo: dolarAdsTipo,
        cotizAjuste: +(dolarAdsAjuste*100).toFixed(2),
        cotizOperativo: dolarCostosEf > 0, // true = se usó el dólar único de Costos (no el histórico día por día)
        cotizProm: adsBd.rateDias>0 ? +(adsBd.rateSum/adsBd.rateDias).toFixed(2) : null,
        diasSinCotiz: adsBd.sinCotiz,
        feePct: adsBd.convertido>0 ? +(adsBd.feeMonto/adsBd.convertido*100).toFixed(2) : 0,
        feeMonto: +adsBd.feeMonto.toFixed(2),
        total: +(adsBd.convertido + adsBd.feeMonto).toFixed(2), // convertido + fees por cuenta (feeAd global ya no aplica)
      } : null;

      // engineV: versión del motor de métricas. Se sube cuando cambia la DEFINICIÓN
      // de una métrica (v2 = facturación TN incluye envío cobrado al cliente;
      // v3 = corte de día TN en hora argentina; v4 = envío ML real con descuentos; v5 = envío ML en cero para ventas devueltas; v6 = Net Revenue = contribución antes de pauta) para que los caches del
      // cliente (P&L mensual) descarten resultados viejos.
      const responseBody = { engineV: 6, rows, prevRows, totals, prevTotals, prevTotalsHora, prevHasta, byDow, byChannel, byChannelDaily, sales, byProduct, clientes, facturacionBreakdown, adSpendBreakdown,
        cashflow: { ...(mpCommCurr.cashflow||{}), financingFee: mpCommCurr.financingFee||0, retenciones: mpCommCurr.retenciones||0 },
        dolarSerie, dolarActual, quality,
        since, until, prevSince, prevUntil,
        meta: { hasMetaData: Object.keys(metaCurr).length>0, hasStoreData: Object.keys(curr.dailyRevenue).length>0, metaAccountsCount: metaAccounts.length,
          mlAdsFuente: mlAdsAutoCurr!=null ? "auto" : (mlAdsList.length ? "manual" : "sin_datos"),
          googleAdsFuente: gAdsAutoCurr!=null ? "auto" : (googleAdsList.length ? "manual" : "sin_datos"),
          googleAdsConectado: !!userData.googleAds?.refresh_token,
          googleAdsDiag: (userData.googleAds?.refresh_token && gAdsAutoCurr==null) ? gadsDiag : null,
          stockDegradado: curr.degradado || prev.degradado || null, // ts del snapshot servido cuando TN/ML no respondieron en vivo
          mlAdsDebug, mlEnvioDebug,
          metaTokenExpired: !!metaErr.expired,
          costosConfigurados: { cogs: Object.keys(cogsMap).length, impuestos: pctImp*100, impuestosML: pctImpML*100, mpPct: mpPctCfg*100, plataforma: pctPlat*100, pago: pctPago*100, envioProm, envioModo: envioModoTienda, mlFlex: envioMlFlex, fulfillment: fulfillFee, fijosMensual, costosAdic: costosAdicList.length, feeAd: feeAd*100, dolar: +dolarValorEf.toFixed(2), dolarAdsTipo, dolarAdsHistDias, dolarAdsFallback: +dolarAdsFallback.toFixed(2) } } };
      // Guardar caché + registrar el rango en el warmer (best-effort: si Firestore
      // falla acá, la respuesta en vivo sale igual). Respuesta DEGRADADA (snapshot
      // viejo porque TN/ML no respondieron): NO se cachea — sería congelar datos
      // vencidos como si fueran frescos.
      try {
        if (responseBody.meta?.stockDegradado) throw Object.assign(new Error("skip-cache"), { _skip: true });
        const nowIso = new Date().toISOString();
        // Guard de tamaño (mismo criterio que saveStockCache en api/stock.js):
        // Firestore rechaza docs >1MB y el catch de acá abajo se lo tragaba →
        // los rangos grandes NUNCA quedaban cacheados y cada visita recalculaba
        // en vivo. Si no entra completo, se cachea una versión recortada (sin
        // byChannelDaily, byProduct a 50) que alcanza para pintar KPIs y filas.
        let bodyStr = JSON.stringify(responseBody);
        if (bodyStr.length > 850000) {
          const trimmed = { ...responseBody, byProduct: (responseBody.byProduct || []).slice(0, 50), trimmed: true };
          delete trimmed.byChannelDaily;
          bodyStr = JSON.stringify(trimmed);
        }
        if (bodyStr.length > 850000) {
          console.error(`margenes cache: rango ${cacheKey} no entra en Firestore ni recortado (${bodyStr.length} bytes) — no se cachea`);
        } else {
          await cacheRef.set({ body: bodyStr, cachedAt: nowIso, ts: Date.now() });
        }
        // Un documento por rango, NO un mapa dentro de un único doc global.
        // Antes todas las cuentas escribían en system/margenes_warm: Firestore
        // admite ~1 escritura por segundo por documento y tiene un techo de 1 MB
        // por doc — con cientos de cuentas eso se traba y después revienta.
        await db.collection("system_warm_margenes").doc(warmDocId(uid, cacheKey)).set({
          uid, key: cacheKey,
          days: req.query.date_from ? null : days,
          date_from: req.query.date_from || null, date_to: req.query.date_to || null,
          // lastAccess solo lo actualizan los requests de usuarios reales — el
          // warmer no se retroalimenta a sí mismo para siempre.
          ...(req.query.warm === "1" ? {} : { lastAccess: nowIso }),
          lastWarm: nowIso,
        }, { merge: true });
      } catch(e) { console.error("margenes cache set error:", e.message); }
      return res.json(responseBody);
    } catch(e) { console.error("Dashboard error:", e); return res.status(500).json({ error: e.message }); }
  }

  // ── Warmer del dashboard Márgenes (cron cada 5 min) ──
  // Recalcula EN VIVO los rangos más desactualizados que algún usuario haya
  // mirado en las últimas 48h y refresca su caché. Antes hacía UNO por corrida:
  // con 300 cuentas eso son 25 horas de vuelta, o sea nunca. Ahora va un lote
  // en paralelo, con rotación por lastWarm (el que hace más tiempo no se
  // recalcula va primero) y respetando el presupuesto de tiempo de la función.
  if (action === 'warm_margenes') {
    const t0 = Date.now();
    const DEADLINE = 55000;
    try {
      const db = initAdmin();
      const hace48h = new Date(Date.now() - 48*3600000).toISOString();
      let activos = [];
      try {
        // orderBy de un solo campo → usa el índice automático, sin índice compuesto.
        const snap = await db.collection("system_warm_margenes").orderBy("lastWarm", "asc").limit(200).get();
        activos = snap.docs.map(d => d.data()).filter(e => e && e.uid && (e.lastAccess||"") >= hace48h);
      } catch(e) { console.error("warm_margenes query error:", e.message); }

      // Compatibilidad: migrar el registro viejo (un único doc con un mapa
      // "entries") a la colección nueva, de a poco y sin bloquear la corrida.
      if (!activos.length) {
        try {
          const legacy = await db.collection("system").doc("margenes_warm").get();
          const entries = Object.values((legacy.data()||{}).entries || {});
          const vivos = entries.filter(e => e && e.uid && (e.lastAccess||"") >= hace48h);
          if (vivos.length) {
            const batch = db.batch();
            for (const e of vivos.slice(0, 400)) {
              batch.set(db.collection("system_warm_margenes").doc(warmDocId(e.uid, e.key)), e, { merge: true });
            }
            await batch.commit();
            activos = vivos;
          }
        } catch(e) { console.error("warm_margenes migracion error:", e.message); }
      }

      if (!activos.length) return res.json({ ok: true, warmed: [], motivo: "sin rangos activos en 48h" });
      activos.sort((a,b) => String(a.lastWarm||"").localeCompare(String(b.lastWarm||"")));

      // Cada recálculo tarda 30-50s, así que van en paralelo. El tope es bajo a
      // propósito: son subrequests reales contra la propia función.
      const LOTE = 4;
      const tanda = activos.slice(0, LOTE);
      const resultados = await Promise.all(tanda.map(async e => {
        if (Date.now() - t0 > DEADLINE) return { key: `${e.uid}|${e.key}`, ok: false, error: "sin tiempo" };
        try {
          const url = new URL(`https://${req.headers.host}/api/orders`);
          url.searchParams.set("action","daily_metrics"); url.searchParams.set("uid", e.uid); url.searchParams.set("warm","1");
          if (e.date_from && e.date_to) { url.searchParams.set("date_from", e.date_from); url.searchParams.set("date_to", e.date_to); }
          else url.searchParams.set("days", String(e.days || 30));
          // Subrequest server→server con el mismo CRON_SECRET: el warmer recalcula
          // la caché de uids ajenos y no tiene (ni debe tener) token de usuario.
          const r = await fetch(url.toString(), {
            headers: { host: req.headers.host, Authorization: `Bearer ${process.env.CRON_SECRET || ''}` },
            signal: AbortSignal.timeout(50000),
          });
          const j = await r.json().catch(() => ({}));
          return { key: `${e.uid}|${e.key}`, ok: r.ok && !j.error, error: j.error || null };
        } catch(err) { return { key: `${e.uid}|${e.key}`, ok: false, error: err.message }; }
      }));
      return res.json({ ok: true, pendientes: activos.length, warmed: resultados, ms: Date.now()-t0 });
    } catch(e) { console.error("warm_margenes error:", e.message); return res.status(500).json({ error: e.message }); }
  }

  // ── fin Rendimiento ──────────────────────────────────────────────────────

  if (!uid) return res.status(401).json({ error: "uid requerido" });

  let platform = 'tiendanube', storeId, accessToken, shop, mlUserId, mlToken;
  let dbRef;
  try {
    dbRef = initAdmin();
    const userSnap = await dbRef.collection("users").doc(uid).get();
    if (userSnap.exists) {
      const stores = userSnap.data().stores || [];
      const tnStore = stores.find(s => s.type === "tiendanube");
      const shStore = stores.find(s => s.type === "shopify");
      const mlStore = stores.find(s => s.type === "mercadolibre" || s.type === "meli");
      // Shopify tiene prioridad si está conectado
      if (shStore?.accessToken && shStore?.shop) {
        platform = 'shopify';
        shop = shStore.shop;
        accessToken = shStore.accessToken;
      } else if (tnStore?.accessToken && tnStore?.storeId) {
        platform = 'tiendanube';
        storeId = tnStore.storeId;
        accessToken = tnStore.accessToken;
      }
      // ML (en paralelo a la plataforma primaria, para que stats sume todo)
      const mlVentasStats = String(userSnap.data().margenesMlVentas || "");
      if (mlStore && mlVentasStats !== "__none__") {
        try {
          const tok = await getValidMLToken(dbRef, uid, mlVentasStats || null); // cuenta de ventas ML
          if (tok?.accessToken && tok?.userId) { mlUserId = tok.userId; mlToken = tok.accessToken; }
        } catch (_) {}
      }
    }
  } catch(e) {
    console.error("Error fetching user store:", e.message);
    return res.status(500).json({ error: "Error al obtener credenciales" });
  }
  if (!accessToken) return res.status(403).json({ error: "Tienda no conectada" });

  // ── Helpers Shopify ───────────────────────────────────────────────────
  const SH_HEADERS = { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' };
  const SH_BASE = platform === 'shopify' ? `https://${shop}/admin/api/2024-10` : null;

  async function fetchShopifyOrders(from, to, extraParams = '') {
    let all = [], url = `${SH_BASE}/orders.json?limit=250&status=any&financial_status=paid&created_at_min=${encodeURIComponent(from)}&created_at_max=${encodeURIComponent(to)}&fields=id,total_price,created_at${extraParams}`;
    while (url) {
      const r = await fetch(url, { headers: SH_HEADERS });
      if (!r.ok) break;
      const d = await r.json();
      const batch = d.orders || [];
      all = all.concat(batch);
      if (batch.length < 250) break;
      const link = r.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }
    return all;
  }

  const calcStats = (orders, isShopify) => ({
    count: orders.length,
    revenue: orders.reduce((sum, o) => sum + parseFloat(isShopify ? (o.total_price || 0) : (o.total || 0)), 0),
    units: orders.reduce((sum, o) => {
      // Shopify: line_items[].quantity. TN: products[].quantity.
      const items = isShopify ? (o.line_items || []) : (o.products || []);
      return sum + items.reduce((s, it) => s + (parseInt(it.quantity) || 0), 0);
    }, 0),
  });

  // ── ML orders helper ───────────────────────────────────────────
  // Trae todas las órdenes paid (no canceladas) en el rango con paginación.
  async function fetchMLOrdersInRange(from, to) {
    if (!mlUserId || !mlToken) return [];
    const all = [];
    const fromISO = new Date(from).toISOString().replace("Z", "-00:00");
    const toISO = new Date(to).toISOString().replace("Z", "-00:00");
    for (let offset = 0; offset < 2000; offset += 50) {
      try {
        const url = `https://api.mercadolibre.com/orders/search?seller=${mlUserId}&order.status=paid&order.date_created.from=${encodeURIComponent(fromISO)}&order.date_created.to=${encodeURIComponent(toISO)}&limit=50&offset=${offset}&sort=date_desc`;
        const r = await fetch(url, { headers: { Authorization: `Bearer ${mlToken}` } });
        if (!r.ok) break;
        const d = await r.json();
        const batch = d.results || [];
        all.push(...batch);
        if (batch.length < 50) break;
      } catch (_) { break; }
    }
    return all;
  }
  const calcMLStats = (mlOrders) => ({
    count: mlOrders.length,
    revenue: mlOrders.reduce((s, o) => s + (parseFloat(o.total_amount) || 0), 0),
    units: mlOrders.reduce((s, o) => s + ((o.order_items || []).reduce((u, it) => u + (parseInt(it.quantity) || 0), 0)), 0),
  });
  const mergeStats = (a, b) => ({
    count: (a.count || 0) + (b.count || 0),
    revenue: (a.revenue || 0) + (b.revenue || 0),
    units: (a.units || 0) + (b.units || 0),
  });

  try {
    // BULK LOOKUP (TN): trae una página de órdenes recientes para matchear SKUs
    // localmente. TN no soporta búsqueda por número de orden — hay que paginar
    // y filtrar local. El caso Shopify vive más abajo (necesita los helpers
    // shopifyFetchOrders/shopifyToTNFormat, que son const y todavía no existen acá).
    if (tab === 'bulk_lookup' && platform !== 'shopify') {
      const tnHeaders = { 'Authentication': `bearer ${accessToken}`, 'User-Agent': 'GrowithApp (contacto.growith@gmail.com)' };
      const page = parseInt(req.query.page) || 1;
      // Solo los campos que usa el estampado de SKUs (number + products) — el
      // payload completo de 200 órdenes pesaba ~1-2MB y hacía eterno el análisis.
      // Timeout de 40s: si TN está lenta devolvemos [] en vez de colgar la función.
      try {
        const r = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?per_page=200&page=${page}&fields=id,number,contact_name,products`, { headers: tnHeaders, signal: AbortSignal.timeout(40000) });
        if (!r.ok) return res.status(200).json([]);
        const data = await r.json();
        return res.status(200).json(Array.isArray(data) ? data : []);
      } catch (_) { return res.status(200).json([]); }
    }

    // ML_ENVIOS: pedidos de Mercado Libre para el panel de Envíos (solo
    // lectura — ML despacha con su propia logística; acá se ve el ESTADO).
    if (tab === 'ml_envios') {
      if (!mlUserId || !mlToken) return res.status(200).json({ orders: [], mlConectado: false });
      const dias = Math.min(parseInt(req.query.days) || 14, 30);
      const to = new Date();
      const from = new Date(Date.now() - dias * 86400000);
      const mlOrds = await fetchMLOrdersInRange(from.toISOString(), to.toISOString());
      // Estado real del envío: /shipments/{id} para los primeros 60 (lotes de 20).
      const shipIds = [...new Set(mlOrds.map(o => o.shipping?.id).filter(Boolean))].slice(0, 60);
      const shipInfo = {};
      for (let i = 0; i < shipIds.length; i += 20) {
        await Promise.all(shipIds.slice(i, i + 20).map(async id => {
          try {
            const r = await fetch(`https://api.mercadolibre.com/shipments/${id}`, { headers: { Authorization: `Bearer ${mlToken}` } });
            if (!r.ok) return;
            const j = await r.json();
            shipInfo[id] = { status: j.status || null, substatus: j.substatus || null, lt: j.logistic_type || null, tracking: j.tracking_number || null };
          } catch (_) {}
        }));
      }
      const orders = mlOrds.map(o => ({
        id: String(o.id),
        fecha: o.date_created || "",
        comprador: o.buyer?.nickname || o.buyer?.first_name || "—",
        items: (o.order_items || []).map(it => ({ titulo: it.item?.title || "", qty: parseInt(it.quantity) || 0 })),
        total: parseFloat(o.total_amount) || 0,
        envio: o.shipping?.id ? (shipInfo[o.shipping.id] || null) : null,
      }));
      return res.status(200).json({ orders, mlConectado: true });
    }

    // STATS: facturado + count período actual vs anterior (para Home KPIs)
    // Compatible con TN, Shopify y ML — SUMA todas las plataformas conectadas.
    if (tab === 'stats') {
      const { from, to, prevFrom } = req.query;
      if (!from) return res.status(400).json({ error: 'from required' });
      const toDate = to || new Date().toISOString();

      // Fetch ML en paralelo a la plataforma primaria
      const mlCurrentP = fetchMLOrdersInRange(from, toDate);
      const mlPrevP = prevFrom ? fetchMLOrdersInRange(prevFrom, from) : Promise.resolve([]);

      let primaryCurrent, primaryPrev;
      if (platform === 'shopify') {
        [primaryCurrent, primaryPrev] = await Promise.all([
          fetchShopifyOrders(from, toDate),
          prevFrom ? fetchShopifyOrders(prevFrom, from) : Promise.resolve([]),
        ]);
        primaryCurrent = calcStats(primaryCurrent, true);
        primaryPrev = calcStats(primaryPrev, true);
      } else {
        const mkParams = (f, t) =>
          `payment_status=paid&created_at_min=${encodeURIComponent(f)}&created_at_max=${encodeURIComponent(t)}`;
        [primaryCurrent, primaryPrev] = await Promise.all([
          fetchAllPages(storeId, accessToken, mkParams(from, toDate)),
          prevFrom ? fetchAllPages(storeId, accessToken, mkParams(prevFrom, from)) : Promise.resolve([]),
        ]);
        primaryCurrent = calcStats(primaryCurrent, false);
        primaryPrev = calcStats(primaryPrev, false);
      }
      const [mlCurOrders, mlPrevOrders] = await Promise.all([mlCurrentP, mlPrevP]);
      const mlCurrent = calcMLStats(mlCurOrders);
      const mlPrev = calcMLStats(mlPrevOrders);
      return res.status(200).json({
        current: mergeStats(primaryCurrent, mlCurrent),
        prev: mergeStats(primaryPrev, mlPrev),
        breakdown: { primary: primaryCurrent, ml: mlCurrent }, // por si la UI quiere desglosar
      });
    }

    // ─── Helper: traduce orden Shopify → formato TN-compatible para que la UI
    // (buildOrdersFromAPI) la procese sin cambios ───
    const shopifyToTNFormat = (o) => {
      const sh = o.shipping_address || o.billing_address || {};
      const fulfillments = o.fulfillments || [];
      const isFulfilled = (o.fulfillment_status || "").toLowerCase() === "fulfilled" || fulfillments.some(f => (f.status || "").toLowerCase() === "success");
      const shStatus = isFulfilled ? "shipped" : (fulfillments.length > 0 ? "ready_to_ship" : "unpacked");
      // Shopify mete calle y número juntos en address1 ("Av. Siempreviva 742");
      // Andreani (XLSX y API) los necesita separados. Número al final o al
      // principio; si no hay, queda todo como calle y número vacío.
      const addr1 = (sh.address1 || "").trim();
      let calle = addr1, numero = "";
      let m = addr1.match(/^(.*?)[\s,]+(\d+[a-zA-Z]?)$/);
      if (m) { calle = m[1].trim(); numero = m[2]; }
      else { m = addr1.match(/^(\d+[a-zA-Z]?)[\s,]+(.+)$/); if (m) { numero = m[1]; calle = m[2].trim(); } }
      // Sin número parseable → "0": la API de Andreani (action=emitir) exige
      // `numero` no vacío para envíos a domicilio o devuelve 400 (el XLSX ya
      // hace el mismo fallback). Andreani interpreta "0" como sin numeración.
      if (!numero) numero = "0";
      // Shopify no captura DNI de forma nativa; algunas tiendas lo piden en un
      // campo custom del checkout → llega en note_attributes. Lo buscamos por
      // nombres habituales (DNI/documento/cuit) para no emitir la etiqueta sin
      // documento del destinatario.
      const notas = Array.isArray(o.note_attributes) ? o.note_attributes : [];
      const docAttr = notas.find(a => /dni|documento|cuit|cuil|identific/i.test(String(a?.name || "")));
      const contactDoc = String(docAttr?.value || "").replace(/\D/g, "");
      return {
        id: o.id,
        number: o.order_number || (o.name || "").replace("#", "") || o.id,
        status: o.cancelled_at ? "cancelled" : "open",
        payment_status: o.financial_status === "paid" ? "paid" : (o.financial_status === "pending" ? "pending" : o.financial_status || ""),
        shipping_status: shStatus,
        contact_name: o.customer ? `${o.customer.first_name || ""} ${o.customer.last_name || ""}`.trim() : (sh.name || ""),
        contact_email: o.email || o.contact_email || o.customer?.email || "",
        contact_phone: o.phone || sh.phone || o.customer?.phone || "",
        contact_identification: contactDoc,
        created_at: o.created_at,
        paid_at: o.processed_at,
        shipped_at: fulfillments[0]?.created_at || null,
        total: o.total_price,
        subtotal: o.subtotal_price,
        discount: o.total_discounts || "0",
        shipping_cost_customer: o.total_shipping_price_set?.shop_money?.amount || "0",
        shipping_address: {
          name: sh.first_name || "",
          last_name: sh.last_name || "",
          address: calle,
          number: numero,
          floor: sh.address2 || "",
          locality: sh.city || "",
          city: sh.city || "",
          zipcode: sh.zip || "",
          province: sh.province || "",
        },
        admin_url: shop ? `https://${shop}/admin/orders/${o.id}` : "",
        billing_address: o.billing_address ? { name: `${o.billing_address.first_name || ""} ${o.billing_address.last_name || ""}`.trim(), email: o.email || "", phone: o.billing_address.phone || "" } : null,
        shipping_option: o.shipping_lines?.[0]?.title || "Envío",
        // Punto de retiro en Shopify: no hay objeto estándar como en TN — las
        // apps de envío ponen el punto en el título del método y suelen pisar
        // shipping_address con la dirección del punto. Se arma un pickup
        // sintético para que el matcheo de sucursal Andreani y su verificación
        // contra la tienda trabajen igual que con Tienda Nube.
        shipping_pickup_details: /sucursal|punto|hop|retiro|pickup/i.test(o.shipping_lines?.[0]?.title || "")
          ? { name: o.shipping_lines[0].title, address: { address: calle, number: numero === "0" ? "" : numero, locality: sh.city || "", city: sh.city || "", zipcode: sh.zip || "", province: sh.province || "" } }
          : null,
        shipping_tracking_number: fulfillments[0]?.tracking_number || "",
        payment_details: { method: o.payment_gateway_names?.[0] || "" },
        gateway_name: o.payment_gateway_names?.[0] || "",
        storefront: "shopify",
        fulfillments: fulfillments.map(f => ({ status: (f.status || "").toLowerCase() === "success" ? "PACKED" : "PENDING", shipping: { option: { name: f.tracking_company || "" } } })),
        products: (o.line_items || []).map(li => ({
          name: li.title || li.name || "",
          product_name: li.title || li.name || "",
          quantity: li.quantity || 1,
          price: li.price || "0",
          unit_price: li.price || "0",
          sku: li.sku || "",
        })),
        _platform: "shopify",
      };
    };

    // Helper Shopify: traer orders con paginación
    const shopifyFetchOrders = async (extraQuery) => {
      const out = [];
      let url = `${SH_BASE}/orders.json?limit=250&status=any&${extraQuery}`;
      let safety = 0;
      while (url && safety < 10) {
        safety++;
        const r = await fetch(url, { headers: SH_HEADERS });
        if (!r.ok) break;
        const d = await r.json();
        out.push(...(d.orders || []));
        const link = r.headers.get("Link") || "";
        const next = link.match(/<([^>]+)>;\s*rel="next"/);
        url = next ? next[1] : null;
      }
      return out;
    };

    // BULK LOOKUP (Shopify): una sola "página" con las últimas 250 órdenes en
    // formato TN — alcanza para matchear los SKU de los rótulos recién
    // exportados. page>1 devuelve [] para cortar la paginación del front.
    if (tab === 'bulk_lookup' && platform === 'shopify') {
      const page = parseInt(req.query.page) || 1;
      if (page > 1) return res.status(200).json([]);
      try {
        const r = await fetch(`${SH_BASE}/orders.json?limit=250&status=any`, { headers: SH_HEADERS });
        if (!r.ok) return res.status(200).json([]);
        const d = await r.json();
        return res.status(200).json((d.orders || []).map(shopifyToTNFormat));
      } catch (_) { return res.status(200).json([]); }
    }

    // TOTAL: count de todos los pedidos pagados (TN o Shopify)
    if (tab === 'total') {
      if (platform === 'shopify') {
        const orders = await shopifyFetchOrders("financial_status=paid&fields=id");
        return res.status(200).json(Array.from({length: orders.length}, (_,i) => ({id:i})));
      }
      // Conteo por header X-Total-Count: 1 request en vez de hasta 20 páginas.
      let total = null;
      try { total = await fetchTNCount(storeId, accessToken, "payment_status=paid,partially_paid,partially_refunded"); } catch (_) {}
      if (total === null) {
        total = 0;
        for (let p = 1; p <= 20; p++) {
          const page = await fetchPage(storeId, accessToken, "payment_status=paid,partially_paid,partially_refunded", p, 200);
          total += page.length;
          if (page.length < 200) break;
        }
      }
      return res.status(200).json(Array.from({length: total}, (_,i) => ({id:i})));
    }

    // POR COBRAR: pedidos sin pagar
    if (tab === 'cobrar') {
      if (platform === 'shopify') {
        const orders = await shopifyFetchOrders("financial_status=pending,partially_paid");
        const filtered = orders.filter(o => !o.cancelled_at).map(shopifyToTNFormat);
        if (_countOnly) return res.status(200).json(Array.from({length: filtered.length}, (_,i) => ({id:i})));
        return res.status(200).json(filtered);
      }
      if (_countOnly) {
        let n = null;
        try { n = await fetchTNCount(storeId, accessToken, "payment_status=pending,partially_paid&status=open"); } catch (_) {}
        if (n !== null) return res.status(200).json(Array.from({length: n}, (_,i) => ({id:i})));
      }
      const orders = await fetchAllPages(storeId, accessToken, "payment_status=pending,partially_paid&status=open");
      if (_countOnly) return res.status(200).json(Array.from({length: orders.length}, (_,i) => ({id:i})));
      return res.status(200).json(orders);
    }

    // POR EMPAQUETAR: pagados, pendientes de fulfillment
    if (tab === 'empaquetar') {
      if (platform === 'shopify') {
        const orders = await shopifyFetchOrders("financial_status=paid&fulfillment_status=unfulfilled,partial");
        const filtered = orders.filter(o => !o.cancelled_at).map(shopifyToTNFormat);
        if (_countOnly) return res.status(200).json(Array.from({length: filtered.length}, (_,i) => ({id:i})));
        return res.status(200).json(filtered);
      }
      const EMP_PARAMS = "payment_status=paid&shipping_status=unpacked&status=open";
      if (_countOnly) {
        let n = null;
        try { n = await fetchTNCount(storeId, accessToken, EMP_PARAMS); } catch (_) {}
        if (n !== null) return res.status(200).json(Array.from({length: n}, (_,i) => ({id:i})));
      }
      // quick=1: primera página chica (50) para primer paint rápido mientras baja el resto
      if (req.query.quick === '1') {
        const first = await fetchPage(storeId, accessToken, EMP_PARAMS, 1, 50).catch(() => []);
        return res.status(200).json(first);
      }
      const orders = await fetchAllPagesFast(storeId, accessToken, EMP_PARAMS);
      if (_countOnly) return res.status(200).json(Array.from({length: orders.length}, (_,i) => ({id:i})));
      return res.status(200).json(orders);
    }

    // POR ENVIAR: empaquetado, listo a enviar
    if (tab === 'enviar') {
      if (platform === 'shopify') {
        // Shopify no tiene "PACKED" — tomamos partial como ready-to-ship aproximado.
        const orders = await shopifyFetchOrders("financial_status=paid&fulfillment_status=partial");
        const filtered = orders.filter(o => !o.cancelled_at).map(shopifyToTNFormat);
        if (_countOnly) return res.status(200).json(Array.from({length: filtered.length}, (_,i) => ({id:i})));
        return res.status(200).json(filtered);
      }
      // Vía rápida: filtro nativo shipping_status=unfulfilled de TN = empaquetadas
      // sin enviar (verificado contra esta tienda: unpacked=por empaquetar,
      // unfulfilled=por enviar, fulfilled=enviadas). Trae TODAS las pendientes
      // sin límite de antigüedad en 1-2 requests. Si devuelve vacío o falla,
      // caemos al scan de fulfillments PACKED (más lento pero seguro).
      const PACKED_PARAMS = "payment_status=paid&shipping_status=unfulfilled&status=open";
      const ENV_PARAMS = "payment_status=paid&status=open";
      // Scan fallback: 5 páginas en paralelo (~1 round-trip de TN en vez de 5)
      const scanPacked = async (light) => {
        const params = light ? ENV_PARAMS + "&fields=id,fulfillments" : ENV_PARAMS;
        const pages = await Promise.all(
          [1,2,3,4,5].map(p => fetchPage(storeId, accessToken, params, p).catch(() => []))
        );
        let all = [];
        for (const pg of pages) { all = all.concat(pg); if (pg.length < 200) break; }
        return all.filter(o => o.fulfillments?.some(f => f.status === 'PACKED'));
      };
      if (_countOnly) {
        let n = null;
        try { n = await fetchTNCount(storeId, accessToken, PACKED_PARAMS); } catch (_) {}
        if (n === null || n === 0) n = (await scanPacked(true)).length; // verificar 0 con el scan liviano
        return res.status(200).json(Array.from({length: n}, (_,i) => ({id:i})));
      }
      // quick=1: primera página chica para render progresivo
      if (req.query.quick === '1') {
        let first = [];
        try { first = await fetchPage(storeId, accessToken, PACKED_PARAMS, 1, 50); } catch (_) {}
        if (!first.length) {
          const p1 = await fetchPage(storeId, accessToken, ENV_PARAMS, 1).catch(() => []);
          first = p1.filter(o => o.fulfillments?.some(f => f.status === 'PACKED'));
        }
        return res.status(200).json(first);
      }
      let porEnviar = [];
      try { porEnviar = await fetchAllPagesFast(storeId, accessToken, PACKED_PARAMS); } catch (_) {}
      if (!porEnviar.length) porEnviar = await scanPacked(false);
      return res.status(200).json(porEnviar);
    }

    // ── Link público de cupón: crear (o devolver) el token compartible y
    // sincronizar el % de comisión que ve el dueño del código. Requiere
    // sesión (ya pasó guardUid) — la lectura pública es action=cupon_publico.
    if (action === 'cupon_link') {
      const code = String(req.query.code || "").toUpperCase().trim();
      if (!code) return res.status(400).json({ error: "code requerido" });
      const dbCl = initAdmin();
      const col = dbCl.collection("cupon_links");
      const datos = {
        uid, code,
        comisionPct: Number(req.query.comisionPct) || 0,
        mpComision: Number(req.query.mpComision) || 0,
        influencer: String(req.query.influencer || "").slice(0, 80),
        updatedAt: Date.now(),
      };
      const prev = await col.where("uid", "==", uid).where("code", "==", code).limit(1).get();
      if (!prev.empty) {
        await prev.docs[0].ref.set(datos, { merge: true });
        return res.status(200).json({ ok: true, token: prev.docs[0].id });
      }
      const { randomBytes } = await import("crypto");
      const token = randomBytes(16).toString("hex");
      await col.doc(token).set({ ...datos, createdAt: Date.now() });
      return res.status(200).json({ ok: true, token });
    }

    // ── Coupons (antiguo /api/coupons) ───────────────────────────────────
    if (action === 'coupons') {
      const { desde, hasta } = req.query;
      const tzOffset = "-0300";
      const desdeISO = desde ? `${desde}T00:00:00${tzOffset}` : null;
      const hastaISO = hasta ? `${hasta}T23:59:59${tzOffset}` : null;
      // Shopify: los códigos de descuento vienen en discount_codes[] de cada
      // orden — mismo agregado que TN (usos, ventas y descuento por código).
      if (platform === 'shopify') {
        const extra = `${desdeISO ? `&created_at_min=${encodeURIComponent(desdeISO)}` : ""}${hastaISO ? `&created_at_max=${encodeURIComponent(hastaISO)}` : ""}`;
        const shOrders = await shopifyFetchOrders(`financial_status=paid&fields=id,total_price,discount_codes,created_at,cancelled_at${extra}`);
        const map = {};
        for (const o of shOrders) {
          if (o.cancelled_at) continue;
          for (const c of (o.discount_codes || [])) {
            const code = (c.code || "").toUpperCase().trim(); if (!code) continue;
            if (!map[code]) map[code] = { code, type: c.type === "percentage" ? "percentage" : "absolute", value: "0", usosPeriodo: 0, ventasPeriodo: 0, descuentoPeriodo: 0 };
            map[code].usosPeriodo++; map[code].ventasPeriodo += parseFloat(o.total_price || 0); map[code].descuentoPeriodo += parseFloat(c.amount || 0);
          }
        }
        return res.status(200).json({ coupons: Object.values(map).sort((a, b) => b.usosPeriodo - a.usosPeriodo), totalPedidosAnalizados: shOrders.length, periodo: { desde: desdeISO, hasta: hastaISO } });
      }
      if (platform !== 'tiendanube') return res.status(200).json({ coupons: [], totalPedidosAnalizados: 0, periodo: { desde: desdeISO, hasta: hastaISO } });
      const tnHeaders = { 'Authentication': `bearer ${accessToken}`, 'User-Agent': 'GrowithApp (contacto.growith@gmail.com)' };
      // Solo los campos que usa el cálculo (sin fields TN manda la orden completa
      // y un mes entero se pasaba del timeout de la función → 504 al cliente).
      const couponUrl = (p) => {
        let url = `https://api.tiendanube.com/v1/${storeId}/orders?payment_status=paid&per_page=200&page=${p}&fields=id,coupon,total,discount_coupon`;
        if (desdeISO) url += `&created_at_min=${encodeURIComponent(desdeISO)}`;
        if (hastaISO) url += `&created_at_max=${encodeURIComponent(hastaISO)}`;
        return url;
      };
      // Página con reintento ante 429/5xx (TN devuelve 404 cuando la página no existe)
      const couponPage = async (p) => {
        for (let intento = 0; intento < 3; intento++) {
          try {
            const r = await fetch(couponUrl(p), { headers: tnHeaders });
            if (r.status === 404) return [];
            if (r.status === 429 || r.status >= 500) { await new Promise(rs => setTimeout(rs, 500 * (intento + 1))); continue; }
            if (!r.ok) return [];
            const data = await r.json();
            return Array.isArray(data) ? data : [];
          } catch (_) { await new Promise(rs => setTimeout(rs, 500 * (intento + 1))); }
        }
        return [];
      };
      // Lotes de 5 páginas en paralelo (antes era secuencial: hasta 25 round-trips encadenados)
      let allOrders = [];
      for (let start = 1; start <= 25; start += 5) {
        const chunk = await Promise.all([0, 1, 2, 3, 4].map(i => couponPage(start + i)));
        let fin = false;
        for (const pg of chunk) { allOrders = allOrders.concat(pg); if (pg.length < 200) { fin = true; break; } }
        if (fin) break;
      }
      const couponMap = {};
      for (const o of allOrders) {
        const coupons = Array.isArray(o.coupon) ? o.coupon : [];
        for (const c of coupons) {
          const code = (c.code || "").toUpperCase().trim(); if (!code) continue;
          if (!couponMap[code]) couponMap[code] = { code, type: c.type||"percentage", value: c.value||"0", usosPeriodo: 0, ventasPeriodo: 0, descuentoPeriodo: 0 };
          couponMap[code].usosPeriodo++; couponMap[code].ventasPeriodo += parseFloat(o.total||0); couponMap[code].descuentoPeriodo += parseFloat(o.discount_coupon||0);
        }
      }
      // Códigos SIN uso en el período: listado oficial de cupones de TN, para
      // que un código recién creado aparezca en la tabla (con 0 usos) apenas
      // se crea, sin esperar la primera venta. Best-effort: si falla, la tabla
      // sigue mostrando los detectados en pedidos.
      let couponsListError = null, couponsListados = 0;
      try {
        // TN lista de más viejo a más nuevo: hay que llegar a la ÚLTIMA página
        // o los códigos recién creados quedan afuera. Lotes de 5 páginas en
        // paralelo, hasta 40 páginas (8000 cupones).
        const cuponPage = async (p) => {
          const r = await fetch(`https://api.tiendanube.com/v1/${storeId}/coupons?per_page=200&page=${p}`, { headers: tnHeaders });
          if (r.status === 404) return [];
          if (!r.ok) throw new Error(`TN respondió ${r.status} al listar cupones${r.status === 401 || r.status === 403 ? " (la app no tiene permiso de cupones — reconectá Tienda Nube)" : ""}`);
          const cs = await r.json();
          if (!Array.isArray(cs)) throw new Error("TN devolvió un formato inesperado al listar cupones");
          return cs;
        };
        for (let start = 1; start <= 40; start += 5) {
          const chunk = await Promise.all([0, 1, 2, 3, 4].map(i => cuponPage(start + i)));
          let fin = false;
          for (const cs of chunk) {
            couponsListados += cs.length;
            for (const c of cs) {
              const code = (c.code || "").toUpperCase().trim(); if (!code || couponMap[code]) continue;
              couponMap[code] = { code, type: c.type || "percentage", value: c.value || "0", usosPeriodo: 0, ventasPeriodo: 0, descuentoPeriodo: 0, sinUso: true };
            }
            if (cs.length < 200) { fin = true; break; }
          }
          if (fin) break;
        }
      } catch (e) { couponsListError = e.message || "error de red"; }
      return res.status(200).json({ coupons: Object.values(couponMap).sort((a,b) => b.usosPeriodo - a.usosPeriodo || String(a.code).localeCompare(String(b.code))), totalPedidosAnalizados: allOrders.length, couponsListError, couponsListados, periodo: { desde: desdeISO, hasta: hastaISO } });
    }
    // ── fin Coupons ───────────────────────────────────────────────────────

    // Búsqueda: TN filtra server-side por número de orden, nombre o email vía "q"
    // (el parámetro "number" existe pero TN lo ignora silenciosamente — verificado).
    if (q) {
      const qTrim = q.trim();
      if (platform === 'shopify') {
        const orders = await shopifyFetchOrders("financial_status=paid");
        const sq = qTrim.toLowerCase();
        const filtered = orders.filter(o => !o.cancelled_at && (
          String(o.order_number||o.name||"").toLowerCase().includes(sq) ||
          (o.customer?.first_name||"").toLowerCase().includes(sq) ||
          (o.customer?.last_name||"").toLowerCase().includes(sq) ||
          (o.email||"").toLowerCase().includes(sq)
        )).slice(0, 30).map(shopifyToTNFormat);
        return res.status(200).json(filtered);
      }
      const orders = await fetchPage(storeId, accessToken, `q=${encodeURIComponent(qTrim)}`, 1, 30);
      return res.status(200).json(orders);
    }

    // Fallback: últimos pedidos pagados
    if (platform === 'shopify') {
      const orders = await shopifyFetchOrders("financial_status=paid");
      const mapped = orders.filter(o => !o.cancelled_at).map(shopifyToTNFormat);
      return res.status(200).json(mapped);
    }
    const orders = await fetchPage(storeId, accessToken, "", 1, 200);
    res.status(200).json(orders);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
