// Libro IVA Digital (RG 4597) — arma los 4 archivos de texto de ancho fijo que se importan en
// ARCA → "Libro IVA Digital" (Importar comprobantes): ventas comprobantes (266 caracteres),
// ventas alícuotas (62), compras comprobantes (325) y compras alícuotas (84). Puro, sin dependencias
// (tests: node scripts/libro_iva_test.cjs). Solo para Responsables Inscriptos; la factura C no va.
//
// Fila de venta normalizada: { fecha:"AAAA-MM-DD", tipo, pv, nro, docTipo (80 CUIT | 86 CUIL | 96 DNI | 99 sin identificar),
//   docNro, nombre, total, neto, iva, exento (importe exento), noGravado, otros (otros tributos), alic:[{id, base, importe}] }
// Fila de compra: lo mismo, el docTipo/docNro es del vendedor.

export const LIBRO_ALIC = { 0: 3, 10.5: 4, 21: 5, 27: 6, 5: 8, 2.5: 9 }; // % → código ARCA
const ALIC_PCT = { 3: 0, 4: 10.5, 5: 21, 6: 27, 8: 5, 9: 2.5 };

function libroTxt(v, n) { // texto alineado a la izquierda, sin acentos ni caracteres fuera de ASCII
  const s = String(v == null ? "" : v).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7E]/g, "").toUpperCase();
  return s.slice(0, n).padEnd(n, " ");
}
function libroNum(v, n) { // dígitos alineados a la derecha con ceros
  const s = String(v == null ? "" : v).replace(/\D/g, "");
  return s.slice(-n).padStart(n, "0");
}
function libroImp(v, n = 15) { // importe con 2 decimales implícitos; los negativos llevan el signo adelante
  const c = Math.round(Math.abs(Number(v) || 0) * 100);
  const neg = (Number(v) || 0) < 0 && c > 0;
  const s = String(c).padStart(neg ? n - 1 : n, "0").slice(-(neg ? n - 1 : n));
  return neg ? "-" + s : s;
}
function libroFecha(f) { return libroNum(String(f || "").slice(0, 10), 8); }
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

// Alícuota más cercana a iva/neto (para compras importadas, que traen un solo IVA).
export function libroAlicDe(neto, iva) {
  if (!(Number(neto) > 0) || !(Number(iva) > 0)) return 3;
  const pct = (Number(iva) / Number(neto)) * 100;
  let best = 5, d = Infinity;
  for (const [id, p] of Object.entries(ALIC_PCT)) { if (Number(id) === 3) continue; const x = Math.abs(p - pct); if (x < d) { d = x; best = Number(id); } }
  return best;
}

// Alícuotas de una fila: las que trae, o una sola deducida. Una fila sin IVA y sin gravado lleva
// una alícuota 0 % con base 0 (ARCA exige al menos una en A y B).
function alicDe(r) {
  const a = (Array.isArray(r.alic) ? r.alic : []).filter(x => x && Number(x.id)).map(x => ({ id: Number(x.id), base: r2(x.base), importe: r2(x.importe) }));
  if (a.length) return a;
  if (Number(r.neto) > 0) return [{ id: libroAlicDe(r.neto, r.iva), base: r2(r.neto), importe: r2(r.iva) }];
  return [{ id: 3, base: 0, importe: 0 }];
}
const esC = t => [11, 12, 13, 15].includes(Number(t));

export function libroIvaVentas(rows) {
  const cbte = [], alic = [];
  for (const r of rows) {
    if (esC(r.tipo)) continue;
    const al = alicDe(r);
    const exento = r2(r.exento), noGrav = r2(r.noGravado);
    const op = exento > 0 && !(Number(r.neto) > 0) ? "E" : noGrav > 0 && !(Number(r.neto) > 0) ? "N" : "0";
    const doc = Number(r.docTipo) || 99;
    cbte.push([
      libroFecha(r.fecha), libroNum(r.tipo, 3), libroNum(r.pv, 5), libroNum(r.nro, 20), libroNum(r.nro, 20),
      libroNum(doc, 2), libroNum(doc === 99 ? 0 : r.docNro, 20), libroTxt(r.nombre || (doc === 99 ? "CONSUMIDOR FINAL" : ""), 30),
      libroImp(r.total), libroImp(noGrav), libroImp(0), libroImp(exento), libroImp(0), libroImp(0), libroImp(0), libroImp(0),
      "PES", "0001000000", String(Math.min(9, al.length)), op, libroImp(r.otros), "00000000",
    ].join(""));
    for (const a of al.slice(0, 9)) alic.push([libroNum(r.tipo, 3), libroNum(r.pv, 5), libroNum(r.nro, 20), libroImp(a.base), libroNum(a.id, 4), libroImp(a.importe)].join(""));
  }
  return { cbte, alic };
}

export function libroIvaCompras(rows) {
  const cbte = [], alic = [];
  for (const r of rows) {
    const c = esC(r.tipo);
    const al = c ? [] : alicDe(r);
    const doc = Number(r.docTipo) || (String(r.docNro || "").replace(/\D/g, "").length === 11 ? 80 : 99);
    const credito = c ? 0 : al.reduce((s, a) => s + a.importe, 0);
    const noGrav = c ? r2(r.total) : r2(r.noGravado);
    cbte.push([
      libroFecha(r.fecha), libroNum(r.tipo, 3), libroNum(r.pv, 5), libroNum(r.nro, 20), libroTxt("", 16),
      libroNum(doc, 2), libroNum(r.docNro, 20), libroTxt(r.nombre, 30),
      libroImp(r.total), libroImp(noGrav), libroImp(r.exento), libroImp(0), libroImp(0), libroImp(0), libroImp(0), libroImp(0),
      "PES", "0001000000", String(Math.min(9, al.length)), c ? "N" : "0", libroImp(credito), libroImp(r.otros),
      libroNum(0, 11), libroTxt("", 30), libroImp(0),
    ].join(""));
    for (const a of al.slice(0, 9)) alic.push([libroNum(r.tipo, 3), libroNum(r.pv, 5), libroNum(r.nro, 20), libroNum(doc, 2), libroNum(r.docNro, 20), libroImp(a.base), libroNum(a.id, 4), libroImp(a.importe)].join(""));
  }
  return { cbte, alic };
}

// ARCA ordena por fecha y número; los archivos van con fin de línea CRLF.
export function libroIva({ ventas = [], compras = [] }) {
  const ord = (a, b) => String(a.fecha).localeCompare(String(b.fecha)) || Number(a.tipo) - Number(b.tipo) || Number(a.pv) - Number(b.pv) || Number(a.nro) - Number(b.nro);
  const v = libroIvaVentas([...ventas].sort(ord)), c = libroIvaCompras([...compras].sort(ord));
  const txt = l => l.length ? l.join("\r\n") + "\r\n" : "";
  return {
    ventasCbte: txt(v.cbte), ventasAlic: txt(v.alic), comprasCbte: txt(c.cbte), comprasAlic: txt(c.alic),
    n: { ventas: v.cbte.length, compras: c.cbte.length },
  };
}
