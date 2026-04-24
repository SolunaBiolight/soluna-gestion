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

  // Get all unshipped+open orders and check their fulfillment status
  const r = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?shipping_status=unshipped&status=open&per_page=50`, { headers });
  const orders = await r.json();

  const summary = Array.isArray(orders) ? orders.map(o => ({
    number: o.number,
    shipping_status: o.shipping_status,
    fulfillments_count: o.fulfillments?.length || 0,
    fulfillments_status: o.fulfillments?.map(f => f.status) || [],
    has_packed: o.fulfillments?.some(f => f.status === 'PACKED') || false,
  })) : orders;

  const packed = summary.filter ? summary.filter(o => o.has_packed) : [];
  const not_packed = summary.filter ? summary.filter(o => !o.has_packed) : [];

  res.json({
    total_unshipped_open: Array.isArray(orders) ? orders.length : 0,
    with_PACKED_fulfillment: packed.length,
    packed_numbers: packed.map(o => o.number),
    without_packed: not_packed.length,
    sample_not_packed: not_packed.slice(0,3),
  });
}
