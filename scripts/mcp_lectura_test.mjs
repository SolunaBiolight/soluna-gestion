// Prueba de las herramientas de lectura del conector MCP (referencias, canjes,
// reclamos, tareas) con un Firestore simulado. Uso: node scripts/mcp_lectura_test.mjs
import { __test } from "../api/mcp.js";
const { handleRpc, TOOLS } = __test;

const DIA = 86400000, ahora = Date.now();
const iso = (d) => new Date(ahora - d * DIA).toISOString();
const tsF = (d) => ({ _seconds: Math.floor((ahora - d * DIA) / 1000), toDate() { return new Date(ahora - d * DIA); } });
const UID = "tienda1", OTRA = "tienda2";

// ── Firestore simulado: colecciones raíz, subcolecciones, where ==, get/set/update ──
function crearDb(datos) {
  const store = new Map(Object.entries(datos).map(([k, v]) => [k, new Map(Object.entries(v))]));
  const col = (path) => { if (!store.has(path)) store.set(path, new Map()); return store.get(path); };
  const docRef = (path, id) => ({
    id,
    async get() { const d = col(path).get(id); return { exists: d !== undefined, id, data: () => d }; },
    async set(v, o) { col(path).set(id, o?.merge ? { ...(col(path).get(id) || {}), ...v } : v); },
    async update(v) { col(path).set(id, { ...(col(path).get(id) || {}), ...v }); },
    collection: (sub) => colRef(`${path}/${id}/${sub}`),
  });
  const query = (path, filtros) => ({
    where: (f, op, v) => query(path, [...filtros, [f, op, v]]),
    limit: () => query(path, filtros), orderBy: () => query(path, filtros),
    async get() {
      const docs = [...col(path).entries()].filter(([, d]) => filtros.every(([f, op, v]) =>
        op === "==" ? d[f] === v : op === "array-contains" ? (d[f] || []).includes(v) : op === ">=" ? d[f] >= v : op === "<" ? d[f] < v : true))
        .map(([id, d]) => ({ id, data: () => d }));
      return { docs, empty: !docs.length, size: docs.length };
    },
  });
  const colRef = (path) => ({ doc: (id) => docRef(path, id ?? Math.random().toString(36).slice(2)), ...query(path, []), add: async (v) => col(path).set(Math.random().toString(36).slice(2), v) });
  return { collection: colRef, _store: store };
}

const db = crearDb({
  users: { [UID]: { nombreTienda: "Soluna", stores: [] }, [OTRA]: { nombreTienda: "Otra" } },
  general: {
    [UID]: {
      referencias: [
        { id: "r1", nombre: "Foqus", color: "#000", links: [{ tipo: "meta", label: "", url: "https://www.facebook.com/ads/library/?view_all_page_id=123" }, { tipo: "web", label: "landing", url: "https://foqus.com.ar" }] },
        { id: "r2", nombre: "No Mercy", web: "https://nomercy.com", metaAds: "https://www.facebook.com/ads/library/?q=nomercy", ig: "https://instagram.com/nomercy", notas: "Escribir a ventas@nomercy.com" },
      ],
      materiales: [{ id: "m1", nombre: "Fotos de producto", url: "https://drive.google.com/x", nota: "", tipo: "drive", cat: "Fotos" }],
      posts: [{ texto: "Grabar el jueves", tipo: "aviso", pinned: true, createdAt: iso(1) }],
    },
  },
  canjes: {
    c1: { ownerId: UID, influencer: "Chiara", usuario: "chiara.ok", red: "Instagram", estado: "Contenido pendiente", email: "chiara@mail.com", telefono: "1155554444", dni: "30111222", direccion: "Calle Falsa", dirNumero: "123", cp: "1900", localidad: "La Plata", tracking: "360001234", trackingEstado: "Entregado", producto: "Anteojo rojo", productosCanje: [{ nombre: "Anteojo rojo", cantidad: 1 }], piezas: [{ id: "p1", tipo: "Reel", estado: "pendiente", fechaLimite: "2020-01-01", link: "" }, { id: "p2", tipo: "Historia", estado: "publicada", fechaLimite: "", link: "https://ig/p" }], codigoDescuento: "CHIARA10", createdAt: tsF(10), updatedAt: tsF(2) },
    c2: { ownerId: UID, influencer: "Viejo", estado: "Cerrado", contenido: [], createdAt: tsF(300), updatedAt: tsF(200), finalizadoAt: tsF(200) },
    c3: { ownerId: OTRA, influencer: "De otra tienda", estado: "Enviado", createdAt: tsF(1) },
  },
  influencers: { i1: { ownerId: UID, nombre: "Chiara", usuario: "chiara.ok", red: "Instagram", email: "chiara@mail.com", telefono: "1155554444", codigoDescuento: "CHIARA10" } },
  reclamos: {
    r1: { ownerId: UID, orderNum: "5012", tipo: "Cambio", motivo: "Talle incorrecto", estado: "Contactado", descripcion: "Me escribió al 221 455-9252 o a juan@gmail.com el 2026-10-20, pagó 12.500.000. Pago MP 12345678901, pedido #98765432", clienteNombre: "Juan Pérez", clienteEmail: "juan@gmail.com", clienteTelefono: "2214559252", direccion: "Calle 1", asignadoNombre: "Nico", productosRecibe: [{ producto: "Anteojo amarillo", cantidad: 1 }], historial: [{ accion: "Reclamo creado", fecha: iso(3) }], createdAt: tsF(3), updatedAt: tsF(1) },
    r2: { ownerId: UID, orderNum: "4900", tipo: "Devolución", motivo: "No es lo que esperaba", estado: "Resuelto", clienteEmail: "x@y.com", createdAt: tsF(40), updatedAt: tsF(30), resolvedAt: tsF(30) },
    r3: { ownerId: UID, orderNum: "4000", tipo: "Reclamo", motivo: "Demora", estado: "Rechazado", createdAt: tsF(120), updatedAt: tsF(100), resolvedAt: tsF(100) },
    r4: { ownerId: OTRA, orderNum: "1", tipo: "Reclamo", motivo: "Ajeno", estado: "Nuevo", createdAt: tsF(1) },
  },
  tareas: {
    t1: { uid: UID, titulo: "Guion Chiara", estado: "en_proceso", prioridad: "alta", asignadoEmail: "nico@soluna.com", asignadoNombre: "Nico", asignadosEmails: ["nico@soluna.com", "lau@soluna.com"], deadline: new Date(new Date(ahora - 2 * DIA).toISOString().slice(0, 10) + "T00:00:00Z"), checklist: [{ id: "a", text: "Hook", done: true }], links: [{ name: "", url: "https://doc" }], deliverables: [], tareaNumStr: "007", createdAt: tsF(5), updatedAt: tsF(1) },
    t2: { uid: UID, titulo: "Placa vieja", estado: "aprobado", asignadoEmail: "lau@soluna.com", deadline: tsF(200), createdAt: tsF(210), updatedAt: tsF(200) },
    t3: { uid: UID, titulo: "Placa nueva", estado: "pendiente", asignadoEmail: "lau@soluna.com", deadline: new Date(ahora + 5 * DIA), createdAt: tsF(1), updatedAt: tsF(1) },
    t5: { uid: UID, titulo: "Vence mañana", estado: "pendiente", asignadoEmail: "lau@soluna.com", deadline: new Date(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date(ahora + DIA)) + "T00:00:00Z"), createdAt: tsF(1), updatedAt: tsF(1) },
    t4: { uid: OTRA, titulo: "Ajena", estado: "pendiente", createdAt: tsF(1) },
  },
  colaboradores: { k1: { uid: UID, nombre: "Lautaro", email: "lau@soluna.com", token: "secreto" }, k2: { uid: UID, nombre: "Nico", email: "nico@soluna.com", token: "secreto2" } },
  mcp_grants: { g1: { uid: UID } },
});

let fallas = 0, n = 0;
const ok = (c, msg) => { n++; if (!c) { fallas++; console.log("✗", msg); } else console.log("✓", msg); };
const ctx = { perfil: UID, grantId: "g1", origin: "https://www.growithapp.com", sesion: { id: "s1", clienteUid: UID } };
const llamar = async (name, args = {}) => {
  const r = await handleRpc(db, ctx, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return r.result;
};

// tools/list
const lista = (await handleRpc(db, ctx, { jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools;
for (const t of ["referencias", "canjes", "reclamos", "tareas"]) {
  const d = lista.find(x => x.name === t);
  ok(d && d.annotations.readOnlyHint === true && d.annotations.destructiveHint === false, `${t}: publicada como solo lectura`);
  ok(d && d.inputSchema.properties.cliente_id, `${t}: acepta cliente_id como las demás`);
}
ok(TOOLS.length === lista.length, "tools/list devuelve todas");

const PROHIBIDOS = ["juan@gmail.com", "2214559252", "221 455-9252", "Juan Pérez", "Calle 1", "chiara@mail.com", "1155554444", "30111222", "Calle Falsa", "lau@soluna.com", "nico@soluna.com", "secreto", "360001234", "x@y.com"];
const sinPII = (r, t) => { const s = JSON.stringify(r); const hall = PROHIBIDOS.filter(p => s.includes(p)); ok(!hall.length, `${t}: sin datos de contacto${hall.length ? " (filtró: " + hall.join(", ") + ")" : ""}`); };

// referencias
let r = await llamar("referencias");
ok(!r.isError, "referencias: responde");
let d = r.structuredContent;
ok(d.cliente.cliente_id === UID && d.cliente.nombre === "Soluna", "referencias: dice de qué cliente es");
ok(d.referencias.length === 2, "referencias: las dos marcas");
ok(d.referencias[0].links.some(l => l.tipo.startsWith("Meta Ads") && l.url.includes("ads/library")), "referencias: link a la Ad Library de Foqus");
ok(d.referencias[1].links.length === 3, "referencias: formato viejo (web/metaAds/ig) también sale");
ok(d.referencias[1].notas.includes("[mail]"), "referencias: el mail en notas se tapa");
ok(d.materiales.length === 1 && d.tablon.length === 1, "referencias: materiales y tablón");

// canjes
r = await llamar("canjes"); d = r.structuredContent;
ok(!r.isError, "canjes: responde");
ok(d.canjes.length === 1 && d.canjes[0].influencer === "Chiara", "canjes: solo los de esta tienda, sin el cerrado de hace 200 días");
ok(d.resumen.canjes_total === 2, "canjes: el resumen cuenta todos los de la tienda");
ok(d.canjes[0].piezas.length === 2 && d.canjes[0].piezas[0].vencida === true, "canjes: piezas con vencimiento");
ok(d.canjes[0].piezas_resumen.publicadas === 1 && d.canjes[0].envio_estado === "Entregado", "canjes: resumen de piezas y estado del envío");
ok(d.influencers.length === 1 && d.influencers[0].codigo_descuento === "CHIARA10", "canjes: influencers");
sinPII(d, "canjes");

// reclamos
r = await llamar("reclamos"); d = r.structuredContent;
ok(!r.isError, "reclamos: responde");
ok(d.reclamos.length === 2, "reclamos: abierto + cerrado de 30 días (no el de 100 días ni el de otra tienda)");
const ab = d.reclamos.find(x => x.pedido === "5012");
ok(ab.abierto && ab.paso_actual === "Contactado" && ab.siguiente_paso === "Esperando producto", "reclamos: paso actual y siguiente");
ok(ab.dias_abierto === 3 && ab.responsable === "Nico" && ab.motivo === "Talle incorrecto", "reclamos: días abierto, responsable, motivo");
ok(ab.descripcion.includes("[teléfono]") && ab.descripcion.includes("[mail]"), "reclamos: teléfono y mail de la descripción tapados");
ok(ab.descripcion.includes("2026-10-20") && ab.descripcion.includes("12.500.000"), "reclamos: fechas y montos no se tapan");
ok(ab.descripcion.includes("Pago MP 12345678901") && ab.descripcion.includes("#98765432"), "reclamos: números de pago y de pedido no se tapan");
ok(d.resumen.abiertos === 1 && d.resumen.cerrados_60_dias === 1, "reclamos: resumen");
sinPII(d, "reclamos");

// tareas
r = await llamar("tareas"); d = r.structuredContent;
ok(!r.isError, "tareas: responde");
ok(d.tareas.length === 3 && d.tareas.every(t => t.titulo !== "Ajena" && t.titulo !== "Placa vieja"), "tareas: abiertas de esta tienda, sin la aprobada hace 200 días");
const t1 = d.tareas[0];
ok(t1.titulo === "Guion Chiara" && t1.vencida && t1.estado === "En proceso", "tareas: ordenadas por fecha límite, vencida, estado legible");
ok(t1.asignados.join(",") === "Nico,Lautaro" && d.tareas.find(t => t.titulo === "Placa nueva").responsable === "Lautaro", "tareas: responsables por nombre (desde colaboradores)");
ok(t1.checklist[0].item === "Hook" && t1.checklist[0].hecho && t1.links[0] === "https://doc", "tareas: checklist y links");
ok(d.tareas.find(t => t.titulo === "Vence mañana").vencida === false, "tareas: la que vence mañana no figura vencida (zona horaria)");
sinPII(d, "tareas");

// cliente_id ajeno: mismo control que las demás herramientas
r = await llamar("reclamos", { cliente_id: OTRA });
ok(r.isError, "reclamos: un cliente_id que no es del usuario se rechaza");

// Nada se escribió en las colecciones de negocio
const antes = JSON.stringify([...db._store.get("reclamos")]) + JSON.stringify([...db._store.get("canjes")]) + JSON.stringify([...db._store.get("tareas")]) + JSON.stringify([...db._store.get("general")]);
for (const t of ["referencias", "canjes", "reclamos", "tareas"]) await llamar(t);
const despues = JSON.stringify([...db._store.get("reclamos")]) + JSON.stringify([...db._store.get("canjes")]) + JSON.stringify([...db._store.get("tareas")]) + JSON.stringify([...db._store.get("general")]);
ok(antes === despues, "ninguna de las cuatro escribe datos del negocio");

console.log(`\n${n - fallas}/${n} chequeos OK`);
process.exit(fallas ? 1 : 0);
