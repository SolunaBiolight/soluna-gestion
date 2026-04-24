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

// Filtros confirmados contra la API real de TN
const TAB_PARAMS = {
  cobrar:     "payment_status=pending,partially_paid&status=open",
  empaquetar: "payment_status=paid&shipping_status=unpacked&status=open",
  enviar:     "shipping_status=fulfilled&status=open",
  enviado:    "shipping_status=shipped",
  entregado:  "shipping_status=delivered",
};

async function fetchAllPages(storeId, accessToken, extraParams = "") {
  const headers = {
    'Authentication': `bearer ${accessToken}`,
    'User-Agent': 'GrowithApp (soluna.biolight@gmail.com)'
  };

  const buildUrl = (page) =>
    `https://api.tiendanube.com/v1/${storeId}/orders?per_page=200&page=${page}${extraParams ? "&" + extraParams : ""}`;

  const firstRes = await fetch(buildUrl(1), { headers });
  if (!firstRes.ok) {
    const err = await firstRes.json().catch(() => ({}));
    // 404 "Last page is 0" = no results, not an error
    if (firstRes.status === 404) return [];
    throw new Error(`TN API error ${firstRes.status}: ${err.message || "Unknown"}`);
  }
  const firstData = await firstRes.json();
  if (!Array.isArray(firstData) || firstData.length === 0) return [];
  if (firstData.length < 200) return firstData;

  // Traer páginas restantes en paralelo
  const extraPages = await Promise.all(
    [2,3,4,5,6,7,8,9,10].map(p =>
      fetch(buildUrl(p), { headers })
        .then(r => r.ok ? r.json() : [])
        .then(d => Array.isArray(d) ? d : [])
        .catch(() => [])
    )
  );

  let all = [...firstData];
  for (const page of extraPages) {
    if (page.length === 0) break;
    all = all.concat(page);
    if (page.length < 200) break;
  }
  return all;
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
    const extraParams = tab && TAB_PARAMS[tab] ? TAB_PARAMS[tab] : "";
    const orders = await fetchAllPages(storeId, accessToken, extraParams);
    res.status(200).json(orders);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
