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

// Sin fallback — se requiere uid válido con tienda conectada

async function fetchPage(storeId, accessToken, extraParams, page, perPage=200) {
  const headers = {
    'Authentication': `bearer ${accessToken}`,
    'User-Agent': 'GrowithApp (soluna.biolight@gmail.com)'
  };
  const url = `https://api.tiendanube.com/v1/${storeId}/orders?per_page=${perPage}&page=${page}${extraParams ? "&" + extraParams : ""}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`TN API error ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function fetchAllPages(storeId, accessToken, extraParams = "") {
  const first = await fetchPage(storeId, accessToken, extraParams, 1);
  if (first.length === 0 || first.length < 200) return first;
  const extras = await Promise.all(
    [2,3,4,5,6,7,8,9,10].map(p =>
      fetchPage(storeId, accessToken, extraParams, p).catch(() => [])
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { uid, tab, countOnly, q } = req.query;

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
      if (mlStore) {
        try {
          const tok = await getValidMLToken(dbRef, uid);
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
  });
  const mergeStats = (a, b) => ({ count: (a.count || 0) + (b.count || 0), revenue: (a.revenue || 0) + (b.revenue || 0) });

  try {
    // Búsqueda directa por número (solo TN — Shopify devuelve vacío)
    if (q) {
      if (platform === 'shopify') return res.status(200).json([]);
      const headers = { 'Authentication': `bearer ${accessToken}`, 'User-Agent': 'GrowithApp (soluna.biolight@gmail.com)' };
      const r = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?q=${encodeURIComponent(q)}&per_page=20`, { headers });
      if (!r.ok) throw new Error(`TN search error ${r.status}`);
      const data = await r.json();
      return res.status(200).json(Array.isArray(data) ? data : []);
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
      return {
        id: o.id,
        number: o.order_number || (o.name || "").replace("#", "") || o.id,
        status: o.cancelled_at ? "cancelled" : "open",
        payment_status: o.financial_status === "paid" ? "paid" : (o.financial_status === "pending" ? "pending" : o.financial_status || ""),
        shipping_status: shStatus,
        contact_name: o.customer ? `${o.customer.first_name || ""} ${o.customer.last_name || ""}`.trim() : (sh.name || ""),
        contact_email: o.email || o.contact_email || o.customer?.email || "",
        contact_phone: o.phone || sh.phone || o.customer?.phone || "",
        contact_identification: "",
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
          address: sh.address1 || "",
          number: "",
          floor: sh.address2 || "",
          locality: sh.city || "",
          city: sh.city || "",
          zipcode: sh.zip || "",
          province: sh.province || "",
        },
        billing_address: o.billing_address ? { name: `${o.billing_address.first_name || ""} ${o.billing_address.last_name || ""}`.trim(), email: o.email || "", phone: o.billing_address.phone || "" } : null,
        shipping_option: o.shipping_lines?.[0]?.title || "Envío",
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

    // TOTAL: count de todos los pedidos pagados (TN o Shopify)
    if (tab === 'total') {
      if (platform === 'shopify') {
        const orders = await shopifyFetchOrders("financial_status=paid&fields=id");
        return res.status(200).json(Array.from({length: orders.length}, (_,i) => ({id:i})));
      }
      let total = 0;
      for (let p = 1; p <= 20; p++) {
        const page = await fetchPage(storeId, accessToken, "payment_status=paid,partially_paid,partially_refunded", p, 200);
        total += page.length;
        if (page.length < 200) break;
      }
      return res.status(200).json(Array.from({length: total}, (_,i) => ({id:i})));
    }

    // POR COBRAR: pedidos sin pagar
    if (tab === 'cobrar') {
      if (platform === 'shopify') {
        const orders = await shopifyFetchOrders("financial_status=pending,partially_paid");
        const filtered = orders.filter(o => !o.cancelled_at).map(shopifyToTNFormat);
        if (countOnly === 'true') return res.status(200).json(Array.from({length: filtered.length}, (_,i) => ({id:i})));
        return res.status(200).json(filtered);
      }
      const orders = await fetchAllPages(storeId, accessToken, "payment_status=pending,partially_paid&status=open");
      if (countOnly === 'true') return res.status(200).json(Array.from({length: orders.length}, (_,i) => ({id:i})));
      return res.status(200).json(orders);
    }

    // POR EMPAQUETAR: pagados, pendientes de fulfillment
    if (tab === 'empaquetar') {
      if (platform === 'shopify') {
        const orders = await shopifyFetchOrders("financial_status=paid&fulfillment_status=unfulfilled,partial");
        const filtered = orders.filter(o => !o.cancelled_at).map(shopifyToTNFormat);
        if (countOnly === 'true') return res.status(200).json(Array.from({length: filtered.length}, (_,i) => ({id:i})));
        return res.status(200).json(filtered);
      }
      const orders = await fetchAllPages(storeId, accessToken, "payment_status=paid&shipping_status=unpacked&status=open");
      if (countOnly === 'true') return res.status(200).json(Array.from({length: orders.length}, (_,i) => ({id:i})));
      return res.status(200).json(orders);
    }

    // POR ENVIAR: empaquetado, listo a enviar
    if (tab === 'enviar') {
      if (platform === 'shopify') {
        // Shopify no tiene "PACKED" — tomamos partial como ready-to-ship aproximado.
        const orders = await shopifyFetchOrders("financial_status=paid&fulfillment_status=partial");
        const filtered = orders.filter(o => !o.cancelled_at).map(shopifyToTNFormat);
        if (countOnly === 'true') return res.status(200).json(Array.from({length: filtered.length}, (_,i) => ({id:i})));
        return res.status(200).json(filtered);
      }
      const page1 = await fetchPage(storeId, accessToken, "payment_status=paid&status=open", 1, 200);
      const porEnviar = page1.filter(o => o.fulfillments?.some(f => f.status === 'PACKED'));
      if (countOnly === 'true') return res.status(200).json(Array.from({length: porEnviar.length}, (_,i) => ({id:i})));
      return res.status(200).json(porEnviar);
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
