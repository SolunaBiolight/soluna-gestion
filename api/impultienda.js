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
  const r = await (await fetch(`https://graph.facebook.com/v23.0/me/adaccounts?fields=account_id,name,currency,timezone_name&limit=200&access_token=${encodeURIComponent(tk)}`, { signal: AbortSignal.timeout(20000) })).json();
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
  const campCuenta = {}, nombresCuenta = {}, sinHoraCuenta = {}; // para el desglose por cuenta publicitaria
  const adGasto = {}; // ad_id → {c: campaign_id, d: {fecha: usd}} — para repartir el gasto de cada campaña por tienda según el link de sus anuncios
  const adToken = {}; // ad_id → token que lo ve
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
    nombresCuenta[id] = c.name || id;
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
            if (row.campaign_id) campCuenta[row.campaign_id] = id;
            porDiaLocal[row.date_start] = (porDiaLocal[row.date_start] || 0) + usd;
          }
          url = r.paging?.next || null;
        }
      })();
      // Lo que Meta dice que vendió cada campaña (píxel), para comparar con la venta real.
      // Gasto por anuncio y día: una CBO puede mezclar anuncios de varias tiendas.
      const pAds = (async () => {
        let url = `https://graph.facebook.com/v23.0/${id}/insights?level=ad&fields=spend,ad_id,campaign_id&time_increment=1&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}&limit=500&access_token=${encodeURIComponent(tk)}`;
        for (let i = 0; url && i < 30; i++) {
          const r = await fetchJson(url); if (r.error) break;
          for (const row of r.data || []) { const usd = aUsd(Number(row.spend) || 0, c.currency, fx); if (!row.ad_id || !usd) continue; const x = adGasto[row.ad_id] || (adGasto[row.ad_id] = { c: row.campaign_id, d: {} }); x.d[row.date_start] = (x.d[row.date_start] || 0) + usd; adToken[row.ad_id] = tk; }
          url = r.paging?.next || null;
        }
      })().catch(() => {});
      const pPixel = fetchJson(`https://graph.facebook.com/v23.0/${id}/insights?level=campaign&fields=campaign_id,actions,action_values&time_range=${encodeURIComponent(JSON.stringify({ since: desde, until: hasta }))}&limit=500&access_token=${encodeURIComponent(tk)}`).catch(() => ({}));
      // Trampa conocida: el desglose horario puede no traer todavía las horas de HOY (zona de la cuenta).
      // Se compara con el gasto del día y la diferencia va a la hora ART actual, marcada como "sin hora exacta".
      const pHoy = fetchJson(`https://graph.facebook.com/v23.0/${id}/insights?level=account&fields=spend&time_range=${encodeURIComponent(JSON.stringify({ since: hoyLocal, until: hoyLocal }))}&access_token=${encodeURIComponent(tk)}`).catch(() => ({}));
      const [, rr, r2] = await Promise.all([pHoras, pPixel, pHoy, pAds]);
      for (const [k, v] of Object.entries(filas)) out[k] = (out[k] || 0) + v;
      for (const row of rr.data || []) {
        const pick = (arr) => { const a = (arr || []).find(x => x.action_type === "purchase") || (arr || []).find(x => x.action_type === "offsite_conversion.fb_pixel_purchase"); return a ? Number(a.value) || 0 : 0; };
        metaDice[row.campaign_id] = { compras: pick(row.actions), valor: aUsd(pick(row.action_values), c.currency, fx) || 0 };
      }
      const totalHoy = aUsd(Number(r2.data?.[0]?.spend) || 0, c.currency, fx) || 0;
      const falta = totalHoy - (porDiaLocal[hoyLocal] || 0);
      if (falta > 0.01) {
        const a = zonaDe(new Date().toISOString(), tzU);
        if (a.fecha >= desde && a.fecha <= hasta) { const k = `${a.fecha}|${a.hora}||`; out[k] = (out[k] || 0) + falta; sinHora += falta; sinHoraCuenta[id] = (sinHoraCuenta[id] || 0) + falta; }
      }
    } catch (e) { errores.push(`${id}: ${e.message}`); }
  });
  return { porHora: out, sinHora, cuentas: vistas.size, errores, metaDice, campCuenta, nombresCuenta, sinHoraCuenta, adGasto, adToken };
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

// ── Stripe: reembolsos y disputas hechos fuera de Growith ──
// Se guardan por balance_transaction del cobro (el mismo o.stripe.bt de la venta), así se cruzan aunque la venta
// sea vieja. Doc impultienda_cfg/stripe_movs {at, ch:{cobro: bt}, m:{bt:{txId:{t, usd, fee, at}}}}.
const STRIPE_MOV_TIPOS = ["refund", "refund_failure", "payment_refund", "payment_failure_refund", "adjustment"];
async function stripeMovimientos(db, uid, cfg) {
  const key = descifrar(cfg.stripeEnc);
  if (!key) return { m: {} };
  const ref = db.collection("users").doc(uid).collection("impultienda_cfg").doc("stripe_movs");
  const prev = (await ref.get()).data() || {};
  const m = prev.m || {}, ch = prev.ch || {}, d = prev.d || {};
  const ahora = Date.now();
  if (prev.at && ahora - prev.at < 10 * 60000) return { m, d };
  const desde = Math.floor((prev.at ? prev.at - 2 * 86400000 : ahora - 180 * 86400000) / 1000);
  const st = (u) => fetch("https://api.stripe.com/v1/" + u, { headers: { Authorization: `Bearer ${key}` } }).then(r => r.json());
  try {
    const listas = await Promise.all(STRIPE_MOV_TIPOS.map(async (tipo) => {
      const out = [];
      let url = `balance_transactions?limit=100&type=${tipo}&created[gte]=${desde}&expand[]=data.source`;
      for (let i = 0; i < 20; i++) {
        const j = await st(url);
        if (j.error) throw new Error(j.error.message);
        out.push(...(j.data || []));
        if (!j.has_more || !j.data?.length) break;
        url = url.replace(/&starting_after=[^&]*/, "") + `&starting_after=${j.data[j.data.length - 1].id}`;
      }
      return out;
    }));
    const fx = await fxPorUsd();
    for (const t of listas.flat()) {
      const disputa = t.reporting_category === "dispute" || t.reporting_category === "dispute_reversal" || t.source?.object === "dispute";
      if (t.type === "adjustment" && !disputa) continue;
      const chId = typeof t.source?.charge === "string" ? t.source.charge : t.source?.charge?.id;
      if (!chId) continue;
      if (!ch[chId]) {
        const c = await st(`charges/${chId}`);
        if (c.error) throw new Error(c.error.message);
        ch[chId] = typeof c.balance_transaction === "string" ? c.balance_transaction : c.balance_transaction?.id || "";
      }
      if (!ch[chId]) continue;
      // amount es negativo cuando la plata sale (reembolso, disputa) y positivo cuando vuelve (disputa ganada, reembolso fallido).
      const usd = aUsd(Math.abs(t.amount) / 100, t.currency, fx), fee = aUsd(Math.abs(t.fee) / 100, t.currency, fx);
      if (usd == null || fee == null) continue;
      (m[ch[chId]] || (m[ch[chId]] = {}))[t.id] = { t: disputa ? "disputa" : "reembolso", usd: t.amount < 0 ? usd : -usd, fee: t.fee < 0 ? -fee : fee, at: new Date(t.created * 1000).toISOString() };
      if (disputa && t.source?.id) d[ch[chId]] = { id: t.source.id, st: t.source.status || "" };
    }
    // Disputas leídas directo de Stripe (180 días): cada una trae sus movimientos (plata retirada + costo, y la
    // devolución si se gana). No depender solo del listado por tipo, que no siempre las trae.
    let durl = `disputes?limit=100&created[gte]=${Math.floor((ahora - 180 * 86400000) / 1000)}&expand[]=data.balance_transactions`;
    for (let i = 0; i < 10; i++) {
      const j = await st(durl);
      if (j.error) throw new Error(j.error.message);
      for (const dp of j.data || []) {
        const chId = typeof dp.charge === "string" ? dp.charge : dp.charge?.id;
        if (!chId) continue;
        if (!ch[chId]) {
          const c = await st(`charges/${chId}`);
          if (c.error) continue;
          ch[chId] = typeof c.balance_transaction === "string" ? c.balance_transaction : c.balance_transaction?.id || "";
        }
        if (!ch[chId]) continue;
        const mm = m[ch[chId]] || (m[ch[chId]] = {});
        for (const t of dp.balance_transactions || []) {
          const usd = aUsd(Math.abs(t.amount) / 100, t.currency, fx), fee = aUsd(Math.abs(t.fee) / 100, t.currency, fx);
          if (usd == null || fee == null) continue;
          mm[t.id] = { t: "disputa", usd: t.amount < 0 ? usd : -usd, fee: t.fee < 0 ? -fee : fee, at: new Date(t.created * 1000).toISOString() };
        }
        d[ch[chId]] = { id: dp.id, st: dp.status || "", motivo: dp.reason || "" };
      }
      if (!j.has_more || !j.data?.length) break;
      durl = durl.replace(/&starting_after=[^&]*/, "") + `&starting_after=${j.data[j.data.length - 1].id}`;
    }
    // Perder una disputa no genera movimiento nuevo: hay que preguntarle a Stripe por las que siguen abiertas.
    await Promise.all(Object.values(d).filter(x => !["won", "lost", "warning_closed"].includes(x.st)).slice(0, 30).map(async (x) => {
      const j = await st(`disputes/${x.id}`).catch(() => null);
      if (j?.status) x.st = j.status;
    }));
    await ref.set({ at: ahora, m, ch, d });
    return { m, d };
  } catch (e) { return { m, d, error: e.message }; }
}
function resumenMovs(txs) {
  const r = { reembolso: 0, disputa: 0, feeDisputa: 0, feeOtros: 0 };
  for (const x of Object.values(txs || {})) { r[x.t] += x.usd; if (x.t === "disputa") r.feeDisputa += x.fee; else r.feeOtros += x.fee; }
  r.total = r.reembolso + r.disputa + r.feeDisputa + r.feeOtros;
  return r;
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
  // La tienda se puede renombrar en Impultienda: vale el nombre de su venta más reciente (no el primero que se vio).
  const ultimo = {};
  for (const o of ordenes) { if (!o.store_id || !o.store_nombre || o.importado) continue; const ts = o.ev_approved || o.actualizado || ""; if (!ultimo[o.store_id] || ts > ultimo[o.store_id].ts) ultimo[o.store_id] = { ts, nombre: o.store_nombre }; }
  for (const [id, u] of Object.entries(ultimo)) if (tiendasMap[id]) tiendasMap[id].nombre = u.nombre;
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
  // Pagos iniciados y rechazados de Impultienda (webhooks "Orden creada" / "Pago rechazado" / "Carrito abandonado"):
  // una orden cuenta una vez, en el momento de su primer evento. Solo si la cuenta manda esos eventos.
  out.intentos = ordenes.some(o => o.ev_created || o.ev_rejected || o.ev_abandoned);
  out.pi = { n: 0, rech: 0 };
  if (out.intentos) for (const o of ordenes) {
    if (o.post_compra || o.importado) continue;
    const ts = [o.ev_created, o.ev_rejected, o.ev_abandoned, o.ev_approved].map(x => Date.parse(x || "")).filter(isFinite);
    if (!ts.length) continue;
    const t0 = Math.min(...ts);
    if (t0 < desdeMs || t0 >= hastaMs) continue;
    if (opts.dentro && !opts.dentro(o, tiendasMap[o.store_id])) continue;
    const rech = o.ev_rejected && !o.ev_approved ? 1 : 0;
    out.pi.n++; out.pi.rech += rech;
    const x = atr[o.order_id];
    if (x) for (const nivel of ["c", "s", "a"]) if (x[nivel]) { const m = out[nivel][x[nivel]] || (out[nivel][x[nivel]] = { n: 0, rev: 0 }); m.pi = (m.pi || 0) + 1; m.rech = (m.rech || 0) + rech; }
  }
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
// ── Tienda de cada anuncio por el link al que lleva ──
// URL del creativo (link_data, video CTA, asset feed, link_url/object_url). Se guarda el host+primer tramo del path
// en users/{uid}/impultienda_cfg/ad_links {a: {ad_id: "host/path"}} porque el link de un anuncio no cambia.
function linkDeCreativo(cr) {
  if (!cr) return null;
  const o = cr.object_story_spec || {};
  const cands = [o.link_data?.link, o.link_data?.call_to_action?.value?.link, o.video_data?.call_to_action?.value?.link, o.template_data?.link,
    ...(cr.asset_feed_spec?.link_urls || []).map(l => l.website_url), cr.link_url, cr.object_url, cr.template_url];
  for (const u of cands) { try { if (u && /^https?:/i.test(u)) { const x = new URL(u); if (/facebook\.com|fb\.me|instagram\.com/i.test(x.host)) continue; return (x.host.replace(/^www\./, "") + "/" + (x.pathname.split("/").filter(Boolean)[0] || "")).toLowerCase(); } } catch (_) {} }
  return null;
}
async function linksDeAnuncios(db, uid, ads, adToken) {
  const ref = db.collection("users").doc(uid).collection("impultienda_cfg").doc("ad_links");
  const cache = (await ref.get().catch(() => null))?.data()?.a || {};
  const faltan = ads.filter(a => cache[a] === undefined && adToken[a]);
  const nuevos = {};
  const lotes = []; for (let i = 0; i < faltan.length && i < 600; i += 50) lotes.push(faltan.slice(i, i + 50));
  await enParalelo(lotes, 4, async (l) => {
    try {
      const r = await fetchJson(`https://graph.facebook.com/v23.0/?ids=${l.join(",")}&fields=creative{object_story_spec,asset_feed_spec,link_url,object_url,template_url}&access_token=${encodeURIComponent(adToken[l[0]])}`);
      if (r.error) return;
      for (const a of l) if (r[a]) nuevos[a] = linkDeCreativo(r[a].creative) || "";
    } catch (_) {}
  });
  if (Object.keys(nuevos).length) await ref.set({ a: nuevos }, { merge: true }).catch(() => {});
  return { ...cache, ...nuevos };
}
const tokensNombre = (x) => norm(x).split(" ").filter(w => w.length >= 3);

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
  const [stripe, mp, movs] = await Promise.all([stripeComisiones(db, uid, cfg, delRango, desdeMs, hastaMs), mpComisiones(db, uid, delRango, desdeMs, hastaMs), stripeMovimientos(db, uid, cfg)]);
  if (movs.error) stripe.errorMovimientos = movs.error;
  if (movs.d && stripe) stripe.disputas = Object.entries(movs.d).map(([bt, x]) => ({ estado: x.st, motivo: x.motivo || null, venta: (ordenes.find(o => o.stripe?.bt === bt) || {}).orden ?? null, movimientos: Object.values(movs.m[bt] || {}) }));
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
      // Lo que dice Stripe manda: ve lo hecho fuera de Growith y los US$ de la disputa, que también restan.
      const mov = o.stripe?.bt && movs.m[o.stripe.bt] ? resumenMovs(movs.m[o.stripe.bt]) : null;
      const disp = mov && Object.values(movs.m[o.stripe.bt]).some(x => x.t === "disputa") ? { usd: mov.disputa, fee: mov.feeDisputa, estado: mov.disputa <= 0.005 || movs.d?.[o.stripe.bt]?.st === "won" ? "ganada" : movs.d?.[o.stripe.bt]?.st === "lost" ? "perdida" : "abierta" } : null;
      const reemb = mov ? mov.total : o.reembolso?.usd != null ? o.reembolso.usd : (o.ev_refunded || o.ev_chargeback ? usd : 0);
      f.reembolsos += reemb;
      cv.comisiones += com;
      const atr = atribuirUtm(o.utm, idxUtm);
      ventasLista.push({ tid, campKey: ck, ad, adId: atr?.a || null, adsetId: atr?.s || null, campId: atr?.c || null, utmRaw: !!o.utm, comisionDetalle: o.stripe?.det || null, orden: o.orden ?? o.order_id, fecha: a.fecha, hora: a.hora, at: o.ev_approved, tienda: tiendasMap[tid]?.nombre || o.store_nombre || tid,
        total: usd, totalOriginal: Number(o.buyer_total ?? o.total) || 0, monedaOriginal: o.buyer_moneda || o.moneda || "USD", post_compra: !!o.post_compra,
        comision: com, fuente: o.stripe?.fee != null ? "stripe" : o.mp?.fee != null ? "mercadopago" : "estimada", stripe_id: o.stripe?.bt || null,
        pasarela: o.pasarela || null, campana: o.utm?.utm_campaign || null, anuncio: (o.utm?.utm_content && idxUtm?.a?.[o.utm.utm_content]?.[0]) || o.utm?.utm_content || null, importado: !!o.importado,
        reembolsada: mov ? mov.reembolso + (disp?.estado === "perdida" ? mov.disputa : 0) > 0.005 : !!(o.ev_refunded || o.ev_chargeback || o.reembolso), reembolso: o.reembolso || null, reembolsoUsd: reemb, disputa: disp, email: o.email || null,
        order_id: o.order_id });
    }
  }

  const tiendasLista = Object.values(tiendasMap);
  // Tienda de una campaña cuando el nombre no dice el país: adonde fueron SUS ventas por UTM en el período (la que más tuvo).
  const tiendaPorVentas = (key) => { const t = ventasCamp[key]?.tiendas; if (!t) return null; const top = Object.entries(t).sort((a, b) => b[1] - a[1])[0]; return top ? top[0] : null; };
  // Gasto por tienda a nivel ANUNCIO: cada anuncio va a la tienda a la que lleva su link. El link→tienda se aprende
  // de las ventas (venta con utm_content = id del anuncio → su tienda) y, si no hay, por el nombre de la tienda en el link.
  const adsIds = Object.keys(meta.adGasto || {});
  const links = adsIds.length ? await linksDeAnuncios(db, uid, adsIds, meta.adToken || {}) : {};
  const votos = {};
  for (const o of ordenes) {
    if (!o.store_id || o.post_compra) continue;
    const a = atribuirUtm(o.utm, idxUtm)?.a || o.utm?.utm_content; const l = a && links[a];
    if (l) { const v = votos[l] || (votos[l] = {}); v[o.store_id] = (v[o.store_id] || 0) + 1; }
  }
  const tiendaDeLink = (l) => {
    if (!l) return null;
    const v = votos[l]; if (v) return Object.entries(v).sort((a, b) => b[1] - a[1])[0][0];
    const host = l.split("/")[0]; const hv = {}; for (const [k, x] of Object.entries(votos)) if (k.split("/")[0] === host) for (const [t, n] of Object.entries(x)) hv[t] = (hv[t] || 0) + n;
    const top = Object.entries(hv).sort((a, b) => b[1] - a[1])[0]; if (top) return top[0];
    const lt = norm(l.replace(/\.impultienda\.ar|\.[a-z]{2,3}(?=\/|$)/g, " ")).split(" ");
    const hits = tiendasLista.filter(t => { const tt = tokensNombre(String(t.nombre).replace(/\(.*?\)/g, "")); return tt.length && tt.every(w => lt.some(x => x.startsWith(w) || w.startsWith(x))); });
    return hits.length === 1 ? hits[0].id : null;
  };
  const adTienda = {}; for (const a of adsIds) adTienda[a] = tiendaDeLink(links[a]);
  // Reparto de cada campaña por día: {cid: {fecha: {tid: usd}}} (también el total del rango para los días sin dato).
  const reparto = {};
  for (const [a, x] of Object.entries(meta.adGasto || {})) {
    const tid = adTienda[a] || "_camp"; if (!x.c) continue; // anuncio sin tienda detectada: sigue la regla de la campaña
    const rc = reparto[x.c] || (reparto[x.c] = { _tot: {} });
    for (const [d, usd] of Object.entries(x.d)) { const rd = rc[d] || (rc[d] = {}); rd[tid] = (rd[tid] || 0) + usd; rc._tot[tid] = (rc._tot[tid] || 0) + usd; }
  }
  const partes = (cid, fecha) => { const rc = reparto[cid]; if (!rc) return null; const m = rc[fecha] && Object.keys(rc[fecha]).length ? rc[fecha] : rc._tot; const t = Object.values(m).reduce((a, b) => a + b, 0); return t > 0 ? Object.entries(m).map(([tid, v]) => [tid, v / t]) : null; };
  const campanas = {};
  for (const [k, usd] of Object.entries(meta.porHora)) {
    const [fecha, hora, camp, cid] = k.split("|");
    if (fecha < desde || fecha > hasta) continue;
    const tCamp = tiendaDeCampana(camp, tiendasLista) || tiendaPorVentas(cid || camp) || "SIN_ASIGNAR";
    const pp = cid && partes(cid, fecha)?.map(([t, f]) => [t === "_camp" ? tCamp : t, f]);
    const tid = pp ? [...pp].sort((a, b) => b[1] - a[1])[0][0] : tCamp;
    if (pp) for (const [t, f] of pp) fila(fecha, parseInt(hora, 10), t).gasto += usd * f;
    else fila(fecha, parseInt(hora, 10), tid).gasto += usd;
    if (camp) { const key = cid || camp; const c = campanas[key] || (campanas[key] = { key, id: cid || null, nombre: camp, tienda: tid, gasto: 0 }); c.gasto += usd; }
  }
  // Venta sin UTM que cruce: si su tienda tuvo UNA sola campaña con gasto en el período, es de esa campaña
  // (el checkout a veces pierde las UTM; con una sola campaña no hay a quién más atribuirla).
  const campsTienda = {};
  for (const c of Object.values(campanas)) if (c.gasto > 0 && c.tienda && c.tienda !== "SIN_ASIGNAR") (campsTienda[c.tienda] || (campsTienda[c.tienda] = new Set())).add(c.key);
  for (const v of ventasLista) {
    const s = campsTienda[v.tid]; if (v.campKey !== "SIN_CAMPANA" || !s || s.size !== 1) continue;
    const ck = [...s][0], de = ventasCamp.SIN_CAMPANA, a = ventasCamp[ck] || (ventasCamp[ck] = { ventas: 0, n: 0, comisiones: 0, anuncios: {}, tiendas: {} });
    const n = v.post_compra ? 0 : 1;
    de.ventas -= v.total; de.n -= n; de.comisiones -= v.comision;
    const ad0 = de.anuncios[v.ad]; if (ad0) { ad0.ventas -= v.total; ad0.n -= n; if (ad0.ventas < 0.005 && ad0.n <= 0) delete de.anuncios[v.ad]; }
    a.ventas += v.total; a.n += n; a.comisiones += v.comision;
    const ad = "sin anuncio (UTM perdida)"; const av = a.anuncios[ad] || (a.anuncios[ad] = { anuncio: ad, ventas: 0, n: 0 }); av.ventas += v.total; av.n += n;
    v.campKey = ck; v.campInferida = true;
    if (de.ventas < 0.005 && de.n <= 0) delete ventasCamp.SIN_CAMPANA;
  }
  for (const [ck, v] of Object.entries(ventasCamp)) {
    const c = campanas[ck] || (campanas[ck] = { key: ck, id: esIdMeta(ck) ? ck : null, nombre: ck === "SIN_CAMPANA" ? "Sin campaña (venta sin UTM que cruce)" : esIdMeta(ck) ? `${idxUtm?.c?.[ck] || `Campaña ${ck}`} (sin gasto leído: cuenta no elegida en Meta → Configuración)` : ck, tienda: null, gasto: 0 });
    c.ventas = v.ventas; c.n = v.n; c.comisiones = v.comisiones;
    c.anuncios = Object.values(v.anuncios).sort((a, b) => b.ventas - a.ventas);
  }
  for (const c of Object.values(campanas)) { if (c.id && meta.metaDice?.[c.id]) c.metaDice = meta.metaDice[c.id];
    c.ventas = c.ventas || 0; c.n = c.n || 0; c.comisiones = c.comisiones || 0; c.ganancia = c.ventas - c.comisiones - c.gasto; c.roas = c.gasto ? c.ventas / c.gasto : null; c.cpa = c.n && c.gasto ? c.gasto / c.n : null; }
  // Desglose por cuenta publicitaria: gasto de sus campañas (+ el de hoy aún sin hora) y las ventas reales de esas campañas por UTM.
  const reembCamp = {}; for (const v of ventasLista) reembCamp[v.campKey] = (reembCamp[v.campKey] || 0) + (v.reembolsoUsd || 0);
  const porCuenta = {};
  const cta = (id) => porCuenta[id] || (porCuenta[id] = { id, nombre: id === "SIN_CAMPANA" ? "Ventas sin campaña" : id === "OTRA" ? "Cuentas no elegidas" : meta.nombresCuenta?.[id] || id, gasto: 0, ventas: 0, n: 0, comisiones: 0, reembolsos: 0, campanas: 0 });
  for (const c of Object.values(campanas)) {
    const x = cta(c.key === "SIN_CAMPANA" ? "SIN_CAMPANA" : meta.campCuenta?.[c.id] || "OTRA");
    x.gasto += c.gasto; x.ventas += c.ventas; x.n += c.n; x.comisiones += c.comisiones; x.reembolsos += reembCamp[c.key] || 0; if (c.gasto > 0) x.campanas += 1;
  }
  for (const [id, usd] of Object.entries(meta.sinHoraCuenta || {})) cta(id).gasto += usd;
  const cuentasLista = Object.values(porCuenta).map(x => ({ ...x, ganancia: x.ventas - x.comisiones - x.reembolsos - x.gasto, roas: x.gasto ? x.ventas / x.gasto : null, cpa: x.n && x.gasto ? x.gasto / x.n : null }))
    .filter(x => x.gasto > 0.01 || x.ventas > 0.01).sort((a, b) => b.ganancia - a.ganancia);
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
  return { desde, hasta, zona: tz, porCuenta: cuentasLista, filas: lista, totales: tot, tiendas: tiendasLista, campanas: Object.values(campanas).sort((a, b) => (b.ventas + b.gasto) - (a.ventas + a.gasto)), meta: { cuentas: meta.cuentas, sinHora: meta.sinHora, errores: meta.errores }, stripe, mp, comisionPromedio: { pct: feePct, fijo: feeFijo, real: pctReal != null, cruzadas: conFee.length }, ventas: ventasLista.sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, 2000), fx: Object.fromEntries(MONEDAS_VISTA.filter(c => fx[c]).map(c => [c, c === "ARS" && fx._arsVista ? fx._arsVista : fx[c]])), arsCripto: !!fx._arsCripto, generado: new Date().toISOString() };
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

// ── API de solo lectura para un bot externo ──
// GET /api/bot/metricas (rewrite → ?action=bot_metricas). Header X-Bot-Key = env BOT_API_KEY
// (opcional BOT_CLIENTES="uid1,uid2" para limitar a qué clientes puede leer). 10 pedidos/min.
// Misma lógica que el Dashboard digital (porHora) + gasto de Meta por conjunto y anuncio
// (insights level=ad por hora, caché 5 min). Nunca escribe en Meta ni en los datos del cliente.
const _botAds = new Map(); // `${uid}|${since}|${until}` → {ts, filas}
async function metaAdsPorHora(db, uid, since, until, elegidas) {
  const k = `${uid}|${since}|${until}`; const hit = _botAds.get(k);
  if (hit && Date.now() - hit.ts < 5 * 60000) return hit.filas;
  const snap = await db.collection("users").doc(uid).collection("meta_accounts").get();
  const tokens = [...new Set(snap.docs.map(d => d.data()?.access_token).filter(Boolean))];
  const fx = await fxPorUsd(); const trabajos = []; const vistas = new Set(); const filas = []; const errores = [];
  for (const tk of tokens) { let cs = []; try { cs = await cuentasDelToken(tk); } catch (e) { errores.push(e.message); }
    for (const c of cs) { const id = "act_" + c.account_id; if (vistas.has(id) || (elegidas.length && !elegidas.includes(id))) continue; vistas.add(id); trabajos.push({ tk, c, id }); } }
  await enParalelo(trabajos, 6, async ({ tk, c, id }) => {
    const tz = c.timezone_name || "America/Los_Angeles";
    let url = `https://graph.facebook.com/v23.0/${id}/insights?level=ad&fields=spend,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name&time_increment=1&breakdowns=hourly_stats_aggregated_by_advertiser_time_zone&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}&limit=500&access_token=${encodeURIComponent(tk)}`;
    for (let i = 0; url && i < 40; i++) {
      const r = await fetchJson(url).catch(e => ({ error: { message: e.message } }));
      if (r.error) { errores.push(`${id}: ${r.error.message}`); break; }
      for (const row of r.data || []) {
        const hh = parseInt(String(row.hourly_stats_aggregated_by_advertiser_time_zone || "").slice(0, 2), 10);
        const usd = aUsd(Number(row.spend) || 0, c.currency, fx); if (!isFinite(hh) || !usd) continue;
        filas.push({ t: utcDeLocal(row.date_start, hh, tz), cuenta: id, c: row.campaign_id, cn: row.campaign_name, s: row.adset_id, sn: row.adset_name, a: row.ad_id, an: row.ad_name, usd });
      }
      url = r.paging?.next || null;
    }
  });
  const out = { filas, errores };
  _botAds.set(k, { ts: Date.now(), filas: out }); if (_botAds.size > 50) _botAds.delete(_botAds.keys().next().value);
  return out;
}
async function botMetricas(req, res, db) {
  // La clave no está en el código: solo su SHA-256 (no se puede recuperar la clave desde la huella).
  // Si se carga BOT_API_KEY en Vercel, manda esa.
  const clave = String(process.env.BOT_API_KEY || ""), dada = String(req.headers["x-bot-key"] || "");
  const ha = crypto.createHash("sha256").update(dada).digest();
  const hb = clave ? crypto.createHash("sha256").update(clave).digest() : Buffer.from("9d1b797392e646dd77ea6dbaf0d911abc814086dd5b462738a5d2fbe853bb071", "hex");
  res.setHeader("X-Bot-Auth", clave ? "env" : "huella"); // diagnóstico: de dónde sale la clave (no la expone)
  if (!dada || dada.length < 32 || !crypto.timingSafeEqual(ha, hb)) return res.status(401).json({ error: "no autorizado" });
  if (req.method !== "GET") return res.status(405).json({ error: "solo GET" });
  // 10 pedidos por minuto (contador en Firestore, sirve entre instancias).
  const min = Math.floor(Date.now() / 60000), rref = db.collection("bot_rate").doc(String(min));
  const n = await db.runTransaction(async tx => { const s = await tx.get(rref); const v = (s.data()?.n || 0) + 1; tx.set(rref, { n: v, exp: new Date((min + 2) * 60000) }); return v; });
  if (n > 10) { res.setHeader("Retry-After", String(60 - Math.floor(Date.now() / 1000) % 60)); return res.status(429).json({ error: "máximo 10 pedidos por minuto" }); }
  const uid = String(req.query.cliente_id || "");
  const permitidos = String(process.env.BOT_CLIENTES || "").split(",").map(x => x.trim()).filter(Boolean);
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(uid) || (permitidos.length && !permitidos.includes(uid))) return res.status(403).json({ error: "cliente_id no permitido" });
  if (!(await db.collection("users").doc(uid).get()).exists) return res.status(404).json({ error: "cliente no encontrado" });
  const TZ = "America/Argentina/Buenos_Aires", hoy = zonaDe(new Date().toISOString(), TZ).fecha;
  const vh = req.query.ventana_horas != null ? Number(req.query.ventana_horas) : null;
  let desde, hasta, desdeMs, hastaMs;
  if (vh != null) {
    if (!(vh >= 1 && vh <= 24 * 31)) return res.status(400).json({ error: "ventana_horas entre 1 y 744" });
    hastaMs = Date.now(); desdeMs = hastaMs - vh * 3600000; desde = zonaDe(new Date(desdeMs).toISOString(), TZ).fecha; hasta = hoy;
  } else {
    desde = String(req.query.desde || hoy); hasta = String(req.query.hasta || desde);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta) || desde > hasta) return res.status(400).json({ error: "desde/hasta AAAA-MM-DD" });
    if ((Date.parse(hasta) - Date.parse(desde)) / 86400000 > 31) return res.status(400).json({ error: "máximo 31 días" });
    desdeMs = utcDeLocal(desde, 0, TZ); hastaMs = utcDeLocal(addDias(hasta, 1), 0, TZ);
  }
  const cfg = (await db.collection("users").doc(uid).collection("impultienda_cfg").doc("main").get()).data() || {};
  const [ph, ads] = await Promise.all([porHora(db, uid, desde, hasta, TZ), metaAdsPorHora(db, uid, addDias(desde, -1), addDias(hasta, 1), cfg.metaCuentas || [])]);
  const enV = (ms) => ms >= desdeMs && ms < hastaMs;
  const ventas = (ph.ventas || []).filter(v => enV(Date.parse(v.at)));
  const gastoAds = ads.filas.filter(f => enV(f.t));
  const r2 = (x) => x == null || !isFinite(x) ? null : Math.round(x * 100) / 100;
  const met = (o) => ({ gasto: r2(o.gasto), ventas: o.n, facturacion: r2(o.fac), roas: r2(o.gasto ? o.fac / o.gasto : null), cpa: r2(o.n && o.gasto ? o.gasto / o.n : null) });
  const nuevo = () => ({ gasto: 0, n: 0, fac: 0, com: 0, reemb: 0 });
  const camps = {}; const tiendas = {}; const hora = {}; const sinUtm = { n: 0, fac: 0 }; const tot = nuevo();
  const camp = (id, nombre) => camps[id] || (camps[id] = { id, nombre: nombre || ph.campanas?.find(c => c.id === id)?.nombre || null, ...nuevo(), tiendas: {}, sets: {} });
  const set = (c, id, nombre) => c.sets[id] || (c.sets[id] = { id, nombre: nombre || null, ...nuevo(), ads: {} });
  const adOf = (s, id, nombre) => s.ads[id] || (s.ads[id] = { id, nombre: nombre || null, ...nuevo() });
  const hk = (ms, cid) => { const h = new Date(Math.floor(ms / 3600000) * 3600000).toISOString(); const k = `${h}|${cid}`; return hora[k] || (hora[k] = { hora_utc: h, campaign_id: cid, ...nuevo() }); };
  for (const f of gastoAds) {
    const c = camp(f.c, f.cn); const s = set(c, f.s, f.sn); const a = adOf(s, f.a, f.an);
    for (const x of [c, s, a, tot, hk(f.t, f.c)]) x.gasto += f.usd;
  }
  for (const v of ventas) {
    const n = v.post_compra ? 0 : 1, rb = v.reembolsoUsd || 0;
    tot.n += n; tot.fac += v.total; tot.com += v.comision; tot.reemb += rb;
    const t = tiendas[v.tid] || (tiendas[v.tid] = { tienda: v.tienda, ...nuevo() }); t.n += n; t.fac += v.total; t.com += v.comision; t.reemb += rb;
    const cid = v.campId || (/^\d{10,}$/.test(v.campKey || "") ? v.campKey : null);
    if (!cid) { sinUtm.n += n; sinUtm.fac += v.total; continue; }
    const c = camp(cid); c.n += n; c.fac += v.total; c.tiendas[v.tienda] = (c.tiendas[v.tienda] || 0) + 1;
    const hx = hk(Date.parse(v.at), cid); hx.n += n; hx.fac += v.total;
    const sid = v.adsetId || (v.adId && ads.filas.find(f => f.a === v.adId)?.s) || null;
    if (sid) { const s = set(c, sid); s.n += n; s.fac += v.total; if (v.adId) { const a = adOf(s, v.adId); a.n += n; a.fac += v.total; } }
  }
  // Tienda de cada campaña: la del Dashboard (por anuncio/país) o la que más ventas tuvo.
  const tiendaDe = Object.fromEntries((ph.campanas || []).filter(c => c.id).map(c => [c.id, c.tienda]));
  const tMap = Object.fromEntries((ph.tiendas || []).map(t => [t.id, t]));
  for (const t of Object.values(tiendas)) t.gasto = 0;
  for (const f of gastoAds) { const tid = tiendaDe[f.c]; const tt = tid && tMap[tid] && Object.values(tiendas).find(x => x.tienda === tMap[tid].nombre); if (tt) tt.gasto += f.usd; }
  const be = (o) => { const neto = o.fac - o.com - o.reemb; return { cpa_break_even: r2(o.n ? neto / o.n : null), break_even_roas: r2(neto > 0 ? o.fac / neto : null) }; };
  const campanas = Object.values(camps).map(c => { const tid = tiendaDe[c.id]; const t = tid && tMap[tid]; const top = Object.entries(c.tiendas).sort((a, b) => b[1] - a[1])[0];
    return { campaign_id: c.id, nombre: c.nombre, tienda: t?.nombre || top?.[0] || null, pais: t?.pais || null, ...met(c),
      conjuntos: Object.values(c.sets).map(s => ({ adset_id: s.id, nombre: s.nombre, ...met(s), anuncios: Object.values(s.ads).map(a => ({ ad_id: a.id, nombre: a.nombre, ...met(a) })).sort((x, y) => y.gasto - x.gasto) })).sort((x, y) => y.gasto - x.gasto) }; })
    .sort((a, b) => (b.gasto + b.facturacion) - (a.gasto + a.facturacion));
  res.setHeader("Cache-Control", "no-store");
  return res.json({
    generado_utc: new Date().toISOString(), cliente_id: uid,
    ventana: { desde_utc: new Date(desdeMs).toISOString(), hasta_utc: new Date(hastaMs).toISOString() },
    totales: { ...met(tot), comisiones: r2(tot.com), reembolsos: r2(tot.reemb), ...be(tot) },
    tiendas: Object.values(tiendas).map(t => ({ tienda: t.tienda, ...met(t), ...be(t) })),
    campanas,
    por_hora: Object.values(hora).sort((a, b) => a.hora_utc.localeCompare(b.hora_utc)).map(h => ({ hora_utc: h.hora_utc, campaign_id: h.campaign_id, gasto: r2(h.gasto), ventas: h.n, facturacion: r2(h.fac) })),
    ventas_sin_utm: { ventas: sinUtm.n, facturacion: r2(sinUtm.fac) },
    avisos: { errores_meta: [...(ads.errores || []), ...(ph.meta?.errores || [])].slice(0, 5) },
  });
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
  if (action === "bot_metricas") return botMetricas(req, res, db);
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
      const cuentas = new Map(), errores = [];
      for (const tk of tokens) {
        // Misma lectura (con caché de 10 min) que usa el Dashboard: si Meta limita, no se pierde la lista.
        try { for (const a of await cuentasDelToken(tk)) cuentas.set("act_" + a.account_id, { id: "act_" + a.account_id, nombre: a.name || "act_" + a.account_id, moneda: a.currency }); } catch (e) { errores.push(e.message); }
      }
      const cfg = (await cfgRef.get()).data() || {};
      return res.json({ cuentas: [...cuentas.values()].sort((a, b) => String(a.nombre).localeCompare(String(b.nombre))), elegidas: cfg.metaCuentas || [], errores, tokens: tokens.length });
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
    // Registros de Stripe: movimientos del saldo por tandas (el navegador las junta y arma el CSV).
    if (action === "stripe_registros") {
      const cfg = (await cfgRef.get()).data() || {};
      const key = descifrar(cfg.stripeEnc); if (!key) return res.json({ conectado: false, filas: [] });
      const ds = Date.parse(`${req.query.desde}T00:00:00-03:00`), hs = Date.parse(`${req.query.hasta}T23:59:59-03:00`);
      if (!isFinite(ds) || !isFinite(hs) || hs < ds) return res.status(400).json({ error: "Período inválido" });
      const desp = String(req.query.despues || "");
      if (desp && !/^[a-zA-Z0-9_]+$/.test(desp)) return res.status(400).json({ error: "Cursor inválido" });
      const filas = []; let cursor = desp, hayMas = true;
      for (let i = 0; i < 5 && hayMas; i++) {
        const u = `https://api.stripe.com/v1/balance_transactions?limit=100&created[gte]=${Math.floor(ds / 1000)}&created[lte]=${Math.floor(hs / 1000)}&expand[]=data.source${cursor ? `&starting_after=${cursor}` : ""}`;
        const j = await fetch(u, { headers: { Authorization: `Bearer ${key}` } }).then(r => r.json());
        if (j.error) return res.status(400).json({ error: j.error.message });
        for (const t of j.data || []) filas.push({ id: t.id, fecha: new Date(t.created * 1000).toISOString(), tipo: t.type, categoria: t.reporting_category || "", descripcion: t.description || "", monto: t.amount / 100, comision: t.fee / 100, neto: t.net / 100, moneda: String(t.currency).toUpperCase(), estado: t.status, disponible: new Date(t.available_on * 1000).toISOString().slice(0, 10), cobro: t.source?.object === "charge" ? t.source.id : typeof t.source?.charge === "string" ? t.source.charge : "", email: t.source?.billing_details?.email || t.source?.receipt_email || "" });
        hayMas = !!j.has_more && !!j.data?.length;
        if (j.data?.length) cursor = j.data[j.data.length - 1].id;
      }
      return res.json({ conectado: true, filas, siguiente: hayMas ? cursor : null });
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
