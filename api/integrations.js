// api/integrations.js
// Dispatcher único de integraciones (Shopify, Tienda Nube, Mercado Libre).
// Diseño: api/integrations/README.md
//
// Un solo endpoint por límite de 12 functions del plan Vercel Hobby.
// Routing: ?platform=shopify|tiendanube|mercadolibre & ?action=connect|disconnect|...

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { guardUid } from "./_auth.js";
import { signState } from "./tn-callback.js";
import { driveEnv, signDriveState, getValidDriveToken, DRIVE_REDIRECT_URI, DRIVE_SCOPES } from "./google-drive-callback.js";
import { tiktokEnv, signTiktokState, tiktokAdvertisers, TIKTOK_REDIRECT_URI } from "./tiktok-ads-callback.js";
import crypto from "crypto";

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

// ─── Shopify: OAuth con la app pública de Growith (1 click) ────────
// Por defecto usa las credenciales de la app pública de Growith (env
// SHOPIFY_APP_ID / SHOPIFY_APP_SECRET): el cliente solo pone su dominio
// .myshopify.com y toca Conectar, igual que Tienda Nube/Mercado Libre.
// Fallback: si el cliente manda SU client_id + client_secret (app propia de
// Shopify Partners), se usan esos — así los ya conectados siguen funcionando.

const SHOPIFY_APP_ID     = process.env.SHOPIFY_APP_ID     || "";
const SHOPIFY_APP_SECRET = process.env.SHOPIFY_APP_SECRET || "";
const SHOPIFY_SCOPES = "read_all_orders,read_customers,read_orders,write_orders,read_products";
const SHOPIFY_APP_URL = "https://www.growithapp.com";
// Shopify NO permite el query param reservado "action" en la redirect URL, así
// que la dejamos sin él. El callback llega con "platform=shopify" + el "code" que
// Shopify appendea; lo detectamos por ahí (ver dispatch en el handler).
const SHOPIFY_REDIRECT_URI = `${SHOPIFY_APP_URL}/api/integrations?platform=shopify`;

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

// HMAC del callback OAuth de Shopify: HMAC-SHA256 (hex) sobre el querystring
// ORDENADO alfabéticamente, sin los params `hmac` y `signature`. Compara en tiempo
// constante contra el `hmac` que manda Shopify. Valida que el redirect es genuino.
function verifyShopifyOauthHmac(query, secret) {
  const { hmac, signature, ...rest } = query || {};
  if (!hmac || !secret) return false;
  const message = Object.keys(rest).sort()
    .map(k => `${k}=${Array.isArray(rest[k]) ? rest[k].join(",") : rest[k]}`)
    .join("&");
  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(digest, "utf8"), Buffer.from(String(hmac), "utf8")); }
  catch { return false; }
}

// HMAC de webhook de Shopify: base64 de HMAC-SHA256 sobre el CUERPO CRUDO (bytes),
// comparado contra el header X-Shopify-Hmac-Sha256.
function verifyShopifyWebhookHmac(rawBody, hmacHeader, secret) {
  if (!hmacHeader || !secret) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  try { return crypto.timingSafeEqual(Buffer.from(digest, "utf8"), Buffer.from(String(hmacHeader), "utf8")); }
  catch { return false; }
}

// POST { uid, shop, [client_id], [client_secret] }
// Sin client_id/secret → app pública de Growith (1 click). Con ellos → app propia
// del cliente (fallback). Guarda el estado en Firestore (oauth_pending) y devuelve URL.
async function shopifyOauthStart(req, res, db) {
  const body = JSON.parse((await readBody(req)).toString());
  const { uid, shop: shopRaw } = body;
  let { client_id, client_secret } = body;
  if (!uid || !shopRaw) {
    return res.status(400).json({ error: "Faltan uid o shop" });
  }
  // Sin esto, cualquiera podía arrancar un OAuth y dejar credenciales +
  // conexión de Shopify colgando de un uid ajeno.
  if (!(await guardUid(req, res, uid))) return;

  // 1-click: si el cliente no trae SUS credenciales, usar la app pública de Growith.
  const central = !(client_id && client_secret);
  if (central) {
    client_id = SHOPIFY_APP_ID;
    client_secret = SHOPIFY_APP_SECRET;
    if (!client_id || !client_secret) {
      return res.status(500).json({ error: "La app de Shopify de Growith todavía no está configurada en el servidor. Avisale al equipo." });
    }
  }

  const shop = normalizeShop(shopRaw);
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    return res.status(400).json({
      error: `Dominio inválido (${shop}). Tenés que poner el subdominio NATIVO de Shopify (xxxx.myshopify.com), no tu dominio personalizado tipo .com o .com.ar. Buscalo en Admin → Configuración → Dominios → el que diga "Predeterminado de Shopify".`
    });
  }

  // Guardar el estado con un state random (TTL 10 min implícito). El secret de la
  // app CENTRAL no se persiste — se lee del env en el callback; solo se guarda el
  // secret cuando es una app propia del cliente.
  const state = genState();
  try {
    await db.collection("oauth_pending").doc(state).set({
      uid: String(uid),
      shop,
      client_id: String(client_id).trim(),
      client_secret: central ? null : String(client_secret).trim(),
      central,
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
  // App central: el secret vive en el env (no se persistió). App propia: en el state.
  const clientSecret = pending.central ? SHOPIFY_APP_SECRET : pending.client_secret;
  if (!clientSecret) return res.redirect(`${SHOPIFY_APP_URL}?shopify_error=no_secret`);

  // Verificar el HMAC del callback OAuth (Shopify lo firma con el secret de la app).
  // Protege contra callbacks falsificados — requisito para apps públicas.
  if (!verifyShopifyOauthHmac(req.query, clientSecret)) {
    return res.redirect(`${SHOPIFY_APP_URL}?shopify_error=bad_hmac`);
  }

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
    // Si el doc no existe (usuario nuevo), lo creamos con set+merge (no falla con
    // user_not_found ni pisa nada de lo existente).
    const currentStores = (snap.exists ? snap.data().stores : null) || [];
    if (currentStores.find(s => s.type === "tiendanube")) {
      return res.redirect(`${SHOPIFY_APP_URL}?shopify_error=tn_already_connected`);
    }

    const stores = currentStores.filter(s => s.type !== "shopify");
    stores.push({
      type: "shopify",
      shop,
      clientId,
      central: !!pending.central, // true = conectada con la app pública de Growith
      accessToken,
      storeName: shopName,
      storeEmail: shopEmail,
      connectedAt: new Date().toISOString(),
    });
    const extra = snap.exists ? {} : { uid, email: shopEmail || "", nombre: shopName || "", createdAt: new Date(), plan: "free", trialEnd: new Date(Date.now() + 14 * 864e5) };
    await userRef.set({ ...extra, stores }, { merge: true });
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
  if (!(await guardUid(req, res, uid))) return;

  const userRef = db.collection("users").doc(uid);
  const snap = await userRef.get();
  if (!snap.exists) return res.status(404).json({ error: "Usuario no encontrado" });
  const stores = (snap.data().stores || []).filter(s => s.type !== "shopify");
  await userRef.update({ stores });

  return res.json({ ok: true });
}

// ─── Webhooks OBLIGATORIOS de privacidad (compliance) de Shopify ────────────
// Toda app pública debe implementar los 3 mandatory webhooks. Se enrutan todos a
// esta misma URL y se distinguen por el header X-Shopify-Topic:
//   • customers/data_request  → el merchant pide los datos de un comprador.
//   • customers/redact        → borrar los datos de un comprador.
//   • shop/redact             → 48hs post-desinstalación, borrar TODO de esa tienda.
// HMAC obligatorio con el secret de la app: si no valida → 401 (Shopify lo exige y
// lo testea). Growith NO persiste una base de clientes (los pedidos se leen en vivo
// de la API, no se guardan), así que data_request/redact no tienen PII propia que
// entregar o borrar; shop/redact sí desconecta la tienda y borra su token.
async function shopifyCompliance(req, res, db) {
  const secret = SHOPIFY_APP_SECRET;
  const raw = await readBody(req); // Buffer crudo — necesario para el HMAC
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  if (!secret || !verifyShopifyWebhookHmac(raw, hmacHeader, secret)) {
    return res.status(401).json({ error: "HMAC inválido" });
  }
  const topic = String(req.headers["x-shopify-topic"] || "");
  let payload = {};
  try { payload = JSON.parse(raw.toString() || "{}"); } catch (_) {}
  const shopDomain = String(req.headers["x-shopify-shop-domain"] || payload.shop_domain || "").toLowerCase();

  try {
    if (topic === "shop/redact" && shopDomain) {
      // Desinstalación: desconectar esa tienda de TODO usuario que la tenga y borrar
      // su token. Los snapshots derivados (stock_cache, etc.) son por-uid y quedan
      // inertes/expiran al no haber más acceso a la tienda.
      const usersSnap = await db.collection("users").get();
      for (const d of usersSnap.docs) {
        const st = d.data().stores || [];
        const tiene = st.some(s => s.type === "shopify" && String(s.shop || "").toLowerCase() === shopDomain);
        if (tiene) {
          const keep = st.filter(s => !(s.type === "shopify" && String(s.shop || "").toLowerCase() === shopDomain));
          await d.ref.update({ stores: keep }).catch(() => {});
        }
      }
    }
    // customers/data_request y customers/redact: sin base de clientes propia →
    // nada que entregar/borrar. Se acusa recibo (200) como exige Shopify.
  } catch (e) {
    console.error("[shopify-compliance]", topic, e.message);
    // Igual respondemos 200: el HMAC ya validó; reintentar no cambia el resultado.
  }
  return res.status(200).json({ ok: true, topic });
}

// ─── Mercado Libre: OAuth con app propia de Growith (1 click) ────────
const ML_CLIENT_ID     = process.env.ML_CLIENT_ID     || "";
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET || "";
const ML_REDIRECT_URI  = `${SHOPIFY_APP_URL}/api/integrations?platform=mercadolibre&action=callback`;

// POST { uid }  — ya no necesita client_id/secret del usuario
async function mercadolibreOauthStart(req, res, db) {
  const body = JSON.parse((await readBody(req)).toString());
  const { uid } = body;
  if (!uid) return res.status(400).json({ error: "Falta uid" });
  if (!(await guardUid(req, res, uid))) return;
  if (!ML_CLIENT_ID || !ML_CLIENT_SECRET) {
    return res.status(500).json({ error: "ML_CLIENT_ID / ML_CLIENT_SECRET no configurados en el servidor." });
  }

  const state = genState();
  try {
    await db.collection("oauth_pending").doc(state).set({
      uid: String(uid),
      platform: "mercadolibre",
      client_id:     ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ error: "No se pudo guardar el estado OAuth: " + e.message });
  }

  const ML_SCOPES = "write:billing_data";
  const url = `https://auth.mercadolibre.com.ar/authorization?response_type=code&client_id=${encodeURIComponent(ML_CLIENT_ID)}&redirect_uri=${encodeURIComponent(ML_REDIRECT_URI)}&state=${encodeURIComponent(state)}&scope=${encodeURIComponent(ML_SCOPES)}`;
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
    // Si el doc del usuario no existe todavía (usuario nuevo), lo creamos acá con
    // defaults para no fallar con user_not_found. set+merge = crea si falta, sino
    // actualiza (no pisa nada de lo existente).
    const currentStores = (snap.exists ? snap.data().stores : null) || [];
    // Permitimos VARIAS cuentas de ML conectadas: solo reemplazamos si es la MISMA
    // (mismo userId de ML), sino conservamos las otras. Así podés tener el ML de una
    // tienda para ventas y el de otra para leer los pagos de MP.
    const stores = currentStores.filter(s => !(s.type === "mercadolibre" && String(s.userId) === String(user_id)));
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
    const extra = snap.exists ? {} : { uid, email: email || "", nombre: nickname || (email || "").split("@")[0] || "", createdAt: new Date(), plan: "free", trialEnd: new Date(Date.now() + 14 * 864e5) };
    await userRef.set({ ...extra, stores }, { merge: true });
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
  if (!(await guardUid(req, res, uid))) return;

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
// targetUserId (opcional): con varios ML conectados, elige cuál usar (por su
// userId de ML). Sin él, usa el primero (comportamiento anterior, 1 solo ML).
export async function getValidMLToken(db, uid, targetUserId = null) {
  const userRef = db.collection("users").doc(uid);
  const snap = await userRef.get();
  if (!snap.exists) return null;
  const stores = snap.data().stores || [];
  const mls = stores.filter(s => s.type === "mercadolibre");
  const ml = targetUserId
    ? (mls.find(s => String(s.userId) === String(targetUserId)) || mls[0])
    : mls[0];
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
    // Preservar userId original si ML no devuelve uno nuevo en el refresh
    userId: t.user_id || ml.userId,
  };
  const newStores = stores.map(s => (s.type === "mercadolibre" && String(s.userId) === String(ml.userId)) ? newStore : s);
  await userRef.update({ stores: newStores });
  return { accessToken: newStore.accessToken, userId: newStore.userId || ml.userId };
}

// ─── Handler principal ──────────────────────────────────────────

const PLATFORMS = ["shopify", "tiendanube", "mercadolibre", "googledrive", "tiktokads"];

// ── Sondeo: ¿el token de ML sirve para leer pagos de Mercado Pago? ──
// Diagnóstico para decidir cómo calcular la comisión real de MP en ventas
// que NO son de ML (Shopify/TN vía MP Checkout). Devuelve una muestra.
async function mpProbe(req, res, db) {
  const { uid, from, to } = req.query;
  if (!uid) return res.status(400).json({ error: "Falta uid" });
  // Devuelve pagos de MP y tokens de checkout de Shopify del tenant: exige binding.
  if (!(await guardUid(req, res, uid))) return;
  let tok;
  try { tok = await getValidMLToken(db, uid); } catch (e) { return res.json({ ok:false, step:"token", error:e.message }); }
  if (!tok?.accessToken) return res.json({ ok:false, step:"token", error:"Sin token ML/MP — conectá Mercado Libre" });
  const since = from || new Date(Date.now()-14*86400000).toISOString();
  const until = to || new Date().toISOString();
  const url = `https://api.mercadopago.com/v1/payments/search?sort=date_created&criteria=desc&range=date_created&begin_date=${encodeURIComponent(since)}&end_date=${encodeURIComponent(until)}&limit=30`;
  let r, body;
  try { r = await fetch(url, { headers: { Authorization: `Bearer ${tok.accessToken}` } }); } catch (e) { return res.json({ ok:false, step:"fetch", error:e.message }); }
  try { body = await r.json(); } catch (_) { body = { raw: await r.text() }; }
  if (r.status !== 200) return res.json({ ok:false, step:"mp_api", status:r.status, body });
  const sample = (body.results||[]).map(p => ({
    id: p.id, operation_type: p.operation_type, status: p.status,
    amount: p.transaction_amount,
    fee: (p.fee_details||[]).reduce((s,f)=>s+(f.amount||0),0),
    fee_types: (p.fee_details||[]).map(f=>f.type),
    external_reference: p.external_reference, order_id: p.order?.id,
    pay_method: p.payment_method_id, marketplace: p.marketplace,
    date: p.date_created,
  }));

  // Además: traer unas órdenes de Shopify con sus transacciones, para ver qué
  // campo linkea cada orden con su pago de MP (id de pago / external_reference).
  let shopifyOrders = [];
  try {
    const userSnap = await db.collection("users").doc(uid).get();
    const sh = (userSnap.data()?.stores||[]).find(s => s.type === "shopify");
    if (sh?.shop && sh?.accessToken) {
      const oRes = await fetch(`https://${sh.shop}/admin/api/2024-10/orders.json?limit=5&status=any&fields=id,name,order_number,checkout_token,cart_token,note_attributes,payment_gateway_names,total_price,created_at`, { headers: { "X-Shopify-Access-Token": sh.accessToken } });
      const oj = await oRes.json();
      for (const o of (oj.orders||[]).slice(0,5)) {
        let txs = [];
        try {
          const tRes = await fetch(`https://${sh.shop}/admin/api/2024-10/orders/${o.id}/transactions.json`, { headers: { "X-Shopify-Access-Token": sh.accessToken } });
          const tj = await tRes.json();
          txs = (tj.transactions||[]).map(t => ({ gateway:t.gateway, authorization:t.authorization, receipt_id:t.receipt?.id||t.receipt?.payment_id, amount:t.amount, kind:t.kind, status:t.status }));
        } catch(_) {}
        shopifyOrders.push({ id:o.id, name:o.name, order_number:o.order_number, checkout_token:o.checkout_token, gateways:o.payment_gateway_names, note_attributes:o.note_attributes, total:o.total_price, transactions:txs });
      }
    }
  } catch (e) { shopifyOrders = [{ error: e.message }]; }

  return res.json({ ok:true, status:r.status, total: body.paging?.total, count: sample.length, sample, shopifyOrders });
}

// Sondeo de Mercado Ads (publicidad de ML) para descubrir la estructura de la
// API y el gasto: Product Ads (PADS), Brand Ads (BADS), Display, Mercado Shops.
async function mlAdsProbe(req, res, db) {
  const { uid, from, to } = req.query;
  if (!uid) return res.status(400).json({ error: "Falta uid" });
  if (!(await guardUid(req, res, uid))) return;
  let tok;
  try { tok = await getValidMLToken(db, uid); } catch (e) { return res.json({ ok:false, step:"token", error:e.message }); }
  if (!tok?.accessToken) return res.json({ ok:false, step:"token", error:"Sin token ML — conectá Mercado Libre" });
  const headers = { Authorization: `Bearer ${tok.accessToken}`, "Api-Version": "1" };
  const date_to = to || new Date().toISOString().slice(0,10);
  const date_from = from || new Date(Date.now()-30*86400000).toISOString().slice(0,10);
  const out = { ok:true, userId: tok.userId, date_from, date_to, steps: {} };

  // 1) Advertisers por producto publicitario
  for (const product of ["PADS","BADS","DISPLAY","MSHOPS"]) {
    try {
      const r = await fetch(`https://api.mercadolibre.com/advertising/advertisers?product_id=${product}`, { headers });
      let body; try { body = await r.json(); } catch(_) { body = { raw: await r.text() }; }
      out.steps[`advertisers_${product}`] = { status: r.status, body };
    } catch(e) { out.steps[`advertisers_${product}`] = { error: e.message }; }
  }

  // 2) Si hay advertiser de Product Ads, traer campañas con métricas (cost = gasto)
  const padsAdv = out.steps.advertisers_PADS?.body?.advertisers?.[0]?.advertiser_id;
  if (padsAdv) {
    out.padsAdvertiserId = padsAdv;
    for (const path of [
      `https://api.mercadolibre.com/advertising/product_ads/campaigns?advertiser_id=${padsAdv}&date_from=${date_from}&date_to=${date_to}&metrics=clicks,prints,cost,acos&limit=20`,
      `https://api.mercadolibre.com/advertising/advertisers/${padsAdv}/product_ads/campaigns?date_from=${date_from}&date_to=${date_to}&limit=20`,
    ]) {
      try {
        const r = await fetch(path, { headers });
        let body; try { body = await r.json(); } catch(_) { body = { raw: await r.text() }; }
        out.steps[`campaigns_try_${Object.keys(out.steps).length}`] = { url: path, status: r.status, body };
        if (r.status === 200) break;
      } catch(e) { out.steps[`campaigns_err`] = { error: e.message }; }
    }
  }
  return res.json(out);
}

// Sondeo de envíos de ML: trae las últimas órdenes con el logistic_type y el
// costo real del shipment, para saber qué marcar como Flex y cuánto de envío.
async function mlShipProbe(req, res, db) {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: "Falta uid" });
  // Devuelve dirección y teléfono del comprador (PII): exige binding con el uid.
  if (!(await guardUid(req, res, uid))) return;
  let tok;
  try { tok = await getValidMLToken(db, uid); } catch (e) { return res.json({ ok:false, step:"token", error:e.message }); }
  if (!tok?.accessToken) return res.json({ ok:false, error:"Sin token ML — conectá Mercado Libre" });
  const H = { Authorization: `Bearer ${tok.accessToken}` };
  let orders = [];
  try {
    const r = await fetch(`https://api.mercadolibre.com/orders/search?seller=${tok.userId}&sort=date_desc&limit=8`, { headers: H });
    const j = await r.json();
    orders = j.results || [];
  } catch (e) { return res.json({ ok:false, step:"orders", error:e.message }); }
  const out = [];
  let fullSample = null;
  for (const o of orders.slice(0, 6)) {
    const shipId = o.shipping?.id;
    let ship = null;
    if (shipId) {
      // Sin x-format-new: formato clásico que sí trae logistic_type/costos.
      try {
        const r = await fetch(`https://api.mercadolibre.com/shipments/${shipId}`, { headers: H });
        let j; try { j = await r.json(); } catch(_) { j = { raw: await r.text() }; }
        ship = {
          status: r.status, keys: Object.keys(j||{}),
          logistic_type: j.logistic_type, mode: j.mode, ship_status: j.status,
          base_cost: j.base_cost, declared_cost: j.declared_value,
          shipping_option: j.shipping_option, costs: j.costs, logistic: j.logistic,
        };
        if (!fullSample) fullSample = j; // primer shipment completo para inspeccionar
      } catch (e) { ship = { error: e.message }; }
    }
    out.push({
      order_id: o.id, shipId, tags: o.tags, ship,
      // Importes para entender el revenue real (con descuentos/cupones).
      total_amount: o.total_amount, paid_amount: o.paid_amount, coupon: o.coupon,
      items: (o.order_items||[]).map(it => ({
        title: it.item?.title, quantity: it.quantity,
        unit_price: it.unit_price, full_unit_price: it.full_unit_price,
        sale_fee: it.sale_fee,
      })),
      // Pagos: para ver el monto REAL que pagó el cliente (post precio-por-cantidad).
      payments: (o.payments||[]).map(p => ({
        status: p.status, transaction_amount: p.transaction_amount,
        total_paid_amount: p.total_paid_amount, shipping_cost: p.shipping_cost,
        coupon_amount: p.coupon_amount, taxes_amount: p.taxes_amount,
      })),
    });
  }
  return res.json({ ok:true, userId: tok.userId, count: out.length, orders: out, fullSample });
}

// ─── Reclamos + contracargos MP/ML → tablero de Reclamos ────────────────────
// Trae automáticamente al tablero (colección `reclamos`): contracargos de MP,
// disputas/mediaciones de MP y reclamos de Mercado Libre. Reusa el token de ML
// (que también autentica contra la API de MP para el mismo vendedor). Cada
// fuente es INDEPENDIENTE: si una falla por scope/permisos, se saltea y se
// reporta, sin romper las demás. Idempotente: doc-id determinístico por origen
// → nunca duplica, y en re-sync NO pisa lo que el usuario editó a mano (estado,
// notas, resolución); solo refresca el estado del origen.
async function reclamosSync(req, res, db) {
  const uid = req.query.uid || req.body?.uid;
  const debug = req.query.debug === "1";
  if (!uid) return res.status(400).json({ error: "Falta uid" });
  if (!(await guardUid(req, res, uid))) return;

  let tok;
  try { tok = await getValidMLToken(db, uid); }
  catch (e) { return res.json({ ok: false, step: "token", error: e.message }); }
  if (!tok?.accessToken) return res.json({ ok: false, step: "token", error: "Sin token ML/MP — conectá Mercado Libre" });

  const auth = { Authorization: `Bearer ${tok.accessToken}` };
  const since = new Date(Date.now() - 90 * 86400000);
  const sinceISO = since.toISOString();
  const untilISO = new Date().toISOString();
  const now = new Date().toISOString();
  const report = { mp_contracargos: 0, mp_mediaciones: 0, ml_reclamos: 0, creados: 0, actualizados: 0, errores: {} };
  const samples = {};
  const toUpsert = [];

  // Escanea pagos MP por status (charged_back / in_mediation) y los mapea a reclamos.
  async function mpPayments(status, tipo, fuente) {
    const url = `https://api.mercadopago.com/v1/payments/search?status=${status}&sort=date_created&criteria=desc&range=date_created&begin_date=${encodeURIComponent(sinceISO)}&end_date=${encodeURIComponent(untilISO)}&limit=50`;
    const r = await fetch(url, { headers: auth });
    if (r.status !== 200) { report.errores[fuente] = `MP HTTP ${r.status}`; return; }
    const body = await r.json();
    const results = body.results || [];
    if (debug) samples[fuente] = results.slice(0, 3);
    for (const p of results) {
      const amount = p.transaction_amount || 0;
      const nombre = [p.payer?.first_name, p.payer?.last_name].filter(Boolean).join(" ") || p.payer?.email || "";
      toUpsert.push({
        docId: `${uid}_mp_${p.id}`,
        origen: "mp", fuente, origenStatus: p.status_detail || p.status,
        origenUrl: `https://www.mercadopago.com.ar/activities/detail/${p.id}`,
        reclamo: {
          orderNum: String(p.order?.id || p.external_reference || p.id),
          tipo, motivo: tipo === "Contracargo" ? "Contracargo de Mercado Pago" : "Disputa / mediación de Mercado Pago",
          descripcion: `Pago MP ${p.id} · ${p.status_detail || p.status} · $${Number(amount).toLocaleString("es-AR")}`,
          clienteNombre: nombre, clienteEmail: p.payer?.email || "", clienteTotal: String(amount),
        },
      });
      if (tipo === "Contracargo") report.mp_contracargos++; else report.mp_mediaciones++;
    }
  }

  // Contracargos y mediaciones de MP (proven: /payments/search ya funciona con este token).
  try { await mpPayments("charged_back", "Contracargo", "mp_contracargo"); }
  catch (e) { report.errores.mp_contracargo = e.message; }
  try { await mpPayments("in_mediation", "Reclamo", "mp_mediacion"); }
  catch (e) { report.errores.mp_mediacion = e.message; }

  // Reclamos de Mercado Libre (post-purchase claims). Probamos v1 y v2; si el
  // token no tiene scope de post-venta, degrada y se reporta.
  try {
    let claims = [], ok = false;
    for (const ver of ["v1", "v2"]) {
      const r = await fetch(`https://api.mercadolibre.com/post-purchase/${ver}/claims/search?limit=50&sort=date_created,desc`, { headers: auth });
      if (r.status === 200) {
        const body = await r.json();
        claims = body.data || body.results || [];
        if (debug) samples.ml_reclamos = { version: ver, sample: claims.slice(0, 3) };
        ok = true; break;
      } else if (r.status !== 404) {
        report.errores.ml_reclamos = `ML HTTP ${r.status}`;
      }
    }
    if (!ok && !report.errores.ml_reclamos) report.errores.ml_reclamos = "endpoint no disponible (404)";
    for (const c of claims) {
      const oid = c.resource_id || c.order_id || (c.resource === "order" ? c.resource_id : "") || "";
      const razon = c.reason_id || c.reason?.name || c.type || "Reclamo";
      toUpsert.push({
        docId: `${uid}_ml_${c.id}`,
        origen: "ml", fuente: "ml_reclamo", origenStatus: c.status || c.stage || "",
        origenUrl: oid ? `https://www.mercadolibre.com.ar/ventas/${oid}/detalle` : "",
        reclamo: {
          orderNum: String(oid || c.id),
          tipo: "Reclamo", motivo: `Reclamo Mercado Libre — ${razon}`,
          descripcion: `Claim ML ${c.id} · ${c.type || "reclamo"} · etapa ${c.stage || "-"} · ${c.status || "-"}`,
          clienteNombre: "", clienteEmail: "", clienteTotal: "",
        },
      });
      report.ml_reclamos++;
    }
  } catch (e) { report.errores.ml_reclamos = e.message; }

  // Upsert idempotente. Nuevo → tarjeta completa en "Nuevo". Existente → solo
  // refresca el estado del origen, sin tocar lo editado a mano.
  for (const it of toUpsert) {
    try {
      const ref = db.collection("reclamos").doc(it.docId);
      const snap = await ref.get();
      if (!snap.exists) {
        await ref.set({
          ...it.reclamo,
          estado: "Nuevo", resolucion: "", notas: "", notasInternas: "",
          trackingCambio: "", trackingDevolucion: "",
          productosRecibe: [], productosEnvia: [],
          estadoRecepcion: "", estadoReembolso: "", clienteProductos: [], clienteTelefono: "",
          ownerId: uid, origen: it.origen, fuente: it.fuente, extId: it.docId,
          origenUrl: it.origenUrl, origenStatus: it.origenStatus,
          historial: [{ accion: `Importado de ${it.origen.toUpperCase()}`, fecha: now }],
          createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
          resolvedAt: null, lastSyncedAt: now,
        });
        report.creados++;
      } else {
        await ref.set({ origenStatus: it.origenStatus, origenUrl: it.origenUrl, lastSyncedAt: now, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        report.actualizados++;
      }
    } catch (e) { report.errores[it.docId] = e.message; }
  }

  return res.json({ ok: true, report, ...(debug ? { samples } : {}) });
}

// ─── Google Drive (OAuth por redirección, sin popup) ─────────────────────────
// El popup de GIS devolvía popup_closed sin entregar el token. Acá el usuario va
// a Google en la misma pestaña y vuelve por /api/google-drive-callback. Scope
// drive.file (no restringido, sin cartel). El Picker del front usa el token de
// `token` para mostrar TODO el Drive; lo que el usuario elige queda accesible.
function gdriveSetupError() {
  return {
    error: "Falta configurar Google Drive en el servidor.",
    setup: true,
    steps: [
      "Vercel → Settings → Environment Variables → agregar GOOGLE_DRIVE_CLIENT_SECRET (secreto del cliente OAuth web del proyecto Growith-Gestion, cuenta contacto.growith@gmail.com).",
      `Google Cloud → Google Auth Platform → Clientes → cliente web → URIs de redirección autorizados → agregar ${DRIVE_REDIRECT_URI}`,
      "Redeploy en Vercel y volver a tocar Conectar.",
    ],
  };
}

async function gdriveOauthStart(req, res, db) {
  const uid = req.body?.uid || req.query.uid;
  if (!uid) return res.status(400).json({ error: "Falta uid" });
  if (!(await guardUid(req, res, uid))) return;
  const { clientId, clientSecret } = driveEnv();
  if (!clientId || !clientSecret) return res.status(400).json(gdriveSetupError());
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", DRIVE_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", DRIVE_SCOPES);
  url.searchParams.set("access_type", "offline");   // → refresh_token
  url.searchParams.set("prompt", "consent");        // fuerza refresh_token aunque ya haya consentido
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", `${uid}.${signDriveState(uid)}`);
  return res.json({ url: url.toString() });
}

async function gdriveStatus(req, res, db) {
  const uid = req.query.uid;
  if (!uid) return res.status(400).json({ error: "Falta uid" });
  if (!(await guardUid(req, res, uid))) return;
  const g = (await db.collection("users").doc(uid).get()).data()?.googleDrive || null;
  const { clientId, clientSecret } = driveEnv();
  return res.json({ connected: !!g?.refresh_token, email: g?.email || null, configured: !!(clientId && clientSecret), redirect_uri: DRIVE_REDIRECT_URI });
}

// Access token corto para el Google Picker del navegador (drive.file).
async function gdriveToken(req, res, db) {
  const uid = req.query.uid;
  if (!uid) return res.status(400).json({ error: "Falta uid" });
  if (!(await guardUid(req, res, uid))) return;
  try {
    const t = await getValidDriveToken(db, uid);
    if (!t) return res.status(400).json({ error: "Google Drive no está conectado", not_connected: true });
    return res.json({ access_token: t.accessToken, email: t.email });
  } catch (e) { return res.status(502).json({ error: e.message }); }
}

async function gdriveDisconnect(req, res, db) {
  const uid = req.body?.uid || req.query.uid;
  if (!uid) return res.status(400).json({ error: "Falta uid" });
  if (!(await guardUid(req, res, uid))) return;
  const ref = db.collection("users").doc(uid);
  const g = (await ref.get()).data()?.googleDrive;
  // Revocar en Google (best-effort) y borrar local.
  if (g?.refresh_token) { try { await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(g.refresh_token)}`, { method: "POST" }); } catch (_) {} }
  await ref.set({ googleDrive: { connected: false, email: null, refresh_token: null, access_token: null, expires_at: null, disconnectedAt: new Date().toISOString() } }, { merge: true });
  return res.json({ ok: true });
}

// ─── TikTok Ads (OAuth por redirección, Marketing API v1.3) ──────────────────
// Mismo patrón que Google Drive: el usuario va a TikTok en la misma pestaña y
// vuelve por /api/tiktok-ads-callback. Sin env TIKTOK_APP_ID/SECRET la app
// muestra "PRONTO" (status.configured=false) y se prende sola al cargarlos.
function tiktokSetupError() {
  return {
    error: "Falta configurar TikTok Ads en el servidor.",
    setup: true,
    steps: [
      "Crear una app en TikTok for Business Developers (business-api.tiktok.com) con scopes Ad Account Management + Reporting.",
      `En la app, 'Advertiser redirect URL' = ${TIKTOK_REDIRECT_URI}`,
      "Vercel → Environment Variables → TIKTOK_APP_ID y TIKTOK_APP_SECRET → Redeploy.",
    ],
  };
}

async function tiktokOauthStart(req, res, db) {
  const uid = req.body?.uid || req.query.uid;
  if (!uid) return res.status(400).json({ error: "Falta uid" });
  if (!(await guardUid(req, res, uid))) return;
  const { appId, secret } = tiktokEnv();
  if (!appId || !secret) return res.status(400).json(tiktokSetupError());
  const url = new URL("https://business-api.tiktok.com/portal/auth");
  url.searchParams.set("app_id", appId);
  url.searchParams.set("state", `${uid}.${signTiktokState(uid)}`);
  url.searchParams.set("redirect_uri", TIKTOK_REDIRECT_URI);
  return res.json({ url: url.toString() });
}

async function tiktokStatus(req, res, db) {
  const uid = req.query.uid;
  if (!uid) return res.status(400).json({ error: "Falta uid" });
  if (!(await guardUid(req, res, uid))) return;
  const t = (await db.collection("users").doc(uid).get()).data()?.tiktokAds || null;
  const { appId, secret } = tiktokEnv();
  return res.json({ connected: !!t?.access_token, advertisers: t?.advertisers || [], advertiser_id: t?.advertiser_id || null, configured: !!(appId && secret), redirect_uri: TIKTOK_REDIRECT_URI });
}

// Elegir la cuenta publicitaria activa (si el usuario tiene varias).
async function tiktokSetAdvertiser(req, res, db) {
  const uid = req.body?.uid || req.query.uid;
  const advertiserId = String(req.body?.advertiser_id || "");
  if (!uid) return res.status(400).json({ error: "Falta uid" });
  if (!(await guardUid(req, res, uid))) return;
  const ref = db.collection("users").doc(uid);
  const t = (await ref.get()).data()?.tiktokAds;
  if (!t?.access_token) return res.status(400).json({ error: "TikTok Ads no está conectado" });
  if (!(t.advertisers || []).some(a => a.id === advertiserId)) return res.status(400).json({ error: "Esa cuenta publicitaria no está en tu lista" });
  await ref.set({ tiktokAds: { ...t, advertiser_id: advertiserId } }, { merge: true });
  return res.json({ ok: true, advertiser_id: advertiserId });
}

async function tiktokDisconnect(req, res, db) {
  const uid = req.body?.uid || req.query.uid;
  if (!uid) return res.status(400).json({ error: "Falta uid" });
  if (!(await guardUid(req, res, uid))) return;
  const ref = db.collection("users").doc(uid);
  const t = (await ref.get()).data()?.tiktokAds;
  // Revocar en TikTok (best-effort) y borrar local.
  if (t?.access_token) {
    const { appId, secret } = tiktokEnv();
    try { await fetch("https://business-api.tiktok.com/open_api/v1.3/oauth2/revoke_token/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app_id: appId, secret, access_token: t.access_token }) }); } catch (_) {}
  }
  await ref.set({ tiktokAds: { connected: false, access_token: null, advertisers: [], advertiser_id: null, disconnectedAt: new Date().toISOString() } }, { merge: true });
  return res.json({ ok: true });
}

// ─── Conversación de un reclamo (leer hilo + responder al comprador) ─────────
// Las tarjetas del tablero guardan su origen en el doc-id: `{uid}_ml_{claimId}`
// (reclamo ML → el id ES el claim) o `{uid}_mp_{paymentId}` (contracargo/disputa
// MP → hay que resolver el claim asociado al pago). Estas funciones reusan el
// token de ML (que autentica contra MP y contra la API de post-venta de ML).

// Resuelve el claim de post-venta para una tarjeta. Devuelve { claimId, ... } +
// las URLs intentadas (para diagnóstico). Para MP: pago → order → claim.
async function resolveClaim(auth, origen, rawId) {
  const tried = [];
  if (origen === "ml") return { claimId: String(rawId), tried };
  // MP: el rawId es un payment_id. Traemos el pago para sacar el order de ML.
  let payStatus = null, orderId = null;
  try {
    const pr = await fetch(`https://api.mercadopago.com/v1/payments/${rawId}`, { headers: auth });
    tried.push(`GET /v1/payments/${rawId} → ${pr.status}`);
    if (pr.ok) { const pay = await pr.json(); payStatus = pay.status; orderId = pay.order?.id || null; }
  } catch (e) { tried.push(`payments error: ${e.message}`); }
  const candidates = [];
  if (orderId) candidates.push(`https://api.mercadolibre.com/post-purchase/v1/claims/search?resource=order&resource_id=${orderId}`);
  candidates.push(`https://api.mercadolibre.com/post-purchase/v1/claims/search?payment_id=${rawId}`);
  for (const url of candidates) {
    try {
      const r = await fetch(url, { headers: auth });
      tried.push(`GET ${url.replace("https://api.mercadolibre.com","")} → ${r.status}`);
      if (r.ok) { const b = await r.json(); const c = (b.data || b.results || [])[0]; if (c?.id) return { claimId: String(c.id), orderId, payStatus, tried }; }
    } catch (e) { tried.push(`claims search error: ${e.message}`); }
  }
  return { claimId: null, orderId, payStatus, tried };
}

// Normaliza el token + docId comunes a leer y responder.
async function reclamoCtx(req, res, db) {
  const uid = req.query.uid || req.body?.uid;
  const docId = req.query.docId || req.body?.docId;
  if (!uid) { res.status(400).json({ error: "Falta uid" }); return null; }
  if (!(await guardUid(req, res, uid))) return null;
  if (!docId) { res.status(400).json({ error: "Falta docId" }); return null; }
  // docId = `${uid}_${origen}_${id}` — el uid puede tener "_", así que parseamos por el prefijo conocido.
  const rest = docId.startsWith(uid + "_") ? docId.slice(uid.length + 1) : docId;
  const origen = rest.startsWith("ml_") ? "ml" : rest.startsWith("mp_") ? "mp" : null;
  const rawId = origen ? rest.slice(3) : null;
  if (!origen || !rawId) { res.status(400).json({ error: "docId no es un reclamo MP/ML" }); return null; }
  let tok;
  try { tok = await getValidMLToken(db, uid); } catch (e) { res.json({ ok: false, step: "token", error: e.message }); return null; }
  if (!tok?.accessToken) { res.json({ ok: false, step: "token", error: "Sin token ML/MP — conectá Mercado Libre" }); return null; }
  return { uid, docId, origen, rawId, auth: { Authorization: `Bearer ${tok.accessToken}` } };
}

// GET: lee el hilo de mensajes del reclamo (comprador ↔ vendedor).
async function reclamoThread(req, res, db) {
  const ctx = await reclamoCtx(req, res, db);
  if (!ctx) return;
  const debug = req.query.debug === "1";
  const resolved = await resolveClaim(ctx.auth, ctx.origen, ctx.rawId);
  if (!resolved.claimId) {
    return res.json({ ok: true, claimId: null, messages: [], note: "No se encontró un reclamo/claim asociado por API — respondelo desde el panel de Mercado Pago/Libre.", ...(debug ? { tried: resolved.tried } : {}) });
  }
  const raw = {};
  let claimInfo = {}, messages = [];
  try {
    const cr = await fetch(`https://api.mercadolibre.com/post-purchase/v1/claims/${resolved.claimId}`, { headers: ctx.auth });
    if (cr.ok) { const c = await cr.json(); claimInfo = { stage: c.stage, status: c.status, type: c.type }; if (debug) raw.claim = c; }
  } catch (e) { raw.claimErr = e.message; }
  try {
    const mr = await fetch(`https://api.mercadolibre.com/post-purchase/v1/claims/${resolved.claimId}/messages`, { headers: ctx.auth });
    raw.messagesStatus = mr.status;
    if (mr.ok) {
      const body = await mr.json();
      const arr = Array.isArray(body) ? body : (body.data || body.results || body.messages || []);
      messages = arr.map(m => ({
        from: m.sender_role || m.from?.role || m.role || "",
        text: m.message || m.text || (m.receiver && m.message) || "",
        date: m.date_created || m.date || m.last_updated || "",
      })).filter(m => m.text);
      if (debug) raw.messagesRaw = arr.slice(0, 5);
    }
  } catch (e) { raw.messagesErr = e.message; }
  return res.json({ ok: true, claimId: resolved.claimId, ...claimInfo, messages, ...(debug ? { tried: resolved.tried, raw } : {}) });
}

// POST: responde (manda un mensaje al comprador dentro del reclamo).
async function reclamoReply(req, res, db) {
  const ctx = await reclamoCtx(req, res, db);
  if (!ctx) return;
  const message = (req.body?.message || "").toString().trim();
  if (!message) return res.status(400).json({ error: "Mensaje vacío" });
  const resolved = await resolveClaim(ctx.auth, ctx.origen, ctx.rawId);
  if (!resolved.claimId) return res.json({ ok: false, error: "No se encontró el claim para responder por API — usá el panel de MP/ML.", tried: resolved.tried });
  // Probamos los dos formatos conocidos del endpoint de envío de mensaje.
  const attempts = [
    { url: `https://api.mercadolibre.com/post-purchase/v1/claims/${resolved.claimId}/actions/send-message`, body: { receiver_role: "complainant", message } },
    { url: `https://api.mercadolibre.com/post-purchase/v1/claims/${resolved.claimId}/messages`, body: { receiver_role: "complainant", message } },
  ];
  const tried = [];
  for (const a of attempts) {
    try {
      const r = await fetch(a.url, { method: "POST", headers: { ...ctx.auth, "Content-Type": "application/json" }, body: JSON.stringify(a.body) });
      const txt = await r.text();
      tried.push(`POST ${a.url.replace("https://api.mercadolibre.com","")} → ${r.status}`);
      if (r.ok) return res.json({ ok: true, claimId: resolved.claimId });
      // 400/409 con detalle: devolvemos el motivo (ej. no es tu turno de responder).
      if (r.status !== 404) return res.json({ ok: false, status: r.status, error: txt.slice(0, 300), tried });
    } catch (e) { tried.push(`error: ${e.message}`); }
  }
  return res.json({ ok: false, error: "No se pudo enviar el mensaje por API (endpoint no disponible).", tried });
}

export default async function handler(req, res) {
  { const _o=String(req.headers.origin||""); res.setHeader("Access-Control-Allow-Origin", (["https://www.growithapp.com","https://growithapp.com","https://soluna-gestion.vercel.app"].includes(_o)||_o.endsWith("-soluna1.vercel.app")||_o.startsWith("http://localhost"))?_o:"https://www.growithapp.com"); } // allowlist CORS
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end(); // preflight sin auth

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
      // El callback llega SIN action (Shopify lo prohíbe) pero CON code. Lo
      // detectamos por el code así no depende del param reservado "action".
      if (req.method === "GET" && (action === "callback" || req.query.code)) return shopifyOauthCallback(req, res, db);
      if (action === "disconnect" && req.method === "POST") return shopifyDisconnect(req, res, db);
      // Webhooks obligatorios de privacidad (customers/data_request, customers/redact,
      // shop/redact) — todos a esta URL, distinguidos por el header X-Shopify-Topic.
      if (action === "compliance" && req.method === "POST") return shopifyCompliance(req, res, db);
    }

    if (platform === "tiendanube") {
      // Devuelve el `state` FIRMADO para el OAuth de TN. El frontend no puede
      // firmarlo (el secreto es del servidor), así que lo pide acá ya
      // autenticado: sin esto, el state era el uid en claro y cualquiera podía
      // completar el flujo con la cuenta de otro (CSRF de vinculación).
      if (action === "oauth_start" && req.method === "POST") {
        const uid = req.body?.uid || req.query.uid;
        if (!(await guardUid(req, res, uid))) return;
        return res.json({ state: `${uid}.${signState(uid)}` });
      }
    }

    if (platform === "tiktokads") {
      if (action === "oauth_start" && req.method === "POST") return tiktokOauthStart(req, res, db);
      if (action === "status" && req.method === "GET") return tiktokStatus(req, res, db);
      if (action === "set_advertiser" && req.method === "POST") return tiktokSetAdvertiser(req, res, db);
      if (action === "disconnect" && req.method === "POST") return tiktokDisconnect(req, res, db);
    }

    if (platform === "googledrive") {
      if (action === "oauth_start" && req.method === "POST") return gdriveOauthStart(req, res, db);
      if (action === "status" && req.method === "GET") return gdriveStatus(req, res, db);
      if (action === "token" && req.method === "GET") return gdriveToken(req, res, db);
      if (action === "disconnect" && req.method === "POST") return gdriveDisconnect(req, res, db);
    }

    if (platform === "mercadolibre") {
      if (action === "oauth_start" && req.method === "POST") return mercadolibreOauthStart(req, res, db);
      if (action === "callback" && req.method === "GET") return mercadolibreOauthCallback(req, res, db);
      if (action === "disconnect" && req.method === "POST") return mercadolibreDisconnect(req, res, db);
      if (action === "mp_probe" && req.method === "GET") return mpProbe(req, res, db);
      if (action === "reclamos_sync" && (req.method === "POST" || req.method === "GET")) return reclamosSync(req, res, db);
      if (action === "reclamo_thread" && req.method === "GET") return reclamoThread(req, res, db);
      if (action === "reclamo_reply" && req.method === "POST") return reclamoReply(req, res, db);
      if (action === "mlads_probe" && req.method === "GET") return mlAdsProbe(req, res, db);
      if (action === "mlship_probe" && req.method === "GET") return mlShipProbe(req, res, db);
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
