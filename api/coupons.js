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

  const { uid, desde, hasta } = req.query;
  const { storeId, accessToken } = await getTNCredentials(uid);

  const headers = {
    'Authentication': `bearer ${accessToken}`,
    'User-Agent': 'GrowithApp (soluna.biolight@gmail.com)',
  };

  try {
    // TN filtra por created_at_min / created_at_max en formato ISO 8601
    // Ej: 2026-05-01T00:00:00-0300
    const tzOffset = "-0300"; // Argentina
    const desdeISO = desde ? `${desde}T00:00:00${tzOffset}` : null;
    const hastaISO = hasta ? `${hasta}T23:59:59${tzOffset}` : null;

    let allOrders = [];
    let page = 1;

    while (page <= 25) {
      let url = `https://api.tiendanube.com/v1/${storeId}/orders?payment_status=paid&per_page=200&page=${page}`;
      if (desdeISO) url += `&created_at_min=${encodeURIComponent(desdeISO)}`;
      if (hastaISO) url += `&created_at_max=${encodeURIComponent(hastaISO)}`;

      const r = await fetch(url, { headers });
      if (!r.ok) {
        const errText = await r.text();
        console.error('[coupons] TN error:', r.status, errText.slice(0,200));
        break;
      }
      const data = await r.json();
      if (!Array.isArray(data) || data.length === 0) break;
      allOrders = [...allOrders, ...data];
      if (data.length < 200) break;
      page++;
    }

    // Agrupar por código de cupón
    const couponMap = {};

    for (const o of allOrders) {
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
          };
        }

        couponMap[code].usosPeriodo++;
        couponMap[code].ventasPeriodo += parseFloat(o.total || 0);
        couponMap[code].descuentoPeriodo += parseFloat(o.discount_coupon || 0);
      }
    }

    const result = Object.values(couponMap).sort((a, b) => b.usosPeriodo - a.usosPeriodo);

    res.status(200).json({
      coupons: result,
      totalPedidosAnalizados: allOrders.length,
      periodo: { desde: desdeISO, hasta: hastaISO },
    });

  } catch(e) {
    console.error('[coupons]', e.message);
    res.status(500).json({ error: e.message });
  }
}
