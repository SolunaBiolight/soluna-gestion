// api/_hop.js — Puntos HOP de Andreani por API (índice propio).
//
// Hecho comprobado el 16/9/2026: para nuestra cuenta NINGÚN listado trae los
// puntos HOP (/v2/sucursales, ?canal=B2C|HOP, /v2/puntos-de-tercero: 1 solo HOP
// en todo el país), pero /v2/sucursales/{id} SÍ resuelve cualquier punto HOP
// (id = 10000 + número del punto, canal B2C, tipo DEALER, código HOPnnnn, con
// dirección completa, CP, coordenadas y horario). O sea: el acceso está, lo
// que falta es el índice. Se arma acá enumerando ids 10000..20999:
//   • foto inicial en _hop_index.json (2.6k puntos, 16/9/2026), para que
//     funcione desde el primer deploy;
//   • cron `hop_index_cron` (api/andreani.js) que barre los ids por tandas con
//     cursor en andreani_config/hop_idx_meta y, al completar la vuelta,
//     reemplaza los shards andreani_config/hop_idx_{n}.
// sucursalesPorCp / sucursalesTodas (andreani.js) y el checkout de Shopify
// (shopify-rates.js) mezclan este índice con lo que devuelve Andreani, así el
// matcheo de Envíos, la emisión y el checkout ven los HOP como una sucursal más.
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const BASE = require("./_hop_index.json");

export const HOP_ID_MIN = 10000;
export const HOP_ID_MAX = 21000;            // exclusivo (spot-check: 21.5k..40k → 404)
// Firestore no admite arrays anidados: cada registro compacto viaja como texto JSON.
const recA = r => (typeof r === "string" ? r : JSON.stringify(r));
const recDe = r => { if (typeof r !== "string") return r; try { return JSON.parse(r); } catch (_) { return null; } };
const SHARD = 600;                          // registros compactos por doc (≈ 90 KB)
const MEM_TTL_MS = 3600000;                 // caché en memoria por instancia

export const HOP_RX = /\bHOP\b|PUNTO ANDREANI|PICKIT/i;
export function esHopOficial(x) {
  return /^HOP/i.test(String(x?.codigo || "")) || HOP_RX.test(String(x?.descripcion || ""))
    || /dealer/i.test(String(x?.datosAdicionales?.tipo || x?.tipo || ""));
}
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };

// Registro compacto (array) ↔ forma de slimSucursal (+ hop:true).
export function hopCompact(x) {
  const d = x.direccion || {}, g = x.coordenadas || {}, da = x.datosAdicionales || {};
  return [x.id, x.codigo || "", String(x.descripcion || "").replace(/\s+/g, " ").trim(), d.calle || "", d.numero || "", d.localidad || "", d.provincia || "", d.region || "",
    String(d.codigoPostal || "").replace(/\D/g, ""), num(g.latitud), num(g.longitud), x.horarioDeAtencion || "", da.sucursalAbastecedora?.id ?? null, da.admiteEnvios !== false];
}
export function hopExpand(r) {
  return {
    id: r[0], codigo: r[1] || null, numero: r[1] ? (String(r[1]).replace(/\D/g, "") || null) : null,
    descripcion: r[2] || "",
    direccion: { calle: r[3] || "", numero: r[4] || "", provincia: r[6] || "", localidad: r[5] || "", region: r[7] || "", pais: "Argentina", codigoPostal: r[8] || "" },
    horarioDeAtencion: r[11] || "", lat: r[9] ?? null, lng: r[10] ?? null,
    hop: true, abastecedora: r[12] ?? null, admiteEnvios: r[13] !== false,
  };
}

let _mem = { ts: 0, list: null, origen: "" };

// Índice completo (expandido). Firestore si hay una vuelta completa más nueva
// que la foto; si no, la foto. Nunca lanza: ante cualquier error, la foto.
export async function hopIndexTodas(db) {
  if (_mem.list && Date.now() - _mem.ts < MEM_TTL_MS) return _mem.list;
  let recs = BASE.recs, origen = "foto";
  try {
    const meta = (await db.collection("andreani_config").doc("hop_idx_meta").get()).data();
    if (meta && Number(meta.ts) > Number(BASE.ts) && Number(meta.shards) > 0 && Number(meta.n) > 0) {
      const refs = []; for (let i = 0; i < Number(meta.shards); i++) refs.push(db.collection("andreani_config").doc(`hop_idx_${i}`));
      const snaps = await db.getAll(...refs);
      const got = []; for (const s of snaps) for (const r of (s.data()?.recs || [])) { const v = recDe(r); if (v) got.push(v); }
      if (got.length >= Number(meta.n) * 0.9) { recs = got; origen = "firestore"; }
    }
  } catch (e) { console.warn("[hop] índice Firestore:", e.message); }
  const list = recs.map(hopExpand);
  _mem = { ts: Date.now(), list, origen };
  return list;
}
export async function hopIndexPorCp(db, cp) {
  const c = String(cp || "").replace(/\D/g, "");
  if (!c) return [];
  return (await hopIndexTodas(db)).filter(h => h.direccion.codigoPostal === c);
}
export function hopIndexOrigen() { return _mem.origen || "foto"; }
// Fecha (ms) de la foto del repo: si el cron nunca cerró una vuelta, es lo que se sirve.
export function hopIndexFotoTs() { return Number(BASE.ts) || 0; }

// Mezcla: lo oficial primero (así [0] sigue siendo una sucursal real para la
// sugerencia de origen) y los HOP que falten después, sin repetir ids.
export function conHop(lista, hops) {
  const ids = new Set((lista || []).map(s => String(s.id)));
  const out = [...(lista || [])];
  for (const h of hops || []) if (!ids.has(String(h.id))) { ids.add(String(h.id)); out.push(h); }
  return out;
}

// Acumulado de la vuelta en curso: shards hop_idx_build_{n} de SHARD registros
// (un solo doc superaba 1 MB); meta.buildShards dice cuántos hay.
async function buildLeer(db, col, meta) {
  const n = Number(meta.buildShards) || 0;
  if (!n) return [];
  const refs = []; for (let i = 0; i < n; i++) refs.push(col.doc(`hop_idx_build_${i}`));
  const snaps = await db.getAll(...refs);
  const recs = []; for (const s of snaps) for (const r of (s.data()?.recs || [])) { const v = recDe(r); if (v) recs.push(v); }
  return recs;
}
// Escribe los shards nuevos y borra los sobrantes (y el doc viejo hop_idx_build).
function buildEscribir(batch, col, recs, previos) {
  const shards = Math.ceil(recs.length / SHARD);
  for (let i = 0; i < shards; i++) batch.set(col.doc(`hop_idx_build_${i}`), { ts: Date.now(), recs: recs.slice(i * SHARD, (i + 1) * SHARD).map(recA) });
  for (let i = shards; i < previos; i++) batch.delete(col.doc(`hop_idx_build_${i}`));
  batch.delete(col.doc("hop_idx_build"));
  return shards;
}

// Barrido por tandas (cron). `fetchOficial(id)` devuelve la Response de
// GET /v2/sucursales/{id}. Cursor y acumulado en Firestore; al cerrar la vuelta
// se reemplazan los shards. Si una tanda falla mucho (Andreani caído) no se
// avanza el cursor: la próxima corrida la repite.
export async function hopIndexSweep(db, fetchOficial, { porCorrida = 1500, concurrencia = 20, presupuestoMs = 40000 } = {}) {
  const t0 = Date.now();
  const col = db.collection("andreani_config");
  const metaRef = col.doc("hop_idx_meta");
  const meta = (await metaRef.get()).data() || {};
  let cursor = Number(meta.cursor) || HOP_ID_MIN;
  if (cursor < HOP_ID_MIN || cursor >= HOP_ID_MAX) cursor = HOP_ID_MIN;
  const buildPrevios = Number(meta.buildShards) || 0;
  const build = cursor === HOP_ID_MIN ? [] : await buildLeer(db, col, meta);
  const fin = Math.min(HOP_ID_MAX, cursor + porCorrida);
  let ok = 0, hop = 0, fallas = 0, id = cursor;
  const nuevos = [];
  const worker = async () => {
    while (id < fin && Date.now() - t0 < presupuestoMs) {
      const mio = id++;
      try {
        const r = await fetchOficial(mio);
        if (r.status === 200) { const j = await r.json().catch(() => null); ok++; if (j && esHopOficial(j) && String(j.datosAdicionales?.tipo || "").toUpperCase() !== "PLANTA") { nuevos.push(hopCompact(j)); hop++; } }
        else if (r.status !== 404) fallas++;
      } catch (_) { fallas++; }
    }
  };
  await Promise.all(Array.from({ length: concurrencia }, worker));
  const procesados = Math.max(0, Math.min(id, fin) - cursor);
  if (procesados > 0 && fallas > procesados * 0.2) {
    return { ok: false, error: `demasiadas fallas (${fallas}/${procesados}) — no se avanza el cursor`, cursor, ms: Date.now() - t0 };
  }
  // Si el presupuesto de tiempo cortó antes, el cursor avanza solo hasta el
  // primer id no procesado (los workers toman ids en orden, así que `id` es
  // el tope alcanzado; los que quedaron a medias se repiten la próxima).
  const nuevoCursor = Math.min(id, fin);
  const recs = build.concat(nuevos).sort((a, b) => a[0] - b[0]);
  if (nuevoCursor >= HOP_ID_MAX) {
    // Vuelta completa: reemplazar shards (solo si no se desplomó el conteo).
    const previo = Number(meta.n) || BASE.n || 0;
    if (recs.length < previo * 0.6) {
      const bd = db.batch();
      buildEscribir(bd, col, [], buildPrevios); // limpia los shards de la vuelta
      bd.set(metaRef, { cursor: HOP_ID_MIN, buildShards: 0, ultimaVuelta: { at: Date.now(), n: recs.length, descartada: true, motivo: `solo ${recs.length} HOP vs ${previo} previos` } }, { merge: true });
      await bd.commit();
      return { ok: false, error: `vuelta descartada: ${recs.length} HOP vs ${previo} previos`, ms: Date.now() - t0 };
    }
    const shards = Math.ceil(recs.length / SHARD);
    const batch = db.batch();
    for (let i = 0; i < shards; i++) batch.set(col.doc(`hop_idx_${i}`), { ts: Date.now(), recs: recs.slice(i * SHARD, (i + 1) * SHARD).map(recA) });
    for (let i = shards; i < (Number(meta.shards) || 0); i++) batch.delete(col.doc(`hop_idx_${i}`));
    buildEscribir(batch, col, [], buildPrevios); // la vuelta cerró: fuera los shards de build
    batch.set(metaRef, { ts: Date.now(), n: recs.length, shards, cursor: HOP_ID_MIN, buildShards: 0, ultimaVuelta: { at: Date.now(), n: recs.length } }, { merge: true });
    await batch.commit();
    _mem = { ts: 0, list: null, origen: "" };
    return { ok: true, vueltaCompleta: true, hop: recs.length, shards, ms: Date.now() - t0 };
  }
  const bb = db.batch();
  const buildShards = buildEscribir(bb, col, recs, buildPrevios);
  bb.set(metaRef, { cursor: nuevoCursor, buildShards, enCurso: { at: Date.now(), acumulados: recs.length } }, { merge: true });
  await bb.commit();
  return { ok: true, cursor: nuevoCursor, tanda: { desde: cursor, hasta: nuevoCursor, ok, hop, fallas }, acumulados: recs.length, ms: Date.now() - t0 };
}
