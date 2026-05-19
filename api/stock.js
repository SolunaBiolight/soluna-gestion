// api/stock.js
// Lee productos, variantes, stock y ventas directamente de TN o Shopify
// Sin base de datos propia — siempre fuente de verdad es la plataforma

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

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

const FALLBACK_STORE_ID = "6978415";
const FALLBACK_TOKEN    = "71be8939bf409df5b98caa80e22d7227ad288f82";
const TN_HEADERS = (token) => ({
  "Authentication": `bearer ${token}`,
  "User-Agent": "GrowithApp (soluna.biolight@gmail.com)",
});
const SH_HEADERS = (token) => ({
  "X-Shopify-Access-Token": token,
  "Content-Type": "application/json",
});
const SH_API = (shop) => `https://${shop}/admin/api/2024-10`;

// ── TN helpers ──────────────────────────────────────────────────────
async function tnFetchAllProducts(storeId, token) {
  let products = [], page = 1;
  while (true) {
    const r = await fetch(
      `https://api.tiendanube.com/v1/${storeId}/products?per_page=200&page=${page}`,
      { headers: TN_HEADERS(token) }
    );
    if (!r.ok) break;
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) break;
    products = products.concat(data);
    if (data.length < 200) break;
    page++;
  }
  return products;
}

async function tnFetchSales(storeId, token, days) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  // Traer las primeras 3 páginas en paralelo para velocidad
  const pages = await Promise.all([1,2,3].map(page =>
    fetch(
      `https://api.tiendanube.com/v1/${storeId}/orders?per_page=200&page=${page}&payment_status=paid,partially_paid,partially_refunded&created_at_min=${since}`,
      { headers: TN_HEADERS(token) }
    ).then(r => r.ok ? r.json() : []).catch(() => [])
  ));
  return pages.flat().filter(o => Array.isArray([o]) && o.id);
}

// ── Shopify helpers ─────────────────────────────────────────────────
async function shFetchAllProducts(shop, token) {
  let products = [], sinceId = null;
  while (true) {
    let url = `${SH_API(shop)}/products.json?limit=250&fields=id,title,variants,image`;
    if (sinceId) url += `&since_id=${sinceId}`;
    const r = await fetch(url, { headers: SH_HEADERS(token) });
    if (!r.ok) break;
    const { products: batch } = await r.json();
    if (!batch || batch.length === 0) break;
    products = products.concat(batch);
    if (batch.length < 250) break;
    sinceId = batch[batch.length - 1].id;
  }
  return products;
}

async function shFetchSales(shop, token, days) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  // Solo primera página para velocidad
  const url = `${SH_API(shop)}/orders.json?limit=250&status=any&financial_status=paid,partially_paid,partially_refunded&created_at_min=${since}&fields=id,line_items,created_at`;
  const r = await fetch(url, { headers: SH_HEADERS(token) });
  if (!r.ok) return [];
  const { orders } = await r.json();
  return orders || [];
}

// ── Procesar ventas TN → mapa variantId → {units, revenue} ─────────
function processTNSales(orders) {
  const map = {}; // variantId → {units, revenue}
  const daily = {}; // "YYYY-MM-DD" → units
  for (const order of orders) {
    const day = (order.created_at || "").slice(0, 10);
    for (const item of order.products || []) {
      const vid = String(item.variant_id || item.product_id);
      if (!map[vid]) map[vid] = { units: 0, revenue: 0 };
      map[vid].units    += parseInt(item.quantity) || 0;
      map[vid].revenue  += parseFloat(item.price) * (parseInt(item.quantity) || 0);
      if (day) daily[day] = (daily[day] || 0) + (parseInt(item.quantity) || 0);
    }
  }
  return { map, daily };
}

// ── Procesar ventas Shopify → mapa variantId → {units, revenue} ────
function processSHSales(orders) {
  const map = {};
  const daily = {};
  for (const order of orders) {
    const day = (order.created_at || "").slice(0, 10);
    for (const item of order.line_items || []) {
      const vid = String(item.variant_id || item.product_id);
      if (!map[vid]) map[vid] = { units: 0, revenue: 0 };
      map[vid].units   += parseInt(item.quantity) || 0;
      map[vid].revenue += parseFloat(item.price) * (parseInt(item.quantity) || 0);
      if (day) daily[day] = (daily[day] || 0) + (parseInt(item.quantity) || 0);
    }
  }
  return { map, daily };
}

// ── Calcular proyección de días restantes ───────────────────────────
function calcDaysLeft(stock, units, days) {
  if (!units || units === 0) return null; // sin ventas → sin proyección
  const dailyRate = units / days;
  return Math.round(stock / dailyRate);
}

// ── Normalizar producto TN ──────────────────────────────────────────
function normalizeTNProduct(p, salesMap, days) {
  const variants = (p.variants || []).map(v => {
    const vid   = String(v.id);
    const stock = parseInt(v.stock) || 0;
    const sales = salesMap[vid] || { units: 0, revenue: 0 };
    return {
      id:         vid,
      sku:        v.sku || "",
      nombre:     Object.values(v.values?.[0] || {}).join(" / ") || "Default",
      stock,
      units_sold: sales.units,
      revenue:    sales.revenue,
      days_left:  calcDaysLeft(stock, sales.units, days),
      price:      parseFloat(v.price) || 0,
    };
  });
  const totalStock = variants.reduce((a, v) => a + v.stock, 0);
  const totalUnits = variants.reduce((a, v) => a + v.units_sold, 0);
  const totalRev   = variants.reduce((a, v) => a + v.revenue, 0);
  const minDays    = variants
    .map(v => v.days_left)
    .filter(d => d !== null)
    .reduce((a, b) => a === null ? b : Math.min(a, b), null);

  return {
    id:          String(p.id),
    nombre:      p.name?.es || p.name?.["pt-BR"] || Object.values(p.name || {})[0] || "Sin nombre",
    imagen:      p.images?.[0]?.src || null,
    variants,
    stock_total: totalStock,
    units_sold:  totalUnits,
    revenue:     totalRev,
    days_left:   minDays,
    platform:    "tiendanube",
  };
}

// ── Normalizar producto Shopify ─────────────────────────────────────
function normalizeSHProduct(p, salesMap, days) {
  const variants = (p.variants || []).map(v => {
    const vid   = String(v.id);
    const stock = v.inventory_quantity ?? 0;
    const sales = salesMap[vid] || { units: 0, revenue: 0 };
    return {
      id:         vid,
      sku:        v.sku || "",
      nombre:     [v.option1, v.option2, v.option3].filter(Boolean).join(" / ") || "Default",
      stock,
      units_sold: sales.units,
      revenue:    sales.revenue,
      days_left:  calcDaysLeft(stock, sales.units, days),
      price:      parseFloat(v.price) || 0,
    };
  });
  const totalStock = variants.reduce((a, v) => a + v.stock, 0);
  const totalUnits = variants.reduce((a, v) => a + v.units_sold, 0);
  const totalRev   = variants.reduce((a, v) => a + v.revenue, 0);
  const minDays    = variants
    .map(v => v.days_left)
    .filter(d => d !== null)
    .reduce((a, b) => a === null ? b : Math.min(a, b), null);

  return {
    id:          String(p.id),
    nombre:      p.title || "Sin nombre",
    imagen:      p.image?.src || null,
    variants,
    stock_total: totalStock,
    units_sold:  totalUnits,
    revenue:     totalRev,
    days_left:   minDays,
    platform:    "shopify",
  };
}

// ── Handler principal ───────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { uid, action, days: daysRaw } = req.query;
  const days = parseInt(daysRaw) || 30;

  // Obtener credenciales del usuario
  let platform = "tiendanube";
  let storeId, accessToken, shop;

  storeId     = FALLBACK_STORE_ID;
  accessToken = FALLBACK_TOKEN;

  if (uid) {
    try {
      const db   = initAdmin();
      const snap = await db.collection("users").doc(uid).get();
      if (snap.exists) {
        const stores = snap.data().stores || [];
        const tnStore = stores.find(s => s.type === "tiendanube");
        const shStore = stores.find(s => s.type === "shopify");
        if (shStore?.accessToken && shStore?.shop) {
          platform    = "shopify";
          shop        = shStore.shop;
          accessToken = shStore.accessToken;
        } else if (tnStore?.accessToken && tnStore?.storeId) {
          platform    = "tiendanube";
          storeId     = tnStore.storeId;
          accessToken = tnStore.accessToken;
        }
      }
    } catch (e) {
      console.error("[stock] error obteniendo store:", e.message);
    }
  }

  try {
    if (action === "products") {
      // Traer productos + ventas en paralelo
      if (platform === "shopify") {
        const [products, orders] = await Promise.all([
          shFetchAllProducts(shop, accessToken),
          shFetchSales(shop, accessToken, days),
        ]);
        const { map: salesMap, daily } = processSHSales(orders);
        const normalized = products.map(p => normalizeSHProduct(p, salesMap, days));
        return res.status(200).json({
          platform, products: normalized, days,
          total_products: normalized.length,
          total_variants: normalized.reduce((a, p) => a + p.variants.length, 0),
          total_stock:    normalized.reduce((a, p) => a + p.stock_total, 0),
          total_units:    normalized.reduce((a, p) => a + p.units_sold, 0),
          daily_series:   daily,
        });
      } else {
        const [products, orders] = await Promise.all([
          tnFetchAllProducts(storeId, accessToken),
          tnFetchSales(storeId, accessToken, days),
        ]);
        const { map: salesMap, daily } = processTNSales(orders);
        const normalized = products.map(p => normalizeTNProduct(p, salesMap, days));
        return res.status(200).json({
          platform, products: normalized, days,
          total_products: normalized.length,
          total_variants: normalized.reduce((a, p) => a + p.variants.length, 0),
          total_stock:    normalized.reduce((a, p) => a + p.stock_total, 0),
          total_units:    normalized.reduce((a, p) => a + p.units_sold, 0),
          daily_series:   daily,
        });
      }
    }

    return res.status(400).json({ error: "Acción no reconocida" });
  } catch (e) {
    console.error("[stock] error:", e.message);
    return res.status(500).json({ error: e.message });
  }
}
