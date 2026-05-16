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

// ─── Shopify: conectar con custom app token ─────────────────────

async function shopifyConnect(req, res, db) {
  const body = JSON.parse((await readBody(req)).toString());
  const { uid, shop: shopRaw, access_token, client_id } = body;
  if (!uid || !shopRaw || !access_token || !client_id) {
    return res.status(400).json({ error: "Faltan uid, shop, access_token o client_id" });
  }

  // Normalizar shop: aceptar "mitienda.myshopify.com", "mitienda", "https://mitienda.myshopify.com", "xxxx-xx"
  let shop = String(shopRaw).trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.myshopify\.com$/, "");
  shop = `${shop}.myshopify.com`;

  // Validar token llamando a /admin/api/2024-10/shop.json
  const url = `https://${shop}/admin/api/2024-10/shop.json`;
  let shopName, shopEmail;
  try {
    const r = await fetch(url, {
      headers: { "X-Shopify-Access-Token": String(access_token).trim(), "Content-Type": "application/json" },
    });
    if (r.status === 401 || r.status === 403) {
      return res.status(401).json({ error: "Token inválido o sin permisos. Verificá que la app en Dev Dashboard tenga los scopes: read_all_orders, read_customers, read_orders, write_orders." });
    }
    if (r.status === 404) {
      return res.status(404).json({ error: `No se encontró la tienda ${shop}. Verificá el dominio.` });
    }
    if (!r.ok) {
      const txt = await r.text();
      return res.status(502).json({ error: `Shopify rechazó la conexión (HTTP ${r.status}): ${txt.slice(0, 200)}` });
    }
    const data = await r.json();
    shopName = data.shop?.name || shop;
    shopEmail = data.shop?.email || "";
  } catch (e) {
    return res.status(502).json({ error: `No se pudo conectar a ${shop}: ${e.message}` });
  }

  // Guardar en users/{uid}.stores[]
  const userRef = db.collection("users").doc(uid);
  const snap = await userRef.get();
  if (!snap.exists) return res.status(404).json({ error: "Usuario no encontrado" });

  // Mutual exclusion: una sola plataforma de e-commerce conectada por vez
  const currentStores = snap.data().stores || [];
  if (currentStores.find(s => s.type === "tiendanube")) {
    return res.status(409).json({ error: "Ya tenés Tienda Nube conectada. Desvinculala primero para conectar Shopify." });
  }

  const stores = currentStores.filter(s => s.type !== "shopify");
  stores.push({
    type: "shopify",
    shop,                                     // ej. "mitienda.myshopify.com"
    clientId: String(client_id).trim(),       // Client ID de la app en Dev Dashboard del cliente
    accessToken: String(access_token).trim(),
    storeName: shopName,
    storeEmail: shopEmail,
    connectedAt: new Date().toISOString(),
  });
  await userRef.update({ stores });

  return res.json({ ok: true, shop, storeName: shopName });
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
      if (action === "connect" && req.method === "POST") return shopifyConnect(req, res, db);
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
