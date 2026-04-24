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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: "Falta uid" });

  const db = initAdmin();
  const userSnap = await db.collection("users").doc(uid).get();
  const tnStore = (userSnap.data()?.stores || []).find(s => s.type === "tiendanube");
  const { storeId, accessToken } = tnStore;
  const headers = {
    'Authentication': `bearer ${accessToken}`,
    'User-Agent': 'GrowithApp (soluna.biolight@gmail.com)'
  };

  // Get TOTAL count for each tab with per_page=200 page=1
  const tabs = {
    empaquetar: "payment_status=paid&shipping_status=unpacked",
    cobrar:     "payment_status=pending,partially_paid",
    enviar:     "payment_status=paid&shipping_status=ready_to_ship",
    enviado:    "shipping_status=shipped",
    entregado:  "shipping_status=delivered",
  };

  const results = {};
  for (const [tab, params] of Object.entries(tabs)) {
    // Page 1
    const r1 = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?per_page=200&page=1&${params}`, { headers });
    const d1 = await r1.json();
    const p1count = Array.isArray(d1) ? d1.length : 0;

    // Page 2
    const r2 = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?per_page=200&page=2&${params}`, { headers });
    const d2 = await r2.json();
    const p2count = Array.isArray(d2) ? d2.length : 0;

    results[tab] = { page1: p1count, page2: p2count, total: p1count + p2count };
  }

  res.json(results);
}
