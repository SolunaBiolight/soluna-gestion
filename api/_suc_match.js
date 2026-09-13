// Núcleo de matcheo de sucursales Andreani — copia servidor del bloque
// GH_SUC_MATCH de src/App.jsx (funciones puras, misma lógica). El front no
// puede importar de /api ni al revés, así que viven dos copias y
// scripts/suc_match_test.cjs corre los mismos casos contra las DOS y exige
// que devuelvan lo mismo. Cambiá una → cambiá la otra → corré el test.
// No lo expone Vercel (empieza con "_", como _auth.js).

export const GH_SUC_GEN = new Set(["PUNTO","ANDREANI","HOP","PICKIT","SUCURSAL","RETIRO","ESPACIO","EXPRESO","AVENIDA","AVDA","AV","CALLE","DIAGONAL","DIAG","PASAJE","PJE","BOULEVARD","BULEVAR","BV","BLVD","RUTA","GENERAL","GRAL","DOCTOR","DR","PRESIDENTE","PTE","TENIENTE","TTE","CORONEL","CNEL","INGENIERO","ING","SANTA","STA","SANTO","STO","SAN","DE","DEL","LA","EL","LOS","LAS","Y","E","NRO","NUM","ALTURA","KM"]);

export function ghStripUnidad(s) {
  return String(s || "").replace(/[,\s]+ENTRE\s+\S[\s\S]*?\s+Y\s+[\s\S]*$/i, "").replace(/[,\s]+(LOCAL(?:ES)?|PISO|DPTO\.?|DEPTO\.?|DEPARTAMENTO|OFICINA|OF\.|UF|GALERIA|GALERÍA|TIMBRE|CASA|PB|E\/|ESQ\.?|ESQUINA)\b[\s\S]*$/i, "").trim();
}
export function ghNrmSuc(s) {
  return String(s || "").toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
export function ghDirParse(calle, numero) {
  let c = ghNrmSuc(ghStripUnidad(calle));
  const numRaw = String(numero || "").trim();
  let num = numRaw.replace(/\D.*/, "").trim();
  const m = c.match(/\b(\d{1,5})\s*$/);
  if (m && ((!numRaw && !num) || m[1] === num)) { num = num || m[1]; c = c.replace(/\b\d{1,5}\s*$/, "").trim(); }
  const toks = c.split(" ").filter(w => w && !GH_SUC_GEN.has(w) && (w.length >= 3 || /^\d+$/.test(w)));
  return { calle: c, num, toks, words: toks.filter(w => !/^\d+$/.test(w)), nums: toks.filter(w => /^\d+$/.test(w)) };
}
export function ghMismaCalle(a, b) {
  if (!a || !b) return false;
  if (a.words.length && b.words.length) {
    const [s, l] = a.words.length <= b.words.length ? [a.words, b.words] : [b.words, a.words];
    if (!s.every(w => l.includes(w))) return false;
    if (a.nums.length && b.nums.length && !a.nums.some(n => b.nums.includes(n))) return false;
    return true;
  }
  if (!a.words.length && !b.words.length && a.nums.length && b.nums.length) return a.nums.every(n => b.nums.includes(n)) || b.nums.every(n => a.nums.includes(n));
  return false;
}
const ghEsCaba = (loc, cp) => /\bC\s*A\s*B\s*A\b|CAPITAL FEDERAL|CIUDAD AUTONOMA|CIUDAD DE BUENOS AIRES/.test(ghNrmSuc(loc)) || /^1[0-4]\d\d$/.test(String(cp || "").replace(/\D/g, ""));
function ghLocToks(loc) { return ghNrmSuc(loc).split(" ").filter(w => w.length >= 4 && !GH_SUC_GEN.has(w)); }
export function ghMismaLoc(locA, locB) {
  const a = ghLocToks(locA), b = ghLocToks(locB);
  if (!a.length || !b.length) return null;
  return a.some(t => b.includes(t)) || b.some(t => a.includes(t));
}
export function ghPuntoDeOrden(o) {
  const pd = o?.pickupDetails;
  if (pd) return { nombre: pd.name || "", calle: pd.address?.address || "", num: pd.address?.number || "", loc: pd.address?.locality || pd.address?.city || "", cp: pd.address?.zipcode || pd.address?.zip_code || o?.cp || "", conPickup: true };
  if (!o || (!o.direccion && !o.localidad && !o.ciudad)) return null;
  return { nombre: "", calle: o.direccion || "", num: o.dirNumero || "", loc: o.localidad || o.ciudad || "", cp: o.cp || "", conPickup: false };
}
export function ghCmpPunto(p, suc) {
  const d = suc?.direccion || {};
  const a = ghDirParse(p?.calle, p?.num), b = ghDirParse(d.calle, d.numero);
  const calle = ghMismaCalle(a, b);
  return { a, b, calle, numIgual: !!(a.num && b.num && a.num === b.num), numDistinto: !!(a.num && b.num && a.num !== b.num) };
}
export function ghConflictoPunto(p, suc) {
  if (!p || !suc) return null;
  const d = suc.direccion || {};
  const c = ghCmpPunto(p, suc);
  const mismoDom = !!(c.calle && c.numIgual);
  const razones = []; let grave = false;
  if (c.calle && c.numDistinto) { razones.push(`es ${String(d.calle || "la misma calle").trim()} ${c.b.num}, no ${c.a.num}`); grave = true; }
  const cpP = String(p.cp || "").replace(/\D/g, ""), cpS = String(d.codigoPostal || "").replace(/\D/g, "");
  const locP = String(p.loc || "").trim(), locS = String(d.localidad || "").trim();
  const cabaP = ghEsCaba(locP, cpP), cabaS = ghEsCaba(locS, cpS);
  const mismaLoc = ghMismaLoc(locP, locS);
  if (cabaP !== cabaS && (locP || cpP) && (locS || cpS)) {
    razones.push(`está en ${locS || "otra localidad"}${cpS ? ` (CP ${cpS})` : ""} y el cliente eligió ${locP || "CABA"}${cpP ? ` (CP ${cpP})` : ""}`); grave = true;
  } else if (cpP && cpS && cpP !== cpS && !(cabaP && cabaS)) {
    if (mismoDom && mismaLoc === true) { razones.push(`Andreani lo registra con CP ${cpS} (el cliente eligió CP ${cpP})`); }
    else { razones.push(`${mismoDom ? "misma calle y número, pero " : ""}CP ${cpS}${locS ? ` (${locS})` : ""} y el cliente eligió CP ${cpP}${locP ? ` (${locP})` : ""}`); grave = true; }
  } else if (mismaLoc === false && !(cabaP && cabaS)) {
    razones.push(`figura en ${locS} y el cliente eligió ${locP}`);
    if (!mismoDom && !(cpP && cpS && cpP === cpS)) grave = true;
  }
  return razones.length ? { msg: razones.join(" · "), grave, mismoDom } : null;
}
export function ghCoincidePunto(p, suc) {
  if (!p || !suc) return false;
  const c = ghCmpPunto(p, suc);
  if (!(c.calle && c.numIgual)) return false;
  return !ghConflictoPunto(p, suc)?.grave;
}
export function ghMatchOficial(oficiales, p, geo) {
  if (!Array.isArray(oficiales) || !oficiales.length || !p) return null;
  const tnTokens = ghNrmSuc(p.nombre).split(" ").filter(w => w.length >= 4 && !GH_SUC_GEN.has(w));
  const cands = oficiales.filter(s => {
    if (!s) return false;
    const c = ghCmpPunto(p, s);
    const dirMatch = c.calle && c.numIgual;
    const descToks = ghNrmSuc(s.descripcion).split(" ");
    const nameMatch = !!(tnTokens.length && descToks.length && tnTokens.every(t => descToks.includes(t)));
    if (!dirMatch && !nameMatch) return false;
    if (!dirMatch && c.a.num && c.b.num && !c.calle) return false;
    if (ghConflictoPunto(p, s)?.grave) return false;
    if (geo?.exacto && s.distM != null && s.distM > 4000) return false;
    return true;
  });
  const key = s => {
    const dd = s.direccion || {};
    const kc = ghNrmSuc(dd.calle), kn = String(dd.numero || "").replace(/\D.*/, "").trim(), kcp = String(dd.codigoPostal || "").replace(/\D/g, "");
    return kc && (kn || kcp) ? `${kc}|${kn}|${kcp}` : ghNrmSuc(s.descripcion) + "|" + kn;
  };
  const unicas = [...new Map(cands.map(s => [key(s), s])).values()];
  if (unicas.length === 1) return unicas[0];
  const nombres = new Set(unicas.map(s => ghNrmSuc(s.descripcion)).filter(Boolean));
  if (unicas.length > 1 && nombres.size === 1 && unicas.every(s => ghNrmSuc(s.descripcion))) return unicas[0];
  return null;
}
// Punto reconstruido desde la clave de la memoria (nombre|calle|num|cp).
export function ghPuntoDeClave(key) {
  const [nombre = "", calle = "", num = "", cp = ""] = String(key || "").split("|");
  if (!calle && !nombre) return null;
  return { nombre, calle, num, loc: "", cp, conPickup: true };
}
// ¿El string del desplegable del Excel contradice al punto? (mismo criterio que conflictoTpl del front)
export function ghConflictoTpl(p, tplStr) {
  if (!p || !tplStr) return null;
  const s = ghNrmSuc(tplStr);
  const a = ghDirParse(p.calle, p.num);
  if (!a.num || !a.words.length || !a.words.some(t => s.split(" ").includes(t))) return null;
  const nums = s.match(/\b\d{2,5}\b/g) || [];
  if (nums.length && !nums.includes(a.num)) return { msg: `el desplegable dice ${nums.join("/")}, el cliente eligió ${a.num}`, grave: true };
  return null;
}
