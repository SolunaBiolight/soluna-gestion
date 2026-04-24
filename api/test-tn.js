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

  const numbers = [1847, 1867, 1869];
  const orders = {};
  for (const num of numbers) {
    const r = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?q=${num}&per_page=3`, { headers });
    const data = await r.json();
    const o = Array.isArray(data) ? data.find(o => o.number === num) : null;
    orders[num] = o ? {
      status: o.status,
      payment_status: o.payment_status,
      shipping_status: o.shipping_status,
      fulfillments: o.fulfillments?.map(f => ({ status: f.status, shipping: f.shipping?.option?.name })) || [],
    } : "not found";
  }

  // Test all shipping_status values that might match
  const tests = {
    "fulfilled+open":    "shipping_status=fulfilled&status=open&per_page=10",
    "unshipped+open":    "shipping_status=unshipped&status=open&per_page=10",
    "packed+open":       "shipping_status=packed&status=open&per_page=10",
    "ready_to_ship":     "shipping_status=ready_to_ship&per_page=10",
    "label_purchased":   "shipping_status=label_purchased&per_page=10",
    "awaiting_pickup":   "shipping_status=awaiting_pickup&per_page=10",
    "booked":            "shipping_status=booked&per_page=10",
  };
  const filters = {};
  for (const [key, params] of Object.entries(tests)) {
    const r = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?${params}`, { headers });
    const d = await r.json();
    filters[key] = Array.isArray(d) ? { count: d.length, numbers: d.map(o=>o.number) } : { error: d?.message || d?.code };
  }

  res.json({ orders, filters });
}
