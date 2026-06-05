// api/stock.js — Growith Stock Analytics
// Soporta Tienda Nube, Shopify y Mercado Libre
// Devuelve productos, variantes, stock, ventas, provincia, hora, método de pago

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getValidMLToken } from "./integrations.js";

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g,"\n").replace(/"/g,""),
  })});
  return getFirestore();
}

// Sin fallback — se requiere uid válido con tienda conectada

const TN_H  = t => ({ "Authentication":`bearer ${t}`, "User-Agent":"GrowithApp (soluna.biolight@gmail.com)" });
const SH_H  = t => ({ "X-Shopify-Access-Token":t, "Content-Type":"application/json" });
const ML_H  = t => ({ "Authorization":`Bearer ${t}` });
const SH_URL = s => `https://${s}/admin/api/2024-10`;

// ── Fetch con timeout (Bug #3) ────────────────────────────────────────
async function fetchT(url, opts={}, ms=15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── TN Fetch ──────────────────────────────────────────────────────────
async function tnProducts(sid, tok) {
  let all=[], page=1;
  while(true){
    const r=await fetchT(`https://api.tiendanube.com/v1/${sid}/products?per_page=200&page=${page}`,{headers:TN_H(tok)});
    if(!r.ok) break;
    const d=await r.json();
    if(!Array.isArray(d)||d.length===0) break;
    all=all.concat(d);
    if(d.length<200) break;
    page++;
  }
  return all;
}

// Bug #2 fix: sequential pagination instead of always firing 5 parallel requests
async function tnOrders(sid, tok, days, since, until) {
  let all=[], page=1;
  while(page<=10){
    let url=`https://api.tiendanube.com/v1/${sid}/orders?per_page=200&page=${page}&payment_status=paid,partially_paid,partially_refunded&created_at_min=${since}`;
    if(until) url+=`&created_at_max=${until}`;
    const r=await fetchT(url,{headers:TN_H(tok)});
    if(!r.ok) break;
    const d=await r.json();
    if(!Array.isArray(d)||d.length===0) break;
    all=all.concat(d);
    if(d.length<200) break;
    page++;
  }
  return all;
}

// ── Shopify Fetch ─────────────────────────────────────────────────────
async function shProducts(shop, tok) {
  let all=[], sinceId=null;
  while(true){
    let url=`${SH_URL(shop)}/products.json?limit=250&fields=id,title,variants,image`;
    if(sinceId) url+=`&since_id=${sinceId}`;
    const r=await fetchT(url,{headers:SH_H(tok)});
    if(!r.ok) break;
    const {products:batch}=await r.json();
    if(!batch||batch.length===0) break;
    all=all.concat(batch);
    if(batch.length<250) break;
    sinceId=batch[batch.length-1].id;
  }
  return all;
}

// Bug #1 fix: was fetching same page twice — now uses cursor-based pagination via Link header
// Política: solo financial_status=paid (pago aprobado). Las ventas con pago parcial,
// pendiente o reembolso parcial NO descuentan stock ni se cuentan en estadísticas.
async function shOrders(shop, tok, days, since, until) {
  // Format exact que usa Facturador: 2026-05-22T00:00:00-03:00 (sin URL-encode).
  // status=any incluye canceladas — filtramos por cancelled_at en JS.
  let all=[], url=`${SH_URL(shop)}/orders.json?limit=250&status=any&financial_status=paid&created_at_min=${since}&fields=id,line_items,created_at,shipping_address,payment_gateway,financial_status,total_price,subtotal_price,total_tax,total_discounts,total_shipping_price_set,cancelled_at,refunds`;
  if(until) url+=`&created_at_max=${until}`;
  while(url){
    const r=await fetchT(url,{headers:SH_H(tok)});
    if(!r.ok) break;
    const d=await r.json();
    const batch=d.orders||[];
    // Excluir canceladas y refundeadas totales
    const valid = batch.filter(o => !o.cancelled_at);
    all=all.concat(valid);
    if(batch.length<250) break;
    // Shopify cursor-based pagination via Link header
    const link=r.headers.get("Link")||"";
    const next=link.match(/<([^>]+)>;\s*rel="next"/);
    url=next?next[1]:null;
  }
  return all;
}

// ── ML Fetch ──────────────────────────────────────────────────────────
async function mlOrders(sellerId, tok, days) {
  const since=new Date(Date.now()-days*86400000).toISOString().slice(0,10)+"T00:00:00.000-03:00";
  const r=await fetch(`https://api.mercadolibre.com/orders/search?seller=${sellerId}&order.status=paid&order.date_created.from=${since}&limit=50`,{headers:ML_H(tok)});
  if(!r.ok) return [];
  const d=await r.json();
  return d.results||[];
}

// ── Procesar órdenes TN ───────────────────────────────────────────────
function processTN(orders) {
  const map={}, daily={}, dailyRevenue={}, byProv={}, byHour={}, byPayment={}, byVariant={};
  const dailyOrders={}; // "YYYY-MM-DD" → cantidad de órdenes
  for(const o of orders){
    const dt=o.created_at||"";
    const day=dt.slice(0,10);
    const hour=dt.slice(11,13);
    const prov=o.shipping_address?.province||o.billing_address?.province||"Sin provincia";
    const pay=o.gateway||"Otro";
    let orderUnits=0, orderRevenue=0;

    // Contar la orden
    if(day) dailyOrders[day]=(dailyOrders[day]||0)+1;

    let orderSubtotal=0;
    for(const item of o.products||[]){
      orderSubtotal += parseFloat(item.price||0) * (parseInt(item.quantity)||0);
    }
    const orderDiscount = parseFloat(o.discount||0);
    const discountRatio = orderSubtotal>0 ? Math.max(0, orderSubtotal-orderDiscount)/orderSubtotal : 1;

    for(const item of o.products||[]){
      const vid=String(item.variant_id||item.product_id);
      const qty=parseInt(item.quantity)||0;
      const rev=parseFloat(item.price||0)*qty*discountRatio;
      if(!map[vid]) map[vid]={units:0,revenue:0};
      map[vid].units+=qty;
      map[vid].revenue+=rev;
      orderUnits+=qty;
      orderRevenue+=rev;
      const vname=item.variant_values?.join(" / ")||item.name||"Default";
      byVariant[vname]=(byVariant[vname]||0)+qty;
    }
    if(day)  { daily[day]=(daily[day]||0)+orderUnits; dailyRevenue[day]=(dailyRevenue[day]||0)+orderRevenue; }
    if(hour) byHour[hour]=(byHour[hour]||0)+orderUnits;
    byProv[prov]=(byProv[prov]||0)+orderUnits;
    byPayment[pay]=(byPayment[pay]||0)+orderUnits;
  }
  return {map,daily,dailyRevenue,dailyOrders,byProv,byHour,byPayment,byVariant};
}

// ── Procesar órdenes Shopify ──────────────────────────────────────────
function processSH(orders) {
  const map={}, daily={}, dailyRevenue={}, byProv={}, byHour={}, byPayment={}, byVariant={};
  const dailyOrders={};
  for(const o of orders){
    const dt=o.created_at||"";
    const day=dt.slice(0,10);
    const hour=dt.slice(11,13);
    const prov=o.shipping_address?.province||"Sin provincia";
    const pay=o.payment_gateway||"Otro";
    let orderUnits=0;

    if(day) dailyOrders[day]=(dailyOrders[day]||0)+1;

    // Revenue NETO por orden (matchea con Escalafy y dashboards de AR típicos):
    // subtotal_price - total_tax - refunds.
    // En Argentina, las tiendas suelen tener "precios con IVA incluido": subtotal_price
    // viene con IVA dentro. total_tax es la porción de IVA. Restando obtenemos el neto real.
    // Si la tienda factura sin IVA (precios netos), total_tax = 0 y queda igual.
    const refundedAmount = (o.refunds || []).reduce((s, r) => {
      const ti = (r.transactions || []).reduce((t, x) => t + (parseFloat(x.amount) || 0), 0);
      return s + ti;
    }, 0);
    const subtotal = parseFloat(o.subtotal_price) || 0;
    const tax = parseFloat(o.total_tax) || 0;
    const orderRevenue = Math.max(0, subtotal - tax - refundedAmount);

    for(const item of o.line_items||[]){
      const vid=String(item.variant_id||item.product_id);
      const qty=parseInt(item.quantity)||0;
      const rev=parseFloat(item.price)*qty;
      if(!map[vid]) map[vid]={units:0,revenue:0};
      map[vid].units+=qty;
      map[vid].revenue+=rev; // mantenemos per-variant a precio de lista
      orderUnits+=qty;
      const vname=item.variant_title||item.title||"Default";
      byVariant[vname]=(byVariant[vname]||0)+qty;
    }
    if(day)  { daily[day]=(daily[day]||0)+orderUnits; dailyRevenue[day]=(dailyRevenue[day]||0)+orderRevenue; }
    if(hour) byHour[hour]=(byHour[hour]||0)+orderUnits;
    byProv[prov]=(byProv[prov]||0)+orderUnits;
    byPayment[pay]=(byPayment[pay]||0)+orderUnits;
  }
  return {map,daily,dailyRevenue,dailyOrders,byProv,byHour,byPayment,byVariant};
}

// ── Procesar órdenes ML ───────────────────────────────────────────────
function processML(orders) {
  const map={}, daily={}, dailyRevenue={}, dailyOrders={}, byProv={}, byHour={}, byPayment={}, byVariant={}, byVariantRev={};
  for(const o of orders){
    const dt=o.date_created||"";
    const day=dt.slice(0,10);
    const hour=dt.slice(11,13);
    const prov="Buenos Aires"; // ML no siempre da provincia en search
    const pay=o.payments?.map(p=>p.payment_type).join(",")||"Mercado Pago";
    let orderUnits=0;

    // Revenue de la orden = total_amount (el monto que el vendedor cobra,
    // después de descuentos pero antes de comisiones MP). Equivale al
    // "subtotal_price - tax" de Shopify procesado en processSH. Si no viene
    // total_amount (raro), fallback al sum de unit_price.
    let orderRev = parseFloat(o.total_amount);
    if (!isFinite(orderRev) || orderRev <= 0) {
      orderRev = (o.order_items||[]).reduce((s, it) => s + parseFloat(it.unit_price||0) * (parseInt(it.quantity)||0), 0);
    }

    for(const item of o.order_items||[]){
      const vid=String(item.item?.id||"ml");
      const qty=parseInt(item.quantity)||0;
      const rev=parseFloat(item.unit_price)*qty; // per-variant a precio de lista
      if(!map[vid]) map[vid]={units:0,revenue:0,nombre:item.item?.title};
      map[vid].units+=qty;
      map[vid].revenue+=rev;
      orderUnits+=qty;
      const vname=item.item?.variation_attributes?.[0]?.value_name||item.item?.title||"Default";
      byVariant[vname]=(byVariant[vname]||0)+qty;
      byVariantRev[vname]=(byVariantRev[vname]||0)+rev;
    }
    if(day){
      daily[day]  =(daily[day]  ||0)+orderUnits;
      dailyRevenue[day]=(dailyRevenue[day]||0)+orderRev;
      dailyOrders[day]=(dailyOrders[day]||0)+1;
    }
    if(hour) byHour[hour]=(byHour[hour]||0)+orderUnits;
    byProv[prov]=(byProv[prov]||0)+orderUnits;
    byPayment[pay]=(byPayment[pay]||0)+orderUnits;
  }
  return {map,daily,dailyRevenue,dailyOrders,byProv,byHour,byPayment,byVariant,byVariantRev};
}

function daysLeft(stock, units, days) {
  if(!units||units===0) return null;
  return Math.round(stock/(units/days));
}

function normTN(p, salesMap, days) {
  const variants=(p.variants||[]).map(v=>{
    const vid=String(v.id);
    const s=salesMap[vid]||{units:0,revenue:0};
    const stock=parseInt(v.stock)||0;
    return {id:vid,sku:v.sku||"",nombre:Object.values(v.values?.[0]||{}).join(" / ")||"Default",stock,units_sold:s.units,revenue:s.revenue,days_left:daysLeft(stock,s.units,days),price:parseFloat(v.price)||0};
  });
  const tS=variants.reduce((a,v)=>a+v.stock,0);
  const tU=variants.reduce((a,v)=>a+v.units_sold,0);
  const tR=variants.reduce((a,v)=>a+v.revenue,0);
  const mD=variants.map(v=>v.days_left).filter(d=>d!==null).reduce((a,b)=>Math.min(a,b),Infinity);
  return {id:String(p.id),nombre:p.name?.es||Object.values(p.name||{})[0]||"Sin nombre",imagen:p.images?.[0]?.src||null,variants,stock_total:tS,units_sold:tU,revenue:tR,days_left:mD===Infinity?null:mD,platform:"tiendanube"};
}

function normSH(p, salesMap, days) {
  const variants=(p.variants||[]).map(v=>{
    const vid=String(v.id);
    const s=salesMap[vid]||{units:0,revenue:0};
    const stock=v.inventory_quantity??0;
    return {id:vid,sku:v.sku||"",nombre:[v.option1,v.option2,v.option3].filter(Boolean).join(" / ")||"Default",stock,units_sold:s.units,revenue:s.revenue,days_left:daysLeft(stock,s.units,days),price:parseFloat(v.price)||0};
  });
  const tS=variants.reduce((a,v)=>a+v.stock,0);
  const tU=variants.reduce((a,v)=>a+v.units_sold,0);
  const tR=variants.reduce((a,v)=>a+v.revenue,0);
  const mD=variants.map(v=>v.days_left).filter(d=>d!==null).reduce((a,b)=>Math.min(a,b),Infinity);
  return {id:String(p.id),nombre:p.title||"Sin nombre",imagen:p.image?.src||null,variants,stock_total:tS,units_sold:tU,revenue:tR,days_left:mD===Infinity?null:mD,platform:"shopify"};
}

function buildResponse(platform, products, analytics, days) {
  const totalOrders=Object.values(analytics.dailyOrders||{}).reduce((a,b)=>a+b,0);
  // total_revenue ahora viene de la suma de dailyRevenue (subtotal por orden, sin tax/shipping/refunds)
  // — antes era suma de line_items.price × qty que daba inflado por IVA incluido.
  const totalRevenueFromOrders = Object.values(analytics.dailyRevenue||{}).reduce((a,b)=>a+b,0);
  return {
    platform, products, days,
    total_products: products.length,
    total_variants: products.reduce((a,p)=>a+p.variants.length,0),
    total_stock:    products.reduce((a,p)=>a+p.stock_total,0),
    total_units:    products.reduce((a,p)=>a+p.units_sold,0),
    total_revenue:  totalRevenueFromOrders > 0 ? totalRevenueFromOrders : products.reduce((a,p)=>a+p.revenue,0),
    total_orders:   totalOrders,
    daily_series:   analytics.daily,      // unidades por día
    daily_revenue:  analytics.dailyRevenue||{}, // revenue por día
    daily_orders:   analytics.dailyOrders||{}, // órdenes por día
    by_province:    analytics.byProv,
    by_hour:        analytics.byHour,
    by_payment:     analytics.byPayment,
    by_variant:     analytics.byVariant,  // unidades por variante
  };
}

// ─── Helpers consolidados desde rendimiento.js (Vercel Hobby 12 functions) ───
async function rendFetchMetaDailySpend(cfg, since, until) {
  if (!cfg?.access_token || !cfg.ad_account_id) return {};
  try {
    const url = new URL(`https://graph.facebook.com/v21.0/${cfg.ad_account_id}/insights`);
    url.searchParams.set("access_token", cfg.access_token);
    url.searchParams.set("level", "account");
    url.searchParams.set("fields", "spend,impressions,clicks");
    url.searchParams.set("time_range[since]", since);
    url.searchParams.set("time_range[until]", until);
    url.searchParams.set("time_increment", "1");
    url.searchParams.set("limit", "90");
    const r = await fetch(url.toString());
    const j = await r.json();
    if (j.error) return {};
    const byDate = {};
    for (const row of (j.data || [])) {
      const date = row.date_start; if (!date) continue;
      byDate[date] = { spend: parseFloat(row.spend)||0, impressions: parseInt(row.impressions)||0, clicks: parseInt(row.clicks)||0 };
    }
    return byDate;
  } catch (_) { return {}; }
}
function rendBuildRows(since, until, dailyRevenue, dailyOrders, metaDailySpend, commission) {
  const allDates = new Set([...Object.keys(dailyRevenue), ...Object.keys(dailyOrders), ...Object.keys(metaDailySpend)]);
  const start = new Date(since + "T12:00:00"); const end = new Date(until + "T12:00:00");
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) allDates.add(d.toISOString().slice(0,10));
  return [...allDates].sort().map(date => {
    const revenue = dailyRevenue[date] || 0;
    const orders = dailyOrders[date] || 0;
    const adSpend = metaDailySpend[date]?.spend || 0;
    const netRevenue = revenue * (1 - commission);
    const profit = netRevenue - adSpend;
    return {
      Fecha: date, "Ordenes > $0": orders, Revenue: revenue, "Ad Spend": adSpend,
      "Net Revenue": parseFloat(netRevenue.toFixed(2)), Profit: parseFloat(profit.toFixed(2)),
      "Profit Margin": revenue > 0 ? parseFloat((profit/revenue).toFixed(6)) : 0,
      ROAS: adSpend > 0 ? parseFloat((revenue/adSpend).toFixed(4)) : 0,
      "True ROAS": adSpend > 0 ? parseFloat((netRevenue/adSpend).toFixed(4)) : 0,
      CPA: orders > 0 ? parseFloat((adSpend/orders).toFixed(2)) : 0,
    };
  });
}
function rendComputeTotals(rows) {
  const t = rows.reduce((acc, r) => ({
    orders: acc.orders + (r["Ordenes > $0"] || 0), revenue: acc.revenue + (r.Revenue || 0),
    adSpend: acc.adSpend + (r["Ad Spend"] || 0), netRevenue: acc.netRevenue + (r["Net Revenue"] || 0),
    profit: acc.profit + (r.Profit || 0),
  }), {orders:0,revenue:0,adSpend:0,netRevenue:0,profit:0});
  return {
    ...t,
    roas: t.adSpend > 0 ? t.revenue / t.adSpend : 0,
    trueRoas: t.adSpend > 0 ? t.netRevenue / t.adSpend : 0,
    cpa: t.orders > 0 ? t.adSpend / t.orders : 0,
    profitMargin: t.revenue > 0 ? t.profit / t.revenue : 0,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET, POST, OPTIONS");
  if(req.method==="OPTIONS") return res.status(200).end();

  // action=daily_metrics (consolidado desde rendimiento.js)
  if (req.query.action === "daily_metrics") {
    try {
      const { uid: u2, days: daysQ, date_from: df2, date_to: dt2 } = req.query;
      if (!u2) return res.status(400).json({ error: "Falta uid" });
      const daysN = parseInt(daysQ) || 30;
      const nowDate = new Date();
      const until = dt2 || nowDate.toISOString().slice(0,10);
      const since = df2 || new Date(nowDate - daysN * 86400000).toISOString().slice(0,10);
      const periodMs = new Date(until+"T23:59:59") - new Date(since+"T00:00:00");
      const prevUntilD = new Date(new Date(since+"T00:00:00") - 86400000);
      const prevSinceD = new Date(prevUntilD - periodMs);
      const prevSince = prevSinceD.toISOString().slice(0,10);
      const prevUntil = prevUntilD.toISOString().slice(0,10);

      const dbR = initAdmin();
      const userSnap = await dbR.collection("users").doc(u2).get();
      const userData = userSnap.data() || {};
      const stores2 = userData.stores || [];
      const hasML2 = stores2.some(s => s.type === "meli");
      const commission = parseFloat(userData.rendimientoCommission) || (hasML2 ? 0.10 : 0.03);

      async function fetchStockRange(from, to) {
        try {
          const u = new URL(`https://${req.headers.host}/api/stock`);
          u.searchParams.set("uid", u2); u.searchParams.set("action", "products");
          u.searchParams.set("date_from", from); u.searchParams.set("date_to", to);
          const r = await fetch(u.toString(), { headers: { host: req.headers.host } });
          if (!r.ok) return { dailyRevenue:{}, dailyOrders:{} };
          const j = await r.json();
          return { dailyRevenue: j.daily_revenue || {}, dailyOrders: j.daily_orders || {} };
        } catch(_) { return { dailyRevenue:{}, dailyOrders:{} }; }
      }

      const metaAccountsSnap = await dbR.collection("users").doc(u2).collection("meta_accounts").get();
      const metaAccounts = metaAccountsSnap.docs.map(d => d.data()).filter(a => a.access_token && a.ad_account_id);
      const metaCfg = metaAccounts[0] || null;

      const [curr, prev, metaCurr, metaPrev] = await Promise.all([
        fetchStockRange(since, until),
        fetchStockRange(prevSince, prevUntil),
        metaCfg ? rendFetchMetaDailySpend(metaCfg, since, until) : Promise.resolve({}),
        metaCfg ? rendFetchMetaDailySpend(metaCfg, prevSince, prevUntil) : Promise.resolve({}),
      ]);

      const rows = rendBuildRows(since, until, curr.dailyRevenue, curr.dailyOrders, metaCurr, commission);
      const prevRows = rendBuildRows(prevSince, prevUntil, prev.dailyRevenue, prev.dailyOrders, metaPrev, commission);
      const totals = rendComputeTotals(rows);
      const prevTotals = rendComputeTotals(prevRows);

      return res.json({
        rows, prevRows, totals, prevTotals, since, until, prevSince, prevUntil,
        meta: { hasMetaData: Object.keys(metaCurr).length > 0, hasStoreData: Object.keys(curr.dailyRevenue).length > 0, commission, metaAccountsCount: metaAccounts.length },
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.query.action === "save_config" && req.method === "POST") {
    try {
      const { uid: u3 } = req.query;
      if (!u3) return res.status(400).json({ error: "Falta uid" });
      const body = await new Promise(resolve => {
        let d = ""; req.on("data", c => d += c); req.on("end", () => resolve(JSON.parse(d || "{}")));
      });
      const dbS = initAdmin();
      await dbS.collection("users").doc(u3).update({ rendimientoCommission: parseFloat(body.commission) || 0.03 });
      return res.json({ ok: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  const {uid, action, days:dRaw, date_from, date_to}=req.query;
  const days=parseInt(dRaw)||30;
  // Si hay fechas personalizadas, calcular días equivalentes
  const hasCustomDate = date_from && date_to;
  const effectiveDays = hasCustomDate
    ? Math.max(1, Math.round((new Date(date_to)-new Date(date_from))/86400000)+1)
    : days;
  // Formato EXACTO que usa Facturador y sí funciona con Shopify/TN:
  // "2026-05-22T00:00:00-03:00" (offset AR, no UTC Z).
  const sinceDate = hasCustomDate
    ? `${String(date_from).slice(0,10)}T00:00:00-03:00`
    : new Date(Date.now() - effectiveDays * 86400000).toISOString();
  const untilDate = hasCustomDate
    ? `${String(date_to).slice(0,10)}T23:59:59-03:00`
    : null;

  if(!uid) return res.status(401).json({ error: "uid requerido" });

  let platform="tiendanube", storeId, accessToken, shop, mlSellerId, mlToken;
  let dbRef;
  try{
    dbRef=initAdmin();
    const snap=await dbRef.collection("users").doc(uid).get();
    if(snap.exists){
      const stores=snap.data().stores||[];
      const tn=stores.find(s=>s.type==="tiendanube");
      const sh=stores.find(s=>s.type==="shopify");
      const ml=stores.find(s=>s.type==="mercadolibre"||s.type==="meli");
      if(sh?.accessToken&&sh?.shop){ platform="shopify"; shop=sh.shop; accessToken=sh.accessToken; }
      else if(tn?.accessToken&&tn?.storeId){ platform="tiendanube"; storeId=tn.storeId; accessToken=tn.accessToken; }
      // ML: el OAuth guarda userId (no sellerId). Usar getValidMLToken para refrescar
      // tokens vencidos automáticamente (TTL 6h).
      if(ml){
        try{
          const tok=await getValidMLToken(dbRef, uid);
          if(tok?.accessToken && tok?.userId){ mlSellerId=tok.userId; mlToken=tok.accessToken; }
        }catch(_){ /* ML token roto, no abortamos — seguimos sin ML */ }
      }
    }
  }catch(e){
    console.error("[stock]",e.message);
    return res.status(500).json({ error: "Error al obtener credenciales" });
  }
  if(!accessToken) return res.status(403).json({ error: "Tienda no conectada" });

  try{
    if(action==="products"){
      // Helper: fetch ML data en paralelo (si está conectado).
      // Funciona con cualquier plataforma primaria (Shopify O TN).
      const fetchML = async () => {
        if (!mlSellerId || !mlToken) return null;
        try {
          const mlOrd = await mlOrders(mlSellerId, mlToken, days);
          return processML(mlOrd);
        } catch (e) { return null; }
      };
      if(platform==="shopify"){
        const [products, orders, mlAnalytics] = await Promise.all([
          shProducts(shop, accessToken),
          shOrders(shop, accessToken, effectiveDays, sinceDate, untilDate),
          fetchML(),
        ]);
        const analytics = processSH(orders);
        const normalized = products.map(p => normSH(p, analytics.map, days));
        const resp = buildResponse("shopify", normalized, analytics, effectiveDays);
        if (mlAnalytics) resp.ml_data = {
          daily:         mlAnalytics.daily,         // unidades por día
          daily_revenue: mlAnalytics.dailyRevenue,  // facturación por día (NETO de la orden)
          daily_orders:  mlAnalytics.dailyOrders,   // órdenes por día
          by_variant:    mlAnalytics.byVariant,     // unidades por variante
          by_variant_rev: mlAnalytics.byVariantRev, // revenue por variante (bruto)
          by_province:   mlAnalytics.byProv,
          by_hour:       mlAnalytics.byHour,
          by_payment:    mlAnalytics.byPayment,
          total_units:   Object.values(mlAnalytics.map).reduce((a,v)=>a+v.units, 0),
          // total_revenue NETO — suma de dailyRevenue (que usa o.total_amount).
          // Coincide con lo que ML paga al vendedor antes de su comisión.
          total_revenue: Object.values(mlAnalytics.dailyRevenue||{}).reduce((a,b)=>a+b,0),
          total_orders:  Object.keys(mlAnalytics.dailyOrders||{}).reduce((a,k)=>a+mlAnalytics.dailyOrders[k], 0),
        };
        return res.status(200).json(resp);
      } else {
        const [products, orders, mlAnalytics] = await Promise.all([
          tnProducts(storeId, accessToken),
          tnOrders(storeId, accessToken, effectiveDays, sinceDate, untilDate),
          fetchML(),
        ]);
        const analytics = processTN(orders);
        const normalized = products.map(p => normTN(p, analytics.map, effectiveDays));
        const resp = buildResponse("tiendanube", normalized, analytics, effectiveDays);
        if (mlAnalytics) resp.ml_data = {
          daily:         mlAnalytics.daily,         // unidades por día
          daily_revenue: mlAnalytics.dailyRevenue,  // facturación por día (NETO de la orden)
          daily_orders:  mlAnalytics.dailyOrders,   // órdenes por día
          by_variant:    mlAnalytics.byVariant,     // unidades por variante
          by_variant_rev: mlAnalytics.byVariantRev, // revenue por variante (bruto)
          by_province:   mlAnalytics.byProv,
          by_hour:       mlAnalytics.byHour,
          by_payment:    mlAnalytics.byPayment,
          total_units:   Object.values(mlAnalytics.map).reduce((a,v)=>a+v.units, 0),
          // total_revenue NETO — suma de dailyRevenue (que usa o.total_amount).
          // Coincide con lo que ML paga al vendedor antes de su comisión.
          total_revenue: Object.values(mlAnalytics.dailyRevenue||{}).reduce((a,b)=>a+b,0),
          total_orders:  Object.keys(mlAnalytics.dailyOrders||{}).reduce((a,k)=>a+mlAnalytics.dailyOrders[k], 0),
        };
        return res.status(200).json(resp);
      }
    }
    return res.status(400).json({error:"Acción no reconocida"});
  }catch(e){
    console.error("[stock] error:",e.message);
    return res.status(500).json({error:e.message});
  }
}
