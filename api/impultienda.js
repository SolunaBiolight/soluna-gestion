// Impultienda en Growith (24/oct/2026): ventas de tiendas de productos digitales
// por webhook, comisiones reales de Stripe (clave restringida de solo lectura del
// usuario) y ganancia POR HORA en hora Argentina (00:00 ART = día nuevo).
//
// Impultienda no tiene API REST: manda webhooks firmados (doc: impultienda.ar/docs/webhooks)
//   headers X-Impultienda-Signature = HMAC-SHA256 hex de "{X-Impultienda-Timestamp}.{cuerpo crudo}"
//   idempotencia por payload.id (los reintentos reenvían el mismo id)
//   "Probar" del panel manda test:true y order_id "TEST-…" → no se guarda.
//
// Firestore (todo server-only):
//   impultienda_hooks/{hookKey}            {uid, creado}       — la URL del webhook lleva hookKey (no adivinable)
//   users/{uid}/impultienda_cfg/main       {hookKey, secretEnc, stripeEnc, feePct, feeFijo, paises:{store_id:"IT"}}
//   users/{uid}/impultienda_orders/{order_id}  la orden (último payload + fechas de cada evento + stripe)
//   impultienda_deliveries/{payload.id}    {uid, at} — dedupe de entregas
//
// NO es api/stripe.js (ese es la facturación de Growith): esta conexión es del usuario, para SUS cobros.

import crypto from "crypto";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { guardUid } from "./_auth.js";
import { getValidMLToken } from "./integrations.js";

export const config = { api: { bodyParser: false } };

function initAdmin() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
      }),
    });
  }
  return getFirestore();
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ── Cifrado de secretos (clave de firma del webhook, clave de Stripe) ──
// AES-256-GCM con una clave derivada de una variable que ya existe en Vercel.
function clave() { return crypto.createHash("sha256").update(String(process.env.FIREBASE_PRIVATE_KEY || "") + "|impultienda-v1").digest(); }
function cifrar(txt) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", clave(), iv);
  const enc = Buffer.concat([c.update(String(txt), "utf8"), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}
function descifrar(s) {
  try {
    const [iv, tag, enc] = String(s || "").split(".").map(x => Buffer.from(x, "base64"));
    const d = crypto.createDecipheriv("aes-256-gcm", clave(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
  } catch (_) { return null; }
}

// ── Hora Argentina (UTC−3, sin horario de verano) ──
const ART_MS = 3 * 3600000;
// Fecha y hora de un instante en una zona IANA cualquiera (la del usuario).
export function zonaDe(iso, tz) {
  const t = Date.parse(iso); if (!isFinite(t)) return null;
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" }).formatToParts(new Date(t));
  const g = k => p.find(x => x.type === k).value;
  return { fecha: `${g("year")}-${g("month")}-${g("day")}`, hora: parseInt(g("hour"), 10) };
}
export const tzValida = (tz) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } };
export function artDe(iso) { const t = Date.parse(iso); if (!isFinite(t)) return null; const d = new Date(t - ART_MS).toISOString(); return { fecha: d.slice(0, 10), hora: parseInt(d.slice(11, 13), 10) }; }
const hoyART = () => new Date(Date.now() - ART_MS).toISOString().slice(0, 10);
const addDias = (ymd, n) => new Date(Date.parse(ymd + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
// Instante UTC de "fecha hora:00" en una zona horaria IANA (para las horas de Meta).
export function utcDeLocal(fecha, hora, tz) {
  const guess = Date.parse(`${fecha}T${String(hora).padStart(2, "0")}:00:00Z`);
  const off = (ms) => {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms));
    const g = k => parseInt(p.find(x => x.type === k).value, 10);
    return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute")) - ms;
  };
  let t = guess - off(guess);
  t = guess - off(t); // segunda pasada por si el cambio de horario cae en el medio
  return t;
}

// ── Monedas → USD (open.er-api.com, sin clave, caché 6 h en memoria) ──
let _fx = null, _fxAt = 0;
async function fxPorUsd() {
  if (_fx && Date.now() - _fxAt < 6 * 3600000) return _fx;
  try { const j = await (await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(6000) })).json(); if (j?.rates) { _fx = j.rates; _fxAt = Date.now(); } } catch (_) {}
  return _fx || { USD: 1 };
}
const aUsd = (monto, cur, fx) => { const c = String(cur || "USD").toUpperCase(); if (c === "USD") return monto; const r = fx?.[c]; return r ? monto / r : null; };

// ── Webhook ──
async function webhook(req, res, db) {
  const raw = await readBody(req);
  const hookKey = String(req.query.k || "");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(hookKey)) return res.status(404).json({ ok: false });
  const h = await db.collection("impultienda_hooks").doc(hookKey).get();
  if (!h.exists) return res.status(404).json({ ok: false, reason: "endpoint_desconocido" });
  const uid = h.data().uid;
  const cfg = (await db.collection("users").doc(uid).collection("impultienda_cfg").doc("main").get()).data() || {};
  const secret = descifrar(cfg.secretEnc);
  if (!secret) return res.status(401).json({ ok: false, reason: "falta_clave_de_firma" });
  const ts = String(req.headers["x-impultienda-timestamp"] || "");
  const sig = String(req.headers["x-impultienda-signature"] || "");
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return res.status(401).json({ ok: false, reason: "timestamp" });
  const esperada = crypto.createHmac("sha256", secret).update(ts + "." + raw.toString("utf8")).digest("hex");
  if (sig.length !== esperada.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperada))) return res.status(401).json({ ok: false, reason: "firma" });
  let p; try { p = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).json({ ok: false, reason: "json" }); }
  const d = p?.data || {};
  if (p.test === true || d.test === true || String(d.order_id || "").startsWith("TEST-")) {
    await db.collection("users").doc(uid).collection("impultienda_cfg").doc("main").set({ ultimaPrueba: new Date().toISOString() }, { merge: true });
    return res.status(200).json({ ok: true, test: true });
  }
  if (!d.order_id || !p.event) return res.status(200).json({ ok: false, reason: "sin_orden" });
  // Dedupe por id de entrega (los reintentos reenvían el mismo payload.id).
  const delRef = db.collection("impultienda_deliveries").doc(String(p.id || `${d.order_id}_${p.event}`).slice(0, 200));
  const nueva = await db.runTransaction(async tx => { const s = await tx.get(delRef); if (s.exists) return false; tx.set(delRef, { uid, at: new Date() }); return true; });
  if (!nueva) return res.status(200).json({ ok: true, duplicado: true });
  const ev = String(p.event).replace(/^order\./, "");
  const cuando = p.created_at || new Date().toISOString();
  const orden = {
    order_id: String(d.order_id), orden: d.order_number ?? null,
    store_id: d.store?.id || null, store_nombre: d.store?.name || null,
    estado: d.status || ev, total: Number(d.total) || 0, moneda: d.currency || "USD",
    buyer_total: d.buyer_total ?? null, buyer_moneda: d.buyer_currency || null,
    pais: d.buyer_country || null, pasarela: d.payment_method || null,
    email: String(d.customer?.email || "").toLowerCase() || null,
    nombre: [d.customer?.name, d.customer?.last_name].filter(Boolean).join(" ") || null,
    dni: d.customer?.tax_id || null,
    post_compra: !!d.is_post_purchase, orden_original: d.parent_order_id || null,
    creada_utc: d.order_created_at || null,
    items: (d.items || []).map(i => ({ id: i.product_id, nombre: i.name, precio: i.price, cant: i.quantity, tipo: i.type })),
    utm: d.tracking || null,
    actualizado: new Date().toISOString(),
    [`ev_${ev}`]: cuando,
  };
  await db.collection("users").doc(uid).collection("impultienda_orders").doc(String(d.order_id)).set(orden, { merge: true });
  return res.status(200).json({ ok: true });
}

// ── Meta: gasto por hora ART ──
async function metaPorHora(db, uid, desde, hasta, elegidas = [], tzU = "America/Argentina/Buenos_Aires") {
  const snap = await db.collection("users").doc(uid).collection("meta_accounts").get();
  const tokens = [...new Set(snap.docs.map(d => d.data()?.access_token).filter(Boolean))];
  const out = {}; // "fecha|hora|campaña" → usd
  const errores = [];
  let sinHora = 0;
  const vistas = new Set();
  const metaDice = {}; // campaign_id → {compras, valor} según el píxel de Meta (su atribución, su zona horaria)
  const fx = await fxPorUsd();
  for (const tk of tokens) {
    let cuentas = [];
    try {
      const r = await (await fetch(`https://graph.facebook.com/v23.0/me/adaccounts?fields=account_id,currency,timezone_name&limit=200&access_token=${encodeURIComponent(tk)}`)).json();
      cuentas = r.data || [];
    } catch (e) { errores.push(e.message); }
    for (const c of cuentas) {
      const id = "act_" + c.account_id;
      if (vistas.has(id)) continue; vistas.add(id);
      if (elegidas.length && !elegidas.includes(id)) continue;
      const tz = c.timezone_name || "America/Los_Angeles";
      // El día ART empieza en otra hora de la zona de la cuenta: se pide un día de margen.
      const since = addDias(desde, -1), until = addDias(hasta, 1);
      let url = `https://graph.facebook.com/v23.0/${id}/insights?level=campaign&fields=spend,campaign_name,campaign_id&time_increment=1&breakdowns=hourly_stats_aggregated_by_advertiser_time_zone&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}&limit=500&access_token=${encodeURIComponent(tk)}`;
      const porDiaLocal = {};
      try {
        for (let i = 0; url && i < 20; i++) {
          const r = await (await fetch(url)).json();
          if (r.error) { errores.push(`${id}: ${r.error.message}`); break; }
          for (const row of r.data || []) {
            const hh = parseInt(String(row.hourly_stats_aggregated_by_advertiser_time_zone || "").slice(0, 2), 10);
            const usd = aUsd(Number(row.spend) || 0, c.currency, fx);
            if (!isFinite(hh) || usd == null) continue;
            const a = zonaDe(new Date(utcDeLocal(row.date_start, hh, tz)).toISOString(), tzU);
            const k = `${a.fecha}|${a.hora}|${String(row.campaign_name || "").replace(/\|/g, "/")}|${row.campaign_id || ""}`;
            out[k] = (out[k] || 0) + usd;
            porDiaLocal[row.date_start] = (porDiaLocal[row.date_start] || 0) + usd;
          }
          url = r.paging?.next || null;
        }
        // Lo que Meta dice que vendió cada campaña (píxel), para comparar con la venta real.
        try {
          const rr = await (await fetch(`https://graph.facebook.com/v23.0/${id}/insights?level=campaign&fields=campaign_id,actions,action_values&time_range=${encodeURIComponent(JSON.stringify({ since: desde, until: hasta }))}&limit=500&access_token=${encodeURIComponent(tk)}`)).json();
          for (const row of rr.data || []) {
            const pick = (arr) => { const a = (arr || []).find(x => x.action_type === "purchase") || (arr || []).find(x => x.action_type === "offsite_conversion.fb_pixel_purchase"); return a ? Number(a.value) || 0 : 0; };
            metaDice[row.campaign_id] = { compras: pick(row.actions), valor: aUsd(pick(row.action_values), c.currency, fx) || 0 };
          }
        } catch (_) {}
        // Trampa conocida: el desglose horario puede no traer todavía las horas de HOY
        // (zona de la cuenta). Se compara con el gasto del día y la diferencia va a la
        // hora ART actual, marcada como "sin hora exacta".
        const hoyLocal = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
        const r2 = await (await fetch(`https://graph.facebook.com/v23.0/${id}/insights?level=account&fields=spend&time_range=${encodeURIComponent(JSON.stringify({ since: hoyLocal, until: hoyLocal }))}&access_token=${encodeURIComponent(tk)}`)).json();
        const totalHoy = aUsd(Number(r2.data?.[0]?.spend) || 0, c.currency, fx) || 0;
        const falta = totalHoy - (porDiaLocal[hoyLocal] || 0);
        if (falta > 0.01) {
          const a = zonaDe(new Date().toISOString(), tzU);
          if (a.fecha >= desde && a.fecha <= hasta) { const k = `${a.fecha}|${a.hora}||`; out[k] = (out[k] || 0) + falta; sinHora += falta; }
        }
      } catch (e) { errores.push(`${id}: ${e.message}`); }
    }
  }
  return { porHora: out, sinHora, cuentas: vistas.size, errores, metaDice };
}

// ── Stripe: comisión real por venta ──
// Cruce: balance_transaction (type charge) con el cargo expandido → email del
// comprador + monto + ±10 min de la aprobación. Ambiguo o sin cruce = estimada.
async function stripeComisiones(db, uid, cfg, ordenes, desdeMs, hastaMs) {
  const key = descifrar(cfg.stripeEnc);
  if (!key) return { conectado: false };
  const txs = [];
  let url = `https://api.stripe.com/v1/balance_transactions?limit=100&type=charge&created[gte]=${Math.floor(desdeMs / 1000) - 900}&created[lte]=${Math.floor(hastaMs / 1000) + 900}&expand[]=data.source`;
  try {
    for (let i = 0; i < 30; i++) {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
      const j = await r.json();
      if (j.error) return { conectado: true, error: j.error.message };
      txs.push(...(j.data || []));
      if (!j.has_more || !j.data?.length) break;
      url = url.replace(/&starting_after=[^&]*/, "") + `&starting_after=${j.data[j.data.length - 1].id}`;
    }
  } catch (e) { return { conectado: true, error: e.message }; }
  const fx = await fxPorUsd();
  const usados = new Set();
  let cruzadas = 0;
  const batch = db.batch(); let escrituras = 0;
  for (const o of ordenes) {
    if (o.stripe?.bt) { usados.add(o.stripe.bt); cruzadas++; continue; }
    if (o.pasarela && o.pasarela !== "stripe" && o.pasarela !== "card") continue;
    const tAp = Date.parse(o.ev_approved || "");
    if (!isFinite(tAp)) continue;
    const cand = txs.filter(t => {
      if (usados.has(t.id)) return false;
      const ch = t.source || {};
      const mail = String(ch.billing_details?.email || ch.receipt_email || "").toLowerCase();
      if (o.email && mail && mail !== o.email) return false;
      if (Math.abs(t.created * 1000 - tAp) > 10 * 60000) return false;
      const montoCh = (ch.amount || 0) / 100, curCh = String(ch.currency || "").toUpperCase();
      const esperado = curCh === String(o.buyer_moneda || "").toUpperCase() && o.buyer_total != null ? Number(o.buyer_total) : (curCh === String(o.moneda || "").toUpperCase() ? o.total : null);
      return esperado == null ? false : Math.abs(montoCh - esperado) <= Math.max(0.02, esperado * 0.01);
    });
    if (cand.length !== 1) continue;
    const t = cand[0]; usados.add(t.id);
    const fee = aUsd(t.fee / 100, t.currency, fx);
    if (fee == null) continue;
    o.stripe = { bt: t.id, fee, at: new Date().toISOString() };
    batch.set(db.collection("users").doc(uid).collection("impultienda_orders").doc(o.order_id), { stripe: o.stripe }, { merge: true });
    escrituras++; cruzadas++;
  }
  if (escrituras) await batch.commit().catch(() => {});
  return { conectado: true, cruzadas, transacciones: txs.length };
}

// ── Mercado Pago: comisión real por venta (cuenta conectada como "Mercado Pago") ──
async function mpComisiones(db, uid, ordenes, desdeMs, hastaMs) {
  const deMp = ordenes.filter(o => o.pasarela === "mercadopago" && !o.mp?.id);
  if (!deMp.length) return { conectado: null };
  let tok = null;
  try { tok = await getValidMLToken(db, uid); } catch (_) {}
  if (!tok?.accessToken) return { conectado: false };
  const pagos = [];
  try {
    for (let off = 0; off < 2000; off += 100) {
      const u = `https://api.mercadopago.com/v1/payments/search?status=approved&sort=date_created&criteria=desc&range=date_created&begin_date=${encodeURIComponent(new Date(desdeMs - 900000).toISOString())}&end_date=${encodeURIComponent(new Date(hastaMs + 900000).toISOString())}&limit=100&offset=${off}`;
      const j = await (await fetch(u, { headers: { Authorization: `Bearer ${tok.accessToken}` } })).json();
      pagos.push(...(j.results || []));
      if (!j.results || j.results.length < 100) break;
    }
  } catch (e) { return { conectado: true, error: e.message }; }
  const fx = await fxPorUsd();
  const usados = new Set(); let cruzadas = 0;
  const batch = db.batch(); let n = 0;
  for (const o of deMp) {
    const tAp = Date.parse(o.ev_approved || ""); if (!isFinite(tAp)) continue;
    const cand = pagos.filter(p => {
      if (usados.has(p.id)) return false;
      if (Math.abs(Date.parse(p.date_approved || p.date_created) - tAp) > 10 * 60000) return false;
      const mail = String(p.payer?.email || "").toLowerCase();
      if (o.email && mail && mail !== o.email) return false;
      const cur = String(p.currency_id || "").toUpperCase();
      const esperado = cur === String(o.buyer_moneda || "").toUpperCase() && o.buyer_total != null ? Number(o.buyer_total) : (cur === String(o.moneda || "").toUpperCase() ? o.total : null);
      return esperado != null && Math.abs(Number(p.transaction_amount) - esperado) <= Math.max(1, esperado * 0.01);
    });
    if (cand.length !== 1) continue;
    const p = cand[0]; usados.add(p.id);
    const fee = (p.fee_details || []).filter(fd => fd.fee_payer !== "payer").reduce((a, fd) => a + (Number(fd.amount) || 0), 0);
    const usd = aUsd(fee, p.currency_id, fx); if (usd == null) continue;
    o.mp = { id: p.id, fee: usd };
    batch.set(db.collection("users").doc(uid).collection("impultienda_orders").doc(o.order_id), { mp: o.mp }, { merge: true }); n++; cruzadas++;
  }
  if (n) await batch.commit().catch(() => {});
  return { conectado: true, cruzadas, pagos: pagos.length };
}

// Tienda a la que va el gasto de una campaña: la que tiene su código de país en el
// nombre ("IT | Lumea…", "Lumea IT", "[PL]"). Si no matchea ninguna, "sin asignar".
export const paisesDe = (p) => String(p || "").toUpperCase().split(/[^A-Z]+/).filter(x => x.length === 2);
export function tiendaDeCampana(nombre, tiendas) {
  const toks = String(nombre || "").toUpperCase().split(/[^A-Z]+/).filter(Boolean);
  const hit = tiendas.filter(t => paisesDe(t.pais).some(p => toks.includes(p)));
  return hit.length === 1 ? hit[0].id : null;
}

// ── Atribución por UTM ──
// Cada venta trae las UTM con las que llegó el comprador. Orden de cruce con las
// campañas de Meta: utm_id = id de campaña ({{campaign.id}}) → utm_campaign igual
// al nombre de la campaña (normalizado) → código de país de la UTM ("lumea_it" →
// IT) contra una sola campaña con ese país en el nombre. Sin cruce = "sin campaña".
const norm = (x) => String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export function paisDeUtm(utm) {
  const m = /(?:^|[_\-\s|])([a-z]{2})$/i.exec(String(utm?.utm_campaign || "").trim());
  return m ? m[1].toUpperCase() : null;
}
export function campanaDeVenta(utm, campanas) {
  if (!utm) return null;
  if (utm.utm_id) { const c = campanas.find(c => c.id && String(c.id) === String(utm.utm_id)); if (c) return c.key; }
  if (utm.utm_campaign) {
    const u = norm(utm.utm_campaign);
    const c = campanas.find(c => norm(c.nombre) === u) || campanas.find(c => c.id && String(c.id) === String(utm.utm_campaign));
    if (c) return c.key;
    const pais = paisDeUtm(utm);
    if (pais) { const hit = campanas.filter(c => norm(c.nombre).split(" ").includes(pais.toLowerCase())); if (hit.length === 1) return hit[0].key; }
  }
  return null;
}

// ── Reporte por hora ──
export async function porHora(db, uid, desde, hasta, tz = "America/Argentina/Buenos_Aires") {
  if (!tzValida(tz)) tz = "America/Argentina/Buenos_Aires";
  const cfg = (await db.collection("users").doc(uid).collection("impultienda_cfg").doc("main").get()).data() || {};
  // El día va de 00:00 a 00:00 en la zona elegida.
  const desdeMs = utcDeLocal(desde, 0, tz), hastaMs = utcDeLocal(addDias(hasta, 1), 0, tz);
  // Órdenes tocadas en el rango o un poco antes (un reembolso de hoy puede ser de una venta vieja).
  const snap = await db.collection("users").doc(uid).collection("impultienda_orders").where("actualizado", ">=", new Date(desdeMs - 40 * 86400000).toISOString()).get();
  // Una orden importada se descarta si el webhook ya trajo la misma (tienda + número).
  const todas = snap.docs.map(d => d.data());
  const delWebhook = new Set(todas.filter(o => !o.importado && o.store_id && o.orden != null).map(o => `${o.store_id}|${o.orden}`));
  const ordenes = todas.filter(o => !o.importado || !delWebhook.has(`${o.store_id}|${o.orden}`));
  const fx = await fxPorUsd();
  const delRango = ordenes.filter(o => o.ev_approved && Date.parse(o.ev_approved) >= desdeMs && Date.parse(o.ev_approved) < hastaMs);
  const [stripe, mp] = await Promise.all([stripeComisiones(db, uid, cfg, delRango, desdeMs, hastaMs), mpComisiones(db, uid, delRango, desdeMs, hastaMs)]);
  const feePct = Number(cfg.feePct ?? 2.9), feeFijo = Number(cfg.feeFijo ?? 0.3);
  const paises = cfg.paises || {};
  const tiendasMap = {};
  for (const [id, t] of Object.entries(cfg.tiendasManual || {})) tiendasMap[id] = { id, nombre: t.nombre || id, pais: paises[id] || t.pais || null, votos: {} };
  const porNombre = {};
  for (const [id, t] of Object.entries(cfg.tiendasManual || {})) if (id.startsWith("n_")) porNombre[norm(t.nombre)] = id;
  for (const o of ordenes) { if (o.store_id && !tiendasMap[o.store_id] && porNombre[norm(o.store_nombre)]) o.store_id = porNombre[norm(o.store_nombre)]; }
  for (const o of ordenes) if (o.store_id && !tiendasMap[o.store_id]) tiendasMap[o.store_id] = { id: o.store_id, nombre: o.store_nombre || o.store_id, pais: paises[o.store_id] || null, votos: {} };
  // Sin país cargado: el que más se repite en las UTM de sus ventas (o la moneda/país del comprador).
  for (const o of ordenes) { const t = tiendasMap[o.store_id]; if (!t || t.pais) continue; const p = paisDeUtm(o.utm) || o.pais; if (p) t.votos[p] = (t.votos[p] || 0) + 1; }
  for (const t of Object.values(tiendasMap)) { if (!t.pais) { const top = Object.entries(t.votos).sort((a, b) => b[1] - a[1])[0]; if (top) { t.pais = top[0]; t.paisAuto = true; } } delete t.votos; }
  const filas = {}; // "fecha|hora|tienda"
  const fila = (fecha, hora, tienda) => { const k = `${fecha}|${hora}|${tienda}`; const t = tiendasMap[tienda]; return filas[k] || (filas[k] = { fecha, hora, tienda, tiendaNombre: t?.nombre || (tienda === "SIN_ASIGNAR" ? "Sin asignar" : tienda), pais: t?.pais || null, ventas: 0, n: 0, reembolsos: 0, comisiones: 0, comisionesEstimadas: 0, gasto: 0 }); };
  const ventasCamp = {};
  const enRango = (iso) => { const t = Date.parse(iso || ""); return isFinite(t) && t >= desdeMs && t < hastaMs; };
  const meta = await metaPorHora(db, uid, desde, hasta, cfg.metaCuentas || [], tz);
  const campIdx = {};
  for (const k of Object.keys(meta.porHora)) { const [, , nombre, id] = k.split("|"); if (nombre) campIdx[id || nombre] = { key: id || nombre, id: id || null, nombre }; }
  const campLista = Object.values(campIdx);
  for (const o of ordenes) {
    const tid = o.store_id || "SIN_TIENDA";
    const usd = aUsd(o.total, o.moneda, fx) ?? 0;
    if (enRango(o.ev_approved)) {
      const a = zonaDe(o.ev_approved, tz); const f = fila(a.fecha, a.hora, tid);
      f.ventas += usd; f.n += 1;
      const ck = campanaDeVenta(o.utm, campLista) || "SIN_CAMPANA";
      const cv = ventasCamp[ck] || (ventasCamp[ck] = { ventas: 0, n: 0, comisiones: 0, anuncios: {} });
      cv.ventas += usd; cv.n += 1;
      const ad = String(o.utm?.utm_content || "sin anuncio").slice(0, 80);
      const av = cv.anuncios[ad] || (cv.anuncios[ad] = { anuncio: ad, ventas: 0, n: 0 }); av.ventas += usd; av.n += 1;
      const real = o.stripe?.fee ?? o.mp?.fee;
      const com = real != null ? real : usd * feePct / 100 + feeFijo;
      f.comisiones += com; if (real == null) f.comisionesEstimadas += com;
      cv.comisiones += com;
    }
    // Reembolso y contracargo restan cuando ocurren (solo si la venta se había aprobado).
    for (const ev of ["ev_refunded", "ev_chargeback"]) {
      if (o.ev_approved && enRango(o[ev])) { const a = zonaDe(o[ev], tz); fila(a.fecha, a.hora, tid).reembolsos += usd; }
    }
  }

  const tiendasLista = Object.values(tiendasMap);
  const campanas = {};
  for (const [k, usd] of Object.entries(meta.porHora)) {
    const [fecha, hora, camp, cid] = k.split("|");
    if (fecha < desde || fecha > hasta) continue;
    const tid = tiendaDeCampana(camp, tiendasLista) || "SIN_ASIGNAR";
    fila(fecha, parseInt(hora, 10), tid).gasto += usd;
    if (camp) { const key = cid || camp; const c = campanas[key] || (campanas[key] = { key, id: cid || null, nombre: camp, tienda: tid, gasto: 0 }); c.gasto += usd; }
  }
  for (const [ck, v] of Object.entries(ventasCamp)) {
    const c = campanas[ck] || (campanas[ck] = { key: ck, id: null, nombre: ck === "SIN_CAMPANA" ? "Sin campaña (venta sin UTM que cruce)" : ck, tienda: null, gasto: 0 });
    c.ventas = v.ventas; c.n = v.n; c.comisiones = v.comisiones;
    c.anuncios = Object.values(v.anuncios).sort((a, b) => b.ventas - a.ventas);
  }
  for (const c of Object.values(campanas)) { if (c.id && meta.metaDice?.[c.id]) c.metaDice = meta.metaDice[c.id];
    c.ventas = c.ventas || 0; c.n = c.n || 0; c.comisiones = c.comisiones || 0; c.ganancia = c.ventas - c.comisiones - c.gasto; c.roas = c.gasto ? c.ventas / c.gasto : null; c.cpa = c.n && c.gasto ? c.gasto / c.n : null; }
  const lista = Object.values(filas).map(f => ({ ...f, ganancia: f.ventas - f.reembolsos - f.comisiones - f.gasto }));
  lista.sort((a, b) => (a.fecha + String(a.hora).padStart(2, "0")).localeCompare(b.fecha + String(b.hora).padStart(2, "0")) || a.tienda.localeCompare(b.tienda));
  const tot = lista.reduce((t, f) => { for (const k of ["ventas", "n", "reembolsos", "comisiones", "comisionesEstimadas", "gasto"]) t[k] += f[k]; return t; }, { ventas: 0, n: 0, reembolsos: 0, comisiones: 0, comisionesEstimadas: 0, gasto: 0 });
  tot.ganancia = tot.ventas - tot.reembolsos - tot.comisiones - tot.gasto;
  tot.roas = tot.gasto ? tot.ventas / tot.gasto : null;
  tot.cpa = tot.n ? tot.gasto / tot.n : null;
  return { desde, hasta, zona: tz, filas: lista, totales: tot, tiendas: tiendasLista, campanas: Object.values(campanas).sort((a, b) => (b.ventas + b.gasto) - (a.ventas + a.gasto)), meta: { cuentas: meta.cuentas, sinHora: meta.sinHora, errores: meta.errores }, stripe, mp, generado: new Date().toISOString() };
}

export default async function handler(req, res) {
  const db = initAdmin();
  const action = String(req.query.action || "");
  if (action === "webhook") {
    if (req.method !== "POST") {
      // Abierto en el navegador: explicar en vez de tirar un 405 pelado.
      const ok = /^[A-Za-z0-9_-]{16,64}$/.test(String(req.query.k || "")) && (await db.collection("impultienda_hooks").doc(String(req.query.k)).get()).exists;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Inter,system-ui,sans-serif;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px"><div style="max-width:460px;line-height:1.6"><h2 style="margin:0 0 8px">${ok ? "✓ Este link funciona" : "Link no reconocido"}</h2><p style="color:#9da7b3">${ok ? "No hay que abrirlo en el navegador: pegalo en Impultienda → Configuraciones → Webhooks → Agregar endpoint, con los eventos order.approved, order.refunded y order.chargeback. Después pegá en Growith la clave de firma que te da Impultienda y tocá «Probar»." : "Copiá de nuevo la URL desde Growith → Dashboard → Conexión."}</p></div></body>`);
    }
    try { return await webhook(req, res, db); } catch (e) { console.error("[impultienda webhook]", e.message); return res.status(500).json({ ok: false }); }
  }
  const uid = String(req.query.uid || "");
  if (!(await guardUid(req, res, uid, "margenes"))) return;
  const cfgRef = db.collection("users").doc(uid).collection("impultienda_cfg").doc("main");
  try {
    if (action === "config") {
      let cfg = (await cfgRef.get()).data() || {};
      if (!cfg.hookKey) {
        const k = crypto.randomBytes(18).toString("base64url");
        await db.collection("impultienda_hooks").doc(k).set({ uid, creado: new Date() });
        await cfgRef.set({ hookKey: k }, { merge: true });
        cfg.hookKey = k;
      }
      const host = req.headers["x-forwarded-host"] || req.headers.host || "www.growithapp.com";
      const tiendas = {};
      for (const [id, t] of Object.entries(cfg.tiendasManual || {})) tiendas[id] = { nombre: t.nombre, pais: (cfg.paises || {})[id] || t.pais || null };
      const os = await db.collection("users").doc(uid).collection("impultienda_orders").orderBy("actualizado", "desc").limit(300).get();
      for (const d of os.docs) { const o = d.data(); if (o.store_id && !tiendas[o.store_id]) tiendas[o.store_id] = { nombre: o.store_nombre, pais: (cfg.paises || {})[o.store_id] || null }; }
      return res.json({
        url: `https://${host}/api/impultienda?action=webhook&k=${cfg.hookKey}`,
        tieneFirma: !!cfg.secretEnc, tieneStripe: !!cfg.stripeEnc,
        feePct: cfg.feePct ?? 2.9, feeFijo: cfg.feeFijo ?? 0.3,
        paises: cfg.paises || {}, tiendas, ordenes: os.size, ultimaPrueba: cfg.ultimaPrueba || null,
      });
    }
    if (action === "meta_cuentas") {
      const snap = await db.collection("users").doc(uid).collection("meta_accounts").get();
      const tokens = [...new Set(snap.docs.map(d => d.data()?.access_token).filter(Boolean))];
      const cuentas = new Map();
      for (const tk of tokens) {
        try { const r = await (await fetch(`https://graph.facebook.com/v23.0/me/adaccounts?fields=account_id,name,currency,amount_spent&limit=200&access_token=${encodeURIComponent(tk)}`)).json(); for (const a of r.data || []) cuentas.set("act_" + a.account_id, { id: "act_" + a.account_id, nombre: a.name, moneda: a.currency }); } catch (_) {}
      }
      const cfg = (await cfgRef.get()).data() || {};
      return res.json({ cuentas: [...cuentas.values()].sort((a, b) => String(a.nombre).localeCompare(String(b.nombre))), elegidas: cfg.metaCuentas || [] });
    }
    // Importación de ventas pasadas (antes de conectar el webhook): la lista que da
    // el conector de Impultienda (impultienda_listar_ventas) — orden, fecha UTC, total,
    // moneda, pasarela, post_compra. Sin UTM ni comprador: entran a su tienda pero no
    // a una campaña. Doc id propio (imp_<tienda>_<orden>) y porHora descarta la
    // importada si el webhook ya trajo esa misma orden.
    if (action === "importar" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)).toString() || "{}");
      const sid = String(b.store_id || ""); if (!/^[0-9a-f-]{20,40}$/i.test(sid)) return res.status(400).json({ error: "store_id inválido" });
      const ventas = Array.isArray(b.ventas) ? b.ventas.slice(0, 2000) : [];
      let n = 0; let batch = db.batch(); let enBatch = 0;
      for (const v of ventas) {
        const orden = Number(v.orden); const t = Date.parse(v.fecha || "");
        if (!orden || !isFinite(t)) continue;
        const doc = db.collection("users").doc(uid).collection("impultienda_orders").doc(`imp_${sid}_${orden}`);
        batch.set(doc, {
          order_id: `imp_${sid}_${orden}`, orden, store_id: sid, store_nombre: String(b.store_nombre || "").slice(0, 80) || null,
          estado: "approved", total: Number(v.total) || 0, moneda: String(v.moneda || "USD").toUpperCase(),
          pasarela: v.metodo_pago || null, post_compra: !!v.post_compra, importado: true,
          ev_approved: new Date(t).toISOString(), actualizado: new Date().toISOString(),
        }, { merge: true });
        n++; enBatch++;
        if (enBatch >= 400) { await batch.commit(); batch = db.batch(); enBatch = 0; }
      }
      if (enBatch) await batch.commit();
      // borrar las cachés de reportes para que se vea al toque
      const cs = await cfgRef.parent.get(); const bd = db.batch(); let k = 0;
      for (const d of cs.docs) if (d.id.startsWith("cache_")) { bd.delete(d.ref); k++; }
      if (k) await bd.commit();
      return res.json({ ok: true, importadas: n });
    }
    if (action === "conectar" && req.method === "POST") {
      // Una tienda Impultienda es SOLO Impultienda + Mercado Pago y/o Stripe:
      // no convive con Tienda Nube, Shopify ni Mercado Libre en la misma tienda de Growith.
      const uref = db.collection("users").doc(uid);
      const stores = (await uref.get()).data()?.stores || [];
      const otra = stores.find(x => ["tiendanube", "shopify", "mercadolibre", "meli"].includes(x.type));
      if (otra) return res.status(409).json({ error: `Esta tienda ya tiene ${otra.type === "tiendanube" ? "Tienda Nube" : otra.type === "shopify" ? "Shopify" : "Mercado Libre"} conectada. Impultienda va en una tienda aparte: creala desde el selector de tiendas y conectala ahí.` });
      if (!stores.some(x => x.type === "impultienda")) await uref.set({ stores: [...stores, { type: "impultienda", storeName: "Impultienda", conectadaAt: new Date().toISOString() }] }, { merge: true });
      return res.json({ ok: true });
    }
    if (action === "config_set" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)).toString() || "{}");
      const patch = {};
      if (typeof b.secret === "string" && b.secret.trim()) patch.secretEnc = cifrar(b.secret.trim());
      if (typeof b.stripe_key === "string" && b.stripe_key.trim()) {
        const k = b.stripe_key.trim();
        if (!/^(rk|sk)_(live|test)_/.test(k)) return res.status(400).json({ error: "Esa no parece una clave de Stripe (empieza con rk_live_…)." });
        const r = await fetch("https://api.stripe.com/v1/balance_transactions?limit=1", { headers: { Authorization: `Bearer ${k}` } });
        if (!r.ok) { const j = await r.json().catch(() => ({})); return res.status(400).json({ error: `Stripe rechazó la clave: ${j.error?.message || r.status}. Tiene que tener permiso de lectura de Balance transactions y Charges.` }); }
        patch.stripeEnc = cifrar(k);
        // Bandera visible en el doc de la tienda (la clave NO: vive cifrada en impultienda_cfg).
        await db.collection("users").doc(uid).set({ stripeCobros: { conectado: true, at: new Date().toISOString(), modo: k.includes("_test_") ? "test" : "live" } }, { merge: true });
      }
      if (b.stripe_key === null) { patch.stripeEnc = FieldValue.delete(); await db.collection("users").doc(uid).set({ stripeCobros: FieldValue.delete() }, { merge: true }); }
      if (b.feePct != null && isFinite(Number(b.feePct))) patch.feePct = Number(b.feePct);
      if (b.feeFijo != null && isFinite(Number(b.feeFijo))) patch.feeFijo = Number(b.feeFijo);
      if (b.paises && typeof b.paises === "object") patch.paises = Object.fromEntries(Object.entries(b.paises).map(([k, v]) => [String(k), paisesDe(v).join(" ").slice(0, 20)]).filter(([, v]) => v));
      // Cuentas publicitarias que cuentan para esta tienda (vacío = todas).
      if (Array.isArray(b.metaCuentas)) patch.metaCuentas = b.metaCuentas.map(String).filter(x => /^act_\d+$/.test(x)).slice(0, 100);
      // Tiendas precargadas a mano (Impultienda no lista tiendas por API): {store_id: {nombre, pais}}
      if (b.tiendas && typeof b.tiendas === "object") {
        const tm = {};
        const prev = (await cfgRef.get()).data()?.tiendasManual || {};
        Object.assign(tm, b.reemplazar ? {} : prev);
        for (const [id0, t] of Object.entries(b.tiendas)) {
          if (t === null) { delete tm[id0]; continue; }
          const nombre = String(t?.nombre || "").trim().slice(0, 80);
          const id = /^[0-9a-f-]{20,40}$/i.test(id0) ? id0 : (nombre ? "n_" + norm(nombre).replace(/ /g, "_").slice(0, 60) : null);
          if (!id) continue;
          tm[id] = { nombre: nombre || id, pais: paisesDe(t?.pais).join(" ").slice(0, 20) || null };
        }
        patch.tiendasManual = tm;
        patch.paises = { ...(patch.paises || {}), ...Object.fromEntries(Object.entries(tm).filter(([, t]) => t.pais).map(([id, t]) => [id, t.pais])) };
      }
      await cfgRef.set(patch, { merge: true });
      return res.json({ ok: true });
    }
    if (action === "por_hora") {
      const tz = tzValida(String(req.query.tz || "")) ? String(req.query.tz) : "America/Argentina/Buenos_Aires";
      const hoy = zonaDe(new Date().toISOString(), tz).fecha;
      const desde = /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde || "") ? req.query.desde : hoy;
      const hasta = /^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta || "") ? req.query.hasta : desde;
      if (Date.parse(hasta) - Date.parse(desde) > 31 * 86400000) return res.status(400).json({ error: "Máximo 31 días." });
      // Caché de 10 minutos por rango (fresh=1 la saltea).
      const cacheRef = db.collection("users").doc(uid).collection("impultienda_cfg").doc(`cache_${desde}_${hasta}_${tz.replace(/\//g, "-")}`);
      if (req.query.fresh !== "1") {
        const c = await cacheRef.get();
        if (c.exists && Date.now() - (c.data().ts || 0) < 10 * 60000) return res.json({ ...JSON.parse(c.data().body), cache: true });
      }
      const out = await porHora(db, uid, desde, hasta, tz);
      await cacheRef.set({ ts: Date.now(), body: JSON.stringify(out) }).catch(() => {});
      return res.json(out);
    }
    return res.status(400).json({ error: "acción desconocida" });
  } catch (e) {
    console.error("[impultienda]", action, e.message);
    return res.status(500).json({ error: e.message });
  }
}
