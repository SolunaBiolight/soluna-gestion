// ─── Reglas de escala automática de Meta ───
// Cada tienda escribe sus reglas en lenguaje natural; la IA las pasa a una config fija
// (normalizarReglas) que este motor aplica cada 15 min (:00 :15 :30 :45, que en la hora
// local de cada país es el mismo cuarto de hora) sobre todas las campañas ACTIVAS de
// todas las cuentas publicitarias, con gasto de Meta y ventas reales de Impultienda (UTM).
//
// Firestore (users/{uid}/…):
//   meta_escala/cfg            {prompt, reglas, activo, simular, actualizado}
//   meta_escala_estado/{nodo}  estado del día por campaña/conjunto (subidas, bajadas, piso…)
//   meta_escala_log/{auto}     cada cambio (o simulación) con regla y números
//   meta_escala_vueltas/{iso}  cada vuelta de 15 min: ok, saltada (motivo) o con errores
//   meta_escala_resumen/{día}  resumen de las 21:30 (hora Argentina)
// system/meta_escala {uids:{uid:true}}: tiendas con reglas activas (las que recorre el cron).
//
// Lo manual manda: un presupuesto cambiado a mano pasa a ser el nuevo piso y punto de
// partida; el motor nunca activa nada (lo pausado a mano queda pausado); "[MANUAL]" en el
// nombre no se toca. Si en una vuelta falla cualquier lectura, esa vuelta no toca nada.

import { utcDeLocal, zonaDe, fxPorUsd, aUsd, atribuirUtm, armarTiendas, leerIndiceUtm, construirIndiceUtm, paisDeUtm } from "./impultienda.js";

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

// ── Alcance: a qué campañas / conjuntos aplica cada regla ──
// Árbol de condiciones: {y:[…]} | {o:[…]} | {no:…} | {campo, op, valores}. campo: cuenta, fanpage,
// pixel, dominio, link, pais, campana, estrategia, tipo (CBO/ABO). op: es | contiene | coincide (con *).
const CAMPOS = ["cuenta", "fanpage", "pixel", "dominio", "link", "pais", "campana", "estrategia", "tipo"];
const CAMPO_TXT = { cuenta: "cuenta", fanpage: "fanpage", pixel: "píxel", dominio: "dominio", link: "link", pais: "país", campana: "campaña", estrategia: "estrategia de puja", tipo: "tipo" };
const sinTilde = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
export const estrategiaCodigo = (v) => {
  const s = String(v || "").toUpperCase();
  if (/COST.?CAP|CAP.*COSTO|LIMITE.*COSTO/.test(s)) return "COST_CAP";
  if (/BID|PUJA/.test(s) && /CAP|TOPE|LIMITE/.test(s)) return "LOWEST_COST_WITH_BID_CAP";
  if (/ROAS/.test(s)) return "LOWEST_COST_WITH_MIN_ROAS";
  if (/LOWEST_COST_WITHOUT_CAP|MENOR|LOWEST|VOLUM|SIN TOPE|SIN LIMITE|AUTOM/.test(s)) return "LOWEST_COST_WITHOUT_CAP";
  return s.replace(/\s+/g, "_");
};
export function normAlcance(a, prof = 0) {
  if (!a || typeof a !== "object" || prof > 6) return null;
  if (Array.isArray(a)) return normAlcance({ y: a }, prof);
  for (const k of ["y", "o"]) if (Array.isArray(a[k])) { const l = a[k].map(x => normAlcance(x, prof + 1)).filter(Boolean); return !l.length ? null : l.length === 1 ? l[0] : { [k]: l }; }
  if (a.no) { const n = normAlcance(a.no, prof + 1); return n ? { no: n } : null; }
  const campo = sinTilde(a.campo).replace(/^pixel.*/, "pixel").replace(/^pagina.*|^page.*/, "fanpage").replace(/^campana.*/, "campana");
  if (!CAMPOS.includes(campo)) return null;
  let valores = (Array.isArray(a.valores) ? a.valores : a.valor != null ? [a.valor] : []).map(v => String(v).trim()).filter(Boolean).slice(0, 50);
  if (campo === "estrategia") valores = valores.map(estrategiaCodigo);
  if (campo === "tipo" || campo === "pais") valores = valores.map(v => v.toUpperCase());
  if (!valores.length) return null;
  const op = ["es", "contiene", "coincide"].includes(a.op) ? a.op : valores.some(v => v.includes("*")) ? "coincide" : "es";
  return { campo, op, valores };
}
const comodin = (p) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
const host = (u) => String(u || "").toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/^www\./, "");
// ¿El contexto (listas de valores por campo) cumple el alcance? Un campo sin datos no cumple.
export function cumple(a, ctx) {
  if (!a) return true;
  if (a.y) return a.y.every(x => cumple(x, ctx));
  if (a.o) return a.o.some(x => cumple(x, ctx));
  if (a.no) return !cumple(a.no, ctx);
  const vals = (ctx[a.campo] || []).filter(v => v != null && v !== "").map(v => String(v).toLowerCase());
  return a.valores.some(p => {
    let q = p.toLowerCase();
    if (a.campo === "dominio") q = q.includes("*") ? q.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "") : host(q);
    if (a.op === "coincide" || q.includes("*")) { const re = comodin(q); return vals.some(v => re.test(v) || (a.campo === "dominio" && q.startsWith("*.") && v === q.slice(2))); }
    if (a.op === "contiene") return vals.some(v => v.includes(q));
    if (a.campo === "dominio") return vals.some(v => v === q || v.endsWith("." + q));
    if (a.campo === "cuenta") { const id = q.replace(/^act_/, ""); return vals.some(v => v === q || v === id); }
    return vals.some(v => v === q);
  });
}
export function textoAlcance(a) {
  if (!a) return "";
  if (a.y) return a.y.map(x => (x.o ? `(${textoAlcance(x)})` : textoAlcance(x))).join(" Y ");
  if (a.o) return a.o.map(x => (x.y ? `(${textoAlcance(x)})` : textoAlcance(x))).join(" O ");
  if (a.no) return `NO (${textoAlcance(a.no)})`;
  return `${CAMPO_TXT[a.campo]} ${a.op === "es" ? (a.valores.length > 1 ? "es una de" : "es") : a.op} ${a.valores.join(", ")}`;
}
const tieneCuenta = (a) => !!a && (a.y ? a.y.some(tieneCuenta) : a.o ? a.o.every(tieneCuenta) : a.no ? false : a.campo === "cuenta");
const usaCampo = (a, cs) => !!a && (a.y || a.o ? (a.y || a.o).some(x => usaCampo(x, cs)) : a.no ? usaCampo(a.no, cs) : cs.includes(a.campo));

// ── Config de reglas: lo que sale de la IA se limpia acá ──
// Cada bloque puede ser un objeto o una lista de variantes, cada una con su "alcance"; para cada
// campaña o conjunto vale la PRIMERA variante cuyo alcance cumple (bloque vacío = regla apagada).
const BLOQUES = ["horario", "subida", "puja", "bajada", "media", "cierre", "pausa", "excepciones", "nuevos"];
const CLAVE = { media: "zona_media", nuevos: "adsets_nuevos" };
const NORM = {
  horario: (o) => ({ desde: aMin(o.desde, 360), hasta: aMin(o.hasta, 1260) }),
  subida: (o) => ({ roas: num(o.roas_min, 1.9), ventas: num(o.ventas_min, 2), pct: Math.min(100, Math.max(1, num(o.pct, 15))), cada: num(o.cada_min, 120),
    pico: (Array.isArray(o.pico) ? o.pico : []).map(p => [aMin(p?.desde, null), aMin(p?.hasta, null)]).filter(p => p[0] != null && p[1] != null), cadaPico: num(o.cada_min_pico, 15), tope: o.tope_pct_dia != null ? num(o.tope_pct_dia, null) : null }),
  puja: (o) => ({ espera: aMin(o.desde, 390), paso: num(o.paso_usd, 0.5), cada: num(o.cada_min, 30), gastoFijo: num(o.gasto_fijo_usd, 10) }),
  bajada: (o) => ({ roas: num(o.roas_max, 1.4), ventana: num(o.ventana_min, 120), pct: Math.min(90, Math.max(1, num(o.pct, 15))), minCpa: num(o.min_cpa_gastado, 1), enfriar: num(o.enfriar_min, 120) }),
  media: (o) => ({ desde: num(o.roas_desde, 1.4), hasta: num(o.roas_hasta, 1.9), pct: num(o.empuje_pct, 10), hora: aMin(o.empuje_hora, 600), ventana: num(o.ventana_salida_min, 240) }),
  cierre: (o) => ({ hora: aMin(o.hora, 1260), subidasMas: num(o.subidas_mas_de, 4), sinBajadas: o.sin_bajadas !== false, pct: num(o.pct, 15) }),
  pausa: (o) => ({ bajadas: o.bajadas != null ? num(o.bajadas, null) : null, piso: o.piso_y_malo !== false, dias: o.dias != null ? num(o.dias, null) : null, diasRoas: num(o.dias_roas_max, 1.4), diasCpa: num(o.dias_min_cpa, 3) }),
  excepciones: (o) => ({ horas: num(o.min_horas_desde_inicio, 24), etiqueta: String(o.etiqueta_manual || "[MANUAL]").slice(0, 40) }),
  nuevos: (o) => ({ etiqueta: String(o.etiqueta_nuevo || "[NUEVO]").slice(0, 40), creativo: o.creativo_nuevo !== false, cpas: Math.min(5, Math.max(0.1, num(o.cpas_por_adset, 1))), cpaDias: Math.min(30, Math.max(1, num(o.cpa_dias, 7))),
    ticket: o.ticket_usd != null && num(o.ticket_usd, 0) > 0 ? num(o.ticket_usd, null) : null, subePiso: o.sube_piso !== false }),
};
export function normalizarReglas(x = {}) {
  const variantes = {};
  for (const k of BLOQUES) {
    const raw = x[CLAVE[k] || k];
    const lista = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(o => o && typeof o === "object" && o.activo !== false).slice(0, 20);
    variantes[k] = lista.map(o => ({ ...NORM[k](o), alcance: normAlcance(o.alcance), nombre: o.nombre ? String(o.nombre).slice(0, 80) : null }));
    // Por seguridad, la de adsets nuevos tiene que estar limitada a una cuenta (nunca a todas).
    if (k === "nuevos") for (const v of variantes[k]) if (!tieneCuenta(v.alcance)) v.invalida = "no dice en qué cuenta publicitaria aplica: no se usa";
    if ((k === "horario" || k === "excepciones") && !variantes[k].some(v => !v.alcance)) variantes[k].push({ ...NORM[k]({}), alcance: null, nombre: null });
  }
  return {
    alcance: normAlcance(x.alcance), variantes,
    caidas: (Array.isArray(x.caidas) ? x.caidas : []).map(c => ({ desde: aMin(c?.desde, null), hasta: aMin(c?.hasta, null), tz: PAIS_TZ[String(c?.pais || "").toUpperCase()] || ART })).filter(c => c.desde != null && c.hasta != null).slice(0, 10),
  };
}
// Las reglas que valen para un contexto (campaña o conjunto): misma forma que una config plana.
export function resolver(R, ctx) {
  const out = { caidas: R.caidas };
  for (const k of BLOQUES) out[k] = (R.variantes[k] || []).find(v => !v.invalida && cumple(v.alcance, ctx)) || null;
  return out;
}
const necesitaAnuncios = (R) => usaCampo(R.alcance, ["fanpage", "dominio", "link"]) || BLOQUES.some(k => (R.variantes[k] || []).some(v => usaCampo(v.alcance, ["fanpage", "dominio", "link"]))) || R.variantes.nuevos.some(v => !v.invalida);

// La misma config, en filas para mostrar (Growith y MCP muestran exactamente esto).
export function tablaReglas(R) {
  const H = R.variantes.horario.find(v => !v.alcance) || R.variantes.horario[0];
  const h = `${hhmm(H.desde)} a ${hhmm(H.hasta)} (hora local del país)`;
  const nivel = "CBO: presupuesto de la campaña · ABO: de cada conjunto · con bid/cost cap también el tope";
  const f = [];
  const fila = (v, x) => f.push({ ...x, alcance: textoAlcance(v.alcance) || "Todas", ...(v.nombre ? { nombre: v.nombre } : {}), ...(v.invalida ? { aviso: v.invalida } : {}) });
  if (R.alcance) f.push({ regla: "Alcance general", condicion: textoAlcance(R.alcance), accion: "Fuera de esto no se toca nada", nivel: "Todo", horario: "Siempre", alcance: textoAlcance(R.alcance) });
  for (const v of R.variantes.horario) if (v !== H) fila(v, { regla: "Horario", condicion: `${hhmm(v.desde)} a ${hhmm(v.hasta)} (hora local del país)`, accion: "Horario en que corren las reglas", nivel: "—", horario: "—" });
  for (const v of R.variantes.subida) {
    fila(v, { regla: "Subida", condicion: `ROAS del día ≥ ${v.roas} y ≥ ${v.ventas} ventas en el día (primera del día)`, accion: `+${v.pct} % de presupuesto`, nivel, horario: h });
    fila(v, { regla: "Subida", condicion: `Cada ${v.cada} min (${v.pico.length ? `cada ${v.cadaPico} min en ${v.pico.map(p => `${hhmm(p[0])}–${hhmm(p[1])}`).join(" y ")}` : "sin horas pico"}): desde la última subida ≥ ${v.ventas} ventas con ROAS ≥ ${v.roas}`, accion: `+${v.pct} %${v.tope ? `, tope +${v.tope} % en el día` : ", sin tope"}`, nivel, horario: h });
  }
  for (const v of R.variantes.puja) fila(v, { regla: "Bid / cost cap", condicion: `Desde las ${hhmm(v.espera)}, si el conjunto no gastó en los últimos ${v.cada} min y el día lleva < ${v.gastoFijo} USD`, accion: `+${v.paso} USD al tope cada ${v.cada} min; con ≥ ${v.gastoFijo} USD gastados el tope queda fijo y siguen las reglas comunes`, nivel: "Conjunto con bid cap o cost cap", horario: h });
  for (const v of R.variantes.bajada) fila(v, { regla: "Bajada", condicion: `ROAS de las últimas ${v.ventana / 60} h < ${v.roas}, con ≥ ${v.minCpa} CPA gastado en el día y sin otra bajada en ${v.enfriar / 60} h`, accion: `−${v.pct} %, nunca por debajo del piso (presupuesto con el que arrancó o el último puesto a mano)`, nivel, horario: h });
  for (const v of R.variantes.media) fila(v, { regla: "Zona media", condicion: `ROAS del día entre ${v.desde} y ${v.hasta}`, accion: `Se mantiene; +${v.pct} % una vez a las ${hhmm(v.hora)}. Si el ROAS de las últimas ${v.ventana / 60} h sale de la franja, aplica subida o bajada`, nivel, horario: h });
  for (const v of R.variantes.cierre) fila(v, { regla: "Cierre", condicion: `A las ${hhmm(v.hora)}: más de ${v.subidasMas} subidas en el día${v.sinBajadas ? " y ninguna bajada" : ""}`, accion: `−${v.pct} %`, nivel, horario: `${hhmm(v.hora)} local` });
  for (const v of R.variantes.pausa) {
    const c = [];
    if (v.bajadas) c.push(`${v.bajadas} bajadas en el día`);
    if (v.piso) c.push("llegó al piso y en el chequeo siguiente sigue con ROAS bajo");
    if (v.dias) c.push(`últimos ${v.dias} días con ROAS < ${v.diasRoas} habiendo gastado ≥ ${v.diasCpa} CPA`);
    if (c.length) fila(v, { regla: "Pausa", condicion: c.join(" · o "), accion: "Pausar (en CBO el conjunto malo; la campaña solo si todos vienen mal). Nunca se reactiva nada", nivel: "Campaña o conjunto", horario: h });
  }
  for (const v of R.variantes.nuevos) fila(v, { regla: "Adset nuevo", condicion: `Un conjunto de una CBO arranca hoy (su hora de inicio ya pasó) y ${v.creativo ? `su anuncio usa un video o imagen que no corría en esa campaña, o tiene "${v.etiqueta}" en el nombre` : `tiene "${v.etiqueta}" en el nombre`}. Una sola vez por conjunto`,
    accion: `+${v.cpas} CPA al presupuesto diario de la CBO por cada conjunto nuevo (CPA real de ${v.cpaDias} días de la campaña; si no tiene ventas, ${v.ticket ? `${v.ticket} USD` : "el ticket del producto principal"})${v.subePiso ? "; el piso sube lo mismo" : ""}. Después siguen las reglas comunes`, nivel: "Campaña CBO", horario: "Apenas arranca (cualquier hora)" });
  for (const v of R.variantes.excepciones) fila(v, { regla: "Excepciones", condicion: `Menos de ${v.horas} h desde que arrancó · "${v.etiqueta}" en el nombre · pausado a mano`, accion: "No se toca", nivel: "Campaña o conjunto", horario: "Siempre" });
  for (const c of R.caidas) f.push({ regla: "Caída de Impultienda", condicion: `${hhmm(c.desde)} a ${hhmm(c.hasta)} (${c.tz === ART ? "hora Argentina" : c.tz})`, accion: "La vuelta no toca nada", nivel: "Todo", horario: `${hhmm(c.desde)}–${hhmm(c.hasta)}`, alcance: "Todas" });
  f.push({ regla: "Definiciones", condicion: "ROAS = facturación real cobrada (principal + bumps + post-compra, USD) ÷ gasto de Meta (USD). CPA de referencia = el de la campaña en 5 días si tiene 3+ ventas, si no el promedio de todas", accion: "—", nivel: "—", horario: "—", alcance: "Todas" });
  return f;
}

// Lógica exacta que corre el motor, en pasos (para que otra IA la revise).
export const LOGICA_MOTOR = [
  "Cada 15 min (:00 :15 :30 :45). Si la vuelta cae en una ventana de caída, o la tienda no es digital, no hace nada.",
  "Lee TODO antes de decidir: cuentas, campañas y conjuntos ACTIVOS, gasto por hora (2 días) y por día (8 días) de Meta, anuncios (fanpage, link, video/imagen) si alguna regla los usa, y las ventas reales de Impultienda (8 días) cruzadas por UTM. Si cualquier lectura falla, la vuelta no toca nada.",
  "Contexto de cada campaña / conjunto: cuenta (id y nombre), campaña (id y nombre), país (tienda donde más vende o código del nombre), tipo CBO/ABO, estrategia de puja (campaña y conjunto), píxel (promoted_object del conjunto), fanpage, links y dominios (de sus anuncios). En una CBO el contexto junta los de todos sus conjuntos activos.",
  "Alcance: si hay alcance general y la campaña no lo cumple, se saltea. Para cada regla vale la PRIMERA variante cuyo alcance cumple el contexto; si ninguna cumple, esa regla no aplica ahí. Una condición sobre un dato que no hay (por ejemplo sin anuncios) no se cumple.",
  "Saltea: lo que tiene la etiqueta manual, lo que arrancó hace menos de N h, lo pausado (solo lee ACTIVOS; nunca reactiva).",
  "Cambio manual: si el presupuesto actual difiere del último que puso Growith, pasa a ser el nuevo piso y punto de partida.",
  "Adset nuevo (CBO, antes que el resto y a cualquier hora): por cada conjunto activo que arrancó hoy (hora local del país) y ya pasó su hora de inicio, con creativo nuevo (un video/imagen/post que ningún otro conjunto de la campaña usa) o con la etiqueta → +cpas × CPA al presupuesto de la CBO, una sola vez por conjunto. CPA = gasto ÷ ventas de la campaña en cpa_dias días; si no tiene ventas, ticket configurado o mediana del ticket del producto principal. Esa vuelta no aplica otras reglas a la campaña.",
  "Bid/cost cap (conjuntos con tope): desde la hora de espera, si no gastó desde el último cambio de tope y el día lleva < gasto fijo, +paso USD cada N min. Al llegar al gasto fijo el tope queda fijo y entra en las reglas comunes (sus topes se mueven con el mismo % que el presupuesto).",
  "Orden por unidad (CBO = campaña, ABO = cada conjunto con presupuesto), dentro del horario: 1) pausa por N días; 2) pausa por piso y sigue mal; 3) cierre; 4) bajada (nunca debajo del piso); 5) subida; 6) empujón de zona media. Una sola acción por unidad y vuelta.",
  "Aplica en Meta (o solo registra si está en simulación) y guarda cada cambio con regla, números, hora local y zona.",
];
export function logicaReglas(R) {
  return tablaReglas(R).filter(r => r.regla !== "Definiciones").map(r => `${r.alcance && r.alcance !== "Todas" ? `SI [${r.alcance}] ` : ""}${r.regla.toUpperCase()}: SI ${r.condicion} → ${r.accion}${r.aviso ? ` (⚠ ${r.aviso})` : ""}`);
}

const SISTEMA_IA = `Convertís reglas de escala de Meta Ads escritas por un usuario en un JSON EXACTO con esta forma (todas las horas "HH:MM" en hora local del país de cada campaña salvo caidas; porcentajes como número, 15 = 15 %). Si una regla no aparece en el texto, poné ese bloque en null. No inventes reglas que el usuario no escribió.
{
 "alcance": ALCANCE | null,
 "horario": {"desde":"06:00","hasta":"21:00"},
 "subida": {"roas_min":1.9,"ventas_min":2,"pct":15,"cada_min":120,"pico":[{"desde":"10:00","hasta":"12:00"}],"cada_min_pico":15,"tope_pct_dia":null} | null,
 "puja": {"desde":"06:30","paso_usd":0.5,"cada_min":30,"gasto_fijo_usd":10} | null,
 "bajada": {"roas_max":1.4,"ventana_min":120,"pct":15,"min_cpa_gastado":1,"enfriar_min":120} | null,
 "zona_media": {"roas_desde":1.4,"roas_hasta":1.9,"empuje_pct":10,"empuje_hora":"10:00","ventana_salida_min":240} | null,
 "cierre": {"hora":"21:00","subidas_mas_de":4,"sin_bajadas":true,"pct":15} | null,
 "pausa": {"bajadas":6,"piso_y_malo":true,"dias":4,"dias_roas_max":1.4,"dias_min_cpa":3} | null,
 "adsets_nuevos": {"etiqueta_nuevo":"[NUEVO]","creativo_nuevo":true,"cpas_por_adset":1,"cpa_dias":7,"ticket_usd":null,"sube_piso":true,"alcance":ALCANCE} | null,
 "excepciones": {"min_horas_desde_inicio":24,"etiqueta_manual":"[MANUAL]"},
 "caidas": [{"desde":"03:00","hasta":"04:30","pais":"AR"}],
 "no_entendido": ["frases del usuario que no encajan en ningún campo"]
}
ALCANCE limita a qué campañas o conjuntos aplica: {"y":[ALCANCE,…]} (todas), {"o":[ALCANCE,…]} (alguna), {"no":ALCANCE} o una condición {"campo":C,"op":"es"|"contiene"|"coincide","valores":["…"]}. C: "cuenta" (nombre o id de la cuenta publicitaria), "fanpage" (id o nombre), "pixel" (id), "dominio" (por ejemplo "*.tienda.com", con op "coincide" si hay *), "link" (URL de destino), "pais" (código de 2 letras), "campana" (nombre o id; "contiene" para parte del nombre), "estrategia" (COST_CAP, LOWEST_COST_WITH_BID_CAP, LOWEST_COST_WITHOUT_CAP, LOWEST_COST_WITH_MIN_ROAS), "tipo" (CBO o ABO).
Cualquier bloque (salvo caidas) puede ser un objeto o una LISTA de variantes, cada una con su propio "alcance" (y opcional "nombre"): para cada campaña vale la primera variante cuyo alcance cumple. Usá lista cuando el usuario da valores distintos según cuenta, país, tipo, etc. Un "alcance" en la raíz limita TODAS las reglas. "Nunca en X" se escribe con {"no":…}.
Detalles: "cada_min" es cada cuánto se permite una nueva subida; "pico" son las horas en que ese intervalo pasa a "cada_min_pico"; "tope_pct_dia" null si dice "sin tope". En "pausa", cada condición que no esté va en null (o false para piso_y_malo). "caidas" son ventanas en que no se toca nada; "pais" es el código del país de esa hora (AR si dice ARG). "adsets_nuevos": cuando un conjunto nuevo arranca dentro de una CBO, sube el presupuesto de la CBO en cpas_por_adset CPA; creativo_nuevo=false si solo cuenta la etiqueta; ticket_usd solo si el usuario da el ticket; su alcance tiene que decir la cuenta. Respondé SOLO el JSON.`;

export async function interpretarReglas(prompt) {
  const key = process.env.GOOGLE_AI_KEY;
  if (!key) throw new Error("Falta GOOGLE_AI_KEY para interpretar las reglas.");
  let ultimo;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(40000),
        body: JSON.stringify({ system_instruction: { parts: [{ text: SISTEMA_IA }] }, contents: [{ role: "user", parts: [{ text: String(prompt).slice(0, 12000) }] }],
          generationConfig: { response_mime_type: "application/json", temperature: 0, max_output_tokens: 4000, thinkingConfig: { thinkingBudget: 0 } } }),
      });
      const j = await r.json();
      let t = j.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const s = t.indexOf("{"), e = t.lastIndexOf("}");
      if (s < 0 || e <= s) throw new Error(j.error?.message || "respuesta vacía");
      return JSON.parse(t.slice(s, e + 1));
    } catch (e) { ultimo = e; }
  }
  throw new Error(`No se pudieron interpretar las reglas: ${ultimo?.message || "error"}`);
}

// ── Meta ──
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
// prueba: corre en simulación y no guarda nada (ni estado, ni registro, ni vuelta): devuelve lo que haría.
export async function correrEscala(db, uid, { ahora = Date.now(), forzar = false, prueba = false } = {}) {
  const uRef = db.collection("users").doc(uid);
  const cfgDoc = (await uRef.collection("meta_escala").doc("cfg").get()).data();
  const vueltaId = new Date(ahora).toISOString().slice(0, 16);
  const vRef = uRef.collection("meta_escala_vueltas").doc(vueltaId);
  const simular = prueba || !!cfgDoc?.simular;
  const vuelta = { ts: new Date(ahora).toISOString(), simular, evaluadas: 0, cambios: 0, errores: [], saltada: null };
  const cerrar = async () => { if (!prueba) await vRef.set(vuelta).catch(() => {}); return vuelta; };
  if (!cfgDoc?.activo && !forzar) { vuelta.saltada = "reglas apagadas"; return vuelta; }
  if (!cfgDoc?.reglas) { vuelta.saltada = "sin reglas"; return cerrar(); }
  const R = normalizarReglas(cfgDoc.reglas);
  for (const c of R.caidas) {
    const m = minutosLocal(ahora, c.tz);
    if (c.desde <= c.hasta ? (m >= c.desde && m < c.hasta) : (m >= c.desde || m < c.hasta)) { vuelta.saltada = `ventana de caída de Impultienda (${hhmm(c.desde)}–${hhmm(c.hasta)})`; return cerrar(); }
  }
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
  const conAnuncios = necesitaAnuncios(R);
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
  if (usaCampo(R.alcance, ["fanpage"]) || Object.values(R.variantes).some(l => l.some(v => usaCampo(v.alcance, ["fanpage"])))) {
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

  // 3) Estado y decisiones.
  const estSnap = await uRef.collection("meta_escala_estado").get();
  const EST = Object.fromEntries(estSnap.docs.map(d => [d.id, d.data()]));
  const sucios = new Set();
  const acciones = [];
  const nuevo = (id) => EST[id] || (EST[id] = {});
  const viejo = (n, E) => ahora - Math.max(Date.parse(n.start_time || "") || 0, Date.parse(n.created_time || "") || 0) < E.horas * 3600000;
  const manual = (n, E) => String(n.name || "").toUpperCase().includes(E.etiqueta.toUpperCase());

  for (const d of datos) {
    const setsPorId = Object.fromEntries(d.sets.map(s => [s.id, s]));
    const kUsd = String(d.c.moneda || "USD").toUpperCase() === "USD" ? 1 : Number(V.fx?.[String(d.c.moneda).toUpperCase()]) || null;
    for (const camp of d.camps) {
      const { tz, pais } = zonaCamp(camp, d.tzC), fecha = hoyEn(tz, ahora);
      const esCBO = parseInt(camp.daily_budget) > 0;
      // Contexto para el alcance de las reglas (un conjunto, o la campaña con todos sus conjuntos).
      const ctxDe = (lista) => {
        const ctx = { cuenta: [d.c.id, d.c.id.replace(/^act_/, ""), d.c.nombre], campana: [camp.id, camp.name], pais: [pais], tipo: [esCBO ? "CBO" : "ABO"],
          estrategia: [camp.bid_strategy, ...lista.map(s => s.bid_strategy)], pixel: lista.map(s => s.promoted_object?.pixel_id), fanpage: [], link: [], dominio: [] };
        for (const s of lista) { const x = AD[s.id]; if (!x) continue; for (const f of ["fanpage", "link", "dominio"]) ctx[f].push(...x[f]); for (const pg of x.fanpage) if (nombrePagina[pg]) ctx.fanpage.push(nombrePagina[pg]); }
        return ctx;
      };
      const todosSets = (setsDeCamp[camp.id] || []).map(id => setsPorId[id]).filter(Boolean);
      const ctxCamp = ctxDe(todosSets);
      if (R.alcance && !cumple(R.alcance, ctxCamp)) continue;
      const Rc = resolver(R, ctxCamp), E = Rc.excepciones;
      if (manual(camp, E) || viejo(camp, E)) continue;
      const slot = Math.round(minutosLocal(ahora, tz) / 15) * 15;
      const iniDia = utcDeLocal(fecha, 0, tz);
      const cpa = cpaDe(camp.id);
      const setsActivos = todosSets.filter(s => !manual(s, E));
      const unidades = esCBO ? [{ nodo: camp, nivel: "c", tipo: "campaign", budget: parseInt(camp.daily_budget), ctx: ctxCamp, caps: setsActivos.filter(s => CAPS.includes(s.bid_strategy) && parseInt(s.bid_amount) > 0) }]
        : setsActivos.filter(s => parseInt(s.daily_budget) > 0 && !viejo(s, E) && (!R.alcance || cumple(R.alcance, ctxDe([s])))).map(s => ({ nodo: s, nivel: "s", tipo: "adset", budget: parseInt(s.daily_budget), ctx: ctxDe([s]), caps: CAPS.includes(s.bid_strategy) && parseInt(s.bid_amount) > 0 ? [s] : [] }));
      const base = { cuenta: d.c.nombre, cuenta_id: d.c.id, campana: camp.name, campana_id: camp.id, tz, hora_local: hhmm(slot % 1440), tok: d.c.tokEdita };

      // Bid / cost cap: subir el tope hasta que el día gaste lo mínimo; después queda fijo.
      const capsFijos = new Set();
      for (const s of setsActivos.filter(s => CAPS.includes(s.bid_strategy) && parseInt(s.bid_amount) > 0 && !viejo(s, E))) {
        const Rp = resolver(R, ctxDe([s]));
        const st = nuevo(s.id);
        if (st.fechaPuja !== fecha) Object.assign(st, { fechaPuja: fecha, topeFijo: false, ultPuja: 0, gastoUltPuja: 0 }), sucios.add(s.id);
        const dia = met("s", s.id, iniDia);
        if (!Rp.puja || st.topeFijo || dia.gasto >= Rp.puja.gastoFijo) { if (Rp.puja && !st.topeFijo && dia.gasto >= Rp.puja.gastoFijo) { st.topeFijo = true; sucios.add(s.id); } capsFijos.add(s.id); continue; }
        if (slot < Rp.puja.espera || slot >= Rp.horario.hasta || !kUsd) continue;
        if (st.ultPuja && ahora - st.ultPuja < Rp.puja.cada * 60000 - 90000) continue;
        if (st.ultPuja && dia.gasto - (st.gastoUltPuja || 0) > 0.01) { st.ultPuja = ahora; st.gastoUltPuja = dia.gasto; sucios.add(s.id); continue; }
        const actual = parseInt(s.bid_amount), nv = actual + Math.round(Rp.puja.paso * kUsd * 100);
        acciones.push({ ...base, nivel: "adset", id: s.id, nombre: s.name, accion: "puja", campo: "bid_amount", antes: actual, despues: nv, regla: `Bid/cost cap: sin gasto en ${Rp.puja.cada} min y el día lleva ${dia.gasto} USD (< ${Rp.puja.gastoFijo})`, datos: { dia }, post: () => { st.ultPuja = ahora; st.gastoUltPuja = dia.gasto; sucios.add(s.id); } });
      }

      for (const u of unidades) {
        const n = u.nodo, st = nuevo(n.id), Ru = resolver(R, u.ctx);
        if (st.fecha !== fecha) { Object.assign(st, { fecha, subidas: 0, bajadas: 0, ultSubida: 0, ultBajada: 0, empuje: false, cierre: false, enPiso: false, pisoVisto: 0 }); sucios.add(n.id); }
        if (st.piso == null) { st.piso = u.budget; st.puesto = u.budget; sucios.add(n.id); }
        if (st.puesto != null && Math.abs(u.budget - st.puesto) > 1) {
          acciones.push({ ...base, nivel: u.tipo, id: n.id, nombre: n.name, accion: "manual", antes: st.puesto, despues: u.budget, regla: "Cambio manual detectado: pasa a ser el nuevo punto de partida y piso", datos: {}, soloRegistro: true });
          st.piso = u.budget; st.puesto = u.budget; st.enPiso = false; sucios.add(n.id);
        }
        // Adset nuevo en una CBO: +N CPA al presupuesto de la campaña apenas arranca, una sola vez por conjunto.
        if (u.tipo === "campaign") {
          let suma = 0;
          for (const s of setsActivos) {
            const N = resolver(R, ctxDe([s])).nuevos, sst = nuevo(s.id);
            if (!N || sst.nuevoAplicado) continue;
            const ini = Date.parse(s.start_time || s.created_time || "");
            if (!isFinite(ini) || ini > ahora || hoyEn(tz, ini) !== fecha) continue;
            const marcado = String(s.name || "").toUpperCase().includes(N.etiqueta.toUpperCase());
            const mc = mediosDeCamp[camp.id] || {};
            const propios = [...(AD[s.id]?.medios || [])].filter(m => ![...(mc[m] || [])].some(o => o !== s.id));
            if (!marcado && !(N.creativo && propios.length)) continue;
            const m7 = met("c", camp.id, ahora - N.cpaDias * 86400000, true);
            let cpaN = m7.ventas >= 1 ? m7.gasto / m7.ventas : null, fuente = `CPA real de la campaña en ${N.cpaDias} días (${m7.gasto} USD ÷ ${m7.ventas} ventas)`;
            if (!cpaN) { cpaN = N.ticket ?? ticketPrincipal; fuente = N.ticket ? `sin ventas en ${N.cpaDias} días: ticket configurado` : `sin ventas en ${N.cpaDias} días: ticket del producto principal (mediana de las ventas recientes)`; }
            const motivo = marcado ? `tiene "${N.etiqueta}" en el nombre` : `creativo nuevo en la campaña (${propios.slice(0, 3).join(", ")})`;
            const datosA = { adset_nuevo: { id: s.id, nombre: s.name, inicio: s.start_time || null, motivo }, cpa_usado: cpaN ? r2(cpaN) : null, cpa_fuente: fuente, cpas: N.cpas };
            if (!cpaN || !kUsd) {
              if (sst.nuevoAviso !== fecha) { sst.nuevoAviso = fecha; sucios.add(s.id); acciones.push({ ...base, nivel: "adset", id: s.id, nombre: s.name, accion: "aviso", regla: `Adset nuevo detectado, pero no hay ${!kUsd ? "cotización de la moneda de la cuenta" : "CPA ni ticket"}: no se subió el presupuesto`, datos: datosA, soloRegistro: true }); }
              continue;
            }
            const extra = Math.round(cpaN * N.cpas * kUsd * 100), antes = u.budget + suma, nv = antes + extra;
            acciones.push({ ...base, nivel: "campaign", id: n.id, nombre: n.name, accion: "presupuesto", campo: "daily_budget", antes, despues: nv, puestoSim: u.budget,
              regla: `Adset nuevo «${s.name}» arrancó (${motivo}): +${N.cpas} CPA = ${r2(cpaN * N.cpas)} USD`, datos: { ...datosA, presupuesto_antes: antes / 100, presupuesto_despues: nv / 100, piso: st.piso / 100 },
              post: () => { sst.nuevoAplicado = new Date(ahora).toISOString(); sucios.add(s.id); st.puesto = nv; if (N.subePiso && !simular) st.piso = (st.piso || 0) + extra; sucios.add(n.id); } });
            suma += extra;
          }
          // Esta vuelta no aplica otras reglas a la campaña; desde la próxima corren sobre el presupuesto nuevo.
          if (suma) continue;
        }
        // Un conjunto con tope que todavía no llegó al gasto mínimo no entra en las reglas comunes.
        if (u.tipo === "adset" && u.caps.length && !capsFijos.has(n.id)) continue;
        if (slot < Ru.horario.desde || slot > Ru.horario.hasta) continue;
        vuelta.evaluadas++;
        const dia = met(u.nivel, n.id, iniDia);
        const w2 = Ru.bajada ? met(u.nivel, n.id, ahora - Ru.bajada.ventana * 60000) : null;
        const w4 = Ru.media ? met(u.nivel, n.id, ahora - Ru.media.ventana * 60000) : null;
        const dias = Ru.pausa?.dias ? met(u.nivel, n.id, ahora - Ru.pausa.dias * 86400000, true) : null;
        const datosN = { dia, ultimas_2h: w2, ultimas_4h: w4, cpa_ref: cpa != null ? r2(cpa) : null, presupuesto: u.budget / 100, piso: st.piso / 100 };
        // Cambia el presupuesto ±pct (nunca debajo del piso); `extra(nv)` corre si Meta lo aceptó.
        const mover = (pct, regla, extra) => {
          const nv = Math.max(st.piso, Math.round(u.budget * (1 + pct / 100)));
          if (nv === u.budget) return false;
          acciones.push({ ...base, nivel: u.tipo, id: n.id, nombre: n.name, accion: "presupuesto", campo: "daily_budget", antes: u.budget, despues: nv, regla, datos: datosN, post: () => { st.puesto = nv; extra?.(nv); sucios.add(n.id); } });
          for (const s of u.caps.filter(s => capsFijos.has(s.id))) { const b = parseInt(s.bid_amount), nb = Math.max(1, Math.round(b * (1 + pct / 100))); if (nb !== b) acciones.push({ ...base, nivel: "adset", id: s.id, nombre: s.name, accion: "puja", campo: "bid_amount", antes: b, despues: nb, regla: `${regla} (tope del conjunto, mismo %)`, datos: datosN }); }
          return true;
        };
        // ventana(sid) = métricas del conjunto en la misma ventana que disparó la pausa.
        const pausar = (regla, ventana = (sid) => met("s", sid, iniDia), roasMal = Ru.bajada?.roas ?? 1.4) => {
          // En una CBO se pausa el conjunto malo; la campaña solo si todos vienen mal.
          if (u.tipo === "campaign") {
            const malos = setsActivos.filter(s => { const m = ventana(s.id); return m.gasto > 0 && (m.roas ?? 0) < roasMal; });
            if (malos.length && malos.length < setsActivos.length) { for (const s of malos) acciones.push({ ...base, nivel: "adset", id: s.id, nombre: s.name, accion: "pausar", antes: "ACTIVE", despues: "PAUSED", regla: `${regla} → se pausa el conjunto malo`, datos: { ...datosN, conjunto: ventana(s.id) } }); return; }
            if (!malos.length) { acciones.push({ ...base, nivel: "campaign", id: n.id, nombre: n.name, accion: "aviso", regla: `${regla}, pero ningún conjunto se destaca como malo: no se pausó`, datos: datosN, soloRegistro: true }); return; }
          }
          acciones.push({ ...base, nivel: u.tipo, id: n.id, nombre: n.name, accion: "pausar", antes: "ACTIVE", despues: "PAUSED", regla, datos: datosN });
        };
        const enPico = Ru.subida?.pico.some(([a, b]) => slot >= a && slot < b);
        const enMedia = Ru.media && dia.roas != null && dia.roas >= Ru.media.desde && dia.roas < Ru.media.hasta;

        // Pausa por los últimos N días.
        if (dias && cpa != null && dias.gasto >= Ru.pausa.diasCpa * cpa && (dias.roas ?? 0) < Ru.pausa.diasRoas) { pausar(`Últimos ${Ru.pausa.dias} días ROAS ${dias.roas ?? 0} < ${Ru.pausa.diasRoas} con ${dias.gasto} USD gastados (≥ ${Ru.pausa.diasCpa} CPA)`, (sid) => met("s", sid, ahora - Ru.pausa.dias * 86400000, true), Ru.pausa.diasRoas); continue; }
        // Pausa: llegó al piso y en el chequeo siguiente sigue mal.
        if (Ru.pausa?.piso && Ru.bajada && st.enPiso && st.pisoVisto && st.pisoVisto < ahora - 60000 && w2.gasto > 0 && (w2.roas ?? 0) < Ru.bajada.roas) { pausar(`Llegó al piso y sigue con ROAS ${w2.roas ?? 0} < ${Ru.bajada.roas}`); continue; }
        // Cierre del día.
        if (Ru.cierre && slot === Ru.cierre.hora && !st.cierre) {
          st.cierre = true; sucios.add(n.id);
          if (st.subidas > Ru.cierre.subidasMas && (!Ru.cierre.sinBajadas || !st.bajadas) && mover(-Ru.cierre.pct, `Cierre ${hhmm(Ru.cierre.hora)}: ${st.subidas} subidas y ${st.bajadas} bajadas en el día`)) continue;
        }
        if (slot >= Ru.horario.hasta) continue;
        // Bajada (en zona media se mira la ventana larga).
        const wB = enMedia ? w4 : w2;
        if (Ru.bajada && wB && wB.gasto > 0 && (wB.roas ?? 0) < Ru.bajada.roas && cpa != null && dia.gasto >= Ru.bajada.minCpa * cpa && (!st.ultBajada || ahora - st.ultBajada >= Ru.bajada.enfriar * 60000 - 90000)) {
          if (u.budget > st.piso) {
            const bajadasN = (st.bajadas || 0) + 1;
            if (mover(-Ru.bajada.pct, `Bajada: ROAS de las últimas ${(enMedia ? Ru.media.ventana : Ru.bajada.ventana) / 60} h ${wB.roas ?? 0} < ${Ru.bajada.roas}`,
              (nv) => { st.bajadas = bajadasN; st.ultBajada = ahora; st.enPiso = nv <= st.piso; st.pisoVisto = st.enPiso ? ahora : 0; })) {
              if (Ru.pausa?.bajadas && bajadasN >= Ru.pausa.bajadas) pausar(`${bajadasN} bajadas en el día`);
              continue;
            }
          }
        }
        // Subidas.
        if (Ru.subida) {
          const cada = (enPico ? Ru.subida.cadaPico : Ru.subida.cada) * 60000 - 90000;
          let regla = null;
          if (!st.subidas) { if (dia.ventas >= Ru.subida.ventas && (dia.roas ?? 0) >= Ru.subida.roas) regla = `Subida: ROAS del día ${dia.roas} ≥ ${Ru.subida.roas} con ${dia.ventas} ventas`; }
          else if (ahora - st.ultSubida >= cada) {
            const t = met(u.nivel, n.id, st.ultSubida);
            if (t.ventas >= Ru.subida.ventas && (t.roas ?? 0) >= Ru.subida.roas) regla = `Subida${enPico ? " (hora pico)" : ""}: desde la última subida ${t.ventas} ventas con ROAS ${t.roas}`;
          }
          if (!regla && enMedia && w4.ventas >= Ru.subida.ventas && (w4.roas ?? 0) >= Ru.subida.roas && (!st.ultSubida || ahora - st.ultSubida >= cada)) regla = `Zona media → subida: ROAS de las últimas ${Ru.media.ventana / 60} h ${w4.roas} ≥ ${Ru.subida.roas}`;
          const topeOk = !Ru.subida.tope || u.budget < st.piso * (1 + Ru.subida.tope / 100);
          if (regla && topeOk && mover(Ru.subida.pct, regla, () => { st.subidas = (st.subidas || 0) + 1; st.ultSubida = ahora; st.enPiso = false; })) continue;
        }
        // Zona media: empujón una vez por día.
        if (enMedia && slot === Ru.media.hora && !st.empuje) {
          if (!mover(Ru.media.pct, `Zona media: ROAS del día ${dia.roas} entre ${Ru.media.desde} y ${Ru.media.hasta}, empujón de las ${hhmm(Ru.media.hora)}`, () => { st.empuje = true; })) { st.empuje = true; sucios.add(n.id); }
        }
      }
    }
  }

  // 4) Aplicar (o simular) y registrar.
  const logRef = uRef.collection("meta_escala_log");
  const yaPausados = new Set();
  for (const a of acciones) {
    if (a.accion === "pausar") { if (yaPausados.has(a.id)) continue; yaPausados.add(a.id); }
    let ok = true, error = null;
    if (!a.soloRegistro && !simular) {
      try {
        if (!a.tok) throw new Error("sin token con ads_management para esta cuenta");
        await metaPost(a.id, a.accion === "pausar" ? { status: "PAUSED" } : { [a.campo]: String(a.despues) }, a.tok);
      } catch (e) { ok = false; error = e.message; }
    }
    if (ok && !a.soloRegistro) { a.post?.(); if (simular && a.accion === "presupuesto" && EST[a.id]) EST[a.id].puesto = a.puestoSim ?? a.antes; }
    if (!a.soloRegistro && ok) vuelta.cambios++;
    if (error) vuelta.errores.push(`${a.nombre}: ${error}`);
    const enMoneda = a.campo ? { antes: a.antes / 100, despues: a.despues / 100 } : { antes: a.antes ?? null, despues: a.despues ?? null };
    const fila = { ts: new Date(ahora).toISOString(), vuelta: vueltaId, cuenta: a.cuenta, cuenta_id: a.cuenta_id, campana: a.campana, campana_id: a.campana_id, nivel: a.nivel, id: a.id, nombre: a.nombre,
      accion: a.accion, ...enMoneda, pct: a.campo && a.antes ? r2((a.despues - a.antes) / a.antes * 100) : null, regla: a.regla, datos: a.datos || {}, hora_local: a.hora_local, zona: a.tz,
      simulado: simular && !a.soloRegistro, ok, error };
    if (prueba) (vuelta.acciones = vuelta.acciones || []).push(fila); else await logRef.add(fila).catch(() => {});
  }
  if (!prueba) await Promise.all([...sucios].map(id => uRef.collection("meta_escala_estado").doc(id).set(EST[id], { merge: true }).catch(() => {})));
  vuelta.ultima_venta = V.ultima ? new Date(V.ultima).toISOString() : null;
  return cerrar();
}

// ── Resumen diario (21:30 hora Argentina) ──
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
export async function cronEscala(db, { deadline = Date.now() + 270000 } = {}) {
  const idx = (await db.collection("system").doc("meta_escala").get()).data()?.uids || {};
  const uids = Object.keys(idx).filter(u => idx[u]);
  const ahora = Math.floor(Date.now() / 60000) * 60000;
  const out = [];
  for (let i = 0; i < uids.length && Date.now() < deadline; i += 4) {
    out.push(...await Promise.all(uids.slice(i, i + 4).map(async uid => {
      try { const v = await correrEscala(db, uid, { ahora }); return { uid, cambios: v.cambios, saltada: v.saltada, errores: v.errores.length }; }
      catch (e) { await db.collection("users").doc(uid).collection("meta_escala_vueltas").doc(new Date(ahora).toISOString().slice(0, 16)).set({ ts: new Date(ahora).toISOString(), errores: [e.message], saltada: "la vuelta falló: no tocó nada" }).catch(() => {}); return { uid, error: e.message }; }
    })));
  }
  // 21:30 hora Argentina: resumen del día.
  const mArt = minutosLocal(ahora, ART);
  if (mArt >= 1290 && mArt < 1305) for (const uid of uids) await resumenDiario(db, uid, hoyEn(ART, ahora)).catch(() => {});
  return { tiendas: uids.length, resultados: out };
}
