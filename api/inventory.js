// api/inventory.js
// Módulo Stock / Inventario para Growith.
// Collections: users/{uid}/inventory_items, users/{uid}/inventory_movements
// Campos en user doc: inventory_settings { multiplier, low_days, empty_days, alert_email }

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getValidMLToken } from "./integrations.js";

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

async function getSettings(db, uid) {
  const snap = await db.collection("users").doc(uid).get();
  return snap.data()?.inventory_settings || {
    multiplier: 1,
    low_days: 15,
    empty_days: 5,
    alert_email: false,
  };
}

function computeStatus(stock, sales30d, settings) {
  const salesPerDay = ((sales30d || 0) / 30) * (settings.multiplier || 1);
  if (salesPerDay <= 0) return { days_left: null, status: stock > 0 ? "ok" : "empty" };
  const days_left = Math.floor((stock || 0) / salesPerDay);
  let status = "ok";
  if (days_left <= (settings.empty_days || 5)) status = "empty";
  else if (days_left <= (settings.low_days || 15)) status = "low";
  return { days_left, status };
}

async function logMovement(db, uid, mov) {
  await db.collection("users").doc(uid).collection("inventory_movements").add({
    ...mov,
    ts: mov.ts || new Date().toISOString(),
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, PATCH");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { action, uid } = req.query;
  if (!uid) return res.status(401).json({ error: "Falta uid" });

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
        const sales_30d = sales30dByItem[d.id] || 0;
        const { days_left, status } = computeStatus(data.stock_total, sales_30d, settings);
        return { id: d.id, ...data, sales_30d, days_left, status };
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

      // TN
      if (platform === "all" || platform === "tiendanube") {
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
            } catch (e) { break; }
          }
        }
      }

      // Shopify
      if (platform === "all" || platform === "shopify") {
        const sh = stores.find(s => s.type === "shopify");
        if (sh?.accessToken && sh?.shop) {
          let pageInfoUrl = `https://${sh.shop}/admin/api/2024-10/products.json?limit=250`;
          for (let i = 0; i < 4 && pageInfoUrl; i++) {
            try {
              const r = await fetch(pageInfoUrl, { headers: { "X-Shopify-Access-Token": sh.accessToken } });
              if (!r.ok) break;
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
            } catch (e) { break; }
          }
        }
      }

      // ML
      if (platform === "all" || platform === "mercadolibre") {
        const ml = stores.find(s => s.type === "mercadolibre");
        if (ml?.userId) {
          try {
            const tokenInfo = await getValidMLToken(db, uid);
            if (tokenInfo?.accessToken) {
              for (let offset = 0; offset < 500; offset += 50) {
                const idsRes = await fetch(`https://api.mercadolibre.com/users/${tokenInfo.userId}/items/search?status=active&limit=50&offset=${offset}`, {
                  headers: { Authorization: `Bearer ${tokenInfo.accessToken}` },
                });
                if (!idsRes.ok) break;
                const idsData = await idsRes.json();
                const ids = idsData.results || [];
                if (ids.length === 0) break;
                const detailsRes = await fetch(`https://api.mercadolibre.com/items?ids=${ids.join(",")}&attributes=id,title,thumbnail,price,seller_custom_field`, {
                  headers: { Authorization: `Bearer ${tokenInfo.accessToken}` },
                });
                if (!detailsRes.ok) break;
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
            }
          } catch (e) { /* ignorar */ }
        }
      }

      return res.json({ products });
    }

    // ── SYNC SALES — recorre ordenes recientes, descuenta stock de items vinculados ──
    if (action === "sync_sales" && req.method === "POST") {
      const itemsSnap = await db.collection("users").doc(uid).collection("inventory_items").get();
      const items = itemsSnap.docs.map(d => ({ ref: d.ref, ...d.data() }));
      const linkedItems = items.filter(i => Array.isArray(i.product_links) && i.product_links.length > 0);
      if (linkedItems.length === 0) return res.json({ ok: true, processed_orders: 0, items_updated: 0 });

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
                products: (o.products || []).map(p => ({ id: `TN-${p.product_id || p.id}`, quantity: parseInt(p.quantity) || 1 })),
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
                products: (o.line_items || []).map(li => ({ id: `SH-${li.product_id}`, quantity: parseInt(li.quantity) || 1 })),
              });
            }
            const linkHeader = r.headers.get("link") || "";
            const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
            pageInfoUrl = nextMatch ? nextMatch[1] : null;
          } catch (e) { break; }
        }
      }

      // ML
      const ml = stores.find(s => s.type === "mercadolibre");
      if (ml?.userId) {
        try {
          const tokenInfo = await getValidMLToken(db, uid);
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
                  products: (o.order_items || []).map(it => ({ id: `ML-${it.item?.id}`, quantity: parseInt(it.quantity) || 1 })),
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
        const linkMap = new Map(item.product_links.map(l => [l.product_id, parseInt(l.quantity) || 1]));
        const processed = new Set(item.processed_orders || []);
        let stockChange = 0;
        const newProcessed = [];

        for (const ord of recentOrders) {
          if (processed.has(ord.order_id)) continue;
          let unitsForItem = 0;
          for (const prod of ord.products) {
            const linkedQty = linkMap.get(prod.id);
            if (linkedQty) unitsForItem += prod.quantity * linkedQty;
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
        } else if (newProcessed.length === 0 && !item.last_sync_at) {
          // primer sync sin ventas — solo marcamos timestamp
          await item.ref.update({ last_sync_at: new Date().toISOString() });
        }
      }

      return res.json({ ok: true, processed_orders: recentOrders.length, items_updated: itemsUpdated, sales_logged: salesLogged });
    }

    // ── CREATE/UPDATE ITEM ──────────────────────────────────
    if (action === "save_item" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      if (!body.nombre) return res.status(400).json({ error: "Falta nombre" });

      const itemsCol = db.collection("users").doc(uid).collection("inventory_items");
      const id = body.id || itemsCol.doc().id;
      const existing = body.id ? (await itemsCol.doc(id).get()).data() : null;

      const data = {
        id,
        nombre: String(body.nombre).slice(0, 200),
        sku: String(body.sku || "").slice(0, 80),
        image: body.image || null,
        stock_total: parseInt(body.stock_total) || 0,
        canales: Array.isArray(body.canales) ? body.canales : [],
        // product_links: [{ product_id, platform, title, image, quantity }] — cantidad descuento por venta
        product_links: Array.isArray(body.product_links) ? body.product_links.map(l => ({
          product_id: String(l.product_id || ""),
          platform: String(l.platform || ""),
          title: String(l.title || ""),
          image: l.image || null,
          quantity: parseInt(l.quantity) || 1,
        })) : (existing?.product_links || []),
        // Mantenemos el set de orders procesadas para no descontar 2 veces
        processed_orders: existing?.processed_orders || [],
        last_sync_at: existing?.last_sync_at || null,
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

      return res.json({ ok: true, item: data });
    }

    // ── ADJUST STOCK (suma/resta change, o setea new_stock) ─
    if (action === "adjust_stock" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      const { item_id, new_stock, change, source, event } = body;
      if (!item_id) return res.status(400).json({ error: "Falta item_id" });

      const ref = db.collection("users").doc(uid).collection("inventory_items").doc(item_id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: "Item no encontrado" });
      const current = snap.data();
      const oldStock = current.stock_total || 0;
      const newStock = new_stock !== undefined && new_stock !== null
        ? parseInt(new_stock)
        : oldStock + (parseInt(change) || 0);

      await ref.update({ stock_total: newStock, updated_at: new Date().toISOString() });
      await logMovement(db, uid, {
        item_id, item_name: current.nombre,
        change: newStock - oldStock,
        old_stock: oldStock, new_stock: newStock,
        source: source || "manual",
        event: event || "ajuste",
      });
      return res.json({ ok: true, old_stock: oldStock, new_stock: newStock });
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
      return res.json({ movements });
    }

    // ── SETTINGS GET / SAVE ─────────────────────────────────
    if (action === "settings_get" && req.method === "GET") {
      const settings = await getSettings(db, uid);
      return res.json({ settings });
    }

    if (action === "settings_save" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      const settings = {
        multiplier: parseFloat(body.multiplier) || 1,
        low_days: parseInt(body.low_days) || 15,
        empty_days: parseInt(body.empty_days) || 5,
        alert_email: !!body.alert_email,
      };
      await db.collection("users").doc(uid).set({ inventory_settings: settings }, { merge: true });
      return res.json({ ok: true, settings });
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

      for (const d of snap.docs) {
        const m = d.data();
        if (!m.ts || new Date(m.ts) < sinceDate) continue;
        const isSale = m.event === "venta" || (m.change < 0 && m.event !== "ajuste_manual" && m.event !== "ajuste");
        if (!isSale) continue;
        const day = m.ts.slice(0, 10);
        const qty = Math.abs(m.change) || 0;
        byDay[day] = (byDay[day] || 0) + qty;
        if (!byItem[m.item_id]) byItem[m.item_id] = { id: m.item_id, nombre: m.item_name || "(sin nombre)", units: 0, count: 0 };
        byItem[m.item_id].units += qty;
        byItem[m.item_id].count += 1;
      }

      // Serie de tiempo: completar días faltantes con 0
      const series = [];
      const today = new Date();
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today.getTime() - i * 86400000);
        const key = d.toISOString().slice(0, 10);
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

    return res.status(400).json({ error: `Acción no soportada: ${action}` });
  } catch (e) {
    console.error("[inventory]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
