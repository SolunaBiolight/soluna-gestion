// api/coupons.js
// Extrae cupones y sus ventas directamente desde los pedidos
// No requiere scope read_marketing — funciona con read_orders que ya tenemos

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

async function fetchAllPaidOrders(storeId, accessToken, desde, hasta) {
  const headers = {
    'Authentication': `bearer ${accessToken}`,
    'User-Agent': 'GrowithApp (soluna.biolight@gmail.com)',
  };

  let allOrders = [];
  let page = 1;

  while (page <= 25) {
    let url = `https://api.tiendanube.com/v1/${storeId}/orders?payment_status=paid&per_page=200&page=${page}`;
    if (desde) url += `&min_date=${encodeURIComponent(desde)}`;
    if (hasta) url += `&max_date=${encodeURIComponent(hasta)}`;

    const r = await fetch(url, { headers });
    if (!r.ok) break;
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) break;
    allOrders = [...allOrders, ...data];
    if (data.length < 200) break;
    page++;
  }

  return allOrders;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { uid, desde, hasta } = req.query;
  const { storeId, accessToken } = await getTNCredentials(uid);

  try {
    // Traer todos los pedidos pagados en el rango
    const orders = await fetchAllPaidOrders(storeId, accessToken, desde, hasta);

    // También traer todos los pedidos históricos (sin filtro de fecha) para usos totales
    // Pero eso es muy pesado — mejor usar los del período y marcar los usos totales
    // como "en el período" para simplicidad. Los usos históricos no los podemos saber
    // sin traer TODO el historial.
    // Alternativa: traer los últimos 1000 pedidos para usos históricos aproximados.
    let historicOrders = orders; // por ahora mismo conjunto

    // Si no hay filtro de fechas, traer más histórico
    if (!desde && !hasta) {
      historicOrders = await fetchAllPaidOrders(storeId, accessToken, null, null);
    }

    // Agrupar por código de cupón
    const couponMap = {};

    for (const o of orders) {
      // El campo coupon en TN es un array de objetos o array vacío
      const coupons = Array.isArray(o.coupon) ? o.coupon : [];
      for (const c of coupons) {
        const code = (c.code || "").toUpperCase().trim();
        if (!code) continue;

        if (!couponMap[code]) {
          couponMap[code] = {
            code,
            type: c.type || "percentage",
            value: c.value || "0",
            usosPeriodo: 0,
            ventasPeriodo: 0,
            descuentoPeriodo: 0,
            pedidos: [],
          };
        }

        const total = parseFloat(o.total || 0);
        const descuento = parseFloat(o.discount_coupon || 0);

        couponMap[code].usosPeriodo++;
        couponMap[code].ventasPeriodo += total;
        couponMap[code].descuentoPeriodo += descuento;
        couponMap[code].pedidos.push({
          numero: o.number,
          total,
          fecha: o.created_at,
        });
      }
    }

    // Convertir a array ordenado por usos descendente
    const result = Object.values(couponMap).sort((a, b) => b.usosPeriodo - a.usosPeriodo);

    res.status(200).json({
      coupons: result,
      totalPedidosAnalizados: orders.length,
      periodo: { desde: desde || null, hasta: hasta || null },
    });

  } catch(e) {
    console.error('[coupons]', e.message);
    res.status(500).json({ error: e.message });
  }
}
