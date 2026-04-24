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

  // Traer paid+open y filtrar los PACKED en backend
  const r = await fetch(
    `https://api.tiendanube.com/v1/${storeId}/orders?payment_status=paid&status=open&per_page=200`,
    { headers }
  );
  const orders = await r.json();
  
  if (!Array.isArray(orders)) return res.json({ error: orders });

  const packed = orders.filter(o => o.fulfillments?.some(f => f.status === 'PACKED'));
  const unpacked = orders.filter(o => !o.fulfillments?.some(f => f.status === 'PACKED'));

  res.json({
    total_paid_open: orders.length,
    por_enviar_PACKED: packed.length,
    packed_numbers: packed.map(o => o.number),
    por_empaquetar_rest: unpacked.length,
    sample_unpacked: unpacked.slice(0,3).map(o=>({number:o.number,shipping_status:o.shipping_status,fulfillments:o.fulfillments?.map(f=>f.status)})),
  });
}
