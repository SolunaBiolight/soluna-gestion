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
    return res.status(400).json({
      error: `Dominio inválido (${shop}). Tenés que poner el subdominio NATIVO de Shopify (xxxx.myshopify.com), no tu dominio personalizado tipo .com o .com.ar. Buscalo en Admin → Configuración → Dominios → el que diga "Predeterminado de Shopify".`
    });
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
      accessToken,
      storeName: shopName,
      storeEmail: shopEmail,
      connectedAt: new Date().toISOString(),
    });
    const extra = snap.exists ? {} : { uid, email: shopEmail || "", nombre: shopName || "", createdAt: new Date().toISOString(), plan: "free", trialEnd: new Date(Date.now() + 7 * 864e5).toISOString() };
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

  const userRef = db.collection("users").doc(uid);
  const snap = await userRef.get();
  if (!snap.exists) return res.status(404).json({ error: "Usuario no encontrado" });
  const stores = (snap.data().stores || []).filter(s => s.type !== "shopify");
  await userRef.update({ stores });

  return res.json({ ok: true });
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
    const extra = snap.exists ? {} : { uid, email: email || "", nombre: nickname || (email || "").split("@")[0] || "", createdAt: new Date().toISOString(), plan: "free", trialEnd: new Date(Date.now() + 7 * 864e5).toISOString() };
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

const PLATFORMS = ["shopify", "tiendanube", "mercadolibre"];

// ── Sondeo: ¿el token de ML sirve para leer pagos de Mercado Pago? ──
// Diagnóstico para decidir cómo calcular la comisión real de MP en ventas
// que NO son de ML (Shopify/TN vía MP Checkout). Devuelve una muestra.
async function mpProbe(req, res, db) {
  const { uid, from, to } = req.query;
  if (!uid) return res.status(400).json({ error: "Falta uid" });
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
      // El callback llega SIN action (Shopify lo prohíbe) pero CON code. Lo
      // detectamos por el code así no depende del param reservado "action".
      if (req.method === "GET" && (action === "callback" || req.query.code)) return shopifyOauthCallback(req, res, db);
      if (action === "disconnect" && req.method === "POST") return shopifyDisconnect(req, res, db);
    }

    if (platform === "mercadolibre") {
      if (action === "oauth_start" && req.method === "POST") return mercadolibreOauthStart(req, res, db);
      if (action === "callback" && req.method === "GET") return mercadolibreOauthCallback(req, res, db);
      if (action === "disconnect" && req.method === "POST") return mercadolibreDisconnect(req, res, db);
      if (action === "mp_probe" && req.method === "GET") return mpProbe(req, res, db);
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
