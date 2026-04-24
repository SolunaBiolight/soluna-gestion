import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
    }),
  });
  return getFirestore();
}

const FALLBACK_STORE_ID = "6978415";
const FALLBACK_TOKEN = "71be8939bf409df5b98caa80e22d7227ad288f82";

const TAB_PARAMS = {
  cobrar:     "payment_status=pending,partially_paid&status=open",
  empaquetar: "payment_status=paid&shipping_status=unpacked&status=open",
  enviar:     "shipping_status=fulfilled&status=open",
  // buscar: últimos 200 pedidos para búsqueda rápida
  buscar:     "",
};

async function fetchPage(storeId, accessToken, extraParams, page, perPage=200) {
  const headers = {
    'Authentication': `bearer ${accessToken}`,
    'User-Agent': 'GrowithApp (soluna.biolight@gmail.com)'
  };
  const url = `https://api.tiendanube.com/v1/${storeId}/orders?per_page=${perPage}&page=${page}${extraParams ? "&" + extraParams : ""}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`TN API error ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function fetchAllPages(storeId, accessToken, extraParams = "") {
  const first = await fetchPage(storeId, accessToken, extraParams, 1);
  if (first.length === 0 || first.length < 200) return first;

  const extras = await Promise.all(
    [2,3,4,5,6,7,8,9,10].map(p =>
      fetchPage(storeId, accessToken, extraParams, p).catch(() => [])
    )
  );

  let all = [...first];
  for (const page of extras) {
    if (page.length === 0) break;
    all = all.concat(page);
    if (page.length < 200) break;
  }
  return all;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { uid, tab, countOnly, q } = req.query;

  let storeId = FALLBACK_STORE_ID;
  let accessToken = FALLBACK_TOKEN;

  if (uid) {
    try {
      const db = initAdmin();
      const userSnap = await db.collection("users").doc(uid).get();
      if (userSnap.exists) {
        const tnStore = (userSnap.data().stores || []).find(s => s.type === "tiendanube");
        if (tnStore?.accessToken && tnStore?.storeId) {
          storeId = tnStore.storeId;
          accessToken = tnStore.accessToken;
        }
      }
    } catch(e) {
      console.error("Error fetching user store:", e.message);
    }
  }

  try {
    // Búsqueda directa por número o nombre
    if (q) {
      const headers = {
        'Authentication': `bearer ${accessToken}`,
        'User-Agent': 'GrowithApp (soluna.biolight@gmail.com)'
      };
      const r = await fetch(
        `https://api.tiendanube.com/v1/${storeId}/orders?q=${encodeURIComponent(q)}&per_page=20`,
        { headers }
      );
      const data = await r.json();
      res.status(200).json(Array.isArray(data) ? data : []);
      return;
    }

    const extraParams = tab && TAB_PARAMS[tab] !== undefined ? TAB_PARAMS[tab] : "";

    if (countOnly === 'true') {
      const first = await fetchPage(storeId, accessToken, extraParams, 1, 200);
      res.status(200).json(Array.from({length: first.length}, (_,i) => ({id:i})));
      return;
    }

    // Para búsqueda libre solo traer los últimos 200
    if (tab === 'buscar') {
      const orders = await fetchPage(storeId, accessToken, "", 1, 200);
      res.status(200).json(orders);
      return;
    }

    const orders = await fetchAllPages(storeId, accessToken, extraParams);
    res.status(200).json(orders);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
