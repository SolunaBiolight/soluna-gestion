// api/google-ads.js
// Integración Google Ads — OAuth + estado de conexión.
// Requiere en Vercel: GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET (OAuth de un
// proyecto de Google Cloud con la Google Ads API habilitada) y
// GOOGLE_ADS_DEVELOPER_TOKEN (se pide desde el centro de API de una cuenta
// administrador de Google Ads). Opcional: GOOGLE_ADS_LOGIN_CUSTOMER_ID (id del
// MCC, sin guiones) si las cuentas cuelgan de un administrador.
// El gasto se lee en api/orders.js (fetchGoogleAdsAuto) — acá solo vive el OAuth.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createHmac } from "crypto";
import { guardUid } from "./_auth.js";

const APP_URL = "https://www.growithapp.com";
export const GADS_REDIRECT = `${APP_URL}/api/google-ads-callback`;

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({
    credential: cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
    }),
  });
  return getFirestore();
}

// state firmado (mismo esquema que meta.js): uid.HMAC(uid) — el callback lo verifica.
export function signGadsState(uid) {
  const secret = process.env.GOOGLE_ADS_CLIENT_SECRET || "";
  return `${uid}.${createHmac("sha256", secret).update(String(uid)).digest("hex").slice(0, 32)}`;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = req.query?.action;
  const uid = req.query?.uid;
  if (!uid) return res.status(400).json({ error: "Falta uid" });
  // El token tiene que pertenecer al uid pedido (o a su equipo / a un admin):
  // con verifyAuth a secas, cualquier cliente logueado podía firmar un state de
  // OAuth para otra cuenta o desconectarle Google Ads.
  if (!(await guardUid(req, res, uid))) return;

  try {
    const db = initAdmin();

    if (action === "oauth_start" && req.method === "GET") {
      const cid = process.env.GOOGLE_ADS_CLIENT_ID;
      if (!cid || !process.env.GOOGLE_ADS_CLIENT_SECRET) {
        return res.status(400).json({ error: "faltan_credenciales", detail: "Faltan GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET en Vercel. Creá las credenciales OAuth en Google Cloud (con la Google Ads API habilitada) y cargalas." });
      }
      const params = new URLSearchParams({
        client_id: cid,
        redirect_uri: GADS_REDIRECT,
        response_type: "code",
        scope: "https://www.googleapis.com/auth/adwords",
        access_type: "offline",   // devuelve refresh_token (dura hasta que se revoque)
        prompt: "consent",        // fuerza refresh_token aunque ya haya consentido antes
        state: signGadsState(uid),
      });
      return res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
    }

    if (action === "status" && req.method === "GET") {
      const snap = await db.collection("users").doc(uid).get();
      const g = snap.data()?.googleAds || null;
      return res.json({ connected: !!g?.refresh_token, customers: g?.customers || [], connectedAt: g?.connectedAt || null,
        hasCreds: !!(process.env.GOOGLE_ADS_CLIENT_ID && process.env.GOOGLE_ADS_CLIENT_SECRET),
        hasDevToken: !!process.env.GOOGLE_ADS_DEVELOPER_TOKEN });
    }

    if (action === "disconnect" && req.method === "POST") {
      await db.collection("users").doc(uid).set({ googleAds: null }, { merge: true });
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: "Acción inválida" });
  } catch (e) {
    console.error("google-ads error:", e);
    return res.status(500).json({ error: e.message });
  }
}
