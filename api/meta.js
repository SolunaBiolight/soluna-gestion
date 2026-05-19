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
const GEMINI_TEXT_MODEL = "gemini-2.5-flash";

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

async function metaGet(path, params, token) {
  const url = new URL(`${META_BASE}/${path.replace(/^\//, "")}`);
  url.searchParams.set("access_token", token);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const r = await fetch(url.toString());
  const d = await r.json();
  if (d.error) throw new Error(`Meta · ${d.error.message} (${d.error.code})`);
  return d;
}

async function metaPost(path, payload, token) {
  const body = new URLSearchParams({ ...payload, access_token: token });
  const r = await fetch(`${META_BASE}/${path.replace(/^\//, "")}`, { method: "POST", body });
  const d = await r.json();
  if (d.error) throw new Error(`Meta · ${d.error.message} (${d.error.code})`);
  return d;
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

const COPY_SYSTEM = `Sos un copywriter experto en Facebook/Instagram Ads para ecommerce argentino.
Escribís en español rioplatense con voseo, tono directo y empático.
Devolvé SOLO un JSON con estas claves exactas, sin explicaciones ni backticks:
{"copy":"texto principal del ad (2-4 líneas, hook fuerte al inicio)","title":"titular corto máx 40 chars","description":"descripción secundaria máx 30 chars"}`;

async function geminiGenerateCopy({ brand, analysis, tone, length, format, notes, filename }) {
  const apiKey = process.env.GOOGLE_AI_KEY;
  if (!apiKey) throw new Error("Falta GOOGLE_AI_KEY en env");
  const toneDesc = { directo:"directo y al grano", emocional:"empático y emocional", urgencia:"con urgencia y escasez", educativo:"educativo e informativo" }[tone] || tone;
  const lengthDesc = { corto:"máximo 3 líneas", medio:"4-6 líneas", largo:"7-10 líneas" }[length] || length;
  const formatDesc = { storytelling:"storytelling (problema → agitación → solución)", directo:"propuesta de valor directa", pregunta:"arranca con una pregunta al target", testimonial:"en primera persona como testimonio" }[format] || format;
  const userPrompt = [
    brand ? `## Contexto de marca:\n${brand}` : "",
    analysis ? `## Análisis del creativo:\n${JSON.stringify(analysis, null, 2)}` : `## Creativo: ${filename || "sin nombre"}`,
    `## Parámetros:\n- Tono: ${toneDesc}\n- Largo: ${lengthDesc}\n- Formato: ${formatDesc}`,
    notes ? `- Notas: ${notes}` : "",
    `\nGenerá el copy siguiendo el formato JSON exacto.`,
  ].filter(Boolean).join("\n");
  const payload = {
    system_instruction: { parts: [{ text: COPY_SYSTEM }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: { response_mime_type: "application/json", temperature: 0.7, max_output_tokens: 600 },
  };
  const r = await fetch(`${GEMINI_BASE}/models/${GEMINI_TEXT_MODEL}:generateContent?key=${apiKey}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const data = await r.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) throw new Error("Gemini devolvió respuesta vacía");
  let cleaned = text;
  if (cleaned.includes("```")) { cleaned = cleaned.split("```")[1]; if (cleaned.startsWith("json")) cleaned = cleaned.slice(4); }
  const s = cleaned.indexOf("{"), e = cleaned.lastIndexOf("}");
  if (s >= 0 && e > s) cleaned = cleaned.slice(s, e + 1);
  return JSON.parse(cleaned);
}

// ─── Insights helper (reutilizable por endpoint y evaluador de reglas) ──

async function fetchInsightsRows(cfg, level, since, until) {
  const fields = [
    "campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name",
    "spend", "impressions", "clicks", "ctr", "cpm", "cpc", "frequency", "reach",
    "actions", "action_values", "purchase_roas", "cost_per_action_type",
  ].join(",");
  const data = await metaGet(`${cfg.ad_account_id}/insights`, {
    level,
    time_range: JSON.stringify({ since, until }),
    fields,
    limit: 500,
  }, cfg.access_token);

  const nodeFields = level === "campaign" ? "id,name,status,effective_status,objective,daily_budget,lifetime_budget"
                   : level === "adset"    ? "id,name,status,effective_status,daily_budget,lifetime_budget,campaign_id"
                   : "id,name,status,effective_status,adset_id,campaign_id";
  const nodes = await metaGet(`${cfg.ad_account_id}/${level === "campaign" ? "campaigns" : level === "adset" ? "adsets" : "ads"}`, {
    fields: nodeFields, limit: 500,
  }, cfg.access_token);
  const nodeMap = {};
  for (const n of (nodes.data || [])) nodeMap[n.id] = n;

  const rows = (data.data || []).map(r => {
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
async function evaluateRulesForAccount(db, uid, accId) {
  const cfg = await loadMetaAccount(db, uid, accId);
  if (!cfg?.access_token || !cfg.ad_account_id) return { error: "Cuenta no configurada" };

  const rulesSnap = await db.collection("users").doc(uid).collection("meta_rules")
    .where("acc_id", "==", accId).where("active", "==", true).get();
  const rules = rulesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (rules.length === 0) return { evaluated: 0, actions: 0 };

  // Pre-fetch insights por cada combinación única (level, window) que use alguna regla
  const combos = new Set();
  for (const rule of rules) {
    for (const cond of rule.conditions || []) combos.add(`${rule.level}|${cond.window_days || 7}`);
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

  let totalActions = 0;
  const logBatch = db.batch();
  const logCol = db.collection("users").doc(uid).collection("meta_rule_log");

  for (const rule of rules) {
    if (!rule.conditions?.length) continue;
    // Usamos la window de la PRIMERA condition como referencia para listar nodos.
    // Cada condition se evalúa con su propia window cache.
    const refCombo = `${rule.level}|${rule.conditions[0].window_days || 7}`;
    const refMap = cache.get(refCombo) || new Map();

    for (const [nodeId, refRow] of refMap) {
      if (refRow.effective_status !== "ACTIVE") continue;

      const results = rule.conditions.map(c => {
        const combo = `${rule.level}|${c.window_days || 7}`;
        const row = cache.get(combo)?.get(nodeId) || {};
        const v = row[c.metric] ?? 0;
        return { matched: evalCondition(v, c.op, c.value), actual: v, cond: c };
      });
      const matched = rule.logic === "OR"
        ? results.some(r => r.matched)
        : results.every(r => r.matched);

      if (!matched) continue;

      // Aplicar acción
      let ok = true, errMsg = null;
      if (rule.action === "pause") {
        try { await metaPost(nodeId, { status: "PAUSED" }, cfg.access_token); }
        catch (e) { ok = false; errMsg = e.message; }
      }

      const logRef = logCol.doc();
      logBatch.set(logRef, {
        rule_id: rule.id, rule_name: rule.name,
        node_id: nodeId, node_name: refRow.name || "",
        level: rule.level, logic: rule.logic,
        action_taken: rule.action, ok, error: errMsg || null,
        triggered: results.map(r => ({ metric: r.cond.metric, op: r.cond.op, target: r.cond.value, window_days: r.cond.window_days, actual: r.actual })),
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
  if (cleaned.includes("```")) { cleaned = cleaned.split("```")[1]; if (cleaned.startsWith("json")) cleaned = cleaned.slice(4); }
  const s = cleaned.indexOf("{"), e = cleaned.lastIndexOf("}");
  if (s >= 0 && e > s) cleaned = cleaned.slice(s, e + 1);
  return JSON.parse(cleaned);
}

// ─── Handler ───────────────────────────────────────────

export const config = { api: { bodyParser: true } };

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
      const { ad_account_id, ad_account_name, page_id, page_name, page_access_token, ig_account_id, ig_username, pixel_id } = req.body || {};
      const updated = { ...cfg, ad_account_id, ad_account_name, page_id, page_name, page_access_token, ig_account_id, ig_username, pixel_id };
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

      try {
        const data = await metaGet(`${cfg.ad_account_id}/insights`, {
          level,
          time_range: JSON.stringify({ since, until }),
          fields,
          limit: 500,
        }, cfg.access_token);

        // También necesitamos el status de cada nodo (que insights no devuelve).
        // Una sola llamada al endpoint correspondiente con id+status+effective_status.
        const nodeMap = {};
        const nodeFields = level === "campaign" ? "id,name,status,effective_status,objective,daily_budget,lifetime_budget"
                         : level === "adset"    ? "id,name,status,effective_status,daily_budget,lifetime_budget,campaign_id"
                         : "id,name,status,effective_status,adset_id,campaign_id,creative{id,name,thumbnail_url,object_story_spec}";
        try {
          const nodes = await metaGet(`${cfg.ad_account_id}/${level === "campaign" ? "campaigns" : level === "adset" ? "adsets" : "ads"}`, {
            fields: nodeFields,
            limit: 500,
          }, cfg.access_token);
          for (const n of (nodes.data || [])) nodeMap[n.id] = n;
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

      const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const until = new Date().toISOString().slice(0, 10);

      try {
        // 1) Ads con creative detallado
        const adsData = await metaGet(`${cfg.ad_account_id}/ads`, {
          fields: "id,name,status,effective_status,adset_id,campaign_id,creative{id,name,thumbnail_url,image_url,object_story_spec,object_type,body,title}",
          limit: 300,
        }, cfg.access_token);
        const ads = adsData.data || [];

        // 2) Insights de últimos 7 días por ad
        let insightsRows = [];
        try {
          const ins = await metaGet(`${cfg.ad_account_id}/insights`, {
            level: "ad",
            time_range: JSON.stringify({ since, until }),
            fields: "ad_id,spend,impressions,clicks,ctr,cpm,cpc,frequency,reach,actions,action_values,purchase_roas,cost_per_action_type",
            limit: 500,
          }, cfg.access_token);
          insightsRows = ins.data || [];
        } catch (e) { /* sin insights */ }

        // 3) Análisis cacheados
        const analysesSnap = await db.collection("users").doc(uid).collection("meta_ad_analyses").get();
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
          return {
            id: ad.id,
            name: ad.name,
            status: ad.status,
            effective_status: ad.effective_status,
            campaign_id: ad.campaign_id,
            adset_id: ad.adset_id,
            creative_thumbnail: creative.thumbnail_url || creative.image_url || null,
            creative_body: creative.body || linkData.message || "",
            creative_title: creative.title || linkData.name || "",
            creative_description: linkData.description || "",
            creative_link: linkData.link || "",
            creative_cta: linkData.call_to_action?.type || "",
            creative_type: creative.object_type || "image",
            spend: parseFloat(ins.spend) || 0,
            impressions: parseInt(ins.impressions) || 0,
            clicks: parseInt(ins.clicks) || 0,
            ctr: parseFloat(ins.ctr) || 0,
            cpm: parseFloat(ins.cpm) || 0,
            frequency: parseFloat(ins.frequency) || 0,
            purchases: parseInt(purchases?.value) || 0,
            purchase_value: parseFloat(purchaseValue?.value) || 0,
            roas: parseFloat((ins.purchase_roas || [])[0]?.value) || 0,
            cpa: parseFloat(cpaPurchase?.value) || 0,
            analysis: cachedAnalyses[ad.id]?.analysis || null,
            analyzed_at: cachedAnalyses[ad.id]?.analyzed_at || null,
          };
        });

        return res.json({ ads: result, since, until });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
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
        action: rule.action === "notify" ? "notify" : "pause",
        active: rule.active !== false,
        acc_id: rule.acc_id,
        updated_at: new Date().toISOString(),
        ...(rule.id ? {} : { created_at: new Date().toISOString() }),
      };
      await col.doc(ruleId).set(data, { merge: true });
      return res.json({ ok: true, id: ruleId, rule: { id: ruleId, ...data } });
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
    if (action === "evaluate_rules" && req.method === "POST") {
      const accIdQ = acc_id || req.query.acc_id;
      if (!accIdQ) return res.status(400).json({ error: "Falta acc_id" });
      const result = await evaluateRulesForAccount(db, uid, accIdQ);
      return res.json(result);
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
      const { name, objective, cbo_daily_budget_ars, bid_strategy, special_ad_categories } = req.body || {};
      const payload = {
        name: (name || "").trim() || `Campaña ${new Date().toLocaleDateString("es-AR")}`,
        objective: objective || "OUTCOME_SALES",
        status: "PAUSED",
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
      const { name, campaign_id, billing_event, optimization_goal, daily_budget_ars, bid_strategy, is_cbo, start_time, pixel_id, custom_event_type, targeting } = req.body || {};
      if (!campaign_id) return res.status(400).json({ error: "Falta campaign_id" });
      const payload = {
        name: (name || "").trim() || `AdSet ${new Date().toLocaleTimeString("es-AR")}`,
        campaign_id,
        billing_event: billing_event || "IMPRESSIONS",
        optimization_goal: optimization_goal || "OFFSITE_CONVERSIONS",
        status: "PAUSED",
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

    // ── CREATIVOS ─────────────────────────────────────────

    if (action === "creatives" && req.method === "GET") {
      if (!acc_id) return res.status(400).json({ error: "Falta acc_id" });
      const items = await listCreatives(db, uid, acc_id);
      return res.json({ creatives: items });
    }

    if (action === "add_creative" && req.method === "POST") {
      if (!acc_id) return res.status(400).json({ error: "Falta acc_id" });
      const { filename, kind, url, size } = req.body || {};
      if (!filename || !kind || !url) return res.status(400).json({ error: "Faltan filename, kind o url" });
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const creative = {
        id, acc_id, filename, filename_base: filename.replace(/\.[^.]+$/, ""),
        kind, url, size: size || 0,
        tone: "directo", length: "medio", format: "storytelling",
        notes: "", copy: "", title: "", description: "", link: "", cta: "LEARN_MORE",
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
      const EDITABLE = ["tone","length","format","notes","copy","title","description","link","cta","campaign_id","adset_id","analysis"];
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

    if (action === "generate_copy" && req.method === "POST") {
      if (!cid) return res.status(400).json({ error: "Falta cid" });
      const c = await loadCreative(db, uid, cid);
      if (!c) return res.status(404).json({ error: "Creativo no encontrado" });
      const userSnap = await db.collection("users").doc(uid).get();
      const brand = userSnap.data()?.meta_brand || "";
      const { tone, length, format, notes } = req.body || {};
      const merged = { ...c, ...(tone && { tone }), ...(length && { length }), ...(format && { format }), ...(notes && { notes }) };
      let result;
      try { result = await geminiGenerateCopy({ brand, analysis: merged.analysis, tone: merged.tone, length: merged.length, format: merged.format, notes: merged.notes, filename: merged.filename_base }); }
      catch (e) { return res.status(502).json({ error: e.message }); }
      const updated = { ...merged, copy: result.copy, title: result.title, description: result.description, ia_status: "ok" };
      await saveCreative(db, uid, updated);
      return res.json({ ok: true, creative: updated });
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
        const uploadRes = await metaPost(`${adAccountId}/advideos`, { file_url: c.url, title: (c.title || c.filename_base || "").slice(0, 60) }, token);
        const videoId = uploadRes.id;
        if (!videoId) return res.status(502).json({ error: "Meta no devolvió video_id" });
        let ready = false;
        for (let i = 0; i < 9 && !ready; i++) {
          await new Promise(r => setTimeout(r, 5000));
          const st = await metaGet(videoId, { fields: "status" }, token);
          if (st.status?.video_status === "ready") ready = true;
          else if (st.status?.video_status === "error") return res.status(502).json({ error: "Meta falló al procesar el video" });
        }
        if (!ready) return res.status(504).json({ error: "Timeout esperando procesamiento de video" });
        let thumb;
        try { const tr = await metaGet(`${videoId}/thumbnails`, { fields: "uri,is_preferred" }, token); thumb = (tr.data?.find(t => t.is_preferred) || tr.data?.[0])?.uri; } catch (_) {}
        spec = { page_id: pageId, video_data: { video_id: videoId, title: (c.title || "").slice(0, 60), message: c.copy.trim(), link_description: (c.description || "").slice(0, 60), ...(thumb ? { image_url: thumb } : {}), call_to_action: { type: cta, value: { link } } } };
      } else {
        const imgRes = await metaPost(`${adAccountId}/adimages`, { url: c.url }, token);
        const first = Object.values(imgRes.images || {})[0];
        if (!first?.hash) return res.status(502).json({ error: "Meta no devolvió image hash" });
        spec = { page_id: pageId, link_data: { image_hash: first.hash, link, message: c.copy.trim(), name: (c.title || "").slice(0, 60), description: (c.description || "").slice(0, 60), call_to_action: { type: cta, value: { link } } } };
      }
      if (igId) spec.instagram_user_id = igId;

      let creativeId, igStatus;
      const attempts = [
        ["user", { ...spec }, pageToken],
        ["actor", { ...spec, instagram_actor_id: igId, instagram_user_id: undefined }, pageToken],
        ["fb-only", { ...spec, instagram_user_id: undefined, instagram_actor_id: undefined }, pageToken],
      ];
      for (const [tag, sp, tok] of attempts) {
        try {
          const cr = await metaPost(`${adAccountId}/adcreatives`, { name: adName, object_story_spec: JSON.stringify(sp) }, tok);
          creativeId = cr.id; igStatus = tag; break;
        } catch (e) {
          const low = e.message.toLowerCase();
          if (!low.includes("instagram") && !low.includes("actor") && !low.includes("user_id")) throw e;
        }
      }
      if (!creativeId) return res.status(502).json({ error: "No se pudo crear el AdCreative" });

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
