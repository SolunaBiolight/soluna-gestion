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

  // Get full detail of order 1847 to see all fields
  const r1 = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?q=1847&per_page=3`, { headers });
  const orders = await r1.json();
  const o = Array.isArray(orders) ? orders.find(o=>o.number===1847) : null;

  // Test all possible filter combos that could give 1 result
  const tests = {
    "packed+open":           "shipping_status=packed&status=open",
    "unshipped+fulfilled":   "shipping_status=unshipped,fulfilled&status=open",
    "ready_to_ship+open":    "shipping_status=ready_to_ship&status=open",
    "label_purchased":       "shipping_status=label_purchased&status=open",
    "pending_fulfillment":   "shipping_status=pending_fulfillment&status=open",
  };

  const results = {};
  for (const [key, params] of Object.entries(tests)) {
    const r = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?per_page=5&${params}`, { headers });
    const d = await r.json();
    results[key] = Array.isArray(d) ? { count: d.length, numbers: d.map(o=>o.number) } : d;
  }

  res.json({
    order_1847_full: o ? {
      number: o.number,
      status: o.status,
      payment_status: o.payment_status,
      shipping_status: o.shipping_status,
      fulfillments: o.fulfillments?.map(f=>({status:f.status,shipping:f.shipping?.option?.name})),
    } : "not found",
    filter_tests: results
  });
}
