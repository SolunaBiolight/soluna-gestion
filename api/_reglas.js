// ─── Motor de reglas de escala de Meta (determinístico, sin IA) ───
// Las reglas son JSON estructurado (ver ESQUEMA) que escribe el asistente de IA del usuario por MCP
// (reglas_crear / reglas_editar). Este motor las corre cada 15 min (:00 :15 :30 :45) sobre todas las
// campañas y conjuntos ACTIVOS de las cuentas publicitarias, con gasto de Meta y ventas reales de
// Impultienda (UTM), y actúa en Meta. Mismos datos → mismo resultado.
//
// Firestore (users/{uid}/…):
//   meta_escala/cfg               {activo, simular}  (llaves globales)
//   meta_escala_reglas/{id}       {regla (JSON validado), texto_original, version, creada_por, creada, actualizada}
//   meta_escala_estado/{nodo}     estado por campaña/conjunto (piso, puesto, subidas/bajadas del día, porRegla)
//   meta_escala_log/{auto}        cada acción (o simulación) con regla, métricas usadas, cálculo y números
//   meta_escala_vueltas/{iso}     cada vuelta de 15 min: ok, saltada (motivo) o con errores
//   meta_escala_resumen/{día}     resumen de las 21:30 (hora Argentina)
// system/meta_escala {uids:{uid:true}}: tiendas con reglas activas (las que recorre el cron).
//
// Lo manual manda: un presupuesto o tope cambiado a mano pasa a ser el nuevo punto de partida y piso; el
// motor nunca activa nada (solo lee ACTIVOS). Si en una vuelta falla cualquier lectura, no toca nada.

import { utcDeLocal, zonaDe, fxPorUsd, aUsd, atribuirUtm, armarTiendas, leerIndiceUtm, construirIndiceUtm, paisDeUtm, tzValida } from "./impultienda.js";

const META_V = "v23.0";
const ART = "America/Argentina/Buenos_Aires";
const CAPS = ["COST_CAP", "LOWEST_COST_WITH_BID_CAP"];

// Zona horaria por país (código de 2 letras de la tienda o del nombre de la campaña).
export const PAIS_TZ = {
  AR: "America/Argentina/Buenos_Aires", UY: "America/Montevideo", CL: "America/Santiago", PE: "America/Lima", CO: "America/Bogota", MX: "America/Mexico_City",
  BR: "America/Sao_Paulo", PY: "America/Asuncion", BO: "America/La_Paz", EC: "America/Guayaquil", VE: "America/Caracas", US: "America/New_York", CA: "America/Toronto",
  ES: "Europe/Madrid", PT: "Europe/Lisbon", IT: "Europe/Rome", FR: "Europe/Paris", DE: "Europe/Berlin", AT: "Europe/Vienna", CH: "Europe/Zurich", BE: "Europe/Brussels",
  NL: "Europe/Amsterdam", UK: "Europe/London", GB: "Europe/London", IE: "Europe/Dublin", PL: "Europe/Warsaw", CZ: "Europe/Prague", SK: "Europe/Bratislava", HU: "Europe/Budapest",
  RO: "Europe/Bucharest", MD: "Europe/Chisinau", BG: "Europe/Sofia", GR: "Europe/Athens", TR: "Europe/Istanbul", HR: "Europe/Zagreb", SI: "Europe/Ljubljana", RS: "Europe/Belgrade",
  SE: "Europe/Stockholm", NO: "Europe/Oslo", DK: "Europe/Copenhagen", FI: "Europe/Helsinki", LT: "Europe/Vilnius", LV: "Europe/Riga", EE: "Europe/Tallinn", UA: "Europe/Kyiv",
  ZA: "Africa/Johannesburg", NG: "Africa/Lagos", KE: "Africa/Nairobi", EG: "Africa/Cairo", MA: "Africa/Casablanca", AE: "Asia/Dubai", SA: "Asia/Riyadh", IL: "Asia/Jerusalem",
  IN: "Asia/Kolkata", PH: "Asia/Manila", ID: "Asia/Jakarta", MY: "Asia/Kuala_Lumpur", SG: "Asia/Singapore", TH: "Asia/Bangkok", VN: "Asia/Ho_Chi_Minh", JP: "Asia/Tokyo", AU: "Australia/Sydney", NZ: "Pacific/Auckland",
};
export const hoyEn = (tz, ms = Date.now()) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(ms));
const sumaDias = (ymd, n) => new Date(Date.parse(ymd + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const minutosLocal = (ms, tz) => { const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms)); const g = k => parseInt(p.find(x => x.type === k).value, 10); return g("hour") * 60 + g("minute"); };
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const aMin = (s, def) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim()); return m ? Math.min(1440, parseInt(m[1]) * 60 + parseInt(m[2])) : def; };
const num = (v, def) => { const n = Number(v); return isFinite(n) ? n : def; };
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const sinTilde = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const comodin = (p) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
const host = (u) => String(u || "").toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/^www\./, "");

// ── Esquema de una regla (JSON estructurado, sin IA) ──
// Una regla = alcance (a qué objetos) + horario + condiciones (métricas en ventanas de tiempo) + acción + límites.
// El motor es determinístico: con los mismos datos da el mismo resultado.
export const ESQUEMA = {
  metricas: ["gasto", "ventas", "revenue", "roas", "cpa", "cpa_ref", "gasto_en_cpa", "presupuesto", "puja", "edad_horas", "subidas_hoy", "bajadas_hoy", "bajadas_total", "acciones_hoy", "acciones_total", "adsets_nuevos_hoy", "hora_local"],
  ventanas: ["hoy_local", "ultimas_h:N", "ultimas_min:N", "desde_ultima_vuelta", "desde_ultima_accion", "ultimos_dias:N"],
  ops: [">=", ">", "<=", "<", "==", "!="],
  acciones: ["presupuesto_pct", "presupuesto_monto", "puja_pct", "puja_monto", "pausar"],
  niveles: ["campana_cbo", "adset_abo", "adset_puja", "campana", "adset"],
  valores_especiales: ["cpa", "front_ticket"],
  multiplicar_por: ["adsets_nuevos_hoy"],
  estrategias: ["LOWEST_COST", "BID_CAP", "COST_CAP", "MIN_ROAS"],
  ejemplo: {
    nombre: "Subida por ROAS", prioridad: 10, activa: true,
    alcance: { cuentas: ["DIG1"], tipo: ["CBO"], excluir_nombre_contiene: ["[MANUAL]"] },
    horario: { zona: "pais_tienda", desde: "06:00", hasta: "21:00", excluir_ventanas_arg: [["03:00", "04:30"]] },
    condiciones: { y: [{ metrica: "roas", ventana: "desde_ultima_accion", op: ">=", valor: 1.9 }, { metrica: "ventas", ventana: "desde_ultima_accion", op: ">=", valor: 2 }] },
    accion: { tipo: "presupuesto_pct", valor: 15, nivel: "campana_cbo" },
    limites: { espera_min_misma_accion: 120, piso: "presupuesto_inicial", max_por_dia: 6, min_edad_horas: 24 },
  },
};
const ESTRAT = { LOWEST_COST: ["LOWEST_COST_WITHOUT_CAP"], BID_CAP: ["LOWEST_COST_WITH_BID_CAP"], COST_CAP: ["COST_CAP"], MIN_ROAS: ["LOWEST_COST_WITH_MIN_ROAS"] };
const esHora = (s) => /^\d{1,2}:\d{2}$/.test(String(s || "")) && aMin(s, null) != null;
const listaStr = (v, campo, err, max = 50) => { if (v == null) return []; if (!Array.isArray(v)) { err.push(`${campo}: tiene que ser una lista`); return []; } return v.map(x => String(x ?? "").trim()).filter(Boolean).slice(0, max); };

// Valida y normaliza. Devuelve {ok, errores, regla}. Con errores, la regla NO se guarda.
export function validarRegla(x) {
  const err = [];
  if (!x || typeof x !== "object" || Array.isArray(x)) return { ok: false, errores: ["la regla tiene que ser un objeto JSON"], regla: null };
  const r = {};
  r.nombre = String(x.nombre || "").trim().slice(0, 80); if (!r.nombre) err.push("nombre: obligatorio");
  r.prioridad = Number.isInteger(x.prioridad) ? x.prioridad : x.prioridad == null ? 100 : (err.push("prioridad: tiene que ser un entero"), 100);
  r.activa = x.activa !== false;
  // Alcance
  const a = x.alcance == null ? {} : x.alcance;
  if (typeof a !== "object" || Array.isArray(a)) err.push("alcance: tiene que ser un objeto");
  r.alcance = {
    cuentas: listaStr(a.cuentas, "alcance.cuentas", err), excluir_cuentas: listaStr(a.excluir_cuentas, "alcance.excluir_cuentas", err),
    paises_tienda: listaStr(a.paises_tienda, "alcance.paises_tienda", err).map(s => s.toUpperCase()),
    tipo: listaStr(a.tipo, "alcance.tipo", err).map(s => s.toUpperCase()), estrategia_puja: listaStr(a.estrategia_puja, "alcance.estrategia_puja", err).map(s => s.toUpperCase()),
    campanas: listaStr(a.campanas, "alcance.campanas", err), nombre_contiene: listaStr(a.nombre_contiene, "alcance.nombre_contiene", err),
    excluir_nombre_contiene: a.excluir_nombre_contiene === undefined ? ["[MANUAL]"] : listaStr(a.excluir_nombre_contiene, "alcance.excluir_nombre_contiene", err),
    pixeles: listaStr(a.pixeles, "alcance.pixeles", err), fanpages: listaStr(a.fanpages, "alcance.fanpages", err), dominios: listaStr(a.dominios, "alcance.dominios", err), links: listaStr(a.links, "alcance.links", err),
  };
  for (const t of r.alcance.tipo) if (!["CBO", "ABO"].includes(t)) err.push(`alcance.tipo: "${t}" no es CBO ni ABO`);
  for (const t of r.alcance.estrategia_puja) if (!ESTRAT[t]) err.push(`alcance.estrategia_puja: "${t}" no es una de ${Object.keys(ESTRAT).join(", ")}`);
  for (const p of r.alcance.paises_tienda) if (!/^[A-Z]{2}$/.test(p)) err.push(`alcance.paises_tienda: "${p}" no es un código ISO de 2 letras`);
  // Horario
  const h = x.horario == null ? {} : x.horario;
  if (typeof h !== "object" || Array.isArray(h)) err.push("horario: tiene que ser un objeto");
  r.horario = { zona: h.zona == null ? "pais_tienda" : String(h.zona), desde: h.desde == null ? "00:00" : String(h.desde), hasta: h.hasta == null ? "24:00" : String(h.hasta), excluir_ventanas_arg: [] };
  if (!["pais_tienda", "cuenta"].includes(r.horario.zona) && !tzValida(r.horario.zona)) err.push(`horario.zona: "${r.horario.zona}" no es pais_tienda, cuenta ni una zona IANA válida`);
  if (!esHora(r.horario.desde)) err.push(`horario.desde: "${r.horario.desde}" no es HH:MM`);
  if (!esHora(r.horario.hasta)) err.push(`horario.hasta: "${r.horario.hasta}" no es HH:MM`);
  if (h.excluir_ventanas_arg != null) {
    if (!Array.isArray(h.excluir_ventanas_arg)) err.push("horario.excluir_ventanas_arg: tiene que ser una lista de [desde, hasta]");
    else for (const v of h.excluir_ventanas_arg) { if (!Array.isArray(v) || v.length !== 2 || !esHora(v[0]) || !esHora(v[1])) err.push(`horario.excluir_ventanas_arg: ${JSON.stringify(v)} no es ["HH:MM","HH:MM"]`); else r.horario.excluir_ventanas_arg.push([String(v[0]), String(v[1])]); }
  }
  // Condiciones
  const hoja = (c, ruta) => {
    const o = {};
    o.metrica = String(c.metrica || ""); if (!ESQUEMA.metricas.includes(o.metrica)) err.push(`${ruta}.metrica: "${o.metrica}" no es una de ${ESQUEMA.metricas.join(", ")}`);
    o.ventana = c.ventana == null ? "hoy_local" : String(c.ventana);
    if (!/^(hoy_local|desde_ultima_vuelta|desde_ultima_accion|ultimas_h:\d+|ultimas_min:\d+|ultimos_dias:\d+)$/.test(o.ventana)) err.push(`${ruta}.ventana: "${o.ventana}" no es una de ${ESQUEMA.ventanas.join(", ")}`);
    o.op = String(c.op || ""); if (!ESQUEMA.ops.includes(o.op)) err.push(`${ruta}.op: "${o.op}" no es uno de ${ESQUEMA.ops.join(" ")}`);
    if (o.metrica === "hora_local" && esHora(c.valor)) o.valor = aMin(c.valor, 0);
    else { o.valor = Number(c.valor); if (!isFinite(o.valor)) err.push(`${ruta}.valor: "${c.valor}" no es un número`); }
    return o;
  };
  const arbol = (c, ruta, prof = 0) => {
    if (!c || typeof c !== "object" || Array.isArray(c)) { err.push(`${ruta}: tiene que ser {y:[…]}, {o:[…]}, {no:…} o {metrica, ventana, op, valor}`); return null; }
    if (prof > 6) { err.push(`${ruta}: demasiado anidado`); return null; }
    for (const k of ["y", "o"]) if (c[k] !== undefined) { if (!Array.isArray(c[k]) || !c[k].length) { err.push(`${ruta}.${k}: tiene que ser una lista con al menos una condición`); return null; } return { [k]: c[k].map((s, i) => arbol(s, `${ruta}.${k}[${i}]`, prof + 1)).filter(Boolean) }; }
    if (c.no !== undefined) return { no: arbol(c.no, `${ruta}.no`, prof + 1) };
    return hoja(c, ruta);
  };
  r.condiciones = x.condiciones == null ? null : arbol(x.condiciones, "condiciones");
  // Acción
  const ac = x.accion;
  if (!ac || typeof ac !== "object") { err.push("accion: obligatoria {tipo, valor, nivel}"); r.accion = { tipo: "", nivel: "" }; }
  else {
    r.accion = { tipo: String(ac.tipo || ""), nivel: String(ac.nivel || ""), valor: ac.valor, multiplicar_por: ac.multiplicar_por == null ? null : String(ac.multiplicar_por) };
    if (!ESQUEMA.acciones.includes(r.accion.tipo)) err.push(`accion.tipo: "${r.accion.tipo}" no es uno de ${ESQUEMA.acciones.join(", ")}`);
    if (!ESQUEMA.niveles.includes(r.accion.nivel)) err.push(`accion.nivel: "${r.accion.nivel}" no es uno de ${ESQUEMA.niveles.join(", ")}`);
    if (r.accion.tipo !== "pausar") {
      if (ESQUEMA.valores_especiales.includes(r.accion.valor)) { if (!r.accion.tipo.endsWith("_monto")) err.push(`accion.valor: "${r.accion.valor}" solo vale con presupuesto_monto o puja_monto`); }
      else { r.accion.valor = Number(ac.valor); if (!isFinite(r.accion.valor) || r.accion.valor === 0) err.push(`accion.valor: "${ac.valor}" no es un número distinto de 0 (ni "cpa" / "front_ticket")`); }
      if (r.accion.tipo.endsWith("_pct") && Math.abs(Number(r.accion.valor)) > 100) err.push("accion.valor: un porcentaje va entre -100 y 100");
    }
    if (r.accion.multiplicar_por && !ESQUEMA.multiplicar_por.includes(r.accion.multiplicar_por)) err.push(`accion.multiplicar_por: "${r.accion.multiplicar_por}" no es uno de ${ESQUEMA.multiplicar_por.join(", ")}`);
    if (r.accion.tipo.startsWith("presupuesto") && !["campana_cbo", "adset_abo"].includes(r.accion.nivel)) err.push("accion.nivel: una acción de presupuesto va en campana_cbo o adset_abo");
    if (r.accion.tipo.startsWith("puja") && r.accion.nivel !== "adset_puja") err.push("accion.nivel: una acción de puja va en adset_puja");
  }
  // Límites
  const l = x.limites == null ? {} : x.limites;
  if (typeof l !== "object" || Array.isArray(l)) err.push("limites: tiene que ser un objeto");
  const ent = (v, campo, def) => { if (v == null) return def; const n = Number(v); if (!isFinite(n) || n < 0) { err.push(`limites.${campo}: "${v}" no es un número ≥ 0`); return def; } return n; };
  r.limites = {
    espera_min_misma_accion: ent(l.espera_min_misma_accion, "espera_min_misma_accion", 0), max_por_dia: ent(l.max_por_dia, "max_por_dia", 0),
    una_vez_por_objeto: !!l.una_vez_por_objeto, min_edad_horas: ent(l.min_edad_horas, "min_edad_horas", 24), tope_pct_dia: ent(l.tope_pct_dia, "tope_pct_dia", 0),
    piso: l.piso === undefined ? "presupuesto_inicial" : l.piso === null ? null : l.piso === "presupuesto_inicial" ? l.piso : (isFinite(Number(l.piso)) ? Number(l.piso) : (err.push(`limites.piso: "${l.piso}" no es "presupuesto_inicial", un monto en USD ni null`), "presupuesto_inicial")),
    congelar_si: l.congelar_si == null ? null : hoja(l.congelar_si, "limites.congelar_si"),
  };
  return { ok: !err.length, errores: err, regla: err.length ? null : r };
}

// Texto legible de una regla (lo que muestra la pantalla y el MCP).
const VENT_TXT = (v) => v === "hoy_local" ? "hoy (hora local)" : v === "desde_ultima_vuelta" ? "últimos 15 min" : v === "desde_ultima_accion" ? "desde la última acción de esta regla" : v.startsWith("ultimas_h:") ? `últimas ${v.slice(10)} h` : v.startsWith("ultimas_min:") ? `últimos ${v.slice(12)} min` : v.startsWith("ultimos_dias:") ? `últimos ${v.slice(13)} días` : v;
const NIVEL_TXT = { campana_cbo: "campaña CBO", adset_abo: "conjunto ABO", adset_puja: "conjunto con bid/cost cap", campana: "campaña", adset: "conjunto" };
const condTxt = (c) => !c ? "siempre" : c.y ? c.y.map(s => s.o ? `(${condTxt(s)})` : condTxt(s)).join(" Y ") : c.o ? c.o.map(s => s.y ? `(${condTxt(s)})` : condTxt(s)).join(" O ") : c.no ? `NO (${condTxt(c.no)})` : `${c.metrica} (${VENT_TXT(c.ventana)}) ${c.op} ${c.metrica === "hora_local" ? hhmm(c.valor) : c.valor}`;
export function textoRegla(r) {
  const a = r.alcance || {}, al = [];
  if (a.cuentas?.length) al.push(`cuentas ${a.cuentas.join(", ")}`); if (a.excluir_cuentas?.length) al.push(`nunca en ${a.excluir_cuentas.join(", ")}`);
  if (a.paises_tienda?.length) al.push(`país de la tienda ${a.paises_tienda.join(", ")}`); if (a.tipo?.length) al.push(a.tipo.join(" o ")); if (a.estrategia_puja?.length) al.push(`puja ${a.estrategia_puja.join(" o ")}`);
  if (a.campanas?.length) al.push(`campañas ${a.campanas.join(", ")}`); if (a.nombre_contiene?.length) al.push(`nombre contiene ${a.nombre_contiene.join(" o ")}`); if (a.excluir_nombre_contiene?.length) al.push(`sin ${a.excluir_nombre_contiene.join(" ni ")} en el nombre`);
  if (a.pixeles?.length) al.push(`píxel ${a.pixeles.join(", ")}`); if (a.fanpages?.length) al.push(`fanpage ${a.fanpages.join(", ")}`); if (a.dominios?.length) al.push(`dominio ${a.dominios.join(", ")}`); if (a.links?.length) al.push(`link ${a.links.join(", ")}`);
  const h = r.horario || {}, zona = h.zona === "pais_tienda" ? "hora del país de la tienda" : h.zona === "cuenta" ? "hora de la cuenta publicitaria" : h.zona;
  const hor = `${h.desde || "00:00"}–${h.hasta || "24:00"} (${zona})${h.excluir_ventanas_arg?.length ? `, salvo ${h.excluir_ventanas_arg.map(v => `${v[0]}–${v[1]} hora Argentina`).join(" y ")}` : ""}`;
  const ac = r.accion || {}, v = ac.valor;
  const vt = v === "cpa" ? "1 CPA de referencia" : v === "front_ticket" ? "el ticket del producto principal" : typeof v === "number" ? `${v > 0 ? "+" : ""}${v}${ac.tipo.endsWith("_pct") ? " %" : " USD"}` : "";
  const acc = ac.tipo === "pausar" ? "pausar" : `${ac.tipo.startsWith("puja") ? "tope de puja" : "presupuesto"} ${vt}${ac.multiplicar_por ? ` por cada ${ac.multiplicar_por.replace(/_/g, " ")}` : ""}`;
  const l = r.limites || {}, lim = [];
  if (l.espera_min_misma_accion) lim.push(`esperar ${l.espera_min_misma_accion} min entre acciones`); if (l.max_por_dia) lim.push(`máximo ${l.max_por_dia} por día`); if (l.una_vez_por_objeto) lim.push("una sola vez por campaña/conjunto");
  if (ac.tipo?.startsWith("presupuesto")) lim.push(l.piso === "presupuesto_inicial" ? "nunca debajo del presupuesto inicial (o del último puesto a mano)" : l.piso == null ? "sin piso" : `piso ${l.piso} USD`);
  if (l.tope_pct_dia) lim.push(`tope +${l.tope_pct_dia} % sobre el piso`); if (l.min_edad_horas) lim.push(`solo con ≥ ${l.min_edad_horas} h desde que arrancó`); if (l.congelar_si) lim.push(`se congela el resto del día si ${condTxt(l.congelar_si)}`);
  return `[prioridad ${r.prioridad}] ${r.nombre}${r.activa === false ? " (PAUSADA)" : ""} · Aplica en: ${al.length ? al.join("; ") : "todas las campañas"} · Nivel: ${NIVEL_TXT[ac.nivel] || ac.nivel} · Horario: ${hor} · SI ${condTxt(r.condiciones)} → ${acc}${lim.length ? ` · Límites: ${lim.join("; ")}` : ""}`;
}
export const LOGICA_MOTOR = [
  "Corre en Growith cada 15 min exactos (:00 :15 :30 :45). Es código determinístico, sin IA: mismos datos → mismo resultado.",
  "Primero lee TODO: cuentas publicitarias, campañas y conjuntos ACTIVOS, gasto por hora (2 días) y por día (8 días) de Meta, anuncios (fanpage, link, creativo) si alguna regla los usa, y las ventas reales de Impultienda (8 días) cruzadas por UTM. Si cualquier lectura o token falla, la vuelta no actúa.",
  "Objetos: cada campaña (CBO si tiene presupuesto propio) y cada conjunto (ABO si tiene presupuesto propio; 'con puja' si tiene bid cap o cost cap). Las métricas de una campaña suman sus conjuntos.",
  "Zona horaria 'pais_tienda': la del país de la tienda donde vende la campaña (la tienda a la que lleva su link, por las ventas reales); antes de la primera venta, el código de país del nombre; si no, la zona de la cuenta. 'hoy_local' empieza a las 00:00 de esa zona.",
  "Cambios manuales: si el presupuesto (o el tope de puja) difiere del último que puso Growith, el nuevo valor pasa a ser el punto de partida y el piso. Lo pausado a mano no se reactiva (solo se leen objetos activos).",
  "Para cada objeto se prueban las reglas por prioridad (menor primero). Una regla aplica si: el objeto está en su alcance y nivel; no tiene un texto excluido en el nombre; tiene la edad mínima; es su horario (y no una ventana excluida); no está congelada ni agotada (una vez por objeto, máximo por día, espera entre acciones); y sus condiciones dan verdadero. Una métrica sin datos (p. ej. ROAS sin gasto) hace falsa la condición.",
  "La primera regla que aplica ejecuta su acción y ese objeto no recibe otra en la misma vuelta. Presupuesto: nunca debajo del piso ni arriba del tope diario; si el límite deja el valor igual, no hay acción. 'cpa' = CPA de referencia de la campaña (5 días con 3+ ventas; si no, el promedio de todas); 'front_ticket' = mediana del ticket del producto principal.",
  "Aplica en Meta (o solo registra, en simulación) y guarda cada acción con la regla, las métricas usadas, el cálculo, antes/después, hora local y zona.",
];

async function metaGet(path, params, tok) {
  const u = new URL(`https://graph.facebook.com/${META_V}/${path}`);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
  u.searchParams.set("access_token", tok);
  const j = await (await fetch(u.toString(), { signal: AbortSignal.timeout(25000) })).json().catch(() => ({}));
  if (j.error) throw new Error(j.error.error_user_msg || j.error.message);
  return j;
}
async function metaTodo(path, params, tok, max = 20) {
  let j = await metaGet(path, params, tok); const out = [...(j.data || [])];
  for (let i = 0; j.paging?.next && i < max; i++) {
    j = await (await fetch(j.paging.next, { signal: AbortSignal.timeout(25000) })).json();
    if (j.error) throw new Error(j.error.message);
    out.push(...(j.data || []));
  }
  return out;
}
async function metaPost(id, body, tok) {
  const r = await fetch(`https://graph.facebook.com/${META_V}/${id}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...body, access_token: tok }).toString(), signal: AbortSignal.timeout(25000) });
  const j = await r.json().catch(() => ({}));
  if (j.error) throw new Error(j.error.error_user_msg || j.error.message);
  return j;
}
async function tieneEdicion(db, uid, a) {
  const p = a.permiso_edicion;
  if (p && Date.now() - (p.ts || 0) < 6 * 3600000) return !!p.ok;
  let ok = false;
  try { ok = (await metaGet("me/permissions", {}, a.access_token)).data?.some(x => x.permission === "ads_management" && x.status === "granted") || false; } catch (_) { return !!p?.ok; }
  db.collection("users").doc(uid).collection("meta_accounts").doc(String(a.id)).set({ permiso_edicion: { ok, ts: Date.now() } }, { merge: true }).catch(() => {});
  return ok;
}

// Cuentas publicitarias a recorrer (las elegidas en Growith, o la de cada conexión) con un
// token que las ve y, para escribir, uno con ads_management que también las vea.
async function cuentasDe(db, uid, elegidas) {
  const snap = await db.collection("users").doc(uid).collection("meta_accounts").get();
  const vistos = new Set();
  const tokens = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(a => a.access_token && !a.demo && !vistos.has(a.access_token) && vistos.add(a.access_token));
  const cuentas = {}; const errores = [];
  for (const t of tokens) {
    const edita = await tieneEdicion(db, uid, t);
    let lista = [];
    try { lista = (await metaTodo("me/adaccounts", { fields: "account_id,name,currency,timezone_name", limit: "200" }, t.access_token, 3)).map(c => ({ id: "act_" + c.account_id, nombre: c.name, moneda: c.currency, tz: c.timezone_name })); }
    catch (e) { errores.push(`${t.user_name || t.id}: ${e.message}`); continue; }
    for (const c of lista) {
      if (elegidas.length ? !elegidas.includes(c.id) : c.id !== t.ad_account_id) continue;
      const x = cuentas[c.id] || (cuentas[c.id] = { ...c, tokLee: t.access_token, tokEdita: null });
      if (edita && !x.tokEdita) x.tokEdita = t.access_token;
    }
  }
  return { cuentas: Object.values(cuentas), errores };
}

// ── Ventas reales de los últimos días, una por una (para cualquier ventana) ──
async function ventasRecientes(db, uid, cfg, dias) {
  const desdeMs = Date.now() - dias * 86400000;
  let idx = await leerIndiceUtm(db, uid);
  if (!idx || Date.now() - (idx.ts0 || idx.ts || 0) > 3 * 3600000) { idx = await construirIndiceUtm(db, uid, Math.max(60, idx?.dias || 0)); await db.collection("users").doc(uid).collection("impultienda_cfg").doc("utm_idx").set({ ts0: idx.ts }, { merge: true }).catch(() => {}); }
  else if (Date.now() - (idx.ts || 0) > 5 * 60000) idx = await construirIndiceUtm(db, uid, 2, idx);
  const snap = await db.collection("users").doc(uid).collection("impultienda_orders").where("actualizado", ">=", new Date(desdeMs - 2 * 86400000).toISOString()).get();
  const todas = snap.docs.map(d => d.data());
  const delWebhook = new Set(todas.filter(o => !o.importado && o.orden != null).map(o => String(o.orden)));
  const ordenes = todas.filter(o => !o.importado || !delWebhook.has(String(o.orden)));
  const tiendas = armarTiendas(cfg, ordenes);
  const fx = await fxPorUsd();
  const atr = {};
  for (const o of ordenes) if (!o.post_compra) atr[o.order_id] = atribuirUtm(o.utm, idx);
  const ventas = [];
  let ultima = null;
  for (const o of ordenes) {
    const t = Date.parse(o.ev_approved || "");
    if (!isFinite(t) || t < desdeMs) continue;
    if (!ultima || t > ultima) ultima = t;
    const x = o.post_compra ? (atr[o.orden_original] || atribuirUtm(o.utm, idx)) : atr[o.order_id];
    const it = o.post_compra ? null : ((o.items || []).find(i => !/bump|upsell|downsell/i.test(String(i.tipo || ""))) || (o.items || [])[0]);
    ventas.push({ t, usd: aUsd(Number(o.total) || 0, o.moneda, fx) ?? 0, n: o.post_compra ? 0 : 1, c: x?.c || null, s: x?.s || null, tienda: o.store_id || null, pais: paisDeUtm(o.utm) || null,
      tk: it ? aUsd((Number(it.precio) || 0) * (Number(it.cant) || 1), o.moneda, fx) : null });
  }
  return { ventas, tiendas, ultima, fx };
}

export async function esDigital(db, uid) {
  const u = (await db.collection("users").doc(uid).get()).data() || {};
  return (u.stores || []).some(s => s?.type === "impultienda");
}

// ── El motor ──


// ── Reglas guardadas ──
export async function leerReglas(db, uid) {
  const snap = await db.collection("users").doc(uid).collection("meta_escala_reglas").get();
  return snap.docs.map(d => ({ id: d.id, ...(d.data().regla || {}), texto_original: d.data().texto_original || null, version: d.data().version || 1, creada_por: d.data().creada_por || null, creada: d.data().creada || null, actualizada: d.data().actualizada || null }))
    .filter(r => r.nombre && r.accion).sort((a, b) => a.prioridad - b.prioridad || a.nombre.localeCompare(b.nombre));
}
// Índice del cron: la tienda corre si está activa y tiene al menos una regla activa.
export async function actualizarIndice(db, uid) {
  const cfg = (await db.collection("users").doc(uid).collection("meta_escala").doc("cfg").get()).data() || {};
  const reglas = await leerReglas(db, uid);
  const corre = cfg.activo !== false && reglas.some(r => r.activa !== false);
  await db.collection("system").doc("meta_escala").set({ uids: { [uid]: corre } }, { merge: true });
  return corre;
}

// ── El motor ──
// prueba: simula y no guarda nada (ni estado, ni registro, ni vuelta): devuelve lo que haría y por qué.
// reglasOverride: evaluar solo estas reglas (reglas_simular).
export async function correrReglas(db, uid, { ahora = Date.now(), forzar = false, prueba = false, reglasOverride = null } = {}) {
  const uRef = db.collection("users").doc(uid);
  const cfgDoc = (await uRef.collection("meta_escala").doc("cfg").get()).data() || {};
  const vueltaId = new Date(ahora).toISOString().slice(0, 16);
  const vRef = uRef.collection("meta_escala_vueltas").doc(vueltaId);
  const simular = prueba || !!cfgDoc.simular;
  const vuelta = { ts: new Date(ahora).toISOString(), simular, evaluadas: 0, cambios: 0, errores: [], saltada: null };
  const cerrar = async () => { vuelta.evaluadas = (vuelta.campanas || []).length; if (!prueba) await vRef.set(vuelta).catch(() => {}); return vuelta; };
  if (cfgDoc.activo === false && !forzar) { vuelta.saltada = "reglas apagadas"; return vuelta; }
  const reglas = (reglasOverride || await leerReglas(db, uid)).filter(r => r.activa !== false);
  if (!reglas.length) { vuelta.saltada = "sin reglas activas"; return cerrar(); }
  // Solo tiendas de productos digitales: sin Impultienda no hay ventas reales y bajaría todo.
  if (!(await esDigital(db, uid))) { vuelta.saltada = "la tienda no es de productos digitales (Impultienda)"; return cerrar(); }
  const impCfg = (await uRef.collection("impultienda_cfg").doc("main").get()).data() || {};
  const { cuentas, errores } = await cuentasDe(db, uid, impCfg.metaCuentas || []);
  vuelta.errores.push(...errores);
  if (!cuentas.length) vuelta.errores.push("No hay cuentas publicitarias de Meta para recorrer.");
  const sinEdicion = cuentas.filter(c => !c.tokEdita).map(c => c.nombre);
  if (sinEdicion.length && !simular) vuelta.errores.push(`Sin token con ads_management para: ${sinEdicion.join(", ")}`);

  // 1) Leer TODO antes de decidir nada.
  let V;
  try { V = await ventasRecientes(db, uid, impCfg, 8); } catch (e) { vuelta.errores.push(`Ventas de Impultienda: ${e.message}`); }
  const datos = [];
  const usaAnuncios = (r) => r.alcance.fanpages.length || r.alcance.dominios.length || r.alcance.links.length;
  const conAnuncios = reglas.some(usaAnuncios);
  await Promise.all(cuentas.map(async c => {
    const tzC = c.tz || "America/Los_Angeles", hoyC = hoyEn(tzC, ahora);
    const activo = JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]);
    try {
      const [camps, sets, horas, dias] = await Promise.all([
        metaTodo(`${c.id}/campaigns`, { fields: "id,name,effective_status,daily_budget,lifetime_budget,bid_strategy,start_time,created_time", filtering: activo, limit: "200" }, c.tokLee, 10),
        metaTodo(`${c.id}/adsets`, { fields: "id,name,campaign_id,effective_status,daily_budget,lifetime_budget,bid_strategy,bid_amount,start_time,created_time,promoted_object", filtering: activo, limit: "300" }, c.tokLee, 10),
        metaTodo(`${c.id}/insights`, { level: "adset", fields: "adset_id,campaign_id,spend", time_increment: "1", breakdowns: "hourly_stats_aggregated_by_advertiser_time_zone", time_range: JSON.stringify({ since: sumaDias(hoyC, -1), until: hoyC }), limit: "500" }, c.tokLee, 40),
        metaTodo(`${c.id}/insights`, { level: "adset", fields: "adset_id,campaign_id,spend", time_increment: "1", time_range: JSON.stringify({ since: sumaDias(hoyC, -7), until: hoyC }), limit: "500" }, c.tokLee, 25),
      ]);
      // Anuncios (fanpage, link, video/imagen) solo si alguna regla los usa. Incluye los pausados,
      // para saber qué creativos ya corrieron en cada campaña.
      const ads = [];
      if (conAnuncios && camps.length) for (let i = 0; i < camps.length; i += 50) {
        ads.push(...await metaTodo(`${c.id}/ads`, { fields: "id,adset_id,campaign_id,effective_status,creative{id,actor_id,object_story_spec,asset_feed_spec,effective_object_story_id,object_url,link_url}",
          filtering: JSON.stringify([{ field: "campaign.id", operator: "IN", value: camps.slice(i, i + 50).map(x => x.id) }]), limit: "200" }, c.tokLee, 15));
      }
      datos.push({ c, tzC, hoyC, camps, sets, horas, dias, ads });
    } catch (e) { vuelta.errores.push(`${c.nombre}: ${e.message}`); }
  }));
  if (vuelta.errores.length || !V) { vuelta.saltada = "errores de lectura: esta vuelta no tocó nada"; return cerrar(); }

  // 2) Gasto (USD) por conjunto: horas [inicio, usd] de hoy/ayer + días; lo que Meta aún no
  // repartió por hora va a la media hora más reciente.
  const gH = {}, gD = {}, campDeSet = {};
  for (const d of datos) {
    const fxk = (v) => aUsd(parseFloat(v) || 0, d.c.moneda, V.fx) ?? 0;
    const hoyPorSet = {};
    for (const x of d.horas) {
      const hh = parseInt(String(x.hourly_stats_aggregated_by_advertiser_time_zone || "").slice(0, 2), 10);
      if (!isFinite(hh)) continue;
      const u = fxk(x.spend); campDeSet[x.adset_id] = x.campaign_id;
      (gH[x.adset_id] = gH[x.adset_id] || []).push([utcDeLocal(x.date_start, hh, d.tzC), u]);
      if (x.date_start === d.hoyC) hoyPorSet[x.adset_id] = (hoyPorSet[x.adset_id] || 0) + u;
    }
    for (const x of d.dias) {
      const u = fxk(x.spend); campDeSet[x.adset_id] = x.campaign_id;
      (gD[x.adset_id] = gD[x.adset_id] || []).push([utcDeLocal(x.date_start, 0, d.tzC), u]);
      if (x.date_start === d.hoyC) { const falta = u - (hoyPorSet[x.adset_id] || 0); if (falta > 0.01) (gH[x.adset_id] = gH[x.adset_id] || []).push([ahora - 30 * 60000, falta]); }
    }
  }
  const setsDeCamp = {};
  for (const d of datos) for (const s of d.sets) (setsDeCamp[s.campaign_id] = setsDeCamp[s.campaign_id] || []).push(s.id);
  for (const [s, c] of Object.entries(campDeSet)) { const l = setsDeCamp[c] || (setsDeCamp[c] = []); if (!l.includes(s)) l.push(s); }
  // Métricas de un nodo en una ventana [desde, ahora]. Gasto por hora: entra la hora que termina después de `desde`.
  const met = (nivel, id, desde, porDia = false) => {
    const sets = nivel === "c" ? (setsDeCamp[id] || []) : [id];
    let gasto = 0;
    for (const s of sets) for (const [t, u] of (porDia ? gD[s] : gH[s]) || []) if (t + (porDia ? 86400000 : 3600000) > desde && t <= ahora) gasto += u;
    let n = 0, rev = 0;
    for (const v of V.ventas) if (v[nivel] === id && v.t >= desde && v.t <= ahora) { n += v.n; rev += v.usd; }
    return { gasto: r2(gasto), ventas: n, rev: r2(rev), roas: gasto > 0 ? r2(rev / gasto) : null };
  };
  // Anuncios por conjunto: fanpages, links, dominios y medios (video/imagen/post) para el alcance y los adsets nuevos.
  const AD = {}, mediosDeCamp = {};
  const infoDe = (id) => AD[id] || (AD[id] = { fanpage: new Set(), link: new Set(), dominio: new Set(), medios: new Set() });
  for (const d of datos) for (const ad of d.ads) {
    const cr = ad.creative || {}, o = cr.object_story_spec || {}, af = cr.asset_feed_spec || {}, x = infoDe(ad.adset_id);
    const pg = cr.actor_id || o.page_id; if (pg) x.fanpage.add(String(pg));
    const links = [o.link_data?.link, o.link_data?.call_to_action?.value?.link, o.video_data?.call_to_action?.value?.link, o.template_data?.link, cr.link_url, cr.object_url, ...(af.link_urls || []).map(l => l?.website_url)].filter(Boolean);
    for (const l of links) { x.link.add(String(l)); const hh = host(l); if (hh) x.dominio.add(hh); }
    const med = [o.video_data?.video_id && `v:${o.video_data.video_id}`, o.link_data?.image_hash && `i:${o.link_data.image_hash}`, o.photo_data?.image_hash && `i:${o.photo_data.image_hash}`,
      ...(o.link_data?.child_attachments || []).flatMap(c => [c.video_id && `v:${c.video_id}`, c.image_hash && `i:${c.image_hash}`]),
      ...(af.videos || []).map(v => v?.video_id && `v:${v.video_id}`), ...(af.images || []).map(v => v?.hash && `i:${v.hash}`)].filter(Boolean);
    if (!med.length && cr.effective_object_story_id) med.push(`p:${cr.effective_object_story_id}`);
    const mc = mediosDeCamp[ad.campaign_id] || (mediosDeCamp[ad.campaign_id] = {});
    for (const m of med) { x.medios.add(m); (mc[m] = mc[m] || new Set()).add(ad.adset_id); }
  }
  const nombrePagina = {};
  if (reglas.some(r => r.alcance.fanpages.length)) {
    const ids = [...new Set(Object.values(AD).flatMap(x => [...x.fanpage]))], tok = datos[0]?.c.tokLee;
    for (let i = 0; tok && i < ids.length; i += 50) { try { const j = await metaGet("", { ids: ids.slice(i, i + 50).join(","), fields: "name" }, tok); for (const [k, v] of Object.entries(j)) if (v?.name) nombrePagina[k] = v.name; } catch (_) {} }
  }
  // Ticket del producto principal (por si una campaña no tiene ventas): mediana de los últimos días.
  const tks = V.ventas.map(v => v.tk).filter(v => v > 0).sort((a, b) => a - b);
  const ticketPrincipal = tks.length ? tks[Math.floor(tks.length / 2)] : null;
  // CPA de referencia.
  let gTot = 0, nTot = 0;
  for (const l of Object.values(gD)) for (const [, u] of l) gTot += u;
  for (const v of V.ventas) if (v.c) nTot += v.n;
  const cpaGlobal = nTot ? gTot / nTot : null;
  const cpaDe = (campId) => { const m = met("c", campId, ahora - 5 * 86400000, true); return m.ventas >= 3 ? m.gasto / m.ventas : cpaGlobal; };
  // País (zona) de cada campaña: la tienda donde más vende, o el código del nombre.
  const tiendaTop = {};
  for (const v of V.ventas) if (v.c && v.tienda) { const m = tiendaTop[v.c] || (tiendaTop[v.c] = {}); m[v.tienda] = (m[v.tienda] || 0) + 1; }
  const zonaCamp = (camp, tzC) => {
    const top = Object.entries(tiendaTop[camp.id] || {}).sort((a, b) => b[1] - a[1])[0];
    const p = top && String(V.tiendas[top[0]]?.pais || "").toUpperCase().split(/[^A-Z]+/)[0];
    if (p && PAIS_TZ[p]) return { tz: PAIS_TZ[p], pais: p };
    const cod = String(camp.name || "").toUpperCase().split(/[^A-Z]+/).find(w => w.length === 2 && PAIS_TZ[w]);
    return cod ? { tz: PAIS_TZ[cod], pais: cod } : { tz: tzC, pais: null };
  };


  // 3) Estado y decisiones (determinístico).
  const estSnap = await uRef.collection("meta_escala_estado").get();
  const EST = Object.fromEntries(estSnap.docs.map(d => [d.id, d.data()]));
  const sucios = new Set();
  const acciones = [], evaluaciones = [];
  const nuevo = (id) => EST[id] || (EST[id] = {});
  const ordenadas = reglas.filter(r => r.activa !== false).sort((a, b) => a.prioridad - b.prioridad || a.nombre.localeCompare(b.nombre));
  const enVentana = (m, desde, hasta) => desde <= hasta ? (m >= desde && m < hasta) : (m >= desde || m < hasta);
  const comp = (a, op, b) => a == null || b == null ? false : op === ">=" ? a >= b : op === ">" ? a > b : op === "<=" ? a <= b : op === "<" ? a < b : op === "==" ? Math.abs(a - b) < 1e-9 : Math.abs(a - b) >= 1e-9;
  const estrategiaDe = (n) => Object.keys(ESTRAT).find(k => ESTRAT[k].includes(n?.bid_strategy)) || null;

  for (const d of datos) {
    const setsPorId = Object.fromEntries(d.sets.map(s => [s.id, s]));
    const kUsd = String(d.c.moneda || "USD").toUpperCase() === "USD" ? 1 : Number(V.fx?.[String(d.c.moneda).toUpperCase()]) || null;
    for (const camp of d.camps) {
      const { tz: tzTienda, pais } = zonaCamp(camp, d.tzC);
      const esCBO = parseInt(camp.daily_budget) > 0;
      const todosSets = (setsDeCamp[camp.id] || []).map(id => setsPorId[id]).filter(Boolean);
      const infoSets = (lista) => { const f = new Set(), lk = new Set(), dm = new Set(), px = new Set(); for (const s of lista) { if (s.promoted_object?.pixel_id) px.add(String(s.promoted_object.pixel_id)); const x = AD[s.id]; if (!x) continue; for (const v of x.fanpage) { f.add(v); if (nombrePagina[v]) f.add(nombrePagina[v]); } for (const v of x.link) lk.add(v); for (const v of x.dominio) dm.add(v); } return { fanpage: [...f], link: [...lk], dominio: [...dm], pixel: [...px] }; };
      if (!(vuelta.campanas = vuelta.campanas || []).some(x => x.id === camp.id) && vuelta.campanas.length < 150) vuelta.campanas.push({ id: camp.id, nombre: camp.name, cuenta: d.c.nombre });
      // Objetos: la campaña y cada uno de sus conjuntos.
      const objetos = [{ nodo: camp, tipo: "campaign", sets: todosSets, budget: esCBO ? parseInt(camp.daily_budget) : null, cap: null }];
      for (const s of todosSets) objetos.push({ nodo: s, tipo: "adset", sets: [s], budget: !esCBO && parseInt(s.daily_budget) > 0 ? parseInt(s.daily_budget) : null, cap: CAPS.includes(s.bid_strategy) && parseInt(s.bid_amount) > 0 ? parseInt(s.bid_amount) : null });
      for (const o of objetos) {
        const n = o.nodo, st = nuevo(n.id), fecha = hoyEn(tzTienda, ahora), iniDia = utcDeLocal(fecha, 0, tzTienda);
        const nivelesObj = o.tipo === "campaign" ? ["campana", ...(esCBO ? ["campana_cbo"] : [])] : ["adset", ...(o.budget ? ["adset_abo"] : []), ...(o.cap ? ["adset_puja"] : [])];
        if (st.fecha !== fecha) { Object.assign(st, { fecha, subidas: 0, bajadas: 0 }); sucios.add(n.id); }
        // Punto de partida y piso; un cambio a mano los reemplaza.
        if (o.budget != null) {
          if (st.piso == null) { st.piso = o.budget; st.puesto = o.budget; sucios.add(n.id); }
          if (st.puesto != null && Math.abs(o.budget - st.puesto) > 1) { acciones.push({ cuenta: d.c.nombre, cuenta_id: d.c.id, campana: camp.name, campana_id: camp.id, tz: tzTienda, hora_local: hhmm(minutosLocal(ahora, tzTienda)), nivel: o.tipo, id: n.id, nombre: n.name, accion: "manual", antes: st.puesto, despues: o.budget, regla: "Cambio manual de presupuesto: pasa a ser el nuevo punto de partida y piso", datos: {}, soloRegistro: true, enMoneda: true }); st.piso = o.budget; st.puesto = o.budget; sucios.add(n.id); }
        }
        if (o.cap != null) {
          if (st.pujaPuesta == null) { st.pujaPuesta = o.cap; sucios.add(n.id); }
          else if (Math.abs(o.cap - st.pujaPuesta) > 1) { acciones.push({ cuenta: d.c.nombre, cuenta_id: d.c.id, campana: camp.name, campana_id: camp.id, tz: tzTienda, hora_local: hhmm(minutosLocal(ahora, tzTienda)), nivel: o.tipo, id: n.id, nombre: n.name, accion: "manual", antes: st.pujaPuesta, despues: o.cap, regla: "Cambio manual del tope de puja: pasa a ser el nuevo punto de partida", datos: {}, soloRegistro: true, enMoneda: true }); st.pujaPuesta = o.cap; sucios.add(n.id); }
        }
        const edadH = (ahora - Math.max(Date.parse(n.start_time || "") || 0, Date.parse(n.created_time || "") || 0)) / 3600000;
        const cpaRef = cpaDe(camp.id);
        const info = infoSets(o.sets);
        const nombres = [n.name, camp.name].map(s => String(s || "").toUpperCase());
        const porRegla = (rid) => (st.porRegla = st.porRegla || {})[rid] || (st.porRegla[rid] = {});
        // Conjuntos que arrancaron hoy (hora local) y ya pasaron su inicio, todavía no contados por una regla.
        const nuevosHoy = (rid) => o.tipo !== "campaign" ? 0 : o.sets.filter(s => { const ini = Date.parse(s.start_time || s.created_time || ""); return isFinite(ini) && ini <= ahora && hoyEn(tzTienda, ini) === fecha && !(porRegla(rid).contados || {})[s.id]; }).length;
        const metrica = (m, ventana, r) => {
          const pr = porRegla(r.id);
          let desde = iniDia, porDia = false;
          if (ventana === "desde_ultima_vuelta") desde = ahora - 15 * 60000;
          else if (ventana === "desde_ultima_accion") desde = pr.ult || iniDia;
          else if (ventana.startsWith("ultimas_h:")) desde = ahora - parseInt(ventana.slice(10)) * 3600000;
          else if (ventana.startsWith("ultimas_min:")) desde = ahora - parseInt(ventana.slice(12)) * 60000;
          else if (ventana.startsWith("ultimos_dias:")) { desde = ahora - parseInt(ventana.slice(13)) * 86400000; porDia = true; }
          const b = met(o.tipo === "campaign" ? "c" : "s", n.id, desde, porDia);
          switch (m) {
            case "gasto": return b.gasto; case "ventas": return b.ventas; case "revenue": return b.rev; case "roas": return b.roas;
            case "cpa": return b.ventas ? r2(b.gasto / b.ventas) : null; case "cpa_ref": return cpaRef != null ? r2(cpaRef) : null; case "gasto_en_cpa": return cpaRef ? r2(b.gasto / cpaRef) : null;
            case "presupuesto": return o.budget != null && kUsd ? r2(o.budget / 100 / kUsd) : null; case "puja": return o.cap != null && kUsd ? r2(o.cap / 100 / kUsd) : null;
            case "edad_horas": return r2(edadH); case "subidas_hoy": return st.subidas || 0; case "bajadas_hoy": return st.bajadas || 0; case "bajadas_total": return st.bajadasTotal || 0;
            case "acciones_hoy": return pr.hoy?.fecha === fecha ? pr.hoy.n || 0 : 0; case "acciones_total": return pr.total || 0;
            case "adsets_nuevos_hoy": return nuevosHoy(r.id); case "hora_local": return minutosLocal(ahora, tzTienda);
            default: return null;
          }
        };
        const evalCond = (c, r, entradas) => {
          if (!c) return true;
          if (c.y) return c.y.every(s => evalCond(s, r, entradas));
          if (c.o) return c.o.some(s => evalCond(s, r, entradas));
          if (c.no) return !evalCond(c.no, r, entradas);
          const actual = metrica(c.metrica, c.ventana, r), ok = comp(actual, c.op, c.valor);
          entradas.push({ metrica: c.metrica, ventana: c.ventana, valor_actual: actual, op: c.op, valor: c.valor, cumple: ok });
          return ok;
        };
        for (const r of ordenadas) {
          const a = r.alcance, ev = { regla_id: r.id, regla: r.nombre, objeto: `${o.tipo === "campaign" ? "Campaña" : "Conjunto"} ${n.name}`, id: n.id, cuenta: d.c.nombre };
          const salta = (motivo) => { if (evaluaciones.length < 400) evaluaciones.push({ ...ev, aplica: false, motivo }); };
          // Alcance y nivel.
          if (!nivelesObj.includes(r.accion.nivel)) { salta(`nivel ${r.accion.nivel}: no es este objeto`); continue; }
          const cuentaOk = (lista) => lista.some(x => [d.c.id, d.c.id.replace(/^act_/, ""), d.c.nombre].some(v => sinTilde(v) === sinTilde(x)));
          if (a.cuentas.length && !cuentaOk(a.cuentas)) { salta("fuera de alcance: cuenta"); continue; }
          if (a.excluir_cuentas.length && cuentaOk(a.excluir_cuentas)) { salta("fuera de alcance: cuenta excluida"); continue; }
          if (a.paises_tienda.length && !a.paises_tienda.includes(pais)) { salta(`fuera de alcance: país de la tienda (${pais || "desconocido"})`); continue; }
          if (a.tipo.length && !a.tipo.includes(esCBO ? "CBO" : "ABO")) { salta(`fuera de alcance: es ${esCBO ? "CBO" : "ABO"}`); continue; }
          if (a.estrategia_puja.length && !a.estrategia_puja.includes(estrategiaDe(o.tipo === "campaign" ? camp : n) || estrategiaDe(camp))) { salta("fuera de alcance: estrategia de puja"); continue; }
          if (a.campanas.length && !a.campanas.some(x => x === camp.id || sinTilde(x) === sinTilde(camp.name))) { salta("fuera de alcance: campaña"); continue; }
          if (a.nombre_contiene.length && !a.nombre_contiene.some(x => nombres.some(nm => nm.includes(x.toUpperCase())))) { salta("fuera de alcance: nombre"); continue; }
          if (a.excluir_nombre_contiene.length && a.excluir_nombre_contiene.some(x => nombres.some(nm => nm.includes(x.toUpperCase())))) { salta("excluida por el nombre"); continue; }
          if (a.pixeles.length && !a.pixeles.some(x => info.pixel.includes(x))) { salta("fuera de alcance: píxel"); continue; }
          if (a.fanpages.length && !a.fanpages.some(x => info.fanpage.some(v => sinTilde(v) === sinTilde(x)))) { salta("fuera de alcance: fanpage"); continue; }
          if (a.dominios.length && !a.dominios.some(x => { const re = comodin(x.toLowerCase().replace(/^www\./, "")); return info.dominio.some(v => re.test(v) || (x.startsWith("*.") && v === x.slice(2))); })) { salta("fuera de alcance: dominio"); continue; }
          if (a.links.length && !a.links.some(x => { const re = comodin(x); return info.link.some(v => re.test(v)); })) { salta("fuera de alcance: link"); continue; }
          // Edad, horario y ventanas excluidas.
          if (r.limites.min_edad_horas && edadH < r.limites.min_edad_horas) { salta(`arrancó hace ${r2(edadH)} h (< ${r.limites.min_edad_horas})`); continue; }
          const tzR = r.horario.zona === "pais_tienda" ? tzTienda : r.horario.zona === "cuenta" ? d.tzC : r.horario.zona;
          const mLoc = minutosLocal(ahora, tzR);
          if (!enVentana(mLoc, aMin(r.horario.desde, 0), aMin(r.horario.hasta, 1440))) { salta(`fuera de horario (${hhmm(mLoc)} en ${tzR})`); continue; }
          const mArt = minutosLocal(ahora, ART);
          if (r.horario.excluir_ventanas_arg.some(([x, y]) => enVentana(mArt, aMin(x, 0), aMin(y, 0)))) { salta(`ventana excluida (${hhmm(mArt)} hora Argentina)`); continue; }
          // Límites de repetición.
          const pr = porRegla(r.id);
          if (r.limites.una_vez_por_objeto && pr.hecho) { salta("ya se aplicó una vez a este objeto"); continue; }
          if (pr.congelado === fecha) { salta("congelada por hoy"); continue; }
          if (r.limites.congelar_si) { const e = []; if (evalCond(r.limites.congelar_si, r, e)) { pr.congelado = fecha; sucios.add(n.id); salta(`se congela por hoy: ${e.map(x => `${x.metrica} ${x.valor_actual}`).join(", ")}`); continue; } }
          if (r.limites.espera_min_misma_accion && pr.ult && ahora - pr.ult < r.limites.espera_min_misma_accion * 60000 - 90000) { salta(`esperando ${r.limites.espera_min_misma_accion} min desde la última acción`); continue; }
          if (r.limites.max_por_dia && pr.hoy?.fecha === fecha && (pr.hoy.n || 0) >= r.limites.max_por_dia) { salta(`ya hizo ${pr.hoy.n} hoy (máximo ${r.limites.max_por_dia})`); continue; }
          // Condiciones.
          const entradas = [];
          if (!evalCond(r.condiciones, r, entradas)) { if (evaluaciones.length < 400) evaluaciones.push({ ...ev, aplica: false, motivo: "condiciones no cumplidas", entradas }); continue; }
          // Acción.
          const ac = r.accion; let act = null, calculo = "";
          const base = { cuenta: d.c.nombre, cuenta_id: d.c.id, campana: camp.name, campana_id: camp.id, tz: tzTienda, hora_local: hhmm(mLoc), tok: d.c.tokEdita, nivel: o.tipo, id: n.id, nombre: n.name, regla_id: r.id, regla: r.nombre, datos: { entradas, cpa_ref: cpaRef != null ? r2(cpaRef) : null, presupuesto: o.budget != null && kUsd ? r2(o.budget / 100 / kUsd) : null, piso: st.piso != null && kUsd ? r2(st.piso / 100 / kUsd) : null, puja: o.cap != null && kUsd ? r2(o.cap / 100 / kUsd) : null } };
          if (ac.tipo === "pausar") { act = { ...base, accion: "pausar", antes: "ACTIVE", despues: "PAUSED" }; calculo = "pausar"; }
          else {
            if (!kUsd) { salta("sin cotización de la moneda de la cuenta"); continue; }
            const esPuja = ac.tipo.startsWith("puja"), actual = esPuja ? o.cap : o.budget;
            let monto = ac.valor === "cpa" ? cpaRef : ac.valor === "front_ticket" ? ticketPrincipal : Number(ac.valor);
            if (monto == null || !isFinite(monto)) { salta(`no hay ${ac.valor === "cpa" ? "CPA de referencia" : "ticket del producto principal"}`); continue; }
            let mult = 1; if (ac.multiplicar_por === "adsets_nuevos_hoy") { mult = nuevosHoy(r.id); if (!mult) { salta("sin conjuntos nuevos hoy"); continue; } }
            let nv = ac.tipo.endsWith("_pct") ? Math.round(actual * (1 + monto / 100)) : actual + Math.round(monto * mult * kUsd * 100);
            calculo = ac.tipo.endsWith("_pct") ? `${r2(actual / 100)} ${monto > 0 ? "+" : "−"} ${Math.abs(monto)} % = ${r2(nv / 100)}` : `${r2(actual / 100)} ${monto > 0 ? "+" : "−"} ${r2(Math.abs(monto) * kUsd)}${mult !== 1 ? ` × ${mult}` : ""} = ${r2(nv / 100)}`;
            if (!esPuja) {
              const piso = r.limites.piso === "presupuesto_inicial" ? st.piso : typeof r.limites.piso === "number" ? Math.round(r.limites.piso * kUsd * 100) : null;
              if (piso != null && nv < piso) { calculo += ` → piso ${r2(piso / 100)}`; nv = piso; }
              if (r.limites.tope_pct_dia && st.piso != null) { const tope = Math.round(st.piso * (1 + r.limites.tope_pct_dia / 100)); if (nv > tope) { calculo += ` → tope ${r2(tope / 100)}`; nv = tope; } }
            }
            nv = Math.max(1, nv);
            if (nv === actual) { if (evaluaciones.length < 400) evaluaciones.push({ ...ev, aplica: false, motivo: `sin cambio por el límite (${calculo})`, entradas }); continue; }
            act = { ...base, accion: esPuja ? "puja" : "presupuesto", campo: esPuja ? "bid_amount" : "daily_budget", antes: actual, despues: nv, enMoneda: true };
          }
          act.calculo = calculo;
          act.post = () => {
            const pr2 = porRegla(r.id); pr2.ult = ahora; pr2.total = (pr2.total || 0) + 1; pr2.hoy = pr2.hoy?.fecha === fecha ? { fecha, n: pr2.hoy.n + 1 } : { fecha, n: 1 }; if (r.limites.una_vez_por_objeto) pr2.hecho = true;
            if (ac.multiplicar_por === "adsets_nuevos_hoy") { pr2.contados = pr2.contados || {}; for (const s of o.sets) { const ini = Date.parse(s.start_time || s.created_time || ""); if (isFinite(ini) && ini <= ahora && hoyEn(tzTienda, ini) === fecha) pr2.contados[s.id] = true; } }
            if (act.accion === "presupuesto") { st.puesto = act.despues; if (act.despues > act.antes) st.subidas = (st.subidas || 0) + 1; else { st.bajadas = (st.bajadas || 0) + 1; st.bajadasTotal = (st.bajadasTotal || 0) + 1; } }
            if (act.accion === "puja") st.pujaPuesta = act.despues;
            sucios.add(n.id);
          };
          if (evaluaciones.length < 400) evaluaciones.push({ ...ev, aplica: true, entradas, calculo, accion: act.accion });
          acciones.push(act);
          break; // una acción por objeto y vuelta
        }
      }
    }
  }

  // 4) Aplicar (o simular) y registrar.
  const logRef = uRef.collection("meta_escala_log");
  for (const a of acciones) {
    let ok = true, error = null;
    if (!a.soloRegistro && !simular) {
      try {
        if (!a.tok) throw new Error("sin token con ads_management para esta cuenta");
        await metaPost(a.id, a.accion === "pausar" ? { status: "PAUSED" } : { [a.campo]: String(a.despues) }, a.tok);
      } catch (e) { ok = false; error = e.message; }
    }
    if (ok && !a.soloRegistro) { a.post?.(); if (simular && EST[a.id]) { if (a.accion === "presupuesto") EST[a.id].puesto = a.antes; if (a.accion === "puja") EST[a.id].pujaPuesta = a.antes; } }
    if (!a.soloRegistro && ok) vuelta.cambios++;
    if (error) vuelta.errores.push(`${a.nombre}: ${error}`);
    const enMoneda = a.enMoneda ? { antes: a.antes / 100, despues: a.despues / 100 } : { antes: a.antes ?? null, despues: a.despues ?? null };
    const fila = { ts: new Date(ahora).toISOString(), vuelta: vueltaId, cuenta: a.cuenta, cuenta_id: a.cuenta_id, campana: a.campana, campana_id: a.campana_id, nivel: a.nivel, id: a.id, nombre: a.nombre,
      accion: a.accion, ...enMoneda, pct: a.enMoneda && a.antes ? r2((a.despues - a.antes) / a.antes * 100) : null, regla_id: a.regla_id || null, regla: a.regla, calculo: a.calculo || null, datos: a.datos || {}, hora_local: a.hora_local, zona: a.tz,
      simulado: simular && !a.soloRegistro, ok, error };
    if (prueba) (vuelta.acciones = vuelta.acciones || []).push(fila); else await logRef.add(fila).catch(() => {});
  }
  if (prueba) vuelta.evaluaciones = evaluaciones;
  else await Promise.all([...sucios].map(id => uRef.collection("meta_escala_estado").doc(id).set(EST[id], { merge: true }).catch(() => {})));
  vuelta.ultima_venta = V.ultima ? new Date(V.ultima).toISOString() : null;
  return cerrar();
}

export async function resumenDiario(db, uid, fecha) {
  const desde = new Date(utcDeLocal(fecha, 0, ART)).toISOString(), hasta = new Date(utcDeLocal(sumaDias(fecha, 1), 0, ART)).toISOString();
  const uRef = db.collection("users").doc(uid);
  const [log, vueltas] = await Promise.all([
    uRef.collection("meta_escala_log").where("ts", ">=", desde).where("ts", "<", hasta).get(),
    uRef.collection("meta_escala_vueltas").where("ts", ">=", desde).where("ts", "<", hasta).get(),
  ]);
  const L = log.docs.map(d => d.data());
  const cont = (f) => L.filter(f).length;
  const vs = vueltas.docs.map(d => d.data());
  const res = {
    fecha, generado: new Date().toISOString(),
    vueltas: vs.length, vueltas_saltadas: vs.filter(v => v.saltada).length, vueltas_con_error: vs.filter(v => v.errores?.length).length,
    subidas: cont(x => x.accion === "presupuesto" && x.pct > 0 && x.ok), bajadas: cont(x => x.accion === "presupuesto" && x.pct < 0 && x.ok),
    cambios_de_puja: cont(x => x.accion === "puja" && x.ok), pausas: cont(x => x.accion === "pausar" && x.ok), cambios_manuales: cont(x => x.accion === "manual"), fallidos: cont(x => !x.ok),
    simulado: L.some(x => x.simulado),
    por_campana: Object.values(L.filter(x => x.accion !== "manual").reduce((m, x) => { const k = x.campana_id; const g = m[k] || (m[k] = { campana: x.campana, cuenta: x.cuenta, cambios: [] }); g.cambios.push(`${x.ts.slice(11, 16)} UTC · ${x.accion}${x.pct != null ? ` ${x.pct > 0 ? "+" : ""}${x.pct} %` : ""} · ${x.regla}`); return m; }, {})),
  };
  await uRef.collection("meta_escala_resumen").doc(fecha).set(res);
  return res;
}

// ── Cron: todas las tiendas con reglas activas ──
export async function cronReglas(db, { deadline = Date.now() + 270000 } = {}) {
  const idx = (await db.collection("system").doc("meta_escala").get()).data()?.uids || {};
  const uids = Object.keys(idx).filter(u => idx[u]);
  const ahora = Math.floor(Date.now() / 60000) * 60000;
  const out = [];
  for (let i = 0; i < uids.length && Date.now() < deadline; i += 4) {
    out.push(...await Promise.all(uids.slice(i, i + 4).map(async uid => {
      try { const v = await correrReglas(db, uid, { ahora }); return { uid, cambios: v.cambios, saltada: v.saltada, errores: v.errores.length }; }
      catch (e) { await db.collection("users").doc(uid).collection("meta_escala_vueltas").doc(new Date(ahora).toISOString().slice(0, 16)).set({ ts: new Date(ahora).toISOString(), errores: [e.message], saltada: "la vuelta falló: no tocó nada" }).catch(() => {}); return { uid, error: e.message }; }
    })));
  }
  // 21:30 hora Argentina: resumen del día.
  const mArt = minutosLocal(ahora, ART);
  if (mArt >= 1290 && mArt < 1305) for (const uid of uids) await resumenDiario(db, uid, hoyEn(ART, ahora)).catch(() => {});
  return { tiendas: uids.length, resultados: out };
}

export { correrReglas as correrEscala, cronReglas as cronEscala };
