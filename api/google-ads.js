// api/google-ads.js
// Integración Google Ads — OAuth + estado de conexión.
// Requiere en Vercel: GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET (OAuth de un
// proyecto de Google Cloud con la Google Ads API habilitada) y
// GOOGLE_ADS_DEVELOPER_TOKEN (se pide desde el centro de API de una cuenta
// administrador de Google Ads). Opcional: GOOGLE_ADS_LOGIN_CUSTOMER_ID (id del
// MCC, sin guiones) si las cuentas cuelgan de un administrador.
// El gasto del Dashboard se lee en api/orders.js (fetchGoogleAdsAuto). Acá: OAuth +
// análisis de campañas (accounts / campaigns / campaign_status) para la sección Google Ads.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createHmac } from "crypto";
import { guardUid } from "./_auth.js";
import { driveEnv } from "./google-drive-callback.js";

// Credenciales OAuth para Google Ads. Desde 2026-09-13 se usa el cliente del
// proyecto verificado de Growith (el mismo de Drive, proyecto Growith-Gestion),
// que tiene la marca verificada y el permiso adwords declarado. Las env
// GOOGLE_ADS_CLIENT_ID/SECRET (proyecto viejo sin verificar) quedan solo para
// renovar las conexiones hechas antes con ese cliente.
//
// 2026-09-14: desde el 10/09 Google asigna el nivel de acceso de la Google Ads API
// al PROYECTO de Cloud del cliente OAuth. El acceso Básico (token aprobado el
// 2026-08-21) quedó en el proyecto viejo `sylvan-flight-503101-q2` (cliente legacy
// GOOGLE_ADS_CLIENT_ID); Growith-Gestion está en nivel "Prueba" y solo ve cuentas
// de prueba ("only approved for use with test accounts"). Por eso las conexiones
// NUEVAS usan el cliente legacy hasta que
// console.cloud.google.com/google/ads-apis/overview?project=soluna-gestion diga
// Básico — ahí pasar esto a true (y verificar el scope adwords en ese proyecto).
const GADS_USE_VERIFIED_PROJECT = false;
export function gadsCreds(clientIdGuardado) {
  const drive = driveEnv();
  const legacy = { clientId: String(process.env.GOOGLE_ADS_CLIENT_ID || "").trim(), clientSecret: String(process.env.GOOGLE_ADS_CLIENT_SECRET || "").trim() };
  const hasLegacy = !!(legacy.clientId && legacy.clientSecret);
  const hasDrive = !!(drive.clientId && drive.clientSecret);
  // Conexión existente: se renueva con el mismo cliente con el que se hizo.
  if (clientIdGuardado && hasLegacy && clientIdGuardado === legacy.clientId) return legacy;
  if (clientIdGuardado && hasDrive && clientIdGuardado === drive.clientId) return drive;
  // Conexión nueva (o sin clientId conocido).
  if (GADS_USE_VERIFIED_PROJECT) return hasDrive ? drive : legacy;
  return hasLegacy ? legacy : drive;
}

const APP_URL = "https://www.growithapp.com";
export const GADS_REDIRECT = `${APP_URL}/api/google-ads-callback`;

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

// state firmado (mismo esquema que meta.js): uid.HMAC(uid) — el callback lo verifica.
export function signGadsState(uid) {
  const secret = process.env.GOOGLE_ADS_CLIENT_SECRET || "";
  return `${uid}.${createHmac("sha256", secret).update(String(uid)).digest("hex").slice(0, 32)}`;
}

// v25 (ago 2026): releases mensuales — si algo devuelve 404 en todo, subir la
// versión acá, en google-ads-callback.js y en orders.js (fetchGoogleAdsAuto).
const GADS_API = "https://googleads.googleapis.com/v25";

// refresh_token → access_token con el cliente OAuth con el que se hizo la conexión.
async function gadsAccessToken(g) {
  const creds = gadsCreds(g?.clientId === undefined ? (process.env.GOOGLE_ADS_CLIENT_ID || "") : g.clientId);
  if (!creds.clientId || !creds.clientSecret) throw new Error("Faltan las credenciales OAuth de Google Ads en Vercel.");
  const tr = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: g.refresh_token, grant_type: "refresh_token" }),
  });
  const tj = await tr.json().catch(() => ({}));
  if (!tr.ok || !tj.access_token) throw new Error(`Google rechazó la sesión (${tj.error || "HTTP " + tr.status}) — desvinculá y volvé a conectar Google Ads`);
  return tj.access_token;
}

function gadsHeaders(at, login) {
  const dt = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "";
  const lc = login || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "";
  return { Authorization: `Bearer ${at}`, ...(dt ? { "developer-token": dt } : {}), ...(lc ? { "login-customer-id": String(lc).replace(/-/g, "") } : {}) };
}

// Traduce el error de la Google Ads API a algo que el usuario entienda.
function gadsHttpError(status, txt) {
  const t = String(txt || "");
  let code = "", msg = "";
  try { const j = JSON.parse(t); const d = j.error?.details?.[0]?.errors?.[0]; code = JSON.stringify(d?.errorCode || ""); msg = d?.message || j.error?.message || ""; } catch { msg = t.slice(0, 300); }
  const friendly =
    /only approved for use with test accounts|TEST_ACCOUNTS|apply for Explorer/i.test(code + t) ? "Esta conexión se hizo con un acceso de Google que solo ve cuentas de prueba. Desvinculá Google Ads en Configuración → Integraciones y volvé a conectarlo: la conexión nueva ya lee tus cuentas reales." :
    /DEVELOPER_TOKEN_NOT_APPROVED/i.test(code + t) ? "El developer token de Growith todavía no está aprobado por Google para esta cuenta." :
    /DEVELOPER_TOKEN_PROHIBITED/i.test(code + t) ? "El developer token no puede usarse con este proyecto de Google Cloud." :
    /developer-token|DEVELOPER_TOKEN_INVALID|NOT_ADS_USER/i.test(code + t) && status === 401 ? "Falta el developer token de Google Ads en el servidor (GOOGLE_ADS_DEVELOPER_TOKEN)." :
    /USER_PERMISSION_DENIED/i.test(code + t) ? "La cuenta de Google conectada no tiene acceso directo a esa cuenta de Ads (si cuelga de un administrador, elegí la cuenta hija)." :
    /CUSTOMER_NOT_ENABLED/i.test(code + t) ? "Esa cuenta de Google Ads está desactivada o cancelada." :
    /REQUESTED_METRICS_FOR_MANAGER/i.test(code + t) ? "Es una cuenta administrador (MCC): no tiene métricas propias." :
    /CUSTOMER_NOT_FOUND|INVALID_CUSTOMER_ID/i.test(code + t) ? "Google no encuentra esa cuenta de Ads." :
    /PERMISSION_DENIED|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(code + t) && status === 403 ? "Google denegó el acceso — desvinculá y volvé a conectar Google Ads." :
    null;
  const e = new Error(friendly ? `${friendly}${msg ? " (Google: " + msg.slice(0, 220) + ")" : ""}` : `Google Ads API HTTP ${status}${msg ? ": " + msg : ""}`);
  e.status = status; e.google = msg; e.code = code;
  return e;
}

// Consulta GAQL (googleAds:search, paginada) → filas.
async function gaql(at, customer, login, query) {
  const cn = String(customer).replace(/^customers\//, "").replace(/-/g, "");
  const out = []; let pageToken = null; let guard = 0;
  do {
    const r = await fetch(`${GADS_API}/customers/${cn}/googleAds:search`, {
      method: "POST", headers: { ...gadsHeaders(at, login), "Content-Type": "application/json" },
      body: JSON.stringify({ query, ...(pageToken ? { pageToken } : {}) }), // sin pageSize: la API lo rechaza (fijo en 10000)
    });
    if (!r.ok) throw gadsHttpError(r.status, await r.text().catch(() => ""));
    const j = await r.json();
    out.push(...(j.results || []));
    pageToken = j.nextPageToken || null;
  } while (pageToken && ++guard < 10);
  return out;
}

export default async function handler(req, res) {
  { const _o=String(req.headers.origin||""); res.setHeader("Access-Control-Allow-Origin", (["https://www.growithapp.com","https://growithapp.com","https://soluna-gestion.vercel.app"].includes(_o)||_o.endsWith("-soluna1.vercel.app")||_o.startsWith("http://localhost"))?_o:"https://www.growithapp.com"); } // allowlist CORS
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = req.query?.action;
  const uid = req.query?.uid;
  if (!uid) return res.status(400).json({ error: "Falta uid" });
  // El token tiene que pertenecer al uid pedido (o a su equipo / a un admin):
  // con verifyAuth a secas, cualquier cliente logueado podía firmar un state de
  // OAuth para otra cuenta o desconectarle Google Ads.
  if (!(await guardUid(req, res, uid))) return;

  try {
    const db = initAdmin();

    if (action === "oauth_start" && req.method === "GET") {
      const creds = gadsCreds();
      const cid = creds.clientId;
      if (!cid || !creds.clientSecret) {
        return res.status(400).json({ error: "faltan_credenciales", detail: "Faltan GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET en Vercel. Creá las credenciales OAuth en Google Cloud (con la Google Ads API habilitada) y cargalas." });
      }
      const params = new URLSearchParams({
        client_id: cid,
        redirect_uri: GADS_REDIRECT,
        response_type: "code",
        scope: "https://www.googleapis.com/auth/adwords",
        access_type: "offline",   // devuelve refresh_token (dura hasta que se revoque)
        prompt: "consent",        // fuerza refresh_token aunque ya haya consentido antes
        state: signGadsState(uid),
      });
      return res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
    }

    if (action === "status" && req.method === "GET") {
      const snap = await db.collection("users").doc(uid).get();
      const g = snap.data()?.googleAds || null;
      return res.json({ connected: !!g?.refresh_token, customers: g?.customers || [], connectedAt: g?.connectedAt || null,
        hasCreds: !!(gadsCreds().clientId && gadsCreds().clientSecret),
        hasDevToken: !!process.env.GOOGLE_ADS_DEVELOPER_TOKEN });
    }

    if (action === "disconnect" && req.method === "POST") {
      await db.collection("users").doc(uid).set({ googleAds: null }, { merge: true });
      return res.json({ ok: true });
    }

    // ── Análisis de campañas (Google Ads API, GAQL) ──
    if (action === "accounts" && req.method === "GET") {
      const snap = await db.collection("users").doc(uid).get();
      const g = snap.data()?.googleAds || null;
      if (!g?.refresh_token) return res.status(400).json({ error: "no_conectado", detail: "Google Ads no está conectado en esta tienda." });
      const at = await gadsAccessToken(g);
      let ids = Array.isArray(g.customers) ? g.customers.map(c => String(c.id || c).replace(/^customers\//, "").replace(/-/g, "")) : [];
      if (!ids.length) {
        const cr = await fetch(`${GADS_API}/customers:listAccessibleCustomers`, { headers: gadsHeaders(at) });
        if (!cr.ok) throw gadsHttpError(cr.status, await cr.text().catch(() => ""));
        ids = ((await cr.json()).resourceNames || []).map(r => String(r).replace("customers/", ""));
        if (ids.length) db.collection("users").doc(uid).set({ googleAds: { ...g, customers: ids, customersError: null } }, { merge: true }).catch(() => {});
      }
      const accounts = []; const errors = [];
      for (const cid of ids.slice(0, 10)) {
        try {
          const rows = await gaql(at, cid, null, "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager, customer.status, customer.time_zone FROM customer LIMIT 1");
          const c = rows[0]?.customer || {};
          if (c.manager) {
            // Cuenta administrador (MCC): sin métricas propias; se listan las cuentas hijas.
            const kids = await gaql(at, cid, cid, "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager, customer_client.status, customer_client.level FROM customer_client WHERE customer_client.level <= 1 AND customer_client.manager = FALSE");
            for (const k of kids) {
              const cc = k.customerClient || {};
              accounts.push({ id: String(cc.id), name: cc.descriptiveName || String(cc.id), currency: cc.currencyCode || "", status: cc.status || "", login: cid, viaManager: c.descriptiveName || cid });
            }
          } else {
            accounts.push({ id: String(c.id || cid), name: c.descriptiveName || String(cid), currency: c.currencyCode || "", status: c.status || "", login: null });
          }
        } catch (e) { errors.push({ id: cid, error: e.message }); }
      }
      // Sin duplicados (una cuenta puede estar accesible directo y vía MCC)
      const seen = new Set(); const uniq = accounts.filter(a => { if (seen.has(a.id)) return false; seen.add(a.id); return true; });
      db.collection("users").doc(uid).set({ googleAds: { ...g, customersInfo: uniq, customersInfoAt: new Date().toISOString() } }, { merge: true }).catch(() => {});
      return res.json({ accounts: uniq, errors, hasDevToken: !!process.env.GOOGLE_ADS_DEVELOPER_TOKEN });
    }

    if (action === "campaigns" && req.method === "GET") {
      const customer = String(req.query.customer || "").replace(/-/g, "");
      const login = req.query.login ? String(req.query.login).replace(/-/g, "") : null;
      const since = String(req.query.since || "").slice(0, 10), until = String(req.query.until || "").slice(0, 10);
      if (!customer || !/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) return res.status(400).json({ error: "Faltan customer / since / until" });
      const snap = await db.collection("users").doc(uid).get();
      const g = snap.data()?.googleAds || null;
      if (!g?.refresh_token) return res.status(400).json({ error: "no_conectado", detail: "Google Ads no está conectado en esta tienda." });
      const at = await gadsAccessToken(g);
      // 1) Todas las campañas (estado y presupuesto, sin depender de que hayan tenido impresiones en el rango)
      const base = await gaql(at, customer, login, "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign_budget.amount_micros, campaign.start_date, campaign.end_date FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.name");
      // 2) Métricas del rango
      const met = await gaql(at, customer, login, `SELECT campaign.id, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value, metrics.all_conversions, metrics.ctr, metrics.average_cpc, metrics.average_cpm FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}' AND campaign.status != 'REMOVED'`);
      const byId = {};
      for (const r of base) {
        const c = r.campaign || {}; const b = r.campaignBudget || {};
        byId[String(c.id)] = { id: String(c.id), name: c.name || "", status: c.status || "", channel: c.advertisingChannelType || "", bidding: c.biddingStrategyType || "", budget: b.amountMicros ? +(parseFloat(b.amountMicros) / 1e6).toFixed(2) : null, start: c.startDate || null, end: c.endDate || null,
          spend: 0, impressions: 0, clicks: 0, conversions: 0, conv_value: 0, all_conversions: 0 };
      }
      for (const r of met) {
        const id = String(r.campaign?.id || ""); const m = r.metrics || {};
        const row = byId[id] || (byId[id] = { id, name: r.campaign?.name || id, status: r.campaign?.status || "", channel: "", budget: null, spend: 0, impressions: 0, clicks: 0, conversions: 0, conv_value: 0, all_conversions: 0 });
        row.spend += (parseFloat(m.costMicros) || 0) / 1e6;
        row.impressions += parseInt(m.impressions) || 0;
        row.clicks += parseInt(m.clicks) || 0;
        row.conversions += parseFloat(m.conversions) || 0;
        row.conv_value += parseFloat(m.conversionsValue) || 0;
        row.all_conversions += parseFloat(m.allConversions) || 0;
      }
      const campaigns = Object.values(byId).map(r => ({
        ...r,
        spend: +r.spend.toFixed(2), conv_value: +r.conv_value.toFixed(2), conversions: +r.conversions.toFixed(2), all_conversions: +r.all_conversions.toFixed(2),
        ctr: r.impressions ? +((r.clicks / r.impressions) * 100).toFixed(2) : 0,
        cpc: r.clicks ? +(r.spend / r.clicks).toFixed(2) : 0,
        cpm: r.impressions ? +((r.spend / r.impressions) * 1000).toFixed(2) : 0,
        roas: r.spend ? +(r.conv_value / r.spend).toFixed(2) : 0,
        cpa: r.conversions ? +(r.spend / r.conversions).toFixed(2) : 0,
      })).sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name));
      // 3) Serie diaria del rango (para el gráfico)
      let daily = [];
      try {
        const d = await gaql(at, customer, login, `SELECT segments.date, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.clicks FROM customer WHERE segments.date BETWEEN '${since}' AND '${until}'`);
        daily = d.map(r => ({ date: r.segments?.date, spend: +((parseFloat(r.metrics?.costMicros) || 0) / 1e6).toFixed(2), conversions: +(parseFloat(r.metrics?.conversions) || 0).toFixed(2), conv_value: +(parseFloat(r.metrics?.conversionsValue) || 0).toFixed(2), clicks: parseInt(r.metrics?.clicks) || 0 })).sort((a, b) => String(a.date).localeCompare(String(b.date)));
      } catch (e) { console.error("gads daily:", e.message); }
      return res.json({ campaigns, daily, since, until, customer });
    }

    if (action === "campaign_status" && req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const customer = String(body.customer || "").replace(/-/g, "");
      const login = body.login ? String(body.login).replace(/-/g, "") : null;
      const id = String(body.id || "").replace(/\D/g, "");
      const status = body.status === "ENABLED" ? "ENABLED" : body.status === "PAUSED" ? "PAUSED" : null;
      if (!customer || !id || !status) return res.status(400).json({ error: "Faltan customer / id / status" });
      const snap = await db.collection("users").doc(uid).get();
      const g = snap.data()?.googleAds || null;
      if (!g?.refresh_token) return res.status(400).json({ error: "no_conectado" });
      const at = await gadsAccessToken(g);
      const r = await fetch(`${GADS_API}/customers/${customer}/campaigns:mutate`, {
        method: "POST", headers: { ...gadsHeaders(at, login), "Content-Type": "application/json" },
        body: JSON.stringify({ operations: [{ updateMask: "status", update: { resourceName: `customers/${customer}/campaigns/${id}`, status } }] }),
      });
      if (!r.ok) throw gadsHttpError(r.status, await r.text().catch(() => ""));
      return res.json({ ok: true, id, status });
    }

    return res.status(400).json({ error: "Acción inválida" });
  } catch (e) {
    console.error("google-ads error:", e);
    return res.status(e.status && e.status >= 400 && e.status < 600 ? 502 : 500).json({ error: e.message, google: e.google || null, code: e.code || null });
  }
}
