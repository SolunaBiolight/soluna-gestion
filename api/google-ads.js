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
  const dt = (process.env.GOOGLE_ADS_SEND_DEV_TOKEN === "1" ? (process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "") : ""); // Google: el developer token es opcional desde 09/2026 y se rechaza desde 2027
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

// ── Publicar en Google (Búsqueda / Performance Max) ──────────────────────────
// País → geoTargetConstant (2000 + código ISO numérico) e idioma → languageConstant.
const GADS_GEOS = { AR: 2032, UY: 2858, CL: 2152, PY: 2600, BO: 2068, PE: 2604, CO: 2170, EC: 2218, MX: 2484, ES: 2724, US: 2840 };
const GADS_LANGS = { es: 1003, en: 1000, pt: 1014 };
const GADS_GEMINI_MODEL = "gemini-2.5-flash";
const gLen = (s) => [...String(s || "")].length;
// Lista de textos: sin vacíos ni repetidos (Google rechaza textos duplicados en el mismo anuncio).
const gTxts = (arr) => { const seen = new Set(); return (Array.isArray(arr) ? arr : []).map(s => String(s || "").replace(/\s+/g, " ").trim()).filter(t => { const k = t.toLowerCase(); if (!t || seen.has(k)) return false; seen.add(k); return true; }); };
const gKwText = (s) => String(s || "").replace(/[^\p{L}\p{N}\s&'.\-+/]/gu, " ").replace(/\s+/g, " ").trim().toLowerCase();
const parseBody = (req) => (typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}));

// Errores de un mutate → castellano, diciendo qué elemento falló (labels[i] = qué es la operación i).
const GADS_ERR_ES = {
  DUPLICATE_CAMPAIGN_NAME: "ya hay una campaña con ese nombre en la cuenta — cambiale el nombre",
  POLICY_FINDING: "Google lo rechazó por sus políticas de anuncios",
  ASPECT_RATIO_NOT_ALLOWED: "la imagen no tiene la proporción que pide Google",
  TOO_LONG: "pasa el largo máximo que acepta Google",
};
function gadsMutateError(status, txt, labels) {
  const base = gadsHttpError(status, txt);
  if (!/^Google Ads API HTTP/.test(base.message)) return base; // error de acceso ya traducido
  let errs = [];
  try { errs = (JSON.parse(txt).error?.details || []).flatMap(d => d.errors || []); } catch { }
  if (!errs.length) return base;
  const partes = errs.slice(0, 4).map(e => {
    const code = String(Object.values(e.errorCode || {})[0] || "");
    const idx = (e.location?.fieldPathElements || []).find(f => f.fieldName === "mutate_operations" || f.fieldName === "operations")?.index;
    const donde = idx != null && labels?.[idx] ? `${labels[idx]}: ` : "";
    const trig = e.trigger?.stringValue ? ` («${e.trigger.stringValue}»)` : "";
    const temas = (e.details?.policyFindingDetails?.policyTopicEntries || []).map(p => p.topic).filter(Boolean);
    return `${donde}${GADS_ERR_ES[code] || e.message || code}${trig}${temas.length ? ` [${temas.join(", ")}]` : ""}`;
  });
  const err = new Error(partes.join(" · "));
  err.status = status; err.google = errs[0]?.message || ""; err.code = JSON.stringify(errs[0]?.errorCode || "");
  return err;
}

// googleAds:mutate atómico (si una operación falla, no se crea nada).
async function gadsMutate(at, cn, login, ops, labels) {
  const r = await fetch(`${GADS_API}/customers/${cn}/googleAds:mutate`, {
    method: "POST", headers: { ...gadsHeaders(at, login), "Content-Type": "application/json" },
    body: JSON.stringify({ mutateOperations: ops }),
  });
  const txt = await r.text().catch(() => "");
  if (!r.ok) throw gadsMutateError(r.status, txt, labels);
  try { return JSON.parse(txt).mutateOperationResponses || []; } catch { return []; }
}

// Valida lo que manda el publicador (mismos límites que muestra la UI). → { errs, spec }
function gadsValidarPublicacion(b) {
  const errs = [];
  const tipo = b.tipo === "pmax" ? "pmax" : b.tipo === "search" ? "search" : null;
  if (!tipo) errs.push("Elegí el tipo de campaña");
  const nombre = String(b.nombre || "").replace(/\s+/g, " ").trim();
  if (!nombre) errs.push("Poné un nombre a la campaña"); else if (gLen(nombre) > 250) errs.push("El nombre de la campaña es muy largo");
  const url = String(b.url || "").trim();
  let urlOk = false; try { const u = new URL(url); urlOk = /^https?:$/.test(u.protocol) && u.hostname.includes("."); } catch { }
  if (!urlOk) errs.push("La URL de destino no es válida (tiene que empezar con https://)");
  const presupuesto = Number(b.presupuesto);
  if (!(presupuesto > 0)) errs.push("Poné un presupuesto diario mayor a 0");
  const rango = (lista, min, max, largo, nom) => {
    if (lista.length < min) errs.push(`${nom}: cargá al menos ${min}`);
    if (lista.length > max) errs.push(`${nom}: máximo ${max}`);
    lista.forEach(t => { if (gLen(t) > largo) errs.push(`${nom}: «${t}» pasa los ${largo} caracteres`); });
  };
  const hs = gTxts(b.headlines), ds = gTxts(b.descriptions);
  rango(hs, 3, 15, 30, "Títulos");
  const spec = {
    tipo, nombre, url, hs, ds,
    micros: String(Math.round(presupuesto * 100) * 10000), // múltiplo de la unidad mínima (0,01)
    geo: GADS_GEOS[b.pais] || GADS_GEOS.AR, lang: GADS_LANGS[b.idioma] || GADS_LANGS.es,
    status: b.activar === true ? "ENABLED" : "PAUSED",
  };
  if (tipo === "search") {
    rango(ds, 2, 4, 90, "Descripciones");
    const kws = []; const seen = new Set();
    for (const k of (Array.isArray(b.keywords) ? b.keywords : [])) {
      const text = gKwText(k?.text);
      const match = ["BROAD", "PHRASE", "EXACT"].includes(k?.match) ? k.match : "BROAD";
      if (!text || seen.has(text + match)) continue;
      seen.add(text + match);
      if (gLen(text) > 80 || text.split(" ").length > 10) { errs.push(`Palabra clave «${text}»: máximo 80 caracteres y 10 palabras`); continue; }
      kws.push({ text, match });
    }
    if (!kws.length) errs.push("Cargá al menos una palabra clave");
    if (kws.length > 300) errs.push("Máximo 300 palabras clave");
    const path1 = String(b.path1 || "").replace(/\s+/g, ""), path2 = String(b.path2 || "").replace(/\s+/g, "");
    if (gLen(path1) > 15 || gLen(path2) > 15) errs.push("Las rutas visibles tienen máximo 15 caracteres");
    if (path2 && !path1) errs.push("Para usar la ruta 2 completá la ruta 1");
    Object.assign(spec, { kws, path1, path2, puja: b.puja === "clics" ? "clics" : "conv" });
  } else if (tipo === "pmax") {
    rango(ds, 2, 5, 90, "Descripciones");
    if (ds.length && !ds.some(t => gLen(t) <= 60)) errs.push("Descripciones: al menos una tiene que tener 60 caracteres o menos");
    const lhs = gTxts(b.longHeadlines);
    rango(lhs, 1, 5, 90, "Títulos largos");
    const negocio = String(b.negocio || "").replace(/\s+/g, " ").trim();
    if (!negocio) errs.push("Poné el nombre del negocio"); else if (gLen(negocio) > 25) errs.push("El nombre del negocio tiene máximo 25 caracteres");
    const im = b.images || {};
    Object.assign(spec, { lhs, negocio, puja: b.puja === "conv" ? "conv" : "valor", land: im.land, sq: im.sq, logo: im.logo });
  }
  return { errs, spec };
}

// Operaciones del mutate principal, en orden de dependencia, con IDs temporales
// negativos. pre = {hs, ds}: títulos/descripciones de PMax ya creados (Google exige
// que existan antes de la campaña). labels[i] describe la operación i para los errores.
function gadsOperaciones(cn, spec, pre, stamp) {
  let tmp = -1;
  const rn = (col) => `customers/${cn}/${col}/${tmp--}`;
  const ops = [], labels = [];
  const push = (op, label) => { ops.push(op); labels.push(label); };
  const budget = rn("campaignBudgets"), camp = rn("campaigns");
  push({ campaignBudgetOperation: { create: { resourceName: budget, name: `${spec.nombre} · ${stamp}`, amountMicros: spec.micros, deliveryMethod: "STANDARD", explicitlyShared: false } } }, "Presupuesto");
  const c = { resourceName: camp, name: spec.nombre, status: spec.status, campaignBudget: budget, containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING" };
  if (spec.tipo === "search") {
    Object.assign(c, {
      advertisingChannelType: "SEARCH",
      networkSettings: { targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: false, targetPartnerSearchNetwork: false },
      ...(spec.puja === "clics" ? { targetSpend: {} } : { maximizeConversions: {} }),
    });
  } else {
    // Sin "brand guidelines": nombre del negocio y logo van dentro del grupo de recursos.
    Object.assign(c, { advertisingChannelType: "PERFORMANCE_MAX", brandGuidelinesEnabled: false, ...(spec.puja === "conv" ? { maximizeConversions: {} } : { maximizeConversionValue: {} }) });
  }
  push({ campaignOperation: { create: c } }, "Campaña");
  push({ campaignCriterionOperation: { create: { campaign: camp, location: { geoTargetConstant: `geoTargetConstants/${spec.geo}` } } } }, "Ubicación");
  push({ campaignCriterionOperation: { create: { campaign: camp, language: { languageConstant: `languageConstants/${spec.lang}` } } } }, "Idioma");
  if (spec.tipo === "search") {
    const ag = rn("adGroups");
    push({ adGroupOperation: { create: { resourceName: ag, name: `${spec.nombre} · Grupo 1`, campaign: camp, status: "ENABLED", type: "SEARCH_STANDARD" } } }, "Grupo de anuncios");
    spec.kws.forEach(k => push({ adGroupCriterionOperation: { create: { adGroup: ag, status: "ENABLED", keyword: { text: k.text, matchType: k.match } } } }, `Palabra clave «${k.text}»`));
    const rsa = { headlines: spec.hs.map(text => ({ text })), descriptions: spec.ds.map(text => ({ text })), ...(spec.path1 ? { path1: spec.path1 } : {}), ...(spec.path2 ? { path2: spec.path2 } : {}) };
    push({ adGroupAdOperation: { create: { adGroup: ag, status: "ENABLED", ad: { finalUrls: [spec.url], responsiveSearchAd: rsa } } } }, "Anuncio");
  } else {
    const ag = rn("assetGroups");
    push({ assetGroupOperation: { create: { resourceName: ag, name: `${spec.nombre} · Grupo 1`, campaign: camp, finalUrls: [spec.url], status: "ENABLED" } } }, "Grupo de recursos");
    const link = (asset, fieldType, label) => push({ assetGroupAssetOperation: { create: { assetGroup: ag, asset, fieldType } } }, label);
    const texto = (text, fieldType, label) => { const a = rn("assets"); push({ assetOperation: { create: { resourceName: a, textAsset: { text } } } }, label); link(a, fieldType, label); };
    spec.lhs.forEach((t, i) => texto(t, "LONG_HEADLINE", `Título largo ${i + 1}`));
    texto(spec.negocio, "BUSINESS_NAME", "Nombre del negocio");
    pre.hs.forEach((a, i) => link(a, "HEADLINE", `Título ${i + 1}`));
    pre.ds.forEach((a, i) => link(a, "DESCRIPTION", `Descripción ${i + 1}`));
    spec.land.forEach((a, i) => link(a, "MARKETING_IMAGE", `Imagen horizontal ${i + 1}`));
    spec.sq.forEach((a, i) => link(a, "SQUARE_MARKETING_IMAGE", `Imagen cuadrada ${i + 1}`));
    spec.logo.forEach((a, i) => link(a, "LOGO", `Logo ${i + 1}`));
  }
  return { ops, labels };
}

// Lee la página de destino (título, descripción, precio, texto visible) para darle
// contexto a la IA. Solo http(s) público: sin IPs literales ni hosts internos, y
// cada redirección se vuelve a chequear.
async function gadsLeerPagina(url) {
  const hostOk = (u) => { const h = u.hostname.toLowerCase(); return /^https?:$/.test(u.protocol) && h.includes(".") && !/^[\d.]+$/.test(h) && !h.includes(":") && !/(^|\.)(localhost|local|internal)$/.test(h); };
  let u; try { u = new URL(url); } catch { return ""; }
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 6000);
  try {
    let r = null;
    for (let i = 0; i < 4; i++) {
      if (!hostOk(u)) return "";
      r = await fetch(u.toString(), { signal: ctrl.signal, redirect: "manual", headers: { "User-Agent": "Mozilla/5.0 (compatible; GrowithBot/1.0; +https://www.growithapp.com)", Accept: "text/html" } });
      if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { u = new URL(r.headers.get("location"), u); continue; }
      break;
    }
    if (!r || !r.ok || !/text\/html/i.test(r.headers.get("content-type") || "")) return "";
    const html = (await r.text()).slice(0, 600000);
    const m = (re) => (html.match(re)?.[1] || "").trim();
    const title = m(/<title[^>]*>([^<]{1,300})<\/title>/i);
    const desc = m(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,600})["']/i) || m(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{1,600})["']/i);
    const ogt = m(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{1,300})["']/i);
    const precio = m(/"price"\s*:\s*"?([\d.,]{1,20})/i);
    const texto = html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim().slice(0, 3500);
    return [title && `Título: ${title}`, ogt && ogt !== title && `Título OG: ${ogt}`, desc && `Descripción: ${desc}`, precio && `Precio: ${precio}`, texto && `Texto de la página: ${texto}`].filter(Boolean).join("\n");
  } catch { return ""; } finally { clearTimeout(to); }
}

// Textos para Búsqueda / PMax con Gemini. Descarta (no recorta) lo que pasa los
// límites de Google; si quedan menos de los mínimos, reintenta una vez.
async function gadsGeminiCopy(apiKey, { tipo, url, notas, marca, pagina, idioma }) {
  const lengua = idioma === "en" ? "inglés" : idioma === "pt" ? "portugués" : "español rioplatense (Argentina, con voseo) salvo que la marca indique otra variante";
  const pide = tipo === "pmax"
    ? `{"headlines": [15 títulos, máx. 30 caracteres cada uno], "longHeadlines": [5 títulos largos, máx. 90], "descriptions": [5 descripciones, máx. 90; al menos 2 de 60 o menos], "businessName": "nombre del negocio, máx. 25"}`
    : `{"headlines": [15 títulos, máx. 30 caracteres cada uno], "descriptions": [4 descripciones, máx. 90], "keywords": [15 a 25 objetos {"text": "...", "match": "BROAD" | "PHRASE" | "EXACT"}], "path1": "ruta visible, máx. 15, sin espacios", "path2": "ruta visible, máx. 15, sin espacios"}`;
  const system = `Sos especialista en Google Ads para e-commerce. Escribís en ${lengua}. Cumplís las políticas de anuncios de Google: sin signos de exclamación en los títulos, sin emojis, sin MAYÚSCULAS sostenidas, sin símbolos repetidos, sin superlativos que no se puedan comprobar ("el mejor", "número 1") y sin inventar nada que no esté en los datos (descuentos, envío gratis, cuotas, precios, garantías). Cada título tiene que funcionar solo y combinado con cualquier otro; variá los ángulos: producto, beneficio, problema que resuelve, prueba social, oferta (solo si figura en los datos), llamado a la acción y marca. Los límites de caracteres son ESTRICTOS (contá espacios incluidos). ${tipo === "search" ? "Palabras clave: búsquedas reales de gente con intención de compra; PHRASE o EXACT para las más específicas, BROAD para las genéricas; nunca marcas de terceros." : ""} Respondé SOLO con JSON válido.`;
  const user = [
    marca && `## Contexto de la marca\n${marca}`,
    notas && `## Qué se vende / ángulo pedido\n${notas}`,
    url && `## URL de destino\n${url}`,
    pagina && `## Lo que dice la página de destino\n${pagina}`,
    `Generá los textos de una campaña de ${tipo === "pmax" ? "Performance Max" : "Búsqueda (anuncio de búsqueda responsivo)"} con este formato exacto:\n${pide}`,
  ].filter(Boolean).join("\n\n");
  const sinEmoji = (t) => t.replace(/\p{Extended_Pictographic}/gu, "").replace(/\s+/g, " ").trim();
  const dentro = (arr, max, largo) => gTxts((Array.isArray(arr) ? arr : []).map(t => sinEmoji(String(t || "")))).filter(t => gLen(t) <= largo).slice(0, max);
  let last = null;
  for (let intento = 0; intento < 2; intento++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GADS_GEMINI_MODEL}:generateContent?key=${apiKey}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { response_mime_type: "application/json", temperature: intento ? 0.6 : 0.85, max_output_tokens: 6000, thinking_config: { thinking_budget: 0 } },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { last = new Error(`Gemini: ${j.error?.message || "HTTP " + r.status}`); continue; }
    let txt = j.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    const s = txt.indexOf("{"), e = txt.lastIndexOf("}");
    if (s < 0 || e <= s) { last = new Error("La IA no devolvió textos — probá de nuevo."); continue; }
    let o; try { o = JSON.parse(txt.slice(s, e + 1)); } catch { last = new Error("La IA devolvió un formato inválido — probá de nuevo."); continue; }
    const out = {
      headlines: dentro((o.headlines || []).map(t => String(t || "").replace(/[!¡]/g, "")), 15, 30),
      descriptions: dentro(o.descriptions, tipo === "pmax" ? 5 : 4, 90),
    };
    if (tipo === "pmax") {
      out.longHeadlines = dentro(o.longHeadlines, 5, 90);
      out.businessName = gLen(sinEmoji(String(o.businessName || ""))) <= 25 ? sinEmoji(String(o.businessName || "")) : "";
    } else {
      const seen = new Set();
      out.keywords = (Array.isArray(o.keywords) ? o.keywords : []).map(k => ({ text: gKwText(typeof k === "string" ? k : k?.text), match: ["BROAD", "PHRASE", "EXACT"].includes(k?.match) ? k.match : "BROAD" }))
        .filter(k => k.text && gLen(k.text) <= 80 && k.text.split(" ").length <= 10 && !seen.has(k.text + k.match) && seen.add(k.text + k.match)).slice(0, 40);
      const ruta = (p) => { const t = String(p || "").replace(/\s+/g, "-").replace(/[^\p{L}\p{N}\-]/gu, "").toLowerCase(); return gLen(t) <= 15 ? t : ""; };
      out.path1 = ruta(o.path1); out.path2 = out.path1 ? ruta(o.path2) : "";
    }
    if (out.headlines.length >= 3 && out.descriptions.length >= 2) return out;
    last = new Error("La IA devolvió textos que no entran en los límites de Google — probá de nuevo.");
  }
  throw last || new Error("No se pudieron generar los textos.");
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
      // (v25 ya no tiene campaign.start_date / end_date — no pedir campos de fecha acá)
      // Si esta consulta falla, la tabla igual se arma con las métricas del rango.
      let base = [];
      try {
        base = await gaql(at, customer, login, "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.name");
      } catch (e) { console.error("gads campaigns base:", e.message); }
      // 2) Métricas del rango
      const met = await gaql(at, customer, login, `SELECT campaign.id, campaign.name, campaign.status, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value, metrics.all_conversions, metrics.ctr, metrics.average_cpc, metrics.average_cpm FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}' AND campaign.status != 'REMOVED'`);
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

    // ── Publicar en Google ──
    // 1) upload_image: una imagen por request (JPEG/PNG ya recortado por el navegador a
    //    la medida de Google) → asset IMAGE; devuelve el resourceName para el publish.
    if (action === "upload_image" && req.method === "POST") {
      const b = parseBody(req);
      const customer = String(b.customer || "").replace(/\D/g, "");
      const login = b.login ? String(b.login).replace(/\D/g, "") : null;
      const data = String(b.data || "").replace(/^data:image\/[a-z+.-]+;base64,/i, "");
      if (!customer || !data) return res.status(400).json({ error: "Faltan customer / data" });
      if (data.length > 6_900_000) return res.status(413).json({ error: "La imagen pesa más de 5 MB" });
      const snap = await db.collection("users").doc(uid).get();
      const g = snap.data()?.googleAds || null;
      if (!g?.refresh_token) return res.status(400).json({ error: "no_conectado", detail: "Google Ads no está conectado en esta tienda." });
      const at = await gadsAccessToken(g);
      // Nombre único: si la misma imagen ya existe en la cuenta, Google devuelve la existente.
      const name = `${String(b.name || "Imagen").replace(/\s+/g, " ").trim().slice(0, 80)} · Growith ${Date.now().toString(36)}`;
      const r = await fetch(`${GADS_API}/customers/${customer}/assets:mutate`, {
        method: "POST", headers: { ...gadsHeaders(at, login), "Content-Type": "application/json" },
        body: JSON.stringify({ operations: [{ create: { name, type: "IMAGE", imageAsset: { data } } }] }),
      });
      const txt = await r.text().catch(() => "");
      if (!r.ok) throw gadsMutateError(r.status, txt, [String(b.name || "Imagen")]);
      let resourceName = null; try { resourceName = JSON.parse(txt).results?.[0]?.resourceName || null; } catch { }
      if (!resourceName) throw new Error("Google no devolvió la imagen subida — probá de nuevo.");
      return res.json({ ok: true, resourceName });
    }

    // 2) publish: crea la campaña completa (Búsqueda o Performance Max) en un solo
    //    mutate atómico. Por default queda PAUSADA (activar:true la crea activa).
    if (action === "publish" && req.method === "POST") {
      const b = parseBody(req);
      const customer = String(b.customer || "").replace(/\D/g, "");
      const login = b.login ? String(b.login).replace(/\D/g, "") : null;
      if (!customer) return res.status(400).json({ error: "Falta la cuenta de Google Ads" });
      const { errs, spec } = gadsValidarPublicacion(b);
      if (spec.tipo === "pmax") {
        const rnRe = new RegExp(`^customers/${customer}/assets/\\d+$`);
        const ok = (arr, max) => (Array.isArray(arr) ? arr : []).map(String).filter(x => rnRe.test(x)).slice(0, max);
        spec.land = ok(spec.land, 20); spec.sq = ok(spec.sq, 20); spec.logo = ok(spec.logo, 5);
        if (!spec.land.length) errs.push("Subí al menos una imagen horizontal");
        if (!spec.sq.length) errs.push("Subí al menos una imagen cuadrada");
        if (!spec.logo.length) errs.push("Subí el logo");
      }
      if (errs.length) return res.status(400).json({ error: errs.join(" · "), errores: errs });
      const snap = await db.collection("users").doc(uid).get();
      const g = snap.data()?.googleAds || null;
      if (!g?.refresh_token) return res.status(400).json({ error: "no_conectado", detail: "Google Ads no está conectado en esta tienda." });
      const at = await gadsAccessToken(g);
      let pre = null;
      if (spec.tipo === "pmax") {
        // Google exige que títulos y descripciones de PMax existan antes de la campaña.
        const textos = [...spec.hs, ...spec.ds];
        const labels = [...spec.hs.map((_, i) => `Título ${i + 1}`), ...spec.ds.map((_, i) => `Descripción ${i + 1}`)];
        const out = await gadsMutate(at, customer, login, textos.map(text => ({ assetOperation: { create: { textAsset: { text } } } })), labels);
        const rns = out.map(o => o.assetResult?.resourceName).filter(Boolean);
        if (rns.length !== textos.length) throw new Error("Google no devolvió los textos creados — probá de nuevo.");
        pre = { hs: rns.slice(0, spec.hs.length), ds: rns.slice(spec.hs.length) };
      }
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
      const { ops, labels } = gadsOperaciones(customer, spec, pre, stamp);
      const out = await gadsMutate(at, customer, login, ops, labels);
      const campRN = out.map(o => o.campaignResult?.resourceName).find(Boolean) || "";
      return res.json({ ok: true, campaignId: campRN.split("/").pop() || null, resourceName: campRN, status: spec.status, tipo: spec.tipo, nombre: spec.nombre });
    }

    // 3) ai_copy: títulos / descripciones / keywords con Gemini, leyendo la página de
    //    destino + el contexto de marca (el mismo que usa el copy de Meta).
    if (action === "ai_copy" && req.method === "POST") {
      const b = parseBody(req);
      const apiKey = process.env.GOOGLE_AI_KEY;
      if (!apiKey) return res.status(500).json({ error: "Falta GOOGLE_AI_KEY en el servidor" });
      const url = String(b.url || "").trim().slice(0, 600);
      const notas = String(b.notas || "").trim().slice(0, 1500);
      if (!url && !notas) return res.status(400).json({ error: "Poné la URL de destino o contá qué vendés" });
      const snap = await db.collection("users").doc(uid).get();
      const marca = String(snap.data()?.meta_brand || "").trim().slice(0, 2500);
      const pagina = url ? await gadsLeerPagina(url) : "";
      const out = await gadsGeminiCopy(apiKey, { tipo: b.tipo === "pmax" ? "pmax" : "search", url, notas, marca, pagina, idioma: b.idioma });
      return res.json({ ok: true, ...out, leyoPagina: !!pagina });
    }

    return res.status(400).json({ error: "Acción inválida" });
  } catch (e) {
    console.error("google-ads error:", e);
    return res.status(e.status && e.status >= 400 && e.status < 600 ? 502 : 500).json({ error: e.message, google: e.google || null, code: e.code || null });
  }
}
