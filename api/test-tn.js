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

  // Test 1: does created_at_min work?
  const r1 = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?payment_status=paid&status=open&created_at_min=2025-03-01&per_page=200`, { headers });
  const d1 = await r1.json();

  // Test 2: does the response include fulfillments?
  const r2 = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?payment_status=paid&status=open&per_page=5`, { headers });
  const d2 = await r2.json();
  const sample = Array.isArray(d2) ? d2.map(o => ({
    number: o.number,
    has_fulfillments: !!o.fulfillments,
    fulfillments_count: o.fulfillments?.length,
    fulfillments_status: o.fulfillments?.map(f => f.status),
    shipping_status: o.shipping_status,
  })) : d2;

  // Test 3: the 11 pedidos that should be in empaquetar
  const known = [1868,1865,1864,1863,1862,1861,1860,1859,1857,1856];
  const oldest = known[known.length-1]; // 1856
  const r3 = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?q=${oldest}&per_page=3`, { headers });
  const d3 = await r3.json();
  const order1856 = Array.isArray(d3) ? d3.find(o=>o.number===oldest) : null;

  res.json({
    created_at_min_test: Array.isArray(d1) ? `${d1.length} results` : d1,
    fulfillments_in_response: sample,
    oldest_empaquetar: order1856 ? { created_at: order1856.created_at, shipping_status: order1856.shipping_status, fulfillments: order1856.fulfillments?.map(f=>f.status) } : "not found"
  });
}
