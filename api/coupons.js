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

const FALLBACK_STORE_ID = "6978415";
const FALLBACK_TOKEN = "71be8939bf409df5b98caa80e22d7227ad288f82";

async function getTNCredentials(uid) {
  let storeId = FALLBACK_STORE_ID;
  let accessToken = FALLBACK_TOKEN;
  if (uid) {
    try {
      const db = initAdmin();
      const snap = await db.collection("users").doc(uid).get();
      if (snap.exists) {
        const tnStore = (snap.data().stores || []).find(s => s.type === "tiendanube");
        if (tnStore?.accessToken && tnStore?.storeId) {
          storeId = tnStore.storeId;
          accessToken = tnStore.accessToken;
        }
      }
    } catch(e) { console.error("Firebase error:", e.message); }
  }
  return { storeId, accessToken };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { uid, mode, desde, hasta } = req.query;
  const { storeId, accessToken } = await getTNCredentials(uid);
  const headers = {
    'Authentication': `bearer ${accessToken}`,
    'User-Agent': 'GrowithApp (soluna.biolight@gmail.com)',
  };

  try {
    if (mode === "ventas") {
      // Traer pedidos en rango de fechas y calcular ventas por código
      // TN filtra por created_at con min_date / max_date
      const desde_enc = encodeURIComponent(desde || "");
      const hasta_enc = encodeURIComponent(hasta || "");

      let allOrders = [];
      let page = 1;
      while (page <= 20) {
        let url = `https://api.tiendanube.com/v1/${storeId}/orders?payment_status=paid&per_page=200&page=${page}`;
        if (desde) url += `&min_date=${desde_enc}`;
        if (hasta) url += `&max_date=${hasta_enc}`;
        const r = await fetch(url, { headers });
        if (!r.ok) break;
        const data = await r.json();
        if (!Array.isArray(data) || data.length === 0) break;
        allOrders = [...allOrders, ...data];
        if (data.length < 200) break;
        page++;
      }

      // Agrupar por código de cupón
      const ventasPorCodigo = {};
      for (const o of allOrders) {
        const coupons = Array.isArray(o.coupon) ? o.coupon : [];
        for (const c of coupons) {
          const code = (c.code || "").toUpperCase();
          if (!code) continue;
          if (!ventasPorCodigo[code]) ventasPorCodigo[code] = { usos: 0, ventas: 0, descuentos: 0 };
          ventasPorCodigo[code].usos++;
          ventasPorCodigo[code].ventas += parseFloat(o.total || 0);
          ventasPorCodigo[code].descuentos += parseFloat(o.discount_coupon || 0);
        }
      }
      return res.status(200).json(ventasPorCodigo);
    }

    // mode === "list" (default): traer todos los cupones paginados
    let allCoupons = [];
    let page = 1;
    while (page <= 10) {
      const r = await fetch(
        `https://api.tiendanube.com/v1/${storeId}/coupons?per_page=200&page=${page}`,
        { headers }
      );
      if (!r.ok) break;
      const data = await r.json();
      if (!Array.isArray(data) || data.length === 0) break;
      allCoupons = [...allCoupons, ...data];
      if (data.length < 200) break;
      page++;
    }

    // Ordenar por usos descendente
    allCoupons.sort((a, b) => (b.used || 0) - (a.used || 0));

    res.status(200).json(allCoupons);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
