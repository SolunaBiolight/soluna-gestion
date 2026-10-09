// Pruebas del matcheo de LOCALIDAD para envíos a domicilio (bloque GH_LOC_MATCH
// de src/App.jsx) contra las localidades reales de la plantilla de Andreani.
// Sin dependencias: node scripts/loc_match_test.cjs
// (fixture: node scripts/loc_fixture.cjs cuando cambie public/andreani_template.xlsx)
const fs=require("fs"),path=require("path");
const src=fs.readFileSync(path.join(__dirname,"..","src","App.jsx"),"utf8");
const blk=src.slice(src.indexOf("// GH_LOC_MATCH_BEGIN"),src.indexOf("// GH_LOC_MATCH_END"));
const nrm=src.slice(src.indexOf("function ghNrmSuc(s){"),src.indexOf("\n}\n",src.indexOf("function ghNrmSuc(s){"))+3);
const M=new Function(nrm+blk+"\nreturn {ghLocCp,ghLocProv,ghMatchLocalidad,ghLocVerif,ghLocCandidatas,ghLocPartes};")();
const list=fs.readFileSync(path.join(__dirname,"fixtures","tpl_localidades.txt"),"utf8").split("\n").filter(Boolean);
const cpIndex={},provIndex={};
for(const l of list){ const p=l.split(" / "); (cpIndex[p[2].trim()]=cpIndex[p[2].trim()]||[]).push(l); (provIndex[p[0].trim()]=provIndex[p[0].trim()]||[]).push(l); }
const locs={list,cpIndex,provIndex};
let n=0,fails=0;
const eq=(d,g,e)=>{ n++; if(JSON.stringify(g)!==JSON.stringify(e)){ fails++; console.log("FAIL",d,"\n   got:",JSON.stringify(g),"\n   exp:",JSON.stringify(e)); } };
const m=(cp,prov,loc)=>M.ghMatchLocalidad(locs,cp,prov,loc)?.loc||null;

// CP como lo escribe un comprador de Shopify
eq("cp simple",M.ghLocCp("1425"),"1425");
eq("cp con letra",M.ghLocCp("C1425"),"1425");
eq("CPA completo",M.ghLocCp("c1425dka"),"1425");
eq("CPA con espacios",M.ghLocCp(" B 7600 "),"7600");
eq("cp de 5 dígitos no se recorta",M.ghLocCp("14250"),"");
eq("cp vacío",M.ghLocCp(""),"");
// Provincias de Shopify / Tienda Nube → plantilla
eq("CABA Shopify",M.ghLocProv("Ciudad Autónoma de Buenos Aires"),"CAPITAL FEDERAL");
eq("CABA sigla",M.ghLocProv("C.A.B.A."),"CAPITAL FEDERAL");
eq("Córdoba con acento",M.ghLocProv("Córdoba"),"CORDOBA");
eq("GBA de Tienda Nube",M.ghLocProv("Gran Buenos Aires"),"BUENOS AIRES");
eq("Tierra del Fuego largo",M.ghLocProv("Tierra del Fuego, Antártida e Islas del Atlántico Sur"),"TIERRA DEL FUEGO");
eq("Entre Ríos",M.ghLocProv("Entre Ríos"),"ENTRE RIOS");

// Casos buenos
eq("Córdoba capital",m("5000","Córdoba","Córdoba"),"CORDOBA / CORDOBA / 5000");
eq("Córdoba con CPA",m("X5000ABC","Córdoba","Cordoba Capital"),"CORDOBA / CORDOBA / 5000");
eq("Rosario",m("2000","Santa Fe","Rosario"),"SANTA FE / ROSARIO / 2000");
eq("Tucumán con acento (antes caía en E DE ZOOTECNIA B)",m("4000","Tucumán","San Miguel de Tucumán"),"TUCUMAN / SAN MIGUEL DE TUCUMAN / 4000");
eq("Neuquén",m("Q8300","Neuquén","Neuquén"),"NEUQUEN / NEUQUEN / 8300");
eq("CABA con barrio",m("C1425DKA","Ciudad Autónoma de Buenos Aires","Palermo"),"CAPITAL FEDERAL / CIUDAD AUTONOMA DE BUENOS AIRES / 1425");
eq("CABA con provincia Buenos Aires",m("1425","Buenos Aires","CABA"),"CAPITAL FEDERAL / CIUDAD AUTONOMA DE BUENOS AIRES / 1425");
eq("Olivos",m("1636","Buenos Aires","Olivos"),"BUENOS AIRES / OLIVOS / 1636");
eq("La Plata",m("B1900","Buenos Aires","La Plata"),"BUENOS AIRES / LA PLATA / 1900");
eq("Mar del Plata",m("7600","Buenos Aires","Mar del Plata"),"BUENOS AIRES / MAR DEL PLATA / 7600");

// NUNCA adivinar
eq("CP de Córdoba con provincia Mendoza → a mano",m("5000","Mendoza","Godoy Cruz"),null);
eq("CP único pero otra provincia → a mano",m("5000","Buenos Aires","La Plata"),null);
// Mismo CP + misma provincia: se elige sola una localidad de ESE CP (no se pregunta)
{ const r=M.ghLocPartes(m("4000","Tucumán","Barrio Sur")); eq("barrio que no figura: entrada del mismo CP y provincia",[r?.prov,r?.cp],["TUCUMAN","4000"]); }
{ const r=M.ghLocPartes(m("1842","Buenos Aires","Autónomos I")); eq("#7365 (ciudad basura de la tienda): entrada de Buenos Aires 1842",[r?.prov,r?.cp],["BUENOS AIRES","1842"]); }
eq("mismo pedido, siempre la misma elección",m("1842","Buenos Aires","Autónomos I"),m("1842","Buenos Aires","xx"));
{ const r=M.ghLocPartes(m("5000","","Villa Allende")); eq("sin provincia pero todo el CP es de una sola: entrada de ese CP",[r?.prov,r?.cp],["CORDOBA","5000"]); }
{ const libre=["0001","0002","9998","9997"].find(c=>!cpIndex[c]); eq("CP inexistente → a mano (no cae a la provincia)",m(libre,"Buenos Aires","La Plata"),null); }
console.log("elige:",m("1842","Buenos Aires","Autónomos I"),"|",m("4000","Tucumán","Barrio Sur"),"|",m("1900","Buenos Aires","Tolosa centro"));
eq("sin CP y sin provincia → a mano",m("","","Rosario"),null);
eq("sin nada → a mano",m("","",""),null);
eq("Olivos con provincia Capital y localidad que no coincide → a mano",m("1636","Ciudad Autónoma de Buenos Aires","Belgrano"),null);

// Verificación final
eq("verif ok",M.ghLocVerif({cp:"5000",provincia:"Córdoba",localidad:"Córdoba"},"CORDOBA / CORDOBA / 5000"),"ok");
eq("verif otra provincia",M.ghLocVerif({cp:"5000",provincia:"Mendoza",localidad:"X"},"CORDOBA / CORDOBA / 5000"),"warn");
eq("verif otro CP (antes pasaba si coincidía una palabra)",M.ghLocVerif({cp:"2000",provincia:"Santa Fe",localidad:"Rosario"},"SALTA / ROSARIO DE LA FRONTERA / 4190"),"warn");
eq("verif mismo nombre, otro CP",M.ghLocVerif({cp:"1636",provincia:"Buenos Aires",localidad:"Olivos"},"BUENOS AIRES / OLIVOS / 1637"),"warn");

// Barrido completo: cada entrada de la plantilla, pedida con sus propios datos,
// tiene que devolver una entrada del MISMO CP y la MISMA provincia; y pedida con
// otra provincia tiene que ir a mano. Con el matcher viejo el segundo caso
// devolvía la entrada igual ("la única del CP").
let mal=0,nulos=0,cruzadas=0; const ej=[];
const otras=p=>p==="MENDOZA"?"SALTA":"MENDOZA";
for(const l of list){ const x=M.ghLocPartes(l); const [pv,lc,cp]=l.split(" / ");
  const r=m(cp,pv,lc);
  if(!r) nulos++; else { const y=M.ghLocPartes(r); if(y.cp!==x.cp||y.prov!==x.prov){ mal++; if(ej.length<5) ej.push([l,r]); } }
  const r2=m(cp,otras(pv),lc);
  if(r2){ const y=M.ghLocPartes(r2); if(y.prov!==M.ghLocProv(otras(pv))){ cruzadas++; if(ej.length<5) ej.push(["otra prov",l,r2]); } }
}
eq("barrido: ninguna entrada devuelve otro CP u otra provincia",mal,0);
eq("barrido: con la provincia cambiada nunca devuelve la entrada de la provincia original",cruzadas,0);
if(ej.length) console.log(ej);
console.log(`barrido: ${list.length} localidades · ${nulos} van a mano con sus propios datos (${(nulos/list.length*100).toFixed(1)} %)`);
console.log(`${n-fails}/${n} ok${fails?" — "+fails+" FALLAS":""}`); if(fails) process.exit(1);
