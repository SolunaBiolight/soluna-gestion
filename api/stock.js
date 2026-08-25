// api/stock.js — Growith Stock Analytics
// Soporta Tienda Nube, Shopify y Mercado Libre
// Devuelve productos, variantes, stock, ventas, provincia, hora, método de pago

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getValidMLToken } from "./integrations.js";
import { guardUid, guardCron, isCronRequest } from "./_auth.js";

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

const TN_H  = t => ({ "Authentication":`bearer ${t}`, "User-Agent":"GrowithApp (contacto.growith@gmail.com)" });
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

// ── Fetch con reintentos — evita facturación parcial silenciosa ────────
// Las paginaciones de abajo (tnOrders/shOrders/mlOrders) antes hacían
// `catch(_){break}`: un timeout o un 429 en la página 3 de 5 se trataba
// IGUAL que "no hay más páginas", y el dashboard mostraba una facturación
// incompleta con pinta de real (mismo rango daba $12M/$39M/$64M en
// llamadas consecutivas). fetchTR reintenta las fallas transitorias
// (red, timeout, 429, 5xx) con backoff, y solo después de agotarlas
// LANZA — así el caller puede fallar explícito en vez de mentir con un
// total parcial.
// ms/tries deliberadamente chicos: cada página puede reintentar, pero el
// PRESUPUESTO TOTAL tiene que quedar muy por debajo del maxDuration de la
// función serverless. Con 3 intentos de 15s (el valor original) el peor
// caso por endpoint pasó a ~47s y la función entera moría en seco sin
// devolver ni el JSON de error — peor que el comportamiento anterior.
async function fetchTR(url, opts={}, { ms=10000, tries=2 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetchT(url, opts, ms);
      if (r.status === 429 || r.status >= 500) { lastErr = new Error(`HTTP ${r.status}`); }
      else return r; // 2xx, 4xx (salvo 429) — respuesta válida, la maneja el caller
    } catch (e) { lastErr = e; }
    if (i < tries - 1) await new Promise(res => setTimeout(res, 400));
  }
  throw new Error(`Fetch falló tras ${tries} intentos (${url.split("?")[0]}): ${lastErr?.message || "?"}`);
}

// ── TN Fetch ──────────────────────────────────────────────────────────
// TN tarda ~14s en generar una página de 200 registros pero solo ~4s una de
// 50 — con per_page=200 cualquier timeout razonable (8s) falla SIEMPRE,
// tienda esté lenta o no (así se diagnosticó mal como "TN caída" un rato).
// OJO: pedir esas páginas de 50 EN PARALELO (como hace orders.js con un
// techo bajo de páginas) reintroduce el problema que ya se había arreglado
// una vez en este archivo — TN rate-limita a ~2 req/s, y disparar 20-40
// requests de golpe da 429 sí o sí. Por eso acá van SECUENCIALES: más
// lento que en paralelo, pero cada página de 50 sigue siendo ~4s (vs 14s
// de antes) y no dispara el rate limit.
async function tnProducts(sid, tok) {
  const PP = 50;
  let all=[], page=1;
  while(true){
    const r=await fetchTR(`https://api.tiendanube.com/v1/${sid}/products?per_page=${PP}&page=${page}`,{headers:TN_H(tok)});
    if(r.status===404) break; // fin real de la paginación
    if(!r.ok) throw new Error(`TN products HTTP ${r.status} (página ${page})`);
    const d=await r.json();
    if(!Array.isArray(d)||d.length===0) break;
    all=all.concat(d);
    if(d.length<PP) break;
    page++;
  }
  return all;
}

async function tnOrders(sid, tok, days, since, until) {
  // 100/página en vez de 50: menos vueltas totales sin acercarse al costo
  // de 200 (~14s). Lotes de 3 en paralelo (no 1 a la vez, no 40 de golpe):
  // TN tolera ~2 req/s, y cada request tarda ~7s — 3 concurrentes cada
  // ~7.4s promedia bien por debajo de ese límite sin pagar el costo de
  // la secuencial pura.
  const PP = 100, BATCH = 3, STAGGER = 400, MAXPAGE = 20; // 20×100 = 2000 órdenes
  let all=[], page=1, done=false;
  while(page<=MAXPAGE && !done){
    const batchPages = Array.from({length: BATCH}, (_,i)=>page+i).filter(p=>p<=MAXPAGE);
    const results = await Promise.all(batchPages.map(async p => {
      let url=`https://api.tiendanube.com/v1/${sid}/orders?per_page=${PP}&page=${p}&payment_status=paid,partially_paid,partially_refunded&created_at_min=${since}`;
      if(until) url+=`&created_at_max=${until}`;
      const r=await fetchTR(url,{headers:TN_H(tok)});
      if(r.status===404) return null; // fin real de la paginación
      if(!r.ok) throw new Error(`TN orders HTTP ${r.status} (página ${p})`);
      const d=await r.json();
      return Array.isArray(d) ? d : [];
    }));
    for (const d of results) {
      if (d===null || d.length===0) { done=true; break; }
      all=all.concat(d);
      if (d.length<PP) { done=true; break; }
    }
    page += BATCH;
    if (!done) await new Promise(res=>setTimeout(res, STAGGER));
  }
  // Techo de páginas alcanzado sin llegar al fin real: el resultado está
  // TRUNCADO (períodos largos / alta escala). Se marca para que el dashboard
  // lo diga en vez de mostrar un total parcial con pinta de completo.
  if (!done) all.truncated = true;
  return all;
}

// ── Shopify Fetch ─────────────────────────────────────────────────────
async function shProducts(shop, tok) {
  let all=[], sinceId=null;
  while(true){
    let url=`${SH_URL(shop)}/products.json?limit=250&fields=id,title,variants,image`;
    if(sinceId) url+=`&since_id=${sinceId}`;
    const r=await fetchTR(url,{headers:SH_H(tok)});
    if(!r.ok) throw new Error(`Shopify products HTTP ${r.status}`);
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
  let all=[], url=`${SH_URL(shop)}/orders.json?limit=250&status=any&financial_status=paid&created_at_min=${since}&fields=id,email,line_items,created_at,shipping_address,payment_gateway,payment_gateway_names,financial_status,total_price,subtotal_price,total_tax,total_discounts,total_shipping_price_set,cancelled_at,refunds,source_name,tags,note_attributes`;
  if(until) url+=`&created_at_max=${until}`;
  while(url){
    const r=await fetchTR(url,{headers:SH_H(tok)});
    if(!r.ok) throw new Error(`Shopify orders HTTP ${r.status}`);
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
    // Default: rango [hoy - N días, fin de hoy] en zona AR. Ojo: el día hay que
    // sacarlo del calendario ARGENTINO, no de toISOString() (que es UTC y a
    // partir de las 21:00 local ya devuelve el día siguiente).
    const argYmd = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(d);
    const hoyArg = argYmd(new Date());
    const dToday = new Date(`${hoyArg}T23:59:59-03:00`);
    fromISO = `${argYmd(new Date(Date.now() - (days - 1) * 86400000))}T00:00:00-03:00`;
    toISO   = dToday.toISOString();
  }
  // ML pagina de a 50, techo 2000 (40 páginas). Antes el for de offsets era
  // secuencial (hasta 40 requests encadenados). Ahora: la PRIMERA página trae
  // paging.total, y con eso los offsets restantes van en lotes de 4 en
  // paralelo con stagger (mismo patrón que tnOrders). El array final se
  // concatena POR OFFSET, no por orden de llegada.
  const PP = 50, CAP = 2000, BATCH = 4, STAGGER = 400;
  const urlDe = (offset) => `https://api.mercadolibre.com/orders/search?seller=${sellerId}&order.status=paid&order.date_created.from=${encodeURIComponent(fromISO)}&order.date_created.to=${encodeURIComponent(toISO)}&limit=${PP}&offset=${offset}&sort=date_desc`;
  const r0 = await fetchTR(urlDe(0), { headers: ML_H(tok) });
  if (!r0.ok) throw new Error(`ML orders HTTP ${r0.status} (offset 0)`);
  const d0 = await r0.json();
  const pages = [d0.results || []];
  const totalReal = parseInt(d0.paging?.total) || pages[0].length;
  const total = Math.min(totalReal, CAP);
  if (pages[0].length >= PP && total > PP) {
    const offsets = [];
    for (let o = PP; o < total; o += PP) offsets.push(o);
    for (let i = 0; i < offsets.length; i += BATCH) {
      const lote = offsets.slice(i, i + BATCH);
      const res = await Promise.all(lote.map(async (offset) => {
        const r = await fetchTR(urlDe(offset), { headers: ML_H(tok) });
        if (!r.ok) throw new Error(`ML orders HTTP ${r.status} (offset ${offset})`);
        const d = await r.json();
        return d.results || [];
      }));
      lote.forEach((offset, k) => { pages[offset / PP] = res[k]; });
      if (i + BATCH < offsets.length) await new Promise(res => setTimeout(res, STAGGER));
    }
  }
  const all = [];
  for (const p of pages) if (Array.isArray(p)) all.push(...p);
  if (totalReal > CAP) all.truncated = true; // techo de 2000 alcanzado — resultado parcial
  return all;
}

// ── Procesar órdenes TN ───────────────────────────────────────────────
function processTN(orders) {
  const map={}, daily={}, dailyRevenue={}, byProv={}, byHour={}, byPayment={}, byVariant={};
  const dailyOrders={}; // "YYYY-MM-DD" → cantidad de órdenes
  const ordersDetail=[]; // detalle por orden — habilita comisiones/envío/impuestos por método en Márgenes
  // Calidad del dato: TN filtra por payment_status, pero una orden CANCELADA
  // puede seguir con payment_status=paid — antes contaba a valor pleno. Se
  // excluye acá y se informa cuántas fueron. Los reembolsos parciales sí
  // entran (TN no expone el monto reembolsado), pero se cuentan para que el
  // dashboard pueda avisar que esos números son a valor pleno.
  let cancelledExcluded=0, partialRefundOrders=0;
  // Desglose de facturación (para diagnosticar diferencias vs otras apps):
  // bruto = productos a precio de lista · descuento = cupones/promos ·
  // envíoCliente = lo que el cliente pagó de envío (no lo que la tienda le paga al correo).
  let brutoTotal=0, descuentoTotal=0, envioClienteTotal=0;
  for(const o of orders){
    if(o.status==="cancelled" || o.cancelled_at){ cancelledExcluded++; continue; }
    if(o.payment_status==="partially_refunded") partialRefundOrders++;
    // TN devuelve created_at en UTC (+0000). Se convierte a hora argentina (UTC-3,
    // sin DST) ANTES de cortar día/hora — sino las ventas de 21:00 a 24:00 caían
    // al día siguiente y el corte diario/mensual no coincidía con el admin de TN
    // (y el histograma por hora quedaba corrido 3 horas).
    const rawDt=o.created_at||"";
    const dtMs=rawDt ? Date.parse(rawDt) : NaN;
    const dt=isNaN(dtMs) ? "" : new Date(dtMs-3*3600000).toISOString().slice(0,19);
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

    const detItems=[];
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
      detItems.push({ key: item.sku || vid, vid, qty });
    }
    // Envío cobrado al cliente (lo que pagó por el shipping). TN lo expone como
    // shipping_cost_customer; shipping_cost_owner es lo que la tienda le paga al correo.
    const envioCliente = parseFloat(o.shipping_cost_customer)||0;
    // La facturación de TN INCLUYE el envío cobrado al cliente (así lo reporta el
    // admin de TN y así lo trae Shopify en total_price). Se suma a nivel orden —
    // no por variante, porque el envío no es atribuible a un producto.
    if(orderRevenue>0) orderRevenue += envioCliente;
    if(day)  { daily[day]=(daily[day]||0)+orderUnits; dailyRevenue[day]=(dailyRevenue[day]||0)+orderRevenue; }
    if(hour) byHour[hour]=(byHour[hour]||0)+orderUnits;
    byProv[prov]=(byProv[prov]||0)+orderUnits;
    byPayment[pay]=(byPayment[pay]||0)+orderUnits;
    if(orderRevenue>0){
      brutoTotal += orderSubtotal;
      descuentoTotal += Math.min(orderDiscount, orderSubtotal);
      envioClienteTotal += envioCliente;
      ordersDetail.push({ id:String(o.id), nombre:`#${o.number||o.id}`, fecha:dt, platform:"tiendanube", revenue:orderRevenue, envioCliente, items:detItems, pay, envioCosto:parseFloat(o.shipping_cost_owner)||0, cust:String(o.customer?.id||o.contact_email||"") });
    }
  }
  return {map,daily,dailyRevenue,dailyOrders,byProv,byHour,byPayment,byVariant,ordersDetail,
    facturacion:{ bruto:+brutoTotal.toFixed(2), descuento:+descuentoTotal.toFixed(2), envioCliente:+envioClienteTotal.toFixed(2), neto:+(brutoTotal-descuentoTotal).toFixed(2) },
    quality:{cancelledExcluded,partialRefundOrders}};
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
    // Órdenes de suscripción de Recurrentes: se cobran por Mercado Pago aunque
    // versiones viejas quedaron con gateway "manual". Se detectan por source_name
    // o el tag "RECURRENTE" y se fuerza el método a Mercado Pago para que el motor
    // de márgenes les aplique la comisión de MP (no una genérica ni $0).
    const esRecurrentes = String(o.source_name||"")==="Recurrentes" || /(^|,)\s*RECURRENTE\b/i.test(String(o.tags||""));
    const pay=esRecurrentes ? "Mercado Pago" : ((Array.isArray(o.payment_gateway_names)&&o.payment_gateway_names.length?o.payment_gateway_names.join(", "):o.payment_gateway)||"Otro");
    // Comisión REAL de MP embebida por Recurrentes en la orden (note_attribute
    // "mp_fee_real"). Si está, el motor la usa como fee exacto en vez del %.
    let saleFeeReal = null, mpPayId = null;
    if (esRecurrentes && Array.isArray(o.note_attributes)) {
      const na = o.note_attributes.find(a => a && a.name === "mp_fee_real");
      const v = na ? parseFloat(na.value) : NaN;
      if (isFinite(v) && v > 0) saleFeeReal = v;
      // Órdenes viejas de Recurrentes no tienen mp_fee_real pero sí mp_payment_id:
      // el motor cruza el fee real por ese ID (retroactivo).
      const naPay = o.note_attributes.find(a => a && a.name === "mp_payment_id");
      if (naPay && naPay.value) mpPayId = String(naPay.value);
    }
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
      // vid (variant_id) es ESTABLE: no cambia si renombrás la variante ni si le
      // cambiás el SKU. El motor lo usa para unificar las ventas viejas y nuevas
      // de la misma variante bajo su nombre actual.
      detItems.push({ key: item.sku || vid, vid, qty });
    }
    if(day)  { daily[day]=(daily[day]||0)+orderUnits; dailyRevenue[day]=(dailyRevenue[day]||0)+orderRevenue; }
    if(hour) byHour[hour]=(byHour[hour]||0)+orderUnits;
    byProv[prov]=(byProv[prov]||0)+orderUnits;
    byPayment[pay]=(byPayment[pay]||0)+orderUnits;
    if(orderRevenue>0) ordersDetail.push({ id:String(o.id), nombre:`#${o.order_number||o.name||o.id}`, fecha:dt, platform:"shopify", revenue:orderRevenue, items:detItems, pay, envioCosto:parseFloat(o.total_shipping_price_set?.shop_money?.amount)||0, cust:String(o.email||""), ...(saleFeeReal!=null?{saleFee:saleFeeReal}:{}), ...(mpPayId?{mpPayId}:{}) });
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

// Publicaciones REALES del vendedor de ML (id → título), aunque no se hayan
// vendido — para poder cargarles el costo (COGS) en Márgenes. Devuelve {id: title}.
async function mlPublications(sellerId, token) {
  const out = {}, ids = [];
  try {
    for (let offset = 0; offset < 1000; offset += 50) {
      const r = await fetchT(`https://api.mercadolibre.com/users/${sellerId}/items/search?limit=50&offset=${offset}`, { headers: ML_H(token) });
      if (!r.ok) break;
      const j = await r.json();
      const res = j.results || [];
      ids.push(...res);
      if (res.length < 50) break;
    }
    for (let i = 0; i < ids.length; i += 20) {
      const r = await fetchT(`https://api.mercadolibre.com/items?ids=${ids.slice(i, i+20).join(",")}&attributes=id,title`, { headers: ML_H(token) });
      if (!r.ok) continue;
      const arr = await r.json();
      for (const it of (arr || [])) { const b = it.body || it; if (b?.id) out[b.id] = b.title || b.id; }
    }
  } catch (_) {}
  return out;
}

function processML(orders, couponMap = {}) {
  const map={}, daily={}, dailyRevenue={}, dailyOrders={}, byProv={}, byHour={}, byPayment={}, byVariant={}, byVariantRev={}, comisionMLDaily={};
  let comisionML=0; const ordersDetail=[];
  for(const o of orders){
    let orderFee=0; const detItems=[];
    const dt=o.date_created||"";
    const day=dt.slice(0,10);
    const hour=dt.slice(11,13);
    // El search de ML no trae la provincia del comprador — etiquetamos honesto
    // en vez de imputar "Buenos Aires" (mentía en el donut geográfico).
    const prov="Mercado Libre (sin ubicación)";
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

    // Devolución/contracargo: cuando el comprador recupera su plata, ML deja el
    // PAGO en status "refunded" (devolución) o "charged_back" (contracargo) —ese es
    // el signal confiable—, o marca un reembolso parcial en transaction_amount_refunded
    // sobre un pago que sigue "approved". El tag "refunded" NO existe en órdenes ML,
    // y transaction_amount_refunded muchas veces queda en 0 aunque el pago esté
    // devuelto, así que hay que mirar el status. ML ANULA los cargos de esas ventas
    // (comisión y envío) en la facturación → acá se excluyen de TODOS los agregados
    // (revenue, unidades, comisión, COGS vía map) igual que una cancelada. La orden
    // queda en ordersDetail con el flag para el contador de devueltas y para que el
    // motor no cuente su costo de envío.
    // Neto cobrado = cobrado − devuelto: un pago devuelto/contracargado suma a AMBOS
    // (entró y salió); un reembolso parcial sobre un pago vivo solo suma a devuelto.
    // Los intentos fallidos (cancelled/rejected) NO son devoluciones y no se cuentan.
    // Si el comprador repagó (otro pago approved), el neto se mantiene y NO se excluye.
    const totAmt = parseFloat(o.total_amount)||0;
    let cobradoML = 0, devueltoML = 0;
    for (const p of (o.payments||[])) {
      const st = String(p.status||"").toLowerCase();
      const amt = parseFloat(p.transaction_amount)||0;
      const tar = parseFloat(p.transaction_amount_refunded)||0;
      if (st === "approved") { cobradoML += amt; devueltoML += tar; }
      else if (st === "refunded" || st === "charged_back") { cobradoML += amt; devueltoML += (amt > 0 ? amt : tar); }
    }
    const refunded = cobradoML > 0 && (cobradoML - devueltoML) <= cobradoML * 0.01;

    for(const item of o.order_items||[]){
      const vid=String(item.item?.id||"ml");
      const qty=parseInt(item.quantity)||0;
      const rev=parseFloat(item.unit_price)*qty; // per-variant a precio de lista
      const vname=item.item?.variation_attributes?.[0]?.value_name||item.item?.title||"Default";
      if(!refunded){
        if(!map[vid]) map[vid]={units:0,revenue:0,nombre:item.item?.title};
        map[vid].units+=qty;
        map[vid].revenue+=rev;
        byVariant[vname]=(byVariant[vname]||0)+qty;
        byVariantRev[vname]=(byVariantRev[vname]||0)+rev;
      }
      orderUnits+=qty;
      orderFee += (parseFloat(item.sale_fee||0)) * qty; // comisión real de ML — sale_fee es POR UNIDAD (igual que unit_price), hay que × cantidad
      detItems.push({ key: "ml:"+String(item.item?.id||"ml"), qty });
    }
    if(!refunded){
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
    }
    if(orderRev>0) ordersDetail.push({ id:String(o.id), nombre:`ML #${o.id}`, fecha:(o.date_closed||o.date_created||""), platform:"mercadolibre", revenue:orderRev, items:detItems, saleFee:orderFee, shippingId:o.shipping?.id||null, cust:String(o.buyer?.id||""), refunded });
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
    const varNombre=(v.values||[]).map(val=>val.es||val.en||Object.values(val||{})[0]||"").filter(Boolean).join(" / ")||v.sku||"Default";
    return {id:vid,sku:v.sku||"",nombre:varNombre,stock,units_sold:s.units,revenue:s.revenue,days_left:daysLeft(stock,s.units,days),price:parseFloat(v.price)||0};
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
  // total_revenue viene de la suma de dailyRevenue: productos netos de descuento
  // + envío cobrado al cliente (= la "facturación" que reporta el admin de TN;
  // Shopify ya lo trae así en total_price). Antes era line_items × precio de lista.
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
    facturacion:    analytics.facturacion||null, // desglose bruto/descuento/envíoCliente/neto (TN)
  };
}

export default async function handler(req, res) {
  { const _o=String(req.headers.origin||""); res.setHeader("Access-Control-Allow-Origin", (["https://www.growithapp.com","https://growithapp.com","https://soluna-gestion.vercel.app"].includes(_o)||_o.endsWith("-soluna1.vercel.app")||_o.startsWith("http://localhost"))?_o:"https://www.growithapp.com"); } // allowlist CORS
  res.setHeader("Access-Control-Allow-Methods","GET, OPTIONS");
  // El front ahora manda el ID token de Firebase — sin este header el preflight
  // del browser rechaza la request antes de que llegue acá.
  res.setHeader("Access-Control-Allow-Headers","Content-Type, Authorization");
  if(req.method==="OPTIONS") return res.status(200).end(); // el preflight nunca lleva credenciales

  const {uid, action, days:dRaw, date_from, date_to}=req.query;

  // ── CRON: pre-calienta el snapshot de Stock (7d, el período default) de todos
  // los usuarios con tienda conectada. Así la PRIMERA carga del día también es
  // instantánea (cache=only), no solo las siguientes (SWR local).
  if (action === "warm_all") {
    if (!guardCron(req, res)) return;
    const db = initAdmin();
    // ── Rotación por antigüedad del último precalentado ──────────────────
    // Antes: .limit(50) SIN orderBy → Firestore devuelve siempre las mismas 50
    // (las primeras por id) y, con muchas cuentas, el resto no veía nunca un
    // snapshot caliente. Ahora la cola se ordena por `stockWarmAt` ascendente:
    // primero las que hace más tiempo no se calientan, y al procesarlas se
    // reescribe la marca. orderBy sobre UN campo usa el índice de campo único
    // que Firestore crea solo — NO hace falta índice compuesto.
    const CANDIDATOS = 40, MAX_WARM = 15;

    // Alta de cuentas nuevas en la rotación: las que no tienen `stockWarmAt` no
    // aparecen en el orderBy, así que se las siembra con un barrido rotativo de
    // la colección (100 documentos por corrida, con cursor guardado en
    // system_warm/stock_seed — un doc del cron, una escritura cada 15 min, no
    // un documento compartido por todas las cuentas). Al sembrarlas con la
    // fecha 0 quedan a la cabeza de la cola y se calientan enseguida.
    try {
      const seedRef = db.collection("system_warm").doc("stock_seed");
      const seedSnap = await seedRef.get();
      const desde = seedSnap.exists ? (seedSnap.data().cursor || null) : null;
      let q = db.collection("users").orderBy("__name__").limit(100).select("stockWarmAt");
      // Con orderBy("__name__") el cursor tiene que ser una referencia de documento.
      if (desde) q = q.startAfter(db.collection("users").doc(desde));
      const barrido = await q.get();
      if (barrido.empty) {
        await seedRef.set({ cursor: null, at: new Date().toISOString() }); // volver a empezar
      } else {
        const wb = db.batch(); let n = 0;
        for (const d of barrido.docs) {
          if (d.data().stockWarmAt) continue;
          wb.set(d.ref, { stockWarmAt: new Date(0).toISOString() }, { merge: true });
          n++;
        }
        if (n) await wb.commit();
        await seedRef.set({ cursor: barrido.docs[barrido.docs.length - 1].id, at: new Date().toISOString(), sembradas: n });
      }
    } catch (e) { console.error("[stock warm_all] alta de cuentas nuevas:", e.message); }

    const rotSnap = await db.collection("users")
      .orderBy("stockWarmAt").limit(CANDIDATOS).select("stores", "stockWarmAt", "plan", "planExpiry", "trialEnd").get();
    const candidatos = rotSnap.docs.slice();
    const targets = [], marcar = [];
    const ahora = new Date();
    for (const d of candidatos) {
      const u = d.data();
      const tieneTienda = (u.stores || []).some(s => s.accessToken);
      // Solo cuentas con plan vigente o trial activo: calentar cuentas free o
      // vencidas quema cuota de TN/ML y presupuesto de Vercel en gente que no paga.
      const exp = u.planExpiry?.toDate?.() || null;
      const trial = u.trialEnd?.toDate?.() || null;
      const activo = (u.plan && u.plan !== "free" && (!exp || exp > ahora)) || (trial && trial > ahora);
      // Las cuentas que no aplican igual se marcan: si no, se quedan
      // tapando la cabeza de la cola corrida tras corrida.
      if (!tieneTienda || !activo) { marcar.push(d.ref); continue; }
      if (targets.length >= MAX_WARM) break;
      targets.push(d.id); marcar.push(d.ref);
    }
    try {
      const wb = db.batch();
      const ahoraIso = new Date().toISOString();
      for (const ref of marcar.slice(0, 450)) wb.set(ref, { stockWarmAt: ahoraIso }, { merge: true });
      if (marcar.length) await wb.commit();
    } catch (e) { console.error("[stock warm_all] marca de rotación:", e.message); }
    const base = `https://${req.headers.host}`;
    const results = await Promise.allSettled(targets.map(u =>
      // El subrequest tiene que autenticarse igual que cualquier otro: reenvía el
      // CRON_SECRET para que el guard de abajo lo reconozca como cron (isCronRequest).
      fetch(`${base}/api/stock?action=products&uid=${u}&days=7`, {
        headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
        signal: AbortSignal.timeout(50000),
      }).then(r => r.status)
    ));
    return res.json({ ok: true, warmed: targets.length, statuses: results.map(r => r.status === "fulfilled" ? r.value : "err") });
  }

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

  // Autorización multi-tenant: el uid ya no alcanza como identidad — hay que
  // probar que el token pertenece a esa cuenta (o a su equipo/un admin). Única
  // excepción: el cron interno (warm_all), que se identifica con CRON_SECRET.
  // Cubre TODAS las acciones de acá para abajo (products, cache=only, el guardado
  // del snapshot en users/{uid}/stock_cache, y cualquier acción futura).
  if (!isCronRequest(req) && !(await guardUid(req, res, uid))) return;

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
      // Rol de la cuenta ML: si es "solo Shopify/TN" (margenesMlVentas="__none__"),
      // NO importamos ventas de ML (solo se usa el token para comisiones de MP).
      const mlVentasCfg = String(snap.data().margenesMlVentas || "");
      if(ml && mlVentasCfg !== "__none__"){
        try{
          const tok=await getValidMLToken(dbRef, uid, mlVentasCfg || null);
          if(tok?.accessToken && tok?.userId){ mlSellerId=tok.userId; mlToken=tok.accessToken; }
        }catch(_){ /* ML token roto, no abortamos — seguimos sin ML */ }
      }
    }
  }catch(e){
    console.error("[stock]",e.message);
    return res.status(500).json({ error: "Error al obtener credenciales" });
  }
  if(!accessToken) return res.status(403).json({ error: "Tienda no conectada" });

  // ── Cache server-side del snapshot (users/{uid}/stock_cache/{periodo}) ──
  const cacheKey = hasCustomDate ? `${String(date_from).slice(0,10)}_${String(date_to).slice(0,10)}` : `d${effectiveDays}`;
  if (action === "products" && req.query.cache === "only") {
    try {
      const cs = await dbRef.collection("users").doc(uid).collection("stock_cache").doc(cacheKey).get();
      if (cs.exists) { const c = cs.data(); return res.status(200).json({ ...c.data, cachedAt: c.ts }); }
    } catch (_) {}
    return res.status(200).json({ noCache: true });
  }
  async function saveStockCache(resp) {
    try {
      const s = JSON.stringify(resp);
      if (s.length > 900000) return; // margen bajo el límite de 1MB por doc de Firestore
      await dbRef.collection("users").doc(uid).collection("stock_cache").doc(cacheKey)
        .set({ ts: new Date().toISOString(), data: JSON.parse(s) });
    } catch (_) {}
  }
  // ── Cache del catálogo TN (users/{uid}/stock_cache/tn_products, TTL 1h) ──
  // La paginación completa del catálogo (secuencial, ~4s por página de 50) se
  // repetía en CADA request aunque el catálogo casi nunca cambia. Con caché de
  // 1h el stock mostrado puede quedar hasta 1h desfasado — las ventas/órdenes
  // siguen siempre en vivo.
  async function tnProductsCached(sid, tok) {
    const ref = dbRef.collection("users").doc(uid).collection("stock_cache").doc("tn_products");
    try {
      const s = await ref.get();
      if (s.exists) {
        const c = s.data() || {};
        if (c.cachedAt && (Date.now() - Date.parse(c.cachedAt)) < 3600000 && Array.isArray(c.items)) return c.items;
      }
    } catch (_) {}
    const items = await tnProducts(sid, tok);
    try {
      const str = JSON.stringify(items);
      if (str.length <= 850000) await ref.set({ cachedAt: new Date().toISOString(), items: JSON.parse(str) }); // guard 850KB — si no entra, no se cachea
    } catch (_) {}
    return items;
  }

  // Techo duro para TODA la consulta de ventas — sin importar cuántas páginas
  // reintenten en cascada bajo una red inestable, esto garantiza una respuesta
  // JSON clara ANTES de que Vercel mate la función en seco (que devuelve 0
  // bytes al cliente, mucho peor que un error explícito).
  const DEADLINE_MS = 45000;
  function withDeadline(promise, label) {
    return Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`Tiempo agotado trayendo ${label} (${DEADLINE_MS/1000}s) — la tienda o Mercado Libre están respondiendo muy lento. Reintentá en unos segundos.`)), DEADLINE_MS)),
    ]);
  }

  try{
    if(action==="products"){
      // Helper: fetch ML data en paralelo (si está conectado).
      // Funciona con cualquier plataforma primaria (Shopify O TN).
      const fetchML = async () => {
        if (!mlSellerId || !mlToken) return null; // ML no conectado: no-op legítimo
        // Si ML SÍ está conectado, un fallo acá no puede tragarse en silencio —
        // ocultaría facturación real (exactamente el bug de los totales
        // fluctuantes). mlCouponFees es best-effort (afecta un descuento
        // menor, no el total de ventas); mlOrders no.
        const [mlOrd, coupons, pubs] = await Promise.all([
          mlOrders(mlSellerId, mlToken, effectiveDays, sinceDate, untilDate),
          mlCouponFees(mlToken, sinceDate, untilDate).catch(() => ({})),
          mlPublications(mlSellerId, mlToken).catch(() => ({})),
        ]);
        const out = processML(mlOrd, coupons);
        out.truncated = !!mlOrd.truncated;
        // Sumar publicaciones que NO se vendieron (units 0) para poder costearlas.
        out.map = out.map || {};
        for (const [id, title] of Object.entries(pubs || {})) {
          if (!out.map[id]) out.map[id] = { nombre: title, units: 0 };
          else if (!out.map[id].nombre) out.map[id].nombre = title;
        }
        return out;
      };
      if(platform==="shopify"){
        const [products, orders, mlAnalytics] = await withDeadline(Promise.all([
          shProducts(shop, accessToken),
          shOrders(shop, accessToken, effectiveDays, sinceDate, untilDate),
          fetchML(),
        ]), "Shopify/ML");
        const analytics = processSH(orders);
        const normalized = products.map(p => normSH(p, analytics.map, days));
        const resp = buildResponse("shopify", normalized, analytics, effectiveDays);
        resp.quality = { tn_truncated:false, ml_truncated:!!(mlAnalytics&&mlAnalytics.truncated), cancelled_excluded:0, partial_refund_orders:0 };
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
        await saveStockCache(resp);
        return res.status(200).json(resp);
      } else {
        const [products, orders, mlAnalytics] = await withDeadline(Promise.all([
          tnProductsCached(storeId, accessToken),
          tnOrders(storeId, accessToken, effectiveDays, sinceDate, untilDate),
          fetchML(),
        ]), "Tienda Nube/ML");
        const analytics = processTN(orders);
        const normalized = products.map(p => normTN(p, analytics.map, effectiveDays));
        const resp = buildResponse("tiendanube", normalized, analytics, effectiveDays);
        resp.quality = { tn_truncated:!!orders.truncated, ml_truncated:!!(mlAnalytics&&mlAnalytics.truncated), cancelled_excluded:analytics.quality?.cancelledExcluded||0, partial_refund_orders:analytics.quality?.partialRefundOrders||0 };
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
        await saveStockCache(resp);
        return res.status(200).json(resp);
      }
    }
    return res.status(400).json({error:"Acción no reconocida"});
  }catch(e){
    console.error("[stock] error:",e.message, e.stack?.split("\n")[1]);
    // Los timeouts/aborts contra TN/ML son transitorios — mensaje humano, no "operation was aborted"
    const esTimeout = /abort|aborted|Tiempo agotado|timeout/i.test(e.message||"");
    return res.status(esTimeout?504:500).json({error: esTimeout
      ? "Tu tienda está respondiendo lento en este momento (pasa seguido con rangos largos). Reintentá en unos segundos — apenas cargue una vez, ese período queda cacheado y abre al instante."
      : `Error interno: ${e.message}`});
  }
}
