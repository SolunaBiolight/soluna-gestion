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

  // Test empaquetar: paid + unpacked + open
  const r1 = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?payment_status=paid&shipping_status=unpacked&status=open&per_page=200`, { headers });
  const d1 = await r1.json();

  // Test enviar: unshipped + open, filter PACKED
  const r2 = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?shipping_status=unshipped&status=open&per_page=200`, { headers });
  const d2 = await r2.json();
  const packed = Array.isArray(d2) ? d2.filter(o => o.fulfillments?.some(f => f.status === 'PACKED')) : [];

  res.json({
    empaquetar: { count: Array.isArray(d1) ? d1.length : null, numbers: Array.isArray(d1) ? d1.map(o=>o.number) : d1 },
    enviar: { total_unshipped: Array.isArray(d2) ? d2.length : null, packed_count: packed.length, packed_numbers: packed.map(o=>o.number) }
  });
}
