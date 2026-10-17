// Pruebas del control de Monotributo (api/arca.js, monoResumen). Sin dependencias: node scripts/arca_test.cjs
const fs=require("fs"); const src=fs.readFileSync("api/arca.js","utf8");
const i=src.indexOf("export const MONO_CATS"); const j=src.indexOf("// ─── Handler principal");
const M=new Function(src.slice(i,j).replace(/export (const|function)/g,"$1")+"\nreturn {monoResumen,MONO_SEMILLA};")();
let n=0,f=0; const eq=(d,g,e)=>{ n++; if(JSON.stringify(g)!==JSON.stringify(e)){ f++; console.log("FAIL",d,"\n   got:",JSON.stringify(g),"\n   exp:",JSON.stringify(e)); } };
const meses={}; for(let k=1;k<=10;k++) meses[`2026-${String(k).padStart(2,"0")}`]=1000000; meses["2025-11"]=500000; meses["2025-12"]=500000; meses["2025-10"]=9e9; // fuera de la ventana
const topes={A:5e6,B:8e6,C:11e6,D:13e6,E:15e6,F:17e6,G:19e6,H:21e6,I:23e6,J:25e6,K:27e6};
const r=M.monoResumen({meses,hoy:"2026-10-17",topes,categoria:"C"});
eq("12 meses = nov-25 a oct-26",r.total12,11000000);
eq("ritmo de los 3 meses completos",r.ritmo,1000000);
eq("% del tope",r.pct,100);
eq("le corresponde C",r.corresponde,"C");
eq("próxima recategorización enero",[r.recat.mes,r.recat.base],["2027-01","2026-12"]);
eq("proyección a diciembre: los meses viejos de 500 mil se reemplazan por 1 millón",r.recat.totalProyectado,12000000);
eq("para enero le correspondería D",r.correspondeRecat,"D");
eq("se pasa del tope en noviembre",r.mesExceso,"2026-11");
const s=M.monoResumen({meses,hoy:"2026-03-05",topes:null,categoria:""});
eq("sin topes confirmados no compara",[s.tope===undefined,s.pct===undefined,s.recat.mes],[true,true,"2026-07"]);
eq("excede la K",M.monoResumen({meses:{"2026-10":3e7},hoy:"2026-10-17",topes,categoria:"K"}).corresponde,"excede");
eq("semilla ordenada de menor a mayor",Object.values(M.MONO_SEMILLA.topes).every((v,i,a)=>!i||v>a[i-1]),true);
console.log(`${n-f}/${n} ok${f?" — "+f+" FALLAS":""}`); if(f) process.exit(1);
