// Pruebas del flujo de canjes (bloque GH_CANJES_FLUJO en src/App.jsx): unir el pedido con pago
// pendiente al canje, plazo del contenido, "Para escribir hoy", mensajes e historial del influencer.
// Sin dependencias: node scripts/canjes_flujo_test.cjs
const fs=require("fs");
const src=fs.readFileSync("src/App.jsx","utf8");
const cut=(a,b)=>{ const i=src.indexOf(a); const j=src.indexOf(b,i); if(i<0||j<0) throw new Error("no encontré "+a); return src.slice(i,j); };
const blk=cut("// GH_CANJES_FLUJO_BEGIN","// GH_CANJES_FLUJO_END");
const piezas=cut("function ghPiezaId(","function CanjePiezaLink(");
const nrm=cut("function ghNrmSuc(","// El rótulo suele pegar");
const ACT=src.match(/const ACTIVIDADES = \[[^\]]+\];/)[0];
const M=new Function(ACT+nrm+piezas+blk+"\nreturn {ghCanjeVence,ghCanjeParaEscribir,ghCanjeMensaje,ghCanjeScorePedido,ghCanjeUnirPedidos,ghCanjeRevisarPedido,ghInfluencerHistorial,ghCanjeCodigoDe};")();
let n=0,f=0; const eq=(d,g,e)=>{ n++; if(JSON.stringify(g)!==JSON.stringify(e)){ f++; console.log("FAIL",d,"\n   got:",JSON.stringify(g),"\n   exp:",JSON.stringify(e)); } };
const DIA=86400000; const ahora=Date.parse("2026-11-20T15:00:00-03:00");
const hace=d=>new Date(ahora-d*DIA).toISOString();

// Unir pedido
const C=(x={})=>({_docId:"c1",estado:"Esperando pedido",influencer:"Sofía Gómez",usuario:"sofi.style",telefono:"+54 9 11 5555-1234",email:"sofi@mail.com",createdAt:hace(1),...x});
const O=(x={})=>({numero:"8001",comprador:"Otra Persona",telefono:"",email:"",notaCliente:"",productos:[{nombre:"Rojo",cantidad:1}],...x});
eq("@ en la nota = 3",M.ghCanjeScorePedido(C(),O({notaCliente:"canje @sofi.style gracias"})),3);
eq("@ sin arroba en la nota = 3",M.ghCanjeScorePedido(C(),O({notaCliente:"soy sofi.style"})),3);
eq("otro usuario que empieza igual no cuenta",M.ghCanjeScorePedido(C(),O({notaCliente:"@sofi.style2"})),0);
eq("mismo teléfono = 2",M.ghCanjeScorePedido(C(),O({telefono:"1155551234"})),2);
eq("mismo mail = 2",M.ghCanjeScorePedido(C(),O({email:"SOFI@mail.com "})),2);
eq("mismo nombre = 1",M.ghCanjeScorePedido(C(),O({comprador:"Gomez Sofia"})),1);
eq("nada en común = 0",M.ghCanjeScorePedido(C(),O()),0);
let r=M.ghCanjeUnirPedidos([C()],[O({numero:"8002",notaCliente:"@sofi.style"})]);
eq("auto por @",[r.auto.length,r.auto[0]?.orden.numero,r.dudas.length],[1,"8002",0]);
r=M.ghCanjeUnirPedidos([C()],[O({numero:"8003",comprador:"Sofía Gómez"})]);
eq("solo por nombre = duda",[r.auto.length,r.dudas.length,r.dudas[0]?.opciones[0].numero],[0,1,"8003"]);
r=M.ghCanjeUnirPedidos([C(),{...C(),_docId:"c2",pedidoRef:"8004",estado:"Por enviar"}],[O({numero:"8004",notaCliente:"@sofi.style"})]);
eq("pedido ya usado por otro canje no se une",[r.auto.length,r.dudas.length],[0,0]);
r=M.ghCanjeUnirPedidos([C({estado:"Por enviar"})],[O({notaCliente:"@sofi.style"})]);
eq("solo canjes Esperando pedido",r.auto.length,0);
r=M.ghCanjeUnirPedidos([C({telefono:"",email:""})],[O({numero:"1",comprador:"Sofia Gomez"}),O({numero:"2",comprador:"Sofia Gomez"})]);
eq("dos pedidos con el mismo nombre = duda con dos opciones",[r.auto.length,r.dudas[0]?.opciones.length],[0,2]);
eq("revisar: pidió más de lo acordado",M.ghCanjeRevisarPedido({anteojosAcordados:2},{productos:[{cantidad:2},{cantidad:1}]}),["Pidió 3 productos y acordaron 2"]);
eq("revisar: coincide",M.ghCanjeRevisarPedido({anteojosAcordados:2},{productos:[{cantidad:2}]}),[]);
eq("revisar: sin cantidad acordada no avisa",M.ghCanjeRevisarPedido({},{productos:[{cantidad:5}]}),[]);

// Plazo
eq("vence = entrega + 12",M.ghCanjeVence({trackEntregadoAt:"2026-11-01T18:00:00.000Z"}),"2026-11-13");
eq("vence manual manda",M.ghCanjeVence({contenidoVence:"2026-12-01",trackEntregadoAt:"2026-11-01T18:00:00.000Z"}),"2026-12-01");
eq("sin entrega no hay plazo",M.ghCanjeVence({}),"");

// Para escribir hoy
const P=(x)=>{ const it=M.ghCanjeParaEscribir(x,ahora); return it?[it.tipo,it.clave]:null; };
const pz=[{id:"a",tipo:"Reel",estado:"pendiente"}];
eq("esperando pedido 1 día: nada",P(C({createdAt:hace(1)})),null);
eq("esperando pedido 4 días: recordar",P(C({createdAt:hace(4)})),["pedido","pedido_1"]);
eq("ya escrito ese tramo: nada",P(C({createdAt:hace(4),escritos:{pedido_1:"x"}})),null);
eq("tres días después vuelve",P(C({createdAt:hace(6),escritos:{pedido_1:"x"}})),["pedido","pedido_2"]);
const E=(d,x={})=>({estado:"Contenido pendiente",trackEntregadoAt:hace(d),trackDone:true,piezas:pz,...x});
eq("día 0",P(E(0)),["dia0","dia0"]);
eq("día 3 sin escribir el 0: sigue el 0",P(E(3)),["dia0","dia0"]);
eq("día 3 con el 0 escrito: nada",P(E(3,{escritos:{dia0:"x"}})),null);
eq("día 7",P(E(7,{escritos:{dia0:"x"}})),["dia7","dia7"]);
eq("día 11: toca el 10",P(E(11,{escritos:{dia0:"x",dia7:"x"}})),["dia10","dia10"]);
eq("día 15: vencido",P(E(15,{escritos:{dia10:"x"}})),["dia12","dia12"]);
eq("contenido entregado: nada",P(E(15,{piezas:[{id:"a",tipo:"Reel",estado:"entregada"}]})),null);
eq("cerrado: nada",P(E(15,{estado:"Cerrado"})),null);
eq("en sucursal",P({estado:"Enviado",trackingCat:"en_sucursal",tracking:"36001"}),["sucursal","sucursal_36001"]);
eq("visita fallida",P({estado:"Enviado",trackingCat:"visita_fallida",tracking:"36001"}),["visita","visita_36001"]);

// Mensaje
const msg=M.ghCanjeMensaje("Hola {nombre}! {usuario} vence el {vence}, quedan {restan} días. {tracking}",{influencer:"Sofía Gómez",usuario:"@sofi.style",trackEntregadoAt:hace(7),tracking:"36001"},ahora);
eq("mensaje con datos",msg,"Hola Sofía! @sofi.style vence el 25/11, quedan 5 días. 36001");

eq("código del cupón desde el @",[M.ghCanjeCodigoDe("@sofi.style"),M.ghCanjeCodigoDe("Martín_López")],["SOFISTYLE","MARTINLOPEZ"]);
// Historial
const h=M.ghInfluencerHistorial({usuario:"@sofi.style"},[
  {usuario:"sofi.style",estado:"Cerrado",piezas:[{estado:"entregada"}],contenidoVence:"2026-10-10",contenidoCompletoAt:"2026-10-08T15:00:00Z",createdAt:"2026-09-20T15:00:00Z"},
  {usuario:"sofi.style",estado:"Cerrado",piezas:[{estado:"pendiente"}],createdAt:"2026-08-20T15:00:00Z"},
  {usuario:"SOFI.STYLE",estado:"Enviado",piezas:[],createdAt:"2026-11-10T15:00:00Z"},
  {usuario:"otra",estado:"Cerrado"},
]);
eq("historial",[h.n,h.abiertos,h.cerrados,h.cumplidos,h.aTiempo,h.conPlazo],[3,1,2,1,1,1]);

// Servidor (api/canjes.js): el influencer pega un link por pieza
import("../api/canjes.js").then(A=>{
  const c={estado:"Contenido pendiente",piezas:[{id:"a",tipo:"Reel",estado:"pendiente"},{id:"b",tipo:"Historia",estado:"pendiente"}]};
  let u=A.aplicarLinkPieza(c,"a","https://instagram.com/p/1","2026-11-20T10:00:00Z");
  eq("link marca la pieza entregada",[u.piezas[0].estado,u.piezas[0].link,u.estado],["entregada","https://instagram.com/p/1",undefined]);
  eq("contadores",u.contenido,[{tipo:"Reel",acordados:1,entregados:1},{tipo:"Historia",acordados:1,entregados:0}]);
  u=A.aplicarLinkPieza({...c,piezas:u.piezas},"b","https://x.com/2","2026-11-20T11:00:00Z");
  eq("la última cierra el canje",[u.estado,u.contenidoCompletoAt],["Cerrado","2026-11-20T11:00:00Z"]);
  const v=A.aplicarLinkPieza({estado:"Contenido pendiente",piezas:[{id:"a",tipo:"Reel",estado:"entregada",link:"x",porInfluencer:true}]},"a","","t");
  eq("borrar su link la vuelve a pendiente",v.piezas[0].estado,"pendiente");
  eq("pieza inexistente",A.aplicarLinkPieza(c,"zz","https://a.com","t"),null);
  eq("vence en el servidor igual que en el front",A.venceDe({trackEntregadoAt:"2026-11-01T18:00:00.000Z"}),"2026-11-13");
  console.log(f?`${f} de ${n} fallaron`:`${n}/${n} ok`); process.exit(f?1:0);
});
