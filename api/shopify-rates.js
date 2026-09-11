// api/shopify-rates.js — Callback del CarrierService "Growith · Andreani".
//
// Shopify llama a POST /api/shopify-rates?uid=<uid> en cada checkout con el
// destino y los ítems, y respondemos las tarifas que ve el comprador:
//   • "Andreani a domicilio"            (código ANDREANI_DOM)
//   • "Andreani Sucursal · <sucursal>"   (código ANDREANI_SUC_<id oficial>), una
//     por sucursal que atiende ese CP (hasta `sucursalesMax`).
// El precio es el MISMO que Growith le cobra al vendedor por la etiqueta
// (tarifa Andreani + markup de plataforma) más el recargo/gratis que configure
// la tienda. El id oficial viaja en el código del método → al leer el pedido
// (orders.js) Envíos sabe exactamente a qué sucursal emitir.
//
// Reglas duras: SIEMPRE responder 200 con {rates:[...]} (un error acá rompe el
// checkout del comprador) y en menos de ~10 s (límite de Shopify). Por eso hay
// caché de cotización por CP/peso/valor (6 h) y un tope de tiempo con fallback
// a lo cacheado o a lista vacía (Shopify muestra los otros métodos).
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { andreaniEnv, getGlobalConfig, sucursalesPorCp, sucursalesTodas, cotizarAndreani, precioConMarkup, sucOrigenDe, isPlatformAdmin } from "./andreani.js";

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
  })});
  return getFirestore();
}

const RATES_TTL_MS = 6 * 3600000;   // 6 h
const HARD_TIMEOUT_MS = 8500;       // Shopify corta a los 10 s

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch (_) { return {}; }
}

// CP argentino: "1425", "B1636ABC", "C1425" → 4 dígitos.
function cpDe(dest) {
  const raw = String(dest?.postal_code || dest?.zip || "").toUpperCase();
  const m = /(\d{4})/.exec(raw);
  return m ? m[1] : "";
}
const pesos = n => Math.max(0, Math.ceil(Number(n) / 10) * 10); // redondeo a $10
const cents = n => String(Math.round(Number(n) * 100));
const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
function tituloSucursal(s) {
  const d = s.direccion || {};
  const desc = clip(s.descripcion || s.codigo || `Sucursal ${s.id}`, 48);
  return `Andreani Sucursal · ${desc}`;
}
function descSucursal(s) {
  const d = s.direccion || {};
  const dir = [d.calle, d.numero].filter(Boolean).join(" ");
  const loc = d.localidad || d.ciudad || "";
  const hor = s.horarioDeAtencion ? ` · ${s.horarioDeAtencion}` : "";
  return clip(`Retirás en ${[dir, loc].filter(Boolean).join(", ")}${hor}`, 140);
}

// Sucursales para ofrecer en el checkout: las del CP exacto primero y, si no
// alcanzan, las de CPs vecinos (la numeración postal argentina es geográfica:
// 1425 ↔ 1414/1426/1428 son barrios linderos). Andreani filtra por CP exacto
// y en muchos CP devuelve 1 sola; la app vieja mostraba varias cercanas.
async function sucursalesCercanasCp(db, env, cp, max) {
  const exactas = await sucursalesPorCp(db, env, cp);
  if (exactas.length >= max) return exactas.slice(0, max);
  let todas = [];
  try { todas = await sucursalesTodas(db, env); } catch (_) { return exactas; }
  const n = Number(cp);
  const ids = new Set(exactas.map(s => String(s.id)));
  const cpDe = s => Number(String(s.direccion?.codigoPostal || "").replace(/\D/g, "").slice(0, 4));
  const vecinas = todas
    .filter(s => !ids.has(String(s.id)) && isFinite(cpDe(s)) && Math.abs(cpDe(s) - n) <= 60)
    .sort((a, b) => Math.abs(cpDe(a) - n) - Math.abs(cpDe(b) - n));
  return [...exactas, ...vecinas].slice(0, max);
}

// Motor de tarifas. Devuelve {rates, why} — `why` explica por qué no hubo
// tarifas (lo muestra el autotest de la card de Config; a Shopify solo van rates).
export async function computeRates(db, uid, rate, { shopHdr = "", t0 = Date.now() } = {}) {
  const dest = rate.destination || {};
  const items = Array.isArray(rate.items) ? rate.items : [];
  const currency = rate.currency || "ARS";
  const uSnap = await db.collection("users").doc(uid).get();
  const u = uSnap.exists ? uSnap.data() : null;
  if (!u) return { rates: [], why: "usuario inexistente" };
  const sh = (u.stores || []).find(s => s.type === "shopify" && s.shop);
  if (!sh) return { rates: [], why: "Shopify no conectado en esta tienda" };
  if (shopHdr && shopHdr !== String(sh.shop).toLowerCase()) return { rates: [], why: `la tienda que llama (${shopHdr}) no es la conectada (${sh.shop})` };
  const ac = u.andreaniCheckout || {};
  if (ac.activo === false) return { rates: [], why: "Andreani en el checkout está desactivado" };
  if (String(dest.country || "AR").toUpperCase() !== "AR") return { rates: [], why: "destino fuera de Argentina" };
  const cp = cpDe(dest);
  if (!cp) return { rates: [], why: "el destino no tiene código postal" };
  const env = andreaniEnv();
  if (!env) return { rates: [], why: "faltan credenciales Andreani en el servidor" };
  const [cfg, esAdmin] = await Promise.all([getGlobalConfig(db), isPlatformAdmin(db, uid)]);
  if (!esAdmin && !cfg.habilitados.includes(uid)) return { rates: [], why: "esta tienda no tiene habilitado Envíos Andreani en Growith (lo habilita el admin)" };

  const b = ac.bulto || {};
  const requiresShipping = items.filter(i => i.requires_shipping !== false);
  const gramos = requiresShipping.reduce((a, i) => a + (Number(i.grams) || 0) * (Number(i.quantity) || 1), 0);
  const kilos = Math.max(0.1, gramos > 0 ? gramos / 1000 : (Number(b.kilos) || 1));
  const subtotal = requiresShipping.reduce((a, i) => a + (Number(i.price) || 0) * (Number(i.quantity) || 1), 0) / 100;
  let valorDeclarado = Math.round(subtotal);
  if (Number(b.valorDeclaradoMax) > 0) valorDeclarado = Math.min(valorDeclarado, Number(b.valorDeclaradoMax));
  const bultos = [{ kilos, largoCm: Number(b.largoCm) || 20, altoCm: Number(b.altoCm) || 10, anchoCm: Number(b.anchoCm) || 15, valorDeclarado }];
  const quiereDom = ac.domicilio !== false;
  const quiereSuc = ac.sucursal !== false;
  const gratis = Number(ac.gratisDesde) > 0 && subtotal >= Number(ac.gratisDesde);
  const recargo = p => pesos(p * (1 + (Number(ac.recargoPct) || 0) / 100) + (Number(ac.recargoFijo) || 0));

  const kgB = Math.ceil(kilos * 2) / 2, valB = Math.round(valorDeclarado / 20000) * 20000;
  const cacheRef = db.collection("andreani_config").doc(`rates_${uid}_${cp}_${kgB}_${valB}`);
  let cached = null;
  try { const c = (await cacheRef.get()).data(); if (c && Date.now() - (c.ts || 0) < RATES_TTL_MS) cached = c; } catch (_) {}

  const sucOrigen = sucOrigenDe(u, cfg);
  const errs = [];
  const cotiza = async tipo => {
    if (cached && typeof cached[tipo] === "number") return cached[tipo];
    const cot = await cotizarAndreani(db, env, { tipo, cpDestino: cp, bultos, sucursalOrigen: sucOrigen });
    return precioConMarkup(cot, cfg);
  };
  const work = (async () => {
    const [dom, suc, sucursales] = await Promise.all([
      quiereDom ? cotiza("domicilio").catch(e => { errs.push("domicilio: " + e.message); return null; }) : Promise.resolve(null),
      quiereSuc ? cotiza("sucursal").catch(e => { errs.push("sucursal: " + e.message); return null; }) : Promise.resolve(null),
      quiereSuc ? sucursalesCercanasCp(db, env, cp, Math.max(1, Math.min(12, Number(ac.sucursalesMax) || 5))).catch(e => { errs.push("sucursales: " + e.message); return []; }) : Promise.resolve([]),
    ]);
    if ((dom != null || suc != null) && !(cached && cached.dom === dom && cached.suc === suc)) {
      cacheRef.set({ ratesUid: uid, cp, ts: Date.now(), dom: dom ?? null, suc: suc ?? null }).catch(() => {});
    }
    const rates = [];
    if (dom != null) {
      rates.push({ service_name: "Andreani a domicilio", service_code: "ANDREANI_DOM", total_price: cents(gratis ? 0 : recargo(dom)), currency, description: "Te lo lleva Andreani a la dirección que cargaste" });
    }
    if (suc != null && sucursales.length) {
      const max = Math.max(1, Math.min(12, Number(ac.sucursalesMax) || 5));
      const locDest = String(dest.city || "").toLowerCase();
      const orden = [...sucursales].sort((a, b2) => {
        const sa = (String(a.direccion?.codigoPostal || "") === cp ? 2 : 0) + (locDest && String(a.direccion?.localidad || "").toLowerCase().includes(locDest) ? 1 : 0);
        const sb = (String(b2.direccion?.codigoPostal || "") === cp ? 2 : 0) + (locDest && String(b2.direccion?.localidad || "").toLowerCase().includes(locDest) ? 1 : 0);
        return sb - sa;
      }).slice(0, max);
      for (const s of orden) {
        rates.push({ service_name: tituloSucursal(s), service_code: `ANDREANI_SUC_${s.id}`, total_price: cents(gratis ? 0 : recargo(suc)), currency, description: descSucursal(s) });
      }
    } else if (suc != null && quiereSuc) errs.push(`sin sucursales Andreani para el CP ${cp}`);
    return rates;
  })();
  const timeout = new Promise(r => setTimeout(() => r(null), Math.max(1000, HARD_TIMEOUT_MS - (Date.now() - t0))));
  const rates = await Promise.race([work, timeout]);
  if (rates) return { rates, why: rates.length ? "" : (errs.join(" · ") || "Andreani no devolvió tarifas"), errs };
  console.error(`[shopify-rates] timeout uid=${uid} cp=${cp}`);
  if (cached && typeof cached.dom === "number" && quiereDom) {
    return { rates: [{ service_name: "Andreani a domicilio", service_code: "ANDREANI_DOM", total_price: cents(gratis ? 0 : recargo(cached.dom)), currency, description: "Te lo lleva Andreani a la dirección que cargaste" }], why: "timeout (se usó la caché)" };
  }
  return { rates: [], why: "Andreani tardó más de 10 s" };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).json({ rates: [] });
  const uid = String(req.query.uid || "").trim();
  const t0 = Date.now();
  const respond = rates => res.status(200).json({ rates });
  if (!uid) return respond([]);
  let db;
  try { db = initAdmin(); } catch (e) { console.error("[shopify-rates] init:", e.message); return respond([]); }
  try {
    const body = await readJson(req);
    const shopHdr = String(req.headers["x-shopify-shop-domain"] || "").toLowerCase();
    const out = await computeRates(db, uid, body.rate || {}, { shopHdr, t0 });
    if (out.why) console.error(`[shopify-rates] uid=${uid}: ${out.why}`);
    return respond(out.rates);
  } catch (e) {
    console.error("[shopify-rates]", e.message);
    return respond([]);
  }
}
