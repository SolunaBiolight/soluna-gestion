// api/inventory.js
// Módulo Stock / Inventario para Growith.
// Collections: users/{uid}/inventory_items, users/{uid}/inventory_movements
// Campos en user doc: inventory_settings { multiplier, low_days, empty_days, alert_email }

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getValidMLToken } from "./integrations.js";
import { guardUid } from "./_auth.js";

// Con varias cuentas de ML conectadas, las publicaciones/gestión de ML usan la
// cuenta elegida para VENTAS de ML (margenesMlVentas). Vacío = primera (1 solo ML).
async function mlVentasAcc(db, uid) {
  try { const s = await db.collection("users").doc(uid).get(); return String(s.data()?.margenesMlVentas || "") || null; }
  catch(_) { return null; }
}

// Fetch a la API de Mercado Libre con el token del seller. Devuelve el JSON
// parseado; si la respuesta no es 2xx lanza un Error con el mensaje de ML (para
// que el caller lo devuelva como 502 con detalle). Base URL fija api.mercadolibre.com.
async function mlApi(accessToken, path, { method = "GET", body = null } = {}) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  if (body != null) headers["Content-Type"] = "application/json";
  const r = await fetch(`https://api.mercadolibre.com${path}`, {
    method, headers, ...(body != null ? { body: JSON.stringify(body) } : {}),
  });
  const txt = await r.text();
  let data; try { data = txt ? JSON.parse(txt) : {}; } catch(_) { data = { raw: txt }; }
  if (!r.ok) { const e = new Error(data.message || data.error || `ML HTTP ${r.status}`); e.status = r.status; e.ml = data; throw e; }
  return data;
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

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const SETTINGS_DEFAULTS = {
  multiplier: 1,
  low_days: 14,       // sincronizado con alert_global — un solo umbral en toda la sección
  empty_days: 5,
  alert_email: false,
  alert_global: 14,   // días de stock bajo el cual un producto está "crítico"
  alert_config: {},   // { [productId]: { threshold, enabled } } — overrides por producto
  lead_times: {},     // { [productId]: días } — demora del proveedor
  notif: { email: "", whatsapp: "", enabled: false },
  sync_mode: "off",       // "off" | "simulacion" | "on" — stock cruzado: escribir stock en TN/ML
  sync_ml_separado: false, // true = ML fuera del pool (ni descuenta ventas ML ni escribe en ML)
};

async function getSettings(db, uid) {
  const snap = await db.collection("users").doc(uid).get();
  const s = snap.data()?.inventory_settings || {};
  return { ...SETTINGS_DEFAULTS, ...s, notif: { ...SETTINGS_DEFAULTS.notif, ...(s.notif || {}) } };
}

function computeStatus(stock, sales30d, settings) {
  const salesPerDay = ((sales30d || 0) / 30) * (settings.multiplier || 1);
  if (salesPerDay <= 0) return { days_left: null, status: stock > 0 ? "ok" : "empty" };
  const days_left = Math.floor((stock || 0) / salesPerDay);
  let status = "ok";
  if (days_left <= (settings.empty_days || 5)) status = "empty";
  else if (days_left <= (settings.alert_global || settings.low_days || 14)) status = "low";
  return { days_left, status };
}

async function logMovement(db, uid, mov) {
  // ts normalizado a UTC ISO: cada plataforma manda la fecha con timezone distinto
  // (TN +0000, Shopify -03:00, ML -04:00) y el orderBy("ts") de Firestore compara
  // TEXTO → el historial de movimientos quedaba desordenado. Canonizamos acá,
  // el único punto de entrada.
  const rawTs = mov.ts || new Date().toISOString();
  const tMs = Date.parse(rawTs);
  await db.collection("users").doc(uid).collection("inventory_movements").add({
    ...mov,
    ts: isNaN(tMs) ? String(rawTs) : new Date(tMs).toISOString(),
  });
}

// ── STOCK CRUZADO: escribir el stock central en las plataformas ──────────────
// Modo "simulacion": calcula y loguea qué escribiría, sin tocar nada.
// Modo "on": escribe de verdad. Cada intento queda en users/{uid}/stock_sync_log.
const normSku = s => String(s || "").trim().toUpperCase();

async function syncLog(db, uid, entry) {
  try {
    await db.collection("users").doc(uid).collection("stock_sync_log").add({ ...entry, ts: new Date().toISOString() });
  } catch (_) {}
}

// TN: el stock vive por variante → buscamos la variante cuyo SKU coincide con el
// del item (o la única, si el producto tiene una sola). Nunca adivinamos.
async function pushTN(db, uid, tn, link, item, stock, mode) {
  const pid = link.product_id.replace(/^TN-/, "");
  const base = { item_id: item.id, item_name: item.nombre, link_id: link.product_id, platform: "tiendanube", to_qty: stock, mode };
  const r = await fetch(`https://api.tiendanube.com/v1/${tn.storeId}/products/${pid}/variants`, {
    headers: { "Authentication": `bearer ${tn.accessToken}`, "User-Agent": "GrowithApp" }, signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) { const e = { ...base, ok: false, error: `TN HTTP ${r.status}${r.status===401||r.status===403?" — reconectá Tienda Nube (falta permiso de escritura)":""}` }; await syncLog(db, uid, e); return e; }
  const variants = await r.json();
  if (!Array.isArray(variants) || variants.length === 0) { const e = { ...base, ok: false, error: "Producto TN sin variantes" }; await syncLog(db, uid, e); return e; }
  let v = variants.find(x => normSku(x.sku) === normSku(item.sku) && normSku(item.sku));
  if (!v && variants.length === 1) v = variants[0];
  if (!v) { const e = { ...base, ok: false, error: `Producto TN con ${variants.length} variantes y ninguna coincide con el SKU "${item.sku||"(vacío)"}" — no se toca` }; await syncLog(db, uid, e); return e; }
  const from = v.stock == null ? null : parseInt(v.stock);
  if (from === stock) { const e = { ...base, from_qty: from, ok: true, skipped: true }; return e; } // ya está igual, ni log
  if (mode === "simulacion") { const e = { ...base, from_qty: from, ok: true, simulated: true }; await syncLog(db, uid, e); return e; }
  const w = await fetch(`https://api.tiendanube.com/v1/${tn.storeId}/products/${pid}/variants/${v.id}`, {
    method: "PUT", headers: { "Authentication": `bearer ${tn.accessToken}`, "User-Agent": "GrowithApp", "Content-Type": "application/json" },
    body: JSON.stringify({ stock }), signal: AbortSignal.timeout(12000),
  });
  if (!w.ok) { const txt = await w.text().catch(()=>""); const e = { ...base, from_qty: from, ok: false, error: `TN PUT ${w.status}: ${txt.slice(0,120)}${w.status===401||w.status===403?" — reconectá TN (permiso de escritura)":""}` }; await syncLog(db, uid, e); return e; }
  const e = { ...base, from_qty: from, ok: true }; await syncLog(db, uid, e); return e;
}

// ML: sin variaciones → available_quantity directo; con variaciones → la que
// coincide por SKU (seller_custom_field / SELLER_SKU) o la única.
async function pushML(db, uid, link, item, stock, mode) {
  const mlId = link.product_id.replace(/^ML-/, "");
  const base = { item_id: item.id, item_name: item.nombre, link_id: link.product_id, platform: "mercadolibre", to_qty: stock, mode };
  const tokenInfo = await getValidMLToken(db, uid, await mlVentasAcc(db, uid));
  if (!tokenInfo?.accessToken) { const e = { ...base, ok: false, error: "Sin token válido de ML — reconectá Mercado Libre" }; await syncLog(db, uid, e); return e; }
  const r = await fetch(`https://api.mercadolibre.com/items/${mlId}?attributes=id,status,available_quantity,variations`, {
    headers: { Authorization: `Bearer ${tokenInfo.accessToken}` }, signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) { const e = { ...base, ok: false, error: `ML HTTP ${r.status}` }; await syncLog(db, uid, e); return e; }
  const it = await r.json();
  if (it.status && it.status !== "active" && it.status !== "paused") { const e = { ...base, ok: false, error: `Publicación ML en estado "${it.status}" — no se toca` }; await syncLog(db, uid, e); return e; }
  const vars = Array.isArray(it.variations) ? it.variations : [];
  let body, from;
  if (vars.length === 0) {
    from = parseInt(it.available_quantity) || 0;
    body = { available_quantity: stock };
  } else {
    let v = vars.find(x => normSku(x.seller_custom_field) === normSku(item.sku) && normSku(item.sku));
    if (!v) v = vars.find(x => (x.attributes||[]).some(a => a.id === "SELLER_SKU" && normSku(a.value_name) === normSku(item.sku)) && normSku(item.sku));
    if (!v && vars.length === 1) v = vars[0];
    if (!v) { const e = { ...base, ok: false, error: `Publicación ML con ${vars.length} variantes y ninguna coincide con el SKU "${item.sku||"(vacío)"}" — no se toca` }; await syncLog(db, uid, e); return e; }
    from = parseInt(v.available_quantity) || 0;
    body = { variations: [{ id: v.id, available_quantity: stock }] };
  }
  if (from === stock) { return { ...base, from_qty: from, ok: true, skipped: true }; }
  if (mode === "simulacion") { const e = { ...base, from_qty: from, ok: true, simulated: true }; await syncLog(db, uid, e); return e; }
  const w = await fetch(`https://api.mercadolibre.com/items/${mlId}`, {
    method: "PUT", headers: { Authorization: `Bearer ${tokenInfo.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
  });
  if (!w.ok) { const txt = await w.text().catch(()=>""); const e = { ...base, from_qty: from, ok: false, error: `ML PUT ${w.status}: ${txt.slice(0,120)}${w.status===403?" — habilitá 'Publicación y sincronización' en tu app de ML y reconectá":""}` }; await syncLog(db, uid, e); return e; }
  const e = { ...base, from_qty: from, ok: true }; await syncLog(db, uid, e); return e;
}

// Shopify: variante por SKU (o la única) → inventory_levels/set con la primera
// location activa de la tienda. Requiere write_inventory en el token.
const _shLocCache = {}; // { [shop]: {id, ts} } — la location no cambia entre pushes
async function pushShopify(db, uid, sh, link, item, stock, mode) {
  const pid = link.product_id.replace(/^SH-/, "");
  const base = { item_id: item.id, item_name: item.nombre, link_id: link.product_id, platform: "shopify", to_qty: stock, mode };
  const H = { "X-Shopify-Access-Token": sh.accessToken, "Content-Type": "application/json" };
  const SHB = `https://${sh.shop}/admin/api/2024-10`;
  const r = await fetch(`${SHB}/products/${pid}.json?fields=id,variants`, { headers: H, signal: AbortSignal.timeout(12000) });
  if (!r.ok) { const e = { ...base, ok: false, error: `Shopify HTTP ${r.status}${r.status===401||r.status===403?" — reconectá Shopify (falta permiso)":""}` }; await syncLog(db, uid, e); return e; }
  const variants = (await r.json())?.product?.variants || [];
  if (!variants.length) { const e = { ...base, ok: false, error: "Producto Shopify sin variantes" }; await syncLog(db, uid, e); return e; }
  let v = variants.find(x => normSku(x.sku) === normSku(item.sku) && normSku(item.sku));
  if (!v && variants.length === 1) v = variants[0];
  if (!v) { const e = { ...base, ok: false, error: `Producto Shopify con ${variants.length} variantes y ninguna coincide con el SKU "${item.sku||"(vacío)"}" — no se toca` }; await syncLog(db, uid, e); return e; }
  const from = v.inventory_quantity == null ? null : parseInt(v.inventory_quantity);
  if (from === stock) return { ...base, from_qty: from, ok: true, skipped: true };
  if (mode === "simulacion") { const e = { ...base, from_qty: from, ok: true, simulated: true }; await syncLog(db, uid, e); return e; }
  if (!v.inventory_item_id) { const e = { ...base, from_qty: from, ok: false, error: "La variante no tiene inventory_item_id (¿inventario no trackeado en Shopify?)" }; await syncLog(db, uid, e); return e; }
  // Location activa (cache 10 min por tienda: no cambia entre pushes del lote)
  let loc = _shLocCache[sh.shop];
  if (!loc || Date.now() - loc.ts > 10 * 60000) {
    const lr = await fetch(`${SHB}/locations.json`, { headers: H, signal: AbortSignal.timeout(12000) });
    if (!lr.ok) { const e = { ...base, from_qty: from, ok: false, error: `Shopify locations HTTP ${lr.status}` }; await syncLog(db, uid, e); return e; }
    const locs = (await lr.json())?.locations || [];
    const activa = locs.find(l => l.active) || locs[0];
    if (!activa) { const e = { ...base, from_qty: from, ok: false, error: "La tienda Shopify no tiene locations" }; await syncLog(db, uid, e); return e; }
    loc = { id: activa.id, ts: Date.now() };
    _shLocCache[sh.shop] = loc;
  }
  const w = await fetch(`${SHB}/inventory_levels/set.json`, {
    method: "POST", headers: H,
    body: JSON.stringify({ location_id: loc.id, inventory_item_id: v.inventory_item_id, available: stock }),
    signal: AbortSignal.timeout(12000),
  });
  if (!w.ok) { const txt = await w.text().catch(()=>""); const e = { ...base, from_qty: from, ok: false, error: `Shopify POST ${w.status}: ${txt.slice(0,120)}${w.status===401||w.status===403?" — el token no tiene write_inventory: desvinculá y volvé a conectar Shopify autorizando ese permiso":""}` }; await syncLog(db, uid, e); return e; }
  const e = { ...base, from_qty: from, ok: true }; await syncLog(db, uid, e); return e;
}

// Empuja el stock de UN item a todas sus publicaciones vinculadas (según settings).
async function pushItemStock(db, uid, item, stores, settings) {
  const results = [];
  const mode = settings.sync_mode || "off";
  if (mode === "off") return results;
  const stock = Math.max(0, parseInt(item.stock_total) || 0);
  for (const link of (item.product_links || [])) {
    if (link.sync === false) continue; // excluida por el usuario
    try {
      if (link.platform === "tiendanube") {
        const tn = stores.find(s => s.type === "tiendanube");
        if (tn?.accessToken && tn?.storeId) results.push(await pushTN(db, uid, tn, link, item, stock, mode));
      } else if (link.platform === "mercadolibre") {
        if (settings.sync_ml_separado) continue;
        results.push(await pushML(db, uid, link, item, stock, mode));
      } else if (link.platform === "shopify") {
        const sh = stores.find(s => s.type === "shopify");
        if (sh?.accessToken && sh?.shop) results.push(await pushShopify(db, uid, sh, link, item, stock, mode));
      }
    } catch (e) {
      const err = { item_id: item.id, item_name: item.nombre, link_id: link.product_id, platform: link.platform, to_qty: stock, mode, ok: false, error: e.message };
      await syncLog(db, uid, err); results.push(err);
    }
  }
  return results;
}

export default async function handler(req, res) {
  { const _o=String(req.headers.origin||""); res.setHeader("Access-Control-Allow-Origin", (["https://www.growithapp.com","https://growithapp.com","https://soluna-gestion.vercel.app"].includes(_o)||_o.endsWith("-soluna1.vercel.app")||_o.startsWith("http://localhost"))?_o:"https://www.growithapp.com"); } // allowlist CORS
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, PATCH");
  // El front manda el ID token de Firebase — sin Authorization acá el preflight
  // del browser corta la request antes de que llegue al handler.
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end(); // el preflight nunca lleva credenciales

  const { action, uid } = req.query;
  if (!uid) return res.status(401).json({ error: "Falta uid" });

  // Autorización multi-tenant: el uid solo no prueba nada. Este guard cubre TODAS
  // las acciones del handler — lectura (list_items, stats, settings_get, …) y sobre
  // todo escritura (adjust_stock, save_item, delete_item, sync_push_all,
  // ml_bulk_update, ml_item_update/pictures, …), que además escriben en TN/ML.
  if (!(await guardUid(req, res, uid))) return;

  const db = initAdmin();

  try {
    // ── LIST ITEMS con KPIs, status y sales_30d calculados desde movements ──
    if (action === "list_items" && req.method === "GET") {
      const snap = await db.collection("users").doc(uid).collection("inventory_items").get();
      const settings = await getSettings(db, uid);

      // Calcular sales_30d agrupando movements de ventas de los últimos 30 días
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
      const movSnap = await db.collection("users").doc(uid).collection("inventory_movements")
        .where("ts", ">=", cutoff).get();
      const sales30dByItem = {};
      for (const m of movSnap.docs) {
        const md = m.data();
        if (md.change < 0 && md.source !== "manual") {
          sales30dByItem[md.item_id] = (sales30dByItem[md.item_id] || 0) + Math.abs(md.change);
        }
      }

      const items = snap.docs.map(d => {
        const data = d.data();
        // Defensive clamp: si hay datos viejos con stock_total negativo (por bugs anteriores),
        // los mostramos como 0 al user. El valor en Firestore queda hasta que el user lo edite.
        const stockClean = Math.max(0, data.stock_total || 0);
        const sbwClean = Object.fromEntries(Object.entries(data.stock_by_warehouse || {}).map(([k,v]) => [k, Math.max(0, parseInt(v) || 0)]));
        const sales_30d = sales30dByItem[d.id] || 0;
        const { days_left, status } = computeStatus(stockClean, sales_30d, settings);
        return { id: d.id, ...data, stock_total: stockClean, stock_by_warehouse: sbwClean, sales_30d, days_left, status };
      });
      items.sort((a, b) => (a.status === "empty" ? -1 : 1) - (b.status === "empty" ? -1 : 1));
      const kpis = {
        total: items.length,
        ok: items.filter(i => i.status === "ok").length,
        low: items.filter(i => i.status === "low").length,
        empty: items.filter(i => i.status === "empty").length,
      };
      return res.json({ items, kpis, settings });
    }

    // ── LIST PLATFORM PRODUCTS — todas las publicaciones de TN/Shopify/ML conectadas ──
    if (action === "list_platform_products" && req.method === "GET") {
      const platform = req.query.platform || "all";
      const userSnap = await db.collection("users").doc(uid).get();
      const stores = userSnap.data()?.stores || [];
      const products = [];
      const errors = []; // mensajes por plataforma para mostrar en UI

      // TN
      if (platform === "all" || platform === "tiendanube") {
        const tn = stores.find(s => s.type === "tiendanube");
        if (tn?.accessToken && tn?.storeId) {
          let tnFailed = false, tnFirstError = null;
          for (let page = 1; page <= 5; page++) {
            try {
              const r = await fetch(`https://api.tiendanube.com/v1/${tn.storeId}/products?per_page=200&page=${page}`, {
                headers: { "Authentication": `bearer ${tn.accessToken}`, "User-Agent": "GrowithApp (contacto.growith@gmail.com)" },
              });
              if (!r.ok) {
                const txt = await r.text().catch(()=>"");
                tnFailed = page === 1;
                tnFirstError = `HTTP ${r.status}: ${txt.slice(0, 150)}`;
                break;
              }
              const batch = await r.json();
              if (!Array.isArray(batch) || batch.length === 0) break;
              for (const p of batch) {
                const titleObj = p.name || {};
                const title = typeof titleObj === "string" ? titleObj : (titleObj.es || titleObj.en || Object.values(titleObj)[0] || "(sin nombre)");
                products.push({
                  id: `TN-${p.id}`,
                  platform: "tiendanube",
                  platform_label: "TN",
                  title,
                  sku: p.variants?.[0]?.sku || "",
                  image: p.images?.[0]?.src || null,
                  price: parseFloat(p.variants?.[0]?.price) || 0,
                });
              }
              if (batch.length < 200) break;
            } catch (e) {
              tnFailed = page === 1;
              tnFirstError = e.message;
              break;
            }
          }
          if (tnFailed) errors.push({ platform: "tiendanube", error: tnFirstError });
        }
      }

      // Shopify
      if (platform === "all" || platform === "shopify") {
        const sh = stores.find(s => s.type === "shopify");
        if (sh?.accessToken && sh?.shop) {
          let pageInfoUrl = `https://${sh.shop}/admin/api/2024-10/products.json?limit=250`;
          let shFailed = false, shFirstError = null;
          for (let i = 0; i < 4 && pageInfoUrl; i++) {
            try {
              const r = await fetch(pageInfoUrl, { headers: { "X-Shopify-Access-Token": sh.accessToken } });
              if (!r.ok) {
                const txt = await r.text().catch(()=>"");
                shFailed = i === 0;
                shFirstError = `HTTP ${r.status}: ${txt.slice(0, 200)}`;
                if (r.status === 403 || r.status === 401) {
                  shFirstError = "Falta el scope read_products en el token de Shopify. Desvinculá y volvé a conectar Shopify para autorizar el nuevo permiso.";
                }
                break;
              }
              const data = await r.json();
              for (const p of (data.products || [])) {
                products.push({
                  id: `SH-${p.id}`,
                  platform: "shopify",
                  platform_label: "SH",
                  title: p.title,
                  sku: p.variants?.[0]?.sku || "",
                  image: p.image?.src || null,
                  price: parseFloat(p.variants?.[0]?.price) || 0,
                });
              }
              const linkHeader = r.headers.get("link") || "";
              const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
              pageInfoUrl = nextMatch ? nextMatch[1] : null;
            } catch (e) {
              shFailed = i === 0;
              shFirstError = e.message;
              break;
            }
          }
          if (shFailed) errors.push({ platform: "shopify", error: shFirstError });
        }
      }

      // ML
      if (platform === "all" || platform === "mercadolibre") {
        const ml = stores.find(s => s.type === "mercadolibre");
        if (ml?.userId) {
          try {
            const tokenInfo = await getValidMLToken(db, uid, await mlVentasAcc(db, uid));
            if (!tokenInfo?.accessToken) {
              errors.push({ platform: "mercadolibre", error: "No se pudo obtener un access_token válido (probá reconectar ML)." });
            } else {
              let mlFailed = false, mlFirstError = null;
              for (let offset = 0; offset < 500; offset += 50) {
                const idsRes = await fetch(`https://api.mercadolibre.com/users/${tokenInfo.userId}/items/search?status=active&limit=50&offset=${offset}`, {
                  headers: { Authorization: `Bearer ${tokenInfo.accessToken}` },
                });
                if (!idsRes.ok) {
                  const txt = await idsRes.text().catch(()=>"");
                  mlFailed = offset === 0;
                  // Detectar error de permisos de la app ML (no del token)
                  if (idsRes.status === 403 && (txt.includes("PolicyAgent") || txt.includes("UNAUTHORIZED"))) {
                    mlFirstError = "Tu app de Mercado Libre no tiene el permiso 'Publicación y sincronización'. Entrá a developers.mercadolibre.com → tu app → editar → Permisos → marcá 'Publicación y sincronización' (Lectura) → Guardar. Después reconectá ML en Config.";
                  } else if (idsRes.status === 401) {
                    mlFirstError = "El token de ML expiró o no es válido. Reconectá Mercado Libre desde Config.";
                  } else {
                    mlFirstError = `HTTP ${idsRes.status}: ${txt.slice(0, 200)}`;
                  }
                  break;
                }
                const idsData = await idsRes.json();
                const ids = idsData.results || [];
                if (ids.length === 0) break;
                const detailsRes = await fetch(`https://api.mercadolibre.com/items?ids=${ids.join(",")}&attributes=id,title,thumbnail,price,seller_custom_field`, {
                  headers: { Authorization: `Bearer ${tokenInfo.accessToken}` },
                });
                if (!detailsRes.ok) {
                  const txt = await detailsRes.text().catch(()=>"");
                  mlFailed = offset === 0;
                  mlFirstError = `HTTP ${detailsRes.status} (details): ${txt.slice(0, 200)}`;
                  break;
                }
                const details = await detailsRes.json();
                for (const d of details) {
                  if (d.body) {
                    products.push({
                      id: `ML-${d.body.id}`,
                      platform: "mercadolibre",
                      platform_label: "ML",
                      title: d.body.title,
                      sku: d.body.seller_custom_field || "",
                      image: d.body.thumbnail,
                      price: parseFloat(d.body.price) || 0,
                    });
                  }
                }
                if (ids.length < 50) break;
              }
              if (mlFailed) errors.push({ platform: "mercadolibre", error: mlFirstError });
            }
          } catch (e) {
            errors.push({ platform: "mercadolibre", error: e.message });
          }
        }
      }

      return res.json({ products, errors });
    }

    // ── SYNC SALES — recorre ordenes recientes, descuenta stock de items vinculados ──
    if (action === "sync_sales" && req.method === "POST") {
      const itemsSnap = await db.collection("users").doc(uid).collection("inventory_items").get();
      const items = itemsSnap.docs.map(d => ({ ref: d.ref, ...d.data() }));
      // Un item se descuenta si tiene product_links (vínculo explícito por producto)
      // O un SKU — el SKU es la MISMA llave con la que la UI vincula item↔producto,
      // así una venta descuenta aunque el item nunca haya sido "linkeado" a mano.
      const linkedItems = items.filter(i => (Array.isArray(i.product_links) && i.product_links.length > 0) || String(i.sku || "").trim());
      if (linkedItems.length === 0) return res.json({ ok: true, processed_orders: 0, items_updated: 0 });

      const settings = await getSettings(db, uid);
      const userSnap = await db.collection("users").doc(uid).get();
      const stores = userSnap.data()?.stores || [];

      // Acumular órdenes recientes de las plataformas
      const recentOrders = [];
      const sinceISO = new Date(Date.now() - 30 * 86400000).toISOString();
      const sinceDate = sinceISO.slice(0, 10);

      // TN
      const tn = stores.find(s => s.type === "tiendanube");
      if (tn?.accessToken && tn?.storeId) {
        for (let page = 1; page <= 5; page++) {
          try {
            const r = await fetch(`https://api.tiendanube.com/v1/${tn.storeId}/orders?per_page=200&page=${page}&payment_status=paid&created_at_min=${sinceDate}`, {
              headers: { "Authentication": `bearer ${tn.accessToken}`, "User-Agent": "GrowithApp" },
            });
            if (!r.ok) break;
            const batch = await r.json();
            if (!Array.isArray(batch) || batch.length === 0) break;
            for (const o of batch) {
              if ((o.status || "").toLowerCase() === "cancelled") continue;
              recentOrders.push({
                order_id: `TN-ORD-${o.id}`,
                platform: "tiendanube",
                ts: o.paid_at || o.created_at,
                products: (o.products || []).map(p => ({ id: `TN-${p.product_id || p.id}`, sku: p.sku || "", quantity: parseInt(p.quantity) || 1 })),
              });
            }
            if (batch.length < 200) break;
          } catch (e) { break; }
        }
      }

      // Shopify
      const sh = stores.find(s => s.type === "shopify");
      if (sh?.accessToken && sh?.shop) {
        let pageInfoUrl = `https://${sh.shop}/admin/api/2024-10/orders.json?status=any&financial_status=paid&limit=250&created_at_min=${sinceISO}`;
        for (let i = 0; i < 4 && pageInfoUrl; i++) {
          try {
            const r = await fetch(pageInfoUrl, { headers: { "X-Shopify-Access-Token": sh.accessToken } });
            if (!r.ok) break;
            const data = await r.json();
            for (const o of (data.orders || [])) {
              if (o.cancelled_at) continue;
              if ((o.financial_status || "").toLowerCase() !== "paid") continue;
              recentOrders.push({
                order_id: `SH-ORD-${o.id}`,
                platform: "shopify",
                ts: o.processed_at || o.created_at,
                products: (o.line_items || []).map(li => ({ id: `SH-${li.product_id}`, sku: li.sku || "", quantity: parseInt(li.quantity) || 1 })),
              });
            }
            const linkHeader = r.headers.get("link") || "";
            const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
            pageInfoUrl = nextMatch ? nextMatch[1] : null;
          } catch (e) { break; }
        }
      }

      // ML — si el cliente maneja el stock de ML por separado, sus ventas no
      // descuentan del inventario central.
      const ml = stores.find(s => s.type === "mercadolibre");
      if (ml?.userId && !settings.sync_ml_separado) {
        try {
          const tokenInfo = await getValidMLToken(db, uid, await mlVentasAcc(db, uid));
          if (tokenInfo?.accessToken) {
            const untilISO = new Date().toISOString();
            for (let offset = 0; offset < 500; offset += 50) {
              const r = await fetch(`https://api.mercadolibre.com/orders/search?seller=${tokenInfo.userId}&order.status=paid&order.date_created.from=${sinceISO}&order.date_created.to=${untilISO}&limit=50&offset=${offset}&sort=date_desc`, {
                headers: { Authorization: `Bearer ${tokenInfo.accessToken}` },
              });
              if (!r.ok) break;
              const data = await r.json();
              const orders = data.results || [];
              for (const o of orders) {
                if (["cancelled", "invalid"].includes((o.status || "").toLowerCase())) continue;
                recentOrders.push({
                  order_id: `ML-ORD-${o.id}`,
                  platform: "mercadolibre",
                  ts: o.date_closed || o.date_created,
                  products: (o.order_items || []).map(it => ({ id: `ML-${it.item?.id}`, sku: it.item?.seller_sku || it.item?.seller_custom_field || "", quantity: parseInt(it.quantity) || 1 })),
                });
              }
              if (orders.length < 50) break;
            }
          }
        } catch (e) { /* ignorar */ }
      }

      // Procesar cada item con links y descontar
      let itemsUpdated = 0;
      let salesLogged = 0;
      for (const item of linkedItems) {
        const linkMap = new Map((item.product_links || []).map(l => [l.product_id, parseInt(l.quantity) || 1]));
        const itemSku = String(item.sku || "").trim().toUpperCase();
        const processed = new Set(item.processed_orders || []);
        // Baseline: el stock que fijaste a mano ya refleja las ventas de ANTES. Solo
        // las ventas posteriores al baseline descuentan (evita doble conteo).
        const baselineMs = item.stock_baseline_at ? Date.parse(item.stock_baseline_at) : 0;
        let stockChange = 0;
        const newProcessed = [];

        for (const ord of recentOrders) {
          if (processed.has(ord.order_id)) continue;
          if (baselineMs && ord.ts) { const t = Date.parse(ord.ts); if (isFinite(t) && t <= baselineMs) continue; }
          let unitsForItem = 0;
          for (const prod of ord.products) {
            // 1) Vínculo explícito por product_id (prioridad). 2) Fallback por SKU
            //    (misma llave que usa la UI) — así descuenta aunque no esté linkeado.
            const linkedQty = linkMap.get(prod.id);
            if (linkedQty) { unitsForItem += prod.quantity * linkedQty; continue; }
            if (itemSku && String(prod.sku || "").trim().toUpperCase() === itemSku) unitsForItem += prod.quantity;
          }
          if (unitsForItem > 0) {
            const oldStock = (item.stock_total || 0) + stockChange;
            stockChange -= unitsForItem;
            const newStock = oldStock - unitsForItem;
            await logMovement(db, uid, {
              item_id: item.id, item_name: item.nombre,
              change: -unitsForItem,
              old_stock: oldStock, new_stock: Math.max(0, newStock),
              source: ord.platform, event: `venta ${ord.order_id}`,
              ts: ord.ts,
            });
            newProcessed.push(ord.order_id);
            salesLogged++;
          }
        }

        if (stockChange !== 0) {
          const finalStock = Math.max(0, (item.stock_total || 0) + stockChange);
          const allProcessed = Array.from(new Set([...(item.processed_orders || []), ...newProcessed])).slice(-2000);
          await item.ref.update({
            stock_total: finalStock,
            processed_orders: allProcessed,
            last_sync_at: new Date().toISOString(),
          });
          itemsUpdated++;
          // Stock cruzado: propagar el nuevo stock a las plataformas (best-effort)
          try { await pushItemStock(db, uid, { ...item, stock_total: finalStock }, stores, settings); } catch (_) {}
        } else if (newProcessed.length === 0 && !item.last_sync_at) {
          // primer sync sin ventas — solo marcamos timestamp
          await item.ref.update({ last_sync_at: new Date().toISOString() });
        }
      }

      return res.json({ ok: true, processed_orders: recentOrders.length, items_updated: itemsUpdated, sales_logged: salesLogged });
    }

    // ── IMPORT CATALOG — crea/vincula items desde el catálogo TN/Shopify/ML por SKU ──
    // Agrupa las publicaciones por SKU: un item de inventario por SKU, vinculado a
    // todas las publicaciones que lo comparten (unificación multicanal). Sin SKU,
    // crea un item por publicación. Nunca pisa el stock de items existentes.
    if (action === "import_catalog" && req.method === "POST") {
      const userSnap = await db.collection("users").doc(uid).get();
      const stores = userSnap.data()?.stores || [];
      const catalog = []; // {link_id, platform, title, sku, image, stock, price}

      // TN — stock = suma de variantes (null = infinito en TN, se toma 0)
      const tn = stores.find(s => s.type === "tiendanube");
      if (tn?.accessToken && tn?.storeId) {
        for (let page = 1; page <= 5; page++) {
          try {
            const r = await fetch(`https://api.tiendanube.com/v1/${tn.storeId}/products?per_page=200&page=${page}`, {
              headers: { "Authentication": `bearer ${tn.accessToken}`, "User-Agent": "GrowithApp" },
            });
            if (!r.ok) break;
            const batch = await r.json();
            if (!Array.isArray(batch) || batch.length === 0) break;
            for (const p of batch) {
              const titleObj = p.name || {};
              const title = typeof titleObj === "string" ? titleObj : (titleObj.es || Object.values(titleObj)[0] || "(sin nombre)");
              const stock = (p.variants || []).reduce((s, v) => s + (v.stock == null ? 0 : (parseInt(v.stock) || 0)), 0);
              catalog.push({ link_id: `TN-${p.id}`, platform: "tiendanube", title, sku: p.variants?.[0]?.sku || "", image: p.images?.[0]?.src || null, stock });
            }
            if (batch.length < 200) break;
          } catch (e) { break; }
        }
      }
      // Shopify
      const sh = stores.find(s => s.type === "shopify");
      if (sh?.accessToken && sh?.shop) {
        let url = `https://${sh.shop}/admin/api/2024-10/products.json?limit=250`;
        for (let i = 0; i < 4 && url; i++) {
          try {
            const r = await fetch(url, { headers: { "X-Shopify-Access-Token": sh.accessToken } });
            if (!r.ok) break;
            const data = await r.json();
            for (const p of (data.products || [])) {
              const stock = (p.variants || []).reduce((s, v) => s + (parseInt(v.inventory_quantity) || 0), 0);
              catalog.push({ link_id: `SH-${p.id}`, platform: "shopify", title: p.title, sku: p.variants?.[0]?.sku || "", image: p.image?.src || null, stock });
            }
            const next = (r.headers.get("link") || "").match(/<([^>]+)>;\s*rel="next"/);
            url = next ? next[1] : null;
          } catch (e) { break; }
        }
      }
      // ML — available_quantity de cada publicación activa
      const ml = stores.find(s => s.type === "mercadolibre");
      if (ml?.userId) {
        try {
          const tokenInfo = await getValidMLToken(db, uid, await mlVentasAcc(db, uid));
          if (tokenInfo?.accessToken) {
            for (let offset = 0; offset < 500; offset += 50) {
              const idsRes = await fetch(`https://api.mercadolibre.com/users/${tokenInfo.userId}/items/search?status=active&limit=50&offset=${offset}`, {
                headers: { Authorization: `Bearer ${tokenInfo.accessToken}` },
              });
              if (!idsRes.ok) break;
              const ids = (await idsRes.json()).results || [];
              if (ids.length === 0) break;
              const detRes = await fetch(`https://api.mercadolibre.com/items?ids=${ids.join(",")}&attributes=id,title,thumbnail,available_quantity,seller_custom_field`, {
                headers: { Authorization: `Bearer ${tokenInfo.accessToken}` },
              });
              if (!detRes.ok) break;
              for (const d of (await detRes.json())) {
                if (d.body) catalog.push({ link_id: `ML-${d.body.id}`, platform: "mercadolibre", title: d.body.title, sku: d.body.seller_custom_field || "", image: d.body.thumbnail, stock: parseInt(d.body.available_quantity) || 0 });
              }
              if (ids.length < 50) break;
            }
          }
        } catch (e) { /* ML opcional */ }
      }

      if (catalog.length === 0) return res.json({ ok: true, created: 0, linked: 0, unchanged: 0, catalog: 0 });

      // Agrupar por SKU normalizado (sin SKU → grupo propio por publicación)
      const norm = s => String(s || "").trim().toUpperCase();
      const groups = new Map();
      for (const c of catalog) {
        const key = norm(c.sku) || `__nosku__${c.link_id}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(c);
      }

      const itemsSnap = await db.collection("users").doc(uid).collection("inventory_items").get();
      const existing = itemsSnap.docs.map(d => ({ ref: d.ref, id: d.id, ...d.data() }));
      const bySku = new Map(existing.filter(i => norm(i.sku)).map(i => [norm(i.sku), i]));
      const byLink = new Map();
      for (const i of existing) for (const l of (i.product_links || [])) byLink.set(l.product_id, i);

      const PLAT_ORDER = { tiendanube: 0, shopify: 1, mercadolibre: 2 };
      let created = 0, linked = 0, unchanged = 0;
      for (const [key, group] of groups) {
        group.sort((a, b) => (PLAT_ORDER[a.platform] ?? 9) - (PLAT_ORDER[b.platform] ?? 9));
        const primary = group[0];
        const item = (!key.startsWith("__nosku__") && bySku.get(key)) || group.map(g => byLink.get(g.link_id)).find(Boolean);
        if (item) {
          // Item existente: solo agregar links faltantes y completar sku/canales. NO tocar stock.
          const links = [...(item.product_links || [])];
          const have = new Set(links.map(l => l.product_id));
          let changed = false;
          for (const g of group) {
            if (!have.has(g.link_id)) { links.push({ product_id: g.link_id, platform: g.platform, title: g.title, image: g.image, quantity: 1 }); changed = true; }
          }
          const canales = Array.from(new Set([...(item.canales || []), ...group.map(g => g.platform)]));
          const skuFix = !norm(item.sku) && !key.startsWith("__nosku__") ? { sku: primary.sku } : {};
          if (changed || canales.length !== (item.canales || []).length || skuFix.sku) {
            await item.ref.update({ product_links: links, canales, ...skuFix, updated_at: new Date().toISOString() });
            linked++;
          } else unchanged++;
        } else {
          // Item nuevo: stock inicial = stock de la plataforma primaria (TN > SH > ML)
          const itemsCol = db.collection("users").doc(uid).collection("inventory_items");
          const id = itemsCol.doc().id;
          const stock = Math.max(0, primary.stock || 0);
          const data = {
            id, nombre: String(primary.title).slice(0, 200), sku: key.startsWith("__nosku__") ? "" : primary.sku,
            image: primary.image || null, stock_total: stock, stock_by_warehouse: stock ? { main: stock } : {},
            canales: Array.from(new Set(group.map(g => g.platform))),
            product_links: group.map(g => ({ product_id: g.link_id, platform: g.platform, title: g.title, image: g.image, quantity: 1 })),
            processed_orders: [], last_sync_at: null,
            created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          };
          await itemsCol.doc(id).set(data);
          await logMovement(db, uid, { item_id: id, item_name: data.nombre, change: stock, old_stock: 0, new_stock: stock, source: "manual", event: "importacion_catalogo" });
          created++;
        }
      }
      return res.json({ ok: true, created, linked, unchanged, catalog: catalog.length });
    }

    // ── DEPOSITOS / WAREHOUSES ──────────────────────────────
    // Cada user tiene N depositos. Cada inventory_item tiene
    // stock_by_warehouse: {warehouseId: stock}. stock_total = sum.

    if (action === "warehouses_list" && req.method === "GET") {
      const snap = await db.collection("users").doc(uid).collection("warehouses").get();
      // Excluimos el legacy id="main" (Depósito principal autogenerado) — el cliente
      // sólo debe ver los depósitos que crea. El stock que esté ahí sigue contado en
      // stock_total del item, no se pierde nada; sólo deja de mostrarse como card.
      const warehouses = snap.docs
        .filter(d => d.id !== "main")
        .map(d => ({ id: d.id, ...d.data() }));
      warehouses.sort((a,b) => (a.created_at || "").localeCompare(b.created_at || ""));
      return res.json({ warehouses });
    }

    if (action === "warehouse_save" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      const { id, name, address, is_default } = body || {};
      if (!name?.trim()) return res.status(400).json({ error: "Falta nombre" });
      const col = db.collection("users").doc(uid).collection("warehouses");
      const whId = id || col.doc().id;
      // Si se marca default, desmarcar los otros
      if (is_default) {
        const snap = await col.get();
        const batch = db.batch();
        for (const d of snap.docs) if (d.id !== whId) batch.update(d.ref, { is_default: false });
        await batch.commit();
      }
      const data = {
        name: String(name).trim().slice(0, 80),
        address: String(address || "").slice(0, 200),
        is_default: Boolean(is_default),
        updated_at: new Date().toISOString(),
        ...(id ? {} : { created_at: new Date().toISOString() }),
      };
      await col.doc(whId).set(data, { merge: true });
      return res.json({ ok: true, id: whId, warehouse: { id: whId, ...data } });
    }

    if (action === "warehouse_delete" && req.method === "DELETE") {
      const whId = req.query.warehouse_id;
      if (!whId) return res.status(400).json({ error: "Falta warehouse_id" });
      // Borramos el depósito. El stock que tuviera queda registrado en el item pero
      // sin depósito asignado — el user puede re-asignarlo después si lo necesita.
      // (Nota: el stock_total del item NO cambia; solo desaparece la clave del map.)
      const itemsSnap = await db.collection("users").doc(uid).collection("inventory_items").get();
      const batch = db.batch();
      for (const itemDoc of itemsSnap.docs) {
        const item = itemDoc.data();
        const sbw = item.stock_by_warehouse || {};
        if (sbw[whId] != null) {
          const newSbw = { ...sbw };
          delete newSbw[whId];
          batch.update(itemDoc.ref, { stock_by_warehouse: newSbw });
        }
      }
      batch.delete(db.collection("users").doc(uid).collection("warehouses").doc(whId));
      await batch.commit();
      return res.json({ ok: true });
    }

    // Ajuste de stock por deposito específico
    if (action === "adjust_warehouse_stock" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      const { item_id, warehouse_id, change, new_stock, event } = body || {};
      if (!item_id || !warehouse_id) return res.status(400).json({ error: "Faltan item_id y warehouse_id" });
      const ref = db.collection("users").doc(uid).collection("inventory_items").doc(item_id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: "Item no encontrado" });
      const current = snap.data();
      const sbw = current.stock_by_warehouse || {};
      const oldWh = sbw[warehouse_id] || 0;
      const newWh = new_stock !== undefined && new_stock !== null
        ? parseInt(new_stock) : oldWh + (parseInt(change) || 0);
      const newSbw = { ...sbw, [warehouse_id]: Math.max(0, newWh) };
      const newTotal = Object.values(newSbw).reduce((s, v) => s + (parseInt(v) || 0), 0);
      await ref.update({ stock_by_warehouse: newSbw, stock_total: newTotal, updated_at: new Date().toISOString() });
      await logMovement(db, uid, {
        item_id, item_name: current.nombre,
        warehouse_id, change: newWh - oldWh,
        old_stock: oldWh, new_stock: newWh,
        source: "manual", event: event || "ajuste_deposito",
      });
      try {
        const settings = await getSettings(db, uid);
        const stores = (await db.collection("users").doc(uid).get()).data()?.stores || [];
        await pushItemStock(db, uid, { ...current, id: item_id, stock_total: newTotal }, stores, settings);
      } catch (_) {}
      return res.json({ ok: true, old_stock: oldWh, new_stock: newWh, new_total: newTotal });
    }

    // ── CREATE/UPDATE ITEM ──────────────────────────────────
    if (action === "save_item" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      if (!body.nombre) return res.status(400).json({ error: "Falta nombre" });

      const itemsCol = db.collection("users").doc(uid).collection("inventory_items");
      const id = body.id || itemsCol.doc().id;
      const existing = body.id ? (await itemsCol.doc(id).get()).data() : null;

      // stock_by_warehouse: {whId: qty}. Si viene en el body, usar; sino,
      // poner todo el stock_total en el deposito default "main".
      const sbw = body.stock_by_warehouse && typeof body.stock_by_warehouse === "object"
        ? Object.fromEntries(Object.entries(body.stock_by_warehouse).map(([k,v]) => [String(k), Math.max(0, parseInt(v) || 0)]))
        : null;
      const stockTotalFromSbw = sbw ? Object.values(sbw).reduce((s,v)=>s+v,0) : Math.max(0, parseInt(body.stock_total) || 0);
      const finalSbw = sbw || (body.stock_total ? { main: Math.max(0, parseInt(body.stock_total)) } : (existing?.stock_by_warehouse || {}));
      const data = {
        id,
        nombre: String(body.nombre).slice(0, 200),
        sku: String(body.sku || "").slice(0, 80),
        image: body.image || null,
        stock_total: stockTotalFromSbw,
        stock_by_warehouse: finalSbw,
        canales: Array.isArray(body.canales) ? body.canales : [],
        // product_links: [{ product_id, platform, title, image, quantity }] — cantidad descuento por venta
        product_links: Array.isArray(body.product_links) ? body.product_links.map(l => ({
          product_id: String(l.product_id || ""),
          platform: String(l.platform || ""),
          title: String(l.title || ""),
          image: l.image || null,
          quantity: parseInt(l.quantity) || 1,
          ...(l.sync === false ? { sync: false } : {}), // excluida del stock cruzado
        })) : (existing?.product_links || []),
        // Mantenemos el set de orders procesadas para no descontar 2 veces
        processed_orders: existing?.processed_orders || [],
        last_sync_at: existing?.last_sync_at || null,
        // "Baseline": cuando fijás el stock a mano, ESE número es la verdad DESDE
        // AHORA. Solo las ventas POSTERIORES lo descuentan — las anteriores ya están
        // reflejadas en el conteo físico que cargaste. Evita el doble conteo y que
        // el número quede congelado. Se re-estampa cada vez que cambia el stock manual.
        stock_baseline_at: (!existing || (existing.stock_total || 0) !== stockTotalFromSbw)
          ? new Date().toISOString()
          : (existing?.stock_baseline_at || null),
        created_at: existing?.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await itemsCol.doc(id).set(data, { merge: true });

      // Log si cambió el stock manualmente
      if (existing && existing.stock_total !== data.stock_total) {
        await logMovement(db, uid, {
          item_id: id, item_name: data.nombre,
          change: data.stock_total - (existing.stock_total || 0),
          old_stock: existing.stock_total || 0,
          new_stock: data.stock_total,
          source: "manual", event: "ajuste_manual",
        });
      } else if (!existing) {
        await logMovement(db, uid, {
          item_id: id, item_name: data.nombre,
          change: data.stock_total, old_stock: 0, new_stock: data.stock_total,
          source: "manual", event: "creacion",
        });
      }

      // Stock cruzado: si cambió el stock, propagar a las plataformas
      let sync_results = [];
      if (!existing || existing.stock_total !== data.stock_total) {
        try {
          const settings = await getSettings(db, uid);
          const stores = (await db.collection("users").doc(uid).get()).data()?.stores || [];
          sync_results = await pushItemStock(db, uid, data, stores, settings);
        } catch (_) {}
      }

      return res.json({ ok: true, item: data, sync_results });
    }

    // ── ADJUST STOCK (suma/resta change, o setea new_stock) ─
    if (action === "adjust_stock" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      const { item_id, new_stock, change, source, event } = body;
      if (!item_id) return res.status(400).json({ error: "Falta item_id" });

      const ref = db.collection("users").doc(uid).collection("inventory_items").doc(item_id);
      // Transacción: un doble click (o retry) con `change` ya no descuenta dos
      // veces — el read-modify-write viejo era carrera abierta y se propagaba a TN/ML.
      let current, oldStock, newStock;
      try {
        ({ current, oldStock, newStock } = await db.runTransaction(async tx => {
          const snap = await tx.get(ref);
          if (!snap.exists) throw new Error("ITEM_INEXISTENTE");
          const cur = snap.data();
          const old = cur.stock_total || 0;
          const nue = new_stock !== undefined && new_stock !== null
            ? parseInt(new_stock)
            : old + (parseInt(change) || 0);
          tx.update(ref, { stock_total: nue, updated_at: new Date().toISOString() });
          return { current: cur, oldStock: old, newStock: nue };
        }));
      } catch (e) {
        if (e.message === "ITEM_INEXISTENTE") return res.status(404).json({ error: "Item no encontrado" });
        throw e;
      }
      await logMovement(db, uid, {
        item_id, item_name: current.nombre,
        change: newStock - oldStock,
        old_stock: oldStock, new_stock: newStock,
        source: source || "manual",
        event: event || "ajuste",
      });
      let sync_results = [];
      try {
        const settings = await getSettings(db, uid);
        const stores = (await db.collection("users").doc(uid).get()).data()?.stores || [];
        sync_results = await pushItemStock(db, uid, { ...current, id: item_id, stock_total: newStock }, stores, settings);
      } catch (_) {}
      return res.json({ ok: true, old_stock: oldStock, new_stock: newStock, sync_results });
    }

    // ── DELETE ITEM ─────────────────────────────────────────
    if (action === "delete_item" && req.method === "DELETE") {
      const item_id = req.query.item_id;
      if (!item_id) return res.status(400).json({ error: "Falta item_id" });
      await db.collection("users").doc(uid).collection("inventory_items").doc(item_id).delete();
      return res.json({ ok: true });
    }

    // ── LIST MOVEMENTS (historial) ──────────────────────────
    if (action === "list_movements" && req.method === "GET") {
      const limit = Math.min(parseInt(req.query.limit) || 200, 500);
      const snap = await db.collection("users").doc(uid).collection("inventory_movements")
        .orderBy("ts", "desc").limit(limit).get();
      const movements = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // Re-orden por instante real: los registros viejos quedaron con ts en
      // timezones mezcladas (TN +0000, Shopify -03:00, ML -04:00) y el orderBy
      // de Firestore los compara como texto. Los nuevos ya entran normalizados
      // a UTC (logMovement), pero el historial existente se ordena acá.
      const tsMs = v => { const t = Date.parse(String(v||"")); return isNaN(t) ? 0 : t; };
      movements.sort((a,b) => tsMs(b.ts) - tsMs(a.ts));
      return res.json({ movements });
    }

    // ── SETTINGS GET / SAVE ─────────────────────────────────
    if (action === "settings_get" && req.method === "GET") {
      const settings = await getSettings(db, uid);
      return res.json({ settings });
    }

    if (action === "settings_save" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      // Merge: solo pisa los campos que vienen en el body (el front puede guardar
      // alertas sin conocer multiplier, y viceversa).
      const current = await getSettings(db, uid);
      const settings = { ...current };
      if (body.multiplier !== undefined) settings.multiplier = parseFloat(body.multiplier) || 1;
      if (body.empty_days !== undefined) settings.empty_days = parseInt(body.empty_days) || 5;
      if (body.alert_email !== undefined) settings.alert_email = !!body.alert_email;
      if (body.alert_global !== undefined || body.low_days !== undefined) {
        // Un solo umbral: alert_global y low_days siempre iguales
        const g = parseInt(body.alert_global ?? body.low_days) || 14;
        settings.alert_global = g;
        settings.low_days = g;
      }
      if (body.alert_config && typeof body.alert_config === "object") settings.alert_config = body.alert_config;
      if (body.lead_times && typeof body.lead_times === "object") settings.lead_times = body.lead_times;
      if (body.notif && typeof body.notif === "object") settings.notif = {
        email: String(body.notif.email || "").slice(0, 120),
        whatsapp: String(body.notif.whatsapp || "").slice(0, 30),
        enabled: !!body.notif.enabled,
      };
      if (body.sync_mode !== undefined) settings.sync_mode = ["off","simulacion","on"].includes(body.sync_mode) ? body.sync_mode : "off";
      if (body.sync_ml_separado !== undefined) settings.sync_ml_separado = !!body.sync_ml_separado;
      await db.collection("users").doc(uid).set({ inventory_settings: settings }, { merge: true });
      return res.json({ ok: true, settings });
    }

    // ── TRANSFER STOCK entre depósitos ──────────────────────
    if (action === "transfer_stock" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      const { item_id, from_id, to_id, qty } = body || {};
      const q = parseInt(qty) || 0;
      if (!item_id || !from_id || !to_id) return res.status(400).json({ error: "Faltan item_id, from_id y to_id" });
      if (from_id === to_id) return res.status(400).json({ error: "Origen y destino son el mismo depósito" });
      if (q <= 0) return res.status(400).json({ error: "La cantidad debe ser mayor a 0" });
      const ref = db.collection("users").doc(uid).collection("inventory_items").doc(item_id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: "Item no encontrado" });
      const item = snap.data();
      const sbw = { ...(item.stock_by_warehouse || {}) };
      const disponible = parseInt(sbw[from_id]) || 0;
      if (q > disponible) return res.status(400).json({ error: `El depósito de origen tiene solo ${disponible} unidades` });
      sbw[from_id] = disponible - q;
      sbw[to_id] = (parseInt(sbw[to_id]) || 0) + q;
      // stock_total no cambia en una transferencia
      await ref.update({ stock_by_warehouse: sbw, updated_at: new Date().toISOString() });
      await logMovement(db, uid, {
        item_id, item_name: item.nombre,
        change: 0, old_stock: item.stock_total || 0, new_stock: item.stock_total || 0,
        warehouse_from: from_id, warehouse_to: to_id, qty: q,
        source: "manual", event: "transferencia_deposito",
      });
      return res.json({ ok: true, stock_by_warehouse: sbw });
    }

    // ── STOCK CRUZADO: empujar TODO el inventario a las plataformas ──
    if (action === "sync_push_all" && req.method === "POST") {
      const settings = await getSettings(db, uid);
      if ((settings.sync_mode || "off") === "off") return res.status(400).json({ error: "El stock cruzado está apagado. Activá Simulación o Activado en Configuración." });
      const itemsSnap = await db.collection("users").doc(uid).collection("inventory_items").get();
      const items = itemsSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(i => (i.product_links || []).length > 0);
      const stores = (await db.collection("users").doc(uid).get()).data()?.stores || [];
      const results = [];
      for (const item of items) {
        results.push(...await pushItemStock(db, uid, item, stores, settings));
      }
      const resumen = {
        total: results.length,
        escritos: results.filter(r => r.ok && !r.simulated && !r.skipped).length,
        simulados: results.filter(r => r.simulated).length,
        sin_cambio: results.filter(r => r.skipped).length,
        errores: results.filter(r => !r.ok).length,
      };
      return res.json({ ok: true, mode: settings.sync_mode, resumen, results });
    }

    // ── STOCK CRUZADO: últimos registros del log ──
    if (action === "sync_log_list" && req.method === "GET") {
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const snap = await db.collection("users").doc(uid).collection("stock_sync_log")
        .orderBy("ts", "desc").limit(limit).get();
      return res.json({ log: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
    }

    // ── STATS para gráfico + ranking ────────────────────────
    // Devuelve ventas agrupadas por día (últimos N días) + top vendidos / no vendidos
    if (action === "stats" && req.method === "GET") {
      const days = Math.min(parseInt(req.query.days) || 30, 365);
      const sinceDate = new Date(Date.now() - days * 86400000);

      // Movimientos negativos (ventas) = source distinto a manual
      const snap = await db.collection("users").doc(uid).collection("inventory_movements")
        .orderBy("ts", "desc").limit(2000).get();

      const byDay = {}; // "YYYY-MM-DD" -> count
      const byItem = {}; // item_id -> {nombre, units, count}

      // Día calendario ARGENTINO del movimiento. Antes: m.ts.slice(0,10) sobre
      // strings con timezone mezclada (TN +0000, Shopify -03:00, ML -04:00) y la
      // serie en días UTC → las ventas de la noche caían en el día equivocado y
      // el recuento diario quedaba corrido.
      const diaAR = (v) => { const t = Date.parse(String(v||"")); if (isNaN(t)) return String(v||"").slice(0,10); return new Intl.DateTimeFormat("en-CA",{timeZone:"America/Argentina/Buenos_Aires"}).format(new Date(t)); };

      for (const d of snap.docs) {
        const m = d.data();
        if (!m.ts || new Date(m.ts) < sinceDate) continue;
        const isSale = m.event === "venta" || (m.change < 0 && m.event !== "ajuste_manual" && m.event !== "ajuste");
        if (!isSale) continue;
        const day = diaAR(m.ts);
        const qty = Math.abs(m.change) || 0;
        byDay[day] = (byDay[day] || 0) + qty;
        if (!byItem[m.item_id]) byItem[m.item_id] = { id: m.item_id, nombre: m.item_name || "(sin nombre)", units: 0, count: 0 };
        byItem[m.item_id].units += qty;
        byItem[m.item_id].count += 1;
      }

      // Serie de tiempo: completar días faltantes con 0 (también en días AR)
      const series = [];
      const today = new Date();
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today.getTime() - i * 86400000);
        const key = diaAR(d.toISOString());
        series.push({ date: key, units: byDay[key] || 0 });
      }

      const ranking = Object.values(byItem).sort((a, b) => b.units - a.units);
      // Items sin movimiento (cero ventas en el período)
      const itemsSnap = await db.collection("users").doc(uid).collection("inventory_items").get();
      const allItems = itemsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const noSale = allItems.filter(i => !byItem[i.id]).map(i => ({ id: i.id, nombre: i.nombre, units: 0 }));

      return res.json({
        days,
        series,
        ranking: ranking.slice(0, 20),
        no_sale: noSale.slice(0, 20),
        total_units: ranking.reduce((s, r) => s + r.units, 0),
      });
    }

    // ── PROJECTION para gráfico de línea de stock futuro ────
    if (action === "stock_projection" && req.method === "GET") {
      const item_id = req.query.item_id;
      if (!item_id) return res.status(400).json({ error: "Falta item_id" });
      const ref = db.collection("users").doc(uid).collection("inventory_items").doc(item_id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: "Item no encontrado" });
      const item = snap.data();
      const settings = await getSettings(db, uid);

      const days = Math.min(parseInt(req.query.days) || 90, 365);
      const salesPerDay = ((item.sales_30d || 0) / 30) * (settings.multiplier || 1);
      const projection = [];
      for (let i = 0; i <= days; i++) {
        const remaining = Math.max(0, (item.stock_total || 0) - Math.floor(salesPerDay * i));
        projection.push({ day: i, stock: remaining });
        if (remaining === 0) break;
      }
      return res.json({
        item_id, item_name: item.nombre,
        stock_total: item.stock_total,
        sales_per_day: salesPerDay,
        empty_in_days: salesPerDay > 0 ? Math.floor((item.stock_total || 0) / salesPerDay) : null,
        projection,
      });
    }

    // ──────────────────────────────────────────────────────────
    // GESTIÓN DE MERCADO LIBRE — Ediciones bulk
    // ──────────────────────────────────────────────────────────

    // Listar todas las publicaciones del user con los campos editables
    // Diagnóstico de la conexión ML — muestra qué falla en cada paso.
    if (action === "ml_diagnose" && req.method === "GET") {
      const diag = { steps: [], suggestion: null };
      let token;
      try { token = await getValidMLToken(db, uid, await mlVentasAcc(db, uid)); }
      catch (e) {
        diag.steps.push({ name: "token", ok: false, error: e.message });
        diag.suggestion = "Reconectá ML desde Configuración → Integraciones.";
        return res.json(diag);
      }
      if (!token) {
        diag.steps.push({ name: "token", ok: false, error: "No hay token guardado" });
        diag.suggestion = "Conectá ML desde Configuración → Integraciones.";
        return res.json(diag);
      }
      diag.steps.push({ name: "token", ok: true, userId: token.userId });
      // Test 1: /users/me
      try {
        const r = await fetch("https://api.mercadolibre.com/users/me", { headers: { Authorization: `Bearer ${token.accessToken}` } });
        const j = await r.json();
        if (!r.ok) {
          diag.steps.push({ name: "users/me", ok: false, status: r.status, error: j.message || JSON.stringify(j).slice(0,300) });
          diag.suggestion = "El token no es válido. Reconectá ML.";
          return res.json(diag);
        }
        diag.steps.push({ name: "users/me", ok: true, nickname: j.nickname, site_id: j.site_id, user_id: j.id });
      } catch (e) {
        diag.steps.push({ name: "users/me", ok: false, error: e.message });
        return res.json(diag);
      }
      // Test 2: items/search active
      try {
        const r = await fetch(`https://api.mercadolibre.com/users/${token.userId}/items/search?status=active&limit=5`, { headers: { Authorization: `Bearer ${token.accessToken}` } });
        const j = await r.json();
        if (!r.ok) {
          const errMsg = j.message || j.error || JSON.stringify(j).slice(0,300);
          diag.steps.push({ name: "items/search?status=active", ok: false, status: r.status, error: errMsg, raw: j });
          if (r.status === 403 && /PolicyAgent|UNAUTHORIZED/.test(errMsg)) {
            diag.suggestion = "Tu app de ML en developers.mercadolibre.com no tiene permiso 'Publicación y sincronización' (Lectura). Entrá a tu app → editar → Permisos → marcalo → Guardar → reconectá ML.";
          } else if (r.status === 401) {
            diag.suggestion = "Token vencido o inválido. Reconectá ML.";
          } else {
            diag.suggestion = "Revisá el error específico arriba.";
          }
          return res.json(diag);
        }
        diag.steps.push({ name: "items/search?status=active", ok: true, total: j.paging?.total ?? null, results_count: (j.results || []).length, sample_ids: (j.results || []).slice(0,3) });
      } catch (e) {
        diag.steps.push({ name: "items/search?status=active", ok: false, error: e.message });
        return res.json(diag);
      }
      // Test 3: items/search all (sin status)
      try {
        const r = await fetch(`https://api.mercadolibre.com/users/${token.userId}/items/search?limit=5`, { headers: { Authorization: `Bearer ${token.accessToken}` } });
        const j = await r.json();
        diag.steps.push({ name: "items/search (all)", ok: r.ok, total: j.paging?.total ?? null, results_count: (j.results || []).length, error: r.ok ? null : (j.message || JSON.stringify(j).slice(0,200)) });
      } catch (e) {
        diag.steps.push({ name: "items/search (all)", ok: false, error: e.message });
      }
      diag.suggestion = "Diagnóstico OK. Si seguís sin ver publicaciones, contactá soporte con este JSON.";
      return res.json(diag);
    }

    if (action === "ml_items" && req.method === "GET") {
      let token;
      try { token = await getValidMLToken(db, uid, await mlVentasAcc(db, uid)); }
      catch (e) { return res.status(400).json({ error: `Tu cuenta de Mercado Libre necesita reconexión: ${e.message}` }); }
      if (!token) return res.status(400).json({ error: "Tu cuenta de Mercado Libre no está vinculada. Andá a Configuración → Integraciones → Mercado Libre y conectala." });
      const status = req.query.status || "active"; // active | paused | closed | all
      const items = [];
      // Capturamos el primer error real (en vez de fallar en silencio)
      let firstError = null;
      try {
        // 1) paginar IDs — intento con limit=50 normal
        const ids = [];
        let offset = 0;
        let totalFromML = null;
        let httpStatus = null;
        while (offset < 1000) {
          // URL bien formada: si status==="all", no incluimos el filtro.
          const url = status === "all"
            ? `https://api.mercadolibre.com/users/${token.userId}/items/search?limit=50&offset=${offset}`
            : `https://api.mercadolibre.com/users/${token.userId}/items/search?status=${status}&limit=50&offset=${offset}`;
          const r = await fetch(url, { headers: { Authorization: `Bearer ${token.accessToken}` } });
          httpStatus = r.status;
          if (!r.ok) {
            const txt = await r.text().catch(()=>"");
            firstError = `HTTP ${r.status} en items/search: ${txt.slice(0,300)}`;
            break;
          }
          const j = await r.json();
          if (totalFromML == null) totalFromML = j.paging?.total ?? null;
          const batch = j.results || [];
          ids.push(...batch);
          if (batch.length < 50) break;
          offset += 50;
        }
        // Fallback: si normal devolvió 0 sin error HTTP, probar search_type=scan
        // (ML recomienda scan para usuarios con muchos items o cuentas vintage).
        if (ids.length === 0 && !firstError) {
          try {
            const scanUrl = status === "all"
              ? `https://api.mercadolibre.com/users/${token.userId}/items/search?search_type=scan&limit=50`
              : `https://api.mercadolibre.com/users/${token.userId}/items/search?status=${status}&search_type=scan&limit=50`;
            const r = await fetch(scanUrl, { headers: { Authorization: `Bearer ${token.accessToken}` } });
            if (r.ok) {
              const j = await r.json();
              ids.push(...(j.results || []));
              if (totalFromML == null) totalFromML = j.paging?.total ?? null;
            }
          } catch (_) {}
        }
        if (ids.length === 0) {
          // Auto-diagnose para que el frontend tenga toda la info sin segunda llamada
          let diagnosticPayload = { reason: firstError ? "api_error" : "empty", error: firstError, total_from_ml: totalFromML, http_status: httpStatus };
          // Probar /users/me para verificar token
          try {
            const me = await fetch("https://api.mercadolibre.com/users/me", { headers: { Authorization: `Bearer ${token.accessToken}` } });
            const meJ = await me.json();
            if (me.ok) {
              diagnosticPayload.users_me = { nickname: meJ.nickname, user_id: meJ.id, site_id: meJ.site_id, status: meJ.status?.list?.allow ? "active" : "inactive" };
              if (String(meJ.id) !== String(token.userId)) {
                diagnosticPayload.warning = `user_id en token (${token.userId}) ≠ user_id de /users/me (${meJ.id}). Reconectá ML.`;
              }
            } else {
              diagnosticPayload.users_me_error = meJ.message || meJ.error || `HTTP ${me.status}`;
            }
          } catch (_) {}
          if (firstError && /403|PolicyAgent|UNAUTHORIZED/i.test(firstError)) {
            diagnosticPayload.hint = "Tu app de ML en developers.mercadolibre.com NO tiene permiso de lectura de items. Entrá a la app → editar → Permisos → marcá 'Publicación y sincronización' (Lectura) → Guardar → reconectá ML.";
          } else if (firstError && /401/.test(firstError)) {
            diagnosticPayload.hint = "Token expirado o inválido. Reconectá ML.";
          } else if (totalFromML === 0) {
            diagnosticPayload.hint = `ML respondió 0 publicaciones en estado "${status}".`;
          } else {
            diagnosticPayload.hint = "Revisá el diagnóstico arriba.";
          }
          return res.json({ items: [], diagnostic: diagnosticPayload });
        }
        // 2) fetch detalles en multiget (max 20 por call)
        const fields = "id,title,permalink,status,available_quantity,price,currency_id,sale_terms,thumbnail,pictures,sold_quantity,health,listing_type_id";
        for (let i = 0; i < ids.length; i += 20) {
          const chunk = ids.slice(i, i + 20);
          const r = await fetch(`https://api.mercadolibre.com/items?ids=${chunk.join(",")}&attributes=${fields}`, {
            headers: { Authorization: `Bearer ${token.accessToken}` },
          });
          if (!r.ok) continue;
          const arr = await r.json();
          for (const entry of arr) {
            const it = entry.body || entry;
            if (!it?.id) continue;
            const handlingTerm = (it.sale_terms || []).find(t => t.id === "MANUFACTURING_TIME");
            items.push({
              id: it.id,
              title: it.title,
              permalink: it.permalink,
              status: it.status,
              available_quantity: it.available_quantity || 0,
              sold_quantity: it.sold_quantity || 0,
              price: it.price || 0,
              currency: it.currency_id || "ARS",
              thumbnail: it.thumbnail || null,
              pictures_count: (it.pictures || []).length,
              handling_time: handlingTerm?.value_struct?.number || null,
              listing_type: it.listing_type_id || null,
              health: it.health ?? null,
            });
          }
        }
        return res.json({ items });
      } catch (e) {
        return res.status(502).json({ error: `Error consultando ML: ${e.message}` });
      }
    }

    // Update individual de un item (PUT a /items/{id})
    if (action === "ml_item_update" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      const { item_id, changes } = body || {};
      if (!item_id) return res.status(400).json({ error: "Falta item_id" });
      if (!changes || typeof changes !== "object") return res.status(400).json({ error: "Falta changes" });
      let token;
      try { token = await getValidMLToken(db, uid, await mlVentasAcc(db, uid)); } catch (e) { return res.status(400).json({ error: e.message }); }
      if (!token) return res.status(400).json({ error: "Mercado Libre no conectado" });
      try {
        const r = await fetch(`https://api.mercadolibre.com/items/${item_id}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token.accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(changes),
        });
        const data = await r.json();
        if (!r.ok) return res.status(502).json({ error: data.message || `HTTP ${r.status}`, raw: data });
        return res.json({ ok: true, item_id, applied: changes });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // BULK update: aplica los mismos changes a N items en paralelo
    // body: { item_ids: [...], changes: {...} }
    // Para handling_time: changes={ handling_time: 5 } se convierte a sale_terms.
    if (action === "ml_bulk_update" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      const { item_ids, changes } = body || {};
      if (!Array.isArray(item_ids) || item_ids.length === 0) return res.status(400).json({ error: "Faltan item_ids" });
      if (!changes || typeof changes !== "object") return res.status(400).json({ error: "Faltan changes" });
      let token;
      try { token = await getValidMLToken(db, uid, await mlVentasAcc(db, uid)); } catch (e) { return res.status(400).json({ error: e.message }); }
      if (!token) return res.status(400).json({ error: "Mercado Libre no conectado" });
      // Traducir handling_time → sale_terms format ML
      const mlChanges = { ...changes };
      if (mlChanges.handling_time != null) {
        const ht = parseInt(mlChanges.handling_time);
        mlChanges.sale_terms = [{
          id: "MANUFACTURING_TIME",
          value_struct: { number: ht, unit: "días" },
        }];
        delete mlChanges.handling_time;
      }
      // % price changes: si pasan { price_pct: -10 } trabajamos por item
      const isPctPrice = typeof changes.price_pct === "number";
      const results = [];
      const POOL = 5;
      let idx = 0;
      const worker = async () => {
        while (idx < item_ids.length) {
          const i = idx++;
          const itemId = item_ids[i];
          try {
            let payload = mlChanges;
            if (isPctPrice) {
              // Necesitamos precio actual para calcular delta
              const r0 = await fetch(`https://api.mercadolibre.com/items/${itemId}?attributes=price`, {
                headers: { Authorization: `Bearer ${token.accessToken}` },
              });
              const j0 = await r0.json();
              const current = j0.price || 0;
              const newPrice = Math.round(current * (1 + changes.price_pct / 100));
              payload = { ...mlChanges, price: newPrice };
              delete payload.price_pct;
            }
            const r = await fetch(`https://api.mercadolibre.com/items/${itemId}`, {
              method: "PUT",
              headers: { Authorization: `Bearer ${token.accessToken}`, "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
            const data = await r.json();
            if (!r.ok) results.push({ item_id: itemId, ok: false, error: data.message || `HTTP ${r.status}` });
            else results.push({ item_id: itemId, ok: true });
          } catch (e) {
            results.push({ item_id: itemId, ok: false, error: e.message });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(POOL, item_ids.length) }, () => worker()));
      const okCount = results.filter(r => r.ok).length;
      return res.json({ ok: true, total: item_ids.length, ok_count: okCount, errors: results.filter(r => !r.ok) });
    }

    // Reemplazar / agregar / quitar imagenes de UN item
    // body: { item_id, picture_urls: [...] }  ← reemplaza el set completo
    if (action === "ml_item_pictures" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      const { item_id, picture_urls } = body || {};
      if (!item_id) return res.status(400).json({ error: "Falta item_id" });
      if (!Array.isArray(picture_urls) || picture_urls.length === 0) return res.status(400).json({ error: "Faltan picture_urls" });
      let token;
      try { token = await getValidMLToken(db, uid, await mlVentasAcc(db, uid)); } catch (e) { return res.status(400).json({ error: e.message }); }
      if (!token) return res.status(400).json({ error: "Mercado Libre no conectado" });
      try {
        const pictures = picture_urls.filter(u => /^https?:\/\//i.test(u)).map(u => ({ source: u }));
        const r = await fetch(`https://api.mercadolibre.com/items/${item_id}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token.accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ pictures }),
        });
        const data = await r.json();
        if (!r.ok) return res.status(502).json({ error: data.message || `HTTP ${r.status}`, raw: data });
        return res.json({ ok: true, item_id, pictures_count: pictures.length });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // GESTOR MERCADO LIBRE — publicador, preguntas, mensajes, ventas, reputación
    // Todas reusan getValidMLToken (auto-refresh) + la cuenta de ventas elegida.
    // ─────────────────────────────────────────────────────────────────────
    const mlToken = async () => {
      const t = await getValidMLToken(db, uid, await mlVentasAcc(db, uid));
      if (!t) { const e = new Error("Mercado Libre no conectado"); e.status = 400; throw e; }
      return t;
    };
    const mlErr = (res, e) => res.status(e.status === 400 ? 400 : 502).json({ error: e.message, raw: e.ml || null });

    // Info del vendedor: site_id (país), nickname, permalink y REPUTACIÓN completa
    // (color del termómetro, métricas de reclamos/cancelaciones/demoras, ventas).
    if (action === "ml_seller_info" && req.method === "GET") {
      try {
        const t = await mlToken();
        const u = await mlApi(t.accessToken, `/users/${t.userId}`);
        return res.json({
          ok: true, seller_id: t.userId, site_id: u.site_id || "MLA", nickname: u.nickname || "",
          permalink: u.permalink || "", registration_date: u.registration_date || null,
          reputation: u.seller_reputation || null, status: u.status || null,
        });
      } catch (e) { return mlErr(res, e); }
    }

    // Predecir categoría a partir del título (domain discovery). Devuelve las
    // categorías sugeridas para que el cliente elija — así el rubro es dinámico.
    if (action === "ml_predict_category" && req.method === "GET") {
      const q = String(req.query.q || "").trim();
      const site = String(req.query.site || "MLA");
      if (!q) return res.status(400).json({ error: "Falta q (título)" });
      try {
        const t = await mlToken();
        const arr = await mlApi(t.accessToken, `/sites/${site}/domain_discovery/search?limit=8&q=${encodeURIComponent(q)}`);
        return res.json({ ok: true, suggestions: (arr || []).map(d => ({ category_id: d.category_id, category_name: d.category_name, domain_id: d.domain_id, domain_name: d.domain_name })) });
      } catch (e) { return mlErr(res, e); }
    }

    // Explorar categorías: sin cat → raíz del sitio; con cat → hijos + path_from_root.
    if (action === "ml_categories" && req.method === "GET") {
      const site = String(req.query.site || "MLA");
      const cat = String(req.query.cat || "").trim();
      try {
        const t = await mlToken();
        if (!cat) { const roots = await mlApi(t.accessToken, `/sites/${site}/categories`); return res.json({ ok: true, root: true, categories: roots }); }
        const c = await mlApi(t.accessToken, `/categories/${cat}`);
        return res.json({ ok: true, id: c.id, name: c.name, path_from_root: c.path_from_root || [], children: c.children_categories || [], settings: c.settings || null });
      } catch (e) { return mlErr(res, e); }
    }

    // Atributos que exige una categoría (dinámico por categoría). El front arma
    // el formulario: required, tipo (list/number/string), valores permitidos, unidades.
    if (action === "ml_category_attributes" && req.method === "GET") {
      const cat = String(req.query.cat || "").trim();
      if (!cat) return res.status(400).json({ error: "Falta cat" });
      try {
        const t = await mlToken();
        const attrs = await mlApi(t.accessToken, `/categories/${cat}/attributes`);
        return res.json({ ok: true, attributes: attrs });
      } catch (e) { return mlErr(res, e); }
    }

    // Tipos de publicación del sitio (gold_special, gold_pro, free...).
    if (action === "ml_listing_types" && req.method === "GET") {
      const site = String(req.query.site || "MLA");
      try {
        const t = await mlToken();
        const lt = await mlApi(t.accessToken, `/sites/${site}/listing_types`);
        return res.json({ ok: true, listing_types: lt });
      } catch (e) { return mlErr(res, e); }
    }

    // Subir UNA foto desde el dispositivo (base64) al repositorio de imágenes de
    // ML. Devuelve el id de la imagen para usarlo en la publicación como {id}.
    if (action === "ml_upload_picture" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      const dataUrl = String(body?.data_url || "");
      const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) return res.status(400).json({ error: "Falta data_url (imagen base64)" });
      try {
        const t = await mlToken();
        const buf = Buffer.from(m[2], "base64");
        const fd = new FormData();
        fd.append("file", new Blob([buf], { type: m[1] }), "photo." + (m[1].split("/")[1] || "jpg"));
        const r = await fetch("https://api.mercadolibre.com/pictures/items/upload", {
          method: "POST", headers: { Authorization: `Bearer ${t.accessToken}` }, body: fd,
        });
        const data = await r.json();
        if (!r.ok) return res.status(502).json({ error: data.message || `HTTP ${r.status}`, raw: data });
        return res.json({ ok: true, id: data.id, url: data.variations?.[0]?.secure_url || data.variations?.[0]?.url || null });
      } catch (e) { return mlErr(res, e); }
    }

    // Crear UNA publicación. El front manda el `item` completo ya armado con la
    // categoría/atributos elegidos (dinámico). La descripción va aparte (recurso
    // /description). Devuelve id + permalink.
    if (action === "ml_create_item" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      const item = body?.item;
      if (!item || typeof item !== "object") return res.status(400).json({ error: "Falta item" });
      try {
        const t = await mlToken();
        const created = await mlApi(t.accessToken, `/items`, { method: "POST", body: item });
        const desc = String(body?.description || "").trim();
        if (desc) { try { await mlApi(t.accessToken, `/items/${created.id}/description`, { method: "POST", body: { plain_text: desc } }); } catch(_) {} }
        return res.json({ ok: true, id: created.id, permalink: created.permalink || null, status: created.status || null });
      } catch (e) { return mlErr(res, e); }
    }

    // Publicación MASIVA (plantilla + duplicar): el front manda un array de items
    // ya resueltos (misma descripción/atributos, distinto título/precio/SKU/fotos).
    // Se crean en pool con reporte por publicación (id/permalink o error).
    if (action === "ml_create_bulk" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      const items = Array.isArray(body?.items) ? body.items : null;
      if (!items || items.length === 0) return res.status(400).json({ error: "Faltan items" });
      if (items.length > 100) return res.status(400).json({ error: "Máximo 100 por tanda" });
      try {
        const t = await mlToken();
        const results = new Array(items.length);
        let idx = 0; const POOL = 3;
        const worker = async () => {
          while (idx < items.length) {
            const i = idx++; const entry = items[i] || {}; const it = entry.item;
            const title = it?.title || `#${i + 1}`;
            try {
              const created = await mlApi(t.accessToken, `/items`, { method: "POST", body: it });
              const desc = String(entry.description || "").trim();
              if (desc) { try { await mlApi(t.accessToken, `/items/${created.id}/description`, { method: "POST", body: { plain_text: desc } }); } catch(_) {} }
              results[i] = { ok: true, title, id: created.id, permalink: created.permalink || null };
            } catch (e) { results[i] = { ok: false, title, error: e.message }; }
          }
        };
        await Promise.all(Array.from({ length: Math.min(POOL, items.length) }, () => worker()));
        return res.json({ ok: true, total: items.length, ok_count: results.filter(r => r.ok).length, results });
      } catch (e) { return mlErr(res, e); }
    }

    // PREGUNTAS pre-venta: listar (por defecto sin responder) + enriquecer con
    // título/thumbnail de la publicación.
    if (action === "ml_questions" && req.method === "GET") {
      const status = String(req.query.status || "UNANSWERED");
      const limit = Math.min(parseInt(req.query.limit) || 50, 50);
      try {
        const t = await mlToken();
        const qs = await mlApi(t.accessToken, `/questions/search?seller_id=${t.userId}&api_version=4&sort=date_desc&status=${status}&limit=${limit}`);
        const questions = qs.questions || [];
        const ids = [...new Set(questions.map(q => q.item_id).filter(Boolean))];
        const titles = {};
        for (let i = 0; i < ids.length; i += 20) {
          const chunk = ids.slice(i, i + 20);
          try {
            const arr = await mlApi(t.accessToken, `/items?ids=${chunk.join(",")}&attributes=id,title,thumbnail,permalink,price`);
            for (const e of arr) if (e.code === 200 && e.body) titles[e.body.id] = { title: e.body.title, thumbnail: e.body.thumbnail, permalink: e.body.permalink, price: e.body.price };
          } catch(_) {}
        }
        return res.json({ ok: true, total: qs.total || questions.length, questions: questions.map(q => ({ id: q.id, text: q.text, status: q.status, date: q.date_created, item_id: q.item_id, from: q.from?.id || null, item: titles[q.item_id] || null })) });
      } catch (e) { return mlErr(res, e); }
    }

    // Responder una pregunta.
    if (action === "ml_answer" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      const question_id = body?.question_id; const text = String(body?.text || "").trim();
      if (!question_id || !text) return res.status(400).json({ error: "Falta question_id o text" });
      try {
        const t = await mlToken();
        await mlApi(t.accessToken, `/answers`, { method: "POST", body: { question_id, text } });
        return res.json({ ok: true, question_id });
      } catch (e) { return mlErr(res, e); }
    }

    // VENTAS / órdenes: lista con número de pack (#2000...), comprador, ítems,
    // estado y estado de envío. Paginada por offset.
    if (action === "ml_orders" && req.method === "GET") {
      const limit = Math.min(parseInt(req.query.limit) || 40, 50);
      const offset = parseInt(req.query.offset) || 0;
      try {
        const t = await mlToken();
        const o = await mlApi(t.accessToken, `/orders/search?seller=${t.userId}&sort=date_desc&limit=${limit}&offset=${offset}`);
        const orders = (o.results || []).map(r => ({
          id: r.id, pack_id: r.pack_id || r.id, date: r.date_created, status: r.status,
          total: r.total_amount, currency: r.currency_id,
          buyer: r.buyer?.nickname || `${r.buyer?.first_name || ""} ${r.buyer?.last_name || ""}`.trim(),
          buyer_id: r.buyer?.id || null,
          items: (r.order_items || []).map(oi => ({ title: oi.item?.title, qty: oi.quantity, unit_price: oi.unit_price, item_id: oi.item?.id, variation: oi.item?.variation_attributes?.map(v => v.value_name).join(" / ") || "" })),
          shipping_id: r.shipping?.id || null,
        }));
        return res.json({ ok: true, total: o.paging?.total || orders.length, offset, orders });
      } catch (e) { return mlErr(res, e); }
    }

    // MENSAJES post-venta de un pack: hilo completo comprador↔vendedor.
    if (action === "ml_messages" && req.method === "GET") {
      const pack = String(req.query.pack_id || "").trim();
      if (!pack) return res.status(400).json({ error: "Falta pack_id" });
      try {
        const t = await mlToken();
        const m = await mlApi(t.accessToken, `/messages/packs/${pack}/sellers/${t.userId}?tag=post_sale&mark_as_read=false`);
        const msgs = (m.messages || []).map(x => ({ id: x.id, from: x.from?.user_id, to: x.to?.user_id, text: x.text || "", date: x.message_date?.created || x.date_created, mine: String(x.from?.user_id) === String(t.userId) }));
        return res.json({ ok: true, seller_id: t.userId, messages: msgs });
      } catch (e) { return mlErr(res, e); }
    }

    // Enviar un mensaje post-venta al comprador de un pack.
    if (action === "ml_send_message" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      const pack = String(body?.pack_id || "").trim();
      const to = body?.to_user_id; const text = String(body?.text || "").trim();
      if (!pack || !to || !text) return res.status(400).json({ error: "Falta pack_id, to_user_id o text" });
      try {
        const t = await mlToken();
        await mlApi(t.accessToken, `/messages/packs/${pack}/sellers/${t.userId}?tag=post_sale`, {
          method: "POST", body: { from: { user_id: String(t.userId) }, to: { user_id: String(to) }, text },
        });
        return res.json({ ok: true, pack_id: pack });
      } catch (e) { return mlErr(res, e); }
    }

    return res.status(400).json({ error: `Acción no soportada: ${action}` });
  } catch (e) {
    console.error("[inventory]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
