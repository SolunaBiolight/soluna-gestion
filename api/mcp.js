// api/mcp.js — Conector de Growith para ChatGPT (y Claude): servidor MCP +
// servidor de autorización OAuth 2.1 propio, en una sola function.
//
// El usuario agrega Growith en ChatGPT con la URL https://www.growithapp.com/mcp,
// inicia sesión en Growith, toca "Permitir" y desde ahí le pregunta a ChatGPT por
// sus ventas, márgenes, stock y envíos. Las cifras salen del mismo snapshot
// determinista del Copilot (api/_snapshot.js): la IA nunca genera números.
// Todo es de SOLO LECTURA — ninguna herramienta escribe datos del negocio.
//
// Rutas (rewrites en vercel.json → /api/mcp?route=…):
//   /mcp                                         endpoint MCP (Streamable HTTP, JSON-RPC, sin estado)
//   /.well-known/oauth-protected-resource[/mcp]  metadata del recurso (RFC 9728)
//   /.well-known/oauth-authorization-server      metadata del servidor de autorización (RFC 8414)
//   /oauth/authorize   valida el pedido y manda al usuario a la app (?ia_auth=<id>) a dar el permiso
//   /oauth/token       canje del código (PKCE S256) y refresh (con rotación)
//   /oauth/register    registro dinámico de clientes (RFC 7591) — lo usa Claude
//   /oauth/revoke      revocación de tokens (RFC 7009)
// Acciones de la app (con sesión de Firebase): ?action=auth_info|approve|deny|conexiones|revocar
//
// Clientes: ChatGPT usa CIMD (client_id = URL de su documento de metadata en
// chatgpt.com); Claude usa DCR. Solo se aceptan redirects a hosts conocidos
// (REDIRECT_HOSTS) y el nombre que ve el usuario en la pantalla de permiso sale
// del host del redirect, nunca del client_name que manda el cliente (anti-phishing).
// Gemini Enterprise no registra clientes solo: el dueño genera en Configuración un
// Client ID/Secret fijo (action=gemini_credenciales → cliente "gs_…", solo redirects de Google).
//
// Tokens opacos (32 bytes aleatorios); en Firestore se guarda solo su SHA-256.
//   mcp_clients/{id}    clientes DCR y caché de documentos CIMD
//   mcp_auth_req/{id}   pedido de autorización pendiente (15 min)
//   mcp_codes/{hash}    código de autorización (5 min, un solo uso)
//   mcp_tokens/{hash}   access token (1 h)
//   mcp_refresh/{hash}  refresh token (90 días, se rota en cada uso)
//   mcp_grants/{id}     conexión que ve el dueño en Config (uid, app, fechas, revocada)
// Los docs temporales llevan `expiresAt` (Date) para una política TTL de Firestore.

import crypto from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { initAdmin } from "./integrations/_shared.js";
import { requireUid, verifyAuth, isFounder } from "./_auth.js";
import { getValidMLToken } from "./integrations.js";
import { snapshotMargenes, snapshotEnvios, snapshotStock, snapshotCuentas, estadoConfiguracion } from "./_snapshot.js";
import { gadsCuentas, gadsReporteCampanas } from "./google-ads.js";
import { ttReporteCampanas } from "./tiktok-ads.js";
import { normalizarReglas, tablaReglas } from "./_escala.js";
import { porHora as impPorHora, metricasDigitales, utmAtribucion, leerIndiceUtm, construirIndiceUtm, fxPorUsd, zonaDe, utcDeLocal } from "./impultienda.js";

const ORIGINS = ["https://www.growithapp.com", "https://soluna-gestion.vercel.app"];
const DEFAULT_ORIGIN = ORIGINS[0];
const SCOPE = "growith.read";
// Host del redirect → nombre que ve el usuario al dar el permiso.
const REDIRECT_HOSTS = { "chatgpt.com": "ChatGPT", "chat.openai.com": "ChatGPT", "claude.ai": "Claude", "claude.com": "Claude", "vertexaisearch.cloud.google.com": "Gemini", "business.gemini.google": "Gemini" };
const GEMINI_HOSTS = ["vertexaisearch.cloud.google.com", "business.gemini.google"];
// Hosts desde los que aceptamos documentos CIMD (se descargan del servidor: nunca hosts arbitrarios).
const CIMD_HOSTS = ["chatgpt.com", "claude.ai", "claude.com"];
const ACCESS_TTL = 3600;          // s
const REFRESH_TTL = 90 * 86400;   // s
const CODE_TTL = 300;             // s
const REQ_TTL = 900;              // s
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const LIMITE_DIARIO = 800;        // llamadas a herramientas por tienda y por día (alcanza para revisar Meta cada 15 min)
const SESSION_TTL = 30 * 86400;   // s — una sesión MCP (un chat) recuerda su cliente activo 30 días
//   mcp_sessions/{sid}  cliente activo de UNA sesión MCP (un chat de Claude/ChatGPT): {grantId, perfil, clienteUid}

// ─── Utilidades ──────────────────────────────────────────────────────────

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rnd = (n = 32) => b64url(crypto.randomBytes(n));
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const sameStr = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Origen canónico según el host del request (www en producción; previews y
// localhost apuntan a sí mismos para poder probar el flujo completo).
function originOf(req) {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim().toLowerCase();
  if (/^localhost(:\d+)?$/.test(host) || /^127\.0\.0\.1(:\d+)?$/.test(host)) return `http://${host}`;
  const o = `https://${host}`;
  if (ORIGINS.includes(o) || host.endsWith("-soluna1.vercel.app")) return o;
  return DEFAULT_ORIGIN;
}

function bodyOf(req) {
  let b;
  try { b = req.body; } catch (_) { return {}; } // el parser de Vercel tira con JSON inválido
  if (Array.isArray(b)) return b;
  if (b && typeof b === "object" && !Buffer.isBuffer(b)) return b;
  const s = Buffer.isBuffer(b) ? b.toString("utf8") : (typeof b === "string" ? b : "");
  if (!s) return {};
  try { return JSON.parse(s); } catch (_) {}
  try { return Object.fromEntries(new URLSearchParams(s)); } catch (_) { return {}; }
}

function withParams(uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") u.searchParams.set(k, String(v));
  return u.toString();
}

function redirect(res, url) {
  res.statusCode = 302;
  res.setHeader("Location", url);
  res.setHeader("Cache-Control", "no-store");
  res.end();
}

function oauthErr(res, status, error, error_description) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(error_description ? { error, error_description } : { error });
}

function htmlError(res, msg) {
  const esc = String(msg).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  res.status(400).setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Growith</title>
<body style="font-family:'Inter',system-ui,sans-serif;background:#0f0f14;color:#e5e5ef;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px">
<div style="max-width:420px;text-align:center"><h1 style="font-size:20px">No se pudo conectar con Growith</h1><p style="color:#a1a1b5;line-height:1.5">${esc}</p>
<p style="color:#a1a1b5;font-size:13px">Volvé a la app desde la que estabas conectando y probá de nuevo.</p></div></body>`);
}

// Nombre visible de la app según el redirect (null = redirect no permitido).
function redirectLabel(uri) {
  let u; try { u = new URL(String(uri)); } catch (_) { return null; }
  if (u.hash) return null;
  if (u.protocol === "https:" && REDIRECT_HOSTS[u.hostname]) return REDIRECT_HOSTS[u.hostname];
  // Clientes locales (MCP Inspector, pruebas): el código solo puede volver a esta misma máquina.
  if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return "App local";
  return null;
}

// RFC 8707: el recurso pedido tiene que ser este servidor MCP (se acepta sin path o con /mcp).
function resourceOk(resource, origin) {
  if (resource == null || resource === "") return true;
  const r = String(resource).replace(/\/+$/, "").toLowerCase();
  return r === `${origin}/mcp`.toLowerCase() || r === origin.toLowerCase();
}

// ─── Clientes (CIMD / DCR) ───────────────────────────────────────────────

async function getClient(db, clientId) {
  const id = String(clientId || "").trim();
  if (/^https:\/\//i.test(id)) return getCimdClient(db, id);
  if (!/^g[hs]_[A-Za-z0-9_-]{16,64}$/.test(id)) return null; // gh_ = DCR · gs_ = fijo (Gemini)
  const snap = await db.collection("mcp_clients").doc(id).get();
  return snap.exists ? { kind: "dcr", ...snap.data(), id } : null;
}

async function getCimdClient(db, url) {
  let u; try { u = new URL(url); } catch (_) { return null; }
  if (u.protocol !== "https:" || u.port || !CIMD_HOSTS.includes(u.hostname) || u.pathname.length < 2) return null;
  const ref = db.collection("mcp_clients").doc("cimd_" + sha(url).slice(0, 40));
  const snap = await ref.get();
  if (snap.exists && Date.now() - (snap.data().fetchedAt || 0) < 3600000) return { id: url, ...snap.data(), kind: "cimd" };
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const txt = await r.text();
    if (txt.length > 20000) throw new Error("documento muy grande");
    const d = JSON.parse(txt);
    if (d.client_id !== url || !Array.isArray(d.redirect_uris) || !d.redirect_uris.length) throw new Error("documento inválido");
    const data = {
      client_name: String(d.client_name || "").slice(0, 80),
      redirect_uris: d.redirect_uris.map(String).slice(0, 20),
      fetchedAt: Date.now(),
    };
    await ref.set(data);
    return { id: url, ...data, kind: "cimd" };
  } catch (e) {
    console.warn("[mcp] CIMD", url, e.message);
    return snap.exists ? { id: url, ...snap.data(), kind: "cimd" } : null; // caché vieja antes que cortar
  }
}

async function register(req, res, db) {
  const b = bodyOf(req);
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 10) return oauthErr(res, 400, "invalid_redirect_uri", "Faltan redirect_uris.");
  const bad = uris.find(u => !redirectLabel(u));
  if (bad) return oauthErr(res, 400, "invalid_redirect_uri", `Growith no acepta este redirect: ${bad}`);
  // RFC 7591: sin método declarado, el default es client_secret_basic.
  const method = b.token_endpoint_auth_method || "client_secret_basic";
  if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) {
    return oauthErr(res, 400, "invalid_client_metadata", "token_endpoint_auth_method no soportado.");
  }
  const client_id = "gh_" + rnd(18);
  const secret = method === "none" ? null : rnd(32);
  const client_name = String(b.client_name || "").slice(0, 80);
  await db.collection("mcp_clients").doc(client_id).set({
    client_name, redirect_uris: uris, token_endpoint_auth_method: method,
    secretHash: secret ? sha(secret) : null, createdAt: new Date(),
  });
  res.setHeader("Cache-Control", "no-store");
  return res.status(201).json({
    client_id, client_id_issued_at: Math.floor(Date.now() / 1000),
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_name, redirect_uris: uris, token_endpoint_auth_method: method,
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: SCOPE,
  });
}

// ─── Autorización ────────────────────────────────────────────────────────

async function authorize(req, res, db, origin) {
  const q = req.query || {};
  const client = await getClient(db, q.client_id);
  if (!client) return htmlError(res, "La app que pide acceso no está registrada en Growith.");
  const ru = String(q.redirect_uri || "") || (client.redirect_uris.length === 1 ? client.redirect_uris[0] : "");
  const label = redirectLabel(ru);
  // Cliente fijo de Gemini: Google no publica un redirect único, se acepta cualquiera de sus hosts.
  const redirOk = !!label && (client.kind === "static" ? label === "Gemini" && (client.redirect_hosts || []).includes(new URL(ru).hostname) : client.redirect_uris.includes(ru));
  if (!ru || !redirOk) return htmlError(res, "La dirección de retorno no coincide con la que registró la app.");
  // Desde acá el redirect es de confianza: los errores vuelven a la app (con iss, RFC 9207).
  const back = (p) => redirect(res, withParams(ru, { ...p, state: q.state, iss: origin }));
  if (q.response_type !== "code") return back({ error: "unsupported_response_type" });
  if (!q.code_challenge || q.code_challenge_method !== "S256") return back({ error: "invalid_request", error_description: "Se requiere PKCE con S256." });
  if (!resourceOk(q.resource, origin)) return back({ error: "invalid_target", error_description: "El recurso pedido no es este servidor." });
  const reqId = rnd(24);
  await db.collection("mcp_auth_req").doc(reqId).set({
    client_id: client.id, client_kind: client.kind, redirect_uri: ru, state: q.state != null ? String(q.state) : null,
    code_challenge: String(q.code_challenge).slice(0, 200), resource: `${origin}/mcp`, scope: SCOPE,
    label, host: new URL(ru).host, origin,
    createdAt: new Date(), exp: Date.now() + REQ_TTL * 1000, expiresAt: new Date(Date.now() + REQ_TTL * 1000),
  });
  // La pantalla de permiso vive en la app (login de Firebase + elección de tienda).
  return redirect(res, `${origin}/?ia_auth=${reqId}`);
}

// Quién puede conectar la tienda: el dueño (o el perfil dueño en multi-tienda) y el
// equipo legacy con acceso total. Los miembros con permisos por sección no — el
// conector expone márgenes y stock, que pueden no tener habilitados.
function puedeConectar(r) {
  if (!r.ok) return false;
  if (r.viaAdmin || r.member) return false;
  return true;
}

async function appAction(req, res, db, origin, action) {
  const b = bodyOf(req);

  if (action === "auth_info") {
    const user = await verifyAuth(req);
    if (!user) return res.status(401).json({ error: "Sesión inválida." });
    const id = String(req.query.req || "");
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(id)) return res.status(400).json({ error: "Pedido inválido." });
    const snap = await db.collection("mcp_auth_req").doc(id).get();
    if (!snap.exists) return res.json({ ok: false, vencido: true });
    const d = snap.data();
    let tienda = null;
    const tuid = String(req.query.uid || "");
    if (tuid) { const rr = await requireUid(req, tuid); if (rr.ok) { const u = (await db.collection("users").doc(tuid).get()).data() || {}; tienda = u.nombreTienda || u.nombre || u.email || null; } }
    return res.json({ ok: true, vencido: Date.now() > d.exp, app: d.label, host: d.host, tienda });
  }

  if (action === "approve" || action === "deny") {
    const id = String(b.req || "");
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(id)) return res.status(400).json({ error: "Pedido inválido." });
    const reqRef = db.collection("mcp_auth_req").doc(id);

    if (action === "deny") {
      const user = await verifyAuth(req);
      if (!user) return res.status(401).json({ error: "Sesión inválida." });
      const snap = await reqRef.get();
      if (!snap.exists) return res.json({ ok: true, redirect: null });
      const d = snap.data();
      await reqRef.delete();
      return res.json({ ok: true, redirect: withParams(d.redirect_uri, { error: "access_denied", state: d.state, iss: d.origin }) });
    }

    const uid = String(b.uid || "");
    const r = await requireUid(req, uid);
    if (!r.ok) return res.status(r.code).json({ error: r.error });
    if (!puedeConectar(r)) return res.status(403).json({ error: "Solo el dueño de la tienda puede conectarla a una app de IA." });

    const code = rnd(32);
    const grantRef = db.collection("mcp_grants").doc(rnd(12));
    let d;
    try {
      d = await db.runTransaction(async (tx) => {
        const snap = await tx.get(reqRef);
        if (!snap.exists) throw new Error("vencido");
        const x = snap.data();
        if (Date.now() > x.exp) throw new Error("vencido");
        tx.delete(reqRef);
        tx.set(grantRef, {
          uid, client_id: x.client_id, client_kind: x.client_kind, label: x.label, host: x.host,
          grantedBy: r.user.uid, createdAt: new Date(), lastUsedAt: null, revoked: false,
        });
        tx.set(db.collection("mcp_codes").doc(sha(code)), {
          grantId: grantRef.id, uid, client_id: x.client_id, redirect_uri: x.redirect_uri,
          code_challenge: x.code_challenge, resource: x.resource, scope: x.scope,
          exp: Date.now() + CODE_TTL * 1000, expiresAt: new Date(Date.now() + CODE_TTL * 1000),
        });
        return x;
      });
    } catch (e) {
      if (e.message === "vencido") return res.status(410).json({ error: "El pedido de conexión venció. Volvé a la app de IA y conectá Growith de nuevo." });
      throw e;
    }
    return res.json({ ok: true, redirect: withParams(d.redirect_uri, { code, state: d.state, iss: d.origin }) });
  }

  if (action === "conexiones" || action === "revocar") {
    const uid = String(req.query.uid || b.uid || "");
    const r = await requireUid(req, uid);
    if (!r.ok) return res.status(r.code).json({ error: r.error });
    const snap = await db.collection("mcp_grants").where("uid", "==", uid).get();
    const activas = snap.docs.filter(g => !g.data().revoked && g.data().activadaAt); // solo las que llegaron a canjear el código

    if (action === "conexiones") {
      const ts = (v) => v?.toDate ? v.toDate().toISOString() : (v || null);
      return res.json({
        ok: true, url: `${origin}/mcp`,
        conexiones: activas.map(g => {
          const x = g.data();
          return { id: g.id, app: x.label, host: x.host, creada: ts(x.createdAt), ultimoUso: ts(x.lastUsedAt) };
        }),
      });
    }

    if (!puedeConectar(r)) return res.status(403).json({ error: "Solo el dueño de la tienda puede desvincular apps de IA." });
    const app = String(b.app || "");
    const ids = activas.filter(g => !b.id ? (!app || g.data().label === app) : g.id === b.id).map(g => g.id);
    for (const gid of ids) {
      await db.collection("mcp_grants").doc(gid).update({ revoked: true, revokedAt: new Date(), revokedBy: r.user.uid });
      for (const col of ["mcp_tokens", "mcp_refresh"]) {
        const ts = await db.collection(col).where("grantId", "==", gid).get();
        await Promise.all(ts.docs.map(t => t.ref.delete()));
      }
    }
    return res.json({ ok: true, revocadas: ids.length });
  }

  // Gemini Enterprise no hace registro dinámico: el dueño genera un Client ID/Secret fijo
  // para cargar en Administrar equipo → Apps conectadas → Agregar servidor MCP.
  if (action === "gemini_credenciales") {
    const uid = String(b.uid || "");
    const r = await requireUid(req, uid);
    if (!r.ok) return res.status(r.code).json({ error: r.error });
    if (!puedeConectar(r)) return res.status(403).json({ error: "Solo el dueño de la tienda puede generar credenciales para Gemini." });
    const client_id = "gs_" + rnd(18), secret = rnd(32);
    await db.collection("mcp_clients").doc(client_id).set({
      kind: "static", client_name: "Gemini Enterprise", redirect_uris: [], redirect_hosts: GEMINI_HOSTS,
      token_endpoint_auth_method: "client_secret_post", secretHash: sha(secret), uid, creadoPor: r.user.uid, createdAt: new Date(),
    });
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, mcp_url: `${origin}/mcp`, authorization_url: `${origin}/oauth/authorize`, token_url: `${origin}/oauth/token`, client_id, client_secret: secret, scopes: SCOPE });
  }

  return res.status(400).json({ error: "Acción desconocida." });
}

// ─── Token ───────────────────────────────────────────────────────────────

async function issueTokens(db, g) {
  const access = rnd(32), refresh = rnd(32), now = Date.now();
  const base = { grantId: g.grantId, uid: g.uid, client_id: g.client_id, resource: g.resource, scope: g.scope };
  await Promise.all([
    db.collection("mcp_tokens").doc(sha(access)).set({ ...base, exp: now + ACCESS_TTL * 1000, expiresAt: new Date(now + ACCESS_TTL * 1000) }),
    db.collection("mcp_refresh").doc(sha(refresh)).set({ ...base, exp: now + REFRESH_TTL * 1000, expiresAt: new Date(now + REFRESH_TTL * 1000) }),
  ]);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: g.scope };
}

async function grantActivo(db, grantId) {
  const g = await db.collection("mcp_grants").doc(String(grantId)).get();
  return g.exists && !g.data().revoked;
}

async function token(req, res, db, origin) {
  const b = bodyOf(req);
  let clientId = b.client_id, clientSecret = b.client_secret;
  const basic = /^Basic\s+(.+)$/i.exec(String(req.headers.authorization || ""));
  if (basic) {
    const [id, sec = ""] = Buffer.from(basic[1], "base64").toString("utf8").split(":");
    clientId = decodeURIComponent(id); clientSecret = decodeURIComponent(sec);
  }
  const client = await getClient(db, clientId);
  if (!client) return oauthErr(res, 401, "invalid_client");
  if (client.secretHash && !sameStr(sha(clientSecret || ""), client.secretHash)) return oauthErr(res, 401, "invalid_client");
  if (!resourceOk(b.resource, origin)) return oauthErr(res, 400, "invalid_target");

  if (b.grant_type === "authorization_code") {
    if (!b.code || !b.code_verifier) return oauthErr(res, 400, "invalid_request", "Faltan code o code_verifier.");
    const ref = db.collection("mcp_codes").doc(sha(b.code));
    // Un solo uso: se lee y se borra en la misma transacción.
    const c = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) return null;
      tx.delete(ref);
      return s.data();
    });
    if (!c || Date.now() > c.exp || c.client_id !== client.id) return oauthErr(res, 400, "invalid_grant");
    if (b.redirect_uri && b.redirect_uri !== c.redirect_uri) return oauthErr(res, 400, "invalid_grant", "redirect_uri distinto.");
    if (!sameStr(b64url(crypto.createHash("sha256").update(String(b.code_verifier)).digest()), c.code_challenge)) {
      return oauthErr(res, 400, "invalid_grant", "PKCE inválido.");
    }
    if (!(await grantActivo(db, c.grantId))) return oauthErr(res, 400, "invalid_grant");
    await db.collection("mcp_grants").doc(String(c.grantId)).update({ activadaAt: new Date() }).catch(() => {});
    res.setHeader("Cache-Control", "no-store");
    return res.json(await issueTokens(db, c));
  }

  if (b.grant_type === "refresh_token") {
    if (!b.refresh_token) return oauthErr(res, 400, "invalid_request", "Falta refresh_token.");
    const ref = db.collection("mcp_refresh").doc(sha(b.refresh_token));
    const t = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) return null;
      tx.delete(ref); // rotación: cada refresh token sirve una sola vez
      return s.data();
    });
    if (!t || Date.now() > t.exp || t.client_id !== client.id) return oauthErr(res, 400, "invalid_grant");
    if (!(await grantActivo(db, t.grantId))) return oauthErr(res, 400, "invalid_grant");
    res.setHeader("Cache-Control", "no-store");
    return res.json(await issueTokens(db, t));
  }

  return oauthErr(res, 400, "unsupported_grant_type");
}

async function revoke(req, res, db) {
  const b = bodyOf(req);
  if (b.token) {
    const h = sha(b.token);
    await Promise.all([db.collection("mcp_tokens").doc(h).delete(), db.collection("mcp_refresh").doc(h).delete()]).catch(() => {});
  }
  return res.status(200).json({});
}

// ─── Servidor MCP ────────────────────────────────────────────────────────

const INSTRUCCIONES = `Growith es la app de gestión del e-commerce del usuario (Argentina): ventas de Tienda Nube, Shopify y Mercado Libre, márgenes, publicidad, stock y envíos.
- Las herramientas devuelven cifras REALES calculadas por Growith. Citá solo esos números: no estimes ni inventes datos del negocio. Si un dato no está, decilo e indicá en qué sección de Growith verlo (https://www.growithapp.com).
- Los montos están en pesos argentinos (ARS) salvo que el campo diga USD. "datos_al" indica cuándo se calcularon las cifras: aclaralo si te preguntan por lo más reciente.
- Respondé en el idioma del usuario (por defecto, español rioplatense con voseo).
- El acceso es de solo lectura, con UNA excepción: meta_accion pausa, activa y cambia presupuestos y pujas (cost cap / bid cap) de Meta cuando la cuenta tiene un token con ads_management (meta_administrador lo indica en "puede_editar"). Sin ese token, cualquier cambio lo hace el usuario desde Growith. Stock, precios y lo demás siempre los cambia el usuario.
- Para revisar o administrar Meta usá meta_administrador: las ventas, revenue, ROAS, CPA y AOV salen de las ventas reales cruzadas por UTM (no del píxel); gasto, CPC, CTR, CPM, frecuencia, pagos iniciados y retención salen de Meta. Antes de cada meta_accion, explicá el motivo con esos números; nunca actúes sobre campañas que el usuario no te pidió administrar.
- La conexión es por USUARIO y cubre todos sus clientes (tiendas). Cada chat tiene UN cliente activo: si el usuario tiene varios y todavía no eligió, llamá a listar_clientes y preguntale cuál (o elegilo vos si lo nombra), y fijalo con seleccionar_cliente. Si tiene uno solo, se usa ese automáticamente; si tiene varios y no eligió, se responde sobre la tienda que tiene abierta en Growith (cada respuesta lo aclara en "cliente"). seleccionar_cliente y cliente_id aceptan el NOMBRE de la tienda (sin distinguir mayúsculas) o el cliente_id. Los números de ventas y rentabilidad se recalculan en vivo si la caché tiene más de 5 minutos: son los mismos que ve el usuario en su Dashboard en ese momento. NO llames a seleccionar_cliente y a una consulta en la misma tanda (en paralelo): primero seleccioná, esperá la respuesta y recién después consultá; o mandá cliente_id directamente en la consulta. Cada respuesta trae el campo "cliente" (id y nombre): verificá que sea el que el usuario pidió. Cuando respondas, aclará de qué cliente son los números.`;

// ─── Rentabilidad de cualquier período y campañas en vivo ────────────────
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (v) => (typeof v === "number" && isFinite(v)) ? +v.toFixed(2) : (parseFloat(v) ? +parseFloat(v).toFixed(2) : 0);
const hoyAR = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
const sumarDias = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const difDias = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const PERIODOS = ["hoy", "ayer", "ultimos_7_dias", "ultimos_30_dias", "ultimos_90_dias", "este_mes", "mes_pasado"];
const PROPS_PERIODO = {
  periodo: { type: "string", enum: PERIODOS, description: "Período predefinido (fechas de Argentina). Se ignora si pasás 'desde'." },
  desde: { type: "string", description: "Inicio del rango, YYYY-MM-DD (opcional)." },
  hasta: { type: "string", description: "Fin del rango, YYYY-MM-DD (opcional; por defecto hoy)." },
};

export function rangoDe(args = {}, porDefecto = "ultimos_30_dias") {
  const hoy = hoyAR();
  if (ISO.test(args.desde || "")) {
    let hasta = ISO.test(args.hasta || "") ? args.hasta : hoy;
    if (hasta > hoy) hasta = hoy;
    if (hasta < args.desde) throw new Error("la fecha 'hasta' es anterior a 'desde'.");
    if (difDias(args.desde, hasta) > 366) throw new Error("el rango máximo es de un año.");
    return { since: args.desde, until: hasta };
  }
  switch (args.periodo || porDefecto) {
    case "hoy": return { since: hoy, until: hoy };
    case "ayer": { const a = sumarDias(hoy, -1); return { since: a, until: a }; }
    case "ultimos_7_dias": return { since: sumarDias(hoy, -6), until: hoy };
    case "ultimos_90_dias": return { since: sumarDias(hoy, -89), until: hoy };
    case "este_mes": return { since: `${hoy.slice(0, 8)}01`, until: hoy };
    case "mes_pasado": { const fin = sumarDias(`${hoy.slice(0, 8)}01`, -1); return { since: `${fin.slice(0, 8)}01`, until: fin }; }
    default: return { since: sumarDias(hoy, -29), until: hoy };
  }
}

// Frescura de los datos que ve la IA: igual que el Dashboard. Una caché más
// vieja que esto se recalcula en vivo antes de responder (30-50 s una vez), y
// cada uso desde la IA cuenta como "acceso" para el warmer de 5 minutos, así
// las próximas consultas salen frescas al instante.
const FRESCURA_MIN = 5;
function warmDocId(uid, key) { return `${uid}__${String(key || "").replace(/[^\w.-]/g, "_")}`.slice(0, 400); }
async function tocarWarmer(db, uid, key, days, since, until, forzar) {
  try {
    await db.collection("system_warm_margenes").doc(warmDocId(uid, key)).set({
      uid, key, days: days || null, date_from: since || null, date_to: until || null,
      lastAccess: new Date().toISOString(), ...(forzar ? { lastWarm: new Date(0).toISOString() } : {}),
    }, { merge: true });
  } catch (_) {}
}
// Últimos 30 días (lo que usan resumen_negocio y rentabilidad_productos): si la
// caché d30 tiene más de FRESCURA_MIN, se recalcula en vivo (fresh=1 saltea
// también la caché de ventas del día) y recién después se lee el snapshot.
async function margenesD30Frescas(db, uid, origin) {
  let edadMin = Infinity;
  try {
    const s = await db.collection("users").doc(uid).collection("margenes_cache").doc("d30").get();
    if (s.exists && s.data()?.cachedAt) edadMin = (Date.now() - Date.parse(s.data().cachedAt)) / 60000;
  } catch (_) {}
  await tocarWarmer(db, uid, "d30", 30, null, null, edadMin > FRESCURA_MIN);
  if (edadMin > FRESCURA_MIN && process.env.CRON_SECRET) {
    try {
      const u = new URL(`${origin}/api/orders`);
      u.searchParams.set("action", "daily_metrics"); u.searchParams.set("uid", uid); u.searchParams.set("days", "30");
      u.searchParams.set("warm", "1"); u.searchParams.set("fresh", "1");
      await fetch(u.toString(), { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` }, signal: AbortSignal.timeout(70000) });
    } catch (e) { console.warn("[mcp] recálculo d30:", e.message); }
  }
}

// Márgenes del período: caché del Dashboard (fresca o de rango cerrado); si no hay,
// lo calcula el motor de Growith por el mismo camino que el warmer (CRON_SECRET).
async function margenesDe(db, uid, origin, since, until) {
  const hoy = hoyAR();
  const col = db.collection("users").doc(uid).collection("margenes_cache");
  const claves = [`${since}_${until}`, ...(until === hoy ? [`d${difDias(since, until) + 1}`] : [])];
  for (const k of claves) {
    const s = await col.doc(k).get();
    if (!s.exists) continue;
    const d = s.data() || {};
    let b; try { b = JSON.parse(d.body || "{}"); } catch { continue; }
    if (b.since !== since || b.until !== until || !b.totals) continue;
    const edadMin = d.cachedAt ? (Date.now() - Date.parse(d.cachedAt)) / 60000 : Infinity;
    if (until < hoy || edadMin <= FRESCURA_MIN) { await tocarWarmer(db, uid, k, k.startsWith("d") ? parseInt(k.slice(1)) : null, k.startsWith("d") ? null : since, k.startsWith("d") ? null : until, false); return { ...b, cachedAt: d.cachedAt || null }; }
  }
  if (!process.env.CRON_SECRET) throw new Error("el servidor no puede calcular ese período ahora (falta CRON_SECRET).");
  const u = new URL(`${origin}/api/orders`);
  u.searchParams.set("action", "daily_metrics"); u.searchParams.set("uid", uid); u.searchParams.set("warm", "1");
  u.searchParams.set("date_from", since); u.searchParams.set("date_to", until); u.searchParams.set("fresh", "1");
  await tocarWarmer(db, uid, `${since}_${until}`, null, since, until, true);
  const r = await fetch(u.toString(), { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` }, signal: AbortSignal.timeout(75000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `el cálculo de rentabilidad falló (HTTP ${r.status}).`);
  if (j.totals) return { ...j, cachedAt: new Date().toISOString() };
  const s = await col.doc(`${since}_${until}`).get();
  const b = s.exists ? JSON.parse(s.data().body || "{}") : null;
  if (!b?.totals) throw new Error("Growith todavía no tiene calculado ese período; probá de nuevo en un minuto.");
  return { ...b, cachedAt: s.data().cachedAt || null };
}

const totalesRent = (x = {}) => ({
  facturacion: r2(x.revenue), ordenes: x.orders || 0, ticket_promedio: r2(x.aov),
  costo_productos: r2(x.costoProductos), impuestos: r2(x.impuestos),
  comision_plataforma: r2(x.comisionPlataforma), comision_pago: r2(x.comisionPago),
  costo_envio: r2(x.costoEnvio), costos_adicionales: r2(x.costosAdicionales),
  inversion_publicitaria: { total: r2(x.adSpend), meta: r2(x.adSpendMeta), google: r2(x.adSpendGoogle), tiktok: r2(x.adSpendTiktok), mercado_ads: r2(x.adSpendMl), otros: r2(x.adSpendExtra) },
  contribucion_antes_de_pauta: r2(x.netRevenue), ganancia_neta: r2(x.profit), margen_neto_pct: r2((x.profitMargin || 0) * 100),
  roas: r2(x.roas), true_roas: r2(x.trueRoas), roas_de_equilibrio: r2(x.breakEvenRoas), cpa: r2(x.cpa), mer_pct: r2((x.mer || 0) * 100),
});

export function armarRentabilidad(b) {
  const ch = b.byChannel || {};
  const avisos = [];
  if (b.meta?.metaTokenExpired) avisos.push("El token de Meta Ads está vencido: el gasto de Meta puede estar incompleto (reconectar en Growith → Meta Ads).");
  if (b.meta?.googleAdsDiag) avisos.push(`Google Ads: ${b.meta.googleAdsDiag}`);
  if (b.meta?.tiktokAdsDiag) avisos.push(`TikTok Ads: ${b.meta.tiktokAdsDiag}`);
  const sinCosto = (b.byProduct || []).filter(p => p.sinCogs).length;
  if (sinCosto) avisos.push(`${sinCosto} producto(s) vendidos no tienen costo cargado en Growith: la ganancia de esos productos está sobreestimada.`);
  return {
    moneda: "ARS",
    periodo: { desde: b.since, hasta: b.until }, periodo_anterior: { desde: b.prevSince, hasta: b.prevUntil },
    datos_al: b.cachedAt || null,
    actual: totalesRent(b.totals), anterior: totalesRent(b.prevTotals),
    por_canal: { tienda: ch.tienda || null, mercado_libre: ch.ml || null, google_ads_atribucion_google: ch.google || null, plataforma_tienda: ch.platform || null },
    productos: (b.byProduct || []).slice(0, 30).map(p => ({
      producto: p.nombre || p.name || p.key, canal: p.canal || null, unidades: p.units || 0,
      facturacion: r2(p.revenue), ganancia: r2(p.profit), margen_pct: r2((p.margin || 0) * 100), sin_costo_cargado: !!p.sinCogs,
    })),
    avisos,
  };
}

const META_V = "v23.0"; // mantener sincronizada con api/meta.js
async function metaCampanas(db, uid, since, until) {
  const snap = await db.collection("users").doc(uid).collection("meta_accounts").get();
  const cuentas = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(a => a.access_token && a.ad_account_id).slice(0, 5);
  if (!cuentas.length) return { conectado: false };
  const g = async (path, params, tok) => {
    const u = new URL(`https://graph.facebook.com/${META_V}/${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set("access_token", tok);
    const r = await fetch(u.toString(), { signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    if (j.error) throw new Error(`Meta: ${j.error.message}`);
    return j.data || [];
  };
  const COMPRA = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"];
  const deTipo = (arr) => { for (const t of COMPRA) { const x = (arr || []).find(a => a.action_type === t); if (x) return parseFloat(x.value) || 0; } return 0; };
  return {
    conectado: true,
    cuentas: await Promise.all(cuentas.map(async a => {
      try {
        const [ins, camps] = await Promise.all([
          g(`${a.ad_account_id}/insights`, { level: "campaign", fields: "campaign_id,campaign_name,spend,impressions,clicks,ctr,cpc,actions,action_values", time_range: JSON.stringify({ since, until }), limit: "300" }, a.access_token),
          g(`${a.ad_account_id}/campaigns`, { fields: "id,name,effective_status,daily_budget", limit: "300" }, a.access_token).catch(() => []),
        ]);
        const est = Object.fromEntries(camps.map(c => [String(c.id), c]));
        const filas = ins.map(r => {
          const gasto = r2(r.spend), compras = deTipo(r.actions), valor = r2(deTipo(r.action_values));
          const c = est[String(r.campaign_id)] || {};
          return { id: r.campaign_id, campana: r.campaign_name, estado: c.effective_status || null, presupuesto_diario: c.daily_budget ? r2(c.daily_budget / 100) : null,
            gasto, impresiones: parseInt(r.impressions) || 0, clicks: parseInt(r.clicks) || 0, ctr_pct: r2(r.ctr), cpc: r2(r.cpc), compras, valor_compras: valor, roas: gasto ? r2(valor / gasto) : 0, costo_por_compra: compras ? r2(gasto / compras) : null };
        }).sort((x, y) => y.gasto - x.gasto);
        const gasto = filas.reduce((t, f) => t + f.gasto, 0), valor = filas.reduce((t, f) => t + f.valor_compras, 0), compras = filas.reduce((t, f) => t + f.compras, 0);
        return { cuenta: a.ad_account_name || a.ad_account_id, moneda: a.currency || "USD", ...(a.token_invalid ? { aviso: "token vencido: reconectar Meta en Growith" } : {}),
          totales: { gasto: r2(gasto), compras, valor_compras: r2(valor), roas: gasto ? r2(valor / gasto) : 0 }, campanas: filas.slice(0, 30) };
      } catch (e) { return { cuenta: a.ad_account_name || a.ad_account_id, error: e.message }; }
    })),
  };
}

// ─── Administrador de Meta: lectura con ventas reales por UTM y cambios con ads_management ───
async function metaGetJ(path, params, tok) {
  const u = new URL(`https://graph.facebook.com/${META_V}/${path}`);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
  u.searchParams.set("access_token", tok);
  const r = await fetch(u.toString(), { signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (j.error) throw new Error(`Meta: ${j.error.error_user_msg || j.error.message}`);
  return j;
}
async function metaTodo(path, params, tok, max = 10) {
  let j = await metaGetJ(path, params, tok); const out = [...(j.data || [])];
  for (let i = 0; j.paging?.next && i < max; i++) { j = await (await fetch(j.paging.next, { signal: AbortSignal.timeout(20000) })).json(); if (j.error) break; out.push(...(j.data || [])); }
  return out;
}
// Mismo criterio y caché (6 h en la cuenta) que api/meta.js → puedeEditar.
async function tokenEditable(db, uid, a) {
  const p = a.permiso_edicion;
  if (p && Date.now() - (p.ts || 0) < 6 * 3600000) return !!p.ok;
  let ok = false;
  try { ok = (await metaGetJ("me/permissions", {}, a.access_token)).data?.some(x => x.permission === "ads_management" && x.status === "granted") || false; }
  catch (_) { return !!p?.ok; }
  db.collection("users").doc(uid).collection("meta_accounts").doc(String(a.id)).set({ permiso_edicion: { ok, ts: Date.now() } }, { merge: true }).catch(() => {});
  return ok;
}
async function metaTokens(db, uid) {
  const snap = await db.collection("users").doc(uid).collection("meta_accounts").get();
  const vistos = new Set();
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(a => a.access_token && !vistos.has(a.access_token) && vistos.add(a.access_token));
}

// Zona horaria por país (código de 2 letras de la tienda o del nombre de la campaña).
const PAIS_TZ = {
  AR: "America/Argentina/Buenos_Aires", UY: "America/Montevideo", CL: "America/Santiago", PE: "America/Lima", CO: "America/Bogota", MX: "America/Mexico_City",
  BR: "America/Sao_Paulo", PY: "America/Asuncion", BO: "America/La_Paz", EC: "America/Guayaquil", VE: "America/Caracas", US: "America/New_York", CA: "America/Toronto",
  ES: "Europe/Madrid", PT: "Europe/Lisbon", IT: "Europe/Rome", FR: "Europe/Paris", DE: "Europe/Berlin", AT: "Europe/Vienna", CH: "Europe/Zurich", BE: "Europe/Brussels",
  NL: "Europe/Amsterdam", UK: "Europe/London", GB: "Europe/London", IE: "Europe/Dublin", PL: "Europe/Warsaw", CZ: "Europe/Prague", SK: "Europe/Bratislava", HU: "Europe/Budapest",
  RO: "Europe/Bucharest", MD: "Europe/Chisinau", BG: "Europe/Sofia", GR: "Europe/Athens", TR: "Europe/Istanbul", HR: "Europe/Zagreb", SI: "Europe/Ljubljana", RS: "Europe/Belgrade",
  SE: "Europe/Stockholm", NO: "Europe/Oslo", DK: "Europe/Copenhagen", FI: "Europe/Helsinki", LT: "Europe/Vilnius", LV: "Europe/Riga", EE: "Europe/Tallinn", UA: "Europe/Kyiv",
  ZA: "Africa/Johannesburg", NG: "Africa/Lagos", KE: "Africa/Nairobi", EG: "Africa/Cairo", MA: "Africa/Casablanca", AE: "Asia/Dubai", SA: "Asia/Riyadh", IL: "Asia/Jerusalem",
  IN: "Asia/Kolkata", PH: "Asia/Manila", ID: "Asia/Jakarta", MY: "Asia/Kuala_Lumpur", SG: "Asia/Singapore", TH: "Asia/Bangkok", VN: "Asia/Ho_Chi_Minh", JP: "Asia/Tokyo", AU: "Australia/Sydney", NZ: "Pacific/Auckland",
};
const hoyEn = (tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
const sumaDias = (ymd, n) => new Date(Date.parse(ymd + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

async function metaAdministrador(db, uid, args) {
  const hoy = hoyAR();
  // ventana: "rango" (desde/hasta en hora Argentina), "hoy_local" (desde las 00:00 de la hora local
  // del país de cada campaña) o "ultimas_horas" (las últimas `horas` horas, hasta ahora).
  const ventana = ["hoy_local", "ultimas_horas"].includes(args.ventana) ? args.ventana : "rango";
  const horas = Math.min(48, Math.max(1, parseInt(args.horas) || 2));
  const ahora = Date.now();
  const desde = ventana !== "rango" ? sumaDias(hoy, -1) : ISO.test(args.desde || "") ? args.desde : hoy;
  const hasta = ventana !== "rango" ? sumaDias(hoy, 1) : ISO.test(args.hasta || "") ? args.hasta : desde;
  if (hasta < desde || difDias(desde, hasta) > 92) throw new Error("rango inválido (máximo 92 días).");
  const nivel = ["campaign", "adset", "ad"].includes(args.nivel) ? args.nivel : "campaign";
  const campId = /^\d+$/.test(String(args.campana_id || "")) ? String(args.campana_id) : null;
  const tokens = await metaTokens(db, uid);
  if (!tokens.length) return { conectado: false, aviso: "El cliente no tiene Meta conectado en Growith." };
  const cfg = (await db.collection("users").doc(uid).collection("impultienda_cfg").doc("main").get()).data() || {};
  const elegidas = cfg.metaCuentas || [];
  // Cuentas publicitarias: las elegidas en Growith (o la de cada conexión), con el token que las ve.
  const cuentas = [], vistas = new Set();
  for (const t of tokens) {
    const editable = await tokenEditable(db, uid, t);
    let lista = [];
    if (elegidas.length) { try { lista = (await metaTodo("me/adaccounts", { fields: "account_id,name,currency,timezone_name", limit: "200" }, t.access_token, 3)).map(c => ({ id: "act_" + c.account_id, nombre: c.name, moneda: c.currency, tz: c.timezone_name })); } catch (_) {} }
    else if (t.ad_account_id) lista = [{ id: t.ad_account_id, nombre: t.ad_account_name || t.ad_account_id, moneda: t.currency || "USD", tz: t.timezone_name }];
    for (const c of lista) if (!vistas.has(c.id) && (!elegidas.length || elegidas.includes(c.id))) { vistas.add(c.id); cuentas.push({ ...c, tok: t.access_token, editable }); }
  }
  // Ventas reales por UTM (Impultienda); sin Impultienda quedan las de Meta.
  let atr = null;
  if ((cfg.secretEnc || elegidas.length)) {
    try {
      // Índice de campañas/anuncios: completo cada 3 h y, en el medio, cada 5 min se suman los
      // anuncios de los últimos 2 días (así una venta de un anuncio recién creado ya cruza).
      let idx = await leerIndiceUtm(db, uid);
      if (!idx || ahora - (idx.ts0 || idx.ts || 0) > 3 * 3600000) { idx = await construirIndiceUtm(db, uid, Math.max(60, idx?.dias || 0)); db.collection("users").doc(uid).collection("impultienda_cfg").doc("utm_idx").set({ ts0: idx.ts }, { merge: true }).catch(() => {}); idx.ts0 = idx.ts; }
      else if (ahora - (idx.ts || 0) > 5 * 60000) idx = await construirIndiceUtm(db, uid, 2, idx);
      const opts = ventana === "ultimas_horas" ? { desdeMs: ahora - horas * 3600000, hastaMs: ahora + 60000 }
        : ventana === "hoy_local" ? { dentro: (o, t) => { const tz = PAIS_TZ[String(t?.pais || "").toUpperCase().split(/[^A-Z]+/)[0]] || "America/Argentina/Buenos_Aires"; return zonaDe(o.ev_approved, tz)?.fecha === hoyEn(tz); } } : {};
      atr = await utmAtribucion(db, uid, desde, hasta, "America/Argentina/Buenos_Aires", idx, opts);
    } catch (_) { atr = null; }
  }
  const fx = await fxPorUsd();
  const k = nivel === "campaign" ? "c" : nivel === "adset" ? "s" : "a";
  const idF = nivel + "_id";
  const CHK = (a) => a.action_type === "initiate_checkout" || a.action_type === "offsite_conversion.fb_pixel_initiate_checkout";
  const COMPRA = (a) => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase";
  const filas = [], errores = [], frescura = [];
  // Zona del país de una campaña: la tienda donde más vendió, o el código de país del nombre.
  const tzCampana = (campId, nombre, tzCuenta) => {
    const ct = atr?.ct?.[campId]; const top = ct && Object.entries(ct).sort((x, y) => y[1] - x[1])[0];
    const pT = top && String(atr.tiendas?.[top[0]]?.pais || "").toUpperCase().split(/[^A-Z]+/)[0];
    if (pT && PAIS_TZ[pT]) return PAIS_TZ[pT];
    const cod = String(nombre || "").toUpperCase().split(/[^A-Z]+/).find(w => w.length === 2 && PAIS_TZ[w]);
    return cod ? PAIS_TZ[cod] : tzCuenta;
  };
  // Gasto de una ventana por hora (desglose horario de Meta, en la zona de la cuenta). Lo que Meta
  // todavía no repartió por hora (el día ya lo cuenta) se suma a la fila: son las horas más recientes.
  const insVentana = async (c, filtro) => {
    const tzC = c.tz || "America/Los_Angeles", hoyC = hoyEn(tzC);
    const base = { level: nivel, time_range: JSON.stringify({ since: sumaDias(hoyC, -2), until: hoyC }), limit: "500", ...filtro };
    const [hs, dia] = await Promise.all([
      metaTodo(`${c.id}/insights`, { ...base, fields: "campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,clicks,actions", time_increment: "1", breakdowns: "hourly_stats_aggregated_by_advertiser_time_zone" }, c.tok, 60),
      metaTodo(`${c.id}/insights`, { ...base, fields: `${idF},campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend`, time_range: JSON.stringify({ since: hoyC, until: hoyC }) }, c.tok, 10).catch(() => []),
    ]);
    const acc = {}, hoyHoras = {};
    let ultima = null;
    const suma = (r, x) => {
      r.spend += parseFloat(x.spend) || 0; r.impressions += parseInt(x.impressions) || 0; r.clicks += parseInt(x.clicks) || 0;
      for (const a of x.actions || []) r._act[a.action_type] = (r._act[a.action_type] || 0) + (parseFloat(a.value) || 0);
    };
    const nueva = (x) => ({ campaign_id: x.campaign_id, campaign_name: x.campaign_name, adset_id: x.adset_id, adset_name: x.adset_name, ad_id: x.ad_id, ad_name: x.ad_name, spend: 0, impressions: 0, clicks: 0, _act: {} });
    for (const x of hs) {
      const hh = parseInt(String(x.hourly_stats_aggregated_by_advertiser_time_zone || "").slice(0, 2), 10);
      if (!isFinite(hh)) continue;
      const id = String(x[idF]);
      if (x.date_start === hoyC) hoyHoras[id] = (hoyHoras[id] || 0) + (parseFloat(x.spend) || 0);
      const ini = utcDeLocal(x.date_start, hh, tzC);
      if ((parseFloat(x.spend) || 0) > 0 && (!ultima || ini > ultima)) ultima = ini;
      let ok;
      if (ventana === "ultimas_horas") ok = ini + 3600000 > ahora - horas * 3600000 && ini <= ahora;
      else { const tz = tzCampana(String(x.campaign_id), x.campaign_name, tzC); ok = zonaDe(new Date(ini).toISOString(), tz)?.fecha === hoyEn(tz); }
      if (!ok) continue;
      suma(acc[id] || (acc[id] = nueva(x)), x);
    }
    let sinHora = 0;
    for (const d of dia) {
      const id = String(d[idF]); const falta = (parseFloat(d.spend) || 0) - (hoyHoras[id] || 0);
      if (falta > 0.01) { (acc[id] || (acc[id] = nueva(d))).spend += falta; sinHora += falta; }
    }
    frescura.push({ cuenta: c.nombre, zona_cuenta: tzC, ultima_hora_con_gasto: ultima ? new Date(ultima).toISOString() : null, gasto_aun_sin_hora: r2(sinHora) });
    return Object.values(acc).map(r => ({ ...r, ctr: r.impressions ? r.clicks / r.impressions * 100 : 0, cpc: r.clicks ? r.spend / r.clicks : 0, cpm: r.impressions ? r.spend / r.impressions * 1000 : 0,
      actions: Object.entries(r._act).map(([action_type, value]) => ({ action_type, value })) }));
  };
  await Promise.all(cuentas.slice(0, 40).map(async c => {
    try {
      const filtro = campId ? { filtering: JSON.stringify([{ field: "campaign.id", operator: "EQUAL", value: campId }]) } : {};
      const edge = nivel === "campaign" ? "campaigns" : nivel === "adset" ? "adsets" : "ads";
      const [ins, nodos] = await Promise.all([
        ventana !== "rango" ? insVentana(c, filtro) : metaTodo(`${c.id}/insights`, { level: nivel, fields: "campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,clicks,ctr,cpc,cpm,frequency,actions,action_values,video_avg_time_watched_actions", time_range: JSON.stringify({ since: desde, until: hasta }), limit: "500", ...filtro }, c.tok),
        metaTodo(`${c.id}/${edge}`, { fields: `id,name,effective_status,daily_budget,lifetime_budget,bid_strategy${nivel === "adset" ? ",bid_amount" : ""}${nivel !== "campaign" ? ",campaign_id" : ""}`, limit: "300", ...filtro }, c.tok, 5).catch(() => []),
      ]);
      const nodo = Object.fromEntries(nodos.map(n => [String(n.id), n]));
      const kfx = String(c.moneda || "USD").toUpperCase() === "USD" ? 1 : Number(fx?.[String(c.moneda).toUpperCase()]) || null;
      const conGasto = new Set();
      const fila = (id, r) => {
        const n = nodo[id] || {};
        const gasto = r2(r?.spend), impr = parseInt(r?.impressions) || 0;
        const v3 = parseInt((r?.actions || []).find(a => a.action_type === "video_view")?.value) || 0;
        const chk = parseInt((r?.actions || []).find(CHK)?.value) || 0;
        const real = atr ? (atr[k][id] || { n: 0, rev: 0 }) : null;
        const gastoUsd = kfx ? gasto / kfx : null;
        const ventas = real ? real.n : parseInt((r?.actions || []).find(COMPRA)?.value) || 0;
        const revUsd = real ? real.rev : (kfx ? (parseFloat((r?.action_values || []).find(COMPRA)?.value) || 0) / kfx : null);
        const ct = atr?.ct?.[nivel === "campaign" ? id : (r?.campaign_id || n.campaign_id)];
        const top = ct && Object.entries(ct).sort((x, y) => y[1] - x[1])[0];
        return {
          id, nombre: r?.[nivel + "_name"] || n.name || "", cuenta: c.nombre, cuenta_id: c.id, moneda_cuenta: c.moneda,
          ...(nivel !== "campaign" ? { campana_id: r?.campaign_id || n.campaign_id || null } : {}),
          estado: n.effective_status || null,
          presupuesto_diario: n.daily_budget ? r2(n.daily_budget / 100) : null,
          presupuesto_total: n.lifetime_budget && n.lifetime_budget !== "0" ? r2(n.lifetime_budget / 100) : null,
          ...(n.bid_strategy ? { estrategia_puja: n.bid_strategy } : {}), ...(n.bid_amount ? { puja: r2(n.bid_amount / 100) } : {}),
          tienda_id: top ? top[0] : null,
          gasto, gasto_usd: gastoUsd != null ? r2(gastoUsd) : null,
          ventas, revenue_usd: revUsd != null ? r2(revUsd) : null,
          roas: gastoUsd && revUsd != null ? r2(revUsd / gastoUsd) : null,
          cpa_usd: ventas && gastoUsd ? r2(gastoUsd / ventas) : null,
          aov_usd: ventas && revUsd != null ? r2(revUsd / ventas) : null,
          cpc: r2(r?.cpc), ctr_pct: r2(r?.ctr), cpm: r2(r?.cpm), frecuencia: r?.frequency != null ? r2(r.frequency) : null,
          pagos_iniciados: chk, costo_pago_iniciado: chk ? r2(gasto / chk) : null,
          retencion_3s_pct: impr ? r2(v3 / impr * 100) : null,
          tiempo_prom_video_s: r2((r?.video_avg_time_watched_actions || [])[0]?.value),
        };
      };
      for (const r of ins) { const id = String(r[idF]); conGasto.add(id); filas.push(fila(id, r)); }
      // Activas sin gasto en el período también se listan (para poder actuar sobre ellas).
      for (const n of nodos) if (!conGasto.has(String(n.id)) && n.effective_status === "ACTIVE") filas.push(fila(String(n.id), null));
    } catch (e) { errores.push(`${c.nombre}: ${e.message}`); }
  }));
  // Agrupado por tienda (país de la tienda de Impultienda), como en Growith.
  const tiendas = atr?.tiendas || {};
  const porPais = {};
  for (const t of Object.values(tiendas)) if (t.pais) (porPais[t.pais] = porPais[t.pais] || []).push(t.id);
  for (const f of filas) if (!f.tienda_id) { const cod = String(f.nombre).toUpperCase().split(/[^A-Z]+/).find(w => w.length === 2 && porPais[w]?.length === 1); if (cod) f.tienda_id = porPais[cod][0]; }
  const grupos = {};
  for (const f of filas.sort((x, y) => (y.gasto_usd || 0) - (x.gasto_usd || 0))) {
    const key = f.tienda_id || "_";
    const g = grupos[key] || (grupos[key] = { tienda: key === "_" ? "Sin tienda" : (tiendas[key]?.nombre || key), pais: tiendas[key]?.pais || null, gasto_usd: 0, ventas: 0, revenue_usd: 0, filas: [] });
    g.gasto_usd += f.gasto_usd || 0; g.ventas += f.ventas; g.revenue_usd += f.revenue_usd || 0; g.filas.push(f);
  }
  const bloques = Object.values(grupos).map(g => ({ ...g, gasto_usd: r2(g.gasto_usd), revenue_usd: r2(g.revenue_usd), roas: g.gasto_usd ? r2(g.revenue_usd / g.gasto_usd) : null, cpa_usd: g.ventas && g.gasto_usd ? r2(g.gasto_usd / g.ventas) : null, filas: g.filas.slice(0, 60) }));
  const tot = bloques.reduce((t, b) => ({ g: t.g + b.gasto_usd, n: t.n + b.ventas, r: t.r + b.revenue_usd }), { g: 0, n: 0, r: 0 });
  return {
    ...(ventana === "rango" ? { desde, hasta } : ventana === "hoy_local" ? { ventana: "hoy desde las 00:00 de la hora local del país de cada campaña" } : { ventana: `últimas ${horas} h`, desde_utc: new Date(ahora - horas * 3600000).toISOString(), hasta_utc: new Date(ahora).toISOString() }),
    nivel, ...(campId ? { campana_id: campId } : {}),
    datos: { leidos_utc: new Date(ahora).toISOString(), ventas: "en vivo (webhooks de Impultienda, llegan en segundos)", gasto: "en vivo desde la API de Meta en cada llamada (Meta lo actualiza con 15 a 60 min de atraso)", ultima_venta_recibida: atr?.ultimaVenta || null, ...(frescura.length ? { meta_por_cuenta: frescura } : {}) },
    fuente_ventas: atr ? "ventas reales de Impultienda cruzadas por UTM (las que no cruzan no se cuentan)" : "píxel de Meta (el cliente no tiene Impultienda)",
    puede_editar: cuentas.some(c => c.editable),
    cuentas: cuentas.map(c => ({ id: c.id, nombre: c.nombre, moneda: c.moneda, puede_editar: c.editable })),
    totales: { gasto_usd: r2(tot.g), ventas: tot.n, revenue_usd: r2(tot.r), roas: tot.g ? r2(tot.r / tot.g) : null, cpa_usd: tot.n && tot.g ? r2(tot.g / tot.n) : null },
    por_tienda: bloques,
    ...(errores.length ? { errores } : {}),
  };
}

async function metaAccion(db, uid, args, grantId) {
  const id = String(args.id || "").trim();
  if (!/^\d{5,25}$/.test(id)) throw new Error("id inválido: usá el id que devuelve meta_administrador.");
  const accion = args.accion;
  if (!["pausar", "activar", "presupuesto", "puja"].includes(accion)) throw new Error("accion inválida.");
  const motivo = String(args.motivo || "").trim().slice(0, 500);
  if (!motivo) throw new Error("falta el motivo.");
  // El primer token con ads_management que ve ese id.
  let tok = null, nodo = null, sinPermiso = 0;
  for (const t of await metaTokens(db, uid)) {
    if (!(await tokenEditable(db, uid, t))) { sinPermiso++; continue; }
    try { nodo = await metaGetJ(id, { fields: "id,name,effective_status,status,daily_budget,lifetime_budget" }, t.access_token); tok = t.access_token; break; } catch (_) {}
  }
  if (!tok) throw new Error(sinPermiso ? "Ninguna conexión de Meta de este cliente tiene ads_management: el usuario tiene que cargar en Growith (Meta Ads → Cuenta) un token de usuario del sistema con ese permiso." : "Ningún token de este cliente ve ese id (o no tiene ads_management).");
  const post = async (body) => {
    const r = await fetch(`https://graph.facebook.com/${META_V}/${id}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...body, access_token: tok }).toString(), signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    if (j.error) throw new Error(`Meta: ${j.error.error_user_msg || j.error.message}`);
    return j;
  };
  let antes, despues;
  if (accion === "puja") {
    // Puja / costo objetivo de un CONJUNTO (bid cap o cost cap). Va en la moneda de la cuenta.
    const nueva = Number(args.puja);
    if (!isFinite(nueva) || nueva <= 0) throw new Error("puja inválida.");
    let set;
    try { set = await metaGetJ(id, { fields: "id,name,bid_amount,bid_strategy" }, tok); } catch (_) { throw new Error(`"${nodo.name}" no es un conjunto de anuncios: la puja y el cost cap se cambian en cada conjunto (usá meta_administrador con nivel=adset).`); }
    const estrategia = ["COST_CAP", "LOWEST_COST_WITH_BID_CAP"].includes(args.estrategia) ? args.estrategia : null;
    const actual = parseInt(set.bid_amount) || 0;
    const cent = Math.round(nueva * 100);
    if (!actual && !estrategia) throw new Error(`"${set.name}" no tiene puja (${set.bid_strategy || "costo más bajo"}). Para ponerle una, mandá estrategia COST_CAP o LOWEST_COST_WITH_BID_CAP.`);
    if (actual && (cent > actual * 5 || cent < actual / 5)) throw new Error(`Cambio demasiado grande: de ${actual / 100} a ${nueva}. Por llamada se permite entre 1/5 y 5 veces la puja actual.`);
    await post({ bid_amount: String(cent), ...(estrategia ? { bid_strategy: estrategia } : {}) });
    antes = actual ? `${actual / 100} (${set.bid_strategy})` : set.bid_strategy || "sin puja"; despues = `${cent / 100} (${estrategia || set.bid_strategy})`;
  } else if (accion === "presupuesto") {
    const nuevo = Number(args.presupuesto_diario);
    if (!isFinite(nuevo) || nuevo <= 0) throw new Error("presupuesto_diario inválido.");
    const actual = parseInt(nodo.daily_budget) || 0;
    if (!actual) throw new Error(`"${nodo.name}" no tiene presupuesto diario propio (está en sus conjuntos, en la campaña o es un presupuesto total).`);
    const cent = Math.round(nuevo * 100);
    if (cent > actual * 5 || cent < actual / 5) throw new Error(`Cambio demasiado grande: de ${actual / 100} a ${nuevo}. Por llamada se permite entre 1/5 y 5 veces el actual.`);
    await post({ daily_budget: String(cent) });
    antes = actual / 100; despues = cent / 100;
  } else {
    const st = accion === "pausar" ? "PAUSED" : "ACTIVE";
    await post({ status: st });
    antes = nodo.status || nodo.effective_status; despues = st;
  }
  await db.collection("users").doc(uid).collection("meta_acciones_ia").add({ at: new Date(), accion, id, nombre: nodo.name || "", antes, despues, motivo, grantId: grantId || null }).catch(() => {});
  return { ok: true, accion, id, nombre: nodo.name || "", antes, despues, motivo };
}

async function googleCampanas(db, uid, u, since, until) {
  const g = u.googleAds;
  if (!g?.refresh_token) return { conectado: false };
  const { accounts, errors } = await gadsCuentas(db, uid, g);
  const cuentas = await Promise.all(accounts.slice(0, 3).map(async a => {
    try {
      const { campaigns } = await gadsReporteCampanas(g, a.id, a.login, since, until);
      const filas = campaigns.filter(c => c.spend > 0 || c.status === "ENABLED").slice(0, 30).map(c => ({
        id: c.id, campana: c.name, estado: c.status, tipo: c.channel, presupuesto_diario: c.budget, gasto: c.spend, impresiones: c.impressions, clicks: c.clicks,
        ctr_pct: c.ctr, cpc: c.cpc, conversiones: c.conversions, valor_conversiones: c.conv_value, roas: c.roas, cpa: c.cpa,
      }));
      const gasto = campaigns.reduce((t, c) => t + c.spend, 0), valor = campaigns.reduce((t, c) => t + c.conv_value, 0);
      return { cuenta: a.name, moneda: a.currency, totales: { gasto: r2(gasto), conversiones: r2(campaigns.reduce((t, c) => t + c.conversions, 0)), valor_conversiones: r2(valor), roas: gasto ? r2(valor / gasto) : 0 }, campanas: filas };
    } catch (e) { return { cuenta: a.name, error: e.message }; }
  }));
  return { conectado: true, cuentas, ...(errors.length && !accounts.length ? { error: errors[0].error } : {}) };
}

async function tiktokCampanas(u, since, until) {
  const t = u.tiktokAds;
  if (!t?.access_token) return { conectado: false };
  const cuentas = await Promise.all((t.advertisers || []).slice(0, 3).map(async a => {
    try {
      const { campaigns, hayCompras } = await ttReporteCampanas(t, String(a.id), since, until);
      const filas = campaigns.filter(c => c.spend > 0 || c.status === "ENABLED").slice(0, 30).map(c => ({
        id: c.id, campana: c.name, estado: c.status, objetivo: c.objective, presupuesto_diario: c.budget, gasto: c.spend, impresiones: c.impressions, clicks: c.clicks,
        ctr_pct: c.ctr, cpc: c.cpc, conversiones: c.conversions, ...(hayCompras ? { compras: c.purchases, valor_compras: c.value, roas: c.roas } : {}), cpa: c.cpa,
      }));
      return { cuenta: a.name, moneda: a.currency || null, totales: { gasto: r2(campaigns.reduce((t2, c) => t2 + c.spend, 0)), conversiones: r2(campaigns.reduce((t2, c) => t2 + c.conversions, 0)) }, campanas: filas };
    } catch (e) { return { cuenta: a.name, error: e.message }; }
  }));
  return { conectado: true, cuentas };
}

const SEC = [{ type: "oauth2", scopes: [SCOPE] }];
const ANN = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const SIN_ARGS = { type: "object", properties: {}, additionalProperties: false };
// Toda herramienta que responde sobre un cliente acepta `cliente_id` opcional:
// pisa al de la sesión en ESA llamada. Evita la carrera cuando la app de IA
// dispara seleccionar_cliente y una consulta en paralelo (la consulta llegaba
// con el cliente viejo de la sesión).
const CLIENTE_OPC = { cliente_id: { type: "string", description: "Opcional: cliente_id (de listar_clientes) sobre el que responder en esta llamada. Si no se manda, se usa el cliente activo del chat." } };
const conCliente = (schema) => ({ ...schema, properties: { ...CLIENTE_OPC, ...(schema.properties || {}) } });
const tool = (name, title, description, inputSchema = SIN_ARGS, ann = ANN) => ({
  name, title, description, inputSchema: ["listar_clientes", "seleccionar_cliente", "obtener_token_ml"].includes(name) ? inputSchema : conCliente(inputSchema),
  annotations: { title, ...ann },
  securitySchemes: SEC,
  _meta: { securitySchemes: SEC, "openai/toolInvocation/invoking": "Consultando Growith…", "openai/toolInvocation/invoked": "Datos de Growith listos" },
});

const TOOLS = [
  tool("resumen_negocio", "Resumen del negocio",
    "Facturación, ganancia neta, margen, inversión en publicidad (Meta, Mercado Libre, Google, TikTok), ROAS, CPA y órdenes de la tienda: últimos 30 días, últimos 7 días y ayer, con desglose por canal, cashflow de Mercado Pago, metas configuradas, los 5 productos que más facturan y qué falta configurar en la cuenta. Usala para preguntas generales de ventas, ganancias o rentabilidad."),
  tool("rentabilidad_productos", "Rentabilidad por producto",
    "Productos de los últimos 30 días con facturación, ganancia, margen y unidades vendidas, ordenados por facturación. Marca los productos sin costo cargado (su ganancia no es real). Usala para saber qué productos dejan o pierden plata.",
    { type: "object", properties: { limite: { type: "integer", minimum: 1, maximum: 50, description: "Cuántos productos devolver (default 15)." } }, additionalProperties: false }),
  tool("stock", "Stock y alertas de quiebre",
    "Inventario central de Growith y stock por variante según la tienda, con unidades vendidas en los últimos 7 días, días de stock restantes y alertas de productos agotados o por agotarse."),
  tool("envios", "Estado de los envíos",
    "Envíos de los últimos 60 días: cuántos están en seguimiento, por estado (en camino, en sucursal, entregado, devolución…), alertas de paquetes demorados, sin retirar o con visita fallida, y días promedio de despacho a entrega."),
  tool("publicidad_y_cuentas", "Cuentas conectadas y campañas",
    "Tiendas conectadas, cuentas de Meta Ads (con aviso si el token venció), campañas de Meta con su estado y presupuesto diario, y metas de ROAS/margen configuradas."),
  tool("rentabilidad", "Rentabilidad de un período",
    "Resultado real de CUALQUIER período con el motor de Growith, comparado con el período anterior: facturación, órdenes, ticket promedio, costo de productos, impuestos, comisiones, envíos, costos fijos, inversión publicitaria por plataforma (Meta, Google, TikTok, Mercado Ads), ganancia neta, margen, ROAS, True ROAS, ROAS de equilibrio y CPA, más desglose por canal y por producto. Usala para preguntas de un período puntual (\"¿cuánto gané en agosto?\", \"¿cómo me fue ayer?\"). Montos en ARS. Si el período no estaba calculado puede tardar hasta un minuto.",
    { type: "object", properties: PROPS_PERIODO, additionalProperties: false }),
  tool("productos_digitales", "Ventas por tienda, hora y campaña (Impultienda)",
    "SOLO para clientes con tienda Impultienda (productos digitales). Devuelve las 16 métricas del Dashboard YA CALCULADAS por Growith (revenue, profit, ad spend, break even, ROAS, margen, CPA break even, true ROAS, CPA real, ventas, AOV, promedio por tienda, comisiones, revenue front, revenue backend post-compra, reembolsos): usalas tal cual, no las recalcules. Cada campaña trae las ventas REALES (Impultienda + UTM) y meta_dice (lo que reporta Meta) para compararlas. Ventas en USD de cada tienda (una por país), gasto de Meta asignado a cada tienda por el país de la campaña, comisiones reales de Mercado Pago/Stripe, reembolsos y ganancia, por hora en hora Argentina (00:00 ART = día nuevo). Incluye las campañas con las ventas cruzadas por UTM (id de campaña, nombre o código de país) y, dentro de cada campaña, las ventas por anuncio (utm_content). desde/hasta en AAAA-MM-DD (hora Argentina, máximo 31 días; por defecto hoy).",
    { type: "object", properties: { desde: { type: "string", description: "AAAA-MM-DD (hora Argentina)" }, hasta: { type: "string", description: "AAAA-MM-DD (hora Argentina)" } }, additionalProperties: false }),
  tool("campanas_publicidad", "Campañas de Meta, Google y TikTok",
    "Campañas de Meta Ads, Google Ads y TikTok Ads conectadas a Growith con métricas del período: estado, presupuesto, gasto, impresiones, clicks, CTR, CPC, conversiones o compras, valor y ROAS según cada plataforma. Cada cuenta indica su moneda. Por defecto, últimos 7 días de todas las plataformas.",
    { type: "object", properties: { plataforma: { type: "string", enum: ["todas", "meta", "google", "tiktok"], description: "Plataforma a consultar (por defecto todas)." }, ...PROPS_PERIODO }, additionalProperties: false }),
  tool("meta_administrador", "Administrador de Meta Ads con ventas reales",
    "Todas las campañas de Meta de las cuentas publicitarias del cliente (las elegidas en Growith), agrupadas por tienda, como el Administrador de anuncios pero con ventas REALES: ventas, revenue (USD), ROAS, CPA y AOV salen de las ventas de Impultienda cruzadas por UTM; gasto, CPC, CTR, CPM, frecuencia, pagos iniciados, retención 3 s y tiempo promedio de video salen de Meta. Cada fila trae id (para meta_accion), estado, presupuesto diario y la cuenta. 'puede_editar' dice si se pueden aplicar cambios con meta_accion. nivel: campaign (default), adset o ad; con campana_id se ven solo los conjuntos/anuncios de esa campaña. desde/hasta AAAA-MM-DD (por defecto hoy, hora Argentina). Con ventana=hoy_local da lo que va del día desde las 00:00 de la hora local del país de cada campaña (gasto y ventas), y con ventana=ultimas_horas las últimas N horas (por ejemplo 2). Todo se lee en vivo en cada llamada (ventas por webhook en segundos; gasto de Meta con su atraso de 15 a 60 min, el gasto que Meta todavía no repartió por hora se suma a la fila); 'datos' dice cuándo se leyó y la última hora con gasto de cada cuenta. Las filas de conjuntos traen estrategia_puja y puja. Se puede llamar cada 1 minuto.",
    { type: "object", properties: { nivel: { type: "string", enum: ["campaign", "adset", "ad"], description: "Nivel (default campaign)." }, campana_id: { type: "string", description: "Opcional: id de campaña para ver sus conjuntos o anuncios." }, ventana: { type: "string", enum: ["rango", "hoy_local", "ultimas_horas"], description: "rango (default, usa desde/hasta en hora Argentina), hoy_local (en lo que va del día desde las 00:00 de la hora local del país de cada campaña) o ultimas_horas (las últimas 'horas' horas hasta ahora)." }, horas: { type: "number", description: "Para ventana=ultimas_horas: 1 a 48 (default 2)." }, desde: { type: "string", description: "AAAA-MM-DD" }, hasta: { type: "string", description: "AAAA-MM-DD" } }, additionalProperties: false }),
  tool("escala_reglas", "Reglas de escala automática de Meta",
    "Las reglas de escala automática que el cliente guardó en Growith (Meta → Reglas de escala) TAL COMO GROWITH LAS INTERPRETÓ: tabla condición → acción → nivel → horario, la config exacta que aplica el motor, si están activas o en simulación y el texto original. Growith las corre solo cada 15 min (:00 :15 :30 :45 en la hora local del país de cada campaña).",
    SIN_ARGS),
  tool("escala_registro", "Vueltas y cambios de la escala automática",
    "Para verificar que la escala automática corre: cada vuelta de 15 min (ok, saltada con motivo, o con errores: una vuelta con errores no toca nada), los cambios aplicados o simulados (hora, cuenta, campaña o conjunto, qué cambió, cuánto, qué regla y con qué números) y el resumen del día (21:30 hora Argentina). 'faltantes' lista los cuartos de hora sin vuelta registrada en la ventana pedida. horas: 1 a 72 (default 6).",
    { type: "object", properties: { horas: { type: "number", description: "Ventana hacia atrás en horas (1 a 72, default 6)." } }, additionalProperties: false }),
  tool("meta_accion", "Pausar, activar o cambiar presupuesto en Meta",
    "Aplica un cambio REAL en Meta Ads: pausar o activar una campaña, conjunto o anuncio, cambiar el presupuesto diario de una campaña (CBO) o conjunto (ABO), o cambiar la puja / cost cap de un conjunto (accion=puja, también entre 1/5 y 5 veces la actual). Solo funciona si la cuenta tiene un token con ads_management (meta_administrador → puede_editar). El presupuesto va en la moneda de la cuenta y por llamada puede ir de 1/5 a 5 veces el actual. Cada cambio queda registrado en Growith con el motivo. Usala solo cuando el usuario te pidió administrar sus campañas, y decí siempre qué cambiaste y por qué.",
    { type: "object", properties: { accion: { type: "string", enum: ["pausar", "activar", "presupuesto", "puja"] }, id: { type: "string", description: "id de la campaña, conjunto o anuncio (de meta_administrador)." }, presupuesto_diario: { type: "number", description: "Solo para accion=presupuesto: nuevo presupuesto diario en la moneda de la cuenta." }, puja: { type: "number", description: "Solo para accion=puja (id de un conjunto): nueva puja o costo objetivo en la moneda de la cuenta." }, estrategia: { type: "string", enum: ["COST_CAP", "LOWEST_COST_WITH_BID_CAP"], description: "Solo para accion=puja si el conjunto todavía no tiene puja: tipo de tope a poner." }, motivo: { type: "string", description: "Por qué se hace el cambio (queda en el registro)." } }, required: ["accion", "id", "motivo"], additionalProperties: false },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }),
  // OJO: tool(name, TÍTULO, descripción, inputSchema). Un argumento de menos
  // deja la descripción como objeto y claude.ai descarta la lista ENTERA
  // ("Este conector no tiene herramientas disponibles"), ver testTools abajo.
  tool("listar_clientes", "Clientes (tiendas) del usuario",
    "Lista los clientes (tiendas) de Growith a los que este usuario tiene acceso, con sus plataformas conectadas (Tienda Nube, Shopify, Mercado Libre o Impultienda para productos digitales) y cuál está activo en este chat. Llamala primero si no sabés sobre qué cliente responder."),
  tool("seleccionar_cliente", "Elegir el cliente activo de este chat",
    "Fija el cliente (tienda) activo para ESTE chat. Todas las demás herramientas (resumen_negocio, rentabilidad, stock, envios, campañas…) pasan a responder sobre ese cliente. Otros chats no se ven afectados.",
    { type: "object", properties: { cliente_id: { type: "string", description: "El cliente_id que devuelve listar_clientes." } }, required: ["cliente_id"], additionalProperties: false }),
  tool("obtener_token_ml", "Token de Mercado Libre de un cliente (solo admins)",
    "SOLO ADMINISTRADORES de Growith. Devuelve el access token vigente de Mercado Libre de un cliente (si venció, lo renueva primero con su refresh token). El token da acceso a la cuenta de ML del cliente: usalo únicamente para lo que el usuario pidió y no lo repitas en la respuesta salvo que lo pida explícitamente.",
    { type: "object", properties: { cliente_id: { type: "string", description: "El cliente_id que devuelve listar_clientes." } }, required: ["cliente_id"], additionalProperties: false }),
];
// Toda herramienta tiene que ser JSON válido para el cliente MCP: título y
// descripción de texto, inputSchema objeto. Se verifica al cargar el módulo.
for (const t of TOOLS) {
  if (typeof t.title !== "string" || typeof t.description !== "string" || !t.inputSchema || t.inputSchema.type !== "object") {
    throw new Error(`Herramienta MCP mal definida: ${t.name}`);
  }
}
// Herramientas que NO necesitan un cliente activo.
const TOOLS_SIN_CLIENTE = new Set(["listar_clientes", "seleccionar_cliente", "obtener_token_ml"]);

async function checkAccess(db, tok, origin) {
  const snap = await db.collection("mcp_tokens").doc(sha(tok)).get();
  if (!snap.exists) return null;
  const t = snap.data();
  if (Date.now() > t.exp) return null;
  if (String(t.resource || "").toLowerCase() !== `${origin}/mcp`.toLowerCase()) return null; // audiencia (RFC 8707)
  // La conexión es del PERFIL (el login de Growith), no de una tienda: con un
  // solo "Permitir" quedan conectadas todas las tiendas a las que ese perfil
  // tiene acceso (como la app de Shopify). AutorizarIAView manda user.uid y el
  // grant guarda ese mismo uid, así que t.uid ES el perfil.
  const [u, g] = await Promise.all([
    db.collection("users").doc(t.uid).get(),
    db.collection("mcp_grants").doc(t.grantId).get(),
  ]);
  if (!u.exists || !g.exists || g.data().revoked) return null;
  if ((u.data() || {}).deleted === true) return null;
  // El perfil es QUIEN TOCÓ "Permitir" (grantedBy = r.user.uid en approve).
  // Los grants viejos pueden tener en `uid` la tienda activa de ese momento;
  // con ese uid la enumeración de tiendas daba vacío ("no tiene ninguna
  // tienda") aunque el usuario tuviera varias.
  const perfil = String(g.data().grantedBy || t.uid);
  return { perfil, grantId: t.grantId, tokenUid: t.uid };
}

// Con qué cuenta está autorizado el conector: va en listar_clientes y en los
// errores, para que "no tiene tiendas" se pueda diagnosticar sin adivinar.
async function cuentaDe(db, perfil) {
  const s = await db.collection("users").doc(perfil).get();
  const d = s.exists ? (s.data() || {}) : {};
  return { uid: perfil, email: d.email || null, nombre: d.nombre || null };
}

// ─── Clientes (tiendas) del perfil y sesiones MCP ─────────────────────────

const PLATAFORMA_LABEL = { tiendanube: "Tienda Nube", shopify: "Shopify", mercadolibre: "Mercado Libre", meli: "Mercado Libre", mercadopago: "Mercado Pago" , impultienda: "Impultienda (productos digitales: usar productos_digitales)" };
function plataformasDe(d) {
  const out = [];
  for (const s of (d.stores || [])) { const l = PLATAFORMA_LABEL[s.type]; if (l && !out.includes(l)) out.push(l); }
  return out;
}
function nombreTienda(d, fallback = "Tienda") { return d.nombreTienda || d.nombre || d.email || fallback; }

// Misma enumeración que el `workspace` de tareas.js: el doc propio del perfil
// (si sigue siendo suyo) + todos los docs donde figura en teamUids.
async function tiendasDePerfil(db, perfil) {
  const [mySnap, qs] = await Promise.all([
    db.collection("users").doc(perfil).get(),
    db.collection("users").where("teamUids", "array-contains", perfil).get(),
  ]);
  const my = mySnap.exists ? (mySnap.data() || {}) : {};
  const out = [];
  const selfMovida = !!(my.ownerUid && my.ownerUid !== perfil);
  if (mySnap.exists && !selfMovida && my.deleted !== true && my.tiendaEliminada !== true) {
    out.push({ cliente_id: perfil, nombre: nombreTienda(my, "Mi tienda"), rol: "owner", plataformas: plataformasDe(my) });
  }
  for (const doc of qs.docs) {
    if (doc.id === perfil) continue;
    const d = doc.data() || {};
    if (d.deleted === true) continue;
    const m = (d.teamMembers || {})[perfil] || {};
    const esOwner = d.ownerUid === perfil || m.rol === "owner";
    out.push({ cliente_id: doc.id, nombre: nombreTienda(d), rol: esOwner ? "owner" : "miembro", plataformas: plataformasDe(d) });
  }
  return out;
}

// Busca un cliente por cliente_id o por nombre (exacto, o único que lo contenga),
// sin distinguir mayúsculas ni acentos: "lumina" alcanza, no hace falta el id.
function resolverCliente(clientes, texto) {
  const t = String(texto || "").trim();
  if (!t) return null;
  const n = (x) => String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  return clientes.find(c => c.cliente_id === t)
    || clientes.find(c => n(c.nombre) === n(t))
    || (() => { const m = clientes.filter(c => n(c.nombre).includes(n(t))); return m.length === 1 ? m[0] : null; })();
}
// Tienda en la que el usuario está parado en Growith (perfil.active_tienda_uid):
// con varias tiendas y sin elección en el chat, se usa esa por defecto.
async function tiendaActivaDe(db, perfil, clientes) {
  try {
    const d = (await db.collection("users").doc(perfil).get()).data() || {};
    const id = String(d.active_tienda_uid || perfil);
    return clientes.find(c => c.cliente_id === id) || null;
  } catch (_) { return null; }
}

async function esAdminPerfil(db, perfil) {
  if (isFounder(perfil)) return true;
  const s = await db.collection("users").doc(perfil).get();
  return s.exists && (s.data() || {}).isAdmin === true;
}

// Sesión = un chat. Claude/ChatGPT mandan el header Mcp-Session-Id que les dimos
// en `initialize`; el cliente activo vive ahí, así dos chats pueden estar parados
// en clientes distintos sin pisarse. Un cliente MCP que no mande el header cae a
// una sesión por conexión (grant), compartida entre sus chats.
function sidDe(req) {
  const h = req.headers["mcp-session-id"] || req.headers["Mcp-Session-Id"];
  const sid = Array.isArray(h) ? h[0] : h;
  return sid && /^[A-Za-z0-9_-]{8,128}$/.test(String(sid)) ? String(sid) : null;
}
async function cargarSesion(db, ctx, sid) {
  const id = sid || `grant_${ctx.grantId}`;
  const s = await db.collection("mcp_sessions").doc(id).get();
  if (!s.exists) return { id, clienteUid: null, nueva: true };
  const d = s.data() || {};
  // Una sesión solo vale para la conexión que la creó: un sid robado de otro
  // grant no da acceso a otro perfil.
  if (d.grantId !== ctx.grantId || d.perfil !== ctx.perfil) return { id, clienteUid: null, nueva: true };
  if (d.exp && Date.now() > d.exp) return { id, clienteUid: null, nueva: true };
  return { id, clienteUid: d.clienteUid || null, nueva: false };
}
async function guardarSesion(db, ctx, id, clienteUid) {
  const now = Date.now();
  await db.collection("mcp_sessions").doc(id).set({
    grantId: ctx.grantId, perfil: ctx.perfil, clienteUid: clienteUid || null,
    exp: now + SESSION_TTL * 1000, expiresAt: new Date(now + SESSION_TTL * 1000), lastUsedAt: new Date(),
  }, { merge: true });
}

async function runTool(db, uid, name, args, origin, grantId) {
  const fecha = new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hourCycle: "h23" });
  const sinMargenes = "SIN DATOS — los márgenes todavía no se calcularon. Pedile al usuario que abra el Dashboard de Growith (sección Márgenes) para que se generen.";

  if (name === "resumen_negocio") {
    await margenesD30Frescas(db, uid, origin);
    const [margenes, cuentas, stock] = await Promise.all([snapshotMargenes(db, uid, 5), snapshotCuentas(db, uid), snapshotStock(db, uid)]);
    const out = { fecha_hora_actual: fecha, moneda: "ARS", estado_configuracion: estadoConfiguracion(margenes, cuentas, stock), tiendas: cuentas?.tiendas || [] };
    if (margenes) {
      const { top_productos, ...resto } = margenes;
      Object.assign(out, resto, { top_5_productos: top_productos, metas_configuradas: cuentas?.metas_margenes || null });
    } else out.margenes = sinMargenes;
    return out;
  }
  if (name === "rentabilidad_productos") {
    const lim = Math.min(50, Math.max(1, parseInt(args?.limite, 10) || 15));
    await margenesD30Frescas(db, uid, origin);
    const m = await snapshotMargenes(db, uid, lim);
    if (!m) return { fecha_hora_actual: fecha, productos: sinMargenes };
    return { fecha_hora_actual: fecha, moneda: "ARS", datos_al: m.datos_al, periodo: m.periodo, productos: m.top_productos };
  }
  if (name === "stock") {
    const s = await snapshotStock(db, uid);
    return { fecha_hora_actual: fecha, stock: s || "SIN DATOS de stock — el usuario tiene que abrir la sección Stock de Growith para que se genere el snapshot." };
  }
  if (name === "envios") {
    const e = await snapshotEnvios(db, uid);
    return { fecha_hora_actual: fecha, envios: e || "SIN DATOS de envíos registrados." };
  }
  if (name === "publicidad_y_cuentas") {
    const c = await snapshotCuentas(db, uid);
    if (!c) return { fecha_hora_actual: fecha, cuentas: "SIN DATOS" };
    const { colaboradores, ...resto } = c; // los mails del equipo no salen de Growith
    return { fecha_hora_actual: fecha, ...resto };
  }
  if (name === "rentabilidad") {
    const { since, until } = rangoDe(args);
    return { fecha_hora_actual: fecha, ...armarRentabilidad(await margenesDe(db, uid, origin || DEFAULT_ORIGIN, since, until)) };
  }
  if (name === "productos_digitales") {
    const hoy = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(args.desde || "") ? args.desde : hoy;
    const hasta = /^\d{4}-\d{2}-\d{2}$/.test(args.hasta || "") ? args.hasta : desde;
    const u = (await db.collection("users").doc(uid).get()).data() || {};
    if (!(u.stores || []).some(s => s.type === "impultienda")) return { error: "Esta tienda no tiene Impultienda conectada." };
    const r = await impPorHora(db, uid, desde, hasta);
    // Resumen compacto: totales, por tienda, por hora y campañas (sin la grilla cruda).
    const porTienda = {}, porHoraT = {};
    for (const f of r.filas) {
      const t = porTienda[f.tienda] || (porTienda[f.tienda] = { tienda: f.tiendaNombre, pais: f.pais, ventas: 0, n: 0, gasto: 0, comisiones: 0, reembolsos: 0 });
      const h = porHoraT[`${f.fecha} ${String(f.hora).padStart(2, "0")}:00`] || (porHoraT[`${f.fecha} ${String(f.hora).padStart(2, "0")}:00`] = { ventas: 0, n: 0, gasto: 0 });
      for (const k of ["ventas", "n", "gasto", "comisiones", "reembolsos"]) t[k] += f[k] || 0;
      h.ventas += f.ventas; h.n += f.n; h.gasto += f.gasto;
    }
    const r2 = (x) => Math.round(x * 100) / 100;
    return {
      fecha_hora_actual: fecha, moneda: "USD", zona: "hora Argentina", desde, hasta,
      metricas: metricasDigitales(r.totales, new Set(r.filas.filter(f => f.n > 0).map(f => f.tienda)).size),
      totales: Object.fromEntries(Object.entries(r.totales).map(([k, v]) => [k, typeof v === "number" ? r2(v) : v])),
      por_tienda: Object.values(porTienda).map(t => ({ ...t, ventas: r2(t.ventas), gasto: r2(t.gasto), comisiones: r2(t.comisiones), reembolsos: r2(t.reembolsos), ganancia: r2(t.ventas - t.gasto - t.comisiones - t.reembolsos), roas: t.gasto ? r2(t.ventas / t.gasto) : null })),
      por_hora: Object.entries(porHoraT).map(([hora, v]) => ({ hora, ventas: r2(v.ventas), n: v.n, gasto: r2(v.gasto) })),
      campanas: (r.campanas || []).slice(0, 40).map(c => ({ campana: c.nombre, tienda: (r.tiendas || []).find(t => t.id === c.tienda)?.nombre || null, gasto: r2(c.gasto), ventas: c.n, facturacion: r2(c.ventas), roas: c.roas ? r2(c.roas) : null, cpa: c.cpa ? r2(c.cpa) : null, ganancia: r2(c.ganancia), meta_dice: c.metaDice ? { compras: c.metaDice.compras, valor: r2(c.metaDice.valor) } : null, anuncios: (c.anuncios || []).slice(0, 15).map(a => ({ anuncio: a.anuncio, ventas: a.n, facturacion: r2(a.ventas) })) })),
      avisos: { gasto_meta_sin_hora: r2(r.meta?.sinHora || 0), errores_meta: r.meta?.errores || [], stripe: r.stripe, mercadopago: r.mp },
    };
  }
  if (name === "meta_administrador") return { fecha_hora_actual: fecha, ...(await metaAdministrador(db, uid, args)) };
  if (name === "escala_reglas") {
    const c = (await db.collection("users").doc(uid).collection("meta_escala").doc("cfg").get()).data();
    if (!c?.reglas) return { fecha_hora_actual: fecha, configuradas: false, aviso: "El cliente no guardó reglas de escala (Meta → Reglas de escala en Growith)." };
    const R = normalizarReglas(c.reglas);
    return { fecha_hora_actual: fecha, configuradas: true, activas: !!c.activo, simulacion: !!c.simular, guardadas: c.actualizado, tabla: tablaReglas(R), config_aplicada: R, texto_original: c.prompt };
  }
  if (name === "escala_registro") {
    const horas = Math.min(72, Math.max(1, parseInt(args.horas) || 6));
    const desde = new Date(Date.now() - horas * 3600000).toISOString();
    const u = db.collection("users").doc(uid);
    const [vs, log, cfg] = await Promise.all([
      u.collection("meta_escala_vueltas").where("ts", ">=", desde).get(),
      u.collection("meta_escala_log").where("ts", ">=", desde).get(),
      u.collection("meta_escala").doc("cfg").get(),
    ]);
    const vueltas = vs.docs.map(d => d.data()).sort((a, b) => b.ts.localeCompare(a.ts));
    const hechas = new Set(vueltas.map(v => v.ts.slice(0, 16)));
    const faltantes = [];
    if (cfg.data()?.activo) for (let t = Math.ceil(Date.parse(desde) / 900000) * 900000; t < Date.now() - 5 * 60000; t += 900000) { const k = new Date(t).toISOString().slice(0, 16); if (!hechas.has(k)) faltantes.push(k + "Z"); }
    const resumen = (await u.collection("meta_escala_resumen").doc(hoyAR()).get()).data() || null;
    return { fecha_hora_actual: fecha, activas: !!cfg.data()?.activo, simulacion: !!cfg.data()?.simular, horas, vueltas: vueltas.slice(0, 300), faltantes, cambios: log.docs.map(d => d.data()).sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 500), resumen_hoy: resumen };
  }
  if (name === "meta_accion") return { fecha_hora_actual: fecha, ...(await metaAccion(db, uid, args, grantId)) };
  if (name === "campanas_publicidad") {
    const { since, until } = rangoDe(args, "ultimos_7_dias");
    const plats = ["meta", "google", "tiktok"].includes(args?.plataforma) ? [args.plataforma] : ["meta", "google", "tiktok"];
    const u = (await db.collection("users").doc(uid).get()).data() || {};
    const out = { fecha_hora_actual: fecha, periodo: { desde: since, hasta: until } };
    await Promise.all(plats.map(async p => {
      try { out[p] = p === "meta" ? await metaCampanas(db, uid, since, until) : p === "google" ? await googleCampanas(db, uid, u, since, until) : await tiktokCampanas(u, since, until); }
      catch (e) { out[p] = { error: e.message }; }
    }));
    return out;
  }
  return null;
}

async function usoDelDia(db, uid) {
  const day = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const ref = db.collection("usage").doc(`${uid}_${day}`);
  const usados = Number((await ref.get()).data()?.mcp_calls) || 0;
  if (usados >= LIMITE_DIARIO) return false;
  ref.set({ uid, date: day, section: "mcp", mcp_calls: FieldValue.increment(1), updatedAt: new Date() }, { merge: true }).catch(() => {});
  return true;
}

async function handleRpc(db, ctx, msg) {
  const isReq = msg && typeof msg === "object" && msg.id !== undefined && msg.id !== null;
  const ok = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: isReq ? msg.id : null, error: { code, message } });
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "Invalid Request");
  if (!isReq) return null; // notificaciones (initialized, cancelled…): nada que responder

  switch (msg.method) {
    case "initialize": {
      const pedida = msg.params?.protocolVersion;
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(pedida) ? pedida : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "growith", title: "Growith", version: "1.0.0", websiteUrl: "https://www.growithapp.com" },
        instructions: INSTRUCCIONES,
      });
    }
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS });
    case "tools/call": {
      const name = msg.params?.name;
      const args = msg.params?.arguments || {};
      if (!TOOLS.some(t => t.name === name)) return fail(-32602, `Herramienta desconocida: ${name}`);
      const errTool = (text) => ok({ isError: true, content: [{ type: "text", text }] });
      const okTool = (data) => ok({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
      db.collection("mcp_grants").doc(ctx.grantId).update({ lastUsedAt: new Date() }).catch(() => {});
      try {
        if (name === "listar_clientes") {
          const [clientes, cuenta] = await Promise.all([tiendasDePerfil(db, ctx.perfil), cuentaDe(db, ctx.perfil)]);
          const enGrowith = await tiendaActivaDe(db, ctx.perfil, clientes);
          return okTool({ cuenta_conectada: cuenta, cliente_activo: ctx.sesion.clienteUid, tienda_abierta_en_growith: enGrowith?.cliente_id || null, clientes: clientes.map(c => ({ ...c, activo: c.cliente_id === ctx.sesion.clienteUid, abierta_en_growith: c.cliente_id === enGrowith?.cliente_id })) });
        }
        if (name === "seleccionar_cliente") {
          const id = String(args.cliente_id || "").trim();
          const clientes = await tiendasDePerfil(db, ctx.perfil);
          const c = resolverCliente(clientes, id);
          if (!c) return errTool(`No existe un cliente "${id}" entre los de este usuario. Disponibles: ${clientes.map(x => `${x.nombre} (${x.cliente_id})`).join(", ")}.`);
          await guardarSesion(db, ctx, ctx.sesion.id, c.cliente_id);
          ctx.sesion.clienteUid = c.cliente_id;
          return okTool({ ok: true, cliente_activo: c, mensaje: `Listo: este chat ahora responde sobre ${c.nombre}.` });
        }
        if (name === "obtener_token_ml") {
          if (!(await esAdminPerfil(db, ctx.perfil))) return errTool("Esta herramienta es solo para administradores de Growith.");
          const id = String(args.cliente_id || "").trim();
          const clientes = await tiendasDePerfil(db, ctx.perfil);
          const c = resolverCliente(clientes, id);
          if (!c) return errTool(`No existe un cliente "${id}" entre los de este usuario.`);
          const tk = await getValidMLToken(db, c.cliente_id); // renueva solo si venció
          if (!tk?.accessToken) return errTool(`${c.nombre} no tiene una cuenta de Mercado Libre conectada en Growith.`);
          // Queda registrado: un token de ML da acceso a la cuenta del cliente.
          db.collection("admin_log").add({ adminUid: ctx.perfil, action: "mcp_token_ml", targetUid: id, targetEmail: null, detalle: `Token de ML de ${c.nombre} entregado por MCP (grant ${ctx.grantId})`, data: null, at: FieldValue.serverTimestamp() }).catch(() => {});
          return okTool({ cliente: { cliente_id: id, nombre: c.nombre }, ml_user_id: tk.userId || null, access_token: tk.accessToken, aviso: "Token con acceso a la cuenta de Mercado Libre del cliente. No lo pegues en respuestas ni lo compartas." });
        }

        // Las demás herramientas necesitan un cliente activo en este chat
        // (o un cliente_id explícito en la llamada, que manda sobre la sesión).
        let clienteUid = ctx.sesion.clienteUid;
        let clienteNombre = null;
        const pedido = String(args.cliente_id || "").trim();
        if (pedido) {
          const clientes = await tiendasDePerfil(db, ctx.perfil);
          const c = resolverCliente(clientes, pedido);
          if (!c) return errTool(`No existe un cliente "${pedido}" para este usuario. Disponibles: ${clientes.map(x => `${x.nombre} (${x.cliente_id})`).join(", ")}.`);
          clienteUid = c.cliente_id; clienteNombre = c.nombre;
        }
        if (!clienteUid) {
          const clientes = await tiendasDePerfil(db, ctx.perfil);
          if (clientes.length === 1) {
            clienteUid = clientes[0].cliente_id;
            await guardarSesion(db, ctx, ctx.sesion.id, clienteUid);
            ctx.sesion.clienteUid = clienteUid;
          } else if (clientes.length === 0) {
            const c = await cuentaDe(db, ctx.perfil);
            return errTool(`La cuenta de Growith conectada (${c.email || c.uid}) no tiene ninguna tienda. Si el usuario esperaba ver sus tiendas, el conector quedó autorizado con otra cuenta: hay que desconectarlo en la app de IA y volver a conectarlo con el login correcto de Growith.`);
          } else {
            // Varias tiendas y ninguna elegida en este chat: la tienda en la que
            // el usuario está parado en Growith, para responder sin preguntar.
            const act = await tiendaActivaDe(db, ctx.perfil, clientes);
            if (!act) return errTool(`Falta elegir sobre qué cliente responder. Preguntale al usuario y llamá a seleccionar_cliente con el nombre o el cliente_id. Disponibles: ${clientes.map(c => `${c.nombre} (${c.cliente_id})`).join(", ")}.`);
            clienteUid = act.cliente_id; clienteNombre = act.nombre;
            await guardarSesion(db, ctx, ctx.sesion.id, clienteUid);
            ctx.sesion.clienteUid = clienteUid;
          }
        }
        if (!(await usoDelDia(db, clienteUid))) {
          return errTool(`Se alcanzó el límite de ${LIMITE_DIARIO} consultas por día a Growith para este cliente. Mañana se renueva solo.`);
        }
        if (!clienteNombre) {
          const cd = await db.collection("users").doc(clienteUid).get();
          clienteNombre = cd.exists ? nombreTienda(cd.data() || {}) : null;
        }
        const data = await runTool(db, clienteUid, name, args, ctx.origin, ctx.grantId);
        // Siempre se dice de QUÉ cliente son los datos, para que la IA no mezcle.
        return okTool({ cliente: { cliente_id: clienteUid, nombre: clienteNombre }, ...(data && typeof data === "object" && !Array.isArray(data) ? data : { resultado: data }) });
      } catch (e) {
        console.error("[mcp] tool", name, e.message);
        return errTool(`Growith no pudo leer esos datos: ${e.message}`);
      }
    }
    case "resources/list": return ok({ resources: [] });
    case "prompts/list": return ok({ prompts: [] });
    default: return fail(-32601, `Método no soportado: ${msg.method}`);
  }
}

async function mcp(req, res, db, origin) {
  if (req.method === "GET" || req.method === "DELETE") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Este servidor MCP solo acepta POST (sin stream SSE)." });
  }
  if (req.method !== "POST") return res.status(405).end();

  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""));
  const ctx = m ? await checkAccess(db, m[1].trim(), origin) : null;
  if (!ctx) {
    const prm = `${origin}/.well-known/oauth-protected-resource/mcp`;
    res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${prm}", scope="${SCOPE}"${m ? ', error="invalid_token"' : ""}`);
    return res.status(401).json({ error: m ? "invalid_token" : "unauthorized", error_description: "Conectá Growith para usar estas herramientas." });
  }

  ctx.origin = origin;
  const body = bodyOf(req);
  const msgs = Array.isArray(body) ? body : [body];
  // Sesión (un chat): en `initialize` se crea una nueva y se le devuelve el id en
  // Mcp-Session-Id; el cliente lo manda en cada request siguiente.
  const inicializa = msgs.some(m => m && m.method === "initialize");
  if (inicializa) {
    const sid = rnd(24);
    await guardarSesion(db, ctx, sid, null);
    res.setHeader("Mcp-Session-Id", sid);
    ctx.sesion = { id: sid, clienteUid: null, nueva: true };
  } else {
    ctx.sesion = await cargarSesion(db, ctx, sidDe(req));
  }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(x => handleRpc(db, ctx, x)))).filter(Boolean);
    return out.length ? res.status(200).json(out) : res.status(202).end();
  }
  const out = await handleRpc(db, ctx, body);
  return out ? res.status(200).json(out) : res.status(202).end();
}

// Para tests locales (no se usa en producción).
export const __test = { handleRpc, tiendasDePerfil, cargarSesion, guardarSesion, checkAccess, TOOLS, TOOLS_SIN_CLIENTE };

// ─── Handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const origin = originOf(req);
  const route = String(req.query.route || "");
  const action = String(req.query.action || "");

  // Metadata, OAuth y MCP se llaman desde servidores o herramientas de terceros
  // (sin cookies, el token va en el header): CORS abierto. Las acciones de la app son same-origin.
  if (route) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version");
    res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id");
    if (req.method === "OPTIONS") return res.status(204).end();
  }

  try {
    if (route === "prm") {
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.json({
        resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: [SCOPE],
        bearer_methods_supported: ["header"], resource_name: "Growith",
      });
    }
    if (route === "asm") {
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.json({
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        revocation_endpoint: `${origin}/oauth/revoke`,
        scopes_supported: [SCOPE],
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
        revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
        code_challenge_methods_supported: ["S256"],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
        service_documentation: "https://www.growithapp.com",
      });
    }

    const db = initAdmin();
    if (route === "mcp") return await mcp(req, res, db, origin);
    if (route === "authorize") {
      if (req.method !== "GET") return res.status(405).end();
      return await authorize(req, res, db, origin);
    }
    if (route === "token") {
      if (req.method !== "POST") return res.status(405).end();
      return await token(req, res, db, origin);
    }
    if (route === "register") {
      if (req.method !== "POST") return res.status(405).end();
      return await register(req, res, db);
    }
    if (route === "revoke") {
      if (req.method !== "POST") return res.status(405).end();
      return await revoke(req, res, db);
    }
    if (action) return await appAction(req, res, db, origin, action);
    return res.status(404).json({ error: "Ruta desconocida." });
  } catch (e) {
    console.error("[mcp]", route || action, e.message);
    if (route === "mcp") return res.status(500).json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Error interno de Growith." } });
    if (route === "token" || route === "register") return oauthErr(res, 500, "server_error");
    return res.status(500).json({ error: "Error interno. Probá de nuevo." });
  }
}
