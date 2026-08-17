// api/google-ads-callback.js
// Callback OAuth de Google Ads — mismo patrón que meta-callback.js.
// Google redirige acá con code+state → intercambiamos por refresh_token →
// listamos las cuentas accesibles → guardamos en users/{uid}.googleAds.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createHmac, timingSafeEqual } from "crypto";

const APP_URL = "https://www.growithapp.com";
const REDIRECT_URI = `${APP_URL}/api/google-ads-callback`;

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

function verifyState(state) {
  const [uid, sig] = String(state || "").split(".");
  if (!uid || !sig) return null;
  const secret = process.env.GOOGLE_ADS_CLIENT_SECRET || "";
  const expected = createHmac("sha256", secret).update(uid).digest("hex").slice(0, 32);
  try {
    if (sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return uid;
  } catch (_) {}
  return null;
}

export default async function handler(req, res) {
  const { code, state, error } = req.query || {};
  if (error) return res.redirect(`${APP_URL}/?gads=cancelled#/config`);
  if (!code || !state) return res.redirect(`${APP_URL}/?gads=bad_request#/config`);

  const uid = verifyState(state);
  if (!uid) return res.redirect(`${APP_URL}/?gads=bad_state#/config`);

  try {
    // 1) code → tokens (el refresh_token es lo que persiste)
    const tr = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_ADS_CLIENT_ID || "",
        client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET || "",
        code: String(code),
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      }),
    });
    const tj = await tr.json();
    if (!tr.ok || !tj.refresh_token) {
      console.error("gads token exchange:", tj);
      return res.redirect(`${APP_URL}/?gads=token_failed#/config`);
    }

    // 2) Cuentas accesibles (requiere developer token). Si el token todavía no
    // está aprobado por Google, se guarda igual la conexión y las cuentas se
    // resuelven después — el gasto queda en manual hasta entonces.
    let customers = [];
    const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    if (devToken) {
      try {
        const cr = await fetch("https://googleads.googleapis.com/v25/customers:listAccessibleCustomers", {
          headers: { Authorization: `Bearer ${tj.access_token}`, "developer-token": devToken },
        });
        if (cr.ok) {
          const cj = await cr.json();
          customers = (cj.resourceNames || []).map(r => String(r).replace("customers/", ""));
        } else {
          console.error("gads listAccessibleCustomers HTTP", cr.status, (await cr.text().catch(()=>"")).slice(0, 300));
        }
      } catch (e) { console.error("gads customers:", e.message); }
    }

    const db = initAdmin();
    await db.collection("users").doc(uid).set({
      googleAds: {
        connected: true,
        refresh_token: tj.refresh_token,
        customers,
        connectedAt: new Date().toISOString(),
      },
    }, { merge: true });

    return res.redirect(`${APP_URL}/?gads=ok#/config`);
  } catch (e) {
    console.error("google-ads-callback:", e);
    return res.redirect(`${APP_URL}/?gads=server_error#/config`);
  }
}
