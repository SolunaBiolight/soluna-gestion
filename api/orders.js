import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

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

  let platform = 'tiendanube', storeId, accessToken, shop;
  try {
    const db = initAdmin();
    const userSnap = await db.collection("users").doc(uid).get();
    if (userSnap.exists) {
      const stores = userSnap.data().stores || [];
      const tnStore = stores.find(s => s.type === "tiendanube");
      const shStore = stores.find(s => s.type === "shopify");
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
    // Compatible con TN y Shopify
    if (tab === 'stats') {
      const { from, to, prevFrom } = req.query;
      if (!from) return res.status(400).json({ error: 'from required' });
      const toDate = to || new Date().toISOString();

      if (platform === 'shopify') {
        const [current, prev] = await Promise.all([
          fetchShopifyOrders(from, toDate),
          prevFrom ? fetchShopifyOrders(prevFrom, from) : Promise.resolve([]),
        ]);
        return res.status(200).json({ current: calcStats(current, true), prev: calcStats(prev, true) });
      }

      // TN
      const mkParams = (f, t) =>
        `payment_status=paid&created_at_min=${encodeURIComponent(f)}&created_at_max=${encodeURIComponent(t)}`;
      const [current, prev] = await Promise.all([
        fetchAllPages(storeId, accessToken, mkParams(from, toDate)),
        prevFrom ? fetchAllPages(storeId, accessToken, mkParams(prevFrom, from)) : Promise.resolve([]),
      ]);
      return res.status(200).json({ current: calcStats(current, false), prev: calcStats(prev, false) });
    }

    // TOTAL: count de todos los pedidos pagados (solo TN por ahora)
    if (tab === 'total') {
      if (platform === 'shopify') return res.status(200).json([]);
      let total = 0;
      for (let p = 1; p <= 20; p++) {
        const page = await fetchPage(storeId, accessToken, "payment_status=paid,partially_paid,partially_refunded", p, 200);
        total += page.length;
        if (page.length < 200) break;
      }
      return res.status(200).json(Array.from({length: total}, (_,i) => ({id:i})));
    }

    // POR COBRAR: solo TN (Shopify usa flujo diferente)
    if (tab === 'cobrar') {
      if (platform === 'shopify') return res.status(200).json([]);
      const orders = await fetchAllPages(storeId, accessToken, "payment_status=pending,partially_paid&status=open");
      if (countOnly === 'true') return res.status(200).json(Array.from({length: orders.length}, (_,i) => ({id:i})));
      return res.status(200).json(orders);
    }

    // POR EMPAQUETAR: solo TN
    if (tab === 'empaquetar') {
      if (platform === 'shopify') return res.status(200).json([]);
      const orders = await fetchAllPages(storeId, accessToken, "payment_status=paid&shipping_status=unpacked&status=open");
      if (countOnly === 'true') return res.status(200).json(Array.from({length: orders.length}, (_,i) => ({id:i})));
      return res.status(200).json(orders);
    }

    // POR ENVIAR: solo TN
    if (tab === 'enviar') {
      if (platform === 'shopify') return res.status(200).json([]);
      const page1 = await fetchPage(storeId, accessToken, "payment_status=paid&status=open", 1, 200);
      const porEnviar = page1.filter(o => o.fulfillments?.some(f => f.status === 'PACKED'));
      if (countOnly === 'true') return res.status(200).json(Array.from({length: porEnviar.length}, (_,i) => ({id:i})));
      return res.status(200).json(porEnviar);
    }

    // Fallback: últimos 200 pedidos (solo TN)
    if (platform === 'shopify') return res.status(200).json([]);
    const orders = await fetchPage(storeId, accessToken, "", 1, 200);
    res.status(200).json(orders);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
