// api/stock.js — Growith Stock Analytics
// Soporta Tienda Nube, Shopify y Mercado Libre
// Devuelve productos, variantes, stock, ventas, provincia, hora, método de pago

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g,"\n").replace(/"/g,""),
  })});
  return getFirestore();
}

const FALLBACK_STORE_ID = "6978415";
const FALLBACK_TOKEN    = "71be8939bf409df5b98caa80e22d7227ad288f82";

const TN_H  = t => ({ "Authentication":`bearer ${t}`, "User-Agent":"GrowithApp (soluna.biolight@gmail.com)" });
const SH_H  = t => ({ "X-Shopify-Access-Token":t, "Content-Type":"application/json" });
const ML_H  = t => ({ "Authorization":`Bearer ${t}` });
const SH_URL = s => `https://${s}/admin/api/2024-10`;

// ── TN Fetch ──────────────────────────────────────────────────────────
async function tnProducts(sid, tok) {
  let all=[], page=1;
  while(true){
    const r=await fetch(`https://api.tiendanube.com/v1/${sid}/products?per_page=200&page=${page}`,{headers:TN_H(tok)});
    if(!r.ok) break;
    const d=await r.json();
    if(!Array.isArray(d)||d.length===0) break;
    all=all.concat(d);
    if(d.length<200) break;
    page++;
  }
  return all;
}

async function tnOrders(sid, tok, days, since, until) {
  let url=`https://api.tiendanube.com/v1/${sid}/orders?per_page=200&page=PAGE&payment_status=paid,partially_paid,partially_refunded&created_at_min=${since}`;
  if(until) url+=`&created_at_max=${until}`;
  const pages=await Promise.all([1,2,3,4,5].map(p=>
    fetch(url.replace("PAGE",p),{headers:TN_H(tok)})
    .then(r=>r.ok?r.json():[]).catch(()=>[])
  ));
  return pages.flat().filter(o=>o?.id);
}

// ── Shopify Fetch ─────────────────────────────────────────────────────
async function shProducts(shop, tok) {
  let all=[], sinceId=null;
  while(true){
    let url=`${SH_URL(shop)}/products.json?limit=250&fields=id,title,variants,image`;
    if(sinceId) url+=`&since_id=${sinceId}`;
    const r=await fetch(url,{headers:SH_H(tok)});
    if(!r.ok) break;
    const {products:batch}=await r.json();
    if(!batch||batch.length===0) break;
    all=all.concat(batch);
    if(batch.length<250) break;
    sinceId=batch[batch.length-1].id;
  }
  return all;
}

async function shOrders(shop, tok, days, since, until) {
  let base=`${SH_URL(shop)}/orders.json?limit=250&status=any&financial_status=paid,partially_paid,partially_refunded&created_at_min=${since}&fields=id,line_items,created_at,shipping_address,payment_gateway`;
  if(until) base+=`&created_at_max=${until}`;
  const pages=await Promise.all([1,2].map(async ()=>{
    const r=await fetch(base,{headers:SH_H(tok)});
    return r.ok?(await r.json()).orders||[]:[];
  }));
  return pages.flat();
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
  const map={}, daily={}, byProv={}, byHour={}, byPayment={}, byVariant={};
  const dailyOrders={}; // "YYYY-MM-DD" → cantidad de órdenes
  for(const o of orders){
    const dt=o.created_at||"";
    const day=dt.slice(0,10);
    const hour=dt.slice(11,13);
    const prov=o.shipping_address?.province||o.billing_address?.province||"Sin provincia";
    const pay=o.gateway||"Otro";
    let orderUnits=0;

    // Contar la orden
    if(day) dailyOrders[day]=(dailyOrders[day]||0)+1;

    for(const item of o.products||[]){
      const vid=String(item.variant_id||item.product_id);
      const qty=parseInt(item.quantity)||0;
      const rev=parseFloat(item.price)*qty;
      if(!map[vid]) map[vid]={units:0,revenue:0};
      map[vid].units+=qty;
      map[vid].revenue+=rev;
      orderUnits+=qty;
      const vname=item.variant_values?.join(" / ")||item.name||"Default";
      byVariant[vname]=(byVariant[vname]||0)+qty;
      // Para ventas (por orden) también trackeamos por variante
      byVariant[vname+"__orders"]=(byVariant[vname+"__orders"]||0)+1;
    }
    if(day)  daily[day]  =(daily[day]  ||0)+orderUnits;
    if(hour) byHour[hour]=(byHour[hour]||0)+orderUnits;
    byProv[prov]=(byProv[prov]||0)+orderUnits;
    byPayment[pay]=(byPayment[pay]||0)+orderUnits;
  }
  return {map,daily,dailyOrders,byProv,byHour,byPayment,byVariant};
}

// ── Procesar órdenes Shopify ──────────────────────────────────────────
function processSH(orders) {
  const map={}, daily={}, byProv={}, byHour={}, byPayment={}, byVariant={};
  const dailyOrders={};
  for(const o of orders){
    const dt=o.created_at||"";
    const day=dt.slice(0,10);
    const hour=dt.slice(11,13);
    const prov=o.shipping_address?.province||"Sin provincia";
    const pay=o.payment_gateway||"Otro";
    let orderUnits=0;

    if(day) dailyOrders[day]=(dailyOrders[day]||0)+1;

    for(const item of o.line_items||[]){
      const vid=String(item.variant_id||item.product_id);
      const qty=parseInt(item.quantity)||0;
      const rev=parseFloat(item.price)*qty;
      if(!map[vid]) map[vid]={units:0,revenue:0};
      map[vid].units+=qty;
      map[vid].revenue+=rev;
      orderUnits+=qty;
      const vname=item.variant_title||item.title||"Default";
      byVariant[vname]=(byVariant[vname]||0)+qty;
    }
    if(day)  daily[day]  =(daily[day]  ||0)+orderUnits;
    if(hour) byHour[hour]=(byHour[hour]||0)+orderUnits;
    byProv[prov]=(byProv[prov]||0)+orderUnits;
    byPayment[pay]=(byPayment[pay]||0)+orderUnits;
  }
  return {map,daily,dailyOrders,byProv,byHour,byPayment,byVariant};
}

// ── Procesar órdenes ML ───────────────────────────────────────────────
function processML(orders) {
  const map={}, daily={}, byProv={}, byHour={}, byPayment={}, byVariant={};
  for(const o of orders){
    const dt=o.date_created||"";
    const day=dt.slice(0,10);
    const hour=dt.slice(11,13);
    const prov="Buenos Aires"; // ML no siempre da provincia en search
    const pay=o.payments?.map(p=>p.payment_type).join(",")||"Mercado Pago";
    let orderUnits=0;

    for(const item of o.order_items||[]){
      const vid=String(item.item?.id||"ml");
      const qty=parseInt(item.quantity)||0;
      const rev=parseFloat(item.unit_price)*qty;
      if(!map[vid]) map[vid]={units:0,revenue:0,nombre:item.item?.title};
      map[vid].units+=qty;
      map[vid].revenue+=rev;
      orderUnits+=qty;
      byVariant[item.item?.variation_attributes?.[0]?.value_name||item.item?.title||"Default"]=(byVariant[item.item?.variation_attributes?.[0]?.value_name||item.item?.title||"Default"]||0)+qty;
    }
    if(day)  daily[day]  =(daily[day]  ||0)+orderUnits;
    if(hour) byHour[hour]=(byHour[hour]||0)+orderUnits;
    byProv[prov]=(byProv[prov]||0)+orderUnits;
    byPayment[pay]=(byPayment[pay]||0)+orderUnits;
  }
  return {map,daily,byProv,byHour,byPayment,byVariant};
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
  return {
    platform, products, days,
    total_products: products.length,
    total_variants: products.reduce((a,p)=>a+p.variants.length,0),
    total_stock:    products.reduce((a,p)=>a+p.stock_total,0),
    total_units:    products.reduce((a,p)=>a+p.units_sold,0),
    total_revenue:  products.reduce((a,p)=>a+p.revenue,0),
    total_orders:   totalOrders,
    daily_series:   analytics.daily,      // unidades por día
    daily_orders:   analytics.dailyOrders||{}, // órdenes por día
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
  const sinceDate = hasCustomDate
    ? new Date(date_from).toISOString()
    : new Date(Date.now()-effectiveDays*86400000).toISOString();
  const untilDate = hasCustomDate ? new Date(date_to).toISOString() : null;

  let platform="tiendanube", storeId=FALLBACK_STORE_ID, accessToken=FALLBACK_TOKEN, shop, mlSellerId, mlToken;

  if(uid){
    try{
      const db=initAdmin();
      const snap=await db.collection("users").doc(uid).get();
      if(snap.exists){
        const stores=snap.data().stores||[];
        const tn=stores.find(s=>s.type==="tiendanube");
        const sh=stores.find(s=>s.type==="shopify");
        const ml=stores.find(s=>s.type==="mercadolibre"||s.type==="meli");
        if(sh?.accessToken&&sh?.shop){ platform="shopify"; shop=sh.shop; accessToken=sh.accessToken; }
        else if(tn?.accessToken&&tn?.storeId){ platform="tiendanube"; storeId=tn.storeId; accessToken=tn.accessToken; }
        // ML como complemento (si está conectado)
        if(ml?.accessToken&&ml?.sellerId){ mlSellerId=ml.sellerId; mlToken=ml.accessToken; }
      }
    }catch(e){ console.error("[stock]",e.message); }
  }

  try{
    if(action==="products"){
      if(platform==="shopify"){
        const [products,orders]=await Promise.all([shProducts(shop,accessToken),shOrders(shop,accessToken,effectiveDays,sinceDate,untilDate)]);
        const analytics=processSH(orders);
        const normalized=products.map(p=>normSH(p,analytics.map,days));
        return res.status(200).json(buildResponse("shopify",normalized,analytics,effectiveDays));
      } else {
        const [products,orders]=await Promise.all([tnProducts(storeId,accessToken),tnOrders(storeId,accessToken,effectiveDays,sinceDate,untilDate)]);
        const analytics=processTN(orders);
        const normalized=products.map(p=>normTN(p,analytics.map,days));
        // Si también tiene ML conectado, obtener ventas ML
        let mlAnalytics=null;
        if(mlSellerId&&mlToken){
          try{
            const mlOrd=await mlOrders(mlSellerId,mlToken,days);
            mlAnalytics=processML(mlOrd);
          }catch(e){}
        }
        const resp=buildResponse("tiendanube",normalized,analytics,effectiveDays);
        if(mlAnalytics) resp.ml_data={daily:mlAnalytics.daily,by_variant:mlAnalytics.byVariant,total_units:Object.values(mlAnalytics.map).reduce((a,v)=>a+v.units,0)};
        return res.status(200).json(resp);
      }
    }
    return res.status(400).json({error:"Acción no reconocida"});
  }catch(e){
    console.error("[stock] error:",e.message);
    return res.status(500).json({error:e.message});
  }
}
