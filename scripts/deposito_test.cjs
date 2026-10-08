// Pruebas de las funciones puras del Depósito (api/deposito.js): FIFO de
// cuenta corriente y extra por unidades. Sin dependencias: node scripts/deposito_test.cjs
const fs=require("fs");
const src=fs.readFileSync("api/deposito.js","utf8");
function fn(name){ const i=src.indexOf(`\nexport function ${name}(`); if(i<0) throw new Error("no "+name); const j=src.indexOf("\n}\n",i); return src.slice(i,j+3).replace("export function","function"); }
const num=`const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };`;
const tot=src.slice(src.indexOf("const totalDe = "),src.indexOf("\n",src.indexOf("const totalDe = "))+1);
const M=new Function(num+fn("unidadesDe")+fn("extraItemsDe")+fn("fifoPuro")+tot+"\nreturn {unidadesDe,extraItemsDe,fifoPuro,totalDe};")();
let fails=0,n=0;
const eq=(d,g,e)=>{ n++; if(JSON.stringify(g)!==JSON.stringify(e)){ fails++; console.log("FAIL",d,"\n   got:",JSON.stringify(g),"\n   exp:",JSON.stringify(e)); } };
// unidades
eq("2x",M.unidadesDe(["2x ROJ-NN","1x LIQ"]),3);
eq("(x2)",M.unidadesDe(["ROJ-NN (x2)","LIQ"]),3);
eq("sin cantidad",M.unidadesDe(["ROJ-NN","NARAN-TT"]),2);
eq("vacío",M.unidadesDe([]),0);
// extra: 5 incluidas, $500 por unidad desde la sexta
const cfg={extraItemsIncluidos:5,extraItemPrecio:500};
eq("5 unidades sin extra",M.extraItemsDe([{items:["5x A"]}],cfg).monto,0);
eq("6 unidades = 1 extra",M.extraItemsDe([{items:["4x A","2x B"]}],cfg).monto,500);
eq("8 unidades = 3 extra",M.extraItemsDe([{items:["8x A"]}],cfg),{unidades:8,extraUnidades:3,pedidosConExtra:1,incluidos:5,precioExtra:500,monto:1500});
eq("por pedido, no por tanda",M.extraItemsDe([{items:["3x A"]},{items:["3x A"]}],cfg).monto,0);
eq("cancelado no cuenta",M.extraItemsDe([{items:["9x A"],cancelado:true},{items:["7x A"]}],cfg).monto,1000);
eq("defaults",M.extraItemsDe([{items:["6x A"]}],null).monto,500);
// total: el pedido cobrado por unidad NO paga el precio por paquete
const tt=(peds,ajuste=0)=>{ const e=M.extraItemsDe(peds,cfg); return M.totalDe({n:peds.length,precioUnit:2000,extraItems:e.monto,extraDetalle:e,ajuste}); };
eq("3 pedidos chicos = 3 paquetes",tt([{items:["A"]},{items:["5x A"]},{items:["2x B"]}]),6000);
eq("8 unidades: 3 extras y sin paquete",tt([{items:["8x A"]}]),1500);
eq("mezcla: 2 paquetes + 1 por unidad",tt([{items:["A"]},{items:["B"]},{items:["7x A"]}]),5000);
eq("sin detalle (tanda vieja o por páginas)",M.totalDe({n:4,precioUnit:2000,extraItems:0,ajuste:-500}),7500);
eq("ajuste no deja negativo",tt([{items:["A"]}],-9000),0);
// fifo
const T=[{id:"a",total:1000},{id:"b",total:2000},{id:"c",total:3000}];
eq("paga la primera y sobra",M.fifoPuro(1500,T),{aplicado:["a"],resto:500});
eq("paga todas, resto a favor",M.fifoPuro(6500,T),{aplicado:["a","b","c"],resto:500});
eq("no alcanza ninguna",M.fifoPuro(900,T),{aplicado:[],resto:900});
eq("cargo pendiente (aFavor negativo) se conserva",M.fifoPuro(2000+(-5000),T),{aplicado:[],resto:-3000});
eq("cargo cubierto y paga",M.fifoPuro(4000+(-500),T),{aplicado:["a","b"],resto:500});
eq("centavos",M.fifoPuro(1000.004,T),{aplicado:["a"],resto:0});
console.log(`${n-fails}/${n} ok${fails?" — "+fails+" FALLAS":""}`); if(fails) process.exit(1);
