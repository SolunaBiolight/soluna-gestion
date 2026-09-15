// api/_demo_ops.js — Tienda DEMO: Facturador (ARCA) y Envíos (Andreani) ficticios.
//
// Lo llama api/demo.js al crear/regenerar la tienda demo. Deja la tienda con:
//   · un CUIT configurado (sin certificado: arca.js simula ARCA para las demo),
//   · los comprobantes emitidos de los últimos 60 días (Registros / Métricas),
//     con una nota de crédito,
//   · envíos despachados y entregados con seguimiento (Envíos → Seguimientos),
//     tres con problema (demorado, en sucursal hace 4 días, visita fallida),
//   · un par de gestiones ante Andreani y movimientos de la billetera.
// Nada de esto sale a ARCA, a Andreani, a la tienda ni a ningún mail:
// arca.js, andreani.js y update-shipping.js cortan antes para las tiendas con
// demo.activo y todos los crons las saltean. La traza de cada envío vive en
// la colección raíz demo_tracks/{numeroDeEnvio} (la lee update-shipping
// action=tracking en vez de consultar a Andreani).
//
// No es un endpoint (el "_" evita que Vercel lo publique).

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { rngDemo } from "./_demo.js";

const DIA = 86400000;
const HORA = 3600000;

// CUIT ficticio con dígito verificador INVÁLIDO a propósito: no es de nadie.
export const DEMO_CUIT = "30712345678";
export const DEMO_PV = 4;
export const DEMO_SALDO = 186400;

// Números de envío demo: 15 dígitos como los de Andreani, con prefijo propio.
const PREFIJO_ENVIO = "3600097";
export const esNumeroEnvioDemo = (n) => /^3600097\d{8}$/.test(String(n || ""));
export function numeroEnvioDemo(r = Math.random) {
  let s = PREFIJO_ENVIO;
  while (s.length < 15) s += Math.floor(r() * 10);
  return s;
}

// CAE ficticio de 14 dígitos (los reales empiezan con 7x).
export function caeDemo(r = Math.random) {
  let s = String(74 + Math.floor(r() * 3));
  while (s.length < 14) s += Math.floor(r() * 10);
  return s;
}
// Vencimiento del CAE: 10 días después del comprobante, en DD/MM/YYYY (como
// lo devuelve parseWsfeResultado).
export function caeVtoDemo(fechaIso) {
  const t = Date.parse(String(fechaIso || "").slice(0, 10) + "T12:00:00Z");
  const d = new Date((isFinite(t) ? t : Date.now()) + 10 * DIA);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}

// Precio de etiqueta ficticio (el que vería el cliente con el markup): base
// por tipo + zona por el primer dígito del CP + kilos extra.
export function precioEtiquetaDemo(tipo, cp, kilos = 1) {
  const d = String(cp || "").replace(/\D/g, "")[0] || "1";
  const zona = { "1": 0, "2": 1100, "3": 1400, "4": 2100, "5": 1500, "6": 700, "7": 800, "8": 2400, "9": 2900 }[d] ?? 1200;
  const base = tipo === "sucursal" ? 6390 : 7890;
  const extra = Math.max(0, Math.ceil((Number(kilos) || 1) - 1)) * 480;
  return Math.round((base + zona + extra) / 10) * 10;
}

// Etapas del tracking público de Andreani (mismo formato "Etapa — detalle"
// que parseTrackingV3 en update-shipping.js).
const ETAPAS_DEMO = {
  pendiente: ["Pendiente de ingreso", "Etiqueta generada. Esperamos que el paquete ingrese a la red de Andreani."],
  ingresado: ["Ingresado", "Recibimos tu envío en la sucursal de origen."],
  camino:    ["En camino", "El envío está viajando hacia la sucursal que hace la entrega."],
  reparto:   ["En camino", "Salió a distribución: hoy lo lleva el repartidor."],
  sucursal:  ["En sucursal", "Tu envío está disponible para retirar en la sucursal."],
  fallida:   ["Visita fallida", "No pudimos entregarlo: no había nadie en el domicilio. Vamos a reintentar."],
  entregado: ["Entregado", "Tu envío fue entregado."],
  anulada:   ["Etiqueta anulada", "La etiqueta se anuló antes de ingresar a Andreani."],
};
// pasos = [[etapa, ms], ...] → {estado, eventos:[{estado, descripcion, fecha}]}
export function trazaDemo(pasos) {
  const eventos = pasos.map(([k, ms]) => ({ estado: ETAPAS_DEMO[k][0], descripcion: ETAPAS_DEMO[k][1], fecha: new Date(ms).toISOString() }));
  const ult = eventos[eventos.length - 1];
  return { estado: ult ? `${ult.estado} — ${ult.descripcion}` : null, eventos };
}
// Traza de un envío demo (la devuelve update-shipping action=tracking).
export async function registrarTrackDemo(db, uid, numeroDeEnvio, envioId, traza) {
  await db.collection("demo_tracks").doc(String(numeroDeEnvio)).set({
    uid, envioId: String(envioId || ""), estado: traza.estado, eventos: traza.eventos, ts: FieldValue.serverTimestamp(),
  });
}

const argYmd = (ms) => new Date(ms - 3 * HORA).toISOString().slice(0, 10);
const ymdDisplay = (ymd) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;
const nombreCli = (c) => `${c?.nombre || ""} ${c?.apellido || ""}`.trim() || "Consumidor Final";
const domicilioCli = (c) => [[c?.direccion, c?.numero].filter(Boolean).join(" "), c?.ciudad, c?.provincia].filter(Boolean).join(", ");

// Escrituras en lotes de hasta 450 operaciones.
async function escribirLote(db, ops) {
  for (let i = 0; i < ops.length; i += 450) {
    const b = db.batch();
    for (const [ref, data, opts] of ops.slice(i, i + 450)) { if (opts) b.set(ref, data, opts); else b.set(ref, data); }
    await b.commit();
  }
}
async function borrarQuery(db, q) {
  for (let vuelta = 0; vuelta < 200; vuelta++) {
    const s = await q.limit(400).get();
    if (s.empty) return;
    const b = db.batch();
    s.docs.forEach(d => b.delete(d.ref));
    await b.commit();
    if (s.size < 400) return;
  }
}

// Subcolecciones del Facturador y de Envíos de la tienda demo.
const SUBCOL_OPS = ["arca_cuits", "arca_comprobantes", "arca_notas_credito", "arca_batches", "arca_emisiones", "arca_facturadas", "arca_iva", "arca_ta", "envios", "andreani_mov"];

/**
 * Borra todo lo que crea seedOpsDemo (y lo que la demo haya generado usando la
 * app: comprobantes simulados, etiquetas simuladas, gestiones).
 * Candado: si el doc de la tienda existe y NO es demo, no borra nada.
 */
export async function limpiarOpsDemo(db, tid) {
  if (!tid) return;
  const ref = db.collection("users").doc(String(tid));
  const snap = await ref.get();
  if (snap.exists && !snap.data()?.demo) throw new Error("limpiarOpsDemo: la tienda no es demo — no se borra nada");
  for (const sub of SUBCOL_OPS) await borrarQuery(db, ref.collection(sub));
  await borrarQuery(db, db.collection("demo_tracks").where("uid", "==", String(tid)));
  await borrarQuery(db, db.collection("envios_casos").where("uid", "==", String(tid)));
  await borrarQuery(db, db.collection("arca_autopilot").where("uid", "==", String(tid)));
}

/**
 * Siembra el Facturador y Envíos de la tienda demo a partir de sus ventas
 * (las de historiaDemo, ya guardadas en demo_orders). Idempotente: arranca
 * limpiando lo anterior. Devuelve el patch para mergear en users/{tid}.
 */
export async function seedOpsDemo(db, tid, ventas) {
  tid = String(tid);
  await limpiarOpsDemo(db, tid);
  const ref = db.collection("users").doc(tid);
  const ahora = Date.now();
  const ahoraIso = new Date(ahora).toISOString();
  const desde = ahora - 60 * DIA;
  const r = rngDemo(4242);
  const lista = (Array.isArray(ventas) ? ventas : []).filter(v => v && v.fecha && isFinite(Date.parse(v.fecha)));
  const ops = [];

  // ── Facturador: comprobantes de los últimos 60 días ─────────────────────
  // Factura B (RI a consumidor final) por cada venta facturada, emitida al
  // día siguiente a las ~18:30 en tandas (Registros las agrupa por lote).
  const compCol = ref.collection("arca_comprobantes");
  const facturadas = lista.filter(v => v.facturada && Date.parse(v.fecha) >= desde).sort((a, b) => Date.parse(a.fecha) - Date.parse(b.fecha));
  let nroB = 1873;
  const porDia = new Map();
  const comps = [];
  for (const v of facturadas) {
    const tV = Date.parse(v.fecha);
    const dia = argYmd(Math.min(tV + DIA, ahora - 2 * HORA));
    const k = porDia.get(dia) || 0; porDia.set(dia, k + 1);
    const emMs = Math.min(Date.parse(`${dia}T21:30:00.000Z`) + k * 6000, ahora - 60000);
    const esMl = v.canal === "ml";
    const c = v.cliente || {};
    const dni = String(c.dni || "").replace(/\D/g, "");
    const total = Math.round((Number(v.total) || 0) * 100) / 100;
    const neto = Math.round((total / 1.21) * 100) / 100;
    const nro = nroB++;
    const docId = `${DEMO_CUIT}_${DEMO_PV}_6_${String(nro).padStart(8, "0")}`;
    const emitidoAt = new Date(emMs).toISOString();
    const data = {
      cuit_emisor: DEMO_CUIT, tipo_cbte: 6, letra: "B", nro, punto_venta: DEMO_PV, exento: false,
      fecha_str: ymdDisplay(dia), fecha_cbte: dia, emitido_at: emitidoAt,
      cae: caeDemo(r), cae_vto: caeVtoDemo(dia),
      cliente: nombreCli(c), doc_tipo: dni.length >= 7 && dni.length <= 8 ? "DNI" : "CF", doc_nro: dni.length >= 7 && dni.length <= 8 ? dni : "",
      total, neto, iva: Math.round((total - neto) * 100) / 100,
      orden_id: (esMl ? "ML-" : "TN-") + String(v.numero || v.id),
      items: (v.items || []).map(i => ({ nombre: i.nombre || "Producto", cantidad: parseInt(i.qty) || 1, precio: Number(i.precio) || 0, descuento_item: 0 })),
      domicilio: domicilioCli(c),
      ml_uploaded: esMl, ml_uploaded_at: esMl ? emitidoAt : null,
      obs_codigo: null, obs_msg: "",
      _demo: true,
    };
    comps.push({ v, docId, data, emMs });
  }
  // Una nota de crédito (venta de la tienda anulada hace 2-3 semanas): la
  // factura queda ANULADA en Registros y la venta vuelve a Facturar.
  const candNc = comps.filter(x => x.v.canal !== "ml" && ahora - x.emMs > 12 * DIA && ahora - x.emMs < 25 * DIA);
  const nc = candNc[Math.floor(candNc.length / 2)] || null;
  if (nc) {
    const ncNro = 41;
    const ncMs = nc.emMs + 2 * DIA;
    nc.data.anulada = true; nc.data.anulada_at = new Date(ncMs).toISOString(); nc.data.nc_nro = ncNro;
    ops.push([ref.collection("arca_notas_credito").doc(`${DEMO_CUIT}_nc_${DEMO_PV}_8_${String(ncNro).padStart(8, "0")}`), {
      cuit: DEMO_CUIT, tipo: 8, letra: "B", punto_venta: DEMO_PV, comprobante: ncNro,
      cae: caeDemo(r), cae_vto: caeVtoDemo(argYmd(ncMs)), total: nc.data.total,
      cliente: nc.data.cliente, doc_tipo: nc.data.doc_tipo, doc_nro: nc.data.doc_nro,
      factura_origen: { tipo: 6, comprobante: nc.data.nro, punto_venta: DEMO_PV },
      fecha: new Date(ncMs).toISOString(), pdf_b64: null, _demo: true,
    }]);
    ops.push([ref.collection("demo_orders").doc(String(nc.v.id)), { facturada: false }, { merge: true }]);
  }
  for (const x of comps) ops.push([compCol.doc(x.docId), x.data]);
  const ultimoB = nroB - 1;
  ops.push([ref.collection("arca_cuits").doc(DEMO_CUIT), {
    cuit: DEMO_CUIT, razon_social: "Growith Demo SRL", nombre_fantasia: "Growith Demo",
    domicilio: "Av. Corrientes 1234, Piso 5 - CABA", fecha_inicio: "01/03/2021",
    condicion_fiscal: "RESPONSABLE_INSCRIPTO", ingresos_brutos: "901-712345-6",
    punto_venta: DEMO_PV, arca_prod: true,
    puntos_venta: [{ numero: DEMO_PV, exento: false, nombre: "Tienda online", concepto: 1 }],
    envio_mail: { enabled: false, reply_to: null },
    migracion_cuit_done: true,
    last_test: { ok: true, ts: ahoraIso, ultimo_b: ultimoB },
    _demo: true,
  }]);

  // ── Envíos: seguimiento de lo despachado en los últimos 60 días ─────────
  const despachadas = lista
    .filter(v => v.canal !== "ml" && ["enviado", "entregado"].includes(v.estadoEnvio) && Date.parse(v.fecha) >= desde)
    .sort((a, b) => Date.parse(a.fecha) - Date.parse(b.fecha));
  const edad = v => (ahora - Date.parse(v.fecha)) / DIA;
  const usadas = new Set();
  const elegir = (pred) => { const v = despachadas.find(x => !usadas.has(x.id) && pred(x)) || despachadas.find(x => !usadas.has(x.id) && edad(x) > 6 && edad(x) < 20); if (v) usadas.add(v.id); return v || null; };
  const vDemora = elegir(v => edad(v) >= 10 && edad(v) <= 16 && v.tipoEnvio !== "sucursal");
  const vSuc = elegir(v => edad(v) >= 7 && edad(v) <= 12 && v.tipoEnvio === "sucursal");
  const vFallida = elegir(v => edad(v) >= 4 && edad(v) <= 9 && v.tipoEnvio !== "sucursal");
  const problemaDe = new Map();
  if (vDemora) problemaDe.set(vDemora.id, "demora");
  if (vSuc) problemaDe.set(vSuc.id, "sucursal");
  if (vFallida) problemaDe.set(vFallida.id, "fallida");

  let seq = 10000000 + Math.floor(r() * 60000000);
  const envCol = ref.collection("envios");
  const envios = [];
  for (const v of despachadas) {
    const c = v.cliente || {};
    const tV = Date.parse(v.fecha);
    const prob = problemaDe.get(v.id) || null;
    const esSucursal = prob === "sucursal" ? true : prob ? false : v.tipoEnvio === "sucursal";
    const tipo = esSucursal ? "sucursal" : "domicilio";
    let tDesp = Math.min(tV + (0.5 + r() * 0.8) * DIA, ahora - 2 * HORA);
    if (prob === "demora") tDesp = Math.min(tDesp, ahora - 9 * DIA);
    if (prob === "sucursal") tDesp = Math.min(tDesp, ahora - 6.5 * DIA);
    if (prob === "fallida") tDesp = Math.min(tDesp, ahora - 3 * DIA);
    seq += 1 + Math.floor(r() * 37);
    const numeroDeEnvio = PREFIJO_ENVIO + String(seq).padStart(8, "0").slice(-8);
    const kilos = 0.3 + (v.items || []).reduce((s, i) => s + (parseInt(i.qty) || 1), 0) * 0.4;
    const precio = precioEtiquetaDemo(tipo, c.cp, kilos);
    const viaApi = prob ? true : r() < 0.75;
    const t0 = tDesp - 30 * 60000; // etiqueta emitida media hora antes del despacho
    let pasos, categoria, activo = true, extra = {}, problema = null;
    if (prob === "demora") {
      pasos = [["pendiente", t0], ["ingresado", tDesp + 4 * HORA], ["camino", tDesp + 20 * HORA]];
      categoria = "en_camino";
      const d = Math.floor((ahora - (tDesp + 20 * HORA)) / DIA);
      problema = { tipo: "quieto", sev: "amber", msg: `sin movimiento hace ${d} días` };
    } else if (prob === "sucursal") {
      const tSuc = ahora - 4 * DIA - 3 * HORA;
      pasos = [["pendiente", t0], ["ingresado", tDesp + 4 * HORA], ["camino", tDesp + 20 * HORA], ["sucursal", tSuc]];
      categoria = "en_sucursal"; extra.enSucursalDesde = new Date(tSuc).toISOString();
      problema = { tipo: "sucursal", sev: "amber", msg: "en sucursal hace 4 días sin retirar" };
    } else if (prob === "fallida") {
      const tF = ahora - 20 * HORA;
      pasos = [["pendiente", t0], ["ingresado", tDesp + 4 * HORA], ["camino", tDesp + 20 * HORA], ["reparto", tF - 5 * HORA], ["fallida", tF]];
      categoria = "visita_fallida";
      problema = { tipo: "visita_fallida", sev: "amber", msg: "visita fallida — Andreani reintenta o lo lleva a sucursal" };
    } else {
      const tEnt = tDesp + (1.5 + r() * 2.5) * DIA;
      if (v.estadoEnvio === "entregado" && tEnt < ahora - 2 * HORA) {
        pasos = [["pendiente", t0], ["ingresado", tDesp + 4 * HORA], ["camino", tDesp + 20 * HORA], ...(esSucursal ? [["sucursal", tEnt - 18 * HORA]] : [["reparto", tEnt - 6 * HORA]]), ["entregado", tEnt]];
        categoria = "entregado"; activo = false; extra.entregadoAt = new Date(tEnt).toISOString();
      } else {
        pasos = [["pendiente", t0], ["ingresado", tDesp + 4 * HORA]];
        if (ahora - tDesp > 20 * HORA) pasos.push(["camino", tDesp + 20 * HORA]);
        categoria = "en_camino";
      }
    }
    pasos = pasos.filter(([, ms]) => ms < ahora - 60000);
    const traza = trazaDemo(pasos);
    const ultMs = pasos.length ? pasos[pasos.length - 1][1] : tDesp;
    const despIso = new Date(tDesp).toISOString();
    const doc = {
      numero: String(v.numero), tnId: String(v.id), cliente: nombreCli(c), esSucursal,
      provincia: c.provincia || "", localidad: c.localidad || c.ciudad || "", total: Number(v.total) || 0,
      productos: (v.items || []).slice(0, 40).map(i => ({ sku: String(i.sku || ""), nombre: String(i.nombre || ""), cantidad: parseInt(i.qty) || 1 })),
      estado: "despachado", activo, tracking: numeroDeEnvio,
      fulfillOk: true, verificado: true, tnDone: true, verificadoAt: despIso,
      destinatario: { nombre: nombreCli(c), email: String(c.email || ""), telefono: String(c.telefono || "") },
      creado: despIso, despachadoAt: despIso,
      estadoAndreani: traza.estado, categoria, estadoDesde: new Date(ultMs).toISOString(),
      lastCheck: new Date(ahora - Math.floor(r() * 25) * 60000).toISOString(), trackVia: viaApi ? "oficial" : "scraping",
      ...extra,
      ...(viaApi ? { andreani: {
        numeroDeEnvio, estado: "Pendiente", precio, tipo,
        fechaEstimadaDeEntrega: new Date(tDesp + 3 * DIA).toISOString().slice(0, 10),
        ts: Timestamp.fromMillis(t0), anulada: false, demo: true,
      } } : {}),
      ...(problema ? { problema } : {}),
      demo: true,
    };
    envios.push({ v, doc, numeroDeEnvio, precio, tipo, t0, viaApi, prob });
    ops.push([envCol.doc(String(v.numero)), doc]);
    ops.push([db.collection("demo_tracks").doc(numeroDeEnvio), { uid: tid, envioId: String(v.numero), estado: traza.estado, eventos: traza.eventos, ts: FieldValue.serverTimestamp() }]);
    // Los pedidos con problema siguen "enviado" (no entregado) también en la venta.
    if (prob && v.estadoEnvio !== "enviado") ops.push([ref.collection("demo_orders").doc(String(v.id)), { estadoEnvio: "enviado" }, { merge: true }]);
  }

  // ── Billetera: una carga por transferencia y las últimas etiquetas ──────
  const movCol = ref.collection("andreani_mov");
  const ultimasApi = envios.filter(x => x.viaApi).slice(-14);
  if (ultimasApi.length) {
    const debitos = ultimasApi.reduce((s, x) => s + x.precio, 0);
    const carga = Math.max(50000, Math.floor((DEMO_SALDO + debitos) / 50000) * 50000);
    let saldo = DEMO_SALDO + debitos; // saldo apenas acreditada la carga (antes: saldo − carga ≥ 0)
    ops.push([movCol.doc(), { tipo: "credito", monto: carga, saldoDespues: saldo, nota: "Carga de saldo por transferencia (GW-DEMO7K)", ts: Timestamp.fromMillis(ultimasApi[0].t0 - 2 * DIA), demo: true }]);
    for (const x of ultimasApi) {
      saldo -= x.precio;
      ops.push([movCol.doc(), {
        tipo: "debito", monto: x.precio, saldoDespues: saldo,
        nota: `Etiqueta Andreani ${x.tipo === "sucursal" ? "a sucursal" : "a domicilio"} · CP ${x.v.cliente?.cp || ""}`.trim(),
        envioId: String(x.v.numero), numeroDeEnvio: x.numeroDeEnvio, ts: Timestamp.fromMillis(x.t0), demo: true,
      }]);
    }
  }

  // ── Gestiones ante Andreani (no llegan a la ejecutiva: demo:true) ───────
  const casoDe = (x, motivo, estado, historial, extra = {}) => ({
    uid: tid, email: "", tienda: "Growith Demo",
    numero: String(x.v.numero), numeroDeEnvio: x.numeroDeEnvio, tracking: x.numeroDeEnvio,
    cliente: x.doc.cliente, localidad: [x.doc.localidad, x.doc.provincia].filter(Boolean).join(", "), esSucursal: !!x.doc.esSucursal,
    motivo, descripcion: historial[0].texto, nuevaDireccion: "", fotos: [], estado, origen: "cliente",
    precio: x.precio, reintegrado: false, nuevoCliente: false, nuevoAndreani: false,
    historial, ts: Timestamp.fromMillis(Date.parse(historial[0].at)), updatedAt: Timestamp.fromMillis(Date.parse(historial[historial.length - 1].at)),
    demo: true, ...extra,
  });
  const xDemora = envios.find(x => x.prob === "demora");
  const xFallida = envios.find(x => x.prob === "fallida");
  if (xDemora) {
    const t1 = ahora - 2 * DIA, t2 = t1 + 3 * HORA;
    ops.push([db.collection("envios_casos").doc(), casoDe(xDemora, "demora", "enviado", [
      { at: new Date(t1).toISOString(), por: "cliente", texto: "El pedido figura en camino hace más de una semana sin movimiento. ¿Pueden revisar dónde está?" },
      { at: new Date(t2).toISOString(), por: "admin", estado: "enviado", texto: "Enviado a Andreani" },
    ])]);
  }
  if (xFallida) {
    const t1 = ahora - 16 * HORA, t2 = ahora - 5 * HORA;
    ops.push([db.collection("envios_casos").doc(), casoDe(xFallida, "cambio", "respondido", [
      { at: new Date(t1).toISOString(), por: "cliente", texto: "La compradora avisa que mañana está en casa de 9 a 18 h. ¿Pueden reprogramar la visita?" },
      { at: new Date(t2).toISOString(), por: "andreani", estado: "respondido", texto: "Reprogramamos la visita para mañana en la franja de 9 a 18 h." },
    ], { nuevaDireccion: "Mañana de 9 a 18 h", nuevoAndreani: true })]);
  }

  await escribirLote(db, ops);

  return {
    cuits: [{ cuit: DEMO_CUIT, razon_social: "Growith Demo SRL", punto_venta: DEMO_PV, condicion_fiscal: "RESPONSABLE_INSCRIPTO" }],
    andreaniSaldo: DEMO_SALDO,
    andreaniOrigen: { codigoPostal: "1414", calle: "Av. Córdoba", numero: "4550", localidad: "Palermo", region: "Capital Federal" },
    andreaniRemitente: { nombreCompleto: "Growith Demo SRL", documentoNumero: DEMO_CUIT, email: "envios@ejemplo.com", telefono: "1140000000" },
    andreaniSucOrigen: { id: "demo_suc_palermo", codigo: "PAL", descripcion: "Palermo", direccion: { calle: "Av. Córdoba", numero: "4550", localidad: "Capital Federal", codigoPostal: "1414", region: "Capital Federal" }, confirmada: true, ts: ahora },
    enviosProblemasN: problemaDe.size,
    enviosProblemasAt: ahoraIso,
    enviosCfg: { avisosDueno: false, avisosComprador: false, sucursalDias: 3, quietoDias: 7 },
  };
}
