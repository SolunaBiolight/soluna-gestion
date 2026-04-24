// api/test-tn.js — endpoint temporal de debug, eliminar después
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
  if (!uid) return res.status(400).json({ error: "Falta uid. Usá /api/test-tn?uid=TU_UID" });

  const db = initAdmin();
  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists) return res.status(404).json({ error: "Usuario no encontrado" });

  const tnStore = (userSnap.data().stores || []).find(s => s.type === "tiendanube");
  if (!tnStore) return res.status(404).json({ error: "No hay tienda TN conectada" });

  const { storeId, accessToken } = tnStore;
  const headers = {
    'Authentication': `bearer ${accessToken}`,
    'User-Agent': 'GrowithApp (soluna.biolight@gmail.com)'
  };

  const tests = [
    "orders?per_page=3&fields=id,number,payment_status,shipping_status,status",
    "orders?per_page=1&payment_status=paid&shipping_status=unpacked",
    "orders?per_page=1&payment_status=paid,partially_paid&shipping_status=unpacked",
    "orders?per_page=1&payment_status[]=paid&payment_status[]=partially_paid&shipping_status[]=unpacked",
  ];

  const results = {};
  for (const t of tests) {
    try {
      const r = await fetch(`https://api.tiendanube.com/v1/${storeId}/${t}`, { headers });
      const data = await r.json();
      results[t] = {
        httpStatus: r.status,
        count: Array.isArray(data) ? data.length : null,
        data: Array.isArray(data) ? data.map(o => ({
          number: o.number,
          payment_status: o.payment_status,
          shipping_status: o.shipping_status,
          status: o.status,
        })) : data
      };
    } catch(e) {
      results[t] = { error: e.message };
    }
  }

  res.json({ storeId, results });
}
