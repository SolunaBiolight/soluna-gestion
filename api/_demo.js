// api/_demo.js — Tienda DEMO de Growith: datos ficticios para mostrar la app por dentro.
//
// Una tienda con users/{uid}.demo.activo === true NO llama a Tienda Nube, Shopify,
// Mercado Libre, Mercado Pago, Meta, Google Ads, ARCA ni Andreani: cada endpoint
// devuelve datos armados desde Firestore:
//   users/{uid}/demo_products/{id}  → catálogo ficticio (canal "tienda", "ml" o "ambos")
//   users/{uid}/demo_orders/{id}    → ventas ficticias (canal, medio de pago, comisión, cliente, envío)
// y los formatea EXACTAMENTE como los devuelve cada plataforma, así el motor real
// (Márgenes, P&L, Stock, Envíos, Facturador) los procesa sin ramas especiales.
// Nada sale a plataformas reales: no se factura en ARCA, no se emiten etiquetas,
// no se manda ningún mail. La crea/regenera api/demo.js (solo contacto.growith@gmail.com).
//
// No es un endpoint (el "_" evita que Vercel lo publique).

export const DEMO_EMAIL = "contacto.growith@gmail.com";
export const esDemo = (d) => !!(d && d.demo && d.demo.activo);

// ── Medios de pago con la comisión típica de Argentina (2026) ────────────────
// pct = % TOTAL que le cuesta la venta al vendedor en ese medio (con IVA).
// Tienda (TN/Shopify): lo cobra la pasarela. Mercado Libre: comisión de la publicación.
export const MEDIOS_DEMO = {
  mp_1:          { canal: "tienda", label: "Mercado Pago · 1 pago",                gateway: "Mercado Pago",  method: "credit_card",   cuotas: 1, pct: 7.61 },
  mp_3:          { canal: "tienda", label: "Mercado Pago · 3 cuotas sin interés",  gateway: "Mercado Pago",  method: "credit_card",   cuotas: 3, pct: 16.5 },
  mp_6:          { canal: "tienda", label: "Mercado Pago · 6 cuotas sin interés",  gateway: "Mercado Pago",  method: "credit_card",   cuotas: 6, pct: 24.9 },
  mp_debito:     { canal: "tienda", label: "Mercado Pago · débito / dinero en cuenta", gateway: "Mercado Pago", method: "debit_card", cuotas: 1, pct: 3.99 },
  pagonube:      { canal: "tienda", label: "Pago Nube · 1 pago",                   gateway: "Pago Nube",     method: "credit_card",   cuotas: 1, pct: 5.99 },
  transferencia: { canal: "tienda", label: "Transferencia bancaria",               gateway: "Transferencia", method: "wire_transfer", cuotas: 1, pct: 0 },
  ml_clasica:    { canal: "ml",     label: "Mercado Libre · publicación Clásica",  gateway: "Mercado Pago",  method: "account_money", cuotas: 1, pct: 14.5 },
  ml_premium:    { canal: "ml",     label: "Mercado Libre · Premium (cuotas sin interés)", gateway: "Mercado Pago", method: "credit_card", cuotas: 6, pct: 26.5 },
};

// ── Catálogo ficticio (genérico, sin marcas reales) ──────────────────────────
// precio/costo en ARS. canal: "tienda" (TN/Shopify), "ml" o "ambos".
export const CATALOGO_DEMO = [
  { nombre: "Remera Oversize",        sku: "REM-OVS",  precio: 24900, costo: 8900,  canal: "ambos",  variantes: [["Negro · M", 42], ["Negro · L", 35], ["Blanco · M", 28], ["Blanco · L", 6]] },
  { nombre: "Buzo Canguro",           sku: "BUZ-CAN",  precio: 49900, costo: 19500, canal: "ambos",  variantes: [["Gris · M", 18], ["Gris · L", 22], ["Negro · L", 4]] },
  { nombre: "Gorra Trucker",          sku: "GOR-TRK",  precio: 18900, costo: 6200,  canal: "tienda", variantes: [["Negra", 55], ["Beige", 31]] },
  { nombre: "Botella Térmica 750 ml", sku: "BOT-750",  precio: 32900, costo: 11800, canal: "ambos",  variantes: [["Acero", 64], ["Negra", 3]] },
  { nombre: "Mochila Urbana",         sku: "MOC-URB",  precio: 64900, costo: 26400, canal: "tienda", variantes: [["Negra", 21]] },
  { nombre: "Auriculares Bluetooth",  sku: "AUR-BT",   precio: 79900, costo: 38500, canal: "ml",     variantes: [["Negro", 17], ["Blanco", 9]] },
  { nombre: "Lámpara LED de escritorio", sku: "LAM-LED", precio: 45900, costo: 17200, canal: "ambos", variantes: [["Blanca", 26]] },
  { nombre: "Set de Tazas x4",        sku: "TAZ-SET4", precio: 29900, costo: 10900, canal: "tienda", variantes: [["Cerámica", 38]] },
  { nombre: "Zapatillas Urban",       sku: "ZAP-URB",  precio: 89900, costo: 41000, canal: "ambos",  variantes: [["40", 7], ["41", 12], ["42", 9], ["43", 2]] },
  { nombre: "Perfume 100 ml",         sku: "PER-100",  precio: 54900, costo: 21000, canal: "ml",     variantes: [["Unisex", 33]] },
  { nombre: "Cartera de Cuero",       sku: "CAR-CUE",  precio: 74900, costo: 30500, canal: "tienda", variantes: [["Suela", 11], ["Negra", 0]] },
  { nombre: "Anteojos de Sol",        sku: "ANT-SOL",  precio: 39900, costo: 12300, canal: "ambos",  variantes: [["Carey", 24], ["Negro", 19]] },
];

// ── Clientes y destinos ficticios ────────────────────────────────────────────
const NOMBRES = ["Sofía", "Martina", "Valentina", "Camila", "Lucía", "Julieta", "Florencia", "Agustina", "Mateo", "Santiago", "Tomás", "Joaquín", "Nicolás", "Facundo", "Lautaro", "Franco", "Micaela", "Rocío", "Bruno", "Ignacio"];
const APELLIDOS = ["González", "Rodríguez", "Fernández", "López", "Martínez", "Pérez", "Gómez", "Díaz", "Sánchez", "Romero", "Álvarez", "Torres", "Ruiz", "Ramírez", "Flores", "Acosta", "Benítez", "Medina", "Herrera", "Suárez"];
const DESTINOS = [
  ["Buenos Aires", "La Plata", "1900", 16], ["Capital Federal", "Palermo", "1425", 22], ["Buenos Aires", "Quilmes", "1878", 9],
  ["Buenos Aires", "San Isidro", "1642", 8], ["Córdoba", "Córdoba", "5000", 12], ["Santa Fe", "Rosario", "2000", 10],
  ["Mendoza", "Mendoza", "5500", 6], ["Tucumán", "San Miguel de Tucumán", "4000", 4], ["Neuquén", "Neuquén", "8300", 3],
  ["Salta", "Salta", "4400", 3], ["Entre Ríos", "Paraná", "3100", 3], ["Chubut", "Comodoro Rivadavia", "9000", 2],
];
const CALLES = ["Av. Corrientes", "San Martín", "Belgrano", "Rivadavia", "Av. Santa Fe", "Mitre", "Sarmiento", "Moreno", "Av. Colón", "9 de Julio"];

// RNG determinístico (misma semilla = mismo entorno)
export function rngDemo(seed = 20260915) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
function pickPeso(r, arr, idxPeso) { const tot = arr.reduce((s, x) => s + x[idxPeso], 0); let v = r() * tot; for (const x of arr) { v -= x[idxPeso]; if (v <= 0) return x; } return arr[arr.length - 1]; }

export function clienteDemo(r) {
  const n = pick(r, NOMBRES), a = pick(r, APELLIDOS);
  const [prov, ciudad, cp] = pickPeso(r, DESTINOS, 3);
  const mail = `${n}.${a}`.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z.]/g, "") + Math.floor(r() * 90 + 10) + "@ejemplo.com";
  return {
    nombre: n, apellido: a, email: mail,
    telefono: "11" + String(Math.floor(r() * 90000000 + 10000000)),
    dni: String(Math.floor(r() * 25000000 + 20000000)),
    provincia: prov, ciudad, localidad: ciudad, cp,
    direccion: pick(r, CALLES), numero: String(Math.floor(r() * 4800 + 100)),
  };
}

// Productos ficticios listos para guardar en demo_products (ids estables).
export function productosDemo() {
  return CATALOGO_DEMO.map((p, i) => {
    const id = `dp_${i + 1}`;
    return {
      id, nombre: p.nombre, sku: p.sku, precio: p.precio, costo: p.costo, canal: p.canal,
      mlId: p.canal !== "tienda" ? `MLA${1800000000 + i * 7919}` : null,
      variantes: p.variantes.map(([nombre, stock], j) => ({ id: `${id}_v${j + 1}`, nombre, sku: `${p.sku}-${String(j + 1).padStart(2, "0")}`, stock, precio: p.precio })),
      creadoAt: new Date().toISOString(),
    };
  });
}

// Comisión en $ de una venta ficticia (lo que el Dashboard descuenta).
export function feeDemo(o) {
  const pct = o.pct != null ? Number(o.pct) : (MEDIOS_DEMO[o.medio]?.pct || 0);
  return Math.round((Number(o.total) || 0) * pct) / 100;
}

/**
 * Arma UNA venta ficticia (sin guardarla).
 * canal "tienda" | "ml"; medio = clave de MEDIOS_DEMO; items = [{prod, variante, qty}]
 */
export function ventaDemo({ r = Math.random, id, numero, canal, medio, pct, items, fechaMs, envioCliente, envioCosto, descuento = 0, cliente, estadoEnvio, tipoEnvio, facturada = false }) {
  const m = MEDIOS_DEMO[medio] || MEDIOS_DEMO[canal === "ml" ? "ml_clasica" : "mp_1"];
  const its = items.map(({ prod, variante, qty, precio }) => {
    const v = variante || prod.variantes?.[0] || null;
    return { prodId: prod.id, varId: v?.id || prod.id, sku: v?.sku || prod.sku, nombre: prod.nombre, variante: v?.nombre || "", qty: qty || 1, precio: precio != null ? Number(precio) : Number(v?.precio ?? prod.precio), mlId: prod.mlId || null };
  });
  const subtotal = its.reduce((s, i) => s + i.precio * i.qty, 0);
  const envCli = envioCliente != null ? Number(envioCliente) : (canal === "ml" ? 0 : (subtotal >= 60000 ? 0 : 6900));
  const envCos = envioCosto != null ? Number(envioCosto) : (canal === "ml" ? 7400 : 8900);
  const total = Math.max(0, subtotal - (Number(descuento) || 0)) + envCli;
  const o = {
    id: String(id), numero: String(numero), canal, medio, pct: pct != null ? Number(pct) : m.pct, cuotas: m.cuotas,
    fecha: new Date(fechaMs || Date.now()).toISOString(),
    items: its, subtotal, descuento: Number(descuento) || 0, envioCliente: envCli, envioCosto: envCos, total,
    cliente: cliente || clienteDemo(r),
    tipoEnvio: tipoEnvio || (r() < 0.35 ? "sucursal" : "domicilio"),
    estadoEnvio: estadoEnvio || "entregado", // empaquetar | enviar | enviado | entregado
    facturada: !!facturada,
    _demo: true,
  };
  o.fee = feeDemo(o);
  return o;
}

/**
 * Genera `dias` de historia de ventas (determinística). Los últimos días quedan
 * con pedidos por empaquetar/enviar y sin facturar, para que Envíos y el
 * Facturador tengan trabajo pendiente.
 */
export function historiaDemo(productos, { dias = 120, seed = 20260915, hastaMs = Date.now() } = {}) {
  const r = rngDemo(seed);
  const tienda = productos.filter(p => p.canal !== "ml");
  const ml = productos.filter(p => p.canal !== "tienda");
  const out = [];
  let nroTienda = 1000, nroMl = 2000004100000;
  const MEDIOS_T = [["mp_1", 44], ["mp_3", 22], ["mp_6", 5], ["mp_debito", 9], ["pagonube", 11], ["transferencia", 9]];
  const MEDIOS_M = [["ml_clasica", 62], ["ml_premium", 38]];
  for (let d = dias; d >= 0; d--) {
    const diaMs = hastaMs - d * 86400000;
    const dow = new Date(diaMs - 3 * 3600000).getUTCDay();
    // Tendencia creciente + fin de semana más fuerte + ruido
    const base = 4 + (dias - d) * 0.045 + (dow === 0 || dow === 6 ? 2 : 0);
    const nT = Math.max(0, Math.round(base + (r() - 0.5) * 4));
    const nM = Math.max(0, Math.round(base * 0.55 + (r() - 0.5) * 3));
    const gen = (canal, n) => {
      for (let k = 0; k < n; k++) {
        const lista = canal === "ml" ? ml : tienda;
        if (!lista.length) return;
        const prod = pick(r, lista);
        const variante = pick(r, prod.variantes);
        const items = [{ prod, variante, qty: r() < 0.82 ? 1 : 2 }];
        if (canal === "tienda" && r() < 0.18) { const p2 = pick(r, tienda); items.push({ prod: p2, variante: pick(r, p2.variantes), qty: 1 }); }
        const hora = Math.floor(9 + r() * 14), min = Math.floor(r() * 60);
        // fecha en hora argentina → UTC
        const dAR = new Date(diaMs - 3 * 3600000); dAR.setUTCHours(hora, min, Math.floor(r() * 60), 0);
        const fechaMs = Math.min(dAR.getTime() + 3 * 3600000, hastaMs - 60000);
        const medio = pickPeso(r, canal === "ml" ? MEDIOS_M : MEDIOS_T, 1)[0];
        const edad = d; // días desde la venta
        const estadoEnvio = edad <= 0 ? (r() < 0.6 ? "empaquetar" : "enviar") : edad <= 1 ? (r() < 0.3 ? "enviar" : "enviado") : edad <= 4 ? (r() < 0.55 ? "enviado" : "entregado") : "entregado";
        const cupon = canal === "tienda" && r() < 0.12 ? Math.round(items.reduce((s, i) => s + i.variante.precio * i.qty, 0) * 0.1) : 0;
        const id = canal === "ml" ? String(++nroMl) : `do_${++nroTienda}`;
        out.push(ventaDemo({ r, id, numero: canal === "ml" ? id : String(nroTienda), canal, medio, items, fechaMs, descuento: cupon, estadoEnvio, facturada: edad > 2 && r() < 0.93 }));
      }
    };
    gen("tienda", nT); gen("ml", nM);
  }
  return out;
}

// ── Formatos de plataforma (lo que procesa el motor real) ────────────────────
const ESTADO_TN = { empaquetar: "unpacked", enviar: "ready_to_ship", enviado: "shipped", entregado: "delivered" };

/** Pedido ficticio → pedido crudo de Tienda Nube (processTN, Envíos, Facturador). */
export function tnOrderDemo(o) {
  const m = MEDIOS_DEMO[o.medio] || MEDIOS_DEMO.mp_1;
  const c = o.cliente || {};
  return {
    id: o.id, number: o.numero, status: "open", created_at: o.fecha, paid_at: o.fecha,
    payment_status: "paid", shipping_status: ESTADO_TN[o.estadoEnvio] || "delivered",
    shipped_at: ["enviado", "entregado"].includes(o.estadoEnvio) ? o.fecha : null,
    products: (o.items || []).map(i => ({ product_id: i.prodId, variant_id: i.varId, sku: i.sku, name: i.nombre, variant_values: i.variante ? [i.variante] : [], price: String(i.precio), quantity: i.qty })),
    subtotal: String(o.subtotal), discount: String(o.descuento || 0), total: String(o.total),
    shipping_cost_customer: String(o.envioCliente || 0), shipping_cost_owner: String(o.envioCosto || 0),
    gateway: m.gateway, gateway_name: m.gateway, payment_details: { method: m.method, installments: m.cuotas },
    customer: { id: "c_" + (c.email || o.id), name: `${c.nombre || ""} ${c.apellido || ""}`.trim(), email: c.email || "" },
    contact_email: c.email || "", contact_name: `${c.nombre || ""} ${c.apellido || ""}`.trim(), contact_phone: c.telefono || "", contact_identification: c.dni || "",
    shipping_address: { name: c.nombre || "", last_name: c.apellido || "", address: c.direccion || "", number: c.numero || "", floor: "", locality: c.localidad || "", city: c.ciudad || "", zipcode: c.cp || "", province: c.provincia || "", country: "AR" },
    billing_address: { name: `${c.nombre || ""} ${c.apellido || ""}`.trim(), email: c.email || "", phone: c.telefono || "" },
    shipping_option: o.tipoEnvio === "sucursal" ? "Andreani - Retiro en sucursal" : "Andreani - Envío a domicilio",
    storefront: "store", admin_url: "", _demo: true,
  };
}

/** Pedido ficticio → orden cruda de Mercado Libre (processML). */
export function mlOrderDemo(o) {
  const m = MEDIOS_DEMO[o.medio] || MEDIOS_DEMO.ml_clasica;
  const pct = o.pct != null ? Number(o.pct) : m.pct;
  const localAR = new Date(Date.parse(o.fecha) - 3 * 3600000).toISOString().slice(0, 19) + ".000-03:00";
  const c = o.cliente || {};
  return {
    id: Number(o.id) || o.id, status: "paid", date_created: localAR, date_closed: localAR,
    total_amount: Number(o.total) || 0,
    order_items: (o.items || []).map(i => ({ item: { id: i.mlId || ("MLA" + i.prodId), title: i.nombre, variation_attributes: i.variante ? [{ name: "Variante", value_name: i.variante }] : [] }, quantity: i.qty, unit_price: i.precio, sale_fee: Math.round(i.precio * pct) / 100 })),
    payments: [{ id: Number(o.id) + 7, status: "approved", transaction_amount: Number(o.total) || 0, transaction_amount_refunded: 0, installments: m.cuotas, payment_type: m.method }],
    shipping: { id: 44000000000 + (Number(String(o.id).slice(-6)) || 0) },
    buyer: { id: 900000 + (Number(String(o.id).slice(-4)) || 0), nickname: `${(c.nombre || "COMPRADOR").toUpperCase()}${String(o.id).slice(-3)}` },
    _demo: true,
  };
}

/** Producto ficticio → producto de Tienda Nube (normTN). */
export function tnProductoDemo(p) {
  return {
    id: p.id, name: { es: p.nombre }, images: p.imagen ? [{ src: p.imagen }] : [],
    variants: (p.variantes || []).map(v => ({ id: v.id, sku: v.sku || "", stock: v.stock ?? 0, price: String(v.precio ?? p.precio), values: v.nombre ? [{ es: v.nombre }] : [] })),
  };
}

// ── Lectura ───────────────────────────────────────────────────────────────────
function aMs(x) {
  if (x == null || x === "") return null;
  if (x instanceof Date) return x.getTime();
  if (typeof x === "number") return x < 1e12 ? x * 1000 : x;
  const ms = Date.parse(String(x).length === 10 ? String(x) + "T00:00:00-03:00" : String(x));
  return isNaN(ms) ? null : ms;
}

/** Productos + ventas ficticias de la tienda (ventas filtradas por fecha si se pasa rango). */
export async function leerDemo(db, uid, since, until) {
  const ref = db.collection("users").doc(uid);
  const [ps, os] = await Promise.all([ref.collection("demo_products").get(), ref.collection("demo_orders").get()]);
  const productos = ps.docs.map(d => ({ id: d.id, ...d.data() }));
  const desde = aMs(since), hasta = aMs(until);
  // "hasta" como fecha (YYYY-MM-DD) incluye el día completo
  const hastaIncl = hasta != null && String(until).length === 10 ? hasta + 86400000 - 1 : hasta;
  const ventas = os.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(o => { const t = Date.parse(o.fecha); return (desde == null || t >= desde) && (hastaIncl == null || t <= hastaIncl); })
    .sort((a, b) => Date.parse(b.fecha) - Date.parse(a.fecha));
  return { productos, ventas };
}

/** Gasto publicitario diario ficticio (Meta / Google), determinístico por fecha. */
export function gastoAdsDemo(fechaYMD, plataforma = "meta") {
  const s = String(fechaYMD).replace(/-/g, "");
  const r = rngDemo(Number(s) + (plataforma === "google" ? 77 : 13));
  const base = plataforma === "google" ? 38000 : 92000;
  return Math.round(base * (0.8 + r() * 0.45));
}
