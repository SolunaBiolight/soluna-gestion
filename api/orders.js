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

// Fallback: Soluna Biolight hardcoded (para cuando no hay uid)
const FALLBACK_STORE_ID = "6978415";
const FALLBACK_TOKEN = "71be8939bf409df5b98caa80e22d7227ad288f82";

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { uid } = req.query;

  let storeId = FALLBACK_STORE_ID;
  let accessToken = FALLBACK_TOKEN;

  // Si hay uid, buscar el token del usuario en Firestore
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
    let allOrders = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await fetch(
        `https://api.tiendanube.com/v1/${storeId}/orders?per_page=200&page=${page}`,
        {
          headers: {
            'Authentication': `bearer ${accessToken}`,
            'User-Agent': 'SolunaGestion (soluna.biolight@gmail.com)'
          }
        }
      );
      const data = await response.json();
      if (!Array.isArray(data) || data.length === 0) {
        hasMore = false;
      } else {
        allOrders = allOrders.concat(data);
        if (data.length < 200) hasMore = false;
        else page++;
      }
    }

    res.status(200).json(allOrders);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
