// api/integrations.js
// Dispatcher único de integraciones (Shopify, Tienda Nube, Mercado Libre).
// Diseño: api/integrations/README.md
//
// Un solo endpoint por límite de 12 functions del plan Vercel Hobby.
// Routing: ?platform=shopify|tiendanube|mercadolibre & ?action=connect|disconnect|...

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

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ─── Shopify: OAuth con credenciales del cliente ──────────────────
// Cada cliente trae SU client_id + client_secret de SU app de Shopify Partners.
// Growith no necesita env vars — solo orquesta el flujo OAuth con esos datos.

const SHOPIFY_SCOPES = "read_all_orders,read_customers,read_orders,write_orders,read_products";
const SHOPIFY_APP_URL = "https://www.growithapp.com";
const SHOPIFY_REDIRECT_URI = `${SHOPIFY_APP_URL}/api/integrations?platform=shopify&action=callback`;

function normalizeShop(shopRaw) {
  let shop = String(shopRaw || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.myshopify\.com$/, "");
  return `${shop}.myshopify.com`;
}

function genState() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

// POST { uid, shop, client_id, client_secret }
// Guarda credenciales temporalmente en Firestore (oauth_pending) y devuelve URL OAuth
async function shopifyOauthStart(req, res, db) {
  const body = JSON.parse((await readBody(req)).toString());
  const { uid, shop: shopRaw, client_id, client_secret } = body;
  if (!uid || !shopRaw || !client_id || !client_secret) {
    return res.status(400).json({ error: "Faltan uid, shop, client_id o client_secret" });
  }

  const shop = normalizeShop(shopRaw);
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    return res.status(400).json({ error: `Dominio inválido (${shop}). Esperado: xxxx-xx.myshopify.com o solo el subdominio` });
  }

  // Guardar credenciales temporalmente con un state random (TTL 10 min implícito)
  const state = genState();
  try {
    await db.collection("oauth_pending").doc(state).set({
      uid: String(uid),
      shop,
      client_id: String(client_id).trim(),
      client_secret: String(client_secret).trim(),
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ error: "No se pudo guardar el estado OAuth: " + e.message });
  }

  const url = `https://${shop}/admin/oauth/authorize?client_id=${encodeURIComponent(client_id.trim())}&scope=${encodeURIComponent(SHOPIFY_SCOPES)}&redirect_uri=${encodeURIComponent(SHOPIFY_REDIRECT_URI)}&state=${encodeURIComponent(state)}`;
  return res.json({ url, shop });
}

// GET ?action=callback&code=...&shop=...&state=...
// Recupera client_id + client_secret de oauth_pending y intercambia code por token
async function shopifyOauthCallback(req, res, db) {
  const { code, shop: shopRaw, state } = req.query;
  if (!code || !shopRaw || !state) {
    return res.redirect(`${SHOPIFY_APP_URL}?shopify_error=missing_params`);
  }
  const shop = normalizeShop(shopRaw);

  // 1) Recuperar credenciales del state
  let pending;
  try {
    const snap = await db.collection("oauth_pending").doc(String(state)).get();
    if (!snap.exists) return res.redirect(`${SHOPIFY_APP_URL}?shopify_error=state_not_found`);
    pending = snap.data();
    // Borrar el state usado (one-time use)
    await snap.ref.delete().catch(() => {});
  } catch (e) {
    return res.redirect(`${SHOPIFY_APP_URL}?shopify_error=state_read_failed`);
  }

  if (pending.shop !== shop) {
    return res.redirect(`${SHOPIFY_APP_URL}?shopify_error=shop_mismatch`);
  }

  const uid = pending.uid;
  const clientId = pending.client_id;
  const clientSecret = pending.client_secret;

  // 2) Intercambiar code por access_token
  let accessToken;
  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    if (!tokenRes.ok) {
      const txt = await tokenRes.text();
      console.error("[shopify-callback] token exchange failed", tokenRes.status, txt.slice(0, 200));
      return res.redirect(`${SHOPIFY_APP_URL}?shopify_error=token_failed&status=${tokenRes.status}`);
    }
    const tokenData = await tokenRes.json();
    accessToken = tokenData.access_token;
    if (!accessToken) return res.redirect(`${SHOPIFY_APP_URL}?shopify_error=no_access_token`);
  } catch (e) {
    console.error("[shopify-callback] error:", e.message);
    return res.redirect(`${SHOPIFY_APP_URL}?shopify_error=server_error`);
  }

  // 3) Obtener nombre de la tienda
  let shopName = shop, shopEmail = "";
  try {
    const infoRes = await fetch(`https://${shop}/admin/api/2024-10/shop.json`, {
      headers: { "X-Shopify-Access-Token": accessToken },
    });
    if (infoRes.ok) {
      const data = await infoRes.json();
      shopName = data.shop?.name || shop;
      shopEmail = data.shop?.email || "";
    }
  } catch (e) { /* ignorar */ }

  // 4) Guardar en Firestore con mutual exclusion
  try {
    const userRef = db.collection("users").doc(uid);
    const snap = await userRef.get();
    if (!snap.exists) return res.redirect(`${SHOPIFY_APP_URL}?shopify_error=user_not_found`);

    const currentStores = snap.data().stores || [];
    if (currentStores.find(s => s.type === "tiendanube")) {
      return res.redirect(`${SHOPIFY_APP_URL}?shopify_error=tn_already_connected`);
    }

    const stores = currentStores.filter(s => s.type !== "shopify");
    stores.push({
      type: "shopify",
      shop,
      clientId,
      accessToken,
      storeName: shopName,
      storeEmail: shopEmail,
      connectedAt: new Date().toISOString(),
    });
    await userRef.update({ stores });
  } catch (e) {
    console.error("[shopify-callback] save error:", e.message);
    return res.redirect(`${SHOPIFY_APP_URL}?shopify_error=save_failed`);
  }

  return res.redirect(`${SHOPIFY_APP_URL}?shopify_success=1`);
}

async function shopifyDisconnect(req, res, db) {
  const body = JSON.parse((await readBody(req)).toString());
  const { uid } = body;
  if (!uid) return res.status(400).json({ error: "Falta uid" });

  const userRef = db.collection("users").doc(uid);
  const snap = await userRef.get();
  if (!snap.exists) return res.status(404).json({ error: "Usuario no encontrado" });
  const stores = (snap.data().stores || []).filter(s => s.type !== "shopify");
  await userRef.update({ stores });

  return res.json({ ok: true });
}

// ─── Mercado Libre: OAuth con credenciales del cliente ────────────
// (Mismo patrón que Shopify — el cliente trae su Client ID + Secret de su app ML)
// TODO: cuando se carguen ML_CLIENT_ID/SECRET en Vercel, podemos volver al patrón
// app-única-de-Growith (revertir este commit).

const ML_REDIRECT_URI = `${SHOPIFY_APP_URL}/api/integrations?platform=mercadolibre&action=callback`;

// POST { uid, client_id, client_secret }
async function mercadolibreOauthStart(req, res, db) {
  const body = JSON.parse((await readBody(req)).toString());
  const { uid, client_id, client_secret } = body;
  if (!uid || !client_id || !client_secret) {
    return res.status(400).json({ error: "Faltan uid, client_id o client_secret" });
  }

  const state = genState();
  try {
    await db.collection("oauth_pending").doc(state).set({
      uid: String(uid),
      platform: "mercadolibre",
      client_id: String(client_id).trim(),
      client_secret: String(client_secret).trim(),
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ error: "No se pudo guardar el estado OAuth: " + e.message });
  }

  const url = `https://auth.mercadolibre.com.ar/authorization?response_type=code&client_id=${encodeURIComponent(client_id.trim())}&redirect_uri=${encodeURIComponent(ML_REDIRECT_URI)}&state=${encodeURIComponent(state)}`;
  return res.json({ url });
}

// GET ?action=callback&code=...&state=...
async function mercadolibreOauthCallback(req, res, db) {
  const { code, state, error: oauthError } = req.query;
  if (oauthError) return res.redirect(`${SHOPIFY_APP_URL}?ml_error=${encodeURIComponent(oauthError)}`);
  if (!code || !state) return res.redirect(`${SHOPIFY_APP_URL}?ml_error=missing_params`);

  let pending;
  try {
    const snap = await db.collection("oauth_pending").doc(String(state)).get();
    if (!snap.exists) return res.redirect(`${SHOPIFY_APP_URL}?ml_error=state_not_found`);
    pending = snap.data();
    await snap.ref.delete().catch(() => {});
  } catch (e) {
    return res.redirect(`${SHOPIFY_APP_URL}?ml_error=state_read_failed`);
  }
  if (pending.platform !== "mercadolibre") {
    return res.redirect(`${SHOPIFY_APP_URL}?ml_error=platform_mismatch`);
  }
  const uid = pending.uid;
  const clientId = pending.client_id;
  const clientSecret = pending.client_secret;
  if (!clientId || !clientSecret) {
    return res.redirect(`${SHOPIFY_APP_URL}?ml_error=missing_credentials`);
  }

  let tokenData;
  try {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code: String(code),
      redirect_uri: ML_REDIRECT_URI,
    });
    const tokenRes = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body: params.toString(),
    });
    if (!tokenRes.ok) {
      const txt = await tokenRes.text();
      console.error("[ml-callback] token exchange failed", tokenRes.status, txt.slice(0, 300));
      return res.redirect(`${SHOPIFY_APP_URL}?ml_error=token_failed&status=${tokenRes.status}`);
    }
    tokenData = await tokenRes.json();
  } catch (e) {
    console.error("[ml-callback] token error:", e.message);
    return res.redirect(`${SHOPIFY_APP_URL}?ml_error=server_error`);
  }

  const { access_token, refresh_token, expires_in, user_id } = tokenData;
  if (!access_token || !refresh_token) {
    return res.redirect(`${SHOPIFY_APP_URL}?ml_error=no_tokens`);
  }
  const expiresAt = Date.now() + (Number(expires_in || 21600) - 60) * 1000;

  let nickname = String(user_id || ""), email = "";
  try {
    const meRes = await fetch("https://api.mercadolibre.com/users/me", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (meRes.ok) {
      const me = await meRes.json();
      nickname = me.nickname || nickname;
      email = me.email || "";
    }
  } catch (e) { /* ignorar */ }

  try {
    const userRef = db.collection("users").doc(uid);
    const snap = await userRef.get();
    if (!snap.exists) return res.redirect(`${SHOPIFY_APP_URL}?ml_error=user_not_found`);

    const currentStores = snap.data().stores || [];
    const stores = currentStores.filter(s => s.type !== "mercadolibre");
    stores.push({
      type: "mercadolibre",
      userId: user_id,
      clientId,
      clientSecret,
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt,
      nickname,
      email,
      connectedAt: new Date().toISOString(),
    });
    await userRef.update({ stores });
  } catch (e) {
    console.error("[ml-callback] save error:", e.message);
    return res.redirect(`${SHOPIFY_APP_URL}?ml_error=save_failed`);
  }

  return res.redirect(`${SHOPIFY_APP_URL}?ml_success=1`);
}

async function mercadolibreDisconnect(req, res, db) {
  const body = JSON.parse((await readBody(req)).toString());
  const { uid } = body;
  if (!uid) return res.status(400).json({ error: "Falta uid" });

  const userRef = db.collection("users").doc(uid);
  const snap = await userRef.get();
  if (!snap.exists) return res.status(404).json({ error: "Usuario no encontrado" });
  const stores = (snap.data().stores || []).filter(s => s.type !== "mercadolibre");
  await userRef.update({ stores });

  return res.json({ ok: true });
}

// Helper para refrescar token de ML — exportable para api/arca.js u otros consumidores.
// Usa clientId/clientSecret guardados en el store del usuario (vinieron del modal de conexión).
// Devuelve { accessToken, userId } o null si no hay store ML.
export async function getValidMLToken(db, uid) {
  const userRef = db.collection("users").doc(uid);
  const snap = await userRef.get();
  if (!snap.exists) return null;
  const stores = snap.data().stores || [];
  const ml = stores.find(s => s.type === "mercadolibre");
  if (!ml) return null;

  if (ml.expiresAt && Date.now() < ml.expiresAt) {
    return { accessToken: ml.accessToken, userId: ml.userId };
  }

  if (!ml.clientId || !ml.clientSecret) throw new Error("Faltan credenciales ML en el store del usuario");
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: ml.clientId,
    client_secret: ml.clientSecret,
    refresh_token: ml.refreshToken,
  });
  const r = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: params.toString(),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`ML refresh failed (${r.status}): ${txt.slice(0, 200)}`);
  }
  const t = await r.json();
  const newStore = {
    ...ml,
    accessToken: t.access_token,
    refreshToken: t.refresh_token || ml.refreshToken,
    expiresAt: Date.now() + (Number(t.expires_in || 21600) - 60) * 1000,
  };
  const newStores = stores.map(s => s.type === "mercadolibre" ? newStore : s);
  await userRef.update({ stores: newStores });
  return { accessToken: newStore.accessToken, userId: newStore.userId };
}

// ─── Handler principal ──────────────────────────────────────────

const PLATFORMS = ["shopify", "tiendanube", "mercadolibre"];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { platform, action } = req.query;

  if (!platform || !PLATFORMS.includes(platform)) {
    return res.status(400).json({
      error: "platform requerido. Valores: " + PLATFORMS.join(", "),
      design: "Ver api/integrations/README.md",
    });
  }

  const db = initAdmin();

  try {
    if (platform === "shopify") {
      if (action === "oauth_start" && req.method === "POST") return shopifyOauthStart(req, res, db);
      if (action === "callback" && req.method === "GET") return shopifyOauthCallback(req, res, db);
      if (action === "disconnect" && req.method === "POST") return shopifyDisconnect(req, res, db);
    }

    if (platform === "mercadolibre") {
      if (action === "oauth_start" && req.method === "POST") return mercadolibreOauthStart(req, res, db);
      if (action === "callback" && req.method === "GET") return mercadolibreOauthCallback(req, res, db);
      if (action === "disconnect" && req.method === "POST") return mercadolibreDisconnect(req, res, db);
    }

    return res.status(501).json({
      error: `Acción no implementada: platform=${platform} action=${action}`,
      design: "Ver api/integrations/README.md",
    });
  } catch (e) {
    console.error("[integrations]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
