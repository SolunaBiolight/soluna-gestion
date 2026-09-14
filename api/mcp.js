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
import { requireUid, verifyAuth } from "./_auth.js";
import { snapshotMargenes, snapshotEnvios, snapshotStock, snapshotCuentas, estadoConfiguracion } from "./_snapshot.js";
import { gadsCuentas, gadsReporteCampanas } from "./google-ads.js";
import { ttReporteCampanas } from "./tiktok-ads.js";

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
const LIMITE_DIARIO = 300;        // llamadas a herramientas por tienda y por día

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
- El acceso es de solo lectura: para pausar campañas, ajustar stock o cualquier cambio, el usuario lo hace desde Growith.`;

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
    if (until < hoy || edadMin <= 20) return { ...b, cachedAt: d.cachedAt || null };
  }
  if (!process.env.CRON_SECRET) throw new Error("el servidor no puede calcular ese período ahora (falta CRON_SECRET).");
  const u = new URL(`${origin}/api/orders`);
  u.searchParams.set("action", "daily_metrics"); u.searchParams.set("uid", uid); u.searchParams.set("warm", "1");
  u.searchParams.set("date_from", since); u.searchParams.set("date_to", until);
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
const tool = (name, title, description, inputSchema = SIN_ARGS) => ({
  name, title, description, inputSchema,
  annotations: { title, ...ANN },
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
  tool("campanas_publicidad", "Campañas de Meta, Google y TikTok",
    "Campañas de Meta Ads, Google Ads y TikTok Ads conectadas a Growith con métricas del período: estado, presupuesto, gasto, impresiones, clicks, CTR, CPC, conversiones o compras, valor y ROAS según cada plataforma. Cada cuenta indica su moneda. Por defecto, últimos 7 días de todas las plataformas.",
    { type: "object", properties: { plataforma: { type: "string", enum: ["todas", "meta", "google", "tiktok"], description: "Plataforma a consultar (por defecto todas)." }, ...PROPS_PERIODO }, additionalProperties: false }),
];

async function checkAccess(db, tok, origin) {
  const snap = await db.collection("mcp_tokens").doc(sha(tok)).get();
  if (!snap.exists) return null;
  const t = snap.data();
  if (Date.now() > t.exp) return null;
  if (String(t.resource || "").toLowerCase() !== `${origin}/mcp`.toLowerCase()) return null; // audiencia (RFC 8707)
  // La tienda sigue existiendo y quien la conectó sigue siendo dueño.
  const [u, g] = await Promise.all([
    db.collection("users").doc(t.uid).get(),
    db.collection("mcp_grants").doc(t.grantId).get(),
  ]);
  if (!u.exists || !g.exists || g.data().revoked) return null;
  const d = u.data() || {}, by = g.data().grantedBy;
  if (d.deleted === true) return null;
  const owner = d.ownerUid ? String(d.ownerUid) : t.uid;
  const legacyTeam = Array.isArray(d.teamUids) && d.teamUids.includes(by) && !(d.teamMembers || {})[by];
  if (by !== owner && !legacyTeam) return null;
  return { uid: t.uid, grantId: t.grantId };
}

async function runTool(db, uid, name, args, origin) {
  const fecha = new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
  const sinMargenes = "SIN DATOS — los márgenes todavía no se calcularon. Pedile al usuario que abra el Dashboard de Growith (sección Márgenes) para que se generen.";

  if (name === "resumen_negocio") {
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
      if (!TOOLS.some(t => t.name === name)) return fail(-32602, `Herramienta desconocida: ${name}`);
      if (!(await usoDelDia(db, ctx.uid))) {
        return ok({ isError: true, content: [{ type: "text", text: `Se alcanzó el límite de ${LIMITE_DIARIO} consultas por día a Growith. Mañana se renueva solo.` }] });
      }
      db.collection("mcp_grants").doc(ctx.grantId).update({ lastUsedAt: new Date() }).catch(() => {});
      try {
        const data = await runTool(db, ctx.uid, name, msg.params?.arguments || {}, ctx.origin);
        return ok({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
      } catch (e) {
        console.error("[mcp] tool", name, e.message);
        return ok({ isError: true, content: [{ type: "text", text: `Growith no pudo leer esos datos: ${e.message}` }] });
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
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(x => handleRpc(db, ctx, x)))).filter(Boolean);
    return out.length ? res.status(200).json(out) : res.status(202).end();
  }
  const out = await handleRpc(db, ctx, body);
  return out ? res.status(200).json(out) : res.status(202).end();
}

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
