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

  // Get raw fields of order #1847 specifically
  const r = await fetch(
    `https://api.tiendanube.com/v1/${storeId}/orders?q=1847&per_page=5&fields=id,number,status,payment_status,shipping_status,fulfillments`,
    { headers }
  );
  const data = await r.json();

  // Also try all possible shipping_status values
  const statusTests = ["packed","ready_to_ship","fulfilled","label_purchased","awaiting_pickup"];
  const statusResults = {};
  for (const ss of statusTests) {
    const r2 = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?per_page=5&shipping_status=${ss}&status=open`, { headers });
    const d2 = await r2.json();
    statusResults[ss] = Array.isArray(d2) ? d2.length : d2?.code || "error";
  }

  res.json({ order_1847: Array.isArray(data) ? data : data, statusTests: statusResults });
}
