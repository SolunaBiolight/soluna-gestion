// api/tn-callback.js
// Tienda Nube OAuth callback — recibe el code, lo intercambia por access_token
// y lo guarda en Firestore bajo users/{uid}/stores

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const TN_CLIENT_ID = "30036";
const TN_CLIENT_SECRET = "236de957e037dc47aee7a38cf5e72ec60891a3c25c9e0ce3";

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

export default async function handler(req, res) {
  const { code, state } = req.query;

  if (!code || !state) {
    return res.status(400).send("Faltan parámetros.");
  }

  const uid = decodeURIComponent(state);

  try {
    // Intercambiar code por access_token con Tienda Nube
    const tokenRes = await fetch("https://www.tiendanube.com/apps/authorize/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: TN_CLIENT_ID,
        client_secret: TN_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error("TN token error:", err);
      return res.redirect(`https://www.growithapp.com?tn_error=token_failed`);
    }

    const tokenData = await tokenRes.json();
    const { access_token, user_id } = tokenData;

    // Obtener info de la tienda
    let storeName = "";
    try {
      const storeRes = await fetch(`https://api.tiendanube.com/v1/${user_id}/store`, {
        headers: {
          "Authentication": `bearer ${access_token}`,
          "User-Agent": "SolunaGestion/1.0",
        },
      });
      if (storeRes.ok) {
        const storeData = await storeRes.json();
        storeName = storeData.name?.es || storeData.name?.en || String(user_id);
      }
    } catch (e) {}

    // Guardar en Firestore
    const db = initAdmin();
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return res.redirect(`https://www.growithapp.com?tn_error=user_not_found`);
    }

    const stores = userSnap.data().stores || [];
    const filtered = stores.filter(s => s.type !== "tiendanube");
    await userRef.update({
      stores: [
        ...filtered,
        {
          type: "tiendanube",
          storeId: String(user_id),
          storeName,
          accessToken: access_token,
          connectedAt: new Date().toISOString(),
        },
      ],
    });

    // Redirigir de vuelta a la app con éxito
    return res.redirect(`https://www.growithapp.com?tn_success=1`);

  } catch (e) {
    console.error("TN callback error:", e);
    return res.redirect(`https://www.growithapp.com?tn_error=server_error`);
  }
}
