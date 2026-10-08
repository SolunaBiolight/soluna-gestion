// Genera scripts/fixtures/tpl_localidades.txt con las localidades REALES
// ("PROVINCIA / LOCALIDAD / CP") del template de Andreani, con el mismo filtro
// que usa la app, para scripts/loc_match_test.cjs. Correr al actualizar el xlsx:
//   node scripts/loc_fixture.cjs
const fs=require("fs"),path=require("path"),XLSX=require("xlsx");
const wb=XLSX.readFile(path.join(__dirname,"..","public","andreani_template.xlsx"));
const pat=/^[A-ZÁÉÍÓÚÑÜ\s]+ \/ [A-ZÁÉÍÓÚÑÜ\s0-9]+ \/ \d+$/;
const set=new Set();
for(const n of wb.SheetNames){ for(const r of XLSX.utils.sheet_to_json(wb.Sheets[n],{header:1})) for(const c of r){ const t=String(c??"").trim(); if(pat.test(t)) set.add(t); } }
fs.writeFileSync(path.join(__dirname,"fixtures","tpl_localidades.txt"),[...set].join("\n")+"\n");
console.log("localidades:",set.size);
