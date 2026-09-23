// api/deposito.js — Depósito / fulfillment de Growith (21/sep/2026).
//
// El depósito es de la cuenta FUNDADORA (DEPOSITO_OWNER). Operarios = miembros
// del equipo de esa cuenta con la sección "deposito" tildada (cada uno entra
// con su propio usuario). Los admins de la plataforma NO entran por ser admins.
//
// Unidad de trabajo: la TANDA = lote de etiquetas que un cliente manda para
// armar (o un ENVÍO ESPECIAL suelto con instrucciones). Llega por tres vías:
//   • cliente Growith, etiquetas por API  (origen "api")    → botón en Envíos
//   • cliente Growith, flujo Excel + PDF de rótulos con SKU (origen "excel")
//   • cliente sin Growith: portal público por token #/deposito/<token> ("portal")
//   • el propio depósito en nombre de un cliente ("deposito")
// El pago NO frena el armado: la tanda entra a la cola igual y el pago queda
// "sin_informar" / "a_verificar" hasta que el dueño lo verifica.
//
// Colecciones (server-only; las reglas de Firestore niegan todo lo no listado):
//   deposito_clientes/{id}  {nombre, precio, growithUid|null, token, activo, contacto, nota}
//   deposito_tandas/{id}    ver `nuevaTanda`
//   deposito_files/{tandaId}__{kind}__{i}  {tandaId, kind, i, data(base64), purgeAt}
//   deposito_pagos/{id}     pago de CUENTA CORRIENTE por transferencia (23/sep/2026): {clienteId, monto,
//                           comp, estado borrador|a_verificar|verificado|rechazado, aplicado:[tandaId]}.
//                           Al verificarlo se aplica FIFO a las tandas sin verificar; el sobrante queda
//                           en deposito_clientes.aFavor. Comprobante en deposito_files/{pagoId}__pcomp__{i}.
//   deposito_ingresos/{id}  mercadería RECIBIDA de un cliente {clienteId, fecha, bultos, items:[{sku,cant}], nota}
//   system/deposito         {adminToken, pcToken, datosPago (CBU/alias que ve el cliente), corteHora (default 15)}
// Los PDF viajan y se guardan en TROZOS de ≤ 700.000 caracteres base64 (límite
// de 1 MiB por doc y 4,5 MB por request) y se purgan a los 30 días.
//
// Sin índices compuestos: toda consulta filtra por UN campo y ordena en memoria.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { randomBytes } from "crypto";
import { requireUid, verifyAuth, guardCron } from "./_auth.js";

export const DEPOSITO_OWNER = "WJH3ArqDPQcNLha9lOinvkVi9uJ2";
const CHUNK_MAX = 700000;          // caracteres base64 por trozo
const MAX_CHUNKS_PDF = 45;         // ≈ 23 MB de PDF
const MAX_CHUNKS_OTRO = 6;         // comprobantes y adjuntos ≈ 3 MB
const MAX_PEDIDOS = 800;
const RETENCION_DIAS = 30;
const ESTADOS = ["pendiente", "impresa", "armada", "entregada"];
const CANALES = ["andreani", "ml", "retiro", "otro"];
const SITE = "https://www.growithapp.com";

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
  })});
  return getFirestore();
}

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const txt = (v, max) => String(v ?? "").replace(/[\x00-\x1f]+/g, " ").trim().slice(0, max);
const hoyAR = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
const esFecha = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
const ms = v => v?.toMillis?.() ?? (v?._seconds ? v._seconds * 1000 : (typeof v === "number" ? v : null));

async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  const lista = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!key || !lista.length) return { error: "missing" };
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.RESEND_FROM || "Growith <onboarding@resend.dev>", to: lista, subject, html }),
      signal: AbortSignal.timeout(10000),
    });
    return r.ok ? { ok: true } : { error: `HTTP ${r.status}` };
  } catch (e) { return { error: e.message }; }
}

// Límite simple por IP para el portal público (por instancia; suficiente para frenar abuso casual).
const _rl = new Map();
function rateOk(req, max = 120) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim() || "x";
  const now = Date.now(); const h = _rl.get(ip);
  if (!h || now - h.t > 60000) { if (_rl.size > 2000) _rl.clear(); _rl.set(ip, { t: now, n: 1 }); return true; }
  h.n++; return h.n <= max;
}

// ── Quién llama ──────────────────────────────────────────────────────────────
// Depósito: dueño (uid del token = DEPOSITO_OWNER, o perfil dueño de esa
// tienda) u operario (miembro con secciones.deposito). viaAdmin NO alcanza.
// PANEL POR TOKEN (23/sep/2026): system/deposito {adminToken, pcToken} —
// #/deposito/panel/<adminToken> = consola completa sin sesión (la dueña, desde
// cualquier lado, separada de la cuenta de Soluna); <pcToken> = la PC del
// depósito: cola, historial y buscador SIN precios ni pagos. El nombre de quien
// está en la PC viaja en body.operario y queda en el historial de cada tanda.
// Se resuelve con el token + el doc del dueño (caché 60 s) en vez de requireUid:
// `me` lo llama cada sesión de cada cliente y requireUid loguea un intento de
// acceso ajeno por cada uno.
let _ownCache = { at: 0, members: {} };
let _tokCache = { at: 0, d: null };
async function tokensDeposito(db) {
  if (!_tokCache.d || Date.now() - _tokCache.at > 30000) _tokCache = { at: Date.now(), d: (await db.collection("system").doc("deposito").get()).data() || {} };
  return _tokCache.d;
}
async function ctxDeposito(req, body = {}) {
  const dtoken = body.dtoken ? String(body.dtoken) : "";
  if (dtoken) {
    if (!/^[a-f0-9]{40,64}$/i.test(dtoken) || !rateOk(req, 300)) return null;
    const tk = await tokensDeposito(getFirestore());
    const op = txt(body.operario, 60);
    if (tk.adminToken && dtoken === tk.adminToken) return { user: { uid: "panel:admin" }, rol: "owner", nombre: op || "Dueña (panel)", via: "panel" };
    if (tk.pcToken && dtoken === tk.pcToken) return { user: { uid: `pc:${op || "deposito"}` }, rol: "operador", nombre: op || "PC del depósito", via: "pc" };
    return null;
  }
  const user = await verifyAuth(req);
  if (!user || user.impersonatedBy) return null;
  if (user.uid === DEPOSITO_OWNER) return { user, rol: "owner", nombre: user.name || user.email || "Dueño" };
  if (Date.now() - _ownCache.at > 60000) {
    const d = (await getFirestore().collection("users").doc(DEPOSITO_OWNER).get()).data() || {};
    _ownCache = { at: Date.now(), members: (d.teamMembers && typeof d.teamMembers === "object") ? d.teamMembers : {} };
  }
  const m = _ownCache.members[user.uid];
  if (m?.secciones?.deposito === true) return { user, rol: "operador", nombre: m.nombre || user.email || "Operario" };
  return null;
}
// Cliente: por token del portal (sin sesión) o por sesión de Growith sobre la
// tienda `uid` (sección Envíos) vinculada a un cliente activo del depósito.
async function ctxCliente(req, db, { token, uid }) {
  if (token) {
    if (!/^[a-f0-9]{32,64}$/i.test(token)) return null;
    const s = await db.collection("deposito_clientes").where("token", "==", token).limit(1).get();
    if (s.empty || s.docs[0].data().activo === false) return null;
    return { cliente: { id: s.docs[0].id, ...s.docs[0].data() }, via: "portal", por: "cliente", porNombre: s.docs[0].data().nombre };
  }
  if (!uid) return null;
  const r = await requireUid(req, uid, "envios");
  if (!r.ok || r.viaAdmin || r.user?.impersonatedBy) return null;
  const s = await db.collection("deposito_clientes").where("growithUid", "==", String(uid)).limit(1).get();
  if (s.empty || s.docs[0].data().activo === false) return null;
  return { cliente: { id: s.docs[0].id, ...s.docs[0].data() }, via: "growith", por: r.user.uid, porNombre: r.user.name || r.user.email || s.docs[0].data().nombre };
}

// ── Formas públicas ──────────────────────────────────────────────────────────
function tandaPublica(id, t, { paraCliente = false } = {}) {
  return {
    id, clienteId: t.clienteId, clienteNombre: t.clienteNombre, tipo: t.tipo, origen: t.origen, canal: t.canal,
    fechaDespacho: t.fechaDespacho, n: t.n, precioUnit: t.precioUnit, ajuste: t.ajuste || 0, ajusteMotivo: t.ajusteMotivo || "", total: t.total,
    estado: t.estado, nota: t.nota || "", notaDeposito: t.notaDeposito || "",
    pago: { estado: t.pago?.estado || "sin_informar", comp: t.pago?.comp ? { nombre: t.pago.comp.nombre, mime: t.pago.comp.mime, chunks: t.pago.comp.chunks } : null, informadoAt: ms(t.pago?.informadoAt), verificadoAt: ms(t.pago?.verificadoAt), nota: t.pago?.nota || "" },
    pdf: t.pdf ? { chunks: t.pdf.chunks, pages: t.pdf.pages || 0, purgado: !!t.pdf.purgado } : null,
    especial: t.especial ? { titulo: t.especial.titulo, instrucciones: t.especial.instrucciones, urgente: !!t.especial.urgente, bultos: t.especial.bultos || 1, adj: (t.especial.adj || []).map(a => ({ kind: a.kind, nombre: a.nombre, mime: a.mime, chunks: a.chunks })) } : null,
    pedidos: (t.pedidos || []).map(p => ({ numero: p.numero, comprador: p.comprador, items: p.items || [], pags: p.pags || [], tracking: p.tracking || "", armado: p.armado ? { porNombre: p.armado.porNombre, at: p.armado.at } : null, apartado: p.apartado ? { nota: p.apartado.nota, porNombre: p.apartado.porNombre, at: p.apartado.at } : null })),
    hist: paraCliente ? (t.hist || []).map(h => ({ at: h.at, a: h.a })) : (t.hist || []),
    createdAt: ms(t.createdAt),
  };
}
// interno=true (dueño/operario): trae vínculo, nota interna y token. Al cliente solo nombre, precio y contacto.
const clientePublico = (id, c, interno) => ({ id, nombre: c.nombre, precio: num(c.precio), activo: c.activo !== false, contacto: c.contacto || "", aFavor: num(c.aFavor),
  ...(interno ? { growithUid: c.growithUid || null, growithEmail: c.growithEmail || "", nota: c.nota || "", token: c.token } : {}) });

const totalDe = t => Math.max(0, +(num(t.n) * num(t.precioUnit) + num(t.ajuste)).toFixed(2));

function sanitPedidos(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, MAX_PEDIDOS).map(p => ({
    numero: txt(p?.numero, 40), comprador: txt(p?.comprador, 80),
    items: (Array.isArray(p?.items) ? p.items : []).slice(0, 25).map(i => txt(i, 90)).filter(Boolean),
    pags: (Array.isArray(p?.pags) ? p.pags : []).slice(0, 12).map(n => Math.max(1, Math.round(num(n)))).filter(Boolean),
    tracking: txt(p?.tracking, 40),
    apartado: null, armado: null,
  }));
}
const pagoPublico = (id, p) => ({ id, clienteId: p.clienteId, clienteNombre: p.clienteNombre, monto: num(p.monto), estado: p.estado, nota: p.nota || "", notaCliente: p.notaCliente || "",
  comp: p.comp ? { nombre: p.comp.nombre, mime: p.comp.mime, chunks: p.comp.chunks } : null, informadoAt: ms(p.informadoAt), verificadoAt: ms(p.verificadoAt), aplicado: p.aplicado || [], porNombre: p.porNombre || "" });
const ingresoPublico = (id, g) => ({ id, clienteId: g.clienteId, clienteNombre: g.clienteNombre, fecha: g.fecha, bultos: g.bultos || 0, items: g.items || [], nota: g.nota || "", porNombre: g.porNombre || "", createdAt: ms(g.createdAt) });
const sanitItems = arr => (Array.isArray(arr) ? arr : []).slice(0, 60).map(i => ({ sku: txt(i?.sku, 60), cant: Math.max(0, Math.round(num(i?.cant))) })).filter(i => i.sku && i.cant > 0);

async function borrarArchivos(db, tandaId) {
  const s = await db.collection("deposito_files").where("tandaId", "==", tandaId).get();
  for (let i = 0; i < s.docs.length; i += 400) { const b = db.batch(); s.docs.slice(i, i + 400).forEach(d => b.delete(d.ref)); await b.commit(); }
  return s.size;
}

async function operadoresEmails(db) {
  const d = (await db.collection("users").doc(DEPOSITO_OWNER).get()).data() || {};
  const ops = Object.values(d.teamMembers || {}).filter(m => m?.secciones?.deposito === true && m.email).map(m => m.email);
  return { owner: d.email || "", ops };
}

export default async function handler(req, res) {
  const db = initAdmin();
  const body = (req.body && typeof req.body === "object") ? req.body : {};
  const action = String(req.query.action || body.action || "");

  try {
    // ── Cron diario (8:00 AR): resumen de lo que hay para armar + purga ──
    if (action === "cron_diario") {
      if (!guardCron(req, res)) return;
      const hoy = hoyAR();
      const s = await db.collection("deposito_tandas").where("estado", "in", ["pendiente", "impresa"]).get();
      const vivas = s.docs.map(d => d.data()).filter(t => !t.fechaDespacho || t.fechaDespacho <= hoy);
      let mail = "sin_pendientes";
      if (vivas.length) {
        const porCliente = {};
        for (const t of vivas) { const k = t.clienteNombre || "?"; porCliente[k] = porCliente[k] || { n: 0, tandas: 0, esp: 0 }; porCliente[k].n += num(t.n); porCliente[k].tandas++; if (t.tipo === "especial") porCliente[k].esp++; }
        const total = vivas.reduce((a, t) => a + num(t.n), 0);
        const filas = Object.entries(porCliente).sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0">${esc(k)}</td><td style="padding:6px 12px;text-align:right"><strong>${v.n}</strong> pedidos</td><td style="padding:6px 0;color:#666">${v.tandas} tanda${v.tandas !== 1 ? "s" : ""}${v.esp ? ` · ${v.esp} especial${v.esp !== 1 ? "es" : ""}` : ""}</td></tr>`).join("");
        const { owner, ops } = await operadoresEmails(db);
        const r = await sendEmail({ to: [owner, ...ops].filter(Boolean), subject: `Depósito hoy: ${total} pedidos de ${Object.keys(porCliente).length} cliente${Object.keys(porCliente).length !== 1 ? "s" : ""}`,
          html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6;color:#111"><p>Para armar hoy (${hoy.split("-").reverse().join("/")}):</p><table style="border-collapse:collapse;font-size:15px">${filas}</table><p><a href="${SITE}/#/deposito">Abrir la cola del depósito</a></p></div>` });
        mail = r.ok ? "enviado" : (r.error || "error");
      }
      // Purga: archivos vencidos y borradores que nunca se cerraron.
      const t0 = Date.now(); const tocadas = new Set(); let archivosPurgados = 0;
      while (Date.now() - t0 < 40000) {
        const venc = await db.collection("deposito_files").where("purgeAt", "<", Date.now()).limit(450).get();
        if (venc.empty) break;
        const b = db.batch(); venc.docs.forEach(d => { b.delete(d.ref); if (d.data().kind === "pdf") tocadas.add(d.data().tandaId); }); await b.commit();
        archivosPurgados += venc.size; if (venc.size < 450) break;
      }
      for (const id of [...tocadas].slice(0, 200)) await db.collection("deposito_tandas").doc(id).set({ pdf: { purgado: true } }, { merge: true }).catch(() => {});
      const borr = await db.collection("deposito_tandas").where("estado", "==", "borrador").get();
      let borrados = 0;
      for (const d of borr.docs) if ((ms(d.data().createdAt) || 0) < Date.now() - 86400000) { await borrarArchivos(db, d.id); await d.ref.delete(); borrados++; }
      return res.json({ ok: true, pendientes: vivas.length, mail, archivosPurgados, borradores: borrados });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "POST" });

    // ── me: qué es esta sesión para el depósito ──
    if (action === "me") {
      const dep = await ctxDeposito(req, body);
      const cli = body.uid ? await ctxCliente(req, db, { uid: String(body.uid) }) : null;
      return res.json({ rol: dep ? dep.rol : null, cliente: cli ? clientePublico(cli.cliente.id, cli.cliente, false) : null, error: false });
    }

    // ══ Acciones del CLIENTE (portal por token o sesión Growith) y del depósito
    //    en nombre de un cliente (clienteId) ══
    const ACC_CLIENTE = ["c_info", "c_tandas", "c_tanda_crear", "c_file_put", "c_tanda_cerrar", "c_pago_informar", "c_tanda_cancelar", "c_file_get", "c_pago_crear", "c_pago_cerrar", "c_ingresos"];
    if (ACC_CLIENTE.includes(action)) {
      const token = body.token ? String(body.token) : "";
      if (token && !rateOk(req)) return res.status(429).json({ error: "Demasiadas solicitudes. Esperá un minuto." });
      let cx = await ctxCliente(req, db, { token, uid: body.uid ? String(body.uid) : "" });
      if (!cx && body.clienteId) {
        const dep = await ctxDeposito(req, body);
        // Un operario solo puede CARGAR en nombre del cliente; informar pagos o cancelar es del dueño.
        if (dep && dep.rol !== "owner" && !["c_tanda_crear", "c_file_put", "c_tanda_cerrar", "c_info", "c_ingresos"].includes(action)) return res.status(403).json({ error: "Solo el dueño del depósito puede hacer esto." });
        if (dep) { const c = await db.collection("deposito_clientes").doc(String(body.clienteId)).get(); if (c.exists) cx = { cliente: { id: c.id, ...c.data() }, via: "deposito", rol: dep.rol, por: dep.user.uid, porNombre: dep.nombre }; }
      }
      if (!cx) return res.status(403).json({ error: token ? "Link inválido o cliente inactivo." : "Esta cuenta no está dada de alta como cliente del depósito." });
      const cli = cx.cliente;
      const tRef = id => db.collection("deposito_tandas").doc(String(id || ""));
      const miTanda = async id => { if (!/^[A-Za-z0-9]{10,40}$/.test(String(id || ""))) return null; const s = await tRef(id).get(); return s.exists && s.data().clienteId === cli.id ? s : null; };

      const cfgPub = async () => { const c = await tokensDeposito(db); return { corteHora: Math.min(23, Math.max(0, Math.round(num(c.corteHora)) || 15)), datosPago: c.datosPago || "" }; };
      if (action === "c_info") return res.json({ cliente: clientePublico(cli.id, cli, false), ...(await cfgPub()) });

      if (action === "c_tandas") {
        const [s, ps, gs, cfg] = await Promise.all([
          db.collection("deposito_tandas").where("clienteId", "==", cli.id).get(),
          db.collection("deposito_pagos").where("clienteId", "==", cli.id).get(),
          db.collection("deposito_ingresos").where("clienteId", "==", cli.id).get(),
          cfgPub(),
        ]);
        const todas = s.docs.map(d => ({ id: d.id, t: d.data() })).filter(x => x.t.estado !== "borrador");
        todas.sort((a, b) => (ms(b.t.createdAt) || 0) - (ms(a.t.createdAt) || 0));
        const deudaBruta = todas.filter(x => x.t.estado !== "cancelada" && x.t.pago?.estado !== "verificado").reduce((a, x) => a + num(x.t.total), 0);
        const pagos = ps.docs.map(d => pagoPublico(d.id, d.data())).filter(p => p.estado !== "borrador").sort((a, b) => (b.informadoAt || 0) - (a.informadoAt || 0)).slice(0, 60);
        const enVerificacion = pagos.filter(p => p.estado === "a_verificar").reduce((a, p) => a + p.monto, 0);
        const ingresos = gs.docs.map(d => ingresoPublico(d.id, d.data())).sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "") || (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 40);
        return res.json({ cliente: clientePublico(cli.id, cli, false), tandas: todas.slice(0, 120).map(x => tandaPublica(x.id, x.t, { paraCliente: true })), saldoPendiente: +deudaBruta.toFixed(2),
          cuenta: { deuda: +Math.max(0, deudaBruta - num(cli.aFavor)).toFixed(2), aFavor: num(cli.aFavor), enVerificacion: +enVerificacion.toFixed(2), pagos }, ingresos, ...cfg });
      }

      if (action === "c_ingresos") {
        const gs = await db.collection("deposito_ingresos").where("clienteId", "==", cli.id).get();
        return res.json({ ingresos: gs.docs.map(d => ingresoPublico(d.id, d.data())).sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "")).slice(0, 200) });
      }

      // Pago de cuenta corriente por transferencia: se crea, se sube el comprobante
      // (c_file_put kind "pcomp") y se cierra con el monto. Lo verifica el dueño.
      if (action === "c_pago_crear") {
        if (cx.via === "deposito" && cx.rol !== "owner") return res.status(403).json({ error: "Solo el dueño del depósito puede hacer esto." });
        const ref = await db.collection("deposito_pagos").add({ clienteId: cli.id, clienteNombre: cli.nombre, monto: 0, estado: "borrador", comp: null, nota: "", por: cx.por, porNombre: txt(cx.porNombre, 80), createdAt: FieldValue.serverTimestamp() });
        return res.json({ id: ref.id });
      }
      if (action === "c_pago_cerrar") {
        const id = String(body.id || ""); if (!/^[A-Za-z0-9]{10,40}$/.test(id)) return res.status(400).json({ error: "Pago inválido." });
        const pRef = db.collection("deposito_pagos").doc(id); const ps = await pRef.get();
        if (!ps.exists || ps.data().clienteId !== cli.id) return res.status(404).json({ error: "Pago inexistente." });
        if (ps.data().estado !== "borrador") return res.json({ ok: true, ya: true });
        const monto = +num(body.monto).toFixed(2); if (!(monto > 0)) return res.status(400).json({ error: "Poné el monto transferido." });
        const chunks = Math.round(num(body.chunks)); if (chunks < 1 || chunks > MAX_CHUNKS_OTRO) return res.status(400).json({ error: "Falta el comprobante de la transferencia." });
        const ult = await db.collection("deposito_files").doc(`${id}__pcomp__${chunks - 1}`).get();
        if (!ult.exists) return res.status(400).json({ error: "La subida quedó incompleta. Probá de nuevo." });
        await pRef.set({ monto, estado: "a_verificar", comp: { chunks, nombre: txt(body.nombre, 120), mime: txt(body.mime, 60) }, notaCliente: txt(body.nota, 300), informadoAt: FieldValue.serverTimestamp() }, { merge: true });
        return res.json({ ok: true });
      }

      if (action === "c_tanda_crear") {
        const tipo = body.tipo === "especial" ? "especial" : "tanda";
        const pedidos = sanitPedidos(body.pedidos);
        const pages = Math.max(0, Math.min(5000, Math.round(num(body.pages))));
        let n = pedidos.length || Math.max(0, Math.min(MAX_PEDIDOS, Math.round(num(body.n))));
        if (tipo === "especial" && !n) n = 1;
        if (!n) return res.status(400).json({ error: "La tanda no tiene pedidos." });
        const fecha = esFecha(body.fechaDespacho) ? body.fechaDespacho : hoyAR();
        const t = {
          clienteId: cli.id, clienteNombre: cli.nombre, growithUid: cli.growithUid || null,
          tipo, origen: cx.via === "deposito" ? "deposito" : (["api", "excel"].includes(body.origen) && cx.via === "growith" ? body.origen : cx.via === "portal" ? "portal" : "manual"),
          canal: CANALES.includes(body.canal) ? body.canal : "andreani",
          fechaDespacho: fecha, n, precioUnit: num(cli.precio), ajuste: 0, total: 0,
          estado: "borrador", nota: txt(body.nota, 600), pedidos,
          pdf: null, pago: { estado: "sin_informar" },
          especial: tipo === "especial" ? { titulo: txt(body.especial?.titulo, 120) || "Envío especial", instrucciones: txt(body.especial?.instrucciones, 2000), urgente: body.especial?.urgente === true, bultos: Math.max(1, Math.min(99, Math.round(num(body.especial?.bultos)) || 1)), adj: [] } : null,
          hist: [], createdAt: FieldValue.serverTimestamp(), createdBy: cx.por, createdByNombre: txt(cx.porNombre, 80), pagesDeclaradas: pages,
        };
        t.total = totalDe(t);
        const ref = await db.collection("deposito_tandas").add(t);
        return res.json({ id: ref.id, chunkMax: CHUNK_MAX, precioUnit: t.precioUnit, total: t.total });
      }

      if (action === "c_file_put" && String(body.kind || "") === "pcomp") {
        const id = String(body.id || ""); if (!/^[A-Za-z0-9]{10,40}$/.test(id)) return res.status(400).json({ error: "Pago inválido." });
        const ps = await db.collection("deposito_pagos").doc(id).get();
        if (!ps.exists || ps.data().clienteId !== cli.id) return res.status(404).json({ error: "Pago inexistente." });
        if (ps.data().estado !== "borrador") return res.status(409).json({ error: "El pago ya fue informado." });
        const i = Math.round(num(body.i)); const data = String(body.data || "");
        if (i < 0 || i >= MAX_CHUNKS_OTRO) return res.status(413).json({ error: "El comprobante es demasiado grande." });
        if (!data || data.length > CHUNK_MAX || !/^[A-Za-z0-9+/=]+$/.test(data)) return res.status(400).json({ error: "Trozo inválido." });
        await db.collection("deposito_files").doc(`${id}__pcomp__${i}`).set({ tandaId: id, kind: "pcomp", i, data, purgeAt: Date.now() + 180 * 86400000 });
        return res.json({ ok: true });
      }
      if (action === "c_file_put") {
        const s = await miTanda(body.id); if (!s) return res.status(404).json({ error: "Tanda inexistente." });
        const t = s.data();
        const kind = String(body.kind || "");
        const esPdf = kind === "pdf", esComp = kind === "comp", esAdj = /^adj[0-4]$/.test(kind);
        if (!esPdf && !esComp && !esAdj) return res.status(400).json({ error: "Tipo de archivo inválido." });
        // El PDF de etiquetas y los adjuntos solo se suben mientras es borrador; el comprobante, siempre (salvo pago ya verificado o tanda cancelada).
        if (!esComp && t.estado !== "borrador") return res.status(409).json({ error: "La tanda ya fue enviada." });
        if (esComp && (t.pago?.estado === "verificado" || t.estado === "cancelada")) return res.status(409).json({ error: t.estado === "cancelada" ? "La tanda está cancelada." : "El pago de esta tanda ya está verificado." });
        const i = Math.round(num(body.i)); const data = String(body.data || "");
        if (i < 0 || i >= (esPdf ? MAX_CHUNKS_PDF : MAX_CHUNKS_OTRO)) return res.status(413).json({ error: "El archivo es demasiado grande." });
        if (!data || data.length > CHUNK_MAX || !/^[A-Za-z0-9+/=]+$/.test(data)) return res.status(400).json({ error: "Trozo inválido." });
        await db.collection("deposito_files").doc(`${s.id}__${kind}__${i}`).set({ tandaId: s.id, kind, i, data, purgeAt: Date.now() + RETENCION_DIAS * 86400000 });
        return res.json({ ok: true });
      }

      if (action === "c_tanda_cerrar") {
        const s = await miTanda(body.id); if (!s) return res.status(404).json({ error: "Tanda inexistente." });
        const t = s.data();
        if (t.estado !== "borrador") return res.json({ ok: true, ya: true });
        const archivos = Array.isArray(body.archivos) ? body.archivos.slice(0, 7) : [];
        const upd = { estado: "pendiente", hist: [{ at: Date.now(), por: cx.por, porNombre: txt(cx.porNombre, 80), de: "borrador", a: "pendiente" }] };
        const adj = [];
        for (const a of archivos) {
          const kind = String(a?.kind || ""); const chunks = Math.round(num(a?.chunks));
          if (!chunks || chunks < 1) continue;
          const okKind = kind === "pdf" || kind === "comp" || /^adj[0-4]$/.test(kind); if (!okKind) continue;
          const ult = await db.collection("deposito_files").doc(`${s.id}__${kind}__${chunks - 1}`).get();
          if (!ult.exists) return res.status(400).json({ error: "La subida quedó incompleta. Probá de nuevo." });
          const meta = { chunks, nombre: txt(a.nombre, 120), mime: txt(a.mime, 60) };
          if (kind === "pdf") upd.pdf = { chunks, pages: Math.max(0, Math.round(num(a.pages))) };
          else if (kind === "comp") upd.pago = { estado: "a_verificar", comp: meta, informadoAt: FieldValue.serverTimestamp() };
          else adj.push({ kind, ...meta });
        }
        if (t.tipo === "tanda" && !upd.pdf) return res.status(400).json({ error: "Falta el PDF de etiquetas." });
        if (t.especial) upd.especial = { ...t.especial, adj };
        await s.ref.set(upd, { merge: true });
        // Envío especial URGENTE: aviso inmediato al depósito (lo demás va en el resumen de las 8).
        if (t.especial?.urgente) {
          const { owner, ops } = await operadoresEmails(db);
          await sendEmail({ to: [owner, ...ops].filter(Boolean), subject: `URGENTE en el depósito: ${t.clienteNombre} — ${t.especial.titulo}`,
            html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6;color:#111"><p><strong>${esc(t.clienteNombre)}</strong> cargó un envío especial urgente: <strong>${esc(t.especial.titulo)}</strong>.</p><p style="white-space:pre-wrap">${esc(t.especial.instrucciones)}</p><p><a href="${SITE}/#/deposito">Abrir la cola</a></p></div>` });
        }
        return res.json({ ok: true, total: t.total });
      }

      if (action === "c_pago_informar") {
        const s = await miTanda(body.id); if (!s) return res.status(404).json({ error: "Tanda inexistente." });
        if (s.data().pago?.estado === "verificado") return res.status(409).json({ error: "El pago de esta tanda ya está verificado." });
        const chunks = Math.round(num(body.chunks)); if (chunks < 1 || chunks > MAX_CHUNKS_OTRO) return res.status(400).json({ error: "Comprobante inválido." });
        const ult = await db.collection("deposito_files").doc(`${s.id}__comp__${chunks - 1}`).get();
        if (!ult.exists) return res.status(400).json({ error: "La subida quedó incompleta. Probá de nuevo." });
        await s.ref.set({ pago: { estado: "a_verificar", comp: { chunks, nombre: txt(body.nombre, 120), mime: txt(body.mime, 60) }, informadoAt: FieldValue.serverTimestamp(), nota: "" } }, { merge: true });
        return res.json({ ok: true });
      }

      if (action === "c_tanda_cancelar") {
        const s = await miTanda(body.id); if (!s) return res.status(404).json({ error: "Tanda inexistente." });
        const out = await db.runTransaction(async tx => {
          const cur = (await tx.get(s.ref)).data() || {};
          if (!["borrador", "pendiente"].includes(cur.estado)) return { error: "El depósito ya empezó a trabajar esta tanda. Avisales por WhatsApp." };
          tx.set(s.ref, { estado: "cancelada", hist: [...(cur.hist || []).slice(-40), { at: Date.now(), por: cx.por, porNombre: txt(cx.porNombre, 80), de: cur.estado, a: "cancelada" }] }, { merge: true });
          return { ok: true };
        });
        if (out.error) return res.status(409).json(out);
        return res.json(out);
      }

      if (action === "c_file_get") {
        const s = await miTanda(body.id); if (!s) return res.status(404).json({ error: "Tanda inexistente." });
        const f = await db.collection("deposito_files").doc(`${s.id}__${String(body.kind || "")}__${Math.round(num(body.i))}`).get();
        if (!f.exists) return res.status(404).json({ error: "El archivo ya no está disponible (se guardan 30 días)." });
        return res.json({ data: f.data().data });
      }
    }

    // ══ Acciones del DEPÓSITO (dueño y operarios) ══
    const dep = await ctxDeposito(req, body);
    if (!dep) return res.status(403).json({ error: "No tenés acceso al depósito." });
    // Un operario (miembro o PC del depósito) no ve la parte financiera: ni precios, ni totales, ni pagos.
    const paraDep = (id, t) => { const p = tandaPublica(id, t); if (dep.rol !== "owner") { p.precioUnit = null; p.ajuste = null; p.ajusteMotivo = ""; p.total = null; p.pago = null; } return p; };
    const soloOwner = () => { if (dep.rol !== "owner") { res.status(403).json({ error: "Solo el dueño del depósito puede hacer esto." }); return false; } return true; };

    if (action === "cola") {
      // Todo lo no terminado + lo entregado/cancelado de los últimos 4 días.
      const [vivas, rec] = await Promise.all([
        db.collection("deposito_tandas").where("estado", "in", ["pendiente", "impresa", "armada"]).get(),
        db.collection("deposito_tandas").where("entregadaAt", ">=", Date.now() - 4 * 86400000).get(),
      ]);
      const m = new Map();
      for (const d of [...vivas.docs, ...rec.docs]) if (d.data().estado !== "borrador") m.set(d.id, d.data());
      const tandas = [...m.entries()].map(([id, t]) => paraDep(id, t)).sort((a, b) => (a.fechaDespacho || "").localeCompare(b.fechaDespacho || "") || (a.createdAt || 0) - (b.createdAt || 0));
      const cs = await db.collection("deposito_clientes").get();
      return res.json({ rol: dep.rol, via: dep.via || "sesion", nombre: dep.nombre, hoy: hoyAR(), tandas, clientes: cs.docs.map(d => clientePublico(d.id, d.data(), false)).filter(c => c.activo).map(c => dep.rol === "owner" ? c : { ...c, precio: null }) });
    }

    // Lector de códigos: la etiqueta escaneada (número de envío de Andreani, id
    // de envío de ML o número de pedido) marca el pedido como armado.
    if (action === "pedido_escanear") {
      const cod = txt(body.codigo, 60).replace(/\s+/g, ""); if (cod.length < 3) return res.status(400).json({ error: "Código vacío." });
      const s = await db.collection("deposito_tandas").where("estado", "in", ["pendiente", "impresa", "armada"]).get();
      const cl = cod.toLowerCase(); const solo = cl.replace(/\D/g, "");
      let hit = null;
      for (const d of s.docs) { const t = d.data();
        const idx = (t.pedidos || []).findIndex(p => { const n = String(p.numero || "").toLowerCase(), tr = String(p.tracking || "").toLowerCase();
          return (n && (n === cl || n === solo || (solo.length >= 6 && n.replace(/\D/g, "") === solo))) || (tr && (tr === cl || tr === solo || (tr.length >= 8 && cl.includes(tr)))); });
        if (idx >= 0) { hit = { ref: d.ref, idx }; break; } }
      if (!hit) return res.status(404).json({ error: `No encontré ningún pedido en la cola con el código ${cod}.` });
      const out = await db.runTransaction(async tx => {
        const cur = (await tx.get(hit.ref)).data(); const pedidos = [...(cur.pedidos || [])]; const p = pedidos[hit.idx]; if (!p) return null;
        const ya = !!p.armado;
        if (!ya) { pedidos[hit.idx] = { ...p, armado: { at: Date.now(), por: dep.user.uid, porNombre: txt(dep.nombre, 80) } }; tx.set(hit.ref, { pedidos }, { merge: true }); }
        const armados = pedidos.filter(x => x.armado).length;
        return { tandaId: hit.ref.id, clienteNombre: cur.clienteNombre, estado: cur.estado, numero: p.numero, comprador: p.comprador, items: p.items || [], apartado: p.apartado ? p.apartado.nota : null, ya, yaPor: p.armado?.porNombre || "", armados, total: pedidos.length, completa: armados === pedidos.length };
      });
      if (!out) return res.status(404).json({ error: "Pedido inexistente." });
      return res.json(out);
    }

    // Mercadería recibida de un cliente (sin stock: es el registro de lo que entró).
    if (action === "ingreso_crear") {
      const c = await db.collection("deposito_clientes").doc(String(body.clienteId || "")).get(); if (!c.exists) return res.status(404).json({ error: "Cliente inexistente." });
      const items = sanitItems(body.items); const bultos = Math.max(0, Math.min(999, Math.round(num(body.bultos))));
      if (!items.length && !bultos) return res.status(400).json({ error: "Cargá al menos los bultos o un producto con cantidad." });
      const g = { clienteId: c.id, clienteNombre: c.data().nombre, fecha: esFecha(body.fecha) ? body.fecha : hoyAR(), bultos, items, nota: txt(body.nota, 400), por: dep.user.uid, porNombre: txt(dep.nombre, 80), createdAt: FieldValue.serverTimestamp() };
      const ref = await db.collection("deposito_ingresos").add(g);
      return res.json({ ok: true, id: ref.id });
    }
    if (action === "ingresos") {
      const desde = new Date(Date.now() - 90 * 86400000);
      const gs = await db.collection("deposito_ingresos").where("createdAt", ">=", desde).get();
      const lista = gs.docs.map(d => ingresoPublico(d.id, d.data())).filter(g => !body.clienteId || g.clienteId === body.clienteId).sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "") || (b.createdAt || 0) - (a.createdAt || 0));
      return res.json({ ingresos: lista.slice(0, 300) });
    }
    if (action === "ingreso_eliminar") {
      if (!soloOwner()) return;
      await db.collection("deposito_ingresos").doc(String(body.id || "")).delete().catch(() => {});
      return res.json({ ok: true });
    }

    if (action === "tanda_estado") {
      const estado = String(body.estado || "");
      if (!ESTADOS.includes(estado)) return res.status(400).json({ error: "Estado inválido." });
      const ref = db.collection("deposito_tandas").doc(String(body.id || ""));
      const out = await db.runTransaction(async tx => {
        const s = await tx.get(ref); if (!s.exists) return null;
        const t = s.data(); if (["borrador", "cancelada"].includes(t.estado)) return { error: "La tanda está cancelada." };
        if (t.estado === estado) return { ok: true };
        tx.set(ref, { estado, ...(estado === "entregada" ? { entregadaAt: Date.now() } : {}), hist: [...(t.hist || []).slice(-40), { at: Date.now(), por: dep.user.uid, porNombre: txt(dep.nombre, 80), de: t.estado, a: estado }] }, { merge: true });
        return { ok: true };
      });
      if (!out) return res.status(404).json({ error: "Tanda inexistente." });
      if (out.error) return res.status(409).json(out);
      return res.json(out);
    }

    if (action === "pedido_apartar") {
      const ref = db.collection("deposito_tandas").doc(String(body.id || ""));
      const idx = Math.round(num(body.idx)); const nota = txt(body.nota, 400);
      const out = await db.runTransaction(async tx => {
        const s = await tx.get(ref); if (!s.exists) return null;
        const pedidos = [...(s.data().pedidos || [])]; if (!pedidos[idx]) return null;
        pedidos[idx] = { ...pedidos[idx], apartado: nota ? { nota, por: dep.user.uid, porNombre: txt(dep.nombre, 80), at: Date.now() } : null };
        tx.set(ref, { pedidos }, { merge: true }); return { ok: true };
      });
      return out ? res.json(out) : res.status(404).json({ error: "Pedido inexistente." });
    }

    if (action === "tanda_nota") {
      if (!body.id) return res.status(400).json({ error: "Falta la tanda." });
      try { await db.collection("deposito_tandas").doc(String(body.id)).update({ notaDeposito: txt(body.nota, 600) }); } catch (_) { return res.status(404).json({ error: "Tanda inexistente." }); }
      return res.json({ ok: true });
    }

    if (action === "file_get") {
      if (["comp", "pcomp"].includes(String(body.kind || "")) && dep.rol !== "owner") return res.status(403).json({ error: "Los comprobantes los ve solo el dueño del depósito." });
      const f = await db.collection("deposito_files").doc(`${String(body.id || "")}__${String(body.kind || "")}__${Math.round(num(body.i))}`).get();
      if (!f.exists) return res.status(404).json({ error: "El archivo ya no está disponible (se guardan 30 días)." });
      return res.json({ data: f.data().data });
    }

    if (action === "buscar") {
      const q = txt(body.q, 60).toLowerCase(); if (q.length < 2) return res.json({ resultados: [] });
      const s = await db.collection("deposito_tandas").where("createdAt", ">=", new Date(Date.now() - 21 * 86400000)).get();
      const out = [];
      for (const d of s.docs) { const t = d.data(); if (["borrador", "cancelada"].includes(t.estado)) continue;
        (t.pedidos || []).forEach((p, idx) => { if (String(p.numero).toLowerCase().includes(q) || String(p.comprador).toLowerCase().includes(q)) out.push({ tandaId: d.id, idx, clienteNombre: t.clienteNombre, fechaDespacho: t.fechaDespacho, estado: t.estado, numero: p.numero, comprador: p.comprador, items: p.items || [], pags: p.pags || [], pdfOk: !!t.pdf && !t.pdf.purgado, pdfChunks: t.pdf && !t.pdf.purgado ? t.pdf.chunks : 0 }); });
        if (out.length > 40) break; }
      return res.json({ resultados: out.slice(0, 40) });
    }

    if (action === "historial") {
      const mes = /^\d{4}-\d{2}$/.test(String(body.mes || "")) ? body.mes : hoyAR().slice(0, 7);
      const s = await db.collection("deposito_tandas").where("fechaDespacho", ">=", `${mes}-01`).where("fechaDespacho", "<=", `${mes}-31`).get();
      const tandas = s.docs.map(d => ({ id: d.id, t: d.data() })).filter(x => x.t.estado !== "borrador" && String(x.t.fechaDespacho).startsWith(mes) && (!body.clienteId || x.t.clienteId === body.clienteId))
        .sort((a, b) => (b.t.fechaDespacho || "").localeCompare(a.t.fechaDespacho || "") || (ms(b.t.createdAt) || 0) - (ms(a.t.createdAt) || 0));
      return res.json({ mes, tandas: tandas.slice(0, 400).map(x => { const p = paraDep(x.id, x.t); p.pedidos = []; return p; }) });
    }

    // ── Solo el dueño: accesos al panel por token, clientes, precios y plata ──
    if (action === "accesos") {
      if (!soloOwner()) return;
      const tk = await tokensDeposito(db);
      return res.json({ adminToken: tk.adminToken || null, pcToken: tk.pcToken || null, adminAt: tk.adminAt || null, pcAt: tk.pcAt || null, datosPago: tk.datosPago || "", corteHora: Math.min(23, Math.max(0, Math.round(num(tk.corteHora)) || 15)) });
    }
    if (action === "config_guardar") {
      if (!soloOwner()) return;
      const corteHora = Math.min(23, Math.max(0, Math.round(num(body.corteHora)) || 15));
      await db.collection("system").doc("deposito").set({ datosPago: txt(body.datosPago, 600), corteHora }, { merge: true });
      _tokCache = { at: 0, d: null };
      return res.json({ ok: true });
    }
    // Pagos de cuenta corriente (transferencias informadas por el cliente).
    if (action === "pagos_cc") {
      if (!soloOwner()) return;
      const [ps, cs, ts] = await Promise.all([
        db.collection("deposito_pagos").where("createdAt", ">=", new Date(Date.now() - 200 * 86400000)).get(),
        db.collection("deposito_clientes").get(),
        db.collection("deposito_tandas").where("createdAt", ">=", new Date(Date.now() - 400 * 86400000)).get(),
      ]);
      const deuda = {};
      for (const d of ts.docs) { const t = d.data(); if (["borrador", "cancelada"].includes(t.estado) || t.pago?.estado === "verificado") continue; deuda[t.clienteId] = (deuda[t.clienteId] || 0) + num(t.total); }
      const cuentas = cs.docs.map(d => { const c = d.data(); const bruta = deuda[d.id] || 0; return { clienteId: d.id, nombre: c.nombre, activo: c.activo !== false, deuda: +Math.max(0, bruta - num(c.aFavor)).toFixed(2), aFavor: num(c.aFavor) }; }).filter(c => c.activo || c.deuda > 0).sort((a, b) => b.deuda - a.deuda);
      const pagos = ps.docs.map(d => pagoPublico(d.id, d.data())).filter(p => p.estado !== "borrador").sort((a, b) => ({ a_verificar: 0, rechazado: 1, verificado: 2 }[a.estado] - { a_verificar: 0, rechazado: 1, verificado: 2 }[b.estado]) || (b.informadoAt || 0) - (a.informadoAt || 0));
      return res.json({ cuentas, pagos: pagos.slice(0, 200) });
    }
    if (action === "pago_cc_verificar") {
      if (!soloOwner()) return;
      const pRef = db.collection("deposito_pagos").doc(String(body.id || ""));
      const ok = body.ok !== false;
      const out = await db.runTransaction(async tx => {
        const ps = await tx.get(pRef); if (!ps.exists) return null; const p = ps.data();
        if (p.estado === "verificado") return { ok: true, ya: true };
        if (!ok) { tx.set(pRef, { estado: "rechazado", nota: txt(body.nota, 300), verificadoAt: FieldValue.serverTimestamp(), verificadoPor: dep.user.uid }, { merge: true }); return { ok: true }; }
        const cRef = db.collection("deposito_clientes").doc(p.clienteId); const cs = await tx.get(cRef); const cli = cs.data() || {};
        const ts = await tx.get(db.collection("deposito_tandas").where("clienteId", "==", p.clienteId));
        const pend = ts.docs.map(d => ({ ref: d.ref, id: d.id, t: d.data() })).filter(x => !["borrador", "cancelada"].includes(x.t.estado) && x.t.pago?.estado !== "verificado")
          .sort((a, b) => (a.t.fechaDespacho || "").localeCompare(b.t.fechaDespacho || "") || (ms(a.t.createdAt) || 0) - (ms(b.t.createdAt) || 0));
        let resto = num(p.monto) + num(cli.aFavor); const aplicado = [];
        for (const x of pend) { const tot = num(x.t.total); if (tot > resto + 0.005) break; resto -= tot; aplicado.push(x.id);
          tx.set(x.ref, { pago: { ...(x.t.pago || {}), estado: "verificado", verificadoAt: FieldValue.serverTimestamp(), verificadoPor: dep.user.uid, pagoId: pRef.id, nota: "" } }, { merge: true }); }
        tx.set(cRef, { aFavor: +Math.max(0, resto).toFixed(2) }, { merge: true });
        tx.set(pRef, { estado: "verificado", nota: txt(body.nota, 300), aplicado, verificadoAt: FieldValue.serverTimestamp(), verificadoPor: dep.user.uid }, { merge: true });
        return { ok: true, aplicadas: aplicado.length, aFavor: +Math.max(0, resto).toFixed(2) };
      });
      if (!out) return res.status(404).json({ error: "Pago inexistente." });
      return res.json(out);
    }
    if (action === "acceso_nuevo") {
      if (!soloOwner()) return;
      const cual = body.cual === "pc" ? "pc" : "admin";
      const token = randomBytes(24).toString("hex");
      await db.collection("system").doc("deposito").set(cual === "pc" ? { pcToken: token, pcAt: Date.now() } : { adminToken: token, adminAt: Date.now() }, { merge: true });
      _tokCache = { at: 0, d: null };
      return res.json({ ok: true, cual, token });
    }
    // Buscar cuentas de Growith con plan activo para darlas de alta como cliente
    // sin tipear el mail. Barrido en memoria (solo el dueño, uso esporádico).
    if (action === "usuarios_buscar") {
      if (!soloOwner()) return;
      const q = txt(body.q, 60).toLowerCase(); if (q.length < 2) return res.json({ usuarios: [] });
      const s = await db.collection("users").select("email", "nombre", "displayName", "plan", "planExpiry", "isTrial", "stripeStatus", "deleted", "soloMiembro", "esTienda", "active_tienda_uid", "storeName", "tiendaNombre").get();
      const now = Date.now(); const out = [];
      for (const d of s.docs) { const u = d.data();
        if (u.deleted || u.soloMiembro) continue;
        const plan = u.plan || "free"; if (plan === "free") continue;
        const exp = ms(u.planExpiry); const vigente = !exp || exp > now || ["active", "trialing"].includes(u.stripeStatus);
        if (!vigente) continue;
        const email = String(u.email || "").toLowerCase(), nombre = String(u.nombre || u.displayName || u.storeName || u.tiendaNombre || "");
        if (!email.includes(q) && !nombre.toLowerCase().includes(q)) continue;
        out.push({ id: d.id, email, nombre, plan, prueba: !!u.isTrial, tienda: !!u.esTienda });
        if (out.length >= 12) break; }
      return res.json({ usuarios: out });
    }
    if (action === "clientes") {
      if (!soloOwner()) return;
      const [cs, ts] = await Promise.all([db.collection("deposito_clientes").get(), db.collection("deposito_tandas").where("createdAt", ">=", new Date(Date.now() - 400 * 86400000)).get()]);
      const mes = hoyAR().slice(0, 7); const st = {};
      for (const d of ts.docs) { const t = d.data(); if (["borrador", "cancelada"].includes(t.estado)) continue;
        const k = t.clienteId; st[k] = st[k] || { mesPedidos: 0, mesTotal: 0, aVerificar: 0, sinInformar: 0 };
        if (String(t.fechaDespacho).startsWith(mes)) { st[k].mesPedidos += num(t.n); st[k].mesTotal += num(t.total); }
        if (t.pago?.estado === "a_verificar") st[k].aVerificar += num(t.total);
        else if (t.pago?.estado !== "verificado") st[k].sinInformar += num(t.total); }
      return res.json({ clientes: cs.docs.map(d => ({ ...clientePublico(d.id, d.data(), true), stats: st[d.id] || { mesPedidos: 0, mesTotal: 0, aVerificar: 0, sinInformar: 0 } })).sort((a, b) => a.nombre.localeCompare(b.nombre)) });
    }

    if (action === "cliente_guardar") {
      if (!soloOwner()) return;
      const nombre = txt(body.nombre, 80); if (!nombre) return res.status(400).json({ error: "Poné el nombre del cliente." });
      const precio = Math.max(0, num(body.precio));
      const data = { nombre, precio, contacto: txt(body.contacto, 160), nota: txt(body.nota, 400), activo: body.activo !== false };
      // Vínculo con una cuenta de Growith: por email de la cuenta (o uid directo).
      // Se acepta el mail de la cuenta o, para perfiles con varias tiendas, el
      // uid de la TIENDA puntual (figura en Admin > ficha del cliente).
      const crudo = txt(body.growithEmail, 120);
      const em = crudo.includes("@") ? crudo.toLowerCase() : crudo;
      const prevCli = body.id ? (await db.collection("deposito_clientes").doc(String(body.id)).get()).data() : null;
      if (body.id && !prevCli) return res.status(404).json({ error: "Cliente inexistente." });
      if (em && prevCli && String(prevCli.growithEmail || "") === em) { /* sin cambio: no se re-resuelve la tienda activa */ }
      else if (em) {
        let doc = null;
        if (em.includes("@")) { const u = await db.collection("users").where("email", "==", em).limit(5).get(); doc = u.docs.find(d => !d.data().deleted) || null; }
        else if (/^[A-Za-z0-9_-]{10,80}$/.test(em)) { const d1 = await db.collection("users").doc(em).get(); if (d1.exists && !d1.data().deleted) doc = d1; }
        if (!doc) return res.status(404).json({ error: `No hay ninguna cuenta de Growith con ${em}.` });
        // Por mail: la tienda ACTIVA del perfil (la que genera etiquetas). Por uid: esa tienda.
        data.growithUid = em.includes("@") ? String(doc.data().active_tienda_uid || doc.id) : doc.id; data.growithEmail = em;
        const dup = await db.collection("deposito_clientes").where("growithUid", "==", data.growithUid).limit(2).get();
        if (dup.docs.some(d => d.id !== String(body.id || ""))) return res.status(409).json({ error: "Esa cuenta de Growith ya está vinculada a otro cliente del depósito." });
      } else if (body.growithEmail === "") { data.growithUid = null; data.growithEmail = ""; }
      if (body.id) { await db.collection("deposito_clientes").doc(String(body.id)).set(data, { merge: true }); return res.json({ ok: true, id: String(body.id) }); }
      const ref = await db.collection("deposito_clientes").add({ ...data, growithUid: data.growithUid || null, growithEmail: data.growithEmail || "", token: randomBytes(20).toString("hex"), createdAt: FieldValue.serverTimestamp() });
      return res.json({ ok: true, id: ref.id });
    }

    if (action === "cliente_token") {
      if (!soloOwner()) return;
      const token = randomBytes(20).toString("hex");
      if (!body.id) return res.status(400).json({ error: "Falta el cliente." });
      try { await db.collection("deposito_clientes").doc(String(body.id)).update({ token }); } catch (_) { return res.status(404).json({ error: "Cliente inexistente." }); }
      return res.json({ ok: true, token });
    }

    if (action === "pago_verificar") {
      if (!soloOwner()) return;
      const estado = body.ok === false ? "rechazado" : "verificado";
      if (!body.id) return res.status(400).json({ error: "Falta la tanda." });
      try { await db.collection("deposito_tandas").doc(String(body.id)).update({ "pago.estado": estado, "pago.verificadoPor": dep.user.uid, "pago.verificadoAt": FieldValue.serverTimestamp(), "pago.nota": txt(body.nota, 300) }); } catch (_) { return res.status(404).json({ error: "Tanda inexistente." }); }
      return res.json({ ok: true, estado });
    }

    if (action === "tanda_ajuste") {
      if (!soloOwner()) return;
      const ref = db.collection("deposito_tandas").doc(String(body.id || ""));
      const s = await ref.get(); if (!s.exists) return res.status(404).json({ error: "Tanda inexistente." });
      const t = { ...s.data(), ajuste: num(body.ajuste), ...(body.n != null ? { n: Math.max(0, Math.min(MAX_PEDIDOS, Math.round(num(body.n)))) } : {}) };
      await ref.set({ ajuste: t.ajuste, ajusteMotivo: txt(body.motivo, 200), n: t.n, total: totalDe(t) }, { merge: true });
      return res.json({ ok: true, total: totalDe(t) });
    }

    if (action === "tanda_eliminar") {
      if (!soloOwner()) return;
      const id = String(body.id || ""); if (!id) return res.status(400).json({ error: "Falta la tanda." });
      await borrarArchivos(db, id); await db.collection("deposito_tandas").doc(id).delete();
      return res.json({ ok: true });
    }

    if (action === "resumen") {
      if (!soloOwner()) return;
      const mes = /^\d{4}-\d{2}$/.test(String(body.mes || "")) ? body.mes : hoyAR().slice(0, 7);
      const s = await db.collection("deposito_tandas").where("fechaDespacho", ">=", `${mes}-01`).where("fechaDespacho", "<=", `${mes}-31`).get();
      const por = {};
      for (const d of s.docs) { const t = d.data(); if (["borrador", "cancelada"].includes(t.estado) || !String(t.fechaDespacho).startsWith(mes)) continue;
        const k = t.clienteId; por[k] = por[k] || { clienteId: k, nombre: t.clienteNombre, tandas: 0, pedidos: 0, total: 0, verificado: 0, aVerificar: 0, sinInformar: 0 };
        por[k].tandas++; por[k].pedidos += num(t.n); por[k].total += num(t.total);
        if (t.pago?.estado === "verificado") por[k].verificado += num(t.total); else if (t.pago?.estado === "a_verificar") por[k].aVerificar += num(t.total); else por[k].sinInformar += num(t.total); }
      return res.json({ mes, clientes: Object.values(por).sort((a, b) => b.total - a.total) });
    }

    return res.status(400).json({ error: "Acción desconocida" });
  } catch (e) {
    console.error("[deposito]", action, e);
    return res.status(500).json({ error: "Error interno del depósito. Probá de nuevo." });
  }
}
