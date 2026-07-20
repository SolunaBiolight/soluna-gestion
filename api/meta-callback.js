// api/meta-callback.js
// OAuth callback de Meta — igual al patrón de tn-callback.js
// Flujo: usuario hace click "Conectar Meta" → redirige a Meta → Meta redirige acá
// → intercambiamos code por token de larga duración → guardamos en Firestore

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createHmac, timingSafeEqual } from "crypto";

const META_APP_ID     = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const APP_URL         = "https://www.growithapp.com";
const META_V          = "v23.0"; // mantener sincronizada con api/meta.js y api/orders.js
const REDIRECT_URI    = `${APP_URL}/api/meta-callback`;

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({
    credential: cert({
      projectId:    process.env.FIREBASE_PROJECT_ID,
      clientEmail:  process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:   process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
    }),
  });
  return getFirestore();
}

export default async function handler(req, res) {
  // Meta manda code + state como query params
  const code  = req.query?.code;
  const state = req.query?.state;
  const error = req.query?.error;

  // Usuario canceló el popup de Meta
  if (error) {
    console.log("[meta-callback] usuario canceló:", error);
    return res.redirect(`${APP_URL}?meta_error=cancelled`);
  }

  if (!code || !state) {
    return res.status(400).json({ error: "Faltan parámetros", received: req.query });
  }

  // state = "uid.firma" — la firma HMAC la genera oauth_start (api/meta.js).
  // Sin esto, cualquiera podía completar un OAuth con SU cuenta de Meta y
  // state=<uid víctima>, pisando la conexión de la víctima (CSRF de vinculación).
  const rawState = decodeURIComponent(state);
  const dot = rawState.lastIndexOf(".");
  if (dot <= 0) return res.redirect(`${APP_URL}?meta_error=bad_state`);
  const uid = rawState.slice(0, dot);
  const gotSig = rawState.slice(dot + 1);
  const expSig = createHmac("sha256", META_APP_SECRET || "").update(uid).digest("hex").slice(0, 32);
  const a = Buffer.from(gotSig), b = Buffer.from(expSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    console.error("[meta-callback] state con firma inválida");
    return res.redirect(`${APP_URL}?meta_error=bad_state`);
  }

  try {
    // 1. Intercambiar code por short-lived token
    const tokenUrl = `https://graph.facebook.com/${META_V}/oauth/access_token`;
    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id:     META_APP_ID,
        client_secret: META_APP_SECRET,
        redirect_uri:  REDIRECT_URI,
        code,
      }),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) {
      console.error("[meta-callback] token error:", tokenData.error);
      return res.redirect(`${APP_URL}?meta_error=token_failed`);
    }
    const shortToken = tokenData.access_token;

    // 2. Extender a long-lived token (~60 días)
    const longRes = await fetch(
      `https://graph.facebook.com/${META_V}/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&fb_exchange_token=${shortToken}`
    );
    const longData = await longRes.json();
    // Si el exchange a long-lived falla, NO conectar con el short-lived (~2h):
    // el usuario quedaría "conectado" y a las 2 horas todo muere sin aviso.
    if (!longData.access_token) {
      console.error("[meta-callback] exchange a long-lived falló:", JSON.stringify(longData.error || longData).slice(0, 300));
      return res.redirect(`${APP_URL}?meta_error=long_token_failed`);
    }
    const longToken = longData.access_token;
    const tokenExpiresAt = longData.expires_in
      ? new Date(Date.now() + longData.expires_in * 1000).toISOString()
      : new Date(Date.now() + 60 * 86400000).toISOString(); // default 60 días

    // 3. Traer info del usuario
    const meRes  = await fetch(`https://graph.facebook.com/${META_V}/me?fields=id,name,email&access_token=${longToken}`);
    const me     = await meRes.json();
    if (!me.id) return res.redirect(`${APP_URL}?meta_error=me_failed`);

    // 4. Traer ad accounts y páginas
    const [aaRes, pagesRes] = await Promise.all([
      fetch(`https://graph.facebook.com/${META_V}/me/adaccounts?fields=id,account_id,name,currency,account_status&limit=50&access_token=${longToken}`),
      fetch(`https://graph.facebook.com/${META_V}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&limit=50&access_token=${longToken}`),
    ]);
    const aaData    = await aaRes.json();
    const pagesData = await pagesRes.json();

    const adAccounts = aaData.data    || [];
    const pages      = pagesData.data || [];

    // 5. Guardar en Firestore bajo users/{uid}/meta_accounts/{userId}
    const db      = initAdmin();
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return res.redirect(`${APP_URL}?meta_error=user_not_found`);

    // Config base — sin ad_account ni page todavía (el usuario los elige en la UI)
    const accId = me.id;
    const accRef = db.collection("users").doc(uid).collection("meta_accounts").doc(accId);
    // Al RE-conectar, preservar la selección previa de cuenta publicitaria/página:
    // antes se escribía null (merge no protege contra nulls explícitos) y cada
    // reconexión con 2+ ad accounts borraba la elección → Ad Spend $0 en Márgenes.
    const prevSnap = await accRef.get();
    const prev = prevSnap.exists ? (prevSnap.data() || {}) : {};
    const autoAd  = adAccounts.length === 1 ? adAccounts[0] : null;
    const autoPg  = pages.length === 1 ? pages[0] : null;
    await accRef.set({
        id:          accId,
        user_id:     me.id,
        user_name:   me.name  || "—",
        email:       me.email || "",
        access_token: longToken,
        ad_accounts: adAccounts,
        pages,
        // Auto-selección si hay 1 sola; sino se conserva lo ya elegido.
        ad_account_id:   autoAd ? autoAd.id   : (prev.ad_account_id   ?? null),
        ad_account_name: autoAd ? autoAd.name : (prev.ad_account_name ?? null),
        page_id:         autoPg ? autoPg.id   : (prev.page_id   ?? null),
        page_name:       autoPg ? autoPg.name : (prev.page_name ?? null),
        page_access_token: autoPg ? autoPg.access_token : (prev.page_access_token ?? null),
        // Sin instagram_basic (fuera de esta ronda de App Review), Graph API omite
        // el campo instagram_business_account en vez de devolverlo null — el ?.
        // encadenado da "undefined", que Firestore rechaza. ?? null lo normaliza.
        ig_account_id:   (autoPg ? autoPg.instagram_business_account?.id      : prev.ig_account_id) ?? null,
        ig_username:     (autoPg ? autoPg.instagram_business_account?.username : prev.ig_username)   ?? null,
        has_token:       true,
        oauth:           true, // el cron re-extiende el token automáticamente a los 40 días
        token_invalid:   false,
        token_expires_at: tokenExpiresAt,
        token_refreshed_at: new Date().toISOString(),
        connected_at:    new Date().toISOString(),
        last_test: { ok: true, ts: new Date().toISOString(), msg: "Conectado vía OAuth" },
      }, { merge: true });

    // Marcar como cuenta activa
    await userRef.set({ meta_active_account: accId }, { merge: true });

    console.log("[meta-callback] ✓ conectado:", me.name, "| ad_accounts:", adAccounts.length, "| pages:", pages.length);
    return res.redirect(`${APP_URL}?meta_success=1`);

  } catch (e) {
    console.error("[meta-callback] error:", e.message);
    return res.redirect(`${APP_URL}?meta_error=server_error`);
  }
}
