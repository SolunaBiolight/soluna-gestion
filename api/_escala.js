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

// ── Config de reglas: lo que sale de la IA se limpia acá (bloque null = regla apagada) ──
export function normalizarReglas(x = {}) {
  const b = (o) => o && typeof o === "object" && o.activo !== false;
  const R = {
    horario: { desde: aMin(x.horario?.desde, 360), hasta: aMin(x.horario?.hasta, 1260) },
    subida: b(x.subida) ? { roas: num(x.subida.roas_min, 1.9), ventas: num(x.subida.ventas_min, 2), pct: num(x.subida.pct, 15), cada: num(x.subida.cada_min, 120),
      pico: (Array.isArray(x.subida.pico) ? x.subida.pico : []).map(p => [aMin(p?.desde, null), aMin(p?.hasta, null)]).filter(p => p[0] != null && p[1] != null), cadaPico: num(x.subida.cada_min_pico, 15), tope: x.subida.tope_pct_dia != null ? num(x.subida.tope_pct_dia, null) : null } : null,
    puja: b(x.puja) ? { espera: aMin(x.puja.desde, 390), paso: num(x.puja.paso_usd, 0.5), cada: num(x.puja.cada_min, 30), gastoFijo: num(x.puja.gasto_fijo_usd, 10) } : null,
    bajada: b(x.bajada) ? { roas: num(x.bajada.roas_max, 1.4), ventana: num(x.bajada.ventana_min, 120), pct: num(x.bajada.pct, 15), minCpa: num(x.bajada.min_cpa_gastado, 1), enfriar: num(x.bajada.enfriar_min, 120) } : null,
    media: b(x.zona_media) ? { desde: num(x.zona_media.roas_desde, 1.4), hasta: num(x.zona_media.roas_hasta, 1.9), pct: num(x.zona_media.empuje_pct, 10), hora: aMin(x.zona_media.empuje_hora, 600), ventana: num(x.zona_media.ventana_salida_min, 240) } : null,
    cierre: b(x.cierre) ? { hora: aMin(x.cierre.hora, 1260), subidasMas: num(x.cierre.subidas_mas_de, 4), sinBajadas: x.cierre.sin_bajadas !== false, pct: num(x.cierre.pct, 15) } : null,
    pausa: b(x.pausa) ? { bajadas: x.pausa.bajadas != null ? num(x.pausa.bajadas, null) : null, piso: x.pausa.piso_y_malo !== false, dias: x.pausa.dias != null ? num(x.pausa.dias, null) : null, diasRoas: num(x.pausa.dias_roas_max, 1.4), diasCpa: num(x.pausa.dias_min_cpa, 3) } : null,
    excepciones: { horas: num(x.excepciones?.min_horas_desde_inicio, 24), etiqueta: String(x.excepciones?.etiqueta_manual || "[MANUAL]").slice(0, 40) },
    caidas: (Array.isArray(x.caidas) ? x.caidas : []).map(c => ({ desde: aMin(c?.desde, null), hasta: aMin(c?.hasta, null), tz: PAIS_TZ[String(c?.pais || "").toUpperCase()] || ART })).filter(c => c.desde != null && c.hasta != null).slice(0, 10),
  };
  for (const k of ["pct"]) { if (R.subida) R.subida[k] = Math.min(100, Math.max(1, R.subida[k])); if (R.bajada) R.bajada[k] = Math.min(90, Math.max(1, R.bajada[k])); }
  return R;
}

// La misma config, en filas para mostrar (Growith y MCP muestran exactamente esto).
export function tablaReglas(R) {
  const h = `${hhmm(R.horario.desde)} a ${hhmm(R.horario.hasta)} (hora local del país)`;
  const nivel = "CBO: presupuesto de la campaña · ABO: de cada conjunto · con bid/cost cap también el tope";
  const f = [];
  if (R.subida) {
    f.push({ regla: "Subida", condicion: `ROAS del día ≥ ${R.subida.roas} y ≥ ${R.subida.ventas} ventas en el día (primera del día)`, accion: `+${R.subida.pct} % de presupuesto`, nivel, horario: h });
    f.push({ regla: "Subida", condicion: `Cada ${R.subida.cada} min (${R.subida.pico.length ? `cada ${R.subida.cadaPico} min en ${R.subida.pico.map(p => `${hhmm(p[0])}–${hhmm(p[1])}`).join(" y ")}` : "sin horas pico"}): desde la última subida ≥ ${R.subida.ventas} ventas con ROAS ≥ ${R.subida.roas}`, accion: `+${R.subida.pct} %${R.subida.tope ? `, tope +${R.subida.tope} % en el día` : ", sin tope"}`, nivel, horario: h });
  }
  if (R.puja) f.push({ regla: "Bid / cost cap", condicion: `Desde las ${hhmm(R.puja.espera)}, si el conjunto no gastó en los últimos ${R.puja.cada} min y el día lleva < ${R.puja.gastoFijo} USD`, accion: `+${R.puja.paso} USD al tope cada ${R.puja.cada} min; con ≥ ${R.puja.gastoFijo} USD gastados el tope queda fijo y siguen las reglas comunes`, nivel: "Conjunto con bid cap o cost cap", horario: h });
  if (R.bajada) f.push({ regla: "Bajada", condicion: `ROAS de las últimas ${R.bajada.ventana / 60} h < ${R.bajada.roas}, con ≥ ${R.bajada.minCpa} CPA gastado en el día y sin otra bajada en ${R.bajada.enfriar / 60} h`, accion: `−${R.bajada.pct} %, nunca por debajo del piso (presupuesto con el que arrancó o el último puesto a mano)`, nivel, horario: h });
  if (R.media) f.push({ regla: "Zona media", condicion: `ROAS del día entre ${R.media.desde} y ${R.media.hasta}`, accion: `Se mantiene; +${R.media.pct} % una vez a las ${hhmm(R.media.hora)}. Si el ROAS de las últimas ${R.media.ventana / 60} h sale de la franja, aplica subida o bajada`, nivel, horario: h });
  if (R.cierre) f.push({ regla: "Cierre", condicion: `A las ${hhmm(R.cierre.hora)}: más de ${R.cierre.subidasMas} subidas en el día${R.cierre.sinBajadas ? " y ninguna bajada" : ""}`, accion: `−${R.cierre.pct} %`, nivel, horario: `${hhmm(R.cierre.hora)} local` });
  if (R.pausa) {
    const c = [];
    if (R.pausa.bajadas) c.push(`${R.pausa.bajadas} bajadas en el día`);
    if (R.pausa.piso) c.push("llegó al piso y en el chequeo siguiente sigue con ROAS bajo");
    if (R.pausa.dias) c.push(`últimos ${R.pausa.dias} días con ROAS < ${R.pausa.diasRoas} habiendo gastado ≥ ${R.pausa.diasCpa} CPA`);
    if (c.length) f.push({ regla: "Pausa", condicion: c.join(" · o "), accion: "Pausar (en CBO el conjunto malo; la campaña solo si todos vienen mal). Nunca se reactiva nada", nivel: "Campaña o conjunto", horario: h });
  }
  f.push({ regla: "Excepciones", condicion: `Menos de ${R.excepciones.horas} h desde que arrancó · "${R.excepciones.etiqueta}" en el nombre · pausado a mano`, accion: "No se toca", nivel: "Campaña o conjunto", horario: "Siempre" });
  for (const c of R.caidas) f.push({ regla: "Caída de Impultienda", condicion: `${hhmm(c.desde)} a ${hhmm(c.hasta)} (${c.tz === ART ? "hora Argentina" : c.tz})`, accion: "La vuelta no toca nada", nivel: "Todo", horario: `${hhmm(c.desde)}–${hhmm(c.hasta)}` });
  f.push({ regla: "Definiciones", condicion: "ROAS = facturación real cobrada (principal + bumps + post-compra, USD) ÷ gasto de Meta (USD). CPA de referencia = el de la campaña en 5 días si tiene 3+ ventas, si no el promedio de todas", accion: "—", nivel: "—", horario: "—" });
  return f;
}

const SISTEMA_IA = `Convertís reglas de escala de Meta Ads escritas por un usuario en un JSON EXACTO con esta forma (todas las horas "HH:MM" en hora local del país de cada campaña salvo caidas; porcentajes como número, 15 = 15 %). Si una regla no aparece en el texto, poné ese bloque en null. No inventes reglas que el usuario no escribió.
{
 "horario": {"desde":"06:00","hasta":"21:00"},
 "subida": {"roas_min":1.9,"ventas_min":2,"pct":15,"cada_min":120,"pico":[{"desde":"10:00","hasta":"12:00"}],"cada_min_pico":15,"tope_pct_dia":null} | null,
 "puja": {"desde":"06:30","paso_usd":0.5,"cada_min":30,"gasto_fijo_usd":10} | null,
 "bajada": {"roas_max":1.4,"ventana_min":120,"pct":15,"min_cpa_gastado":1,"enfriar_min":120} | null,
 "zona_media": {"roas_desde":1.4,"roas_hasta":1.9,"empuje_pct":10,"empuje_hora":"10:00","ventana_salida_min":240} | null,
 "cierre": {"hora":"21:00","subidas_mas_de":4,"sin_bajadas":true,"pct":15} | null,
 "pausa": {"bajadas":6,"piso_y_malo":true,"dias":4,"dias_roas_max":1.4,"dias_min_cpa":3} | null,
 "excepciones": {"min_horas_desde_inicio":24,"etiqueta_manual":"[MANUAL]"},
 "caidas": [{"desde":"03:00","hasta":"04:30","pais":"AR"}],
 "no_entendido": ["frases del usuario que no encajan en ningún campo"]
}
Detalles: "cada_min" es cada cuánto se permite una nueva subida; "pico" son las horas en que ese intervalo pasa a "cada_min_pico"; "tope_pct_dia" null si dice "sin tope". En "pausa", cada condición que no esté va en null (o false para piso_y_malo). "caidas" son ventanas en que no se toca nada; "pais" es el código del país de esa hora (AR si dice ARG). Respondé SOLO el JSON.`;

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
    ventas.push({ t, usd: aUsd(Number(o.total) || 0, o.moneda, fx) ?? 0, n: o.post_compra ? 0 : 1, c: x?.c || null, s: x?.s || null, tienda: o.store_id || null, pais: paisDeUtm(o.utm) || null });
  }
  return { ventas, tiendas, ultima, fx };
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
  const impCfg = (await uRef.collection("impultienda_cfg").doc("main").get()).data() || {};
  const { cuentas, errores } = await cuentasDe(db, uid, impCfg.metaCuentas || []);
  vuelta.errores.push(...errores);
  if (!cuentas.length) vuelta.errores.push("No hay cuentas publicitarias de Meta para recorrer.");
  const sinEdicion = cuentas.filter(c => !c.tokEdita).map(c => c.nombre);
  if (sinEdicion.length && !simular) vuelta.errores.push(`Sin token con ads_management para: ${sinEdicion.join(", ")}`);

  // 1) Leer TODO antes de decidir nada.
  let V;
  try { V = await ventasRecientes(db, uid, impCfg, 6); } catch (e) { vuelta.errores.push(`Ventas de Impultienda: ${e.message}`); }
  const datos = [];
  await Promise.all(cuentas.map(async c => {
    const tzC = c.tz || "America/Los_Angeles", hoyC = hoyEn(tzC, ahora);
    const activo = JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]);
    try {
      const [camps, sets, horas, dias] = await Promise.all([
        metaTodo(`${c.id}/campaigns`, { fields: "id,name,effective_status,daily_budget,lifetime_budget,bid_strategy,start_time,created_time", filtering: activo, limit: "200" }, c.tokLee, 10),
        metaTodo(`${c.id}/adsets`, { fields: "id,name,campaign_id,effective_status,daily_budget,lifetime_budget,bid_strategy,bid_amount,start_time,created_time", filtering: activo, limit: "300" }, c.tokLee, 10),
        metaTodo(`${c.id}/insights`, { level: "adset", fields: "adset_id,campaign_id,spend", time_increment: "1", breakdowns: "hourly_stats_aggregated_by_advertiser_time_zone", time_range: JSON.stringify({ since: sumaDias(hoyC, -1), until: hoyC }), limit: "500" }, c.tokLee, 40),
        metaTodo(`${c.id}/insights`, { level: "adset", fields: "adset_id,campaign_id,spend", time_increment: "1", time_range: JSON.stringify({ since: sumaDias(hoyC, -5), until: hoyC }), limit: "500" }, c.tokLee, 20),
      ]);
      datos.push({ c, tzC, hoyC, camps, sets, horas, dias });
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
  // CPA de referencia.
  let gTot = 0, nTot = 0;
  for (const l of Object.values(gD)) for (const [, u] of l) gTot += u;
  for (const v of V.ventas) if (v.c) nTot += v.n;
  const cpaGlobal = nTot ? gTot / nTot : null;
  const cpaDe = (campId) => { const m = met("c", campId, ahora - 5 * 86400000, true); return m.ventas >= 3 ? m.gasto / m.ventas : cpaGlobal; };
  // País (zona) de cada campaña: la tienda donde más vende, o el código del nombre.
  const tiendaTop = {};
  for (const v of V.ventas) if (v.c && v.tienda) { const m = tiendaTop[v.c] || (tiendaTop[v.c] = {}); m[v.tienda] = (m[v.tienda] || 0) + 1; }
  const tzDe = (camp, tzC) => {
    const top = Object.entries(tiendaTop[camp.id] || {}).sort((a, b) => b[1] - a[1])[0];
    const p = top && String(V.tiendas[top[0]]?.pais || "").toUpperCase().split(/[^A-Z]+/)[0];
    if (p && PAIS_TZ[p]) return PAIS_TZ[p];
    const cod = String(camp.name || "").toUpperCase().split(/[^A-Z]+/).find(w => w.length === 2 && PAIS_TZ[w]);
    return cod ? PAIS_TZ[cod] : tzC;
  };

  // 3) Estado y decisiones.
  const estSnap = await uRef.collection("meta_escala_estado").get();
  const EST = Object.fromEntries(estSnap.docs.map(d => [d.id, d.data()]));
  const sucios = new Set();
  const acciones = [];
  const nuevo = (id) => EST[id] || (EST[id] = {});
  const viejo = (n) => ahora - Math.max(Date.parse(n.start_time || "") || 0, Date.parse(n.created_time || "") || 0) < R.excepciones.horas * 3600000;
  const manual = (n) => String(n.name || "").toUpperCase().includes(R.excepciones.etiqueta.toUpperCase());

  for (const d of datos) {
    const setsPorId = Object.fromEntries(d.sets.map(s => [s.id, s]));
    const kUsd = String(d.c.moneda || "USD").toUpperCase() === "USD" ? 1 : Number(V.fx?.[String(d.c.moneda).toUpperCase()]) || null;
    for (const camp of d.camps) {
      if (manual(camp) || viejo(camp)) continue;
      const tz = tzDe(camp, d.tzC), fecha = hoyEn(tz, ahora);
      const slot = Math.round(minutosLocal(ahora, tz) / 15) * 15;
      const iniDia = utcDeLocal(fecha, 0, tz);
      const cpa = cpaDe(camp.id);
      const esCBO = parseInt(camp.daily_budget) > 0;
      const setsActivos = (setsDeCamp[camp.id] || []).map(id => setsPorId[id]).filter(Boolean).filter(s => !manual(s));
      const unidades = esCBO ? [{ nodo: camp, nivel: "c", tipo: "campaign", budget: parseInt(camp.daily_budget), caps: setsActivos.filter(s => CAPS.includes(s.bid_strategy) && parseInt(s.bid_amount) > 0) }]
        : setsActivos.filter(s => parseInt(s.daily_budget) > 0 && !viejo(s)).map(s => ({ nodo: s, nivel: "s", tipo: "adset", budget: parseInt(s.daily_budget), caps: CAPS.includes(s.bid_strategy) && parseInt(s.bid_amount) > 0 ? [s] : [] }));
      const base = { cuenta: d.c.nombre, cuenta_id: d.c.id, campana: camp.name, campana_id: camp.id, tz, hora_local: hhmm(slot % 1440), tok: d.c.tokEdita };

      // Bid / cost cap: subir el tope hasta que el día gaste lo mínimo; después queda fijo.
      const capsFijos = new Set();
      for (const s of setsActivos.filter(s => CAPS.includes(s.bid_strategy) && parseInt(s.bid_amount) > 0 && !viejo(s))) {
        const st = nuevo(s.id);
        if (st.fechaPuja !== fecha) Object.assign(st, { fechaPuja: fecha, topeFijo: false, ultPuja: 0, gastoUltPuja: 0 }), sucios.add(s.id);
        const dia = met("s", s.id, iniDia);
        if (!R.puja || st.topeFijo || dia.gasto >= R.puja.gastoFijo) { if (R.puja && !st.topeFijo && dia.gasto >= R.puja.gastoFijo) { st.topeFijo = true; sucios.add(s.id); } capsFijos.add(s.id); continue; }
        if (slot < R.puja.espera || slot >= R.horario.hasta || !kUsd) continue;
        if (st.ultPuja && ahora - st.ultPuja < R.puja.cada * 60000 - 90000) continue;
        if (st.ultPuja && dia.gasto - (st.gastoUltPuja || 0) > 0.01) { st.ultPuja = ahora; st.gastoUltPuja = dia.gasto; sucios.add(s.id); continue; }
        const actual = parseInt(s.bid_amount), nv = actual + Math.round(R.puja.paso * kUsd * 100);
        acciones.push({ ...base, nivel: "adset", id: s.id, nombre: s.name, accion: "puja", campo: "bid_amount", antes: actual, despues: nv, regla: `Bid/cost cap: sin gasto en ${R.puja.cada} min y el día lleva ${dia.gasto} USD (< ${R.puja.gastoFijo})`, datos: { dia }, post: () => { st.ultPuja = ahora; st.gastoUltPuja = dia.gasto; sucios.add(s.id); } });
      }

      for (const u of unidades) {
        const n = u.nodo, st = nuevo(n.id);
        if (st.fecha !== fecha) { Object.assign(st, { fecha, subidas: 0, bajadas: 0, ultSubida: 0, ultBajada: 0, empuje: false, cierre: false, enPiso: false, pisoVisto: 0 }); sucios.add(n.id); }
        if (st.piso == null) { st.piso = u.budget; st.puesto = u.budget; sucios.add(n.id); }
        if (st.puesto != null && Math.abs(u.budget - st.puesto) > 1) {
          acciones.push({ ...base, nivel: u.tipo, id: n.id, nombre: n.name, accion: "manual", antes: st.puesto, despues: u.budget, regla: "Cambio manual detectado: pasa a ser el nuevo punto de partida y piso", datos: {}, soloRegistro: true });
          st.piso = u.budget; st.puesto = u.budget; st.enPiso = false; sucios.add(n.id);
        }
        // Un conjunto con tope que todavía no llegó al gasto mínimo no entra en las reglas comunes.
        if (u.tipo === "adset" && u.caps.length && !capsFijos.has(n.id)) continue;
        if (slot < R.horario.desde || slot > R.horario.hasta) continue;
        vuelta.evaluadas++;
        const dia = met(u.nivel, n.id, iniDia);
        const w2 = R.bajada ? met(u.nivel, n.id, ahora - R.bajada.ventana * 60000) : null;
        const w4 = R.media ? met(u.nivel, n.id, ahora - R.media.ventana * 60000) : null;
        const dias = R.pausa?.dias ? met(u.nivel, n.id, ahora - R.pausa.dias * 86400000, true) : null;
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
        const pausar = (regla, ventana = (sid) => met("s", sid, iniDia), roasMal = R.bajada?.roas ?? 1.4) => {
          // En una CBO se pausa el conjunto malo; la campaña solo si todos vienen mal.
          if (u.tipo === "campaign") {
            const malos = setsActivos.filter(s => { const m = ventana(s.id); return m.gasto > 0 && (m.roas ?? 0) < roasMal; });
            if (malos.length && malos.length < setsActivos.length) { for (const s of malos) acciones.push({ ...base, nivel: "adset", id: s.id, nombre: s.name, accion: "pausar", antes: "ACTIVE", despues: "PAUSED", regla: `${regla} → se pausa el conjunto malo`, datos: { ...datosN, conjunto: ventana(s.id) } }); return; }
            if (!malos.length) { acciones.push({ ...base, nivel: "campaign", id: n.id, nombre: n.name, accion: "aviso", regla: `${regla}, pero ningún conjunto se destaca como malo: no se pausó`, datos: datosN, soloRegistro: true }); return; }
          }
          acciones.push({ ...base, nivel: u.tipo, id: n.id, nombre: n.name, accion: "pausar", antes: "ACTIVE", despues: "PAUSED", regla, datos: datosN });
        };
        const enPico = R.subida?.pico.some(([a, b]) => slot >= a && slot < b);
        const enMedia = R.media && dia.roas != null && dia.roas >= R.media.desde && dia.roas < R.media.hasta;

        // Pausa por los últimos N días.
        if (dias && cpa != null && dias.gasto >= R.pausa.diasCpa * cpa && (dias.roas ?? 0) < R.pausa.diasRoas) { pausar(`Últimos ${R.pausa.dias} días ROAS ${dias.roas ?? 0} < ${R.pausa.diasRoas} con ${dias.gasto} USD gastados (≥ ${R.pausa.diasCpa} CPA)`, (sid) => met("s", sid, ahora - R.pausa.dias * 86400000, true), R.pausa.diasRoas); continue; }
        // Pausa: llegó al piso y en el chequeo siguiente sigue mal.
        if (R.pausa?.piso && R.bajada && st.enPiso && st.pisoVisto && st.pisoVisto < ahora - 60000 && w2.gasto > 0 && (w2.roas ?? 0) < R.bajada.roas) { pausar(`Llegó al piso y sigue con ROAS ${w2.roas ?? 0} < ${R.bajada.roas}`); continue; }
        // Cierre del día.
        if (R.cierre && slot === R.cierre.hora && !st.cierre) {
          st.cierre = true; sucios.add(n.id);
          if (st.subidas > R.cierre.subidasMas && (!R.cierre.sinBajadas || !st.bajadas) && mover(-R.cierre.pct, `Cierre ${hhmm(R.cierre.hora)}: ${st.subidas} subidas y ${st.bajadas} bajadas en el día`)) continue;
        }
        if (slot >= R.horario.hasta) continue;
        // Bajada (en zona media se mira la ventana larga).
        const wB = enMedia ? w4 : w2;
        if (R.bajada && wB && wB.gasto > 0 && (wB.roas ?? 0) < R.bajada.roas && cpa != null && dia.gasto >= R.bajada.minCpa * cpa && (!st.ultBajada || ahora - st.ultBajada >= R.bajada.enfriar * 60000 - 90000)) {
          if (u.budget > st.piso) {
            const bajadasN = (st.bajadas || 0) + 1;
            if (mover(-R.bajada.pct, `Bajada: ROAS de las últimas ${(enMedia ? R.media.ventana : R.bajada.ventana) / 60} h ${wB.roas ?? 0} < ${R.bajada.roas}`,
              (nv) => { st.bajadas = bajadasN; st.ultBajada = ahora; st.enPiso = nv <= st.piso; st.pisoVisto = st.enPiso ? ahora : 0; })) {
              if (R.pausa?.bajadas && bajadasN >= R.pausa.bajadas) pausar(`${bajadasN} bajadas en el día`);
              continue;
            }
          }
        }
        // Subidas.
        if (R.subida) {
          const cada = (enPico ? R.subida.cadaPico : R.subida.cada) * 60000 - 90000;
          let regla = null;
          if (!st.subidas) { if (dia.ventas >= R.subida.ventas && (dia.roas ?? 0) >= R.subida.roas) regla = `Subida: ROAS del día ${dia.roas} ≥ ${R.subida.roas} con ${dia.ventas} ventas`; }
          else if (ahora - st.ultSubida >= cada) {
            const t = met(u.nivel, n.id, st.ultSubida);
            if (t.ventas >= R.subida.ventas && (t.roas ?? 0) >= R.subida.roas) regla = `Subida${enPico ? " (hora pico)" : ""}: desde la última subida ${t.ventas} ventas con ROAS ${t.roas}`;
          }
          if (!regla && enMedia && w4.ventas >= R.subida.ventas && (w4.roas ?? 0) >= R.subida.roas && (!st.ultSubida || ahora - st.ultSubida >= cada)) regla = `Zona media → subida: ROAS de las últimas ${R.media.ventana / 60} h ${w4.roas} ≥ ${R.subida.roas}`;
          const topeOk = !R.subida.tope || u.budget < st.piso * (1 + R.subida.tope / 100);
          if (regla && topeOk && mover(R.subida.pct, regla, () => { st.subidas = (st.subidas || 0) + 1; st.ultSubida = ahora; st.enPiso = false; })) continue;
        }
        // Zona media: empujón una vez por día.
        if (enMedia && slot === R.media.hora && !st.empuje) {
          if (!mover(R.media.pct, `Zona media: ROAS del día ${dia.roas} entre ${R.media.desde} y ${R.media.hasta}, empujón de las ${hhmm(R.media.hora)}`, () => { st.empuje = true; })) { st.empuje = true; sucios.add(n.id); }
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
    if (ok && !a.soloRegistro) { a.post?.(); if (simular && a.accion === "presupuesto" && EST[a.id]) EST[a.id].puesto = a.antes; }
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
