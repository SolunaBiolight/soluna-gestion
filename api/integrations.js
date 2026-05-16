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

const SHOPIFY_SCOPES = "read_all_orders,read_customers,read_orders,write_orders";
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

    return res.status(501).json({
      error: `Acción no implementada: platform=${platform} action=${action}`,
      design: "Ver api/integrations/README.md",
    });
  } catch (e) {
    console.error("[integrations]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
