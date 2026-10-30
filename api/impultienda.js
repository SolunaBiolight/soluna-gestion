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

// Cálculos del Dashboard en vuelo por clave de caché: dos pedidos iguales al mismo tiempo comparten uno.
const _enVuelo = new Map();
// ── Monedas → USD (open.er-api.com, sin clave, caché 6 h en memoria) ──
let _fx = null, _fxAt = 0;
export async function fxPorUsd() {
  if (_fx && Date.now() - _fxAt < 6 * 3600000) return _fx;
  try { const j = await (await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(6000) })).json(); if (j?.rates) { _fx = { ...j.rates }; _fxAt = Date.now(); } } catch (_) {}
  // Pesos argentinos: dólar cripto (venta), no el oficial. El resto de las monedas, oficial.
  try { const c = await (await fetch("https://dolarapi.com/v1/dolares/cripto", { signal: AbortSignal.timeout(5000) })).json(); if (_fx && Number(c?.venta) > 0) { _fx.ARS = Number(c.venta); _fx._arsVista = Math.min(Number(c.compra) || Infinity, Number(c.venta)); _fx._arsCripto = true; } } catch (_) {}
  return _fx || { USD: 1 };
}
// Monedas que se pueden elegir en el Dashboard (cotización por 1 USD).
const MONEDAS_VISTA = ["USD","ARS","EUR","GBP","RON","MDL","PLN","TRY","ZAR","BRL","MXN","CLP","COP","UYU","PEN","PYG","BOB","CAD","AUD","CHF","JPY","CNY","INR","HUF","CZK","SEK","NOK","DKK","AED","ILS"];
export const aUsd = (monto, cur, fx) => { const c = String(cur || "USD").toUpperCase(); if (c === "USD") return monto; const r = fx?.[c]; return r ? monto / r : null; };

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
  // Venta nueva: se borran los reportes en caché para que el Dashboard la muestre al instante.
  try { const cs = await db.collection("users").doc(uid).collection("impultienda_cfg").get(); const bd = db.batch(); let k = 0;
    for (const x of cs.docs) if (x.id.startsWith("cache_")) { bd.delete(x.ref); k++; } if (k) await bd.commit(); } catch (_) {}
  // Campaña / conjunto / anuncio nuevos (ids que el índice no conoce): se agregan ya, por id, para que
  // la venta salga con nombre y cruce en todos lados sin esperar la reconstrucción.
  try { await completarIndicePorIds(db, uid, orden.utm); } catch (_) {}
  // Pulso para el front: el Dashboard escucha este campo y recarga en el momento.
  await db.collection("users").doc(uid).set({ imp_pulso: Date.now() }, { merge: true }).catch(() => {});
  return res.status(200).json({ ok: true });
}

// ── Meta: gasto por hora ART ──
// Lista de cuentas publicitarias por token, 10 min en memoria (cambia muy poco y antes se pedía en cada carga).
const _ctasPorToken = new Map();
async function cuentasDelToken(tk) {
  const k = crypto.createHash("sha1").update(tk).digest("hex");
  const hit = _ctasPorToken.get(k);
  if (hit && Date.now() - hit.ts < 10 * 60000) return hit.cuentas;
  const r = await (await fetch(`https://graph.facebook.com/v23.0/me/adaccounts?fields=account_id,currency,timezone_name&limit=200&access_token=${encodeURIComponent(tk)}`, { signal: AbortSignal.timeout(20000) })).json();
  if (r.error) throw new Error(r.error.message);
  const cuentas = r.data || [];
  _ctasPorToken.set(k, { ts: Date.now(), cuentas });
  return cuentas;
}
// Corre fn sobre items de a `n` a la vez.
async function enParalelo(items, n, fn) {
  const res = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); } }));
  return res;
}
const fetchJson = (url) => fetch(url, { signal: AbortSignal.timeout(25000) }).then(r => r.json());

// Gasto de Meta por hora. Antes iba token por token y cuenta por cuenta, con tres pedidos en serie por cuenta
// (con 10 cuentas eran ~30 pedidos encadenados y el Dashboard tardaba 20-30 s). Ahora las cuentas van de a 6
// en paralelo y los tres pedidos de cada cuenta salen juntos.
async function metaPorHora(db, uid, desde, hasta, elegidas = [], tzU = "America/Argentina/Buenos_Aires") {
  const snap = await db.collection("users").doc(uid).collection("meta_accounts").get();
  const tokens = [...new Set(snap.docs.map(d => d.data()?.access_token).filter(Boolean))];
  const out = {}; // "fecha|hora|campaña" → usd
  const errores = [];
  let sinHora = 0;
  const vistas = new Set();
  const metaDice = {}; // campaign_id → {compras, valor} según el píxel de Meta (su atribución, su zona horaria)
  const fx = await fxPorUsd();
  // Qué cuentas hay que consultar (cada una con su token; una cuenta visible desde dos tokens se consulta una vez).
  const trabajos = [];
  const listas = await Promise.all(tokens.map(tk => cuentasDelToken(tk).then(cuentas => ({ tk, cuentas })).catch(e => { errores.push(e.message); return { tk, cuentas: [] }; })));
  for (const { tk, cuentas } of listas) for (const c of cuentas) {
    const id = "act_" + c.account_id;
    if (vistas.has(id)) continue; vistas.add(id);
    if (elegidas.length && !elegidas.includes(id)) continue;
    trabajos.push({ tk, c, id });
  }
  const since = addDias(desde, -1), until = addDias(hasta, 1);
  await enParalelo(trabajos, 6, async ({ tk, c, id }) => {
    const tz = c.timezone_name || "America/Los_Angeles";
    const hoyLocal = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
    const porDiaLocal = {};
    const filas = {};
    try {
      const pHoras = (async () => {
        // El día ART empieza en otra hora de la zona de la cuenta: se pide un día de margen.
        let url = `https://graph.facebook.com/v23.0/${id}/insights?level=campaign&fields=spend,campaign_name,campaign_id&time_increment=1&breakdowns=hourly_stats_aggregated_by_advertiser_time_zone&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}&limit=500&access_token=${encodeURIComponent(tk)}`;
        for (let i = 0; url && i < 20; i++) {
          const r = await fetchJson(url);
          if (r.error) { errores.push(`${id}: ${r.error.message}`); break; }
          for (const row of r.data || []) {
            const hh = parseInt(String(row.hourly_stats_aggregated_by_advertiser_time_zone || "").slice(0, 2), 10);
            const usd = aUsd(Number(row.spend) || 0, c.currency, fx);
            if (!isFinite(hh) || usd == null) continue;
            const a = zonaDe(new Date(utcDeLocal(row.date_start, hh, tz)).toISOString(), tzU);
            const k = `${a.fecha}|${a.hora}|${String(row.campaign_name || "").replace(/\|/g, "/")}|${row.campaign_id || ""}`;
            filas[k] = (filas[k] || 0) + usd;
            porDiaLocal[row.date_start] = (porDiaLocal[row.date_start] || 0) + usd;
          }
          url = r.paging?.next || null;
        }
      })();
      // Lo que Meta dice que vendió cada campaña (píxel), para comparar con la venta real.
      const pPixel = fetchJson(`https://graph.facebook.com/v23.0/${id}/insights?level=campaign&fields=campaign_id,actions,action_values&time_range=${encodeURIComponent(JSON.stringify({ since: desde, until: hasta }))}&limit=500&access_token=${encodeURIComponent(tk)}`).catch(() => ({}));
      // Trampa conocida: el desglose horario puede no traer todavía las horas de HOY (zona de la cuenta).
      // Se compara con el gasto del día y la diferencia va a la hora ART actual, marcada como "sin hora exacta".
      const pHoy = fetchJson(`https://graph.facebook.com/v23.0/${id}/insights?level=account&fields=spend&time_range=${encodeURIComponent(JSON.stringify({ since: hoyLocal, until: hoyLocal }))}&access_token=${encodeURIComponent(tk)}`).catch(() => ({}));
      const [, rr, r2] = await Promise.all([pHoras, pPixel, pHoy]);
      for (const [k, v] of Object.entries(filas)) out[k] = (out[k] || 0) + v;
      for (const row of rr.data || []) {
        const pick = (arr) => { const a = (arr || []).find(x => x.action_type === "purchase") || (arr || []).find(x => x.action_type === "offsite_conversion.fb_pixel_purchase"); return a ? Number(a.value) || 0 : 0; };
        metaDice[row.campaign_id] = { compras: pick(row.actions), valor: aUsd(pick(row.action_values), c.currency, fx) || 0 };
      }
      const totalHoy = aUsd(Number(r2.data?.[0]?.spend) || 0, c.currency, fx) || 0;
      const falta = totalHoy - (porDiaLocal[hoyLocal] || 0);
      if (falta > 0.01) {
        const a = zonaDe(new Date().toISOString(), tzU);
        if (a.fecha >= desde && a.fecha <= hasta) { const k = `${a.fecha}|${a.hora}||`; out[k] = (out[k] || 0) + falta; sinHora += falta; }
      }
    } catch (e) { errores.push(`${id}: ${e.message}`); }
  });
  return { porHora: out, sinHora, cuentas: vistas.size, errores, metaDice };
}

// ── Stripe: comisión real por venta ──
// Cruce: balance_transaction (type charge) con el cargo expandido → email del
// comprador + monto + ±10 min de la aprobación. Ambiguo o sin cruce = estimada.
async function stripeComisiones(db, uid, cfg, ordenes, desdeMs, hastaMs) {
  const key = descifrar(cfg.stripeEnc);
  if (!key) return { conectado: false };
  const txs = [];
  let url = `https://api.stripe.com/v1/balance_transactions?limit=100&created[gte]=${Math.floor(desdeMs / 1000) - 900}&created[lte]=${Math.floor(hastaMs / 1000) + 900}&expand[]=data.source`;
  try {
    for (let i = 0; i < 30; i++) {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
      const j = await r.json();
      if (j.error) return { conectado: true, error: j.error.message };
      // Cobros con tarjeta (charge) y con métodos locales o en otra moneda (payment: BLIK, P24, etc.).
      txs.push(...(j.data || []).filter(t => t.type === "charge" || t.type === "payment"));
      if (!j.has_more || !j.data?.length) break;
      url = url.replace(/&starting_after=[^&]*/, "") + `&starting_after=${j.data[j.data.length - 1].id}`;
    }
  } catch (e) { return { conectado: true, error: e.message }; }
  const fx = await fxPorUsd();
  const usados = new Set();
  let cruzadas = 0;
  const batch = db.batch(); let escrituras = 0;
  // Desglose de la comisión que da Stripe (procesamiento, internacional, conversión, impuestos…).
  const detDe = (t) => (t.fee_details || []).map(d => ({ tipo: d.type, desc: d.description || d.type, monto: aUsd(d.amount / 100, d.currency, fx) ?? 0 }));
  const porBt = Object.fromEntries(txs.map(t => [t.id, t]));
  for (const o of ordenes) {
    if (o.stripe?.bt) {
      usados.add(o.stripe.bt); cruzadas++;
      if (!o.stripe.det && porBt[o.stripe.bt]) { const t = porBt[o.stripe.bt]; o.stripe = { ...o.stripe, det: detDe(t), neto: aUsd(t.net / 100, t.currency, fx) }; batch.set(db.collection("users").doc(uid).collection("impultienda_orders").doc(o.order_id), { stripe: o.stripe }, { merge: true }); escrituras++; }
      continue;
    }
    if (o.pasarela && o.pasarela !== "stripe" && o.pasarela !== "card") continue;
    const tAp = Date.parse(o.ev_approved || "");
    if (!isFinite(tAp)) continue;
    const montoOk = (t) => {
      const ch = t.source || {};
      const montoCh = (ch.amount || 0) / 100, curCh = String(ch.currency || "").toUpperCase();
      const esperado = curCh === String(o.buyer_moneda || "").toUpperCase() && o.buyer_total != null ? Number(o.buyer_total) : (curCh === String(o.moneda || "").toUpperCase() ? o.total : null);
      if (esperado != null && Math.abs(montoCh - esperado) <= Math.max(0.02, esperado * 0.01)) return true;
      // Si la moneda del cobro no coincide (cobro convertido), se compara en dólares con un 3% de margen.
      const uTx = aUsd(t.amount / 100, t.currency, fx), uO = aUsd(Number(o.total) || 0, o.moneda, fx);
      return uTx != null && uO ? Math.abs(uTx - uO) <= uO * 0.03 : false;
    };
    let cand = txs.filter(t => {
      if (usados.has(t.id)) return false;
      const ch = t.source || {};
      const mail = String(ch.billing_details?.email || ch.receipt_email || "").toLowerCase();
      if (o.email && mail && mail !== o.email) return false;
      if (Math.abs(t.created * 1000 - tAp) > 10 * 60000) return false;
      return montoOk(t);
    });
    // Segunda pasada: mismo monto, hasta 30 min de diferencia y sin exigir el email (pagos locales que se aprueban más tarde o con otro mail).
    if (!cand.length) cand = txs.filter(t => !usados.has(t.id) && Math.abs(t.created * 1000 - tAp) <= 30 * 60000 && montoOk(t));
    if (!cand.length) continue;
    // Varios cobros iguales en la ventana (mismo monto, sin email en el cobro): el más cercano en tiempo a la aprobación.
    cand.sort((x, y) => Math.abs(x.created * 1000 - tAp) - Math.abs(y.created * 1000 - tAp));
    const t = cand[0]; usados.add(t.id);
    const fee = aUsd(t.fee / 100, t.currency, fx);
    if (fee == null) continue;
    o.stripe = { bt: t.id, fee, det: detDe(t), neto: aUsd(t.net / 100, t.currency, fx), at: new Date().toISOString() };
    batch.set(db.collection("users").doc(uid).collection("impultienda_orders").doc(o.order_id), { stripe: o.stripe }, { merge: true });
    escrituras++; cruzadas++;
  }
  if (escrituras) await batch.commit().catch(() => {});
  const sueltos = txs.filter(t => !usados.has(t.id)).slice(0, 30).map(t => ({ creado: new Date(t.created * 1000).toISOString(), tipo: t.type, monto: t.amount / 100, moneda: t.currency, cobro: (t.source?.amount || 0) / 100, monedaCobro: t.source?.currency || null, conMail: !!(t.source?.billing_details?.email || t.source?.receipt_email) }));
  return { conectado: true, cruzadas, transacciones: txs.length, sueltos };
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
// Códigos de una tienda: país (IT), varios (RO MD) u otra etiqueta que el cliente use en sus campañas (VERANO).
export const paisesDe = (p) => String(p || "").toUpperCase().split(/[^A-Z0-9]+/).filter(x => x.length >= 2 && x.length <= 20);
// Nombres de país que la gente escribe en el nombre de la campaña ("💇 CHEQUIA Atlas…", "ITALIA · CP6") → código ISO.
// Sin acentos y en mayúsculas (se comparan con los tokens normalizados del nombre). Nombres de dos palabras van con espacio.
const PAIS_NOMBRES = {
  CZ: ["CHEQUIA", "CHEQUÍA", "REPUBLICA CHECA", "CZECH", "CZECHIA", "CESKO"], RO: ["RUMANIA", "ROMANIA"], IT: ["ITALIA", "ITALY"],
  FR: ["FRANCIA", "FRANCE"], SK: ["ESLOVAQUIA", "SLOVAKIA", "SLOVENSKO"], HU: ["HUNGRIA", "HUNGARY"], HR: ["CROACIA", "CROATIA"],
  PL: ["POLONIA", "POLAND", "POLSKA"], RS: ["SERBIA"], TR: ["TURQUIA", "TURKEY", "TURKIYE"], GR: ["GRECIA", "GREECE"], BG: ["BULGARIA"],
  PT: ["PORTUGAL"], ES: ["ESPANA", "SPAIN"], DE: ["ALEMANIA", "GERMANY", "DEUTSCHLAND"], ZA: ["SUDAFRICA", "SOUTH AFRICA"],
  MD: ["MOLDAVIA", "MOLDOVA"], UK: ["REINO UNIDO", "UNITED KINGDOM", "INGLATERRA"], GB: ["REINO UNIDO", "UNITED KINGDOM", "INGLATERRA"],
  US: ["ESTADOS UNIDOS", "USA", "UNITED STATES"], MX: ["MEXICO"], AR: ["ARGENTINA"], CL: ["CHILE"], CO: ["COLOMBIA"], PE: ["PERU"],
  BR: ["BRASIL", "BRAZIL"], NL: ["HOLANDA", "PAISES BAJOS", "NETHERLANDS"], BE: ["BELGICA", "BELGIUM"], AT: ["AUSTRIA"], CH: ["SUIZA", "SWITZERLAND"],
  SE: ["SUECIA", "SWEDEN"], NO: ["NORUEGA", "NORWAY"], DK: ["DINAMARCA", "DENMARK"], FI: ["FINLANDIA", "FINLAND"], IE: ["IRLANDA", "IRELAND"],
  LT: ["LITUANIA", "LITHUANIA"], LV: ["LETONIA", "LATVIA"], EE: ["ESTONIA"], SI: ["ESLOVENIA", "SLOVENIA"], UA: ["UCRANIA", "UKRAINE"],
  AU: ["AUSTRALIA"], CA: ["CANADA"], NZ: ["NUEVA ZELANDA", "NEW ZEALAND"], JP: ["JAPON", "JAPAN"], IN: ["INDIA"],
};
const sinAcentos = (x) => String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
// Códigos de país que aparecen en el nombre de una campaña: como código ("IT | …", "[PL]") o como nombre ("ITALIA", "POLONIA").
export function paisesDeNombre(nombre) {
  const toks = sinAcentos(nombre).split(/[^A-Z0-9]+/).filter(Boolean);
  const out = new Set(toks.filter(t => t.length === 2));
  const texto = " " + toks.join(" ") + " ";
  for (const [cod, nombres] of Object.entries(PAIS_NOMBRES)) if (nombres.some(n => texto.includes(" " + sinAcentos(n) + " "))) out.add(cod);
  return out;
}
// Tienda a la que va el gasto de una campaña, por lo que dice el nombre. Si no cierra con exactamente una, null.
export function tiendaDeCampana(nombre, tiendas) {
  const toks = String(nombre || "").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  let hit = tiendas.filter(t => paisesDe(t.pais).some(p => toks.includes(p)));
  if (hit.length !== 1) { const cods = paisesDeNombre(nombre); hit = tiendas.filter(t => paisesDe(t.pais).some(p => cods.has(p))); }
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
const esIdMeta = (v) => /^\d{10,}$/.test(String(v || "").trim());
export function campanaDeVenta(utm, campanas) {
  if (!utm) return null;
  if (utm.utm_id) { const c = campanas.find(c => c.id && String(c.id) === String(utm.utm_id)); if (c) return c.key; }
  // Con un id de campaña en la UTM la venta es de ESA campaña (aunque su cuenta no esté elegida en Growith):
  // jamás se adivina por país, que es lo que mandaba todas las ventas a una sola campaña.
  if (esIdMeta(utm.utm_id)) return String(utm.utm_id).trim();
  if (utm.utm_campaign) {
    const u = norm(utm.utm_campaign);
    const c = campanas.find(c => norm(c.nombre) === u) || campanas.find(c => c.id && String(c.id) === String(utm.utm_campaign));
    if (c) return c.key;
    const pais = paisDeUtm(utm);
    if (pais) { const hit = campanas.filter(c => norm(c.nombre).split(" ").includes(pais.toLowerCase())); if (hit.length === 1) return hit[0].key; }
  }
  return null;
}

// ── Índice de anuncios para la atribución por UTM ──
// Todos los anuncios con entrega en los últimos N días de las cuentas elegidas, con su
// conjunto y campaña: id → nombre. Así una venta cruza aunque la UTM traiga el id o el
// nombre, y aunque la campaña no haya gastado en el rango que se está mirando.
// Doc users/{uid}/impultienda_cfg/utm_idx = {ts, dias, c:{id:nombre}, s:{id:[nombre,campId]}, a:{id:[nombre,setId,campId]}}.
// Con `base` se suma lo de los últimos `dias` al índice existente (refresco rápido de anuncios nuevos).
export async function construirIndiceUtm(db, uid, dias = 60, base = null) {
  const cfg = (await db.collection("users").doc(uid).collection("impultienda_cfg").doc("main").get()).data() || {};
  const elegidas = cfg.metaCuentas || [];
  const snap = await db.collection("users").doc(uid).collection("meta_accounts").get();
  const tokens = [...new Set(snap.docs.map(d => d.data()?.access_token).filter(Boolean))];
  const idx = base ? { ...base, ts: Date.now(), c: { ...(base.c || {}) }, s: { ...(base.s || {}) }, a: { ...(base.a || {}) }, errores: [] } : { ts: Date.now(), dias, c: {}, s: {}, a: {}, errores: [] };
  const hoy = new Date().toISOString().slice(0, 10);
  const vistas = new Set();
  for (const tk of tokens) {
    let cuentas = [];
    try { cuentas = (await (await fetch(`https://graph.facebook.com/v23.0/me/adaccounts?fields=account_id&limit=200&access_token=${encodeURIComponent(tk)}`)).json()).data || []; }
    catch (e) { idx.errores.push(e.message); }
    for (const c of cuentas) {
      const id = "act_" + c.account_id;
      if (vistas.has(id) || (elegidas.length && !elegidas.includes(id))) continue;
      vistas.add(id);
      let url = `https://graph.facebook.com/v23.0/${id}/insights?level=ad&fields=ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name&time_range=${encodeURIComponent(JSON.stringify({ since: addDias(hoy, -dias), until: hoy }))}&limit=500&access_token=${encodeURIComponent(tk)}`;
      try {
        for (let i = 0; url && i < 30; i++) {
          const r = await (await fetch(url)).json();
          if (r.error) { idx.errores.push(`${id}: ${r.error.message}`); break; }
          for (const x of r.data || []) {
            if (x.campaign_id) idx.c[x.campaign_id] = x.campaign_name || "";
            if (x.adset_id) idx.s[x.adset_id] = [x.adset_name || "", x.campaign_id || null];
            if (x.ad_id && Object.keys(idx.a).length < 8000) idx.a[x.ad_id] = [x.ad_name || "", x.adset_id || null, x.campaign_id || null];
          }
          url = r.paging?.next || null;
        }
      } catch (e) { idx.errores.push(`${id}: ${e.message}`); }
    }
  }
  idx.cuentas = vistas.size;
  await db.collection("users").doc(uid).collection("impultienda_cfg").doc("utm_idx").set(idx);
  return idx;
}
// Suma al índice los ids de una UTM que no conoce, leyendo cada nodo de Meta por id (cualquier token sirve).
export async function completarIndicePorIds(db, uid, utm) {
  if (!utm) return;
  const u = {}; for (const [k, v] of Object.entries(utm)) if (v != null) u[String(k).toLowerCase()] = String(v).trim();
  const cId = ["utm_id", "campaign_id", "utm_campaign_id"].map(k => u[k]).find(esIdMeta), sId = ["utm_term", "adset_id", "utm_adset_id"].map(k => u[k]).find(esIdMeta), aId = ["utm_content", "ad_id", "utm_ad_id"].map(k => u[k]).find(esIdMeta);
  if (!cId && !sId && !aId) return;
  const ref = db.collection("users").doc(uid).collection("impultienda_cfg").doc("utm_idx");
  const idx = (await ref.get()).data() || { c: {}, s: {}, a: {} };
  if ((!cId || idx.c?.[cId] !== undefined) && (!sId || idx.s?.[sId]) && (!aId || idx.a?.[aId])) return;
  const snap = await db.collection("users").doc(uid).collection("meta_accounts").get();
  const tokens = [...new Set(snap.docs.map(d => d.data()?.access_token).filter(Boolean))];
  const leer = async (id, fields) => { for (const tk of tokens) { try { const j = await (await fetch(`https://graph.facebook.com/v23.0/${id}?fields=${fields}&access_token=${encodeURIComponent(tk)}`, { signal: AbortSignal.timeout(8000) })).json(); if (!j.error) return j; } catch (_) {} } return null; };
  const patch = {};
  if (aId && !idx.a?.[aId]) { const j = await leer(aId, "name,adset_id,campaign_id"); if (j) { patch[`a.${aId}`] = [j.name || "", j.adset_id || null, j.campaign_id || null]; } }
  if (sId && !idx.s?.[sId]) { const j = await leer(sId, "name,campaign_id"); if (j) patch[`s.${sId}`] = [j.name || "", j.campaign_id || null]; }
  if (cId && idx.c?.[cId] === undefined) { const j = await leer(cId, "name"); if (j) patch[`c.${cId}`] = j.name || ""; }
  if (Object.keys(patch).length) await ref.set({ c: {}, s: {}, a: {} }, { merge: true }).then(() => ref.update(patch)).catch(() => {});
}
export async function leerIndiceUtm(db, uid) {
  const d = await db.collection("users").doc(uid).collection("impultienda_cfg").doc("utm_idx").get();
  return d.exists ? d.data() : null;
}

// Venta → {c, s, a} (ids de campaña, conjunto y anuncio). Acepta las UTM recomendadas
// (utm_id={{campaign.id}}, utm_term={{adset.id}}, utm_content={{ad.id}}) y también nombres
// ({{campaign.name}}, {{adset.name}}, {{ad.name}}) o los campos sueltos campaign_id/adset_id/ad_id.
// Un nombre solo cuenta si es único (dentro de la campaña cuando ya se sabe cuál es).
export function atribuirUtm(utm, idx) {
  if (!utm || !idx) return null;
  const u = {}; for (const [k, v] of Object.entries(utm)) if (v != null && v !== "") u[String(k).toLowerCase()] = String(v).trim();
  const unico = (lista) => lista.length === 1 ? lista[0] : null;
  const porNombre = (mapa, val, campDe, camp) => {
    const n = norm(val); if (!n) return null;
    let hits = Object.keys(mapa).filter(id => norm(Array.isArray(mapa[id]) ? mapa[id][0] : mapa[id]) === n);
    if (camp && campDe) { const enCamp = hits.filter(id => campDe(id) === camp); if (enCamp.length) hits = enCamp; }
    return unico(hits);
  };
  const buscar = (mapa, claves, campDe, camp) => {
    for (const k of claves) { const v = u[k]; if (!v) continue; if (mapa[v] !== undefined) return v; }
    // Un id de Meta vale aunque el índice todavía no lo conozca (campaña recién creada o de una cuenta no elegida).
    for (const k of claves) { const v = u[k]; if (esIdMeta(v)) return v; }
    for (const k of claves) { const v = u[k]; if (!v || /^\d{6,}$/.test(v)) continue; const id = porNombre(mapa, v, campDe, camp); if (id) return id; }
    return null;
  };
  let c = buscar(idx.c || {}, ["utm_id", "campaign_id", "utm_campaign_id", "utm_campaign"]);
  let a = buscar(idx.a || {}, ["ad_id", "utm_ad_id", "utm_content", "utm_ad"], (id) => idx.a[id]?.[2], c);
  let s = a ? (idx.a[a]?.[1] || null) : buscar(idx.s || {}, ["adset_id", "utm_adset_id", "utm_term", "utm_adset"], (id) => idx.s[id]?.[1], c);
  if (!s && a && !idx.a[a]) s = ["adset_id", "utm_adset_id", "utm_term", "utm_adset"].map(k => u[k]).find(esIdMeta) || null;
  if (!c && a) c = idx.a[a]?.[2] || null;
  if (!c && s) c = idx.s[s]?.[1] || null;
  // Con ids en la UTM nunca se adivina por país: si no cruzan, la venta queda sin campaña (y se ve).
  const conIds = ["utm_id", "campaign_id", "utm_term", "adset_id", "utm_content", "ad_id"].some(k => esIdMeta(u[k]));
  // Último recurso, como antes: el código de país al final de utm_campaign contra UNA sola campaña con ese país.
  // Con UTM fija tipo "lumea_ro": entre las campañas de ese país, la que además tiene en el nombre
  // las otras palabras de la UTM ("lumea") — así "claude_ro" no se mezcla con "lumea_ro".
  if (!c && !conIds) {
    const pais = paisDeUtm(u);
    if (pais) {
      const conPais = Object.keys(idx.c || {}).filter(id => norm(idx.c[id]).split(" ").includes(pais.toLowerCase()));
      const resto = norm(u.utm_campaign).split(" ").filter(t => t.length >= 3);
      const conTodo = resto.length ? conPais.filter(id => { const ws = norm(idx.c[id]).split(" "); return resto.every(t => ws.some(w => w.startsWith(t))); }) : [];
      c = unico(conTodo) || unico(conPais);
      // Ya con la campaña, el anuncio por nombre dentro de ella ("v2", "img1"…).
      if (c && !a) { a = buscar(idx.a || {}, ["ad_id", "utm_ad_id", "utm_content", "utm_ad"], (id) => idx.a[id]?.[2], c); if (a && idx.a[a]?.[2] !== c) a = null; if (a) s = idx.a[a][1]; }
    }
  }
  if (!c && !s && !a) return null;
  return { c: c || null, s: s || null, a: a || null };
}

// Ventas reales por campaña / conjunto / anuncio en el rango (USD). Una venta = la compra
// principal; el post-compra suma facturación a la campaña de su orden original.
// Tiendas de Impultienda (manuales + las que aparecen en las ventas) con su país.
// Ojo: normaliza o.store_id de las ventas a la tienda manual con el mismo nombre.
export function armarTiendas(cfg, ordenes) {
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
  return tiendasMap;
}

// opts.desdeMs/hastaMs: ventana exacta (p. ej. últimas 2 h). opts.dentro(o, tienda): filtro propio
// (p. ej. "hoy" en la hora local del país de cada tienda); desde/hasta solo acotan la lectura.
export async function utmAtribucion(db, uid, desde, hasta, tz, idx, opts = {}) {
  const desdeMs = opts.desdeMs ?? utcDeLocal(desde, 0, tz), hastaMs = opts.hastaMs ?? utcDeLocal(addDias(hasta, 1), 0, tz);
  const snap = await db.collection("users").doc(uid).collection("impultienda_orders").where("actualizado", ">=", new Date(desdeMs - 2 * 86400000).toISOString()).get();
  const todas = snap.docs.map(d => d.data());
  const delWebhook = new Set(todas.filter(o => !o.importado && o.orden != null).map(o => String(o.orden)));
  const ordenes = todas.filter(o => !o.importado || !delWebhook.has(String(o.orden)));
  const [fx, cfgSnap] = await Promise.all([fxPorUsd(), db.collection("users").doc(uid).collection("impultienda_cfg").doc("main").get()]);
  const tiendasMap = armarTiendas(cfgSnap.data() || {}, ordenes);
  // ct: por campaña, cuántas ventas fueron a cada tienda (para agrupar campañas por tienda).
  const out = { c: {}, s: {}, a: {}, ct: {}, tiendas: tiendasMap, total: { n: 0, rev: 0 }, sinAtribuir: { n: 0, rev: 0 }, sinUtm: 0, importadas: 0, ultimaVenta: null };
  const atr = {};
  for (const o of ordenes) if (!o.post_compra) atr[o.order_id] = atribuirUtm(o.utm, idx);
  for (const o of ordenes) {
    const t = Date.parse(o.ev_approved || "");
    if (isFinite(t) && (!out.ultimaVenta || t > Date.parse(out.ultimaVenta))) out.ultimaVenta = o.ev_approved;
    if (!isFinite(t) || t < desdeMs || t >= hastaMs) continue;
    if (opts.dentro && !opts.dentro(o, tiendasMap[o.store_id])) continue;
    const usd = aUsd(Number(o.total) || 0, o.moneda, fx) ?? 0;
    const n = o.post_compra ? 0 : 1;
    const x = o.post_compra ? (atr[o.orden_original] || atribuirUtm(o.utm, idx)) : atr[o.order_id];
    out.total.n += n; out.total.rev += usd;
    if (!o.post_compra) { if (o.importado) out.importadas++; else if (!o.utm) out.sinUtm++; }
    if (!x) { out.sinAtribuir.n += n; out.sinAtribuir.rev += usd; continue; }
    if (x.c && o.store_id) { const m = out.ct[x.c] || (out.ct[x.c] = {}); m[o.store_id] = (m[o.store_id] || 0) + 1; }
    for (const nivel of ["c", "s", "a"]) if (x[nivel]) { const m = out[nivel][x[nivel]] || (out[nivel][x[nivel]] = { n: 0, rev: 0 }); m.n += n; m.rev += usd; }
  }
  return out;
}

// ── Reporte por hora ──
export async function porHora(db, uid, desde, hasta, tz = "America/Argentina/Buenos_Aires") {
  if (!tzValida(tz)) tz = "America/Argentina/Buenos_Aires";
  const cfg = (await db.collection("users").doc(uid).collection("impultienda_cfg").doc("main").get()).data() || {};
  // El día va de 00:00 a 00:00 en la zona elegida.
  const desdeMs = utcDeLocal(desde, 0, tz), hastaMs = utcDeLocal(addDias(hasta, 1), 0, tz);
  // Todo lo que no depende de otra cosa sale a la vez: órdenes, cotizaciones, gasto de Meta e índice UTM
  // (antes iba en serie y Meta esperaba a Stripe y a Mercado Pago).
  const pMeta = metaPorHora(db, uid, desde, hasta, cfg.metaCuentas || [], tz);
  const pIdx = leerIndiceUtm(db, uid).catch(() => null);
  // Órdenes tocadas en el rango o un poco antes (un reembolso de hoy puede ser de una venta vieja).
  const snap = await db.collection("users").doc(uid).collection("impultienda_orders").where("actualizado", ">=", new Date(desdeMs - 40 * 86400000).toISOString()).get();
  // Una orden importada se descarta si el webhook ya trajo la misma (tienda + número).
  const todas = snap.docs.map(d => d.data());
  // El número de orden de Impultienda es único en toda la plataforma: una importada se descarta si el webhook trajo esa orden.
  const delWebhook = new Set(todas.filter(o => !o.importado && o.orden != null).map(o => String(o.orden)));
  const ordenes = todas.filter(o => !o.importado || !delWebhook.has(String(o.orden)));
  const fx = await fxPorUsd();
  const delRango = ordenes.filter(o => o.ev_approved && Date.parse(o.ev_approved) >= desdeMs && Date.parse(o.ev_approved) < hastaMs);
  const [stripe, mp] = await Promise.all([stripeComisiones(db, uid, cfg, delRango, desdeMs, hastaMs), mpComisiones(db, uid, delRango, desdeMs, hastaMs)]);
  // Con Stripe conectado, la comisión de las ventas que no se pudieron cruzar es el PROMEDIO REAL de las cruzadas
  // (no un % cargado a mano). Sin Stripe o con pocas cruzadas, el estimado del cliente.
  const conFee = ordenes.filter(o => o.stripe?.fee != null);
  let pctReal = null;
  if (cfg.stripeEnc && conFee.length >= 5) {
    const sm = conFee.reduce((a, o) => { a.f += o.stripe.fee; a.u += aUsd(Number(o.total) || 0, o.moneda, fx) || 0; return a; }, { f: 0, u: 0 });
    if (sm.u > 0) pctReal = sm.f / sm.u * 100;
  }
  const feePct = pctReal ?? Number(cfg.feePct ?? 2.9), feeFijo = pctReal != null ? 0 : Number(cfg.feeFijo ?? 0.3);
  const ventasLista = [];
  const aceptaron = new Set();
  const tiendasMap = armarTiendas(cfg, ordenes);
  const filas = {}; // "fecha|hora|tienda"
  const fila = (fecha, hora, tienda) => { const k = `${fecha}|${hora}|${tienda}`; const t = tiendasMap[tienda]; return filas[k] || (filas[k] = { fecha, hora, tienda, tiendaNombre: t?.nombre || (tienda === "SIN_ASIGNAR" ? "Sin asignar" : tienda), pais: t?.pais || null, ventas: 0, n: 0, front: 0, nFront: 0, upsell: 0, nUpsell: 0, reembolsos: 0, comisiones: 0, comisionesEstimadas: 0, gasto: 0 }); };
  const ventasCamp = {};
  const enRango = (iso) => { const t = Date.parse(iso || ""); return isFinite(t) && t >= desdeMs && t < hastaMs; };
  const meta = await pMeta;
  const campIdx = {};
  for (const k of Object.keys(meta.porHora)) { const [, , nombre, id] = k.split("|"); if (nombre) campIdx[id || nombre] = { key: id || nombre, id: id || null, nombre }; }
  const campLista = Object.values(campIdx);
  const idxUtm = await pIdx;
  const campDeIdx = (utm) => { const x = atribuirUtm(utm, idxUtm); return x?.c && campIdx[x.c] ? x.c : null; };
  for (const o of ordenes) {
    const tid = o.store_id || "SIN_TIENDA";
    const usd = aUsd(o.total, o.moneda, fx) ?? 0;
    if (enRango(o.ev_approved)) {
      const a = zonaDe(o.ev_approved, tz); const f = fila(a.fecha, a.hora, tid);
      // Una venta = la compra principal; el post-compra suma facturación pero NO es otra venta (igual que Impultienda).
      f.ventas += usd; if (!o.post_compra) f.n += 1;
      if (o.post_compra) { f.upsell += usd; f.nUpsell += 1; } else { f.front += usd; f.nFront += 1; }
      if (o.post_compra) aceptaron.add(String(o.orden_original || o.email || o.order_id)); // personas, no upsells: 15 post-compras de un comprador = 1 aceptación
      const ck = campanaDeVenta(o.utm, campLista) || campDeIdx(o.utm) || "SIN_CAMPANA";
      const cv = ventasCamp[ck] || (ventasCamp[ck] = { ventas: 0, n: 0, comisiones: 0, anuncios: {}, tiendas: {} });
      cv.ventas += usd; if (!o.post_compra) cv.n += 1;
      if (tiendasMap[tid]) cv.tiendas[tid] = (cv.tiendas[tid] || 0) + 1;
      // Con utm_content={{ad.id}} se muestra el nombre del anuncio (índice de 60 días).
      const adRaw = String(o.utm?.utm_content || ""); const ad = String(idxUtm?.a?.[adRaw]?.[0] || adRaw || "sin anuncio").slice(0, 80);
      const av = cv.anuncios[ad] || (cv.anuncios[ad] = { anuncio: ad, ventas: 0, n: 0 }); av.ventas += usd; if (!o.post_compra) av.n += 1;
      const real = o.stripe?.fee ?? o.mp?.fee;
      const com = real != null ? real : usd * feePct / 100 + feeFijo;
      f.comisiones += com; if (real == null) f.comisionesEstimadas += com;
      // Reembolso/contracargo: se resta en el DÍA DE LA VENTA (para que el profit de ese día sea el real).
      // Stripe no devuelve la comisión: la comisión queda y se resta todo lo devuelto.
      const reemb = o.reembolso?.usd != null ? o.reembolso.usd : (o.ev_refunded || o.ev_chargeback ? usd : 0);
      f.reembolsos += reemb;
      cv.comisiones += com;
      ventasLista.push({ tid, comisionDetalle: o.stripe?.det || null, orden: o.orden ?? o.order_id, fecha: a.fecha, hora: a.hora, at: o.ev_approved, tienda: tiendasMap[tid]?.nombre || o.store_nombre || tid,
        total: usd, totalOriginal: Number(o.buyer_total ?? o.total) || 0, monedaOriginal: o.buyer_moneda || o.moneda || "USD", post_compra: !!o.post_compra,
        comision: com, fuente: o.stripe?.fee != null ? "stripe" : o.mp?.fee != null ? "mercadopago" : "estimada", stripe_id: o.stripe?.bt || null,
        pasarela: o.pasarela || null, campana: o.utm?.utm_campaign || null, anuncio: (o.utm?.utm_content && idxUtm?.a?.[o.utm.utm_content]?.[0]) || o.utm?.utm_content || null, importado: !!o.importado,
        reembolsada: !!(o.ev_refunded || o.ev_chargeback || o.reembolso), reembolso: o.reembolso || null, reembolsoUsd: reemb, email: o.email || null,
        order_id: o.order_id });
    }
  }

  const tiendasLista = Object.values(tiendasMap);
  // Tienda de una campaña cuando el nombre no dice el país: adonde fueron SUS ventas por UTM en el período (la que más tuvo).
  const tiendaPorVentas = (key) => { const t = ventasCamp[key]?.tiendas; if (!t) return null; const top = Object.entries(t).sort((a, b) => b[1] - a[1])[0]; return top ? top[0] : null; };
  const campanas = {};
  for (const [k, usd] of Object.entries(meta.porHora)) {
    const [fecha, hora, camp, cid] = k.split("|");
    if (fecha < desde || fecha > hasta) continue;
    const tid = tiendaDeCampana(camp, tiendasLista) || tiendaPorVentas(cid || camp) || "SIN_ASIGNAR";
    fila(fecha, parseInt(hora, 10), tid).gasto += usd;
    if (camp) { const key = cid || camp; const c = campanas[key] || (campanas[key] = { key, id: cid || null, nombre: camp, tienda: tid, gasto: 0 }); c.gasto += usd; }
  }
  for (const [ck, v] of Object.entries(ventasCamp)) {
    const c = campanas[ck] || (campanas[ck] = { key: ck, id: esIdMeta(ck) ? ck : null, nombre: ck === "SIN_CAMPANA" ? "Sin campaña (venta sin UTM que cruce)" : esIdMeta(ck) ? `${idxUtm?.c?.[ck] || `Campaña ${ck}`} (sin gasto leído: cuenta no elegida en Meta → Configuración)` : ck, tienda: null, gasto: 0 });
    c.ventas = v.ventas; c.n = v.n; c.comisiones = v.comisiones;
    c.anuncios = Object.values(v.anuncios).sort((a, b) => b.ventas - a.ventas);
  }
  for (const c of Object.values(campanas)) { if (c.id && meta.metaDice?.[c.id]) c.metaDice = meta.metaDice[c.id];
    c.ventas = c.ventas || 0; c.n = c.n || 0; c.comisiones = c.comisiones || 0; c.ganancia = c.ventas - c.comisiones - c.gasto; c.roas = c.gasto ? c.ventas / c.gasto : null; c.cpa = c.n && c.gasto ? c.gasto / c.n : null; }
  // Meta atribuido a cada venta: el gasto de su tienda ese día, repartido según lo que pesó la venta en la facturación del día.
  // Meta atribuido a cada venta: el gasto TOTAL del día (todas las cuentas y campañas, aunque no tengan tienda)
  // repartido según lo que pesó la venta en la facturación del día. Así la suma de Meta de las ventas = gasto del día.
  const td = {};
  for (const f of Object.values(filas)) { const x = td[f.fecha] || (td[f.fecha] = { ventas: 0, gasto: 0 }); x.ventas += f.ventas; x.gasto += f.gasto; }
  for (const v of ventasLista) { const x = td[v.fecha]; v.meta = x && x.ventas > 0 ? x.gasto * v.total / x.ventas : 0; v.profit = v.total - v.comision - v.meta; }
  const lista = Object.values(filas).map(f => ({ ...f, ganancia: f.ventas - f.reembolsos - f.comisiones - f.gasto }));
  lista.sort((a, b) => (a.fecha + String(a.hora).padStart(2, "0")).localeCompare(b.fecha + String(b.hora).padStart(2, "0")) || a.tienda.localeCompare(b.tienda));
  // Gastos fijos mensuales del cliente, repartidos por día (mes de 30/31 días según corresponda).
  const fijosMes = (cfg.gastosFijos || []).reduce((t, g) => t + (Number(g.monto) || 0), 0);
  let fijos = 0;
  for (let d = desde; d <= hasta; d = addDias(d, 1)) { const [yy, mm] = d.split("-").map(Number); fijos += fijosMes / new Date(Date.UTC(yy, mm, 0)).getUTCDate(); }
  const tot = lista.reduce((t, f) => { for (const k of ["ventas", "n", "front", "nFront", "upsell", "nUpsell", "reembolsos", "comisiones", "comisionesEstimadas", "gasto"]) t[k] += f[k]; return t; }, { ventas: 0, n: 0, front: 0, nFront: 0, upsell: 0, nUpsell: 0, reembolsos: 0, comisiones: 0, comisionesEstimadas: 0, gasto: 0 });
  tot.ganancia = tot.ventas - tot.reembolsos - tot.comisiones - tot.gasto;
  tot.fijos = fijos; tot.fijosMes = fijosMes; tot.aceptaronPost = aceptaron.size;
  tot.roas = tot.gasto ? tot.ventas / tot.gasto : null;
  tot.cpa = tot.n ? tot.gasto / tot.n : null;
  return { desde, hasta, zona: tz, filas: lista, totales: tot, tiendas: tiendasLista, campanas: Object.values(campanas).sort((a, b) => (b.ventas + b.gasto) - (a.ventas + a.gasto)), meta: { cuentas: meta.cuentas, sinHora: meta.sinHora, errores: meta.errores }, stripe, mp, comisionPromedio: { pct: feePct, fijo: feeFijo, real: pctReal != null, cruzadas: conFee.length }, ventas: ventasLista.sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, 2000), fx: Object.fromEntries(MONEDAS_VISTA.filter(c => fx[c]).map(c => [c, c === "ARS" && fx._arsVista ? fx._arsVista : fx[c]])), arsCripto: !!fx._arsCripto, generado: new Date().toISOString() };
}

// Las 16 métricas del Dashboard digital, calculadas en Growith (las usa también el conector de Claude).
export function metricasDigitales(t0, nTiendas) {
  const r2 = (x) => x == null || !isFinite(x) ? null : Math.round(x * 100) / 100;
  const t = { ...t0, ganancia: t0.ganancia - (t0.fijos || 0) }; // el profit descuenta los gastos fijos del período
  const neto = t.ventas - t.comisiones - t.reembolsos;
  return {
    revenue: r2(t.ventas), profit: r2(t.ganancia), ad_spend: r2(t.gasto),
    break_even_roas: r2(neto > 0 ? t.ventas / neto : null), roas: r2(t.gasto ? t.ventas / t.gasto : null),
    margen_pct: r2(t.ventas ? t.ganancia / t.ventas * 100 : null), cpa_break_even: r2(t.n ? neto / t.n : null),
    true_roas: r2(t.gasto ? neto / t.gasto : null), cpa_real: r2(t.n && t.gasto ? t.gasto / t.n : null),
    ventas: t.n, aov: r2(t.n ? t.ventas / t.n : null), facturacion_promedio_por_tienda: r2(nTiendas ? t.ventas / nTiendas : null),
    comisiones: r2(t.comisiones), comisiones_estimadas: r2(t.comisionesEstimadas),
    revenue_front: r2(t.front), ventas_front: t.nFront, revenue_backend_postcompra: r2(t.upsell), upsells: t.nUpsell,
    gastos_fijos: r2(t0.fijos || 0), ganancia_por_venta: r2(t.n ? t.ganancia / t.n : null),
    aceptaron_post_compra: t0.aceptaronPost ?? null, aceptacion_post_compra_pct: r2(t.nFront ? (t0.aceptaronPost ?? t.nUpsell) / t.nFront * 100 : null), reembolsos: r2(t.reembolsos),
  };
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
  const g = await guardUid(req, res, uid, "margenes"); if (!g) return;
  // Productos digitales: por ahora NO se ven desde "Ver como cliente" del admin.
  if (g.user?.impersonatedBy) return res.status(403).json({ error: "Productos digitales no se puede ver desde \"Ver como cliente\"." });
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
        feePct: cfg.feePct ?? 2.9, feeFijo: cfg.feeFijo ?? 0.3, gastosFijos: cfg.gastosFijos || [],
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
    // Cotizaciones por 1 USD para mostrar montos en otra moneda (ARS = dólar cripto más bajo).
    // Reembolso por Stripe desde Growith: total o parcial, en la moneda en que pagó el comprador.
    if (action === "reembolsar" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)).toString() || "{}");
      const cfg = (await cfgRef.get()).data() || {};
      const key = descifrar(cfg.stripeEnc); if (!key) return res.status(400).json({ error: "Conectá Stripe con una clave que permita reembolsos." });
      const ref = db.collection("users").doc(uid).collection("impultienda_orders").doc(String(b.order_id || ""));
      const o = (await ref.get()).data(); if (!o) return res.status(404).json({ error: "Venta no encontrada" });
      if (o.reembolso && o.reembolso.status !== "failed" && o.reembolso.status !== "canceled") return res.status(409).json({ error: "Esta venta ya tiene un reembolso." });
      if (!o.stripe?.bt) return res.status(400).json({ error: "Esta venta no está cruzada con un cobro de Stripe." });
      const st = (u, opt) => fetch("https://api.stripe.com/v1/" + u, { ...opt, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" } }).then(r => r.json());
      const bt = await st(`balance_transactions/${o.stripe.bt}`); if (bt.error) return res.status(400).json({ error: bt.error.message });
      const chId = typeof bt.source === "string" ? bt.source : bt.source?.id; if (!chId) return res.status(400).json({ error: "No encontré el cobro en Stripe." });
      const ch = await st(`charges/${chId}`); if (ch.error) return res.status(400).json({ error: ch.error.message });
      const restante = (ch.amount - (ch.amount_refunded || 0));
      let monto = b.monto != null ? Math.round(Number(b.monto) * 100) : restante;
      if (!(monto > 0) || monto > restante) return res.status(400).json({ error: `Monto inválido (máximo ${(restante / 100).toFixed(2)} ${String(ch.currency).toUpperCase()}).` });
      const params = new URLSearchParams({ charge: chId, amount: String(monto), reason: "requested_by_customer", "metadata[orden]": String(o.orden || o.order_id), "metadata[origen]": "growith" });
      const rf = await st("refunds", { method: "POST", body: params.toString() });
      if (rf.error) return res.status(400).json({ error: rf.error.message });
      const fx = await fxPorUsd();
      const usdTotal = aUsd(Number(o.total) || 0, o.moneda, fx) ?? 0;
      const usd = monto >= ch.amount ? usdTotal : usdTotal * monto / ch.amount;
      const reembolso = { id: rf.id, status: rf.status, monto: monto / 100, moneda: String(rf.currency).toUpperCase(), usd, charge: chId, creado: new Date(rf.created * 1000).toISOString(), por: "growith" };
      await ref.set({ reembolso, actualizado: new Date().toISOString() }, { merge: true });
      const cs = await cfgRef.parent.get(); const bd = db.batch(); let k = 0; for (const x of cs.docs) if (x.id.startsWith("cache_")) { bd.delete(x.ref); k++; } if (k) await bd.commit();
      return res.json({ ok: true, reembolso });
    }
    // Actualiza el estado de un reembolso (pendiente → hecho) consultando a Stripe.
    if (action === "reembolso_estado") {
      const cfg = (await cfgRef.get()).data() || {};
      const key = descifrar(cfg.stripeEnc); if (!key) return res.status(400).json({ error: "Stripe no conectado" });
      const ref = db.collection("users").doc(uid).collection("impultienda_orders").doc(String(req.query.order_id || ""));
      const o = (await ref.get()).data(); if (!o?.reembolso?.id) return res.status(404).json({ error: "Sin reembolso" });
      const rf = await fetch(`https://api.stripe.com/v1/refunds/${o.reembolso.id}`, { headers: { Authorization: `Bearer ${key}` } }).then(r => r.json());
      if (rf.error) return res.status(400).json({ error: rf.error.message });
      const reembolso = { ...o.reembolso, status: rf.status };
      await ref.set({ reembolso }, { merge: true });
      return res.json({ ok: true, reembolso });
    }
    if (action === "fx") {
      const fx = await fxPorUsd();
      return res.json({ fx: Object.fromEntries(MONEDAS_VISTA.filter(c => fx[c]).map(c => [c, c === "ARS" && fx._arsVista ? fx._arsVista : fx[c]])) });
    }
    if (action === "importar" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)).toString() || "{}");
      // Sin el id real de Impultienda: la tienda se identifica por nombre (n_<nombre>) y se da de alta
      // en tiendasManual con su país; las ventas del webhook después se cruzan por ese mismo nombre.
      const sid0 = String(b.store_id || ""), nomT = String(b.store_nombre || "").slice(0, 80);
      const sid = /^[0-9a-f-]{20,40}$/i.test(sid0) ? sid0 : (nomT ? "n_" + norm(nomT).replace(/ /g, "_").slice(0, 60) : "");
      if (!sid) return res.status(400).json({ error: "Falta store_id o store_nombre" });
      if (sid.startsWith("n_")) await cfgRef.set({ tiendasManual: { [sid]: { nombre: nomT, pais: String(b.pais || "").toUpperCase().slice(0, 2) || null } } }, { merge: true });
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
      if (Array.isArray(b.gastosFijos)) patch.gastosFijos = b.gastosFijos.slice(0, 50).map(g => ({ nombre: String(g.nombre || "").slice(0, 60), monto: Math.max(0, Number(g.monto) || 0) })).filter(g => g.nombre || g.monto);
      if (b.feeFijo != null && isFinite(Number(b.feeFijo))) patch.feeFijo = Number(b.feeFijo);
      if (b.paises && typeof b.paises === "object") patch.paises = Object.fromEntries(Object.entries(b.paises).map(([k, v]) => [String(k), paisesDe(v).join(" ").slice(0, 60)]).filter(([, v]) => v));
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
      { const cs = await cfgRef.parent.get(); const bd = db.batch(); let k = 0; for (const x of cs.docs) if (x.id.startsWith("cache_")) { bd.delete(x.ref); k++; } if (k) await bd.commit(); }
      return res.json({ ok: true });
    }
    // Ventas reales por UTM para el administrador de Meta (campaña / conjunto / anuncio).
    if (action === "utm_atribucion") {
      const tz = tzValida(String(req.query.tz || "")) ? String(req.query.tz) : "America/Argentina/Buenos_Aires";
      const hoy = zonaDe(new Date().toISOString(), tz).fecha;
      const desde = /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde || "") ? req.query.desde : hoy;
      const hasta = /^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta || "") ? req.query.hasta : desde;
      if (Date.parse(hasta) - Date.parse(desde) > 92 * 86400000) return res.status(400).json({ error: "Máximo 92 días." });
      const cfgMain = (await cfgRef.get()).data() || {};
      const hayVentas = !(await db.collection("users").doc(uid).collection("impultienda_orders").limit(1).get()).empty;
      if (!cfgMain.secretEnc && !hayVentas) return res.json({ activo: false });
      // El índice se rehace solo cada 3 h (o con "Reprocesar 60 días").
      let idx = await leerIndiceUtm(db, uid);
      if (!idx || Date.now() - (idx.ts0 || idx.ts || 0) > 3 * 3600000) { idx = await construirIndiceUtm(db, uid, Math.max(60, idx?.dias || 0)); await db.collection("users").doc(uid).collection("impultienda_cfg").doc("utm_idx").set({ ts0: idx.ts }, { merge: true }).catch(() => {}); }
      else if (Date.now() - (idx.ts || 0) > 5 * 60000) idx = await construirIndiceUtm(db, uid, 2, idx);
      const out = await utmAtribucion(db, uid, desde, hasta, tz, idx);
      return res.json({ activo: true, moneda: "USD", desde, hasta, ...out, indice: { ts: idx.ts, dias: idx.dias, cuentas: idx.cuentas || 0, campanas: Object.keys(idx.c || {}).length, anuncios: Object.keys(idx.a || {}).length, errores: idx.errores || [] } });
    }
    // Reprocesar 60 días: rehace el índice de anuncios y vuelve a cruzar todas las ventas.
    if (action === "utm_reprocesar" && req.method === "POST") {
      const tz = "America/Argentina/Buenos_Aires";
      const idx = await construirIndiceUtm(db, uid, 60);
      const hoy = zonaDe(new Date().toISOString(), tz).fecha;
      const out = await utmAtribucion(db, uid, addDias(hoy, -60), hoy, tz, idx);
      const cs = await cfgRef.parent.get(); const bd = db.batch(); let k = 0;
      for (const d of cs.docs) if (d.id.startsWith("cache_")) { bd.delete(d.ref); k++; }
      if (k) await bd.commit();
      return res.json({ ok: true, ventas: out.total.n, atribuidas: out.total.n - out.sinAtribuir.n, sinUtm: out.sinUtm, importadas: out.importadas,
        campanas: Object.keys(idx.c).length, anuncios: Object.keys(idx.a).length, cuentas: idx.cuentas || 0, errores: idx.errores });
    }
    if (action === "por_hora") {
      const tz = tzValida(String(req.query.tz || "")) ? String(req.query.tz) : "America/Argentina/Buenos_Aires";
      const hoy = zonaDe(new Date().toISOString(), tz).fecha;
      const desde = /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde || "") ? req.query.desde : hoy;
      const hasta = /^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta || "") ? req.query.hasta : desde;
      if (Date.parse(hasta) - Date.parse(desde) > 31 * 86400000) return res.status(400).json({ error: "Máximo 31 días." });
      // Caché por rango (fresh=1 la saltea): 30 s si incluye hoy, para que el gasto se vea casi en vivo; 10 min si es pasado.
      const ttl = hasta >= hoy ? 30000 : 10 * 60000;
      const cacheRef = db.collection("users").doc(uid).collection("impultienda_cfg").doc(`cache_v11_${desde}_${hasta}_${tz.replace(/\//g, "-")}`);
      if (req.query.fresh !== "1") {
        const c = await cacheRef.get();
        if (c.exists && Date.now() - (c.data().ts || 0) < ttl) return res.json({ ...JSON.parse(c.data().body), cache: true });
      }
      const vk = cacheRef.path;
      let pr = _enVuelo.get(vk);
      if (!pr) { pr = porHora(db, uid, desde, hasta, tz).finally(() => _enVuelo.delete(vk)); _enVuelo.set(vk, pr); }
      const out = await pr;
      await cacheRef.set({ ts: Date.now(), body: JSON.stringify(out) }).catch(() => {});
      return res.json(out);
    }
    return res.status(400).json({ error: "acción desconocida" });
  } catch (e) {
    console.error("[impultienda]", action, e.message);
    return res.status(500).json({ error: e.message });
  }
}
