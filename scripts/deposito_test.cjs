// Pruebas de las funciones puras del Depósito (api/deposito.js): cobro por
// unidad, total de la tanda y ledger de la cuenta corriente. Sin dependencias: node scripts/deposito_test.cjs
const fs=require("fs");
const src=fs.readFileSync("api/deposito.js","utf8");
function fn(name){ const i=src.indexOf(`\nexport function ${name}(`); if(i<0) throw new Error("no "+name); const j=src.indexOf("\n}\n",i); return src.slice(i,j+3).replace("export function","function"); }
const num=`const num = v => { const n = Number(v); return isFinite(n) ? n : 0; }; const ms = v => v?.toMillis?.() ?? (v?._seconds ? v._seconds * 1000 : (typeof v === "number" ? v : null));`;
const tot=src.slice(src.indexOf("const totalDe = "),src.indexOf("\n",src.indexOf("const totalDe = "))+1);
const M=new Function(num+fn("unidadesDe")+fn("extraItemsDe")+fn("ledgerDe")+tot+"\nreturn {unidadesDe,extraItemsDe,ledgerDe,totalDe};")();
let fails=0,n=0;
const eq=(d,g,e)=>{ n++; if(JSON.stringify(g)!==JSON.stringify(e)){ fails++; console.log("FAIL",d,"\n   got:",JSON.stringify(g),"\n   exp:",JSON.stringify(e)); } };
// unidades
eq("2x",M.unidadesDe(["2x ROJ-NN","1x LIQ"]),3);
eq("(x2)",M.unidadesDe(["ROJ-NN (x2)","LIQ"]),3);
eq("sin cantidad",M.unidadesDe(["ROJ-NN","NARAN-TT"]),2);
eq("vacío",M.unidadesDe([]),0);
// cobro por unidad: hasta 5 unidades = paquete; más de 5 = $500 por CADA unidad, sin paquete
const cfg={extraItemsIncluidos:5,extraItemPrecio:500};
eq("5 unidades = paquete, sin extra",M.extraItemsDe([{items:["5x A"]}],cfg).monto,0);
eq("6 unidades = 6 × 500",M.extraItemsDe([{items:["4x A","2x B"]}],cfg).monto,3000);
eq("8 unidades = 8 × 500",M.extraItemsDe([{items:["8x A"]}],cfg),{unidades:8,extraUnidades:8,pedidosConExtra:1,incluidos:5,precioExtra:500,monto:4000});
eq("por pedido, no por tanda",M.extraItemsDe([{items:["3x A"]},{items:["3x A"]}],cfg).monto,0);
eq("cancelado no cuenta",M.extraItemsDe([{items:["9x A"],cancelado:true},{items:["7x A"]}],cfg).monto,3500);
eq("defaults",M.extraItemsDe([{items:["6x A"]}],null).monto,3000);
// total: el pedido cobrado por unidad NO paga el precio por paquete
const tt=(peds,ajuste=0)=>{ const e=M.extraItemsDe(peds,cfg); return M.totalDe({n:peds.length,precioUnit:2000,extraItems:e.monto,extraDetalle:e,ajuste}); };
eq("3 pedidos chicos = 3 paquetes",tt([{items:["A"]},{items:["5x A"]},{items:["2x B"]}]),6000);
eq("8 unidades: 4.000 y sin paquete",tt([{items:["8x A"]}]),4000);
eq("mezcla: 2 paquetes + 7 unidades",tt([{items:["A"]},{items:["B"]},{items:["7x A"]}]),7500);
eq("sin detalle (tanda vieja o por páginas)",M.totalDe({n:4,precioUnit:2000,extraItems:0,ajuste:-500}),7500);
eq("ajuste no deja negativo",tt([{items:["A"]}],-9000),0);
// ledger: cargos (tandas) − pagos verificados; movimientos del más nuevo al más viejo con saldo
const D=f=>Date.parse(`${f}T15:00:00Z`);
const T1=[{id:"a",t:{estado:"entregada",total:1000,n:2,fechaDespacho:"2026-09-10",createdAt:D("2026-09-09")}},{id:"b",t:{estado:"pendiente",total:2000,n:4,fechaDespacho:"2026-10-02",createdAt:D("2026-10-01")}},{id:"x",t:{estado:"cancelada",total:9000,n:9,fechaDespacho:"2026-10-03",createdAt:D("2026-10-01")}},{id:"y",t:{estado:"borrador",total:500,n:1,fechaDespacho:"2026-10-03"}}];
const P1=[{id:"p1",p:{estado:"verificado",monto:1500,verificadoAt:D("2026-09-20")}},{id:"p2",p:{estado:"a_verificar",monto:700,informadoAt:D("2026-10-05")}},{id:"p3",p:{estado:"rechazado",monto:300}},{id:"p4",p:{estado:"verificado",tipo:"ajuste",monto:-200,nota:"insumo",verificadoAt:D("2026-10-04")}}];
const L=M.ledgerDe(T1,P1);
eq("saldo = cargos − pagos (cancelada y borrador no cuentan)",[L.saldo,L.cargos,L.creditos,L.porVerificar],[1700,3200,1500,700]);
eq("orden: más nuevo primero, con saldo después de cada uno",L.movs.map(m=>[m.tipo,m.saldo]),[["cargo",1700],["tanda",1500],["transferencia",-500],["tanda",1000]]);
eq("concepto de la tanda",L.movs[3].concepto,"2 etiquetas");
eq("meses: etiquetas, cargos, pagos y saldo al cierre",L.meses,[{mes:"2026-10",etiquetas:4,tandas:1,cargos:2200,pagos:0,saldoCierre:1700},{mes:"2026-09",etiquetas:2,tandas:1,cargos:1000,pagos:1500,saldoCierre:-500}]);
eq("reverso y saldo (modelo viejo) se ignoran",M.ledgerDe(T1,[...P1,{id:"r",p:{estado:"verificado",tipo:"reverso",monto:1000}},{id:"s",p:{estado:"verificado",tipo:"saldo",monto:1000}}]).saldo,1700);
eq("tanda cobrada con comprobante por tanda (sin pagoId) = cargo + pago",M.ledgerDe([{id:"v",t:{estado:"entregada",total:800,n:1,fechaDespacho:"2026-08-01",pago:{estado:"verificado",verificadoAt:D("2026-08-02")}}}],[]).saldo,0);
eq("tanda verificada por FIFO (con pagoId) sigue siendo cargo",M.ledgerDe([{id:"v",t:{estado:"entregada",total:800,n:1,fechaDespacho:"2026-08-01",pago:{estado:"verificado",pagoId:"p9"}}}],[{id:"p9",p:{estado:"verificado",monto:800,verificadoAt:D("2026-08-02")}}]).saldo,0);
eq("ajuste y por unidad en el concepto",M.ledgerDe([{id:"z",t:{estado:"impresa",total:3500,n:3,ajuste:-500,extraDetalle:{pedidosConExtra:1},fechaDespacho:"2026-10-06"}}],[]).movs[0].concepto,"3 etiquetas (1 por unidad) · ajuste −500");
eq("corrección directa del saldo: concepto y efecto",(()=>{ const L=M.ledgerDe([{id:"a",t:{estado:"entregada",total:5000,n:5,fechaDespacho:"2026-10-01"}}],[{id:"f",p:{estado:"verificado",tipo:"ajuste",monto:3000,fijado:{de:5000,a:2000},nota:"mal contadas",verificadoAt:D("2026-10-02")}}]); return [L.saldo,L.movs[0].concepto]; })(),[2000,"Saldo corregido a 2000: mal contadas"]);
eq("vacío",M.ledgerDe([],[]),{saldo:0,cargos:0,creditos:0,porVerificar:0,movs:[],meses:[]});
// hojas de resumen dentro del PDF de etiquetas (front): no se cuentan ni se cobran
{ const app=fs.readFileSync("src/App.jsx","utf8"); const i=app.indexOf("function ghDepHojasResumen("),j=app.indexOf("async function ghDepContarEtiquetas(");
  const R=new Function(app.slice(i,j)+"return ghDepHojasResumen;")();
  const L=(t="Envio 360000123456789 Juan")=>({w:283,h:425,texto:t}), A4=t=>({w:595,h:842,texto:t});
  eq("resumen de Growith (A4 al final)",R([L(),L(),L(),A4("RESUMEN SKU DESPACHADOS DETALLE ROJ-NN -> 2 u")]),[3]);
  eq("resumen adelante y del mismo tamaño",R([L("Resumen de pedidos ROJ-NN x2"),L(),L()]),[0]);
  eq("A4 sin texto entre etiquetas 10x15",R([L(""),L(""),L(""),A4("")]),[3]);
  eq("todas A4 con número de envío: son etiquetas",R([A4("360000123456789"),A4("360000123456780")]),[]);
  eq("todas iguales y sin texto: son etiquetas",R([L(""),L(""),L("")]),[]);
  eq("una sola página nunca es resumen",R([A4("RESUMEN SKU")]),[]);
  eq("etiqueta A4 con envío entre 10x15 no es resumen",R([L(),L(),A4("Envio 360000123456789")]),[]);
}
// nota del pedido con la marca DEPO: → renglones extra de la etiqueta
{ const app=fs.readFileSync("src/App.jsx","utf8"); const cut=(a,b)=>app.slice(app.indexOf(a),app.indexOf(b,app.indexOf(a)));
  const N=new Function(cut("function ghDepItemNorm(","// La CANTIDAD de pedidos")+cut("function ghNotaDepo(","function ghSkuLinesDe(")+cut("function ghSkuLinesDe(","// pdf.js (CDN")+"return {ghNotaDepo,ghSkuLinesDe};")();
  eq("nota con marca",N.ghNotaDepo("Cliente VIP\nDEPO: 1x LIQ, CLIP-ON x2 + nota de regalo\notra cosa"),["1x LIQ","2x CLIP-ON","nota de regalo"]);
  eq("depósito con acento y minúsculas",N.ghNotaDepo("depósito: paño"),["paño"]);
  eq("nota sin marca no se imprime",N.ghNotaDepo("mandar rápido, es regalo"),[]);
  eq("se suma a los productos del pedido",N.ghSkuLinesDe({productos:[{sku:"ROJ-NN",cantidad:"2"}],notaDepo:["1x LIQ"]}),["2x ROJ-NN","1x LIQ"]);
}
// Etiquetas de Mercado Libre: SKU y unidades leídos del rótulo
{ const app=fs.readFileSync("src/App.jsx","utf8"); const i=app.indexOf("function ghDepMlPedidos(textos){"); const j=app.indexOf("\n}\n",i);
  const ml=new Function(app.slice(i,j+3)+"\nreturn ghDepMlPedidos;")();
  const p1="Pack ID: 2000001234567 Recortá esta parte de la etiqueta para\nque tu paquete viaje seguro.\n2\nUnidades\nSKU: AN + RN\nKit X2 Anteojos\nAmarillo Rojo | 2 u.\nRemitente #123456789\nJuan Perez (JUANPE12)\nDomicilio: Calle 1";
  const p2="Venta ID: 2000007654321\n1\nUnidad\nSKU: R-N\nAnteojo rojo\nAna Gomez (ANAG_99)";
  const p3="Venta ID: 2000001111111\nSKU: A-T\nAnteojo amarillo | 3 u.\nSKU: LIQ\nLiquido | 1 u.\n4\nUnidades";
  const r=ml([p1,p2,p3]);
  eq("ML: kit de 2 unidades",r[0].items,["2x AN + RN"]);
  eq("ML: número de venta y comprador",[r[0].numero,r[0].comprador,r[1].numero,r[1].comprador],["2000001234567","Juan Perez","2000007654321","Ana Gomez"]);
  eq("ML: una unidad",r[1].items,["1x R-N"]);
  eq("ML: dos productos en una etiqueta, cada uno con sus unidades",r[2].items,["3x A-T","1x LIQ"]);
  eq("ML: página de cada pedido",r.map(x=>x.pags[0]),[1,2,3]);
  eq("ML: un PDF que no es de Mercado Libre no devuelve nada",ml(["Orden de Ruteo 36000123","Destinatario Juan"]),[]);
}
// Números del depósito (pestaña Resumen) y cobranza
{ const txt="const txt = (v, max) => String(v ?? \"\").replace(/[\\x00-\\x1f]+/g, \" \").trim().slice(0, max);";
  const aux=src.slice(src.indexOf("const canalK = "),src.indexOf("// Números del depósito (puro"));
  const S=new Function(num+txt+fn("ledgerDe")+fn("cobranzaDe")+fn("itemSkuCant")+aux+fn("statsDeposito")+"\nreturn {statsDeposito,cobranzaDe,ledgerDe,itemSkuCant};")();
  eq("item 2x",S.itemSkuCant("2x ROJ-NN"),{sku:"ROJ-NN",cant:2}); eq("item (x3)",S.itemSkuCant("LIQ (x3)"),{sku:"LIQ",cant:3}); eq("item solo",S.itemSkuCant("CLIP-ON"),{sku:"CLIP-ON",cant:1});
  const d=f=>Date.parse(f+"T15:00:00Z");
  const T=(id,cli,f,nn,total,canal,extra={})=>({id,t:{clienteId:cli,clienteNombre:cli.toUpperCase(),estado:"entregada",fechaDespacho:f,n:nn,total,canal,createdAt:d(f),...extra}});
  const tandas=[T("a","c1","2026-10-10",4,4000,"andreani",{pedidos:[{items:["2x ROJ-NN","1x LIQ"],armado:{at:d("2026-10-10"),porNombre:"Ana"}},{items:["ROJ-NN"],apartado:{nota:"falta stock",at:d("2026-10-10"),porNombre:"Ana"}},{items:["1x LIQ"],cancelado:{at:d("2026-10-11"),porNombre:"Ana",nota:"sin stock"}}],hist:[{at:d("2026-10-10"),porNombre:"Ana",de:"pendiente",a:"entregada"}]}),
    T("b","c2","2026-10-12",2,2000,"ml",{pedidos:[]}), T("c","c1","2026-09-05",10,10000,"andreani",{pedidos:[{items:["3x NARAN-TT"]}]}), T("e","c1","2026-09-28",5,5000,"andreani",{pedidos:[]}),
    {id:"x",t:{clienteId:"c1",estado:"cancelada",fechaDespacho:"2026-10-09",n:99,total:99000,canal:"andreani",createdAt:d("2026-10-09")}}];
  const pagos=[{id:"p1",p:{clienteId:"c1",monto:12000,estado:"verificado",tipo:"transferencia",verificadoAt:d("2026-10-02")}}];
  const R=S.statsDeposito({hoy:"2026-10-13",tandas,todas:tandas,pagos,clientes:[{id:"c1",nombre:"Uno",activo:true},{id:"c2",nombre:"Dos",activo:true},{id:"c3",nombre:"Tres",activo:true}]});
  eq("mes actual: etiquetas, tandas, facturado, cobrado",[R.meses.actual.etiquetas,R.meses.actual.tandas,R.meses.actual.facturado,R.meses.actual.cobrado],[6,2,6000,12000]);
  eq("por correo en el mes",[R.meses.actual.andreani,R.meses.actual.ml],[4,2]);
  eq("mes anterior entero y a la misma altura",[R.meses.anterior.etiquetas,R.meses.anteriorAlDia.etiquetas],[15,10]);
  eq("28 días: hoy último, total del período",[R.dias.length,R.dias[27].f,R.dias.reduce((a,x)=>a+x.total,0)],[28,"2026-10-13",11]);
  const c1=R.clientes.find(c=>c.clienteId==="c1"), c2=R.clientes.find(c=>c.clienteId==="c2");
  eq("ranking: primero el que más manda, el sin movimientos al final",R.clientes.map(c=>c.clienteId),["c1","c2","c3"]);
  eq("saldo de c1 = 19000 − 12000",[c1.saldo,R.teDeben],[7000,9000]);
  eq("c1 debe desde la tanda de fin de septiembre (lo más viejo ya está pago)",[c1.deudaDesde,c1.ultimoPago],[d("2026-09-28"),d("2026-10-02")]);
  eq("c2 sin pagos",[c2.deudaDesde,c2.ultimoPago],[d("2026-10-12"),null]);
  eq("productos del mes (el cancelado no cuenta)",R.skus.actual.map(x=>[x.sku,x.unidades,x.pedidos]),[["ROJ-NN",3,2],["LIQ",1,1]]);
  eq("productos del mes anterior",R.skus.anterior.map(x=>[x.sku,x.unidades]),[["NARAN-TT",3]]);
  eq("etiquetas con y sin detalle de productos",R.cobertura.actual,{con:4,sin:2});
  eq("quién hizo qué",R.operarios.map(o=>[o.nombre,o.impresas,o.escaneados]),[["Ana",4,1]]);
  eq("pedidos con problemas, el más nuevo primero",R.problemas.map(x=>[x.tipo,x.nota]),[["cancelado","sin stock"],["apartado","falta stock"]]);
  eq("sin deuda no hay 'debe desde'",S.cobranzaDe(S.ledgerDe([T("z","c9","2026-10-01",1,1000,"andreani")],[{id:"q",p:{clienteId:"c9",monto:1000,estado:"verificado",verificadoAt:d("2026-10-03")}}])),{ultimoPago:d("2026-10-03"),deudaDesde:null});
}
console.log(`${n-fails}/${n} ok${fails?" — "+fails+" FALLAS":""}`); if(fails) process.exit(1);
