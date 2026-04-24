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
  if (!tnStore) return res.status(404).json({ error: "No hay tienda TN" });

  const { storeId, accessToken } = tnStore;
  const headers = {
    'Authentication': `bearer ${accessToken}`,
    'User-Agent': 'GrowithApp (soluna.biolight@gmail.com)'
  };

  // Test exact queries TN uses for each tab
  const tests = {
    // What TN shows as "Por empaquetar" (13 orders)
    empaquetar_v1: "orders?per_page=5&payment_status=paid&shipping_status=unpacked",
    empaquetar_v2: "orders?per_page=5&payment_status=paid,partially_paid,partially_refunded&shipping_status=unpacked,partially_shipped",
    // Check raw fields of first 3 orders
    raw_fields: "orders?per_page=3&fields=id,number,status,payment_status,shipping_status,fulfillments",
    // Count by status combos
    cobrar: "orders?per_page=5&payment_status=pending,partially_paid",
  };

  const results = {};
  for (const [key, path] of Object.entries(tests)) {
    try {
      const r = await fetch(`https://api.tiendanube.com/v1/${storeId}/${path}`, { headers });
      const data = await r.json();
      results[key] = {
        count: Array.isArray(data) ? data.length : null,
        sample: Array.isArray(data) ? data.map(o => ({
          number: o.number,
          status: o.status,
          payment_status: o.payment_status,
          shipping_status: o.shipping_status,
        })) : data
      };
    } catch(e) {
      results[key] = { error: e.message };
    }
  }

  res.json(results);
}
