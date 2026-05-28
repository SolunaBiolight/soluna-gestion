// api/meta.js
// Meta Ads — Growith
// Maneja: cuentas, campañas, adsets, creativos (metadata en Firestore), copy con Gemini, publicación
//
// DIFERENCIAS vs Gestionommerce Python:
// - Sin disco local: metadata de creativos en Firestore (colección "meta_creatives" bajo users/{uid})
// - Sin threading: publicación síncrona (Vercel 60s alcanza para 1 creativo via URL pública)
// - Creativos se referencian por URL pública (Firebase Storage, CDN, etc.)

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

const META_V = "v21.0";
const META_BASE = `https://graph.facebook.com/${META_V}`;
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_UPLOAD_BASE = "https://generativelanguage.googleapis.com/upload/v1beta/files";
const GEMINI_TEXT_MODEL = "gemini-2.5-flash";

// Sube un archivo binario a Gemini Files API y espera a que esté ACTIVE.
// Devuelve { uri, name, mimeType, state }
async function geminiUploadFileAndWait(apiKey, buf, mime, displayName) {
  const startRes = await fetch(`${GEMINI_UPLOAD_BASE}?key=${apiKey}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Command": "start, upload, finalize",
      "X-Goog-Upload-Header-Content-Length": String(buf.length),
      "X-Goog-Upload-Header-Content-Type": mime,
      "Content-Type": mime,
    },
    body: buf,
  });
  if (!startRes.ok) {
    const t = await startRes.text().catch(()=> "");
    throw new Error(`Gemini upload HTTP ${startRes.status}: ${t.slice(0, 240)}`);
  }
  const startJson = await startRes.json();
  let file = startJson.file;
  if (!file?.uri || !file?.name) throw new Error("Gemini upload: respuesta inesperada");
  let state = file.state;
  // Wait up to ~45s for ACTIVE (videos suelen tardar 5-20s)
  for (let i = 0; i < 30 && state !== "ACTIVE"; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const pollRes = await fetch(`${GEMINI_BASE}/${file.name}?key=${apiKey}`);
    if (!pollRes.ok) break;
    const poll = await pollRes.json();
    file = poll;
    state = poll.state;
    if (state === "FAILED") throw new Error("Gemini procesó el archivo y falló");
  }
  if (state !== "ACTIVE") throw new Error("Timeout esperando que Gemini procese el archivo");
  return file;
}

export const CAMPAIGN_OBJECTIVES = [
  { id: "OUTCOME_SALES",      label: "Ventas" },
  { id: "OUTCOME_TRAFFIC",    label: "Tráfico" },
  { id: "OUTCOME_ENGAGEMENT", label: "Interacción" },
  { id: "OUTCOME_LEADS",      label: "Clientes potenciales" },
  { id: "OUTCOME_AWARENESS",  label: "Reconocimiento" },
];

export const VALID_CTAS = [
  "LEARN_MORE","SHOP_NOW","SIGN_UP","GET_OFFER","ORDER_NOW",
  "BUY_NOW","BOOK_NOW","CONTACT_US","DOWNLOAD","SUBSCRIBE",
  "MESSAGE_PAGE","WHATSAPP_MESSAGE",
];

// ─── Helpers Meta Graph API ────────────────────────────

// Códigos de error de Meta que indican rate-limit transitorio — reintentamos
// con backoff exponencial en vez de tirar al usuario. Más info:
//  4    Application request limit reached (app-level, compartido entre users)
//  17   User request limit reached (per-user)
//  32   Page-level throttling (per-page)
//  613  Custom-level throttling (per-feature)
//  80004 Ads insights throttling (when fetching insights)
const META_RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80004]);
const META_RETRY_DELAYS_MS = [1500, 3500, 7500]; // total ~12.5s antes de rendirse
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function metaGet(path, params, token) {
  const url = new URL(`${META_BASE}/${path.replace(/^\//, "")}`);
  url.searchParams.set("access_token", token);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  let lastErr = null;
  for (let attempt = 0; attempt <= META_RETRY_DELAYS_MS.length; attempt++) {
    const r = await fetch(url.toString());
    const d = await r.json();
    if (!d.error) return d;
    const code = d.error.code;
    const errMsg = `Meta · ${d.error.message} (${code})`;
    if (!META_RATE_LIMIT_CODES.has(code) || attempt === META_RETRY_DELAYS_MS.length) {
      throw new Error(errMsg);
    }
    lastErr = errMsg;
    console.warn(`[meta-rate-limit] GET ${path} → ${errMsg}; reintentando en ${META_RETRY_DELAYS_MS[attempt]}ms (intento ${attempt+1}/${META_RETRY_DELAYS_MS.length})`);
    await sleep(META_RETRY_DELAYS_MS[attempt]);
  }
  throw new Error(lastErr || "Meta retries exhausted");
}

async function metaPost(path, payload, token) {
  let lastErr = null;
  for (let attempt = 0; attempt <= META_RETRY_DELAYS_MS.length; attempt++) {
    const body = new URLSearchParams({ ...payload, access_token: token });
    const r = await fetch(`${META_BASE}/${path.replace(/^\//, "")}`, { method: "POST", body });
    const d = await r.json();
    if (!d.error) return d;
    const code = d.error.code;
    const errMsg = `Meta · ${d.error.message} (${code})`;
    if (!META_RATE_LIMIT_CODES.has(code) || attempt === META_RETRY_DELAYS_MS.length) {
      throw new Error(errMsg);
    }
    lastErr = errMsg;
    console.warn(`[meta-rate-limit] POST ${path} → ${errMsg}; reintentando en ${META_RETRY_DELAYS_MS[attempt]}ms (intento ${attempt+1}/${META_RETRY_DELAYS_MS.length})`);
    await sleep(META_RETRY_DELAYS_MS[attempt]);
  }
  throw new Error(lastErr || "Meta retries exhausted");
}

async function metaIntrospect(token) {
  const me = await metaGet("me", { fields: "id,name,email" }, token);

  // Intento 1: /me/adaccounts (funciona con user tokens)
  let adAccounts = [];
  try {
    const aa = await metaGet("me/adaccounts", { fields: "id,account_id,name,account_status,currency,timezone_name", limit: 200 }, token);
    adAccounts = aa.data || [];
  } catch (e) {
    console.warn("[meta-introspect] /me/adaccounts failed:", e.message);
  }

  // Intento 2: si está vacío, traer businesses → owned_ad_accounts + client_ad_accounts
  // (esto suele ser necesario para system user tokens donde /me/adaccounts viene vacío)
  if (adAccounts.length === 0) {
    try {
      const businessesRes = await metaGet("me", {
        fields: "businesses{id,name,owned_ad_accounts.limit(200){id,account_id,name,account_status,currency,timezone_name},client_ad_accounts.limit(200){id,account_id,name,account_status,currency,timezone_name}}",
      }, token);
      const businesses = businessesRes.businesses?.data || [];
      const collected = [];
      const seen = new Set();
      for (const biz of businesses) {
        for (const aa of (biz.owned_ad_accounts?.data || [])) {
          if (!seen.has(aa.id)) { seen.add(aa.id); collected.push(aa); }
        }
        for (const aa of (biz.client_ad_accounts?.data || [])) {
          if (!seen.has(aa.id)) { seen.add(aa.id); collected.push(aa); }
        }
      }
      adAccounts = collected;
      console.log(`[meta-introspect] fallback businesses → ${collected.length} ad_accounts`);
    } catch (e) {
      console.warn("[meta-introspect] businesses fallback failed:", e.message);
    }
  }

  // Pages
  let pages = [];
  try {
    const p = await metaGet("me/accounts", { fields: "id,name,access_token,instagram_business_account{id,username},category", limit: 200 }, token);
    pages = p.data || [];
  } catch (e) {
    console.warn("[meta-introspect] /me/accounts failed:", e.message);
  }

  return { me, ad_accounts: adAccounts, pages };
}

// ─── Helpers Firestore ─────────────────────────────────

function metaAccountRef(db, uid, accId) {
  return db.collection("users").doc(uid).collection("meta_accounts").doc(String(accId));
}
async function loadMetaAccount(db, uid, accId) {
  const snap = await metaAccountRef(db, uid, accId).get();
  return snap.exists ? snap.data() : null;
}
async function saveMetaAccount(db, uid, accId, data) {
  // Firestore no acepta undefined. Filtramos antes de escribir.
  const clean = Object.fromEntries(Object.entries({ ...data, id: String(accId) }).filter(([, v]) => v !== undefined));
  await metaAccountRef(db, uid, accId).set(clean, { merge: true });
}
async function listMetaAccounts(db, uid) {
  const snap = await db.collection("users").doc(uid).collection("meta_accounts").get();
  return snap.docs.map(d => d.data());
}
function safeAccount(cfg) {
  if (!cfg) return null;
  const { access_token, page_access_token, ...safe } = cfg;
  safe.has_token = Boolean(cfg.access_token);
  return safe;
}

function creativesCol(db, uid) {
  return db.collection("users").doc(uid).collection("meta_creatives");
}
async function loadCreative(db, uid, cid) {
  const snap = await creativesCol(db, uid).doc(cid).get();
  return snap.exists ? snap.data() : null;
}
async function saveCreative(db, uid, c) {
  await creativesCol(db, uid).doc(c.id).set(c, { merge: true });
}
async function listCreatives(db, uid, accId) {
  const snap = await creativesCol(db, uid).where("acc_id", "==", accId).orderBy("created_at", "desc").get();
  return snap.docs.map(d => d.data());
}

// ─── Gemini copy generation ────────────────────────────

const COPY_SYSTEM = `Sos un copywriter top de Meta Ads para ecommerce con +10 años de experiencia.
ESCRIBÍS EN ESPAÑOL RIOPLATENSE con voseo (vos/tenés/podés), nunca tú/tienes/puedes.
REGLA #1: La primera línea del copy es un HOOK SCROLL-STOPPER (curiosidad, contraintuitivo, dolor real o promesa fuerte). Nada de "¿Sabías que…?" ni preguntas tibias.
REGLA #2: El copy fluye como historia/conversación, no como folleto. Usá saltos de línea reales (\n) entre párrafos. Emojis sólo si suman, máximo 4 en todo el copy.
REGLA #3: Cerrá con un CTA claro y un link suave al producto.
Devolvé SOLO un JSON sin backticks ni explicaciones:
{"copy":"texto principal con saltos de línea reales","title":"titular ≤40 chars que combina con el creativo","description":"descripción ≤30 chars"}`;

async function geminiGenerateCopy({ brand, analysis, tone, length, format, notes, filename, word_min, word_max, product_data, url, copy_agent }) {
  const apiKey = process.env.GOOGLE_AI_KEY;
  if (!apiKey) throw new Error("Falta GOOGLE_AI_KEY en env");
  const toneDesc = { directo:"directo y al grano", emocional:"empático y emocional", urgencia:"con urgencia y escasez", educativo:"educativo e informativo", empatico:"empático y emocional", experto:"voz de experto/profesional con autoridad", ugc:"como UGC real de cliente, casual y honesto", dramatico:"dramático y emocional fuerte", informativo:"informativo y educativo" }[tone] || tone || "directo";
  // Default + soporte "nativo" (+400 palabras) y "nativo+500"
  const lengthDesc = {
    corto:"máximo 3 líneas (~25-40 palabras)",
    medio:"4-6 líneas (~50-90 palabras)",
    largo:"7-10 líneas (~100-160 palabras)",
    nativo:"formato nativo Facebook: MÁS de 400 palabras, hook fuerte en la primera línea, varios párrafos cortos, storytelling completo, problema → agitación → solución → prueba social → CTA",
  }[length] || "formato nativo Facebook: MÁS de 400 palabras, hook fuerte en la primera línea, varios párrafos, storytelling completo";
  const formatDesc = { storytelling:"storytelling (problema → agitación → solución)", directo:"propuesta de valor directa", pregunta:"arranca con una pregunta al target", "pregunta-hook":"arranca con una pregunta hook al target", testimonial:"en primera persona como testimonio", "lista":"lista de beneficios numerados o con bullets", "lista de beneficios":"lista de beneficios numerados o con bullets", testimonio:"en primera persona como testimonio", "experto/medico":"voz de experto/médico explicando con autoridad", "ugc casual":"como UGC casual de cliente real" }[format] || format || "storytelling";
  const wMin = parseInt(word_min, 10);
  const wMax = parseInt(word_max, 10);
  const hasWordRange = !Number.isNaN(wMin) && !Number.isNaN(wMax) && wMin > 0 && wMax >= wMin;
  // Si length === "nativo" y no hay rango explícito, forzamos mínimo 400
  const isNativo = length === "nativo";
  const effectiveMin = hasWordRange ? wMin : (isNativo ? 400 : 0);
  const effectiveMax = hasWordRange ? wMax : (isNativo ? 700 : 0);
  const lengthLine = effectiveMin > 0
    ? `- Largo: entre ${effectiveMin} y ${effectiveMax} palabras (mínimo ${effectiveMin}, NO menos)`
    : `- Largo: ${lengthDesc}`;
  // Copy aleatorio: ignoramos filename y analisis (el user lo pidio explicito).
  // El copy se basa SOLO en: brand + product_data + URL + copy_agent + seed
  // random. Sin contexto del ad concreto, sin filename, sin angulo.
  const userPrompt = [
    brand ? `## Contexto de marca:\n${brand}` : "",
    product_data ? `## Data del producto (usar SI o SI):\n${product_data}` : "",
    url ? `## URL del producto (mencionar al final como CTA):\n${url}` : "",
    (tone || length || format) ? `## Parámetros sugeridos (opcional):\n${[tone?`- Tono: ${toneDesc}`:"",lengthLine,format?`- Formato: ${formatDesc}`:""].filter(Boolean).join("\n")}` : "",
    notes ? `- Notas extra: ${notes}` : "",
    `\nGenerá un copy COMPLETAMENTE ORIGINAL para Meta Ads. La PRIMERA línea = hook scroll-stopper. NO repitas estructuras de copies anteriores — improvisá un ángulo único cada vez. JSON exacto.`,
  ].filter(Boolean).join("\n\n");
  // System instruction = baseline + estilo del agente que define el usuario
  const systemText = copy_agent?.trim()
    ? `${COPY_SYSTEM}\n\n## INSTRUCCIONES DEL AGENTE (definidas por el dueño de la cuenta — PRIORIDAD MAXIMA, sobreescriben cualquier default):\n${copy_agent.trim()}`
    : COPY_SYSTEM;
  // Variabilidad: temperature alta + seed que cambia cada vez para que copies
  // del mismo creativo salgan distintos cada generacion.
  // Hasta 3 intentos. Si Gemini devuelve vacío o JSON truncado, reintentamos con
  // tokens cada vez más grandes y temperature más conservadora.
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const randSeed = Math.floor(Math.random() * 100000);
    const maxTok = attempt === 0 ? 3000 : attempt === 1 ? 4500 : 6000;
    const temp = attempt === 0 ? 0.95 : 0.7;
    const payload = {
      system_instruction: { parts: [{ text: systemText }] },
      contents: [{ role: "user", parts: [{ text: userPrompt + `\n\n(seed: ${randSeed})` }] }],
      generationConfig: { response_mime_type: "application/json", temperature: temp, top_p: 0.95, max_output_tokens: maxTok },
    };
    let data;
    try {
      const r = await fetch(`${GEMINI_BASE}/models/${GEMINI_TEXT_MODEL}:generateContent?key=${apiKey}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      data = await r.json();
    } catch (e) { lastErr = e; continue; }
    const cand = data.candidates?.[0];
    const text = cand?.content?.parts?.[0]?.text || "";
    const finishReason = cand?.finishReason || "";
    if (!text) {
      lastErr = new Error(`Gemini devolvió respuesta vacía (finish: ${finishReason || "sin razón"})`);
      continue;
    }
    let cleaned = text;
    if (cleaned.includes("```")) { cleaned = cleaned.split("```")[1] || ""; if (cleaned.startsWith("json")) cleaned = cleaned.slice(4); }
    const s = cleaned.indexOf("{"), e = cleaned.lastIndexOf("}");
    if (s >= 0 && e > s) cleaned = cleaned.slice(s, e + 1);
    // Intento 1: parse directo
    try { return JSON.parse(cleaned); } catch (_) {}
    // Intento 2: si JSON truncado (Unterminated string), reparar cerrando comillas y llaves
    try {
      let repaired = cleaned;
      // Si terminó sin cerrar string: agregar comilla
      const dquotes = (repaired.match(/(?<!\\)"/g) || []).length;
      if (dquotes % 2 === 1) repaired += '"';
      // Cerrar llaves abiertas que sobren
      const opens = (repaired.match(/\{/g) || []).length;
      const closes = (repaired.match(/\}/g) || []).length;
      for (let i = 0; i < opens - closes; i++) repaired += "}";
      return JSON.parse(repaired);
    } catch (_) {}
    // Intento 3: extraer campos copy/title/description via regex como fallback
    try {
      const copyM = cleaned.match(/"copy"\s*:\s*"((?:\\.|[^"\\])*)/);
      const titleM = cleaned.match(/"title"\s*:\s*"((?:\\.|[^"\\])*)/);
      const descM = cleaned.match(/"description"\s*:\s*"((?:\\.|[^"\\])*)/);
      if (copyM) {
        return {
          copy: copyM[1].replace(/\\n/g, "\n").replace(/\\"/g, '"'),
          title: titleM?.[1].replace(/\\"/g, '"') || "",
          description: descM?.[1].replace(/\\"/g, '"') || "",
        };
      }
    } catch (_) {}
    lastErr = new Error(`Gemini devolvió JSON inválido (intento ${attempt + 1})`);
  }
  throw lastErr || new Error("Gemini falló tras 3 intentos");
}

// ─── Insights helper (reutilizable por endpoint y evaluador de reglas) ──

async function fetchInsightsRows(cfg, level, since, until) {
  const fields = [
    "campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name",
    "spend", "impressions", "clicks", "ctr", "cpm", "cpc", "frequency", "reach",
    "actions", "action_values", "purchase_roas", "cost_per_action_type",
  ].join(",");
  // Paginar insights — antes con limit 500 y sin paging.next los ads de pos 501+
  // caian en el branch "sin gasto" con spend:0 aunque hayan gastado 20k+.
  const insightsRows = [];
  let page = await metaGet(`${cfg.ad_account_id}/insights`, {
    level,
    "time_range[since]": since,
    "time_range[until]": until,
    action_attribution_windows: JSON.stringify(["1d_click", "1d_view"]),
    fields,
    limit: 500,
  }, cfg.access_token);
  insightsRows.push(...(page.data || []));
  let nextUrl = page.paging?.next || null;
  let safety = 0;
  while (nextUrl && safety < 20) {
    safety++;
    try {
      const r = await fetch(nextUrl);
      const j = await r.json();
      if (!r.ok || j.error) break;
      insightsRows.push(...(j.data || []));
      nextUrl = j.paging?.next || null;
    } catch (_) { break; }
  }

  const nodeFields = level === "campaign" ? "id,name,status,effective_status,objective,daily_budget,lifetime_budget"
                   : level === "adset"    ? "id,name,status,effective_status,daily_budget,lifetime_budget,campaign_id"
                   : "id,name,status,effective_status,adset_id,campaign_id";
  const nodeArr = [];
  let nodePage = await metaGet(`${cfg.ad_account_id}/${level === "campaign" ? "campaigns" : level === "adset" ? "adsets" : "ads"}`, {
    fields: nodeFields, limit: 500,
  }, cfg.access_token);
  nodeArr.push(...(nodePage.data || []));
  let nodeNext = nodePage.paging?.next || null;
  let nodeSafety = 0;
  while (nodeNext && nodeSafety < 20) {
    nodeSafety++;
    try {
      const r = await fetch(nodeNext);
      const j = await r.json();
      if (!r.ok || j.error) break;
      nodeArr.push(...(j.data || []));
      nodeNext = j.paging?.next || null;
    } catch (_) { break; }
  }
  const nodeMap = {};
  for (const n of nodeArr) nodeMap[n.id] = n;

  const rows = insightsRows.map(r => {
    const idField = level === "campaign" ? "campaign_id" : level === "adset" ? "adset_id" : "ad_id";
    const id = r[idField];
    const node = nodeMap[id] || {};
    const purchases = (r.actions || []).find(a => /purchase/.test(a.action_type || ""));
    const purchaseValue = (r.action_values || []).find(a => /purchase/.test(a.action_type || ""));
    const cpaPurchase = (r.cost_per_action_type || []).find(a => /purchase/.test(a.action_type || ""));
    return {
      id,
      name: r[level + "_name"] || node.name || "",
      status: node.status || null,
      effective_status: node.effective_status || null,
      campaign_id: r.campaign_id, adset_id: r.adset_id, ad_id: r.ad_id,
      spend: parseFloat(r.spend) || 0,
      impressions: parseInt(r.impressions) || 0,
      clicks: parseInt(r.clicks) || 0,
      ctr: parseFloat(r.ctr) || 0,
      cpm: parseFloat(r.cpm) || 0,
      cpc: parseFloat(r.cpc) || 0,
      frequency: parseFloat(r.frequency) || 0,
      reach: parseInt(r.reach) || 0,
      purchases: parseInt(purchases?.value) || 0,
      purchase_value: parseFloat(purchaseValue?.value) || 0,
      roas: parseFloat((r.purchase_roas || [])[0]?.value) || 0,
      cpa: parseFloat(cpaPurchase?.value) || 0,
    };
  });
  // Agregar nodos sin gasto
  for (const id in nodeMap) {
    if (!rows.find(r => r.id === id)) {
      const n = nodeMap[id];
      rows.push({
        id, name: n.name || "", status: n.status, effective_status: n.effective_status,
        spend: 0, impressions: 0, clicks: 0, ctr: 0, cpm: 0, cpc: 0, frequency: 0, reach: 0,
        purchases: 0, purchase_value: 0, roas: 0, cpa: 0,
      });
    }
  }
  return rows;
}

// ─── Evaluador de reglas (Fase 3 optimizador) ─────────

function evalCondition(actual, op, target) {
  const t = parseFloat(target);
  const a = parseFloat(actual) || 0;
  if (isNaN(t)) return false;
  switch (op) {
    case ">=": return a >= t;
    case ">":  return a >  t;
    case "<=": return a <= t;
    case "<":  return a <  t;
    case "=":  return Math.abs(a - t) < 0.0001;
    default:   return false;
  }
}

// Evalúa todas las reglas activas del usuario para esa cuenta.
// Aplica acciones (pause) sobre nodos que matcheen y loguea cada disparo.
// opts.force_window_days: si está, sobreescribe la window de cada condition
//   con ese valor (usado en "Reprocesar últimos N días"). Útil para que una
//   regla recién creada pueda accionar sobre data histórica al instante.
async function evaluateRulesForAccount(db, uid, accId, opts = {}) {
  const cfg = await loadMetaAccount(db, uid, accId);
  if (!cfg?.access_token || !cfg.ad_account_id) return { error: "Cuenta no configurada" };

  const rulesSnap = await db.collection("users").doc(uid).collection("meta_rules")
    .where("acc_id", "==", accId).where("active", "==", true).get();
  const rules = rulesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (rules.length === 0) return { evaluated: 0, actions: 0 };

  const forceWindow = parseInt(opts.force_window_days, 10);
  const useForcedWindow = Number.isFinite(forceWindow) && forceWindow > 0;
  const effectiveWindow = (cond) => useForcedWindow ? forceWindow : (cond.window_days || 7);

  // Pre-fetch insights por cada combinación única (level, window) que use alguna regla
  const combos = new Set();
  for (const rule of rules) {
    for (const cond of rule.conditions || []) combos.add(`${rule.level}|${effectiveWindow(cond)}`);
  }
  const cache = new Map(); // "level|window" -> Map<nodeId, row>
  for (const combo of combos) {
    const [level, w] = combo.split("|");
    const since = new Date(Date.now() - parseInt(w) * 86400000).toISOString().slice(0, 10);
    const until = new Date().toISOString().slice(0, 10);
    try {
      const rows = await fetchInsightsRows(cfg, level, since, until);
      cache.set(combo, new Map(rows.map(r => [r.id, r])));
    } catch (e) {
      console.error("[meta-rules] fetch failed", combo, e.message);
    }
  }

  // ── Productos (clasificador URL→producto) — para reglas con product_ids ──
  // Solo cargamos si alguna regla usa filtro de productos (ahorra una API call si nadie filtra).
  const rulesNeedProducts = rules.some(r => Array.isArray(r.product_ids) && r.product_ids.length > 0);
  let productsById = new Map();
  let adProductsByNode = { campaign: new Map(), adset: new Map(), ad: new Map() };
  if (rulesNeedProducts) {
    try {
      const prodSnap = await db.collection("users").doc(uid).collection("meta_products")
        .where("acc_id", "==", accId).get();
      for (const d of prodSnap.docs) productsById.set(d.id, { id: d.id, ...d.data() });
      // Pre-fetch los ads de la cuenta con sus URLs de destino para mapear node → product_ids
      // Paginar para que cuentas con >500 ads no queden parcialmente mapeadas.
      try {
        const adsArr = [];
        let page = await metaGet(`${cfg.ad_account_id}/ads`, {
          limit: 500,
          fields: "id,adset_id,campaign_id,creative{id,link_url,object_story_spec,asset_feed_spec,template_url,effective_object_story_id,object_story_id}",
        }, cfg.access_token);
        adsArr.push(...(page.data || []));
        let nextUrl = page.paging?.next || null;
        let safety = 0;
        while (nextUrl && safety < 10) {
          safety++;
          const r = await fetch(nextUrl);
          const j = await r.json();
          if (!r.ok || j.error) break;
          adsArr.push(...(j.data || []));
          nextUrl = j.paging?.next || null;
        }
        // Helper: extrae la URL de destino del creative (multiples fallbacks)
        const linkOfAdCreative = (ad) => {
          const cr = ad.creative || {};
          if (cr.link_url) return cr.link_url;
          if (cr.template_url) return cr.template_url;
          const oss = cr.object_story_spec || {};
          const link = oss.link_data?.link
            || oss.video_data?.call_to_action?.value?.link
            || oss.video_data?.call_to_action?.value?.link_url
            || oss.template_data?.link
            || oss.photo_data?.url
            || null;
          if (link) return link;
          const afs = cr.asset_feed_spec || {};
          if (Array.isArray(afs.link_urls)) {
            for (const lu of afs.link_urls) {
              if (lu?.website_url) return lu.website_url;
              if (lu?.url) return lu.url;
            }
          }
          return null;
        };
        // Resolver URLs de ads que usan post existente (effective_object_story_id)
        const extractLinkFromPost = (post) => {
          if (!post) return null;
          if (post.link) return post.link;
          const cta = post.call_to_action;
          if (cta?.value?.link) return cta.value.link;
          if (cta?.value?.link_url) return cta.value.link_url;
          const atts = post.attachments?.data || [];
          for (const att of atts) {
            if (att.target?.url) return att.target.url;
            if (att.url) return att.url;
            if (att.unshimmed_url) return att.unshimmed_url;
            const subs = att.subattachments?.data || [];
            for (const sub of subs) {
              if (sub.target?.url) return sub.target.url;
              if (sub.url) return sub.url;
              if (sub.unshimmed_url) return sub.unshimmed_url;
            }
          }
          if (post.message) {
            const m = post.message.match(/https?:\/\/[^\s"'<>)]+/i);
            if (m) return m[0];
          }
          return null;
        };
        const extractLinkAnywhere = (obj) => {
          const link = extractLinkFromPost(obj);
          if (link) return link;
          if (obj.caption) {
            const m = String(obj.caption).match(/https?:\/\/[^\s"'<>)]+/i);
            if (m) return m[0];
          }
          return null;
        };
        const fetchPostsBatch = async (chunk, token) => {
          const out = {};
          try {
            const params = new URLSearchParams({ ids: chunk.join(","), fields: "attachments.fields(target,url,unshimmed_url,subattachments),link,call_to_action,message,permalink_url,caption", access_token: token });
            const r = await fetch(`${META_BASE}/?${params}`);
            const j = await r.json();
            if (r.ok && !j.error && typeof j === "object") {
              for (const [pid, obj] of Object.entries(j)) {
                const link = extractLinkAnywhere(obj);
                if (link) out[pid] = link;
              }
            }
          } catch (_) {}
          return out;
        };
        const postIdOfAd = (a) => a.creative?.effective_object_story_id || a.creative?.object_story_id || null;
        const adsWithPostNoLink = adsArr.filter(a => !linkOfAdCreative(a) && postIdOfAd(a));
        const postIds = [...new Set(adsWithPostNoLink.map(postIdOfAd))];
        const postLinks = {};
        for (let i = 0; i < postIds.length; i += 50) {
          const chunk = postIds.slice(i, i + 50);
          Object.assign(postLinks, await fetchPostsBatch(chunk, cfg.access_token));
          if (cfg.page_access_token) {
            const remaining = chunk.filter(pid => !postLinks[pid]);
            if (remaining.length) Object.assign(postLinks, await fetchPostsBatch(remaining, cfg.page_access_token));
          }
        }
        // Fallback IG-media para los que no resolvieron via /post_id endpoint
        const stillMissing = postIds.filter(pid => !postLinks[pid]);
        for (const pid of stillMissing.slice(0, 30)) {
          const igCandidate = pid.includes("_") ? pid.split("_")[1] : pid;
          try {
            const obj = await metaGet(igCandidate, { fields: "caption,permalink,media_type" }, cfg.page_access_token || cfg.access_token);
            const link = extractLinkAnywhere(obj);
            if (link) postLinks[pid] = link;
          } catch (_) {}
        }
        // Para ads que aun no resolvieron, fetchear el creative directamente
        const adsStillNoLink = adsArr.filter(a => !linkOfAdCreative(a) && !(a.creative?.effective_object_story_id && postLinks[a.creative.effective_object_story_id]));
        const creativeIds = [...new Set(adsStillNoLink.map(a => a.creative?.id).filter(Boolean))];
        const creativeLinks = {};
        for (let i = 0; i < creativeIds.length; i += 50) {
          const chunk = creativeIds.slice(i, i + 50);
          try {
            const params = new URLSearchParams({ ids: chunk.join(","), fields: "link_url,template_url,object_story_spec{link_data{link},video_data{call_to_action{value{link,link_url}}},template_data{link},photo_data{url}},asset_feed_spec{link_urls}", access_token: cfg.access_token });
            const r = await fetch(`${META_BASE}/?${params}`);
            const j = await r.json();
            if (r.ok && !j.error && typeof j === "object") {
              for (const [cid, cr] of Object.entries(j)) {
                const fakeAd = { creative: cr };
                const link = linkOfAdCreative(fakeAd);
                if (link) creativeLinks[cid] = link;
              }
            }
          } catch (_) {}
        }
        const linkOfAd = (ad) => {
          const direct = linkOfAdCreative(ad);
          if (direct) return direct;
          const pid = postIdOfAd(ad);
          if (pid && postLinks[pid]) return postLinks[pid];
          const cid = ad.creative?.id;
          if (cid && creativeLinks[cid]) return creativeLinks[cid];
          return null;
        };
        // Normaliza URL: minusculas, sin proto, sin www, sin query/hash, sin trailing slash.
        const norm = (u) => {
          let s = String(u || "").trim().toLowerCase();
          s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
          s = s.split("#")[0].split("?")[0];
          s = s.replace(/\/+$/, "");
          return s;
        };
        const productsByUrlPrefix = []; // [{prefix, id}]
        for (const [pid, p] of productsById) {
          for (const u of (p.urls || [])) {
            const n = norm(u);
            if (n) productsByUrlPrefix.push({ prefix: n, id: pid });
          }
        }
        productsByUrlPrefix.sort((a, b) => b.prefix.length - a.prefix.length); // mas largo primero
        const productIdsForUrl = (url) => {
          if (!url) return [];
          const n = norm(url);
          if (!n) return [];
          const matches = new Set();
          for (const { prefix, id } of productsByUrlPrefix) {
            if (!prefix) continue;
            if (n === prefix || n.startsWith(prefix + "/")) matches.add(id);
          }
          return [...matches];
        };
        // Construir mapas por nivel
        for (const ad of adsArr) {
          const link = linkOfAd(ad);
          const pids = productIdsForUrl(link);
          if (pids.length === 0) continue;
          adProductsByNode.ad.set(ad.id, new Set(pids));
          if (ad.adset_id) {
            const s = adProductsByNode.adset.get(ad.adset_id) || new Set();
            pids.forEach(p => s.add(p));
            adProductsByNode.adset.set(ad.adset_id, s);
          }
          if (ad.campaign_id) {
            const s = adProductsByNode.campaign.get(ad.campaign_id) || new Set();
            pids.forEach(p => s.add(p));
            adProductsByNode.campaign.set(ad.campaign_id, s);
          }
        }
      } catch (e) {
        console.error("[meta-rules] ads fetch for product mapping failed:", e.message);
      }
    } catch (e) {
      console.error("[meta-rules] products load failed:", e.message);
    }
  }
  // Helper: ¿este node (campaign/adset/ad id) pertenece a alguno de los products filtrados?
  // POLÍTICA ESTRICTA (cambiada 28/5/2026): si la regla tiene product_ids seleccionados,
  // SOLO se actúa sobre nodos cuya URL de destino matchee alguno de esos productos. Antes
  // se aplicaba una política "loose" (incluir igual cuando la URL no resolvía) pero
  // generaba falsos positivos — ej. pausar ads que no eran del producto seleccionado.
  // Trade-off: si la URL del ad no se resuelve, no se actúa (el usuario debe corregir
  // la URL del producto o de la regla). Para reglas que deben aplicar a TODO, dejar
  // product_ids vacío.
  const nodeMatchesProductFilter = (level, nodeId, filterIds) => {
    if (!Array.isArray(filterIds) || filterIds.length === 0) return true; // sin filtro = aplica a todos
    const productSet = adProductsByNode[level]?.get(nodeId);
    if (!productSet || productSet.size === 0) return false; // URL no resuelta → no actuamos
    return filterIds.some(pid => productSet.has(pid));
  };

  let totalActions = 0;
  const logBatch = db.batch();
  const logCol = db.collection("users").doc(uid).collection("meta_rule_log");

  for (const rule of rules) {
    if (!rule.conditions?.length) continue;
    // Usamos la window de la PRIMERA condition como referencia para listar nodos.
    // Cada condition se evalúa con su propia window cache.
    const refCombo = `${rule.level}|${effectiveWindow(rule.conditions[0])}`;
    const refMap = cache.get(refCombo) || new Map();

    for (const [nodeId, refRow] of refMap) {
      if (refRow.effective_status !== "ACTIVE") continue;
      // Filtro por productos: si la regla tiene product_ids, solo actuar sobre
      // nodos que matcheen algún producto seleccionado.
      if (!nodeMatchesProductFilter(rule.level, nodeId, rule.product_ids)) continue;

      const results = rule.conditions.map(c => {
        const combo = `${rule.level}|${effectiveWindow(c)}`;
        const row = cache.get(combo)?.get(nodeId) || {};
        const v = row[c.metric] ?? 0;
        return { matched: evalCondition(v, c.op, c.value), actual: v, cond: c, effective_window: effectiveWindow(c) };
      });
      const matched = rule.logic === "OR"
        ? results.some(r => r.matched)
        : results.every(r => r.matched);

      if (!matched) continue;

      // Aplicar acción con verificación + retry.
      // IMPORTANTE: Meta a veces devuelve `{success: true}` aunque el cambio no se
      // aplique (token sin permisos exactos sobre la asset, eventual consistency,
      // delivery review, etc.). Por eso después de cada acción releemos el nodo y
      // verificamos. Damos margen a la consistencia eventual con un pequeño delay
      // y un reintento — si tras eso sigue sin tomar el cambio, marcamos ok=false
      // con un mensaje accionable para que el usuario revise BM.
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      let ok = true, errMsg = null;

      if (rule.action === "pause") {
        const tryPause = async () => {
          await metaPost(nodeId, { status: "PAUSED" }, cfg.access_token);
        };
        const verifyPaused = async () => {
          const after = await metaGet(nodeId, { fields: "status,effective_status" }, cfg.access_token);
          const s = String(after.status || after.effective_status || "").toUpperCase();
          return s === "PAUSED" || s === "DELETED" || s === "ARCHIVED";
        };
        try {
          await tryPause();
          await sleep(1200); // dar margen a la consistencia eventual de Meta
          let applied = await verifyPaused();
          if (!applied) {
            // Reintento — a veces el primer POST cae en una replica que tarda más.
            await tryPause();
            await sleep(2500);
            applied = await verifyPaused();
          }
          if (!applied) {
            ok = false;
            errMsg = "Meta aceptó el POST de pausa (2 intentos) pero el ad sigue activo. Es casi siempre permisos: en Business Manager → Usuarios del sistema → tu System User → Asignar activos, confirmá que esta cuenta publicitaria tenga 'Administrar campañas' tildado (no solo 'Ver rendimiento').";
          }
        } catch (e) { ok = false; errMsg = e.message; }
      } else if (rule.action === "reduce_budget") {
        try {
          const node = await metaGet(nodeId, { fields: "daily_budget,lifetime_budget" }, cfg.access_token);
          const dailyOld = parseInt(node.daily_budget) || 0;
          const lifetimeOld = parseInt(node.lifetime_budget) || 0;
          const oldBudget = dailyOld || lifetimeOld;
          if (oldBudget <= 0) throw new Error("Sin presupuesto editable (puede tener CBO/Advantage+ Budget en la campaña)");
          const pctNum = parseFloat(rule.action_pct) || 20;
          const newBudget = Math.max(100, Math.round(oldBudget * (100 - pctNum) / 100));
          const field = dailyOld > 0 ? "daily_budget" : "lifetime_budget";

          const tryReduce = async () => {
            await metaPost(nodeId, { [field]: String(newBudget) }, cfg.access_token);
          };
          const verifyReduced = async () => {
            const after = await metaGet(nodeId, { fields: "daily_budget,lifetime_budget" }, cfg.access_token);
            return (parseInt(after[field]) || 0) === newBudget;
          };
          await tryReduce();
          await sleep(1200);
          let applied = await verifyReduced();
          if (!applied) {
            await tryReduce();
            await sleep(2500);
            applied = await verifyReduced();
          }
          if (!applied) {
            ok = false;
            errMsg = `Meta aceptó el POST de presupuesto (2 intentos) pero ${field} no quedó en ${newBudget}. Revisar permisos del System User en BM ('Administrar campañas') o si la campaña usa CBO/Advantage+ Budget (en ese caso hay que bajar el presupuesto de la CAMPAÑA, no del adset).`;
          }
        } catch (e) { ok = false; errMsg = e.message; }
      }

      const logRef = logCol.doc();
      const matchedProductIds = (rule.product_ids?.length && adProductsByNode[rule.level]?.get(nodeId))
        ? [...adProductsByNode[rule.level].get(nodeId)].filter(pid => rule.product_ids.includes(pid))
        : [];
      logBatch.set(logRef, {
        rule_id: rule.id, rule_name: rule.name,
        node_id: nodeId, node_name: refRow.name || "",
        level: rule.level, logic: rule.logic,
        action_taken: rule.action, ok, error: errMsg || null,
        triggered: results.map(r => ({ metric: r.cond.metric, op: r.cond.op, target: r.cond.value, window_days: r.effective_window || r.cond.window_days, actual: r.actual })),
        reprocessed: useForcedWindow,
        forced_window_days: useForcedWindow ? forceWindow : null,
        product_ids: matchedProductIds,
        ts: new Date().toISOString(),
      });
      totalActions++;
    }

    // Stamp de last_evaluated_at
    logBatch.set(db.collection("users").doc(uid).collection("meta_rules").doc(rule.id),
      { last_evaluated_at: new Date().toISOString() }, { merge: true });
  }

  await logBatch.commit().catch(e => console.error("[meta-rules] log commit failed:", e.message));
  return { evaluated: rules.length, actions: totalActions };
}

// ─── Gemini analyze ad (Biblioteca) ───────────────────

const ANALYZE_SYSTEM = `Sos un experto en Meta Ads (Facebook & Instagram) para ecommerce argentino. Analizás anuncios usando el copy, el creative y las métricas reales de los últimos 7 días. Sos honesto y directo — si un ad anda mal, lo decís.

Devolvés SIEMPRE un JSON válido con esta estructura EXACTA, sin texto extra ni backticks:
{
  "descripcion_corta": "1-2 líneas describiendo qué vende y a quién apunta",
  "audiencia_target": "descripción del target probable según copy/creative",
  "hook": "el gancho/primera línea del copy",
  "angulos": ["array de 2-4 ángulos: precio, urgencia, social_proof, beneficio, problema_solucion, autoridad, novedad, exclusividad, transformacion, miedo, etc."],
  "tono": "tono del copy en 1-2 palabras",
  "formato": "formato del ad: testimonial, storytelling, lista, pregunta, directo, demo, antes_despues, etc.",
  "estrategia": "qué busca lograr (conversion directa, awareness, retargeting, prospecting, etc.)",
  "fortalezas": ["3 puntos fuertes concretos"],
  "oportunidades": ["3 cosas concretas a mejorar"],
  "performance_takeaway": "2-3 líneas con análisis honesto de las métricas (qué dice el ROAS, CTR, frecuencia, CPA)",
  "accion_recomendada": "escalar | iterar | pausar | monitor",
  "razon_accion": "1-2 líneas explicando la acción recomendada"
}`;

async function geminiAnalyzeAd(adData) {
  const apiKey = process.env.GOOGLE_AI_KEY;
  if (!apiKey) throw new Error("Falta GOOGLE_AI_KEY en env");
  const fmt = (n) => (typeof n === "number" ? n.toFixed(2) : "0.00");
  const userPrompt = `## Anuncio
**Nombre:** ${adData.name || "(sin nombre)"}
**Headline:** ${adData.headline || "(vacío)"}
**Body / Copy:**
${adData.body || "(vacío)"}
**Description:** ${adData.description || "(vacío)"}
**Call to action:** ${adData.cta || "(ninguno)"}
**Link:** ${adData.link_url || "(sin link)"}
**Tipo creative:** ${adData.creative_type || "imagen"}

## Performance últimos 7 días
- Gasto: $${fmt(adData.spend)}
- Impresiones: ${adData.impressions || 0}
- Clicks: ${adData.clicks || 0}
- CTR: ${fmt(adData.ctr)}%
- CPM: $${fmt(adData.cpm)}
- Frecuencia: ${fmt(adData.frequency)}
- Compras: ${adData.purchases || 0}
- Valor compras: $${fmt(adData.purchase_value)}
- ROAS: ${fmt(adData.roas)}x
- CPA: $${fmt(adData.cpa)}

Analizá el anuncio FULL y devolvé el JSON. Sé específico y útil — no des consejos genéricos.`;

  const payload = {
    system_instruction: { parts: [{ text: ANALYZE_SYSTEM }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: { response_mime_type: "application/json", temperature: 0.5, max_output_tokens: 2000 },
  };
  const r = await fetch(`${GEMINI_BASE}/models/${GEMINI_TEXT_MODEL}:generateContent?key=${apiKey}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const data = await r.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) throw new Error("Gemini devolvió respuesta vacía");
  let cleaned = text;
  if (cleaned.includes("```")) { cleaned = cleaned.split("```")[1] || ""; if (cleaned.startsWith("json")) cleaned = cleaned.slice(4); }
  const s = cleaned.indexOf("{"), e = cleaned.lastIndexOf("}");
  if (s >= 0 && e > s) cleaned = cleaned.slice(s, e + 1);
  try { return JSON.parse(cleaned); } catch (_) {
    // Reparar JSON truncado
    let repaired = cleaned;
    const dq = (repaired.match(/(?<!\\)"/g) || []).length;
    if (dq % 2 === 1) repaired += '"';
    const opens = (repaired.match(/\{/g) || []).length;
    const closes = (repaired.match(/\}/g) || []).length;
    for (let i = 0; i < opens - closes; i++) repaired += "}";
    return JSON.parse(repaired);
  }
}

// ─── Handler ───────────────────────────────────────────

export const config = { api: { bodyParser: { sizeLimit: "50mb" } } };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { action, uid, acc_id, cid } = req.query;

  const db = initAdmin();

  // ── CRON: corre evaluación de reglas para TODOS los users con reglas activas ──
  // Lo dispara Vercel Cron (Bearer CRON_SECRET) sin uid.
  if (action === "cron_run_all" && req.method === "GET") {
    const expected = process.env.CRON_SECRET;
    const got = req.headers.authorization || "";
    if (expected && got !== `Bearer ${expected}`) {
      return res.status(401).json({ error: "Unauthorized cron" });
    }
    try {
      const allRules = await db.collectionGroup("meta_rules").where("active", "==", true).get();
      const tasks = new Map();
      allRules.docs.forEach(d => {
        const data = d.data();
        const ownerUid = d.ref.parent.parent.id;
        if (data.acc_id) tasks.set(`${ownerUid}|${data.acc_id}`, { uid: ownerUid, accId: data.acc_id });
      });
      const summary = [];
      for (const { uid: u, accId } of tasks.values()) {
        try {
          const r = await evaluateRulesForAccount(db, u, accId);
          summary.push({ uid: u, accId, ...r });
        } catch (e) {
          summary.push({ uid: u, accId, error: e.message });
        }
      }
      return res.json({ ok: true, ran: tasks.size, summary });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (!uid) return res.status(401).json({ error: "Falta uid" });

  try {

    // ── CUENTAS ──────────────────────────────────────────

    // Devuelve la URL de OAuth de Meta para que el cliente la abra en una ventana.
    // El callback (api/meta-callback.js) intercambia el code por token y guarda en Firestore.
    if (action === "oauth_start" && req.method === "GET") {
      const appId = process.env.META_APP_ID;
      if (!appId) return res.status(500).json({ error: "Falta META_APP_ID en Vercel" });
      const redirectUri = encodeURIComponent("https://www.growithapp.com/api/meta-callback");
      const scopes = [
        "ads_management",
        "ads_read",
        "business_management",
        "pages_show_list",
        "pages_read_engagement",
        "instagram_basic",
        "instagram_content_publish",
      ].join(",");
      const url = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${appId}&redirect_uri=${redirectUri}&state=${encodeURIComponent(uid)}&scope=${encodeURIComponent(scopes)}&response_type=code`;
      return res.json({ url });
    }

    // Desconecta TODAS las cuentas Meta del usuario (limpia subcolección + flag activo)
    if (action === "disconnect" && req.method === "POST") {
      const snap = await db.collection("users").doc(uid).collection("meta_accounts").get();
      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      batch.set(db.collection("users").doc(uid), { meta_active_account: null }, { merge: true });
      await batch.commit();
      return res.json({ ok: true });
    }

    if (action === "accounts" && req.method === "GET") {
      const accounts = await listMetaAccounts(db, uid);
      const userSnap = await db.collection("users").doc(uid).get();
      const active = userSnap.data()?.meta_active_account || null;
      return res.json({ accounts: accounts.map(safeAccount), active });
    }

    // Credenciales mínimas para upload directo a Meta desde el browser.
    // Necesario porque Vercel impone hard limit de ~4.5MB en request body,
    // así que el browser sube directo a /act_{id}/adimages o /advideos via
    // FormData sin pasar por Vercel.
    // El token es de la propia cuenta del usuario — equivalente a lo que ya
    // se usa server-side.
    if (action === "upload_creds" && req.method === "GET") {
      if (!acc_id) return res.status(400).json({ error: "Falta acc_id" });
      const cfg = await loadMetaAccount(db, uid, acc_id);
      if (!cfg?.access_token || !cfg?.ad_account_id) return res.status(400).json({ error: "Cuenta sin token o ad_account_id" });
      return res.json({
        access_token: cfg.access_token,
        ad_account_id: cfg.ad_account_id,
        api_version: META_V,
      });
    }

    // Reintroseccionar las ad accounts/pages disponibles del token guardado
    // (usado cuando la cuenta Meta esta conectada pero sin ad_account_id seleccionado).
    if (action === "available_ad_accounts" && req.method === "GET") {
      if (!acc_id) return res.status(400).json({ error: "Falta acc_id" });
      const cfg = await loadMetaAccount(db, uid, acc_id);
      if (!cfg?.access_token) return res.status(400).json({ error: "Sin access_token" });
      try {
        const intros = await metaIntrospect(cfg.access_token);
        return res.json({
          ad_accounts: intros.ad_accounts || [],
          pages: intros.pages || [],
        });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // Trae TODOS los recursos accesibles por el token activo: ad accounts +
    // pixeles por ad account + pages con IG anidado. Usado por el modal
    // "Cambiar recursos" en el Publicar.
    if (action === "all_assets" && req.method === "GET") {
      if (!acc_id) return res.status(400).json({ error: "Falta acc_id" });
      const cfg = await loadMetaAccount(db, uid, acc_id);
      if (!cfg?.access_token) return res.status(400).json({ error: "Sin access_token" });
      try {
        const intros = await metaIntrospect(cfg.access_token);
        const ad_accounts = intros.ad_accounts || [];
        const pages = intros.pages || [];
        // Pixeles por ad_account (paralelo, max 30 cuentas para no explotar)
        const pixelsByAccount = {};
        await Promise.all(ad_accounts.slice(0, 30).map(async aa => {
          try {
            const px = await metaGet(`${aa.id}/adspixels`, { fields: "id,name,creation_time,last_fired_time,is_unavailable", limit: 50 }, cfg.access_token);
            pixelsByAccount[aa.id] = px.data || [];
          } catch (_) { pixelsByAccount[aa.id] = []; }
        }));
        // Aplastar pages con IG separado para que la UI lo pueda mostrar como dos tablas
        const ig_accounts = pages.filter(p => p.instagram_business_account).map(p => ({
          id: p.instagram_business_account.id,
          username: p.instagram_business_account.username,
          page_id: p.id,
          page_name: p.name,
        }));
        return res.json({
          me: intros.me,
          ad_accounts,
          pages,
          ig_accounts,
          pixels_by_account: pixelsByAccount,
          active: {
            ad_account_id: cfg.ad_account_id || null,
            page_id: cfg.page_id || null,
            ig_account_id: cfg.ig_account_id || null,
            pixel_id: cfg.pixel_id || null,
          },
        });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (action === "connect" && req.method === "POST") {
      const { access_token } = req.body || {};
      if (!access_token) return res.status(400).json({ error: "Falta access_token" });
      let intros;
      try { intros = await metaIntrospect(access_token); }
      catch (e) { return res.status(400).json({ error: `Token inválido: ${e.message}` }); }
      const me = intros.me;
      const accId = me.id;
      const existing = await loadMetaAccount(db, uid, accId) || {};
      const cfg = { ...existing, id: accId, user_id: me.id, user_name: me.name || "—", email: me.email || "",
        access_token, created_at: existing.created_at || new Date().toISOString(),
        last_test: { ok: true, ts: new Date().toISOString(), msg: "Token válido" } };
      await saveMetaAccount(db, uid, accId, cfg);
      return res.json({ ok: true, id: accId, account: safeAccount(cfg), ad_accounts: intros.ad_accounts, pages: intros.pages });
    }

    if (action === "select" && req.method === "POST") {
      if (!acc_id) return res.status(400).json({ error: "Falta acc_id" });
      const cfg = await loadMetaAccount(db, uid, acc_id);
      if (!cfg) return res.status(404).json({ error: "Cuenta no encontrada" });
      const { ad_account_id, ad_account_name, page_id, page_name, page_access_token, ig_account_id, ig_username, pixel_id, currency, timezone_name } = req.body || {};
      // Si no nos pasaron currency, intentamos pedírsela a Meta
      let resolvedCurrency = currency;
      let resolvedTz = timezone_name;
      if (ad_account_id && (!resolvedCurrency || !resolvedTz)) {
        try {
          const info = await metaGet(ad_account_id, { fields: "currency,timezone_name" }, cfg.access_token);
          if (!resolvedCurrency) resolvedCurrency = info.currency || "USD";
          if (!resolvedTz) resolvedTz = info.timezone_name || null;
        } catch (_) { if (!resolvedCurrency) resolvedCurrency = "USD"; }
      }
      const updated = { ...cfg, ad_account_id, ad_account_name, page_id, page_name, page_access_token, ig_account_id, ig_username, pixel_id, currency: resolvedCurrency || cfg.currency || "USD", timezone_name: resolvedTz || cfg.timezone_name || null };
      await saveMetaAccount(db, uid, acc_id, updated);
      await db.collection("users").doc(uid).set({ meta_active_account: acc_id }, { merge: true });
      return res.json({ ok: true, account: safeAccount(updated) });
    }

    if (action === "set_active" && req.method === "POST") {
      const { id } = req.body || {};
      await db.collection("users").doc(uid).set({ meta_active_account: id }, { merge: true });
      return res.json({ ok: true, active: id });
    }

    if (action === "delete_account" && req.method === "DELETE") {
      if (!acc_id) return res.status(400).json({ error: "Falta acc_id" });
      await metaAccountRef(db, uid, acc_id).delete();
      return res.json({ ok: true });
    }

    // ── INSIGHTS (Ads Manager dentro de Growith) ─────────
    // GET ?action=insights&acc_id=...&level=campaign|adset|ad&since=YYYY-MM-DD&until=YYYY-MM-DD
    if (action === "insights" && req.method === "GET") {
      const accIdQ = req.query.acc_id;
      if (!accIdQ) return res.status(400).json({ error: "Falta acc_id" });
      const cfg = await loadMetaAccount(db, uid, accIdQ);
      if (!cfg?.access_token) return res.status(400).json({ error: "Cuenta Meta sin token" });
      if (!cfg.ad_account_id) return res.status(400).json({ error: "Falta seleccionar ad_account_id en la cuenta" });

      const level = String(req.query.level || "campaign");
      if (!["campaign", "adset", "ad"].includes(level)) return res.status(400).json({ error: "level inválido" });

      const today = new Date().toISOString().slice(0, 10);
      const since = String(req.query.since || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
      const until = String(req.query.until || today);

      const fields = [
        "campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name",
        "spend", "impressions", "clicks", "ctr", "cpm", "cpc", "frequency", "reach",
        "actions", "action_values", "purchase_roas", "cost_per_action_type",
        "date_start", "date_stop",
      ].join(",");

      // Filtro opcional por parent (drill-down): campaign_id (para adsets) o adset_id (para ads)
      const parentId = req.query.parent_id ? String(req.query.parent_id) : null;
      const parentType = req.query.parent_type ? String(req.query.parent_type) : null; // "campaign" | "adset"
      const filteringParam = parentId && parentType
        ? JSON.stringify([{ field: `${parentType}.id`, operator: "IN", value: [parentId] }])
        : null;

      try {
        // Meta acepta time_range[since]/[until] como params separados — mas confiable
        // que JSON.stringify (que con URL-encoding agresivo a veces es ignorado y devuelve "lifetime").
        const insightsParams = {
          level,
          "time_range[since]": since,
          "time_range[until]": until,
          fields,
          limit: 500,
          // Atribucion estricta al rango (sin look-back 7d posterior)
          action_attribution_windows: JSON.stringify(["1d_click", "1d_view"]),
        };
        if (filteringParam) insightsParams.filtering = filteringParam;
        // Paginar insights — sin esto, accounts con > 500 nodos cortan los datos
        // y los nodos sobrantes caían como "sin gasto" aunque hayan gastado.
        const insightsAll = [];
        const firstInsPage = await metaGet(`${cfg.ad_account_id}/insights`, insightsParams, cfg.access_token);
        insightsAll.push(...(firstInsPage.data || []));
        let insNext = firstInsPage.paging?.next || null;
        let insSafety = 0;
        while (insNext && insSafety < 20) {
          insSafety++;
          try {
            const r = await fetch(insNext);
            const j = await r.json();
            if (!r.ok || j.error) break;
            insightsAll.push(...(j.data || []));
            insNext = j.paging?.next || null;
          } catch (_) { break; }
        }
        const data = { data: insightsAll };

        // También necesitamos el status de cada nodo (que insights no devuelve).
        // Filtrar la lista de nodos por parent si aplica.
        // OJO: NO pedir creative{} acá — con limit:500 + object_story_spec Meta
        // rechaza con "Please reduce the amount of data" y nodeMap queda vacío,
        // lo que deja todas las rows con effective_status:null y el filtro
        // "Solo activos" del front las oculta a todas (bug todos-los-ads vacíos).
        const nodeMap = {};
        const nodeFields = level === "campaign" ? "id,name,status,effective_status,objective,daily_budget,lifetime_budget"
                         : level === "adset"    ? "id,name,status,effective_status,daily_budget,lifetime_budget,campaign_id"
                         : "id,name,status,effective_status,adset_id,campaign_id";
        try {
          const nodesParams = { fields: nodeFields, limit: 200 };
          if (filteringParam) nodesParams.filtering = filteringParam;
          const edge = level === "campaign" ? "campaigns" : level === "adset" ? "adsets" : "ads";
          let nodePage = await metaGet(`${cfg.ad_account_id}/${edge}`, nodesParams, cfg.access_token);
          for (const n of (nodePage.data || [])) nodeMap[n.id] = n;
          let nNext = nodePage.paging?.next || null;
          let nSafety = 0;
          while (nNext && nSafety < 20) {
            nSafety++;
            try {
              const r = await fetch(nNext);
              const j = await r.json();
              if (!r.ok || j.error) break;
              for (const n of (j.data || [])) nodeMap[n.id] = n;
              nNext = j.paging?.next || null;
            } catch (_) { break; }
          }
        } catch (e) { /* seguimos sin status */ }

        const rows = (data.data || []).map(r => {
          const idField = level === "campaign" ? "campaign_id" : level === "adset" ? "adset_id" : "ad_id";
          const id = r[idField];
          const node = nodeMap[id] || {};
          const purchases = (r.actions || []).find(a => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase");
          const purchaseValue = (r.action_values || []).find(a => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase");
          const cpaPurchase = (r.cost_per_action_type || []).find(a => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase");
          return {
            id,
            name: r[level + "_name"] || node.name || "",
            status: node.status || null,
            effective_status: node.effective_status || null,
            campaign_id: r.campaign_id,
            adset_id: r.adset_id,
            ad_id: r.ad_id,
            spend: parseFloat(r.spend) || 0,
            impressions: parseInt(r.impressions) || 0,
            clicks: parseInt(r.clicks) || 0,
            ctr: parseFloat(r.ctr) || 0,
            cpm: parseFloat(r.cpm) || 0,
            cpc: parseFloat(r.cpc) || 0,
            frequency: parseFloat(r.frequency) || 0,
            reach: parseInt(r.reach) || 0,
            purchases: parseInt(purchases?.value) || 0,
            purchase_value: parseFloat(purchaseValue?.value) || 0,
            roas: parseFloat((r.purchase_roas || [])[0]?.value) || 0,
            cpa: parseFloat(cpaPurchase?.value) || 0,
            daily_budget: node.daily_budget ? parseFloat(node.daily_budget) / 100 : null,
            objective: node.objective || null,
            creative: node.creative || null,
          };
        });

        // Sumar nodos sin gasto (que no aparecen en insights pero existen)
        for (const id in nodeMap) {
          if (!rows.find(r => r.id === id)) {
            const n = nodeMap[id];
            rows.push({
              id, name: n.name || "", status: n.status, effective_status: n.effective_status,
              spend: 0, impressions: 0, clicks: 0, ctr: 0, cpm: 0, cpc: 0, frequency: 0, reach: 0,
              purchases: 0, purchase_value: 0, roas: 0, cpa: 0,
              daily_budget: n.daily_budget ? parseFloat(n.daily_budget) / 100 : null,
              objective: n.objective || null,
              creative: n.creative || null,
              campaign_id: n.campaign_id, adset_id: n.adset_id,
            });
          }
        }

        return res.json({ rows, since, until, level });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // ── BIBLIOTECA DE ANUNCIOS (con creative + insights 7d + análisis IA cacheado) ──
    if (action === "ads_library" && req.method === "GET") {
      const accIdQ = req.query.acc_id;
      if (!accIdQ) return res.status(400).json({ error: "Falta acc_id" });
      const cfg = await loadMetaAccount(db, uid, accIdQ);
      if (!cfg?.access_token) return res.status(400).json({ error: "Cuenta Meta sin token" });
      if (!cfg.ad_account_id) return res.status(400).json({ error: "Falta seleccionar ad_account_id" });

      // Aceptar rango de fechas (default últimos 7 días)
      const since = String(req.query.since || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
      const until = String(req.query.until || new Date().toISOString().slice(0, 10));

      // ── Cache de la respuesta completa (TTL 2 min) por (uid, acc_id, rango).
      // Antes la Biblioteca tardaba +60s en cargar porque hace pagineo de /ads +
      // un metaGet por cada video. Con este cache, abrir/refrescar dentro de los
      // 2 min siguientes es instantáneo. Botón "🔄" del front pasa fresh=1 para
      // saltearlo cuando el user quiere data nueva sí o sí.
      // v2: bump cuando cambie shape del payload o cuando queramos invalidar caches viejos
      const libCacheKey = `libv4_${String(accIdQ).replace(/[^a-zA-Z0-9_]/g,"_")}_${since}_${until}`;
      const libCacheRef = db.collection("users").doc(uid).collection("meta_lib_cache").doc(libCacheKey);
      const LIB_CACHE_TTL_MS = 2 * 60 * 1000;
      const forceFresh = req.query.fresh === "1";
      if (!forceFresh) {
        try {
          const snap = await libCacheRef.get();
          if (snap.exists) {
            const c = snap.data();
            if (c.ts && (Date.now() - c.ts) < LIB_CACHE_TTL_MS && c.payload) {
              return res.json({ ...c.payload, _cached: true, _cache_age_ms: Date.now() - c.ts });
            }
          }
        } catch (_) { /* sigue al fetch real */ }
      }

      const _t0 = Date.now();
      const _timings = {};
      try {
        // 1) Ads — fields ULTRA reducidos. Antes el endpoint pedía object_story_spec
        // COMPLETO + asset_feed_spec, que serializaba muchísimos KB por página (Meta
        // tarda más cuando los objetos anidados son grandes). Ahora solo pedimos los
        // campos que la card realmente renderiza. Para detalle completo del creative
        // (description, link, cta) el front llama lazy si es necesario (AI analyzer).
        const ads = [];
        let nextUrl = null;
        // image_url restituido — es solo URL string (no binario), peso despreciable.
        // Sin él las cards salían pixeladas porque thumbnail_url es 128×128. Lo que
        // SÍ era pesado y dejamos afuera es object_story_spec + asset_feed_spec.
        // Cap hard de 200 ads (4 páginas) sigue vigente — el front pagina de 30.
        let page = await metaGet(`${cfg.ad_account_id}/ads`, {
          fields: "id,name,status,effective_status,adset_id,campaign_id,creative{id,name,thumbnail_url,image_url,video_id,object_type,body,title}",
          limit: 50,
        }, cfg.access_token);
        ads.push(...(page.data || []));
        nextUrl = page.paging?.next || null;
        let safety = 0;
        while (nextUrl && safety < 4 && ads.length < 200) {
          safety++;
          try {
            const r = await fetch(nextUrl);
            const j = await r.json();
            if (!r.ok || j.error) break;
            ads.push(...(j.data || []));
            nextUrl = j.paging?.next || null;
          } catch (_) { break; }
        }
        _timings.ads_fetch_ms = Date.now() - _t0;
        _timings.ads_count = ads.length;

        // 1.b) Para los ads que tienen video_id, resolver el MP4 source + thumbnail HD.
        // Garantizamos que SIEMPRE haya un fallback reproducible:
        //   1° intento: metaGet con cfg.access_token (System User Token).
        //   2° intento: si falla o no devolvió source/embed_html/permalink, reintento con
        //               cfg.page_access_token (cuando exista) — algunos videos sólo son
        //               legibles desde el token de la página dueña.
        //   3° fallback: aunque ambos fallen, construimos un permalink sintético
        //               (facebook.com/watch/?v=VIDEO_ID) que el iframe embed sabe abrir.
        //   El front, además, elige entre <video src>, embed_html, e iframe permalink.
        // ── Videos: NO hacemos lookup a Meta acá (era el cuello de botella +60s).
        // Para cada video_id devolvemos un permalink sintético (facebook.com/watch/?v=<id>)
        // que el iframe embed reproduce bien para cualquier ad video público. Si el user
        // hace click en ▶ y queremos el MP4 directo, el front llama al endpoint nuevo
        // ?action=video_source que sí hace el lookup (con cache permanente).
        const videoIds = [...new Set(ads.map(a => a.creative?.video_id).filter(Boolean))];
        const videoSources = {};
        // Aprovechamos lo que ya esté cacheado en Firestore (sin hacer Meta calls).
        const videoCacheCol = db.collection("users").doc(uid).collection("meta_video_cache");
        if (videoIds.length > 0) {
          await Promise.all(videoIds.slice(0, 200).map(async vid => {
            try {
              const snap = await videoCacheCol.doc(String(vid)).get();
              if (snap.exists && snap.data()?.data) {
                videoSources[vid] = snap.data().data;
              }
            } catch (_) {}
            // Si no estaba cacheado, dejamos un placeholder con permalink sintético —
            // el front puede llamar video_source on-demand si quiere upgrade a MP4.
            if (!videoSources[vid]) {
              videoSources[vid] = {
                source: null,
                picture: null,
                permalink: `https://www.facebook.com/watch/?v=${vid}`,
                embed_html: null,
                embeddable: true,
              };
            }
          }));
        }

        // 2) Insights del rango por ad — y análisis en paralelo (independientes)
        const _tIns = Date.now();
        const [insightsRes, analysesSnap] = await Promise.all([
          metaGet(`${cfg.ad_account_id}/insights`, {
            level: "ad",
            "time_range[since]": since,
            "time_range[until]": until,
            action_attribution_windows: JSON.stringify(["1d_click", "1d_view"]),
            fields: "ad_id,spend,impressions,clicks,ctr,cpm,cpc,frequency,reach,actions,action_values,purchase_roas,cost_per_action_type",
            limit: 500,
          }, cfg.access_token).catch(e => { console.warn("[ads_library] insights fail:", e.message); return { data: [] }; }),
          db.collection("users").doc(uid).collection("meta_ad_analyses").get(),
        ]);
        const insightsRows = insightsRes.data || [];
        _timings.insights_ms = Date.now() - _tIns;
        const cachedAnalyses = {};
        analysesSnap.docs.forEach(d => { cachedAnalyses[d.id] = d.data(); });

        // 4) Mergear todo
        const result = ads.map(ad => {
          const ins = insightsRows.find(i => i.ad_id === ad.id) || {};
          const purchases = (ins.actions || []).find(a => /purchase/.test(a.action_type || ""));
          const purchaseValue = (ins.action_values || []).find(a => /purchase/.test(a.action_type || ""));
          const cpaPurchase = (ins.cost_per_action_type || []).find(a => /purchase/.test(a.action_type || ""));
          const creative = ad.creative || {};
          const oss = creative.object_story_spec || {};
          const linkData = oss.link_data || oss.video_data || {};
          const vidInfo = creative.video_id ? videoSources[creative.video_id] : null;
          return {
            id: ad.id,
            name: ad.name,
            status: ad.status,
            effective_status: ad.effective_status,
            campaign_id: ad.campaign_id,
            adset_id: ad.adset_id,
            // Imagen HD (image_url) + thumbnail como fallback.
            // Para videos sin image_url, usamos /<vid>/picture?type=large — Meta CDN
            // sirve el thumb HD del video directamente sin pasar por la API.
            creative_thumbnail: creative.image_url || creative.thumbnail_url || vidInfo?.picture || (creative.video_id ? `https://graph.facebook.com/${creative.video_id}/picture?type=large` : null),
            creative_image_hd: creative.image_url || vidInfo?.picture || (creative.video_id ? `https://graph.facebook.com/${creative.video_id}/picture?type=large` : null) || creative.thumbnail_url,
            // Video reproducible si existe.
            // Tres fuentes posibles: MP4 source directo (poco frecuente), embed_html
            // (iframe HTML de Meta) o permalink (URL del post para armar embed propio).
            creative_video_url: vidInfo?.source || null,
            creative_video_id: creative.video_id || null,
            creative_video_embed_html: vidInfo?.embed_html || null,
            creative_video_embeddable: vidInfo?.embeddable !== false,
            creative_permalink: vidInfo?.permalink || null,
            creative_body: creative.body || linkData.message || "",
            creative_title: creative.title || linkData.name || "",
            creative_description: linkData.description || "",
            creative_link: linkData.link || "",
            creative_cta: linkData.call_to_action?.type || "",
            creative_type: creative.video_id ? "video" : (creative.object_type || "image"),
            spend: parseFloat(ins.spend) || 0,
            impressions: parseInt(ins.impressions) || 0,
            clicks: parseInt(ins.clicks) || 0,
            ctr: parseFloat(ins.ctr) || 0,
            cpm: parseFloat(ins.cpm) || 0,
            cpc: parseFloat(ins.cpc) || 0,
            reach: parseInt(ins.reach) || 0,
            frequency: parseFloat(ins.frequency) || 0,
            purchases: parseInt(purchases?.value) || 0,
            purchase_value: parseFloat(purchaseValue?.value) || 0,
            roas: parseFloat((ins.purchase_roas || [])[0]?.value) || 0,
            cpa: parseFloat(cpaPurchase?.value) || 0,
            analysis: cachedAnalyses[ad.id]?.analysis || null,
            analyzed_at: cachedAnalyses[ad.id]?.analyzed_at || null,
          };
        });

        _timings.total_ms = Date.now() - _t0;
        const payload = { ads: result, since, until, _timings };
        // Persistir el response — el próximo load (dentro de 2 min) sale instant.
        try { await libCacheRef.set({ payload, ts: Date.now() }, { merge: true }); }
        catch (_) {}
        return res.json(payload);
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // ── LAZY: traer source/embed_html de UN video on-demand al hacer click ▶
    // Permite mantener la Biblioteca rápida sin perder MP4 directo cuando el
    // user efectivamente quiere reproducir. Cache permanente por video_id.
    if (action === "video_source" && req.method === "GET") {
      const accIdQ = req.query.acc_id;
      const videoId = String(req.query.video_id || "");
      if (!accIdQ || !videoId) return res.status(400).json({ error: "Falta acc_id o video_id" });
      const cfg = await loadMetaAccount(db, uid, accIdQ);
      if (!cfg?.access_token) return res.status(400).json({ error: "Cuenta Meta sin token" });

      const cacheRef = db.collection("users").doc(uid).collection("meta_video_cache").doc(videoId);
      // ¿Ya cacheado con datos útiles?
      try {
        const snap = await cacheRef.get();
        if (snap.exists) {
          const c = snap.data();
          if (c.data && (c.data.source || c.data.embed_html)) {
            return res.json({ ...c.data, _cached: true });
          }
        }
      } catch (_) {}

      // Resolver desde Meta
      let v = {};
      let thumbs = { data: [] };
      try {
        const [v1, t1] = await Promise.all([
          metaGet(videoId, { fields: "source,picture,permalink_url,embed_html,embeddable" }, cfg.access_token),
          metaGet(`${videoId}/thumbnails`, { fields: "uri,is_preferred,height,width", limit: 20 }, cfg.access_token).catch(() => ({ data: [] })),
        ]);
        v = v1 || {};
        thumbs = t1 || { data: [] };
      } catch (_) { /* sigue con page token */ }
      if (!v.source && !v.embed_html && cfg.page_access_token) {
        try {
          const [v2, t2] = await Promise.all([
            metaGet(videoId, { fields: "source,picture,permalink_url,embed_html,embeddable" }, cfg.page_access_token),
            metaGet(`${videoId}/thumbnails`, { fields: "uri,is_preferred,height,width", limit: 20 }, cfg.page_access_token).catch(() => ({ data: [] })),
          ]);
          if (v2) v = { ...v, ...v2 };
          if (t2?.data?.length) thumbs = t2;
        } catch (_) {}
      }
      let bestThumb = null;
      const ts = Array.isArray(thumbs.data) ? thumbs.data : [];
      if (ts.length > 0) {
        const sized = ts.filter(t => t.uri).map(t => ({ ...t, area: (t.width || 0) * (t.height || 0) }));
        sized.sort((a, b) => b.area - a.area);
        bestThumb = sized[0]?.uri || ts.find(t => t.is_preferred)?.uri || ts[0]?.uri || null;
      }
      const data = {
        source: v.source || null,
        picture: bestThumb || v.picture || null,
        permalink: v.permalink_url || `https://www.facebook.com/watch/?v=${videoId}`,
        embed_html: v.embed_html || null,
        embeddable: v.embeddable !== false,
      };
      try { await cacheRef.set({ data, ts: Date.now() }, { merge: true }); } catch (_) {}
      return res.json(data);
    }

    // ── ANALIZAR UN AD CON GEMINI (cachea en Firestore) ──
    if (action === "analyze_ad" && req.method === "POST") {
      const { ad } = req.body || {};
      if (!ad?.id) return res.status(400).json({ error: "Falta ad.id" });
      try {
        const analysis = await geminiAnalyzeAd({
          name: ad.name,
          headline: ad.creative_title,
          body: ad.creative_body,
          description: ad.creative_description,
          cta: ad.creative_cta,
          link_url: ad.creative_link,
          creative_type: ad.creative_type,
          spend: ad.spend,
          impressions: ad.impressions,
          clicks: ad.clicks,
          ctr: ad.ctr,
          cpm: ad.cpm,
          frequency: ad.frequency,
          purchases: ad.purchases,
          purchase_value: ad.purchase_value,
          roas: ad.roas,
          cpa: ad.cpa,
        });
        await db.collection("users").doc(uid).collection("meta_ad_analyses").doc(String(ad.id))
          .set({ ad_id: ad.id, analysis, analyzed_at: new Date().toISOString() }, { merge: true });
        return res.json({ ok: true, analysis });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // ── REGLAS (Fase 3 optimizador) ──────────────────────

    if (action === "rules_list" && req.method === "GET") {
      const accIdQ = req.query.acc_id;
      if (!accIdQ) return res.status(400).json({ error: "Falta acc_id" });
      const snap = await db.collection("users").doc(uid).collection("meta_rules")
        .where("acc_id", "==", accIdQ).get();
      const rules = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      rules.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
      return res.json({ rules });
    }

    if (action === "rule_save" && req.method === "POST") {
      const { rule } = req.body || {};
      if (!rule?.name || !rule?.level || !rule?.acc_id) return res.status(400).json({ error: "Faltan campos en la regla (name, level, acc_id)" });
      if (!Array.isArray(rule.conditions) || rule.conditions.length === 0) return res.status(400).json({ error: "La regla necesita al menos 1 condición" });

      const col = db.collection("users").doc(uid).collection("meta_rules");
      const ruleId = rule.id || col.doc().id;
      const data = {
        name: String(rule.name).slice(0, 80),
        level: rule.level,
        logic: rule.logic === "OR" ? "OR" : "AND",
        conditions: rule.conditions.map(c => ({
          metric: c.metric,
          op: c.op,
          value: parseFloat(c.value) || 0,
          window_days: parseInt(c.window_days) || 7,
        })),
        action: ["pause", "notify", "reduce_budget"].includes(rule.action) ? rule.action : "pause",
        action_pct: rule.action === "reduce_budget" ? (parseFloat(rule.action_pct) || 20) : null,
        // Productos a los que se aplica esta regla (URL match). [] o ausente = todos los productos / cualquier ad.
        product_ids: Array.isArray(rule.product_ids) ? rule.product_ids.filter(Boolean) : [],
        active: rule.active !== false,
        acc_id: rule.acc_id,
        updated_at: new Date().toISOString(),
        ...(rule.id ? {} : { created_at: new Date().toISOString() }),
      };
      await col.doc(ruleId).set(data, { merge: true });
      return res.json({ ok: true, id: ruleId, rule: { id: ruleId, ...data } });
    }

    // ── PRODUCTOS (clasificador URL → producto con roas BE propio) ─────
    // Estructura: users/{uid}/meta_products/{id}
    //   { name, urls: string[], roas_be: number, acc_id, created_at, updated_at }

    if (action === "products_list" && req.method === "GET") {
      const accIdQ = req.query.acc_id;
      if (!accIdQ) return res.status(400).json({ error: "Falta acc_id" });
      const snap = await db.collection("users").doc(uid).collection("meta_products")
        .where("acc_id", "==", accIdQ).get();
      const products = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      products.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      return res.json({ products });
    }

    if (action === "product_save" && req.method === "POST") {
      const { product } = req.body || {};
      if (!product?.name?.trim()) return res.status(400).json({ error: "Falta nombre del producto" });
      if (!product?.acc_id) return res.status(400).json({ error: "Falta acc_id" });
      const cleanUrls = (Array.isArray(product.urls) ? product.urls : [])
        .map(u => String(u || "").trim())
        .filter(u => u && /^https?:\/\//i.test(u));
      const col = db.collection("users").doc(uid).collection("meta_products");
      const productId = product.id || col.doc().id;
      const data = {
        name: String(product.name).trim().slice(0, 80),
        urls: cleanUrls,
        roas_be: parseFloat(product.roas_be) || 0,
        acc_id: product.acc_id,
        updated_at: new Date().toISOString(),
        ...(product.id ? {} : { created_at: new Date().toISOString() }),
      };
      await col.doc(productId).set(data, { merge: true });
      return res.json({ ok: true, id: productId, product: { id: productId, ...data } });
    }

    if (action === "product_delete" && req.method === "DELETE") {
      const { product_id } = req.query;
      if (!product_id) return res.status(400).json({ error: "Falta product_id" });
      await db.collection("users").doc(uid).collection("meta_products").doc(String(product_id)).delete();
      return res.json({ ok: true });
    }

    // Debug: trae TODA la data de un ad para diagnosticar por que su URL no
    // se esta detectando. Pega el ad_id y devuelve la respuesta cruda de Meta
    // mas el intento de extraer link en cada estrategia.
    if (action === "debug_ad" && req.method === "GET") {
      const accIdQ = req.query.acc_id || acc_id;
      const adId = req.query.ad_id;
      if (!accIdQ || !adId) return res.status(400).json({ error: "Faltan acc_id y ad_id" });
      const cfg = await loadMetaAccount(db, uid, accIdQ);
      if (!cfg?.access_token) return res.status(400).json({ error: "Sin token" });
      const out = { ad_id: adId };
      try {
        out.ad = await metaGet(adId, {
          fields: "id,name,adset_id,campaign_id,status,effective_status,creative{id,link_url,object_story_spec,asset_feed_spec,template_url,effective_object_story_id,object_story_id,instagram_permalink_url,image_url,thumbnail_url}",
        }, cfg.access_token);
        const cr = out.ad?.creative || {};
        out.derived = {
          link_url_direct: cr.link_url || null,
          template_url: cr.template_url || null,
          oss_link_data_link: cr.object_story_spec?.link_data?.link || null,
          oss_video_data_link: cr.object_story_spec?.video_data?.call_to_action?.value?.link || null,
          oss_template_data_link: cr.object_story_spec?.template_data?.link || null,
          oss_photo_data_url: cr.object_story_spec?.photo_data?.url || null,
          afs_link_urls: cr.asset_feed_spec?.link_urls || null,
          effective_object_story_id: cr.effective_object_story_id || null,
          object_story_id: cr.object_story_id || null,
        };
        // Si tiene post id, fetchearlo
        const pid = cr.effective_object_story_id || cr.object_story_id;
        if (pid) {
          try {
            out.post = await metaGet(pid, {
              fields: "attachments{target,url,unshimmed_url,subattachments,type,title,description,media},link,call_to_action,message,permalink_url",
            }, cfg.access_token);
          } catch (e) { out.post_error_user_token = e.message; }
          if (cfg.page_access_token && cfg.page_access_token !== cfg.access_token) {
            try {
              out.post_via_page_token = await metaGet(pid, {
                fields: "attachments{target,url,unshimmed_url,subattachments,type,title,description,media},link,call_to_action,message,permalink_url",
              }, cfg.page_access_token);
            } catch (e) { out.post_error_page_token = e.message; }
          }
        }
        // Tambien probar previews
        try {
          const previewRes = await metaGet(`${adId}/previews`, { ad_format: "MOBILE_FEED_STANDARD" }, cfg.access_token);
          out.preview_html_snippet = (previewRes.data?.[0]?.body || "").slice(0, 800);
        } catch (e) { out.preview_error = e.message; }
      } catch (e) {
        return res.status(500).json({ error: e.message, partial: out });
      }
      return res.json(out);
    }

    // Mapa de ads → product_ids (URL matching) — usado por Analisis para
    // calcular el BE efectivo por row. Devuelve tambien mapas agregados
    // por adset y campaign (union de product_ids).
    if (action === "ad_products_map" && req.method === "GET") {
      const accIdQ = req.query.acc_id || acc_id;
      if (!accIdQ) return res.status(400).json({ error: "Falta acc_id" });
      const cfg = await loadMetaAccount(db, uid, accIdQ);
      if (!cfg?.access_token || !cfg?.ad_account_id) return res.status(400).json({ error: "Cuenta sin token o ad_account_id" });

      // Cargar productos
      const prodSnap = await db.collection("users").doc(uid).collection("meta_products")
        .where("acc_id", "==", accIdQ).get();
      const productsArr = prodSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (productsArr.length === 0) {
        return res.json({ products: [], ad: {}, adset: {}, campaign: {} });
      }

      // Pre-fetch ads con sus URLs de destino — paginar hasta 5000 ads
      let ads = [];
      try {
        let nextUrl = null;
        const baseParams = {
          limit: 500,
          fields: "id,adset_id,campaign_id,creative{id,link_url,object_story_spec,asset_feed_spec,template_url,instagram_permalink_url,effective_object_story_id,object_story_id}",
        };
        let page = await metaGet(`${cfg.ad_account_id}/ads`, baseParams, cfg.access_token);
        ads.push(...(page.data || []));
        nextUrl = page.paging?.next || null;
        let safety = 0;
        while (nextUrl && safety < 10) {
          safety++;
          const r = await fetch(nextUrl);
          const j = await r.json();
          if (!r.ok || j.error) break;
          ads.push(...(j.data || []));
          nextUrl = j.paging?.next || null;
        }
      } catch (e) {
        return res.status(502).json({ error: `No se pudieron traer los ads para mapear: ${e.message}` });
      }

      const linkOfAdCreative = (ad) => {
        const cr = ad.creative || {};
        if (cr.link_url) return cr.link_url;
        if (cr.template_url) return cr.template_url;
        const oss = cr.object_story_spec || {};
        const link = oss.link_data?.link
          || oss.video_data?.call_to_action?.value?.link
          || oss.video_data?.call_to_action?.value?.link_url
          || oss.template_data?.link
          || oss.photo_data?.url
          || null;
        if (link) return link;
        const afs = cr.asset_feed_spec || {};
        if (Array.isArray(afs.link_urls)) {
          for (const lu of afs.link_urls) {
            if (lu?.website_url) return lu.website_url;
            if (lu?.url) return lu.url;
          }
        }
        return null;
      };
      const extractLinkFromPost = (post) => {
        if (!post) return null;
        // 1) post-level link (typical de link posts)
        if (post.link) return post.link;
        // 2) post-level CTA value
        const cta = post.call_to_action;
        if (cta?.value?.link) return cta.value.link;
        if (cta?.value?.link_url) return cta.value.link_url;
        // 3) attachments
        const atts = post.attachments?.data || [];
        for (const att of atts) {
          if (att.target?.url) return att.target.url;
          if (att.url) return att.url;
          if (att.unshimmed_url) return att.unshimmed_url;
          const subs = att.subattachments?.data || [];
          for (const sub of subs) {
            if (sub.target?.url) return sub.target.url;
            if (sub.url) return sub.url;
            if (sub.unshimmed_url) return sub.unshimmed_url;
          }
        }
        // 4) URL en el mensaje del post (regex como ultimo recurso)
        if (post.message) {
          const m = post.message.match(/https?:\/\/[^\s"'<>)]+/i);
          if (m) return m[0];
        }
        return null;
      };
      // Para ads que usan post existente, fetcheamos el post individualmente.
      // Probamos AMBOS post_ids: effective_object_story_id (que ve el ad como
      // post desde la pagina) Y object_story_id (legacy / original id).
      const postIdOfAd = (a) => a.creative?.effective_object_story_id || a.creative?.object_story_id || null;
      const adsWithPostNoLink = ads.filter(a => !linkOfAdCreative(a) && postIdOfAd(a));
      const postIds = [...new Set(adsWithPostNoLink.map(postIdOfAd))];
      const postLinks = {};
      const postErrors = [];
      const postRawSamples = []; // primeros 3 raw responses para diagnostico
      // Helper: probar VARIAS estrategias para sacar el link del post.
      // Incluye fallback para posts IG (que no tienen attachments tradicionales).
      const extractLinkAnywhere = (obj) => {
        const link = extractLinkFromPost(obj);
        if (link) return link;
        // IG-specific: caption a veces tiene la URL
        if (obj.caption) {
          const m = String(obj.caption).match(/https?:\/\/[^\s"'<>)]+/i);
          if (m) return m[0];
        }
        // Story-spec inline link
        if (obj.story_attachment_style && obj.story?.link) return obj.story.link;
        return null;
      };
      const fetchOnePost = async (pid, token) => {
        // Estrategia 1: pedir attachments sin subfields explicitos
        try {
          const obj = await metaGet(pid, { fields: "attachments,link,call_to_action,message,permalink_url,caption,source,picture" }, token);
          if (postRawSamples.length < 3) postRawSamples.push({ pid, keys: Object.keys(obj), att_count: obj.attachments?.data?.length || 0 });
          const link = extractLinkAnywhere(obj);
          if (link) return { pid, link };
        } catch (e) {
          postErrors.push(`${pid} (intento 1): ${e.message}`);
        }
        // Estrategia 2: con subfields explicitos via {} syntax
        try {
          const obj = await metaGet(pid, { fields: "attachments{target,url,unshimmed_url,subattachments{target,url,unshimmed_url},type,title,description,media,description_tags},link,message,caption" }, token);
          const link = extractLinkAnywhere(obj);
          if (link) return { pid, link };
        } catch (e) {
          postErrors.push(`${pid} (intento 2): ${e.message}`);
        }
        // Estrategia 3: IG media direct (algunos post_ids son IG-only, vienen
        // como {ig_user_id}_{media_id} o solo media_id) — pedimos campos IG.
        const igCandidate = pid.includes("_") ? pid.split("_")[1] : pid;
        try {
          const obj = await metaGet(igCandidate, { fields: "caption,permalink,media_type,media_url,thumbnail_url" }, token);
          const link = extractLinkAnywhere(obj);
          if (link) return { pid, link };
        } catch (e) {
          postErrors.push(`${pid} (IG intento 3): ${e.message}`);
        }
        return { pid, link: null };
      };
      // Parallel en lotes de 8 (cuidamos rate limit)
      for (let i = 0; i < postIds.length; i += 8) {
        const chunk = postIds.slice(i, i + 8);
        const results = await Promise.all(chunk.map(pid => fetchOnePost(pid, cfg.access_token)));
        for (const r of results) { if (r.link) postLinks[r.pid] = r.link; }
        // Retry con page_access_token los que fallaron (page-owned posts requieren el page token)
        if (cfg.page_access_token && cfg.page_access_token !== cfg.access_token) {
          const stillMissing = chunk.filter(pid => !postLinks[pid]);
          if (stillMissing.length) {
            const retries = await Promise.all(stillMissing.map(pid => fetchOnePost(pid, cfg.page_access_token)));
            for (const r of retries) { if (r.link) postLinks[r.pid] = r.link; }
          }
        }
      }
      // Para los ads que SIGUEN sin link, fetchear el creative directamente
      // (a veces /ads?fields=creative{...} omite campos que el endpoint
      // del creative directo si devuelve).
      const adsStillNoLink = ads.filter(a => !linkOfAdCreative(a) && !(a.creative?.effective_object_story_id && postLinks[a.creative.effective_object_story_id]));
      const creativeIds = [...new Set(adsStillNoLink.map(a => a.creative?.id).filter(Boolean))];
      const creativeLinks = {}; // creative_id → link
      for (let i = 0; i < creativeIds.length; i += 50) {
        const chunk = creativeIds.slice(i, i + 50);
        try {
          const params = new URLSearchParams({ ids: chunk.join(","), fields: "link_url,template_url,object_story_spec{link_data{link},video_data{call_to_action{value{link,link_url}}},template_data{link},photo_data{url}},asset_feed_spec{link_urls}", access_token: cfg.access_token });
          const r = await fetch(`${META_BASE}/?${params}`);
          const j = await r.json();
          if (r.ok && !j.error && typeof j === "object") {
            for (const [cid, cr] of Object.entries(j)) {
              const fakeAd = { creative: cr };
              const link = linkOfAdCreative(fakeAd);
              if (link) creativeLinks[cid] = link;
            }
          }
        } catch (_) {}
      }
      const linkOfAd = (ad) => {
        const direct = linkOfAdCreative(ad);
        if (direct) return direct;
        const pid = postIdOfAd(ad);
        if (pid && postLinks[pid]) return postLinks[pid];
        const cid = ad.creative?.id;
        if (cid && creativeLinks[cid]) return creativeLinks[cid];
        return null;
      };
      // Normaliza URL para comparar: minusculas, sin protocolo, sin www,
      // sin trailing slash, sin query string, sin hash, sin "/?" final.
      const norm = (u) => {
        let s = String(u || "").trim().toLowerCase();
        s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
        s = s.split("#")[0].split("?")[0];
        s = s.replace(/\/+$/, "");
        return s;
      };
      const productsByPrefix = [];
      for (const p of productsArr) {
        for (const u of (p.urls || [])) {
          const n = norm(u);
          if (n) productsByPrefix.push({ prefix: n, id: p.id });
        }
      }
      productsByPrefix.sort((a, b) => b.prefix.length - a.prefix.length);
      const productIdsForUrl = (url) => {
        if (!url) return [];
        const n = norm(url);
        if (!n) return [];
        const matches = new Set();
        for (const { prefix, id } of productsByPrefix) {
          if (!prefix) continue;
          if (n === prefix || n.startsWith(prefix + "/")) matches.add(id);
        }
        return [...matches];
      };
      const adMap = {};       // ad_id → product_ids[]
      const adsetMap = {};    // adset_id → Set of product_ids
      const campMap = {};     // campaign_id → Set
      for (const ad of ads) {
        const link = linkOfAd(ad);
        const pids = productIdsForUrl(link);
        if (pids.length === 0) continue;
        adMap[ad.id] = pids;
        if (ad.adset_id) {
          const s = adsetMap[ad.adset_id] || new Set();
          pids.forEach(p => s.add(p));
          adsetMap[ad.adset_id] = s;
        }
        if (ad.campaign_id) {
          const s = campMap[ad.campaign_id] || new Set();
          pids.forEach(p => s.add(p));
          campMap[ad.campaign_id] = s;
        }
      }
      // Aplastar Sets a arrays para JSON
      const adsetOut = Object.fromEntries(Object.entries(adsetMap).map(([k, v]) => [k, [...v]]));
      const campOut = Object.fromEntries(Object.entries(campMap).map(([k, v]) => [k, [...v]]));
      // Diagnostico para entender que pasa con los ads en blanco
      const unmatchedAds = ads.filter(a => !linkOfAd(a)).slice(0, 20).map(a => ({
        id: a.id,
        has_creative: Boolean(a.creative),
        has_link_url: Boolean(a.creative?.link_url),
        has_oss: Boolean(a.creative?.object_story_spec),
        has_post_id: Boolean(a.creative?.effective_object_story_id),
        post_id: a.creative?.effective_object_story_id || null,
        creative_id: a.creative?.id || null,
      }));
      const linkedAds = ads.filter(a => linkOfAd(a)).length;
      return res.json({
        products: productsArr.map(p => ({ id: p.id, name: p.name, roas_be: p.roas_be || 0 })),
        ad: adMap,
        adset: adsetOut,
        campaign: campOut,
        _debug: {
          total_ads: ads.length,
          linked_ads: linkedAds,
          unlinked_ads: ads.length - linkedAds,
          post_ids_attempted: postIds.length,
          post_links_resolved: Object.keys(postLinks).length,
          creative_links_resolved: Object.keys(creativeLinks).length,
          post_errors_sample: postErrors.slice(0, 5),
          post_raw_samples: postRawSamples,
          unmatched_sample: unmatchedAds,
          has_page_token: Boolean(cfg.page_access_token),
        },
      });
    }

    // ── HISTORIAL DE LOTES PUBLICADOS ──
    // Guarda cada batch del bulk publish + permite listar los recientes.

    if (action === "publish_batch_save" && req.method === "POST") {
      const { items, dest_mode, dest, errors } = req.body || {};
      if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "Faltan items en el batch" });
      const accIdQ = acc_id || req.query.acc_id;
      const ref = db.collection("users").doc(uid).collection("meta_publish_batches").doc();
      const data = {
        acc_id: accIdQ || null,
        ts: new Date().toISOString(),
        dest_mode: dest_mode || "shared",
        dest: dest || null,
        items: items.map(i => ({
          ad_id: i.ad_id || null,
          ig_status: i.ig_status || null,
          filename: i.filename || "",
          kind: i.kind || "image",
          status: i.status || "PAUSED",
          ok: i.ok !== false,
          error: i.error || null,
          creative_id: i.creative_id || null,
        })),
        errors: Array.isArray(errors) ? errors : [],
        total: items.length,
        ok_count: items.filter(i => i.ok !== false).length,
      };
      await ref.set(data);
      return res.json({ ok: true, id: ref.id, batch: { id: ref.id, ...data } });
    }

    if (action === "publish_batches_list" && req.method === "GET") {
      const accIdQ = req.query.acc_id;
      if (!accIdQ) return res.status(400).json({ error: "Falta acc_id" });
      const snap = await db.collection("users").doc(uid).collection("meta_publish_batches")
        .where("acc_id", "==", accIdQ).get();
      const batches = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.ts || "").localeCompare(a.ts || ""))
        .slice(0, 30);
      return res.json({ batches });
    }

    if (action === "rule_delete" && req.method === "DELETE") {
      const { rule_id } = req.query;
      if (!rule_id) return res.status(400).json({ error: "Falta rule_id" });
      await db.collection("users").doc(uid).collection("meta_rules").doc(String(rule_id)).delete();
      return res.json({ ok: true });
    }

    if (action === "rule_log" && req.method === "GET") {
      const snap = await db.collection("users").doc(uid).collection("meta_rule_log").get();
      const log = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.ts || "").localeCompare(a.ts || ""))
        .slice(0, 100);
      return res.json({ log });
    }

    // Evaluar reglas ahora (manualmente desde la UI)
    // Acepta force_window_days en body o query — override de la window de cada condition.
    // Sirve para "Reprocesar últimos N días" desde la UI.
    if (action === "evaluate_rules" && req.method === "POST") {
      const accIdQ = acc_id || req.query.acc_id;
      if (!accIdQ) return res.status(400).json({ error: "Falta acc_id" });
      const force = req.body?.force_window_days ?? req.query.force_window_days;
      const result = await evaluateRulesForAccount(db, uid, accIdQ, force ? { force_window_days: force } : {});
      return res.json(result);
    }

    // ── REDUCE BUDGET (bajar % del presupuesto de un node) ──
    // POST { node_id, pct } (pct = % a reducir, ej 20 = bajar 20%)
    if (action === "reduce_budget" && req.method === "POST") {
      const { node_id, pct } = req.body || {};
      if (!node_id || !pct) return res.status(400).json({ error: "Faltan node_id o pct" });
      const pctNum = parseFloat(pct);
      if (isNaN(pctNum) || pctNum <= 0 || pctNum >= 100) return res.status(400).json({ error: "pct debe estar entre 1 y 99" });
      const accIdQ = acc_id || req.query.acc_id;
      if (!accIdQ) return res.status(400).json({ error: "Falta acc_id" });
      const cfg = await loadMetaAccount(db, uid, accIdQ);
      if (!cfg?.access_token) return res.status(400).json({ error: "Cuenta Meta sin token" });
      try {
        const node = await metaGet(node_id, { fields: "daily_budget,lifetime_budget,name" }, cfg.access_token);
        const dailyOld = parseInt(node.daily_budget) || 0;
        const lifetimeOld = parseInt(node.lifetime_budget) || 0;
        const oldBudget = dailyOld || lifetimeOld;
        if (oldBudget <= 0) return res.status(400).json({ error: "El node no tiene presupuesto editable" });
        const factor = (100 - pctNum) / 100;
        const newBudget = Math.max(100, Math.round(oldBudget * factor)); // mínimo 1 (cents)
        const field = dailyOld > 0 ? "daily_budget" : "lifetime_budget";
        await metaPost(node_id, { [field]: String(newBudget) }, cfg.access_token);
        return res.json({ ok: true, node_id, field, old_budget: oldBudget / 100, new_budget: newBudget / 100, pct: pctNum });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // ── SET STATUS (pausar/activar campaña, adset o ad) ──
    // POST { node_id, status: "ACTIVE" | "PAUSED" }
    if (action === "set_status" && req.method === "POST") {
      const { node_id, status } = req.body || {};
      if (!node_id || !status) return res.status(400).json({ error: "Faltan node_id o status" });
      if (!["ACTIVE", "PAUSED"].includes(status)) return res.status(400).json({ error: "status inválido" });
      const accIdQ = acc_id || req.query.acc_id;
      if (!accIdQ) return res.status(400).json({ error: "Falta acc_id" });
      const cfg = await loadMetaAccount(db, uid, accIdQ);
      if (!cfg?.access_token) return res.status(400).json({ error: "Cuenta Meta sin token" });
      try {
        await metaPost(node_id, { status }, cfg.access_token);
        return res.json({ ok: true, node_id, status });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (action === "resources" && req.method === "GET") {
      if (!acc_id) return res.status(400).json({ error: "Falta acc_id" });
      const cfg = await loadMetaAccount(db, uid, acc_id);
      if (!cfg?.access_token) return res.status(400).json({ error: "Sin token" });
      let intros;
      try { intros = await metaIntrospect(cfg.access_token); }
      catch (e) { return res.status(400).json({ error: e.message }); }
      let pixels = [];
      if (cfg.ad_account_id) {
        try { const px = await metaGet(`${cfg.ad_account_id}/adspixels`, { fields: "id,name", limit: 50 }, cfg.access_token); pixels = px.data || []; } catch (_) {}
      }
      return res.json({ ...intros, pixels });
    }

    // ── CAMPAÑAS ─────────────────────────────────────────

    if (action === "campaigns" && req.method === "GET") {
      if (!acc_id) return res.status(400).json({ error: "Falta acc_id" });
      const cfg = await loadMetaAccount(db, uid, acc_id);
      if (!cfg?.ad_account_id) return res.status(400).json({ error: "Cuenta sin ad_account_id" });
      const [cs, adsets] = await Promise.all([
        metaGet(`${cfg.ad_account_id}/campaigns`, { fields: "id,name,objective,status,effective_status,daily_budget,lifetime_budget", limit: 200 }, cfg.access_token),
        metaGet(`${cfg.ad_account_id}/adsets`, { fields: "id,name,campaign_id,status,effective_status,daily_budget,optimization_goal", limit: 500 }, cfg.access_token),
      ]);
      return res.json({ campaigns: cs.data || [], adsets: adsets.data || [], objectives: CAMPAIGN_OBJECTIVES });
    }

    if (action === "create_campaign" && req.method === "POST") {
      if (!acc_id) return res.status(400).json({ error: "Falta acc_id" });
      const cfg = await loadMetaAccount(db, uid, acc_id);
      if (!cfg?.ad_account_id) return res.status(400).json({ error: "Cuenta sin ad_account_id" });
      const { name, objective, cbo_daily_budget_ars, bid_strategy, special_ad_categories, active } = req.body || {};
      const payload = {
        name: (name || "").trim() || `Campaña ${new Date().toLocaleDateString("es-AR")}`,
        objective: objective || "OUTCOME_SALES",
        status: active ? "ACTIVE" : "PAUSED",
        special_ad_categories: JSON.stringify(special_ad_categories || []),
        buying_type: "AUCTION",
      };
      if (cbo_daily_budget_ars) {
        payload.daily_budget = String(Math.round(parseFloat(cbo_daily_budget_ars) * 100));
        payload.bid_strategy = bid_strategy || "LOWEST_COST_WITHOUT_CAP";
      }
      const result = await metaPost(`${cfg.ad_account_id}/campaigns`, payload, cfg.access_token);
      return res.json({ ok: true, id: result.id, name: payload.name, objective: payload.objective, is_cbo: Boolean(cbo_daily_budget_ars) });
    }

    if (action === "create_adset" && req.method === "POST") {
      if (!acc_id) return res.status(400).json({ error: "Falta acc_id" });
      const cfg = await loadMetaAccount(db, uid, acc_id);
      if (!cfg?.ad_account_id) return res.status(400).json({ error: "Cuenta sin ad_account_id" });
      const { name, campaign_id, billing_event, optimization_goal, daily_budget_ars, bid_strategy, is_cbo, start_time, pixel_id, custom_event_type, targeting, active } = req.body || {};
      if (!campaign_id) return res.status(400).json({ error: "Falta campaign_id" });
      const payload = {
        name: (name || "").trim() || `AdSet ${new Date().toLocaleTimeString("es-AR")}`,
        campaign_id,
        billing_event: billing_event || "IMPRESSIONS",
        optimization_goal: optimization_goal || "OFFSITE_CONVERSIONS",
        status: active ? "ACTIVE" : "PAUSED",
        targeting: JSON.stringify(targeting || { geo_locations: { countries: ["AR"] }, age_min: 30, age_max: 65, publisher_platforms: ["facebook","instagram"] }),
      };
      if (!is_cbo) {
        payload.daily_budget = String(Math.round(parseFloat(daily_budget_ars || 3000) * 100));
        payload.bid_strategy = bid_strategy || "LOWEST_COST_WITHOUT_CAP";
      }
      if (start_time) payload.start_time = start_time;
      if (pixel_id && payload.optimization_goal === "OFFSITE_CONVERSIONS") {
        payload.promoted_object = JSON.stringify({ pixel_id, custom_event_type: custom_event_type || "PURCHASE" });
      }
      const result = await metaPost(`${cfg.ad_account_id}/adsets`, payload, cfg.access_token);
      return res.json({ ok: true, id: result.id, name: payload.name, campaign_id, start_time: start_time || null });
    }

    // ── CREAR CAMPAÑA + N ADSETS DE UN SAQUE ─────────────
    // POST { name, objective, mode: "abo"|"cbo", daily_budget, adsets: [{name, daily_budget, start_time}] }
    // El budget va a nivel campaign si CBO, o por adset si ABO.
    if (action === "create_full" && req.method === "POST") {
      if (!acc_id) return res.status(400).json({ error: "Falta acc_id" });
      const cfg = await loadMetaAccount(db, uid, acc_id);
      if (!cfg?.ad_account_id) return res.status(400).json({ error: "Cuenta sin ad_account_id" });
      const { name, objective, mode, daily_budget, adsets, active } = req.body || {};
      if (!name?.trim()) return res.status(400).json({ error: "Falta nombre de campaña" });
      if (!Array.isArray(adsets) || adsets.length === 0) return res.status(400).json({ error: "Necesitás al menos 1 adset" });
      const isCbo = mode === "cbo";
      // 1) Campaign
      const campPayload = {
        name: name.trim(),
        objective: objective || "OUTCOME_SALES",
        status: active ? "ACTIVE" : "PAUSED",
        special_ad_categories: JSON.stringify([]),
        buying_type: "AUCTION",
      };
      if (isCbo) {
        const cbo = parseFloat(daily_budget);
        if (!cbo || cbo <= 0) return res.status(400).json({ error: "CBO necesita presupuesto > 0" });
        campPayload.daily_budget = String(Math.round(cbo * 100));
        campPayload.bid_strategy = "LOWEST_COST_WITHOUT_CAP";
      }
      let campRes;
      try { campRes = await metaPost(`${cfg.ad_account_id}/campaigns`, campPayload, cfg.access_token); }
      catch (e) { return res.status(502).json({ error: `Falló crear campaña: ${e.message}` }); }
      // 2) Adsets en cascada
      const createdAdsets = [];
      const adsetErrors = [];
      for (const a of adsets) {
        const adPayload = {
          name: (a.name || "").trim() || `AdSet ${createdAdsets.length+1}`,
          campaign_id: campRes.id,
          billing_event: "IMPRESSIONS",
          optimization_goal: "OFFSITE_CONVERSIONS",
          status: active ? "ACTIVE" : "PAUSED",
          targeting: JSON.stringify({ geo_locations: { countries: ["AR"] }, age_min: 25, age_max: 65, publisher_platforms: ["facebook","instagram"] }),
        };
        if (!isCbo) {
          const b = parseFloat(a.daily_budget);
          if (!b || b <= 0) { adsetErrors.push(`AdSet "${adPayload.name}": presupuesto inválido`); continue; }
          adPayload.daily_budget = String(Math.round(b * 100));
          adPayload.bid_strategy = "LOWEST_COST_WITHOUT_CAP";
        }
        if (a.start_time) adPayload.start_time = a.start_time;
        if (cfg.pixel_id) adPayload.promoted_object = JSON.stringify({ pixel_id: cfg.pixel_id, custom_event_type: "PURCHASE" });
        try {
          const r = await metaPost(`${cfg.ad_account_id}/adsets`, adPayload, cfg.access_token);
          createdAdsets.push({ id: r.id, name: adPayload.name, start_time: a.start_time || null });
        } catch (e) {
          adsetErrors.push(`AdSet "${adPayload.name}": ${e.message}`);
        }
      }
      return res.json({ ok: true, campaign_id: campRes.id, campaign_name: campPayload.name, adsets: createdAdsets, errors: adsetErrors });
    }

    // ── UPLOAD IMAGEN/VIDEO A META ────────────────────────
    // POST JSON { filename, contentType, data_base64 } — el cliente lo lee como FileReader y manda base64.
    // Devuelve { kind, url, hash (img), id (video) }
    if (action === "upload_to_meta" && req.method === "POST") {
      if (!acc_id) return res.status(400).json({ error: "Falta acc_id" });
      const cfg = await loadMetaAccount(db, uid, acc_id);
      if (!cfg?.access_token || !cfg?.ad_account_id) return res.status(400).json({ error: "Cuenta Meta sin ad_account_id" });

      const { filename, contentType, data_base64 } = req.body || {};
      if (!filename || !data_base64) return res.status(400).json({ error: "Faltan filename o data_base64" });

      const fileBuffer = Buffer.from(data_base64, "base64");
      const isVideo = (contentType || "").startsWith("video/") || /\.(mp4|mov|m4v|avi|webm)$/i.test(filename);
      const accIdStr = cfg.ad_account_id.startsWith("act_") ? cfg.ad_account_id : `act_${cfg.ad_account_id}`;

      try {
        if (isVideo) {
          const fd = new FormData();
          const blob = new Blob([fileBuffer], { type: contentType || "video/mp4" });
          fd.append("access_token", cfg.access_token);
          fd.append("source", blob, filename);
          const r = await fetch(`${META_BASE}/${accIdStr}/advideos`, { method: "POST", body: fd });
          const j = await r.json();
          if (!r.ok || j.error) return res.status(500).json({ error: j.error?.message || `HTTP ${r.status}` });
          return res.json({ ok: true, kind: "video", id: j.id, url: null });
        } else {
          const fd = new FormData();
          const blob = new Blob([fileBuffer], { type: contentType || "image/jpeg" });
          fd.append("access_token", cfg.access_token);
          fd.append("filename", blob, filename);
          const r = await fetch(`${META_BASE}/${accIdStr}/adimages`, { method: "POST", body: fd });
          const j = await r.json();
          if (!r.ok || j.error) return res.status(500).json({ error: j.error?.message || `HTTP ${r.status}` });
          const img = Object.values(j.images || {})[0];
          if (!img) return res.status(500).json({ error: "Respuesta inesperada de Meta" });
          return res.json({ ok: true, kind: "image", hash: img.hash, url: img.url, width: img.width, height: img.height });
        }
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // ── ANALIZAR CREATIVE CON GEMINI VISION ───────────────
    // POST { cid?, url?, data_base64?, contentType?, filename?, auto_copy? }
    // Soporta imagen Y video. Para video manda el cliente data_base64 (lo subimos a Gemini Files API).
    // Si auto_copy=true (default true) y el creative no tiene copy, dispara generate_copy automáticamente.
    if (action === "analyze_creative" && req.method === "POST") {
      const { cid: cidBody, url: urlBody, data_base64, contentType, filename, auto_copy } = req.body || {};
      const apiKey = process.env.GOOGLE_AI_KEY;
      if (!apiKey) return res.status(500).json({ error: "Falta GOOGLE_AI_KEY en env" });

      let creativeRef = null;
      if (cidBody) {
        const c = await loadCreative(db, uid, cidBody);
        if (!c) return res.status(404).json({ error: "Creativo no encontrado" });
        creativeRef = c;
      }

      try {
        // Bytes + mime
        let buf = null, mime = contentType || null;
        if (data_base64) {
          buf = Buffer.from(data_base64, "base64");
          if (!mime) mime = (filename || "").match(/\.(mp4|mov|m4v|webm|avi)$/i) ? "video/mp4" : "image/jpeg";
        } else if (creativeRef && creativeRef.url && !creativeRef.url.startsWith("meta-video://")) {
          const r = await fetch(creativeRef.url);
          if (!r.ok) return res.status(500).json({ error: `No se pudo descargar el creativo (HTTP ${r.status})` });
          buf = Buffer.from(await r.arrayBuffer());
          mime = r.headers.get("content-type") || mime || "image/jpeg";
        } else if (urlBody) {
          const r = await fetch(urlBody);
          if (!r.ok) return res.status(500).json({ error: `No se pudo descargar la URL (HTTP ${r.status})` });
          buf = Buffer.from(await r.arrayBuffer());
          mime = r.headers.get("content-type") || mime || "image/jpeg";
        } else {
          return res.status(400).json({ error: "Falta cid+data_base64 (video) o cid con URL accesible (imagen)" });
        }

        const isVideo = (mime || "").startsWith("video/");
        const isImage = (mime || "").startsWith("image/");
        if (!isVideo && !isImage) return res.status(400).json({ error: `Tipo no soportado: ${mime}` });

        // Contexto: brand + product_data + url + filename + copy_agent
        const userSnap = await db.collection("users").doc(uid).get();
        const brand = userSnap.data()?.meta_brand || "";
        const copyAgent = userSnap.data()?.meta_copy_agent || "";
        const productData = creativeRef?.product_data || "";
        const link = creativeRef?.link || "";
        const fname = filename || creativeRef?.filename || "";

        // Media part: video → Files API; imagen → inline_data
        let mediaPart;
        if (isVideo) {
          const file = await geminiUploadFileAndWait(apiKey, buf, mime, fname || "creative.mp4");
          mediaPart = { file_data: { mime_type: mime, file_uri: file.uri } };
        } else {
          mediaPart = { inline_data: { mime_type: mime, data: buf.toString("base64") } };
        }

        const SYSTEM = `Sos un experto top en Meta Ads de ecommerce. Análisis PROFUNDO Y HONESTO de creativos (imagen o video) para que un copywriter genere un anuncio que CONVIERTA. Mirá todo: texto en pantalla, gestos, escenografía, paleta, ángulo emocional, demografía visual. Devolvé SOLO JSON con esta estructura exacta (no agregues claves extra ni backticks):
{
  "angulo": "ángulo principal del creativo en 1 línea (qué historia/promesa/dolor cuenta)",
  "target": "a quién apunta (edad, género, situación, dolor específico)",
  "escena": "qué se ve / qué pasa en 2-3 líneas — incluí gestos, escenografía y elementos clave",
  "transcripcion": "TODO el texto visible/dicho en el creativo (video: cada frase; imagen: cada palabra que se lee). String, no array.",
  "angulos_detectados": ["3-6 ángulos comunicacionales fuertes que detectaste (ej: 'dolor crónico de tendones', 'autoridad médica', 'urgencia por edad')"],
  "angulos_secundarios": ["2-4 ángulos secundarios que se podrían explotar"],
  "tono_detectado": "1 palabra: directo | empático | dramático | informativo | ugc | experto | inspirador",
  "sentiment_detectado": "1 palabra: esperanza | miedo | alegría | urgencia | confianza | curiosidad | empatía",
  "headline_sugerido": "headline corto (max 60 chars) que pegue con este creativo"
}`;

        const userMsg = [
          brand ? `## Contexto de marca:\n${brand}` : "",
          productData ? `## Data del producto (este creativo):\n${productData}` : "",
          link ? `## URL del ad: ${link}` : "",
          fname ? `## Nombre del archivo: ${fname}` : "",
          `Analizá PROFUNDAMENTE este ${isVideo ? "video" : "imagen"} y devolvé el JSON exacto.`,
        ].filter(Boolean).join("\n\n");

        const payload = {
          system_instruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: "user", parts: [mediaPart, { text: userMsg }] }],
          generationConfig: { response_mime_type: "application/json", temperature: 0.4, max_output_tokens: 2500 },
        };

        const r = await fetch(`${GEMINI_BASE}/models/${GEMINI_TEXT_MODEL}:generateContent?key=${apiKey}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        });
        const dataResp = await r.json();
        const text = dataResp.candidates?.[0]?.content?.parts?.[0]?.text || "";
        if (!text) return res.status(500).json({ error: "Gemini devolvió respuesta vacía", raw: dataResp });
        let cleaned = text;
        if (cleaned.includes("```")) { cleaned = cleaned.split("```")[1]; if (cleaned.startsWith("json")) cleaned = cleaned.slice(4); }
        const s = cleaned.indexOf("{"), e = cleaned.lastIndexOf("}");
        if (s >= 0 && e > s) cleaned = cleaned.slice(s, e + 1);
        let analysis;
        try { analysis = JSON.parse(cleaned); } catch (_) { return res.status(502).json({ error: "Gemini devolvió JSON inválido", raw: text.slice(0, 500) }); }

        // Guardar análisis
        let updatedRef = creativeRef;
        if (creativeRef) {
          updatedRef = { ...creativeRef, analysis, ia_status: "analyzed" };
          await saveCreative(db, uid, updatedRef);
        }

        // Auto-fire copy si el creative no tiene copy todavía (default: true)
        const wantsAutoCopy = auto_copy !== false;
        let autoCopy = null;
        if (wantsAutoCopy && updatedRef && !updatedRef.copy?.trim()) {
          try {
            const r2 = await geminiGenerateCopy({
              brand,
              copy_agent: copyAgent,
              analysis,
              tone: updatedRef.tone || analysis?.tono_detectado || "",
              length: updatedRef.length || "nativo",
              format: updatedRef.format || "",
              notes: updatedRef.notes || "",
              filename: updatedRef.filename_base || fname,
              word_min: updatedRef.word_min || "",
              word_max: updatedRef.word_max || "",
              product_data: productData,
              url: link,
            });
            updatedRef = { ...updatedRef, copy: r2.copy, title: r2.title, description: r2.description, ia_status: "ok" };
            await saveCreative(db, uid, updatedRef);
            autoCopy = r2;
          } catch (copyErr) {
            console.error("[auto-copy] failed:", copyErr.message);
          }
        }

        return res.json({ ok: true, analysis, auto_copy: autoCopy, creative: updatedRef });
      } catch (e) {
        console.error("[analyze_creative] error:", e.message);
        return res.status(500).json({ error: e.message });
      }
    }

    // ── CREATIVOS ─────────────────────────────────────────

    if (action === "creatives" && req.method === "GET") {
      if (!acc_id) return res.status(400).json({ error: "Falta acc_id" });
      const items = await listCreatives(db, uid, acc_id);
      return res.json({ creatives: items });
    }

    if (action === "add_creative" && req.method === "POST") {
      if (!acc_id) return res.status(400).json({ error: "Falta acc_id" });
      const { filename, kind, url, size, meta_video_id, meta_hash, link, cta } = req.body || {};
      if (!filename || !kind || !url) return res.status(400).json({ error: "Faltan filename, kind o url" });
      // ID con timestamp + 10 chars random (evita colisiones en parallel upload)
      const id = Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 12);
      let videoId = meta_video_id || null;
      if (!videoId && typeof url === "string" && url.startsWith("meta-video://")) {
        videoId = url.slice("meta-video://".length);
      }
      const creative = {
        id, acc_id, filename, filename_base: filename.replace(/\.[^.]+$/, ""),
        kind, url, size: size || 0,
        meta_video_id: videoId || null,
        meta_hash: meta_hash || null,
        tone: "directo", length: "medio", format: "storytelling",
        notes: "", copy: "", title: "", description: "",
        link: link || "",
        cta: cta || "LEARN_MORE",
        campaign_id: "", adset_id: "", analysis: null, ia_status: "pending",
        created_at: new Date().toISOString(),
      };
      await saveCreative(db, uid, creative);
      return res.json({ ok: true, creative });
    }

    if (action === "patch_creative" && req.method === "PATCH") {
      if (!cid) return res.status(400).json({ error: "Falta cid" });
      const c = await loadCreative(db, uid, cid);
      if (!c) return res.status(404).json({ error: "Creativo no encontrado" });
      const EDITABLE = ["tone","length","format","notes","copy","title","description","link","cta","campaign_id","adset_id","analysis","word_min","word_max","product_data","video_ready","ia_status"];
      const updates = {};
      EDITABLE.forEach(k => { if (req.body?.[k] !== undefined) updates[k] = req.body[k]; });
      const updated = { ...c, ...updates };
      await saveCreative(db, uid, updated);
      return res.json({ ok: true, creative: updated });
    }

    if (action === "delete_creative" && req.method === "DELETE") {
      if (!cid) return res.status(400).json({ error: "Falta cid" });
      await creativesCol(db, uid).doc(cid).delete();
      return res.json({ ok: true });
    }

    // generate_copy: no requiere creative existente. Se basa en brand +
    // copy_agent (de la user doc) + product_data + url + parametros opcionales
    // del body. Si viene cid y el creative existe, ademas guarda el copy
    // en el. Si no, devuelve solo el copy y el frontend lo guarda.
    if (action === "generate_copy" && req.method === "POST") {
      const userSnap = await db.collection("users").doc(uid).get();
      const brand = userSnap.data()?.meta_brand || "";
      const copyAgent = userSnap.data()?.meta_copy_agent || "";
      const { tone, length, format, notes, word_min, word_max, product_data, url } = req.body || {};
      // Si tenemos cid, intentamos mergear con la data del creative existente
      // (product_data y link guardados). Si no existe, seguimos igual.
      let existing = null;
      if (cid) {
        try { existing = await loadCreative(db, uid, cid); } catch (_) {}
      }
      const merged = {
        ...(existing || {}),
        ...(tone && { tone }),
        ...(length && { length }),
        ...(format && { format }),
        ...(notes !== undefined && { notes }),
        ...(word_min && { word_min }),
        ...(word_max && { word_max }),
        ...(product_data !== undefined && { product_data }),
        ...(url !== undefined && { link: url }),
      };
      let result;
      try {
        result = await geminiGenerateCopy({
          brand,
          copy_agent: copyAgent,
          // NO pasamos analysis ni filename — copy aleatorio.
          analysis: null,
          tone: merged.tone || "",
          length: merged.length || "nativo",
          format: merged.format || "",
          notes: merged.notes || "",
          filename: "",
          word_min: merged.word_min || "",
          word_max: merged.word_max || "",
          product_data: merged.product_data || "",
          url: merged.link || "",
        });
      } catch (e) { return res.status(502).json({ error: e.message }); }
      // Si habia creative, guardar el copy en el
      if (existing) {
        const updated = { ...merged, copy: result.copy, title: result.title, description: result.description, ia_status: "ok" };
        await saveCreative(db, uid, updated);
        return res.json({ ok: true, creative: updated, ...result });
      }
      // Sin creative existente: devolver solo el copy
      return res.json({ ok: true, ...result });
    }

    // ── BRAND ────────────────────────────────────────────

    if (action === "brand" && req.method === "GET") {
      const userSnap = await db.collection("users").doc(uid).get();
      const text = userSnap.data()?.meta_brand || "";
      return res.json({ text, configured: Boolean(text.trim()) });
    }

    if (action === "save_brand" && req.method === "POST") {
      const { text } = req.body || {};
      await db.collection("users").doc(uid).set({ meta_brand: text || "" }, { merge: true });
      return res.json({ ok: true });
    }

    // ── INSTRUCCIONES DEL AGENTE COPYWRITER ─────────────
    // El usuario define COMO escribe el agente (personalidad, emojis, CTAs,
    // lo que NO debe decir, voseo, longitud, etc). Se inyecta en cada
    // generate_copy y en el auto-copy del analyze_creative.

    if (action === "copy_agent" && req.method === "GET") {
      const userSnap = await db.collection("users").doc(uid).get();
      const text = userSnap.data()?.meta_copy_agent || "";
      return res.json({ text, configured: Boolean(text.trim()) });
    }

    if (action === "save_copy_agent" && req.method === "POST") {
      const { text } = req.body || {};
      await db.collection("users").doc(uid).set({ meta_copy_agent: text || "" }, { merge: true });
      return res.json({ ok: true });
    }

    // ── PUBLICACIÓN ──────────────────────────────────────

    if (action === "publish" && req.method === "POST") {
      if (!acc_id) return res.status(400).json({ error: "Falta acc_id" });
      const cfg = await loadMetaAccount(db, uid, acc_id);
      if (!cfg?.ad_account_id || !cfg?.page_id) return res.status(400).json({ error: "Configurá ad account y página primero" });
      const { creative_id, activate, default_link, default_cta } = req.body || {};
      if (!creative_id) return res.status(400).json({ error: "Falta creative_id" });
      const c = await loadCreative(db, uid, creative_id);
      if (!c) return res.status(404).json({ error: "Creativo no encontrado" });
      if (!c.copy?.trim()) return res.status(400).json({ error: "Falta copy en el creativo" });
      if (!c.adset_id) return res.status(400).json({ error: "Falta adset_id en el creativo" });
      if (!c.url) return res.status(400).json({ error: "El creativo no tiene URL de archivo" });

      const token = cfg.access_token;
      const adAccountId = cfg.ad_account_id;
      const pageId = cfg.page_id;
      const igId = cfg.ig_account_id || "";
      const pageToken = cfg.page_access_token || token;
      const link = (c.link || default_link || "").trim();
      const cta = c.cta || default_cta || "LEARN_MORE";
      const adName = `${c.filename_base || "ad"} · ${new Date().toLocaleString("es-AR")}`.slice(0, 120);

      let spec;
      if (c.kind === "video") {
        // El video YA fue subido a Meta en el upload directo desde el browser.
        // Tenemos su video_id en c.meta_video_id (o derivado del c.url
        // "meta-video://VIDEO_ID"). NO re-subir — saltea polling.
        let videoId = c.meta_video_id || null;
        if (!videoId && typeof c.url === "string" && c.url.startsWith("meta-video://")) {
          videoId = c.url.slice("meta-video://".length);
        }
        // Si el frontend ya verifico que el video esta ready (background polling
        // durante upload), saltamos el polling.
        const skipPolling = c.video_ready === true;
        // Fallback: si no hay video_id pero hay file_url publica, intentar upload
        // rapido sin polling largo (max 10s total).
        if (!videoId) {
          if (!c.url || !/^https?:\/\//i.test(c.url)) {
            return res.status(400).json({ error: "El creative no tiene video_id ni URL publica de video" });
          }
          const uploadRes = await metaPost(`${adAccountId}/advideos`, { file_url: c.url, title: (c.title || c.filename_base || "").slice(0, 60) }, token);
          videoId = uploadRes.id;
          if (!videoId) return res.status(502).json({ error: "Meta no devolvió video_id" });
        }
        // Si el frontend ya verifico ready (polling background), saltamos.
        // Si no, polling rapido — max ~12s (el user no quiere esperar).
        // Si tras 12s sigue procesando, devolvemos error que va al lote de
        // fallados — el user puede tocar "Reintentar" en el historial.
        let ready = skipPolling;
        let lastStatus = skipPolling ? "ready" : null;
        if (!skipPolling) {
          const delays = [500, 1000, 1500, 2000, 2500, 2500, 2500];
          for (let i = 0; i < delays.length && !ready; i++) {
            await new Promise(r => setTimeout(r, delays[i]));
            try {
              const st = await metaGet(videoId, { fields: "status" }, token);
              const vs = st.status?.video_status;
              lastStatus = vs;
              if (vs === "ready") { ready = true; break; }
              if (vs === "error") return res.status(502).json({ error: "Meta falló al procesar el video" });
            } catch (_) {}
          }
        }
        if (!ready) {
          return res.status(409).json({ error: `Video aún procesándose en Meta. Tocá "Reintentar fallados" en el lote del historial en 30s.`, code: "VIDEO_NOT_READY", video_id: videoId });
        }
        let thumb;
        try { const tr = await metaGet(`${videoId}/thumbnails`, { fields: "uri,is_preferred" }, token); thumb = (tr.data?.find(t => t.is_preferred) || tr.data?.[0])?.uri; } catch (_) {}
        spec = { page_id: pageId, video_data: { video_id: videoId, title: (c.title || "").slice(0, 60), message: c.copy.trim(), link_description: (c.description || "").slice(0, 60), ...(thumb ? { image_url: thumb } : {}), call_to_action: { type: cta, value: { link } } } };
      } else {
        // Imagen: si tenemos meta_hash guardado del upload directo, usarlo.
        // Sino, re-subir via URL (puede fallar si la URL CDN de Meta expiró).
        let imageHash = c.meta_hash || null;
        if (!imageHash) {
          try {
            const imgRes = await metaPost(`${adAccountId}/adimages`, { url: c.url }, token);
            const first = Object.values(imgRes.images || {})[0];
            imageHash = first?.hash || null;
          } catch (e) {
            return res.status(502).json({ error: `No se pudo re-subir la imagen a Meta (URL caducada). Tip: re-subí el archivo desde la cola. (${e.message})` });
          }
        }
        if (!imageHash) return res.status(502).json({ error: "Meta no devolvió image hash" });
        spec = { page_id: pageId, link_data: { image_hash: imageHash, link, message: c.copy.trim(), name: (c.title || "").slice(0, 60), description: (c.description || "").slice(0, 60), call_to_action: { type: cta, value: { link } } } };
      }
      if (igId) spec.instagram_user_id = igId;

      // Estrategia portada de Gestionommerce: 5 intentos para crear el
      // AdCreative en orden de mas a menos preferido para binding con IG.
      // Si un intento falla por OTRA razon distinta a IG → aborta (no
      // tiene sentido reintentar si es error de creative o ad_account).
      const specUser = { ...spec };
      delete specUser.instagram_actor_id;
      const specActor = { ...spec };
      if (specActor.instagram_user_id) {
        specActor.instagram_actor_id = specActor.instagram_user_id;
        delete specActor.instagram_user_id;
      }
      const specNoIg = { ...spec };
      delete specNoIg.instagram_user_id;
      delete specNoIg.instagram_actor_id;
      const attempts = [
        ["user",     specUser,  pageToken], // page_token + instagram_user_id (v21+)
        ["actor",    specActor, pageToken], // page_token + instagram_actor_id (legacy)
        ["user-ut",  specUser,  token],     // user_token + instagram_user_id (fallback)
        ["actor-ut", specActor, token],     // user_token + instagram_actor_id
        ["fb-only",  specNoIg,  pageToken], // sin IG (FB only)
      ];
      let creativeId, igStatus;
      let lastErr = null;
      for (const [tag, sp, tok] of attempts) {
        try {
          const cr = await metaPost(`${adAccountId}/adcreatives`, { name: adName, object_story_spec: JSON.stringify(sp) }, tok);
          creativeId = cr.id; igStatus = tag; break;
        } catch (e) {
          lastErr = e.message;
          const low = e.message.toLowerCase();
          // Si el error NO es de IG/actor/user_id, abortar — reintentar no va a
          // cambiar nada (error de adset, page, spec, etc).
          if (!low.includes("instagram") && !low.includes("ig ") && !low.includes("actor") && !low.includes("user_id")) {
            return res.status(502).json({ error: `Creative falló: ${e.message}` });
          }
        }
      }
      if (!creativeId) return res.status(502).json({ error: `Todos los intentos de creative fallaron${lastErr?": "+lastErr:""}` });

      const ad = await metaPost(`${adAccountId}/ads`, {
        name: adName, adset_id: c.adset_id,
        creative: JSON.stringify({ creative_id: creativeId }),
        status: activate ? "ACTIVE" : "PAUSED",
      }, token);

      return res.json({ ok: true, ad_id: ad.id, creative_id: creativeId, ig_status: igStatus, status: activate ? "ACTIVE" : "PAUSED" });
    }

    return res.status(404).json({ error: `Acción desconocida: ${action}` });

  } catch (e) {
    console.error("[meta]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
