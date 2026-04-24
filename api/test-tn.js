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

  // The 3 PACKED orders have shipping_status=unshipped
  // Try: paid + open, exclude unpacked shipping_status
  // Options to try:
  const tests = {
    // Option A: paid+open without shipping filter - page 1 only, filter PACKED
    "paid_open_p1_packed": null,
    // Option B: paid+open+unshipped (maybe unshipped IS filterable without status=open?)  
    "paid_unshipped": "payment_status=paid&shipping_status=unshipped",
    // Option C: paid+open, not unpacked
    "paid_open_not_unpacked": null,
  };

  // Test B
  const rB = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?payment_status=paid&shipping_status=unshipped&per_page=10`, { headers });
  const dB = await rB.json();

  // Test C: paid+open page 1, filter by PACKED fulfillment  
  const rC = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?payment_status=paid&status=open&per_page=200`, { headers });
  const dC = await rC.json();
  const packedC = Array.isArray(dC) ? dC.filter(o => o.fulfillments?.some(f => f.status === 'PACKED')) : [];

  // Test D: no status filter, just payment=paid and shipping=unshipped
  const rD = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?payment_status=paid&shipping_status=unshipped&status=open&per_page=10`, { headers });
  const dD = await rD.json();

  res.json({
    "paid+unshipped (no status)": Array.isArray(dB) ? { count: dB.length, numbers: dB.map(o=>o.number) } : dB,
    "paid+open page1 filter PACKED": { count: packedC.length, numbers: packedC.map(o=>o.number), total_paid_open_p1: Array.isArray(dC) ? dC.length : 0 },
    "paid+unshipped+open": Array.isArray(dD) ? { count: dD.length } : dD,
  });
}
