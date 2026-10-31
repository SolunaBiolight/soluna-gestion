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
// Piloto automático (31/oct/2026): espera, cierre de mes y corrida diaria.
const pi=src.indexOf("// ─── Reglas del piloto"), pj=src.indexOf("// ─── Notas de crédito en lote");
const P=new Function(src.slice(pi,pj).replace(/export (const|function)/g,"$1")+"\nreturn {autopilotCandidatas,autopilotTocaHoy,esUltimoDiaMes,sumarDiasYmd};")();
const ord={a:{_platform:"mercadolibre",estado_pago:"paid",total:100,fecha:"2026-10-20T15:00:00-03:00"},b:{_platform:"mercadolibre",estado_pago:"paid",total:100,fecha:"2026-10-27T15:00:00-03:00"},c:{_platform:"tiendanube",estado_pago:"paid",total:100,fecha:"2026-10-27T15:00:00-03:00"},d:{_platform:"mercadolibre",estado_pago:"pending",total:100,fecha:"2026-10-27T15:00:00-03:00"},e:{_platform:"mercadolibre",estado_pago:"paid",total:100,fecha:"2026-10-27T15:00:00-03:00",_billed:true}};
const r1=P.autopilotCandidatas(ord,{canales:["mercadolibre"],esperaDias:3,cierreMes:true},"2026-10-28");
eq("solo ML y con 3 días de espera: sale la del 20, espera la del 27",[r1.listas.map(x=>x[0]),r1.esperando.map(x=>[x[0],x[2]])],[["a"],[["b","2026-10-30"]]]);
eq("excluidas por canal y por pago",[r1.excluidas.canal,r1.excluidas.sinPago],[1,1]);
const r2=P.autopilotCandidatas(ord,{canales:["mercadolibre"],esperaDias:3,cierreMes:true},"2026-10-31");
eq("último día del mes factura todo lo de octubre",r2.listas.map(x=>x[0]),["a","b"]);
const r3=P.autopilotCandidatas(ord,{canales:["mercadolibre"],esperaDias:3,cierreMes:false},"2026-10-29");
eq("sin cierre de mes respeta la espera",r3.esperando.map(x=>x[0]),["b"]);
eq("sin espera factura todo lo pagado",P.autopilotCandidatas(ord,{canales:[]},"2026-10-28").listas.map(x=>x[0]),["a","b","c"]);
eq("último día del mes",[P.esUltimoDiaMes("2026-10-31"),P.esUltimoDiaMes("2026-10-30"),P.esUltimoDiaMes("2026-02-28")],[true,false,true]);
eq("diaria: antes de la hora no corre",P.autopilotTocaHoy({frecuencia:"diaria",hora:9},8,"2026-10-28"),false);
eq("diaria: después de la hora corre si no corrió hoy",P.autopilotTocaHoy({frecuencia:"diaria",hora:9},14,"2026-10-28"),true);
eq("diaria: ya corrió hoy",P.autopilotTocaHoy({frecuencia:"diaria",hora:9,ultimaCorridaDia:"2026-10-28"},14,"2026-10-28"),false);
eq("cada hora siempre corre",P.autopilotTocaHoy({frecuencia:"1h",ultimaCorridaDia:"2026-10-28"},3,"2026-10-28"),true);
console.log(`${n-f}/${n} ok${f?" — "+f+" FALLAS":""}`); if(f) process.exit(1);
