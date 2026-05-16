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

// ─── Shopify: OAuth flow ─────────────────────────────────────────
// Una sola app de Shopify Partners para todos los clientes de Growith.
// SHOPIFY_CLIENT_ID y SHOPIFY_CLIENT_SECRET en env vars de Vercel.

const SHOPIFY_SCOPES = "read_all_orders,read_customers,read_orders,write_orders";
const APP_URL = "https://www.growithapp.com";
const SHOPIFY_REDIRECT_URI = `${APP_URL}/api/integrations?platform=shopify&action=callback`;

function normalizeShop(shopRaw) {
  let shop = String(shopRaw || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.myshopify\.com$/, "");
  return `${shop}.myshopify.com`;
}

// GET ?platform=shopify&action=oauth_start&uid=...&shop=...
// Devuelve { url } con la URL OAuth a la que redirigir al usuario
async function shopifyOauthStart(req, res) {
  const uid = req.query.uid;
  const shopRaw = req.query.shop;
  if (!uid || !shopRaw) return res.status(400).json({ error: "Faltan uid o shop" });

  const shop = normalizeShop(shopRaw);
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) {
    return res.status(400).json({ error: "Dominio inválido. Tiene que ser tipo xxxx-xx.myshopify.com" });
  }

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ error: "Falta SHOPIFY_CLIENT_ID en env vars de Vercel. Configurá la variable y redeploy." });
  }

  // state = uid (CSRF + para saber qué user es al volver)
  const state = uid;
  const url = `https://${shop}/admin/oauth/authorize?client_id=${encodeURIComponent(clientId)}&scope=${encodeURIComponent(SHOPIFY_SCOPES)}&redirect_uri=${encodeURIComponent(SHOPIFY_REDIRECT_URI)}&state=${encodeURIComponent(state)}`;
  return res.json({ url, shop });
}

// GET ?platform=shopify&action=callback&code=...&shop=...&state=...
// Recibido desde Shopify después de que el usuario autoriza. Intercambia code por access_token.
async function shopifyOauthCallback(req, res, db) {
  const { code, shop: shopRaw, state } = req.query;
  if (!code || !shopRaw || !state) {
    return res.redirect(`${APP_URL}?shopify_error=missing_params`);
  }
  const shop = normalizeShop(shopRaw);
  const uid = String(state);

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.redirect(`${APP_URL}?shopify_error=missing_env_vars`);
  }

  // 1) Intercambiar code por access_token
  let accessToken;
  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    if (!tokenRes.ok) {
      const txt = await tokenRes.text();
      console.error("[shopify-callback] token exchange failed", tokenRes.status, txt.slice(0, 200));
      return res.redirect(`${APP_URL}?shopify_error=token_failed&status=${tokenRes.status}`);
    }
    const tokenData = await tokenRes.json();
    accessToken = tokenData.access_token;
    if (!accessToken) return res.redirect(`${APP_URL}?shopify_error=no_access_token`);
  } catch (e) {
    console.error("[shopify-callback] error:", e.message);
    return res.redirect(`${APP_URL}?shopify_error=server_error`);
  }

  // 2) Obtener nombre de la tienda
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
  } catch (e) { /* ignorar — no es bloqueante */ }

  // 3) Guardar en Firestore con mutual exclusion
  try {
    const userRef = db.collection("users").doc(uid);
    const snap = await userRef.get();
    if (!snap.exists) return res.redirect(`${APP_URL}?shopify_error=user_not_found`);

    const currentStores = snap.data().stores || [];
    if (currentStores.find(s => s.type === "tiendanube")) {
      return res.redirect(`${APP_URL}?shopify_error=tn_already_connected`);
    }

    const stores = currentStores.filter(s => s.type !== "shopify");
    stores.push({
      type: "shopify",
      shop,
      accessToken,
      storeName: shopName,
      storeEmail: shopEmail,
      connectedAt: new Date().toISOString(),
    });
    await userRef.update({ stores });
  } catch (e) {
    console.error("[shopify-callback] save error:", e.message);
    return res.redirect(`${APP_URL}?shopify_error=save_failed`);
  }

  return res.redirect(`${APP_URL}?shopify_success=1`);
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
      if (action === "oauth_start" && req.method === "GET") return shopifyOauthStart(req, res);
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
