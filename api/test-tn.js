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

  const r = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?q=1847&per_page=3`, { headers });
  const data = await r.json();
  const o = Array.isArray(data) ? data.find(o => o.number === 1847) : null;

  // Show ALL fields that might contain sucursal info
  res.json({
    shipping_option: o?.shipping_option,
    shipping_option_reference: o?.shipping_option_reference,
    shipping_pickup_details: o?.shipping_pickup_details,
    shipping_store_branch_name: o?.shipping_store_branch_name,
    shipping_address: o?.shipping_address,
    fulfillments_full: o?.fulfillments,
    extra_field: o?.extra,
  });
}
