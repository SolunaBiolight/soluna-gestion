// Genera scripts/fixtures/tpl_sucursales.txt con el desplegable REAL de
// sucursales del template de Andreani (public/andreani_template.xlsx, hoja
// Configuracion, columna A) para que scripts/suc_match_test.cjs pruebe el
// matcheo contra los strings de verdad. Correr después de actualizar el xlsx:
//   node scripts/tpl_fixture.cjs
const fs=require("fs"),path=require("path"),XLSX=require("xlsx");
const wb=XLSX.readFile(path.join(__dirname,"..","public","andreani_template.xlsx"));
const rows=XLSX.utils.sheet_to_json(wb.Sheets["Configuracion"],{header:1});
const col=rows.map(r=>String(r[0]||"")).filter(s=>s.trim()&&s.trim()!=="Sucursal").map(s=>s.replace(/[\r\n\t]+/g," "));
fs.writeFileSync(path.join(__dirname,"fixtures","tpl_sucursales.txt"),col.join("\n")+"\n");
console.log("entradas:",col.length);
