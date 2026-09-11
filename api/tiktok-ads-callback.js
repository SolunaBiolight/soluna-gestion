// api/tiktok-ads-callback.js
// Callback OAuth de TikTok Ads (TikTok for Business Marketing API v1.3) — mismo
// patrón que google-drive-callback.js / google-ads-callback.js.
// Flujo: el usuario va a https://business-api.tiktok.com/portal/auth (misma
// pestaña) → autoriza → TikTok redirige acá con auth_code+state → canjeamos por
// access_token (long-lived, no vence solo) → listamos advertisers → guardamos en
// users/{uid}.tiktokAds → volvemos a Config.
//
// Config necesaria (una vez, en la app de TikTok for Business Developers):
//   Vercel env  TIKTOK_APP_ID  y  TIKTOK_APP_SECRET
//   App de TikTok → "Advertiser redirect URL": https://www.growithapp.com/api/tiktok-ads-callback
//   Scopes mínimos: Ad Account Management (read) + Reporting (read).

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createHmac, timingSafeEqual } from "crypto";

export const APP_URL = "https://www.growithapp.com";
export const TIKTOK_REDIRECT_URI = `${APP_URL}/api/tiktok-ads-callback`;
const TT_API = "https://business-api.tiktok.com/open_api/v1.3";

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

export function tiktokEnv() {
  return { appId: process.env.TIKTOK_APP_ID || "", secret: process.env.TIKTOK_APP_SECRET || "" };
}

export function signTiktokState(uid) {
  return createHmac("sha256", tiktokEnv().secret).update(String(uid)).digest("hex").slice(0, 32);
}

function verifyState(state) {
  const [uid, sig] = String(state || "").split(".");
  if (!uid || !sig) return null;
  const expected = signTiktokState(uid);
  try {
    if (sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return uid;
  } catch (_) {}
  return null;
}

/** Lista de advertisers accesibles con un access_token (id + nombre). */
export async function tiktokAdvertisers(accessToken) {
  const { appId, secret } = tiktokEnv();
  const u = new URL(`${TT_API}/oauth2/advertiser/get/`);
  u.searchParams.set("app_id", appId); u.searchParams.set("secret", secret);
  const r = await fetch(u.toString(), { headers: { "Access-Token": accessToken } });
  const j = await r.json().catch(() => ({}));
  if (j.code !== 0) throw new Error(`TikTok advertiser/get: ${j.message || r.status}`);
  return (j.data?.list || []).map(a => ({ id: String(a.advertiser_id), name: a.advertiser_name || String(a.advertiser_id) }));
}

export default async function handler(req, res) {
  const { auth_code, code, state, error } = req.query || {};
  const authCode = auth_code || code;
  if (error) return res.redirect(`${APP_URL}/?tiktok=cancelled#/config`);
  if (!authCode || !state) return res.redirect(`${APP_URL}/?tiktok=bad_request#/config`);

  const uid = verifyState(state);
  if (!uid) return res.redirect(`${APP_URL}/?tiktok=bad_state#/config`);

  const { appId, secret } = tiktokEnv();
  try {
    // 1) auth_code → access_token (+ advertiser_ids)
    const tr = await fetch(`${TT_API}/oauth2/access_token/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, secret, auth_code: String(authCode) }),
    });
    const tj = await tr.json().catch(() => ({}));
    if (tj.code !== 0 || !tj.data?.access_token) {
      console.error("tiktok token exchange:", tj);
      return res.redirect(`${APP_URL}/?tiktok=token_failed#/config`);
    }
    const accessToken = tj.data.access_token;

    // 2) Nombres de las cuentas publicitarias (best-effort; si falla guardamos los ids)
    let advertisers = (tj.data.advertiser_ids || []).map(id => ({ id: String(id), name: String(id) }));
    try { const list = await tiktokAdvertisers(accessToken); if (list.length) advertisers = list; } catch (e) { console.warn("tiktok advertisers:", e.message); }

    const db = initAdmin();
    await db.collection("users").doc(uid).set({
      tiktokAds: {
        connected: true,
        access_token: accessToken,
        scope: tj.data.scope || null,
        advertisers,
        advertiser_id: advertisers[0]?.id || null, // cuenta activa por defecto
        connectedAt: new Date().toISOString(),
      },
    }, { merge: true });

    return res.redirect(`${APP_URL}/?tiktok=ok#/config`);
  } catch (e) {
    console.error("tiktok callback:", e);
    return res.redirect(`${APP_URL}/?tiktok=error#/config`);
  }
}
