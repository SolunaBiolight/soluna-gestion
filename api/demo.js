// api/demo.js — Tienda DEMO de Growith: datos ficticios para mostrar la app por dentro.
//
//   POST {action, ...}   — solo la cuenta de prueba (contacto.growith@gmail.com) o
//                          admins de la plataforma. La identidad sale del TOKEN.
//   status                          → {tiendaUid, nombre, activa, productos, ventas}
//   seed {dias}                     → crea (o regenera) la tienda "Growith Demo" con
//                                     todo cargado: catálogo, ~4 meses de ventas por
//                                     tienda y Mercado Libre, reclamos, canjes,
//                                     influencers, tareas, calendario de pagos,
//                                     publicidad, facturas y envíos; y entra a ella.
//   add_order {tiendaUid, canal, prodId, varId, qty, precio, medio, pct, fecha, estadoEnvio}
//   add_product {tiendaUid, nombre, sku, precio, costo, canal, variantes:[{nombre,stock}]}
//   list {tiendaUid}                → productos + últimas ventas
//   delete_order {tiendaUid, id} · delete_product {tiendaUid, id}
//   reset {tiendaUid}               → vacía los datos ficticios (la tienda queda)
//
// Todo vía Admin SDK. La tienda queda con users/{tid}.demo.activo = true: los
// endpoints la atienden con los datos de api/_demo.js y NUNCA llaman a Tienda Nube,
// Mercado Libre, Meta, Google, ARCA ni Andreani, ni mandan mails.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { verifyAuth, requireAdmin, clearTeamCache } from "./_auth.js";
import { DEMO_EMAIL, MEDIOS_DEMO, productosDemo, historiaDemo, ventaDemo, rngDemo } from "./_demo.js";

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
  })});
  return getFirestore();
}

const DIA = 86400000;
const ymd = (ms) => new Date(ms - 3 * 3600000).toISOString().slice(0, 10); // fecha argentina
const ts = (ms) => Timestamp.fromMillis(ms);

async function borrar(q) {
  for (;;) {
    const snap = await q.limit(400).get();
    if (snap.empty) return;
    const b = q.firestore.batch();
    snap.docs.forEach(d => b.delete(d.ref));
    await b.commit();
    if (snap.size < 400) return;
  }
}
async function escribir(db, refsYDatos) {
  for (let i = 0; i < refsYDatos.length; i += 400) {
    const b = db.batch();
    for (const [ref, data] of refsYDatos.slice(i, i + 400)) b.set(ref, data);
    await b.commit();
  }
}

// Costo por variante (clave = SKU, igual que Márgenes) y por publicación de ML.
function cogsDe(productos) {
  const m = {};
  for (const p of productos) {
    for (const v of p.variantes || []) m[v.sku] = Number(p.costo) || 0;
    if (p.mlId) m["ml:" + p.mlId] = Number(p.costo) || 0;
  }
  return m;
}

// ── Datos de operación (reclamos, canjes, tareas, pagos) ─────────────────────
function reclamosDemo(tid, ventas, ahora) {
  const r = rngDemo(4411);
  const vt = ventas.filter(v => v.canal !== "ml").slice(0, 60);
  const casos = [
    ["Cambio", "Talle incorrecto", "Nuevo", 0.3],
    ["Cambio", "Talle incorrecto", "Esperando producto", 3],
    ["Devolución", "No es lo que esperaba", "Contactado", 1.5],
    ["Reclamo", "Llegó dañado", "Producto recibido", 5],
    ["Cambio", "Color distinto al de la foto", "Envío en camino", 7],
    ["Reclamo", "Demora en la entrega", "Resuelto", 12],
    ["Devolución", "Producto con falla", "Resuelto", 18],
    ["Cambio", "Talle incorrecto", "Resuelto", 25],
    ["Reclamo", "Pidió factura A", "Rechazado", 30],
  ];
  return casos.map(([tipo, motivo, estado, diasAtras], i) => {
    const v = vt[(i * 5) % vt.length] || vt[0];
    const c = v.cliente || {};
    const creado = ahora - diasAtras * DIA;
    const prod = v.items?.[0]?.nombre || "Producto";
    const hist = [{ accion: "Reclamo creado", fecha: new Date(creado).toISOString() }];
    if (estado !== "Nuevo") hist.push({ accion: `Estado → ${estado}`, fecha: new Date(creado + DIA * 0.6).toISOString() });
    return {
      ownerId: tid, orderNum: v.numero, tipo, motivo, estado,
      descripcion: `${motivo}. El cliente escribió por WhatsApp con la foto del pedido #${v.numero}.`,
      resolucion: estado === "Resuelto" ? (tipo === "Devolución" ? "Se reintegró el dinero" : "Se envió el cambio") : "",
      notas: "", trackingCambio: ["Envío en camino", "Resuelto"].includes(estado) && tipo === "Cambio" ? `36000${Math.floor(r() * 90000000 + 10000000)}` : "",
      trackingDevolucion: ["Producto recibido", "Resuelto"].includes(estado) ? `36000${Math.floor(r() * 90000000 + 10000000)}` : "",
      productosRecibe: [{ producto: prod, cantidad: 1 }], productosEnvia: tipo === "Cambio" ? [{ producto: prod, cantidad: 1 }] : [],
      historial: hist,
      clienteNombre: `${c.nombre || ""} ${c.apellido || ""}`.trim(), clienteEmail: c.email || "", clienteTelefono: c.telefono || "", clienteTotal: v.total,
      createdAt: ts(creado), updatedAt: ts(creado + DIA), resolvedAt: estado === "Resuelto" ? ts(creado + 2 * DIA) : null,
      _demo: true,
    };
  });
}

function reclamosMpDemo(tid, ventas, ahora) {
  const vt = ventas.filter(v => v.medio?.startsWith("mp_")).slice(3, 5);
  return vt.map((v, i) => {
    const payId = String(90000000000 + i * 131 + 7);
    const c = v.cliente || {};
    return [`${tid}_mp_${payId}`, {
      ownerId: tid, orderNum: v.numero, tipo: "Contracargo", motivo: i === 0 ? "El comprador desconoce la compra" : "Producto no recibido",
      estado: i === 0 ? "Nuevo" : "Contactado", descripcion: "Contracargo abierto en Mercado Pago.",
      origen: "mp", fuente: "Mercado Pago", origenStatus: i === 0 ? "opened" : "in_process", origenUrl: "https://www.mercadopago.com.ar/activities",
      clienteNombre: `${c.nombre || ""} ${c.apellido || ""}`.trim(), clienteEmail: c.email || "", clienteTotal: v.total,
      historial: [{ accion: "Contracargo recibido de Mercado Pago", fecha: new Date(ahora - (i + 1) * DIA).toISOString() }],
      createdAt: ts(ahora - (i + 1) * DIA), updatedAt: ts(ahora - (i + 1) * DIA), resolvedAt: null, _demo: true,
    }];
  });
}

function influencersDemo(tid, ahora) {
  const base = [
    ["Cami Estilo", "cami.estilo", "Instagram", "CAMI10"], ["Lucas Tech", "lucastech", "TikTok", "LUCAS10"],
    ["Flor Viajera", "florviajera", "Instagram", "FLOR15"], ["Tomi Urbano", "tomiurbano", "YouTube", "TOMI10"],
  ];
  return base.map(([nombre, usuario, red, cod], i) => ({
    ownerId: tid, nombre, usuario, red, codigoDescuento: cod, descuentoPct: i === 2 ? 15 : 10, comisionPct: 12,
    email: `${usuario.replace(/\./g, "")}@ejemplo.com`, telefono: "", notas: "", driveFolder: "",
    createdAt: ts(ahora - (40 + i * 9) * DIA), _demo: true,
  }));
}

function canjesDemo(tid, productos, ahora) {
  const p = (i) => productos[i % productos.length]?.nombre || "Producto";
  const hoyMenos = (d) => ymd(ahora - d * DIA);
  const casos = [
    ["Cami Estilo", "cami.estilo", "Instagram", "Por enviar", 5, 0, "CAMI10"],
    ["Lucas Tech", "lucastech", "TikTok", "Enviado", 18, 5, "LUCAS10"],
    ["Flor Viajera", "florviajera", "Instagram", "Contenido pendiente", 12, 3, "FLOR15"],
    ["Tomi Urbano", "tomiurbano", "YouTube", "Cerrado", 35, 1, "TOMI10"],
    ["Cami Estilo", "cami.estilo", "Instagram", "Cerrado", 60, 0, "CAMI10"],
    ["Flor Viajera", "florviajera", "Instagram", "Enviado", 4, 8, "FLOR15"],
  ];
  return casos.map(([influencer, usuario, red, estado, diasAtras, prodIdx, cod], i) => {
    const creado = ahora - diasAtras * DIA;
    const enviado = estado !== "Por enviar";
    const piezas = [
      { id: `pz${i}a`, tipo: "Reel", estado: estado === "Cerrado" ? "publicada" : estado === "Contenido pendiente" ? "entregada" : "pendiente", fechaLimite: hoyMenos(diasAtras - 14), link: estado === "Cerrado" ? `https://instagram.com/p/demo${i}` : "" },
      { id: `pz${i}b`, tipo: "Historia", estado: estado === "Cerrado" ? "publicada" : "pendiente", fechaLimite: hoyMenos(diasAtras - 10), link: "" },
    ];
    return {
      ownerId: tid, influencer, usuario, red, estado,
      producto: p(prodIdx), productosCanje: [], tracking: enviado ? `36000${410000 + i * 977}` : "",
      fechaEnvio: enviado ? hoyMenos(diasAtras - 1) : "", fechaEnvioProgr: null, recordatorio: false,
      contenido: [{ tipo: "Reel", acordados: 1, entregados: estado === "Cerrado" ? 1 : 0 }, { tipo: "Historia", acordados: 1, entregados: estado === "Cerrado" ? 1 : 0 }],
      piezas, codigoDescuento: cod, comisionPct: 12, pedidoRef: "",
      createdAt: ts(creado), updatedAt: ts(creado + DIA), _demo: true,
    };
  });
}

function colaboradoresDemo(tid, ahora) {
  const r = rngDemo(9021);
  return [["Martina Diseño", "martina.disenio@ejemplo.com", "Diseño gráfico"], ["Bruno Edición", "bruno.edicion@ejemplo.com", "Edición de video"], ["Ro Community", "ro.community@ejemplo.com", "Community manager"]]
    .map(([nombre, email, rol]) => ({ uid: tid, nombre, email, rol, telefono: "", token: Array.from({ length: 24 }, () => Math.floor(r() * 16).toString(16)).join(""), createdAt: new Date(ahora - 50 * DIA).toISOString(), _demo: true }));
}

function tareasDemo(tid, ahora, quien) {
  const t = [
    ["Fotos de producto — colección primavera", "martina.disenio@ejemplo.com", "Martina Diseño", "en_proceso", "alta", 2],
    ["Reel de lanzamiento: Zapatillas Urban", "bruno.edicion@ejemplo.com", "Bruno Edición", "revision", "alta", 1],
    ["Calendario de posteos de octubre", "ro.community@ejemplo.com", "Ro Community", "pendiente", "normal", 6],
    ["Banners para el Hot Sale", "martina.disenio@ejemplo.com", "Martina Diseño", "pendiente", "alta", 9],
    ["Responder comentarios de la campaña", "ro.community@ejemplo.com", "Ro Community", "aprobado", "normal", -2],
    ["Video unboxing Mochila Urbana", "bruno.edicion@ejemplo.com", "Bruno Edición", "entregado", "normal", -6],
    ["Guía de talles para la web", "martina.disenio@ejemplo.com", "Martina Diseño", "bloqueada", "normal", 4],
  ];
  return t.map(([titulo, email, nombre, estado, prioridad, enDias], i) => {
    const n = i + 1; const creado = new Date(ahora - (10 - i) * DIA).toISOString();
    return {
      uid: tid, titulo, descripcion: `${titulo}. Brief y referencias en la carpeta compartida.`, brief: "", links: [],
      asignadoEmail: email, asignadoNombre: nombre, asignadosEmails: [email], prioridad, checklist: [],
      tareaNum: n, tareaNumStr: String(n).padStart(3, "0"),
      deadline: new Date(ahora + enDias * DIA), deadlineHora: "", recordarMail: false,
      estado, deliverables: [], correcciones: estado === "revision" ? 1 : 0, feedbackActual: null, comments: [], activity: [],
      esCampaña: false, slots: [], creadoPor: quien, createdAt: creado, updatedAt: creado, _demo: true,
    };
  });
}

function pagosDemo(ahora) {
  const f = (d) => ymd(ahora + d * DIA);
  const creado = new Date(ahora - 30 * DIA).toISOString();
  const x = (titulo, categoria, monto, venceEn, extra = {}) => ({ titulo, categoria, monto, moneda: "ARS", vence: f(venceEn), tipo: "unico", pagado: false, pagadoAt: null, grupo: null, cuotaN: null, cuotaTotal: null, notas: "", creado, _demo: true, ...extra });
  const out = [
    x("Alquiler del depósito", "alquiler", 850000, 1),
    x("Proveedor de packaging", "proveedor", 320000, 3),
    x("Tarjeta corporativa", "tarjeta", 1240000, -1),
    x("Sueldos del equipo", "sueldos", 2100000, 12),
    x("IIBB del mes", "impuestos", 186000, 8),
    x("Internet y software", "servicios", 74000, -4, { pagado: true, pagadoAt: new Date(ahora - 5 * DIA).toISOString() }),
    x("Pedido de mercadería — remeras", "producto", 1450000, 15, { notas: "Seña pagada, saldo contra entrega" }),
  ];
  for (let n = 1; n <= 6; n++) out.push(x(`Cuota del préstamo · ${n + 3}/12`, "prestamo", 410000, (n - 1) * 30 + 5, { tipo: "cuotas", grupo: "demo_prestamo", cuotaN: n + 3, cuotaTotal: 12 }));
  return out;
}

// ── Limpieza (solo tiendas demo) ─────────────────────────────────────────────
async function limpiarDemo(db, tid) {
  const ref = db.collection("users").doc(tid);
  for (const sub of ["demo_products", "demo_orders", "pagos_cal", "margenes_cache", "stock_cache", "arca_cache"]) await borrar(ref.collection(sub));
  await borrar(db.collection("reclamos").where("ownerId", "==", tid));
  await borrar(db.collection("canjes").where("ownerId", "==", tid));
  await borrar(db.collection("influencers").where("ownerId", "==", tid));
  await borrar(db.collection("tareas").where("uid", "==", tid));
  await borrar(db.collection("colaboradores").where("uid", "==", tid));
  try { const m = await import("./_demo_ads.js"); if (m.limpiarAdsDemo) await m.limpiarAdsDemo(db, tid); } catch (e) { console.warn("[demo] limpiar ads:", e.message); }
  try { const m = await import("./_demo_ops.js"); if (m.limpiarOpsDemo) await m.limpiarOpsDemo(db, tid); } catch (e) { console.warn("[demo] limpiar ops:", e.message); }
}

async function tiendaDemoDe(db, perfil, uid) {
  const cand = [perfil.demoTiendaUid, ...(perfil.tiendas || []).map(t => t.uid)].filter(Boolean);
  for (const tid of [...new Set(cand)]) {
    const d = (await db.collection("users").doc(tid).get()).data();
    if (d && d.demo?.activo && d.ownerUid === uid && !d.deleted) return { tid, d };
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Usá POST" });
  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body || "{}"); } catch (_) { body = {}; } }
  const action = String(body.action || "");

  const me = await verifyAuth(req);
  if (!me) return res.status(401).json({ error: "Sesión inválida. Recargá la página." });
  if (me.impersonatedBy) return res.status(403).json({ error: "Modo solo lectura." });
  let permitido = String(me.email || "").toLowerCase() === DEMO_EMAIL;
  if (!permitido) permitido = (await requireAdmin(req)).ok;
  if (!permitido) return res.status(403).json({ error: "La tienda demo es solo para la cuenta de prueba de Growith." });

  const db = initAdmin();
  const perfilRef = db.collection("users").doc(me.uid);
  const perfil = (await perfilRef.get()).data() || {};
  const ahora = Date.now();

  // Acciones sobre una tienda demo existente: tiene que ser demo y de este perfil.
  async function tiendaOk() {
    const tid = String(body.tiendaUid || "").trim();
    if (!tid) return null;
    const d = (await db.collection("users").doc(tid).get()).data();
    if (!d || !d.demo?.activo || (d.ownerUid !== me.uid)) return null;
    return { tid, d, ref: db.collection("users").doc(tid) };
  }
  const bump = (ref, extra = {}) => ref.set({ demo: { activo: true, version: Date.now(), ...extra } }, { merge: true });

  try {
    if (action === "status") {
      const t = await tiendaDemoDe(db, perfil, me.uid);
      if (!t) return res.json({ ok: true, tiendaUid: null });
      const ref = db.collection("users").doc(t.tid);
      const [p, v] = await Promise.all([ref.collection("demo_products").count().get(), ref.collection("demo_orders").count().get()]);
      return res.json({ ok: true, tiendaUid: t.tid, nombre: t.d.nombreTienda || "Growith Demo", activa: perfil.active_tienda_uid === t.tid, productos: p.data().count, ventas: v.data().count, medios: MEDIOS_DEMO });
    }

    if (action === "seed") {
      const dias = Math.min(180, Math.max(30, parseInt(body.dias) || 120));
      let t = await tiendaDemoDe(db, perfil, me.uid);
      const nueva = !t;
      const tid = t ? t.tid : "t_demo_" + ahora.toString(36) + Math.random().toString(36).slice(2, 6);
      const ref = db.collection("users").doc(tid);
      if (!nueva) await limpiarDemo(db, tid);

      // 1) Catálogo + ventas
      const productos = productosDemo();
      const ventas = historiaDemo(productos, { dias, hastaMs: ahora });
      await escribir(db, [
        ...productos.map(p => [ref.collection("demo_products").doc(p.id), p]),
        ...ventas.map(v => [ref.collection("demo_orders").doc(v.id), v]),
      ]);
      // 2) Operación
      const tareas = tareasDemo(tid, ahora, me.email || DEMO_EMAIL);
      await escribir(db, [
        ...reclamosDemo(tid, ventas, ahora).map(d => [db.collection("reclamos").doc(), d]),
        ...reclamosMpDemo(tid, ventas, ahora).map(([id, d]) => [db.collection("reclamos").doc(id), d]),
        ...influencersDemo(tid, ahora).map(d => [db.collection("influencers").doc(), d]),
        ...canjesDemo(tid, productos, ahora).map(d => [db.collection("canjes").doc(), d]),
        ...colaboradoresDemo(tid, ahora).map(d => [db.collection("colaboradores").doc(), d]),
        ...tareas.map(d => [db.collection("tareas").doc(), d]),
        ...pagosDemo(ahora).map(d => [ref.collection("pagos_cal").doc(), d]),
      ]);
      // 3) Publicidad, Mercado Libre, Facturador y Envíos (módulos propios)
      let patchAds = {}, patchOps = {};
      try { const m = await import("./_demo_ads.js"); if (m.seedAdsDemo) patchAds = (await m.seedAdsDemo(db, tid)) || {}; } catch (e) { console.warn("[demo] seed ads:", e.message); }
      try { const m = await import("./_demo_ops.js"); if (m.seedOpsDemo) patchOps = (await m.seedOpsDemo(db, tid, ventas)) || {}; } catch (e) { console.warn("[demo] seed ops:", e.message); }

      // 4) Doc de la tienda (plan completo, conectada a todo en modo demo)
      const nextNum = Math.max(1000, ...ventas.filter(v => v.canal !== "ml").map(v => parseInt(v.numero) || 0)) + 1;
      const planExpiry = Timestamp.fromMillis(ahora + 365 * DIA);
      await ref.set({
        uid: tid, esTienda: true, nombreTienda: "Growith Demo", colorTienda: "#10b981", nombre: "Growith Demo",
        email: me.email || DEMO_EMAIL, ownerUid: me.uid, ownerEmail: me.email || DEMO_EMAIL,
        teamUids: [me.uid], teamMembers: { [me.uid]: { email: me.email || DEMO_EMAIL, nombre: perfil.nombre || "Dueño", rol: "owner", secciones: {}, desde: ahora } },
        stores: [
          { type: "tiendanube", storeId: "demo", storeName: "Growith Demo", demo: true },
          { type: "mercadolibre", userId: "999000111", nickname: "GROWITH.DEMO", demo: true },
        ],
        plan: "full", planExpiry, trialEnd: null, isTrial: false, onbDone: true,
        tareasCount: tareas.length,
        margenesCogs: cogsDe(productos),
        demo: { activo: true, version: ahora, creadoAt: new Date(ahora).toISOString(), nextNum, nextMl: 2000009000000 },
        ...(nueva ? { createdAt: FieldValue.serverTimestamp(), createdAtIso: new Date(ahora).toISOString() } : {}),
        ...patchAds, ...patchOps,
      }, { merge: true });

      // 5) Perfil: plan completo (así se ven todas las secciones) y entrar a la demo
      await perfilRef.set({
        plan: "full", planExpiry, isTrial: false, demoTiendaUid: tid, active_tienda_uid: tid,
        ...(nueva ? { tiendas: FieldValue.arrayUnion({ uid: tid, nombre: "Growith Demo", color: "#10b981", rol: "owner", createdAt: new Date(ahora).toISOString() }) } : {}),
      }, { merge: true });
      clearTeamCache(tid); clearTeamCache(me.uid);
      return res.json({ ok: true, tiendaUid: tid, nueva, productos: productos.length, ventas: ventas.length, ads: Object.keys(patchAds).length > 0, ops: Object.keys(patchOps).length > 0 });
    }

    if (action === "add_order") {
      const t = await tiendaOk(); if (!t) return res.status(403).json({ error: "Tienda demo inválida." });
      const canal = body.canal === "ml" ? "ml" : "tienda";
      const pSnap = await t.ref.collection("demo_products").doc(String(body.prodId || "")).get();
      if (!pSnap.exists) return res.status(400).json({ error: "Elegí un producto." });
      const prod = { id: pSnap.id, ...pSnap.data() };
      if (canal === "ml" && prod.canal === "tienda") return res.status(400).json({ error: "Ese producto no está publicado en Mercado Libre." });
      if (canal === "tienda" && prod.canal === "ml") return res.status(400).json({ error: "Ese producto solo está en Mercado Libre." });
      const variante = (prod.variantes || []).find(v => v.id === body.varId) || prod.variantes?.[0];
      const qty = Math.max(1, Math.min(50, parseInt(body.qty) || 1));
      const medio = MEDIOS_DEMO[body.medio]?.canal === canal ? body.medio : (canal === "ml" ? "ml_clasica" : "mp_1");
      const pct = body.pct !== undefined && body.pct !== "" && isFinite(parseFloat(body.pct)) ? parseFloat(body.pct) : undefined;
      const fechaMs = body.fecha ? (String(body.fecha).length === 10 ? Date.parse(body.fecha + "T12:00:00-03:00") : Date.parse(body.fecha)) : ahora;
      const dd = t.d.demo || {};
      const id = canal === "ml" ? String((dd.nextMl || 2000009000000) + 1) : `do_${dd.nextNum || 5000}`;
      const numero = canal === "ml" ? id : String(dd.nextNum || 5000);
      const venta = ventaDemo({ id, numero, canal, medio, pct, items: [{ prod, variante, qty, precio: body.precio !== undefined && body.precio !== "" ? parseFloat(body.precio) : undefined }], fechaMs: isFinite(fechaMs) ? fechaMs : ahora, estadoEnvio: ["empaquetar", "enviar", "enviado", "entregado"].includes(body.estadoEnvio) ? body.estadoEnvio : "empaquetar", descuento: parseFloat(body.descuento) || 0 });
      await t.ref.collection("demo_orders").doc(id).set(venta);
      // Descuenta stock de la variante vendida (como una venta real)
      if (variante) {
        const vars = (prod.variantes || []).map(v => v.id === variante.id ? { ...v, stock: Math.max(0, (Number(v.stock) || 0) - qty) } : v);
        await pSnap.ref.set({ variantes: vars }, { merge: true });
      }
      await bump(t.ref, canal === "ml" ? { nextMl: Number(id) } : { nextNum: (dd.nextNum || 5000) + 1 });
      return res.json({ ok: true, venta });
    }

    if (action === "add_product") {
      const t = await tiendaOk(); if (!t) return res.status(403).json({ error: "Tienda demo inválida." });
      const nombre = String(body.nombre || "").trim().slice(0, 80);
      if (!nombre) return res.status(400).json({ error: "Poné un nombre." });
      const precio = Math.max(0, parseFloat(body.precio) || 0), costo = Math.max(0, parseFloat(body.costo) || 0);
      if (!precio) return res.status(400).json({ error: "Poné un precio." });
      const canal = ["tienda", "ml", "ambos"].includes(body.canal) ? body.canal : "ambos";
      const id = "dp_" + ahora.toString(36);
      const sku = (String(body.sku || "").trim() || nombre.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").slice(0, 10).toUpperCase()).slice(0, 24);
      const varsIn = Array.isArray(body.variantes) && body.variantes.length ? body.variantes : [{ nombre: "Único", stock: parseInt(body.stock) || 0 }];
      const variantes = varsIn.slice(0, 20).map((v, j) => ({ id: `${id}_v${j + 1}`, nombre: String(v.nombre || `Variante ${j + 1}`).slice(0, 40), sku: `${sku}-${String(j + 1).padStart(2, "0")}`, stock: Math.max(0, parseInt(v.stock) || 0), precio }));
      const prod = { id, nombre, sku, precio, costo, canal, mlId: canal !== "tienda" ? `MLA${1900000000 + (ahora % 99999999)}` : null, variantes, creadoAt: new Date(ahora).toISOString() };
      await t.ref.collection("demo_products").doc(id).set(prod);
      const cogs = {}; for (const v of variantes) cogs[v.sku] = costo; if (prod.mlId) cogs["ml:" + prod.mlId] = costo;
      await t.ref.set({ margenesCogs: cogs }, { merge: true });
      await bump(t.ref);
      return res.json({ ok: true, producto: prod });
    }

    if (action === "list") {
      const t = await tiendaOk(); if (!t) return res.status(403).json({ error: "Tienda demo inválida." });
      const [ps, os] = await Promise.all([t.ref.collection("demo_products").get(), t.ref.collection("demo_orders").orderBy("fecha", "desc").limit(40).get()]);
      return res.json({ ok: true, productos: ps.docs.map(d => ({ id: d.id, ...d.data() })), ventas: os.docs.map(d => ({ id: d.id, ...d.data() })), medios: MEDIOS_DEMO });
    }

    if (action === "delete_order" || action === "delete_product") {
      const t = await tiendaOk(); if (!t) return res.status(403).json({ error: "Tienda demo inválida." });
      const id = String(body.id || ""); if (!id) return res.status(400).json({ error: "Falta id" });
      await t.ref.collection(action === "delete_order" ? "demo_orders" : "demo_products").doc(id).delete();
      await bump(t.ref);
      return res.json({ ok: true });
    }

    if (action === "reset") {
      const t = await tiendaOk(); if (!t) return res.status(403).json({ error: "Tienda demo inválida." });
      await limpiarDemo(db, t.tid);
      await bump(t.ref);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: "Acción no reconocida" });
  } catch (e) {
    console.error("[demo]", action, e.message);
    return res.status(500).json({ error: e.message });
  }
}
