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
  let all=[], url=`${SH_URL(shop)}/orders.json?limit=250&status=any&financial_status=paid&created_at_min=${since}&fields=id,line_items,created_at,shipping_address,payment_gateway,payment_gateway_names,financial_status,total_price,subtotal_price,total_tax,total_discounts,total_shipping_price_set,cancelled_at,refunds`;
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
async function mlOrders(sellerId, tok, days, sinceDateISO, untilDateISO) {
  // Rango exacto: si tenemos sinceDate/untilDate (que vienen del request)
  // los usamos directo. Si no, fallback a "hace N días desde 00:00 ARG hasta
  // 23:59 ARG de hoy".
  //
  // Bug previo: si days=1 y no había sinceDate, calculábamos
  // `Date.now() - 1*86400000` que da "hace exactamente 24 horas" en UTC →
  // capturaba parte del día anterior + parte del actual → ÓRDENES DUPLICADAS
  // entre dos días. Cuando el merchant pedía "Hoy" (19 ventas), el fetch
  // traía 19 + ~40 del día anterior = 59 órdenes que después dailyOrders
  // sumaba todas como "total_orders".
  let fromISO, toISO;
  if (sinceDateISO) {
    fromISO = sinceDateISO;
    toISO   = untilDateISO || new Date().toISOString();
  } else {
    // Default: rango [hoy - N días, ahora] en zona AR.
    const nowArg = new Date();
    const dToday = new Date(nowArg.toISOString().slice(0,10) + "T23:59:59-03:00");
    const dFrom  = new Date(dToday.getTime() - (days - 1) * 86400000);
    fromISO = dFrom.toISOString().slice(0,10) + "T00:00:00-03:00";
    toISO   = dToday.toISOString();
  }
  // ML pagina de a 50; iteramos con offset hasta 2000 (40 páginas).
  const all=[];
  for (let offset = 0; offset < 2000; offset += 50) {
    try {
      const r = await fetch(
        `https://api.mercadolibre.com/orders/search?seller=${sellerId}&order.status=paid&order.date_created.from=${encodeURIComponent(fromISO)}&order.date_created.to=${encodeURIComponent(toISO)}&limit=50&offset=${offset}&sort=date_desc`,
        { headers: ML_H(tok) }
      );
      if (!r.ok) break;
      const d = await r.json();
      const batch = d.results || [];
      all.push(...batch);
      if (batch.length < 50) break;
    } catch (_) { break; }
  }
  return all;
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
  const dailyOrders={}; const ordersDetail=[];
  for(const o of orders){
    const dt=o.created_at||"";
    const day=dt.slice(0,10);
    const hour=dt.slice(11,13);
    const prov=o.shipping_address?.province||"Sin provincia";
    const pay=(Array.isArray(o.payment_gateway_names)&&o.payment_gateway_names.length?o.payment_gateway_names.join(", "):o.payment_gateway)||"Otro";
    let orderUnits=0;

    if(day) dailyOrders[day]=(dailyOrders[day]||0)+1;

    // Revenue por orden = total_price (lo que pagó el cliente, incluye IVA y
    // envío, descuenta refunds parciales). Mismo criterio que /api/orders
    // ?tab=stats que se usa en Home — así el Home y el Stock muestran la
    // misma facturación. Antes acá restábamos tax y devolvía un "neto" que
    // no coincidía con ningún otro dashboard.
    const refundedAmount = (o.refunds || []).reduce((s, r) => {
      const ti = (r.transactions || []).reduce((t, x) => t + (parseFloat(x.amount) || 0), 0);
      return s + ti;
    }, 0);
    const orderRevenue = Math.max(0, (parseFloat(o.total_price) || 0) - refundedAmount);

    const detItems=[];
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
      detItems.push({ key: item.sku || vid, qty });
    }
    if(day)  { daily[day]=(daily[day]||0)+orderUnits; dailyRevenue[day]=(dailyRevenue[day]||0)+orderRevenue; }
    if(hour) byHour[hour]=(byHour[hour]||0)+orderUnits;
    byProv[prov]=(byProv[prov]||0)+orderUnits;
    byPayment[pay]=(byPayment[pay]||0)+orderUnits;
    if(orderRevenue>0) ordersDetail.push({ id:String(o.id), nombre:`#${o.order_number||o.name||o.id}`, fecha:dt, platform:"shopify", revenue:orderRevenue, items:detItems, pay });
  }
  return {map,daily,dailyRevenue,dailyOrders,byProv,byHour,byPayment,byVariant,ordersDetail};
}

// ── Procesar órdenes ML ───────────────────────────────────────────────
// Descuentos de ML por orden = coupon_fee del pago de MP. Capta cupón Y
// precio×cantidad (este último ML no lo expone en la orden). El token de ML
// sirve contra la API de MP. Devuelve { order_id → coupon_fee }.
async function mlCouponFees(token, beginISO, endISO) {
  const map = {};
  try {
    // Mismo formato EXACTO que la consulta de comisiones que funciona (con .000).
    const begin = String(beginISO).slice(0, 10) + "T00:00:00.000-03:00";
    const end   = String(endISO).slice(0, 10) + "T23:59:59.999-03:00";
    let offset = 0;
    for (let i = 0; i < 20; i++) {
      const url = `https://api.mercadopago.com/v1/payments/search?sort=date_created&criteria=desc&range=date_created&begin_date=${encodeURIComponent(begin)}&end_date=${encodeURIComponent(end)}&limit=100&offset=${offset}`;
      const r = await fetchT(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) break;
      const j = await r.json();
      const results = j.results || [];
      for (const p of results) {
        const ref = String(p.external_reference || "");
        // Pagos de ML: external_reference = id numérico de la orden ("2000...").
        if (p.status === "approved" && p.operation_type === "regular_payment" && /^\d+$/.test(ref)) {
          const cf = (p.fee_details || []).filter(f => f.type === "coupon_fee").reduce((s, f) => s + (parseFloat(f.amount) || 0), 0);
          if (cf > 0) map[ref] = (map[ref] || 0) + cf;
        }
      }
      offset += results.length;
      if (results.length < 100 || offset >= (j.paging?.total || 0)) break;
    }
  } catch (_) {}
  return map;
}

function processML(orders, couponMap = {}) {
  const map={}, daily={}, dailyRevenue={}, dailyOrders={}, byProv={}, byHour={}, byPayment={}, byVariant={}, byVariantRev={}, comisionMLDaily={};
  let comisionML=0; const ordersDetail=[];
  for(const o of orders){
    let orderFee=0; const detItems=[];
    const dt=o.date_created||"";
    const day=dt.slice(0,10);
    const hour=dt.slice(11,13);
    const prov="Buenos Aires"; // ML no siempre da provincia en search
    const pay=o.payments?.map(p=>p.payment_type).join(",")||"Mercado Pago";
    let orderUnits=0;

    // Revenue de la orden = total_amount MENOS el descuento al comprador.
    // OJO: total_amount/paid_amount NO restan el cupón (verificado: total_amount
    // 68900, coupon 3445, lo que el vendedor cobra = 65455). El descuento que el
    // vendedor absorbe está en coupon.amount (tag "order_has_discount").
    let orderRev = parseFloat(o.total_amount);
    if (!isFinite(orderRev) || orderRev <= 0) {
      orderRev = (o.order_items||[]).reduce((s, it) => s + parseFloat(it.unit_price||0) * (parseInt(it.quantity)||0), 0);
    }
    // Descuento REAL = coupon_fee del pago de MP — capta TODOS los descuentos de ML
    // (cupón Y precio×cantidad). La orden solo expone los cupones (coupon.amount);
    // el de precio×cantidad solo aparece en el pago. Fallback a coupon.amount.
    const cfMp = couponMap[String(o.id)];
    orderRev -= (cfMp != null ? cfMp : (parseFloat(o.coupon?.amount) || 0));

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
      orderFee += (parseFloat(item.sale_fee||0)) * qty; // comisión real de ML — sale_fee es POR UNIDAD (igual que unit_price), hay que × cantidad
      detItems.push({ key: "ml:"+String(item.item?.id||"ml"), qty });
    }
    if(day){
      daily[day]  =(daily[day]  ||0)+orderUnits;
      dailyRevenue[day]=(dailyRevenue[day]||0)+orderRev;
      dailyOrders[day]=(dailyOrders[day]||0)+1;
      comisionMLDaily[day]=(comisionMLDaily[day]||0)+orderFee;
    }
    comisionML += orderFee;
    if(hour) byHour[hour]=(byHour[hour]||0)+orderUnits;
    byProv[prov]=(byProv[prov]||0)+orderUnits;
    byPayment[pay]=(byPayment[pay]||0)+orderUnits;
    if(orderRev>0) ordersDetail.push({ id:String(o.id), nombre:`ML #${o.id}`, fecha:(o.date_closed||o.date_created||""), platform:"mercadolibre", revenue:orderRev, items:detItems, saleFee:orderFee, shippingId:o.shipping?.id||null });
  }
  return {map,daily,dailyRevenue,dailyOrders,byProv,byHour,byPayment,byVariant,byVariantRev,comisionML,comisionMLDaily,ordersDetail};
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
    orders_detail:  analytics.ordersDetail||[], // detalle por orden (para tabla venta-por-venta)
    by_province:    analytics.byProv,
    by_hour:        analytics.byHour,
    by_payment:     analytics.byPayment,
    by_variant:     analytics.byVariant,  // unidades por variante
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET, OPTIONS");
  if(req.method==="OPTIONS") return res.status(200).end();

  const {uid, action, days:dRaw, date_from, date_to}=req.query;
  const days=parseInt(dRaw)||30;
  // Si hay fechas personalizadas, calcular días equivalentes
  const hasCustomDate = date_from && date_to;
  const effectiveDays = hasCustomDate
    ? Math.max(1, Math.round((new Date(date_to)-new Date(date_from))/86400000)+1)
    : days;
  // Rango en zona horaria Argentina (UTC-3). Para "Hoy" (days=1) queremos
  // SOLO el día corriente — antes el endpoint hacia "Date.now() - 1*86400000"
  // que es "hace 24 horas" en UTC, y terminaba capturando parte del día
  // anterior (ej: a las 10am, traia desde ayer 10am hasta ahora →
  // duplicaba órdenes entre dos días).
  //
  // Calculamos el día ARG actual y le restamos (effectiveDays - 1) días para
  // armar el inicio del rango. Until siempre es 23:59 del día actual ARG.
  function argTodayParts() {
    const argFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" });
    const parts = argFmt.formatToParts(new Date());
    const y = parts.find(p=>p.type==="year").value;
    const m = parts.find(p=>p.type==="month").value;
    const d = parts.find(p=>p.type==="day").value;
    return `${y}-${m}-${d}`;
  }
  const argToday = argTodayParts(); // "YYYY-MM-DD" en ARG
  let sinceDate, untilDate;
  if (hasCustomDate) {
    sinceDate = `${String(date_from).slice(0,10)}T00:00:00-03:00`;
    untilDate = `${String(date_to).slice(0,10)}T23:59:59-03:00`;
  } else {
    // Restar (effectiveDays - 1) días al día ARG actual
    const [yy, mm, dd] = argToday.split("-").map(Number);
    const startUtc = new Date(Date.UTC(yy, mm - 1, dd) - (effectiveDays - 1) * 86400000);
    const startY = startUtc.getUTCFullYear();
    const startM = String(startUtc.getUTCMonth() + 1).padStart(2, "0");
    const startD = String(startUtc.getUTCDate()).padStart(2, "0");
    sinceDate = `${startY}-${startM}-${startD}T00:00:00-03:00`;
    untilDate = `${argToday}T23:59:59-03:00`;
  }

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
          // Con varios ML conectados, usamos la cuenta elegida para VENTAS de ML
          // (margenesMlVentas) — así la Tienda 2 no importa las ventas de la Tienda 1.
          const tok=await getValidMLToken(dbRef, uid, String(snap.data().margenesMlVentas || "") || null);
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
          // Pasar el MISMO rango exacto que usamos para Shopify/TN, así
          // las series diarias y los totales matchean perfecto entre canales.
          const [mlOrd, coupons] = await Promise.all([
            mlOrders(mlSellerId, mlToken, effectiveDays, sinceDate, untilDate),
            mlCouponFees(mlToken, sinceDate, untilDate),
          ]);
          return processML(mlOrd, coupons);
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
          ml_products:   Object.entries(mlAnalytics.map||{}).map(([id,v])=>({id, nombre:v.nombre||id, units:v.units})), // publicaciones ML (no variantes)
          ml_commission: mlAnalytics.comisionML || 0,           // comisión REAL de ML (sale_fee, incluye MP)
          ml_commission_daily: mlAnalytics.comisionMLDaily || {},
          ml_orders_detail: mlAnalytics.ordersDetail || [],     // detalle por orden ML
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
          ml_products:   Object.entries(mlAnalytics.map||{}).map(([id,v])=>({id, nombre:v.nombre||id, units:v.units})), // publicaciones ML (no variantes)
          ml_commission: mlAnalytics.comisionML || 0,           // comisión REAL de ML (sale_fee, incluye MP)
          ml_commission_daily: mlAnalytics.comisionMLDaily || {},
          ml_orders_detail: mlAnalytics.ordersDetail || [],     // detalle por orden ML
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
