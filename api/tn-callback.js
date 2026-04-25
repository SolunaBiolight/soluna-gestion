// api/tn-callback.js
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const TN_CLIENT_ID = "30036";
const TN_CLIENT_SECRET = "236de957e037dc47aee7a38cf5e72ec60891a3c25c9e0ce3";
const APP_URL = "https://www.growithapp.com";

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

  console.log("[tn-callback] code:", code ? code.slice(0,8)+"..." : "MISSING");
  console.log("[tn-callback] state:", state || "MISSING");

  if (!code || !state) {
    return res.status(400).send("Faltan parámetros.");
  }

  const uid = decodeURIComponent(state);

  try {
    // 1. Intercambiar code por access_token
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

    const tokenText = await tokenRes.text();
    console.log("[tn-callback] token status:", tokenRes.status, "body:", tokenText.slice(0,200));

    if (!tokenRes.ok) {
      return res.redirect(`${APP_URL}?tn_error=token_failed&status=${tokenRes.status}`);
    }

    const tokenData = JSON.parse(tokenText);
    const { access_token, user_id } = tokenData;

    if (!access_token || !user_id) {
      console.error("[tn-callback] missing access_token or user_id:", tokenData);
      return res.redirect(`${APP_URL}?tn_error=token_invalid`);
    }

    console.log("[tn-callback] got token for user_id:", user_id);

    // 2. Obtener nombre de la tienda
    let storeName = String(user_id);
    try {
      const storeRes = await fetch(`https://api.tiendanube.com/v1/${user_id}/store`, {
        headers: {
          "Authentication": `bearer ${access_token}`,
          "User-Agent": "GrowithApp (soluna.biolight@gmail.com)",
        },
      });
      if (storeRes.ok) {
        const storeData = await storeRes.json();
        storeName = storeData.name?.es || storeData.name?.en || String(user_id);
      }
    } catch (e) {
      console.error("[tn-callback] store name error:", e.message);
    }

    // 3. Guardar en Firestore
    const db = initAdmin();
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      console.error("[tn-callback] user not found:", uid);
      return res.redirect(`${APP_URL}?tn_error=user_not_found`);
    }

    const stores = (userSnap.data().stores || []).filter(s => s.type !== "tiendanube");
    await userRef.update({
      stores: [
        ...stores,
        {
          type: "tiendanube",
          storeId: String(user_id),
          storeName,
          accessToken: access_token,
          connectedAt: new Date().toISOString(),
        },
      ],
    });

    console.log("[tn-callback] tienda conectada OK:", storeName);
    return res.redirect(`${APP_URL}?tn_success=1`);

  } catch (e) {
    console.error("[tn-callback] error:", e.message, e.stack);
    return res.redirect(`${APP_URL}?tn_error=server_error`);
  }
}
