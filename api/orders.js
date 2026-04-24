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

// Mapeo exacto de tabs TN → parámetros de la API
const TAB_PARAMS = {
  cobrar:     { payment_status: "pending,partially_paid" },
  empaquetar: { payment_status: "paid,partially_paid,partially_refunded", shipping_status: "unpacked,partially_shipped" },
  enviar:     { payment_status: "paid,partially_refunded", shipping_status: "ready_to_ship,partially_shipped" },
  enviado:    { shipping_status: "shipped" },
  entregado:  { shipping_status: "delivered" },
};

async function fetchAllPages(storeId, accessToken, params = {}) {
  const buildUrl = (page) => {
    const qs = new URLSearchParams({ per_page: "200", page: String(page), ...params });
    return `https://api.tiendanube.com/v1/${storeId}/orders?${qs}`;
  };

  const headers = {
    'Authentication': `bearer ${accessToken}`,
    'User-Agent': 'GrowithApp (soluna.biolight@gmail.com)'
  };

  const firstRes = await fetch(buildUrl(1), { headers });
  const firstData = await firstRes.json();
  if (!Array.isArray(firstData) || firstData.length === 0) return [];
  if (firstData.length < 200) return firstData;

  // Traer páginas restantes en paralelo
  const extraPages = await Promise.all(
    [2, 3, 4, 5, 6, 7, 8, 9, 10].map(p =>
      fetch(buildUrl(p), { headers })
        .then(r => r.json())
        .then(d => Array.isArray(d) ? d : [])
        .catch(() => [])
    )
  );

  let allOrders = [...firstData];
  for (const page of extraPages) {
    if (page.length === 0) break;
    allOrders = allOrders.concat(page);
    if (page.length < 200) break;
  }

  return allOrders;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { uid, tab } = req.query;

  let storeId = FALLBACK_STORE_ID;
  let accessToken = FALLBACK_TOKEN;

  if (uid) {
    try {
      const db = initAdmin();
      const userSnap = await db.collection("users").doc(uid).get();
      if (userSnap.exists) {
        const userData = userSnap.data();
        const tnStore = (userData.stores || []).find(s => s.type === "tiendanube");
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
    const params = tab && TAB_PARAMS[tab] ? TAB_PARAMS[tab] : {};
    const orders = await fetchAllPages(storeId, accessToken, params);
    res.status(200).json(orders);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
