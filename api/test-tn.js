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

  // Get all paid+open orders and find sucursal ones
  const r = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?payment_status=paid&status=open&per_page=200`, { headers });
  const orders = await r.json();
  
  if(!Array.isArray(orders)) return res.json({ error: orders });

  // Find sucursal orders (Punto de retiro)
  const sucursalOrders = orders.filter(o => o.shipping_option === "Punto de retiro");
  
  res.json({
    total_paid_open: orders.length,
    sucursal_count: sucursalOrders.length,
    sucursales: sucursalOrders.map(o => ({
      number: o.number,
      pickup_name: o.shipping_pickup_details?.name,
      pickup_address: o.shipping_pickup_details?.address?.address,
      pickup_number: o.shipping_pickup_details?.address?.number,
      pickup_locality: o.shipping_pickup_details?.address?.locality,
      fulfillment_option: o.fulfillments?.[0]?.shipping?.option?.name,
    }))
  });
}
