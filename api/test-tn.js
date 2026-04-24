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

  // Test with status=open added + different shipped combinations
  const tests = {
    "empaquetar+open":        "payment_status=paid&shipping_status=unpacked&status=open",
    "cobrar+open":            "payment_status=pending,partially_paid&status=open",
    "enviado_shipped":        "shipping_status=shipped&status=open",
    "enviado_shipped+paid":   "shipping_status=shipped&payment_status=paid&status=open",
    "all_open_p1":            "status=open&per_page=200&page=1",
    "all_open_p2":            "status=open&per_page=200&page=2",
    "all_open_p3":            "status=open&per_page=200&page=3",
  };

  const results = {};
  for (const [key, params] of Object.entries(tests)) {
    const r = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?per_page=200&${params}`, { headers });
    const d = await r.json();
    results[key] = Array.isArray(d) ? d.length : d;
  }

  res.json(results);
}
