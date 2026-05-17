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
  const [me, aa, pages] = await Promise.all([
    metaGet("me", { fields: "id,name,email" }, token),
    metaGet("me/adaccounts", { fields: "id,account_id,name,account_status,currency,timezone_name", limit: 200 }, token),
    metaGet("me/accounts", { fields: "id,name,access_token,instagram_business_account{id,username},category", limit: 200 }, token),
  ]);
  return { me, ad_accounts: aa.data || [], pages: pages.data || [] };
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
  await metaAccountRef(db, uid, accId).set({ ...data, id: String(accId) }, { merge: true });
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

// ─── Handler ───────────────────────────────────────────

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { action, uid, acc_id, cid } = req.query;
  if (!uid) return res.status(401).json({ error: "Falta uid" });

  const db = initAdmin();

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
