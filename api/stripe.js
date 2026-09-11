// api/stripe.js — Cobro de planes con tarjeta vía Stripe (suscripción recurrente).
//
//   action=checkout  POST {uid, plan, periodo}  → {url} de Stripe Checkout (o
//                    {changed:true} si ya tiene suscripción activa: cambia de plan
//                    en el momento con prorrateo, sin pasar por Checkout).
//   action=portal    POST {uid}                 → {url} del portal de facturación
//                    (cambiar tarjeta, ver facturas, cancelar).
//   action=cancel    POST {uid, reactivar?}     → cancela al fin del período / reactiva.
//   action=webhook   POST (Stripe)              → activa/renueva planes. Firma
//                    verificada con el secreto del endpoint.
//
// Sin SDK: la API de Stripe es REST con form-encoding y la firma del webhook es
// un HMAC — alcanza con fetch + crypto. Versión de API fijada para que la forma
// de los objetos (invoice.subscription, etc.) no cambie sin avisar.
//
// Setup automático (una sola vez, en el primer checkout): crea el endpoint de
// webhook en Stripe y guarda su secreto en Firestore system/stripe — el secreto
// nunca pasa por el chat ni por variables que haya que pegar a mano.
//
// Fuente de verdad del plan del usuario: users/{uid} {plan, planExpiry,
// stripeCustomerId, stripeSubscriptionId, stripeStatus, cancelAtPeriodEnd}. Cada
// factura cobrada genera un doc en `pagos` (method:"stripe") para que Admin →
// Cobros y el programa de referidos sigan funcionando igual.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { createHmac, timingSafeEqual } from "crypto";
import { guardUid } from "./_auth.js";
import { acreditarComisionReferido, descontarCreditoAplicado } from "./referidos.js";

const STRIPE_API = "https://api.stripe.com/v1";
const STRIPE_VERSION = "2024-06-20";
const SITE = "https://www.growithapp.com";
const WEBHOOK_URL = `${SITE}/api/stripe?action=webhook`;
const WEBHOOK_EVENTS = ["invoice.paid", "invoice.payment_failed", "customer.subscription.updated", "customer.subscription.deleted"];

// Precios USD por mes. Anual = 12 meses al precio "por mes equivalente" (mismos
// números que AppPlanes en el front — si cambian allá, cambian acá).
const PRECIOS = {
  facturador: { mensual: 19, anual: 16, nombre: "Facturador" },
  medio:      { mensual: 39, anual: 32, nombre: "Intermedio" },
  plus:       { mensual: 69, anual: 57, nombre: "Pro" },
};
// Multi-tienda: el plan incluye 1 tienda; cada tienda ADICIONAL suma esto por
// mes (USD). Mismo cuadro que api/tareas.js (PLAN_EXTRA_TIENDA) y AppPlanes.
const PRECIO_EXTRA_TIENDA = { facturador: 5, medio: 10, plus: 15 };
const tiendasExtraDe = (d) => (Array.isArray(d?.tiendas) ? d.tiendas : []).filter(t => t && t.uid && !t.deleted).length;
// Ítem de suscripción "Tienda adicional" (precio inline, cantidad = tiendas extra).
const extraPriceData = (plan, periodo) => {
  const anual = periodo === "anual";
  const unit = (PRECIO_EXTRA_TIENDA[plan] || 0) * (anual ? 12 : 1);
  return { currency: "usd", unit_amount: Math.round(unit * 100), recurring: { interval: anual ? "year" : "month" }, product_data: { name: `Growith — Tienda adicional (${PRECIOS[plan]?.nombre || plan}) — ${anual ? "anual" : "mensual"}`, metadata: { kind: "tienda_extra", plan, periodo } } };
};

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
  })});
  return getFirestore();
}

// {a:{b:1}, c:[x,y]} → a[b]=1&c[0]=x&c[1]=y (formato que espera Stripe)
function formEncode(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((it, i) => typeof it === "object" ? formEncode(it, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(it)}`));
    else if (typeof v === "object") formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join("&");
}
async function stripe(method, path, params, idemKey) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY no configurada");
  const headers = { Authorization: `Bearer ${key}`, "Stripe-Version": STRIPE_VERSION };
  let url = STRIPE_API + path, body;
  if (method === "GET") { const q = params ? formEncode(params) : ""; if (q) url += (url.includes("?") ? "&" : "?") + q; }
  else { headers["Content-Type"] = "application/x-www-form-urlencoded"; body = params ? formEncode(params) : ""; }
  if (idemKey) headers["Idempotency-Key"] = idemKey;
  const r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Stripe HTTP ${r.status}`);
  return j;
}

async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return { error: "missing" };
  const from = process.env.RESEND_FROM || "Growith <onboarding@resend.dev>";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html }), signal: AbortSignal.timeout(10000),
    });
    return r.ok ? { ok: true } : { error: (await r.json().catch(() => ({})))?.message };
  } catch (e) { return { error: e.message }; }
}
const fechaAR = d => d.toLocaleDateString("es-AR", { day: "2-digit", month: "long", year: "numeric", timeZone: "America/Argentina/Buenos_Aires" });

// ── Setup: webhook + configuración del portal, guardados en system/stripe ──
async function ensureSetup(db) {
  const ref = db.doc("system/stripe");
  const snap = await ref.get();
  const cfg = snap.exists ? snap.data() : {};
  const patch = {};
  if (!cfg.webhookSecret) {
    // Si quedó un endpoint viejo con nuestra URL (el secreto solo se ve al
    // crearlo), se borra y se crea de nuevo.
    const list = await stripe("GET", "/webhook_endpoints", { limit: 50 });
    for (const w of (list.data || [])) if (w.url === WEBHOOK_URL) await stripe("DELETE", `/webhook_endpoints/${w.id}`).catch(() => {});
    const w = await stripe("POST", "/webhook_endpoints", { url: WEBHOOK_URL, enabled_events: WEBHOOK_EVENTS, api_version: STRIPE_VERSION, description: "Growith — planes" });
    patch.webhookSecret = w.secret; patch.webhookId = w.id; patch.webhookAt = FieldValue.serverTimestamp();
  }
  if (!cfg.portalConfigId) {
    const c = await stripe("POST", "/billing_portal/configurations", {
      business_profile: { headline: "Growith — tu suscripción" },
      features: {
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        customer_update: { enabled: true, allowed_updates: ["email", "name", "address"] },
        subscription_cancel: { enabled: true, mode: "at_period_end", cancellation_reason: { enabled: true, options: ["too_expensive", "missing_features", "switched_service", "unused", "other"] } },
      },
    });
    patch.portalConfigId = c.id;
  }
  if (Object.keys(patch).length) await ref.set(patch, { merge: true });
  return { ...cfg, ...patch };
}

async function readRaw(req) {
  return await new Promise(resolve => { const c = []; req.on("data", x => c.push(x)); req.on("end", () => resolve(Buffer.concat(c).toString("utf8"))); req.on("error", () => resolve("")); });
}
function verifyStripeSig(raw, header, secret) {
  const parts = Object.fromEntries(String(header || "").split(",").map(p => p.split("=")).filter(p => p.length === 2));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const exp = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  try { return timingSafeEqual(Buffer.from(exp), Buffer.from(v1)); } catch { return false; }
}

function precioDe(plan, periodo) {
  const p = PRECIOS[plan]; if (!p) return null;
  const anual = periodo === "anual";
  return { anual, unit: anual ? p.anual * 12 : p.mensual, interval: anual ? "year" : "month", meses: anual ? 12 : 1, nombre: p.nombre };
}
const priceData = (plan, periodo) => {
  const p = precioDe(plan, periodo);
  return { currency: "usd", unit_amount: Math.round(p.unit * 100), recurring: { interval: p.interval }, product_data: { name: `Growith ${p.nombre} — ${p.anual ? "anual" : "mensual"}`, metadata: { plan, periodo } } };
};

// ── Activación / renovación a partir de una factura cobrada (idempotente) ──
async function procesarInvoicePaid(db, inv) {
  const subId = typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id;
  let meta = inv.subscription_details?.metadata || {};
  let sub = null;
  if ((!meta.uid || !meta.plan) && subId) { sub = await stripe("GET", `/subscriptions/${subId}`); meta = { ...(sub.metadata || {}), ...meta }; }
  const uid = meta.uid; const plan = PRECIOS[meta.plan] ? meta.plan : null;
  if (!uid || !plan) { console.warn("[stripe] invoice sin uid/plan en metadata", inv.id); return; }
  const periodo = meta.periodo === "anual" ? "anual" : "mensual";
  const meses = periodo === "anual" ? 12 : 1;
  const line = (inv.lines?.data || []).find(l => l.period?.end) || null;
  const periodEnd = line ? new Date(line.period.end * 1000) : (sub?.current_period_end ? new Date(sub.current_period_end * 1000) : null);
  const now = new Date();
  const esAlta = inv.billing_reason === "subscription_create";
  const refCreditAplicado = esAlta ? +(Number(meta.refCreditAplicado) || 0).toFixed(2) : 0;
  const pagoId = `stripe_${inv.id}`;
  const pagoRef = db.collection("pagos").doc(pagoId);
  const userRef = db.collection("users").doc(uid);
  const pago = {
    uid, email: String(inv.customer_email || meta.email || "").slice(0, 120),
    plan, method: "stripe", currency: String(inv.currency || "usd").toUpperCase(),
    amount: +((Number(inv.amount_paid) || 0) / 100).toFixed(2),
    meses, mesesConfirmados: meses, periodo, refCreditAplicado,
    estado: "confirmado", confirmadoBy: "stripe", confirmadoAt: now, createdAt: now,
    stripeInvoiceId: inv.id, stripeSubscriptionId: subId || null, stripeCustomerId: typeof inv.customer === "string" ? inv.customer : inv.customer?.id || null,
    invoiceUrl: inv.hosted_invoice_url || null, billingReason: inv.billing_reason || null,
  };
  const nuevo = await db.runTransaction(async tx => {
    const ps = await tx.get(pagoRef);
    if (ps.exists) return false;
    tx.set(pagoRef, pago);
    tx.set(userRef, {
      plan, isTrial: false, cancelAtPeriodEnd: false,
      ...(periodEnd ? { planExpiry: periodEnd } : {}),
      stripeCustomerId: pago.stripeCustomerId, stripeSubscriptionId: subId || null, stripeStatus: "active",
      planActivadoBy: "stripe", planActivadoAt: now,
    }, { merge: true });
    return true;
  });
  if (!nuevo) return;
  console.log(`[stripe] ✓ ${uid} → ${plan} ${periodo} (${inv.billing_reason}) $${pago.amount}`);
  await descontarCreditoAplicado(db, pagoId, pago);
  await acreditarComisionReferido(db, pagoId, pago);
  const email = pago.email || (await userRef.get()).data()?.email;
  if (email) {
    const nombre = PRECIOS[plan].nombre;
    await sendEmail({ to: email, subject: esAlta ? `Tu plan ${nombre} está activo` : `Renovamos tu plan ${nombre}`,
      html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6;color:#111">
        <p>${esAlta ? `¡Listo! Tu pago con tarjeta se procesó y tu plan <strong>${nombre}</strong> ya está activo.` : `Se renovó tu plan <strong>${nombre}</strong> con la tarjeta guardada.`}</p>
        ${periodEnd ? `<p>Tenés acceso hasta el <strong>${fechaAR(periodEnd)}</strong>. Se renueva solo; podés cancelar cuando quieras desde Growith → Mi cuenta.</p>` : ""}
        ${inv.hosted_invoice_url ? `<p><a href="${inv.hosted_invoice_url}">Ver la factura</a></p>` : ""}
        <p>Gracias por usar Growith.</p></div>` });
  }
}

// Cuerpo crudo: la firma del webhook se calcula sobre los bytes exactos que manda Stripe.
// ── Multi-tienda: sincroniza el ítem "Tienda adicional" de la suscripción ──
// Lo llama tareas.js al crear/eliminar tiendas y el cambio de plan (re-precio).
// Estrategia simple y robusta: si hay ítem extra lo borra y, si corresponden
// tiendas extra, agrega uno nuevo con el precio del plan vigente y la cantidad
// actual — todo en UNA actualización con prorrateo facturado.
export async function syncTiendasExtra(db, uid) {
  const userRef = db.collection("users").doc(uid);
  const u = (await userRef.get()).data() || {};
  if (!u.stripeSubscriptionId) return { skipped: "sin_suscripcion" };
  const sub = await stripe("GET", `/subscriptions/${u.stripeSubscriptionId}`).catch(() => null);
  if (!sub || !["active", "trialing", "past_due"].includes(sub.status)) return { skipped: "suscripcion_inactiva" };
  const plan = sub.metadata?.plan || u.plan; const periodo = sub.metadata?.periodo || "mensual";
  const extra = tiendasExtraDe(u);
  const items = sub.items?.data || [];
  const planItemId = items.find(i => i.id === u.stripePlanItemId)?.id || items.find(i => i.id !== u.stripeExtraItemId)?.id || items[0]?.id;
  const extraItem = items.find(i => i.id === u.stripeExtraItemId) || items.find(i => i.id !== planItemId) || null;
  const cambios = [];
  if (extraItem) cambios.push({ id: extraItem.id, deleted: true });
  if (extra > 0 && PRECIO_EXTRA_TIENDA[plan]) cambios.push({ price_data: extraPriceData(plan, periodo), quantity: extra });
  if (!cambios.length) return { ok: true, extra, sinCambios: true };
  const upd = await stripe("POST", `/subscriptions/${sub.id}`, { items: cambios, proration_behavior: "always_invoice" });
  const nuevoExtra = (upd.items?.data || []).find(i => i.id !== planItemId && i.id !== extraItem?.id) || null;
  await userRef.set({ stripePlanItemId: planItemId || null, stripeExtraItemId: nuevoExtra ? nuevoExtra.id : null, tiendasExtraFacturadas: extra }, { merge: true });
  return { ok: true, extra, itemId: nuevoExtra?.id || null };
}

// Cancela la suscripción YA (sin esperar fin de período). Lo usa "Eliminar cuenta".
export async function cancelarSuscripcionAhora(db, uid) {
  const userRef = db.collection("users").doc(uid);
  const u = (await userRef.get()).data() || {};
  if (!u.stripeSubscriptionId) return { skipped: "sin_suscripcion" };
  try { await stripe("DELETE", `/subscriptions/${u.stripeSubscriptionId}`); } catch (e) { if (!/No such subscription|already canceled/i.test(e.message || "")) throw e; }
  await userRef.set({ stripeStatus: "canceled", cancelAtPeriodEnd: false, stripeSubscriptionId: null, stripeExtraItemId: null, stripePlanItemId: null }, { merge: true });
  return { ok: true };
}

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  const action = String(req.query.action || "");
  const db = initAdmin();

  // ── Webhook de Stripe (sin token de usuario: firma HMAC) ──
  if (action === "webhook") {
    if (req.method !== "POST") return res.status(405).end();
    const raw = await readRaw(req);
    const cfg = (await db.doc("system/stripe").get()).data() || {};
    const secret = process.env.STRIPE_WEBHOOK_SECRET || cfg.webhookSecret;
    if (!secret || !verifyStripeSig(raw, req.headers["stripe-signature"], secret)) return res.status(400).json({ error: "firma inválida" });
    let ev; try { ev = JSON.parse(raw); } catch { return res.status(400).json({ error: "json" }); }
    try {
      const obj = ev.data?.object || {};
      if (ev.type === "invoice.paid") await procesarInvoicePaid(db, obj);
      else if (ev.type === "customer.subscription.updated" || ev.type === "customer.subscription.deleted") {
        const uid = obj.metadata?.uid;
        if (uid) {
          const borrada = ev.type === "customer.subscription.deleted" || obj.status === "canceled";
          await db.collection("users").doc(uid).set(borrada
            ? { stripeStatus: "canceled", cancelAtPeriodEnd: false, stripeSubscriptionId: FieldValue.delete() }
            : { stripeStatus: obj.status || "active", cancelAtPeriodEnd: !!obj.cancel_at_period_end, ...(obj.metadata?.plan && PRECIOS[obj.metadata.plan] && obj.status === "active" ? { plan: obj.metadata.plan } : {}) },
            { merge: true });
        }
      } else if (ev.type === "invoice.payment_failed") {
        const meta = obj.subscription_details?.metadata || {};
        if (meta.uid) {
          await db.collection("users").doc(meta.uid).set({ stripeStatus: "past_due", stripePaymentFailedAt: new Date() }, { merge: true });
          const email = obj.customer_email || (await db.collection("users").doc(meta.uid).get()).data()?.email;
          if (email) await sendEmail({ to: email, subject: "No pudimos cobrar tu suscripción de Growith",
            html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6;color:#111"><p>El cobro de tu plan con la tarjeta guardada fue rechazado. Stripe lo va a reintentar en los próximos días.</p><p>Para no perder el acceso, actualizá la tarjeta desde Growith → Mi cuenta → Administrar suscripción.</p></div>` });
        }
      }
      return res.json({ received: true });
    } catch (e) { console.error("[stripe webhook]", ev.type, e.message); return res.status(500).json({ error: e.message }); }
  }

  // ── Acciones de usuario (token obligatorio y atado al uid) ──
  if (req.method !== "POST") return res.status(405).json({ error: "POST" });
  const body = await new Promise(resolve => { let d = ""; req.on("data", c => d += c); req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } }); });
  const uid = String(body.uid || req.query.uid || "");
  if (!uid) return res.status(401).json({ error: "Falta uid" });
  const auth = await guardUid(req, res, uid);
  if (!auth) return;
  if (auth.viaTeam) return res.status(403).json({ error: "Solo el dueño de la cuenta puede gestionar la suscripción." });
  const userRef = db.collection("users").doc(uid);
  const u = (await userRef.get()).data() || {};
  const origin = SITE;

  try {
    if (action === "checkout") {
      const plan = PRECIOS[body.plan] ? body.plan : null;
      const periodo = body.periodo === "anual" ? "anual" : "mensual";
      if (!plan) return res.status(400).json({ error: "Plan inválido" });

      // Ya suscripto y activo: cambio de plan en el momento (prorrateo Stripe).
      if (u.stripeSubscriptionId) {
        const sub = await stripe("GET", `/subscriptions/${u.stripeSubscriptionId}`).catch(() => null);
        if (sub && ["active", "trialing", "past_due"].includes(sub.status)) {
          const itemId = sub.items?.data?.[0]?.id;
          if (sub.metadata?.plan === plan && sub.metadata?.periodo === periodo && !sub.cancel_at_period_end) return res.json({ already: true });
          const upd = await stripe("POST", `/subscriptions/${sub.id}`, {
            items: [{ id: itemId, price_data: priceData(plan, periodo) }],
            proration_behavior: "always_invoice", cancel_at_period_end: false,
            metadata: { uid, plan, periodo },
          });
          await userRef.set({ plan, cancelAtPeriodEnd: false, stripeStatus: upd.status || "active", ...(upd.current_period_end ? { planExpiry: new Date(upd.current_period_end * 1000) } : {}), planActivadoBy: "stripe", planActivadoAt: new Date() }, { merge: true });
          // El precio de la tienda adicional depende del plan → re-preciar el ítem extra.
          try { await syncTiendasExtra(db, uid); } catch (e) { console.warn("[stripe] sync extra tras cambio de plan:", e.message); }
          return res.json({ changed: true, plan, periodo });
        }
      }

      await ensureSetup(db);
      // Cliente Stripe (uno por cuenta)
      let customer = u.stripeCustomerId || null;
      if (customer) { const c = await stripe("GET", `/customers/${customer}`).catch(() => null); if (!c || c.deleted) customer = null; }
      if (!customer) {
        const c = await stripe("POST", "/customers", { email: u.email || undefined, name: u.nombre || u.displayName || undefined, metadata: { uid } });
        customer = c.id; await userRef.set({ stripeCustomerId: customer }, { merge: true });
      }
      // Crédito de referidos: cupón de una sola vez por el monto acumulado
      const p = precioDe(plan, periodo);
      const cred = +Math.min(Number(u.refCreditUsd) || 0, p.unit).toFixed(2);
      let discounts;
      if (cred > 0) {
        const coupon = await stripe("POST", "/coupons", { amount_off: Math.round(cred * 100), currency: "usd", duration: "once", name: "Crédito de referidos", max_redemptions: 1 });
        discounts = [{ coupon: coupon.id }];
      }
      const session = await stripe("POST", "/checkout/sessions", {
        mode: "subscription", customer, locale: "es",
        line_items: [
          { price_data: priceData(plan, periodo), quantity: 1 },
          // Tiendas adicionales del perfil (multi-tienda): un ítem con cantidad.
          ...(tiendasExtraDe(u) > 0 ? [{ price_data: extraPriceData(plan, periodo), quantity: tiendasExtraDe(u) }] : []),
        ],
        ...(discounts ? { discounts } : { allow_promotion_codes: true }),
        subscription_data: { metadata: { uid, plan, periodo, refCreditAplicado: cred, email: u.email || "" } },
        metadata: { uid, plan, periodo },
        success_url: `${origin}/#/planes?stripe=ok`,
        cancel_url: `${origin}/#/planes?stripe=cancel`,
        billing_address_collection: "auto",
        customer_update: { address: "auto", name: "auto" },
      });
      return res.json({ url: session.url });
    }

    if (action === "portal") {
      if (!u.stripeCustomerId) return res.status(400).json({ error: "Todavía no tenés una suscripción con tarjeta." });
      const cfg = await ensureSetup(db);
      const s = await stripe("POST", "/billing_portal/sessions", { customer: u.stripeCustomerId, return_url: `${origin}/#/config`, ...(cfg.portalConfigId ? { configuration: cfg.portalConfigId } : {}) });
      return res.json({ url: s.url });
    }

    if (action === "cancel") {
      if (!u.stripeSubscriptionId) return res.status(400).json({ error: "No hay suscripción con tarjeta activa." });
      const reactivar = !!body.reactivar;
      const sub = await stripe("POST", `/subscriptions/${u.stripeSubscriptionId}`, { cancel_at_period_end: !reactivar });
      await userRef.set({ cancelAtPeriodEnd: !!sub.cancel_at_period_end, stripeStatus: sub.status || "active" }, { merge: true });
      return res.json({ ok: true, cancelAtPeriodEnd: !!sub.cancel_at_period_end, periodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null });
    }

    return res.status(400).json({ error: "Acción desconocida" });
  } catch (e) {
    console.error(`[stripe] ${action}:`, e.message);
    return res.status(502).json({ error: e.message });
  }
}
