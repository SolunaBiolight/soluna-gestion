// Pruebas del armado del Excel de Andreani para pedidos de Shopify (auditoría zensleep 15/oct/2026):
// teléfono (ghTelAR, App.jsx), calle/número/piso y DNI (partirDireccion, soloDocumento, api/orders.js).
// Sin dependencias: node scripts/export_test.cjs
const fs=require("fs");
const app=fs.readFileSync("src/App.jsx","utf8"), ord=fs.readFileSync("api/orders.js","utf8");
const cut=(src,a,b)=>{ const i=src.indexOf(a); const j=src.indexOf(b,i); if(i<0||j<0) throw new Error("no "+a); return src.slice(i,j); };
const T=new Function(cut(app,"const GH_TEL_COD3=","const GH_ENVIO_GRID=")+"\nreturn ghTelAR;")();
const fnO=name=>{ const i=ord.indexOf(`export function ${name}(`); const j=ord.indexOf("\n}\n",i); return ord.slice(i,j+3).replace("export function","function"); };
const D=new Function(fnO("partirDireccion")+fnO("soloDocumento")+"\nreturn {partirDireccion,soloDocumento};")();
let n=0,f=0; const eq=(d,g,e)=>{ n++; if(JSON.stringify(g)!==JSON.stringify(e)){ f++; console.log("FAIL",d,"\n   got:",JSON.stringify(g),"\n   exp:",JSON.stringify(e)); } };
// teléfono — los casos reales del Excel de zensleep
eq("San Rafael 260",T("2604271496"),{cod:"260",num:"4271496"});
eq("Zapala 2942",T("+54 9 2942 547411"),{cod:"2942",num:"547411"});
eq("CABA con +54 9 11",T("+5491140427878"),{cod:"11",num:"40427878"});
eq("CABA 11 directo",T("1157822558"),{cod:"11",num:"57822558"});
eq("Catamarca 383",T("3834691783"),{cod:"383",num:"4691783"});
eq("con 0 y 15",T("0260 15 4271496"),{cod:"260",num:"4271496"});
eq("Córdoba 351 con 9",T("93515551234"),{cod:"351",num:"5551234"});
eq("Mar del Plata 223",T("2235123456"),{cod:"223",num:"5123456"});
eq("Junín 236",T("+54 236 4123456"),{cod:"236",num:"4123456"});
eq("Villa Gesell 2255 (4 dígitos)",T("2255123456"),{cod:"2255",num:"123456"});
eq("sin código de área",T("15 4271496"),{cod:"",num:"4271496"});
eq("vacío",T(""),{cod:"",num:""});
eq("Bariloche 294 sigue de 3",T("2944421234"),{cod:"294",num:"4421234"});
eq("Reconquista 3482",T("3482123456"),{cod:"3482",num:"123456"});
// dirección de Shopify
const P=D.partirDireccion;
eq("#7254 Ruta 143 12330",P("Ruta 143 12330"),{calle:"Ruta 143",numero:"12330",extra:""});
eq("altura + piso con la palabra",P("Av. Siempreviva 742 piso 3"),{calle:"Av. Siempreviva",numero:"742",extra:"piso 3"});
eq("altura + depto corto",P("Belgrano 1234 3B"),{calle:"Belgrano",numero:"1234",extra:"3B"});
eq("altura, coma y depto",P("Belgrano 1234, 3B"),{calle:"Belgrano",numero:"1234",extra:"3B"});
eq("calle numerada",P("Calle 13 456"),{calle:"Calle 13",numero:"456",extra:""});
eq("9 de Julio",P("9 de Julio 1550"),{calle:"9 de Julio",numero:"1550",extra:""});
eq("altura al principio",P("742 Evergreen Terrace"),{calle:"Evergreen Terrace",numero:"742",extra:""});
eq("dto con palabra",P("San Martín 55 dto 4"),{calle:"San Martín",numero:"55",extra:"dto 4"});
eq("sin número",P("Barrio Los Álamos"),{calle:"Barrio Los Álamos",numero:"",extra:""});
eq("lote/manzana",P("Los Robles 120 mz 4 lote 7"),{calle:"Los Robles",numero:"120",extra:"mz 4 lote 7"});
// documento
eq("DNI en empresa",D.soloDocumento("31737977"),"31737977");
eq("DNI con puntos",D.soloDocumento("31.737.977"),"31737977");
eq("CUIT",D.soloDocumento("20-31737977-5"),"20317379775");
eq("empresa de verdad",D.soloDocumento("Óptica Sur"),"");
eq("piso no es DNI",D.soloDocumento("3B"),"");
console.log(`${n-f}/${n} ok${f?" — "+f+" FALLAS":""}`); if(f) process.exit(1);
