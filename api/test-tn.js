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

  // Buscar los 3 pedidos que marcaste como empaquetados
  const numbers = [1847, 1861, 1862]; // cambiá estos si son otros
  const results = {};
  
  for (const num of numbers) {
    const r = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?q=${num}&per_page=3`, { headers });
    const data = await r.json();
    const o = Array.isArray(data) ? data.find(o => o.number === num) : null;
    results[num] = o ? {
      status: o.status,
      payment_status: o.payment_status,
      shipping_status: o.shipping_status,
      fulfillments: o.fulfillments?.map(f => ({ status: f.status, shipping: f.shipping?.option?.name })) || [],
    } : "not found";
  }

  // También probar qué filtros devuelven resultados ahora
  const filterTests = {
    "fulfilled+open": "shipping_status=fulfilled&status=open",
    "unshipped+open": "shipping_status=unshipped&status=open",
    "packed+open":    "shipping_status=packed&status=open",
  };
  const filterResults = {};
  for (const [key, params] of Object.entries(filterTests)) {
    const r = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?per_page=10&${params}`, { headers });
    const d = await r.json();
    filterResults[key] = Array.isArray(d) ? { count: d.length, numbers: d.map(o=>o.number) } : d;
  }

  res.json({ orders: results, filters: filterResults });
}
