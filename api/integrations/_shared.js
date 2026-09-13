// api/integrations/shared.js
// Utilidades compartidas entre integraciones (Shopify, TN, ML)
// Diseño: ver api/integrations/README.md

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export function initAdmin() {
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

/**
 * Schema interno normalizado que esperan `parsearCSV` y `emit` en api/arca.js.
 * Cada integración debe transformar su payload nativo a este formato.
 */
export const ORDEN_SCHEMA = {
  // string — identificador único de la orden en la plataforma origen
  orderId: "string",
  // nombre del comprador
  nombre: "string",
  email: "string",
  // doc_tipo ∈ {CUIT, DNI, CF} — usar clasificarDoc() de api/arca.js
  doc_tipo: "string",
  doc_nro: "string",
  dni: "string",
  // totales (con IVA incluido)
  total: "number",
  subtotal: "number",
  descuento: "number",
  envio: "number",
  estado_pago: "string", // "paid" para facturar
  fecha: "string",
  ciudad: "string",
  provincia: "string",
  metodo_pago: "string",
  // items: array con { nombre, nombre_original, cantidad, precio (con IVA), descuento_item }
  items: "array",
};

/**
 * Guarda el access_token de una plataforma para un user+cuit.
 * TODO: encriptar con KMS antes de guardar (hoy se guardan en claro, no es seguro para producción).
 */
export async function saveIntegrationToken(db, uid, platform, data) {
  await db.collection("users").doc(uid).collection("integrations").doc(platform).set(data, { merge: true });
}

export async function loadIntegrationToken(db, uid, platform) {
  const snap = await db.collection("users").doc(uid).collection("integrations").doc(platform).get();
  return snap.exists ? snap.data() : null;
}

/**
 * Marca una orden como facturada para que no aparezca en la próxima sincronización.
 */
export async function markOrderBilled(db, uid, platform, orderId, comprobanteData) {
  await db.collection("users").doc(uid).collection("integrations_orders")
    .doc(`${platform}_${orderId}`).set({
      platform, orderId,
      billed_at: new Date().toISOString(),
      comprobante: comprobanteData,
    }, { merge: true });
}

export async function getBilledOrderIds(db, uid, platform) {
  const snap = await db.collection("users").doc(uid).collection("integrations_orders")
    .where("platform", "==", platform)
    .get();
  return new Set(snap.docs.map(d => d.data().orderId));
}

/**
 * Heredamos la heurística de clasificarDoc para mantener consistencia con el resto del código.
 * (Cuando implementemos las integraciones, importar desde api/arca.js o moverla acá).
 */
export function clasificarDoc(numStr) {
  const s = String(numStr || "").replace(/\D/g, "");
  if (s.length === 11) {
    const mult = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    const suma = mult.reduce((acc, m, i) => acc + parseInt(s[i]) * m, 0);
    const resto = suma % 11;
    const verificador = resto === 0 ? 0 : resto === 1 ? 9 : 11 - resto;
    if (verificador === parseInt(s[10])) return { doc_tipo: "CUIT", doc_nro: s };
  }
  if (s.length >= 7 && s.length <= 8) return { doc_tipo: "DNI", doc_nro: s };
  return { doc_tipo: "CF", doc_nro: "" };
}


// ── Shopify: tokens que VENCEN (apps públicas nuevas) ─────────────────────────
// Shopify exige a las apps públicas creadas desde abril-2026 (y a todas desde
// 2027) tokens offline que vencen en 1 h y se renuevan con refresh_token (90 días).
// La tienda guarda { accessToken, refreshToken, expiresAt }. Antes de usar el
// token, `ensureShopifyToken` lo renueva si está por vencer y lo persiste.
// Las tiendas con token permanente (sin refreshToken) pasan sin cambios.
export async function shopifyCentralCreds(db) {
  if (process.env.SHOPIFY_APP_ID && process.env.SHOPIFY_APP_SECRET) return { client_id: process.env.SHOPIFY_APP_ID.trim(), client_secret: process.env.SHOPIFY_APP_SECRET.trim() };
  try {
    const d = await db.collection("shopify_apps").doc("_central").get();
    if (d.exists && d.data().client_id && d.data().client_secret) return { client_id: d.data().client_id, client_secret: d.data().client_secret };
  } catch (_) {}
  return null;
}

export function shopifyTokenFields(tokenData) {
  const now = Date.now();
  const out = { accessToken: tokenData.access_token };
  if (tokenData.refresh_token) {
    out.refreshToken = tokenData.refresh_token;
    out.expiresAt = new Date(now + (Number(tokenData.expires_in) || 3600) * 1000).toISOString();
    if (tokenData.refresh_token_expires_in) out.refreshExpiresAt = new Date(now + Number(tokenData.refresh_token_expires_in) * 1000).toISOString();
    out.refreshedAt = new Date(now).toISOString();
  }
  return out;
}

const _shRefreshing = new Map(); // shop → Promise (evita dos refresh en paralelo en la misma instancia)

export async function ensureShopifyToken(db, uid, sh, opts = {}) {
  if (!sh || !sh.refreshToken || !sh.shop) return sh?.accessToken || null;
  const margin = opts.marginMs ?? 10 * 60 * 1000;
  const exp = Date.parse(sh.expiresAt || "") || 0;
  if (!opts.force && exp && Date.now() < exp - margin) return sh.accessToken;
  const key = `${uid}:${sh.shop}`;
  if (_shRefreshing.has(key)) { const r = await _shRefreshing.get(key); Object.assign(sh, r); return sh.accessToken; }
  const job = (async () => {
    // Otro proceso pudo haber renovado hace un momento: releer antes de gastar el refresh token.
    const ref = db.collection("users").doc(uid);
    const snap = await ref.get();
    const stores = (snap.data()?.stores || []);
    const cur = stores.find(s => s.type === "shopify" && s.shop === sh.shop);
    const curExp = Date.parse(cur?.expiresAt || "") || 0;
    if (cur && !opts.force && curExp && Date.now() < curExp - margin) return { accessToken: cur.accessToken, refreshToken: cur.refreshToken, expiresAt: cur.expiresAt, refreshExpiresAt: cur.refreshExpiresAt || null };
    const creds = await shopifyCentralCreds(db);
    if (!creds) return { accessToken: sh.accessToken };
    const r = await fetch(`https://${sh.shop}/admin/oauth/access_token`, {
      method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: (cur?.refreshToken || sh.refreshToken), client_id: creds.client_id, client_secret: creds.client_secret }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      console.error("[shopify-refresh]", sh.shop, r.status, JSON.stringify(j).slice(0, 200));
      await ref.set({ stores: stores.map(s => (s.type === "shopify" && s.shop === sh.shop) ? { ...s, refreshError: `${r.status} ${JSON.stringify(j).slice(0, 120)}`, refreshErrorAt: new Date().toISOString() } : s) }, { merge: true }).catch(() => {});
      return { accessToken: sh.accessToken };
    }
    const upd = { ...shopifyTokenFields(j), refreshError: null };
    await ref.set({ stores: stores.map(s => (s.type === "shopify" && s.shop === sh.shop) ? { ...s, ...upd } : s) }, { merge: true });
    return upd;
  })().finally(() => { setTimeout(() => _shRefreshing.delete(key), 1000); });
  _shRefreshing.set(key, job);
  const upd = await job;
  Object.assign(sh, upd);
  return sh.accessToken;
}

// Renueva todos los tokens de Shopify que vencen dentro de `withinMs` (cron cada 30 min).
export async function refreshAllShopifyTokens(db, withinMs = 50 * 60 * 1000) {
  const snap = await db.collection("users").get();
  let checked = 0, refreshed = 0, errors = 0;
  for (const d of snap.docs) {
    const stores = d.data().stores || [];
    for (const sh of stores) {
      if (sh.type !== "shopify" || !sh.refreshToken) continue;
      checked++;
      const exp = Date.parse(sh.expiresAt || "") || 0;
      if (exp && Date.now() < exp - withinMs) continue;
      try { const before = sh.accessToken; await ensureShopifyToken(db, d.id, sh, { marginMs: withinMs }); if (sh.accessToken !== before) refreshed++; else errors++; } catch (_) { errors++; }
    }
  }
  return { checked, refreshed, errors };
}
