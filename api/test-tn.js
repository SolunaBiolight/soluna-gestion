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

  const tests = {
    "enviar_v1": "payment_status=paid&shipping_status=ready_to_ship&status=open",
    "enviar_v2": "payment_status=paid,partially_refunded&shipping_status=ready_to_ship&status=open",
    "enviar_v3": "payment_status=paid,partially_refunded&shipping_status=ready_to_ship,partially_shipped&status=open",
    "enviar_v4": "shipping_status=ready_to_ship&status=open",
    "enviar_v5": "shipping_status=ready_to_ship,partially_shipped&status=open",
  };

  const results = {};
  for (const [key, params] of Object.entries(tests)) {
    const r = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?per_page=10&${params}`, { headers });
    const d = await r.json();
    results[key] = {
      count: Array.isArray(d) ? d.length : null,
      sample: Array.isArray(d) ? d.map(o => ({ number: o.number, payment_status: o.payment_status, shipping_status: o.shipping_status })) : d
    };
  }

  res.json(results);
}
