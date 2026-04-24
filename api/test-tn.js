import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({ credential: cert({ projectId: process.env.FIREBASE_PROJECT_ID, clientEmail: process.env.FIREBASE_CLIENT_EMAIL, privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, "") }) });
  return getFirestore();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { uid } = req.query;
  const db = initAdmin();
  const userSnap = await db.collection("users").doc(uid).get();
  const tnStore = (userSnap.data()?.stores || []).find(s => s.type === "tiendanube");
  const { storeId, accessToken } = tnStore;
  const headers = { 'Authentication': `bearer ${accessToken}`, 'User-Agent': 'GrowithApp (soluna.biolight@gmail.com)' };

  // Get exact status of the 3 PACKED orders
  const results = {};
  for (const num of [1847, 1867, 1869]) {
    const r = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?q=${num}&per_page=3`, { headers });
    const d = await r.json();
    const o = Array.isArray(d) ? d.find(o => o.number === num) : null;
    results[num] = o ? { shipping_status: o.shipping_status, status: o.status, fulfillments: o.fulfillments?.map(f=>f.status) } : "not found";
  }

  // Try fetching with each possible shipping_status that these orders might have
  const statusValues = ["fulfilled","packed","ready","booked","handling","label_created","picked_up"];
  const statusTests = {};
  for (const ss of statusValues) {
    const r = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?shipping_status=${ss}&status=open&per_page=5`, { headers });
    const d = await r.json();
    statusTests[ss] = Array.isArray(d) ? d.length : (d?.code || "error");
  }

  res.json({ packed_orders: results, status_tests: statusTests });
}
