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
import { andreaniEnv, andreaniFetch, slimSucursal, distanciaM, getGlobalConfig, sucursalesPorCp, sucursalesTodas, sucursalesCercanasCore, cotizarAndreani, precioConMarkup, sucOrigenDe, isPlatformAdmin } from "./andreani.js";

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
  const km = s.distM != null ? ` · a ${(s.distM / 1000).toFixed(s.distM < 9500 ? 1 : 0).replace(".", ",")} km` : "";
  return clip(`3 a 5 días hábiles${km} · Retirás en ${[dir, loc].filter(Boolean).join(", ")}${hor}`, 160);
}

// Puntos que NO son de retiro para el público (depósitos, receptorías,
// puntos "in house" de un cliente): nunca al checkout.
const NO_PUBLICO_RX = /in ?house|receptor[ií]a|dep[oó]sito|planta|\bcds?\b|\bhub\b|log[ií]stica|no usar|devoluci|mercado central|procesamiento/i;
const esPuntoPublico = s => !NO_PUBLICO_RX.test(String(s.descripcion || ""));

// Listado B2C completo con lo que el slim de andreani.js descarta y acá es
// clave: `codigosPostalesAtendidos` (qué CPs atiende cada sucursal — es la
// propia definición de Andreani de "sucursal para este CP"), tipo y si hace
// atención al cliente / entrega envíos. Cacheado 7 días.
async function sucursalesB2CCheckout(db, env) {
  const ref = db.collection("andreani_config").doc("suc_b2c_checkout");
  try { const c = (await ref.get()).data(); if (c && Array.isArray(c.lista) && c.lista.length && Date.now() - (c.ts || 0) < SUC_LIST_TTL_MS) return c.lista; } catch (_) {}
  const r = await andreaniFetch(db, env, "/v2/sucursales?canal=B2C");
  if (!r.ok) throw new Error(`sucursales B2C HTTP ${r.status}`);
  const raw = await r.json();
  const arr = Array.isArray(raw) ? raw : (raw?.sucursales || []);
  const lista = arr.map(x => {
    const sl = slimSucursal(x); const da = x.datosAdicionales || {};
    return { id: sl.id, descripcion: sl.descripcion, direccion: sl.direccion, horarioDeAtencion: sl.horarioDeAtencion, lat: sl.lat, lng: sl.lng,
      cps: Array.isArray(x.codigosPostalesAtendidos) ? x.codigosPostalesAtendidos.map(String) : [],
      tipo: String(da.tipo || ""), atencion: da.seHaceAtencionAlCliente !== false, entrega: da.entregaEnvios !== false };
  });
  try { await ref.set({ ts: Date.now(), lista }); } catch (_) { /* >1MB: sin cache */ }
  return lista;
}
const esRetiroPublico = s => s.entrega && s.atencion && !/planta/i.test(s.tipo || "") && esPuntoPublico(s);

// Sucursales por CERCANÍA real (motor de Envíos): ancla = centroide del CP /
// localidad del comprador (coords cacheadas; no se geocodifica la dirección
// para no gastar los 10 s de Shopify) → ranking por distancia. La lista
// ordenada se cachea 7 días por CP+localidad. Si el motor no responde a
// tiempo o viene vacío, cae al método por CP exacto + CPs vecinos.
const SUC_LIST_TTL_MS = 7 * 86400000;
const enARll = (lat, lng) => isFinite(lat) && isFinite(lng) && lat <= -21 && lat >= -56 && lng <= -53 && lng >= -74;
const sleep = ms => new Promise(r => setTimeout(() => r(null), ms));
const nrmK = v => String(v || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

// Centroide de la localidad (georef): fallback cuando la dirección no geocodifica.
async function geocodeLocalidad({ loc, prov, cp }) {
  if (!loc) return null;
  const esCaba = /c\.?\s*a\.?\s*b\.?\s*a|capital federal|ciudad aut|buenos aires/i.test(loc) && /^1[0-4]\d\d$/.test(String(cp || ""));
  if (esCaba) return null; // en CABA sirve más el CP (sucursales del CP)
  const u = new URL("https://apis.datos.gob.ar/georef/api/localidades");
  u.searchParams.set("nombre", loc); if (prov) u.searchParams.set("provincia", prov);
  u.searchParams.set("max", "1"); u.searchParams.set("campos", "centroide");
  const r = await fetch(u, { signal: AbortSignal.timeout(2500) });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const c = j?.localidades?.[0]?.centroide;
  return (c && isFinite(c.lat) && isFinite(c.lon)) ? { lat: +c.lat, lng: +c.lon } : null;
}

// Ancla = zona del comprador. NO se usa la dirección escrita (es impredecible
// y el geocoder cae en cualquier lado): centroide oficial de la localidad
// (georef, cache 30 días) → mediana de las sucursales ubicadas en su CP.
async function anclaComprador(db, { cp, loc, prov }, pub) {
  const key = (nrmK(`${loc}|${cp}`) || String(cp)).slice(0, 90);
  const ref = db.collection("andreani_config").doc(`geo_ck2_${key}`);
  try { const c = (await ref.get()).data(); if (c && enARll(c.lat, c.lng) && Date.now() - (c.ts || 0) < 30 * 86400000) return { lat: c.lat, lng: c.lng, src: c.src || "cache" }; } catch (_) {}
  let g = null, src = "";
  try { g = await Promise.race([geocodeLocalidad({ loc, prov, cp }), sleep(2500)]); if (g) src = "loc"; } catch (_) {}
  if (g && enARll(g.lat, g.lng)) { ref.set({ lat: g.lat, lng: g.lng, src, ts: Date.now(), ratesUid: "_geo" }).catch(() => {}); return { ...g, src }; }
  const cpS = String(cp);
  const enCp = pub.filter(s => String(s.direccion?.codigoPostal || "").replace(/\D/g, "").slice(0, 4) === cpS && enARll(s.lat, s.lng));
  if (enCp.length) {
    const med = arr => { const a = [...arr].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
    return { lat: med(enCp.map(s => s.lat)), lng: med(enCp.map(s => s.lng)), src: "cp" };
  }
  return null;
}

// Regla (Thiago, 11/9): SOLO sucursales a ≤ 10 km del comprador, ordenadas por
// distancia; si no hay ninguna a 10 km, únicamente la más cercana. Hasta tener
// los puntos HOP en la API, esto es lo que evita listas "raras".
const RADIO_M = 10000;
let _dbg = {}; // diagnóstico de la última selección (solo se devuelve con ?debug=1)
async function sucursalesParaCheckout(db, env, { cp, loc, prov }, max) {
  _dbg = { cp, loc };
  const cacheRef = db.collection("andreani_config").doc(`rates_suc6_${cp}_${(nrmK(loc) || "x").slice(0, 60)}`);
  try {
    const c = (await cacheRef.get()).data();
    if (c && Array.isArray(c.lista) && c.lista.length && Date.now() - (c.ts || 0) < SUC_LIST_TTL_MS) return c.lista.slice(0, max);
  } catch (_) {}
  let lista = [];
  try {
    const pub = (await sucursalesB2CCheckout(db, env)).filter(esRetiroPublico);
    const ancla = await anclaComprador(db, { cp, loc, prov }, pub);
    if (ancla) {
      const conDist = pub.filter(s => enARll(s.lat, s.lng))
        .map(s => ({ ...s, distM: distanciaM(ancla.lat, ancla.lng, s.lat, s.lng) }))
        .sort((a, b) => a.distM - b.distM);
      // Las ubicadas EN el CP del comprador van arriba de todo; el resto por distancia.
      const cpS = String(cp);
      const enCp = s => String(s.direccion?.codigoPostal || "").replace(/\D/g, "").slice(0, 4) === cpS;
      const cerca = dedupeSucursales(conDist).filter(s => s.distM <= RADIO_M).sort((a, b) => (enCp(b) - enCp(a)) || (a.distM - b.distM));
      lista = cerca.length ? cerca : (conDist.length ? [conDist[0]] : []);
    } else {
      // Sin ancla: las que Andreani define que atienden el CP (mismo CP primero).
      const cpS = String(cp);
      lista = pub.filter(s => s.cps.includes(cpS)).sort((a, b) => (String(b.direccion?.codigoPostal || "") === cpS) - (String(a.direccion?.codigoPostal || "") === cpS));
    }
    _dbg.ancla = ancla ? ancla.src : "ninguna"; _dbg.candidatas = lista.length;
  } catch (e) { _dbg.error = e.message; console.error("[shopify-rates] sucursales:", e.message); }
  if (!lista.length) lista = (await sucursalesCercanasCp(db, env, cp, 3)).slice(0, 1);
  lista = dedupeSucursales(lista.filter(esPuntoPublico)).slice(0, 12)
    .map(s => ({ id: s.id, descripcion: s.descripcion || "", direccion: s.direccion || null, horarioDeAtencion: s.horarioDeAtencion || "", distM: s.distM ?? null }));
  if (lista.length) cacheRef.set({ ratesUid: "_suc", cp, ts: Date.now(), lista }).catch(() => {});
  return lista.slice(0, max);
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
  return dedupeSucursales([...exactas, ...vecinas]).slice(0, max);
}
// Andreani lista el mismo local varias veces (sucursal + punto HOP + locker,
// ids distintos): al comprador se le muestra una sola vez (misma calle+número
// o mismo nombre base).
function dedupeSucursales(lista) {
  const nrm = v => String(v || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const seen = new Set(); const out = [];
  for (const s of lista) {
    const d = s.direccion || {};
    const kDir = nrm(d.calle) && nrm(d.numero) ? `d:${nrm(d.calle)}|${nrm(d.numero)}` : "";
    const kNom = `n:${nrm(String(s.descripcion || "").replace(/\(.*?\)/g, ""))}`;
    if ((kDir && seen.has(kDir)) || seen.has(kNom)) continue;
    if (kDir) seen.add(kDir); seen.add(kNom);
    out.push(s);
  }
  return out;
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
      quiereSuc ? sucursalesParaCheckout(db, env, { cp, loc: dest.city, prov: dest.province }, Math.max(1, Math.min(12, Number(ac.sucursalesMax) || 5))).catch(e => { errs.push("sucursales: " + e.message); return []; }) : Promise.resolve([]),
    ]);
    if ((dom != null || suc != null) && !(cached && cached.dom === dom && cached.suc === suc)) {
      cacheRef.set({ ratesUid: uid, cp, ts: Date.now(), dom: dom ?? null, suc: suc ?? null }).catch(() => {});
    }
    const rates = [];
    if (dom != null) {
      rates.push({ service_name: "Andreani a domicilio", service_code: "ANDREANI_DOM", total_price: cents(gratis ? 0 : recargo(dom)), currency, description: "2 a 5 días hábiles · Andreani te lo lleva a la dirección que cargaste" });
    }
    if (suc != null && sucursales.length) {
      // El orden ya viene por cercanía (CP exacto primero, después vecinos).
      for (const s of sucursales) {
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
    return { rates: [{ service_name: "Andreani a domicilio", service_code: "ANDREANI_DOM", total_price: cents(gratis ? 0 : recargo(cached.dom)), currency, description: "2 a 5 días hábiles · Andreani te lo lleva a la dirección que cargaste" }], why: "timeout (se usó la caché)" };
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
    if (req.query.debug === "1") return res.status(200).json({ rates: out.rates, why: out.why || "", errs: out.errs || [], sucursales: _dbg });
    return respond(out.rates);
  } catch (e) {
    console.error("[shopify-rates]", e.message);
    return respond([]);
  }
}
