// Pruebas de las reglas puras de Reclamos (bloque GH_RECLAMOS en src/App.jsx):
// pasos por tipo, paso siguiente, qué hay que hacer y mensaje sugerido.
// Sin dependencias: node scripts/reclamos_test.cjs
const fs=require("fs");
const src=fs.readFileSync("src/App.jsx","utf8");
const blk=src.slice(src.indexOf("// GH_RECLAMOS_BEGIN"),src.indexOf("// GH_RECLAMOS_END"));
const est=src.match(/const ESTADOS_R = \[[^\]]+\];/)[0];
const M=new Function(est+blk+"\nreturn {ghRecPasos,ghRecSiguiente,ghRecVerbo,ghRecQueHacer,ghRecTel,ghRecMensaje,ghRecAbierto};")();
let n=0,f=0; const eq=(d,g,e)=>{ n++; if(JSON.stringify(g)!==JSON.stringify(e)){ f++; console.log("FAIL",d,"\n   got:",JSON.stringify(g),"\n   exp:",JSON.stringify(e)); } };
const R=(tipo,estado,x={})=>({tipo,estado,orderNum:"1234",clienteNombre:"Ana Ríos",...x});
// pasos por tipo
eq("devolución no tiene Envío en camino",M.ghRecPasos("Devolución").includes("Envío en camino"),false);
eq("reclamo simple: 3 pasos",M.ghRecPasos("Reclamo"),["Nuevo","Contactado","Resuelto"]);
// paso siguiente
eq("cambio: recibido → envío",M.ghRecSiguiente(R("Cambio","Producto recibido")),"Envío en camino");
eq("devolución: recibido → resuelto",M.ghRecSiguiente(R("Devolución","Producto recibido")),"Resuelto");
eq("reclamo: contactado → resuelto",M.ghRecSiguiente(R("Reclamo","Contactado")),"Resuelto");
eq("cerrado no tiene siguiente",M.ghRecSiguiente(R("Cambio","Resuelto")),null);
eq("estado fuera del recorrido del tipo",M.ghRecSiguiente(R("Reclamo","Esperando producto")),"Resuelto");
eq("estado viejo (Pendiente)",M.ghRecSiguiente(R("Cambio","Pendiente")),"Nuevo");
eq("verbo de cierre de devolución",M.ghRecVerbo(R("Devolución","Producto recibido"),"Resuelto"),"Reembolso hecho, cerrar");
// qué hacer
const Q=r=>{ const q=M.ghRecQueHacer(r); return [q.txt,q.accion,q.alerta]; };
eq("nuevo = escribir",Q(R("Cambio","Nuevo")),["Escribirle al cliente",true,false]);
eq("contactado = esperar",Q(R("Cambio","Contactado"))[1],false);
eq("esperando sin seguimiento = pedirlo",Q(R("Cambio","Esperando producto")),["Pedirle el seguimiento de la devolución",true,false]);
eq("esperando con link de otro correo = esperar",Q(R("Cambio","Esperando producto",{devolLink:"http://x"}))[1],false);
eq("devolución en sucursal = retirar (alerta)",Q(R("Devolución","Esperando producto",{trackingDevolucion:"36",trackDevolCat:"en_sucursal"})),["Retirar la devolución en la sucursal",true,true]);
eq("recibido devolución = reembolso",Q(R("Devolución","Producto recibido"))[0],"Hacer el reembolso");
eq("recibido cambio = despachar",Q(R("Cambio","Producto recibido"))[0],"Despachar el cambio");
eq("envío sin seguimiento = cargarlo",Q(R("Cambio","Envío en camino"))[0],"Cargar el seguimiento del cambio");
eq("envío en viaje = esperar",Q(R("Cambio","Envío en camino",{trackingCambio:"36",trackCambioCat:"en_camino"}))[1],false);
eq("visita fallida = alerta",Q(R("Cambio","Envío en camino",{trackingCambio:"36",trackCambioCat:"visita_fallida"}))[2],true);
// teléfono
eq("tel con 54",M.ghRecTel("+54 9 11 5555-4444"),"5491155554444");
eq("tel sin 54 y con 0",M.ghRecTel("011 5555 4444"),"541155554444");
eq("tel corto",M.ghRecTel("123"),"");
// mensajes
eq("saluda por el nombre y nombra el pedido",/^Hola Ana,.*#1234/.test(M.ghRecMensaje(R("Cambio","Nuevo"))),true);
eq("sin nombre no deja espacio raro",M.ghRecMensaje(R("Cambio","Nuevo",{clienteNombre:""})).startsWith("Hola, "),true);
eq("envío en camino incluye el link",M.ghRecMensaje(R("Cambio","Envío en camino",{trackingCambio:"360001"})).includes("andreani.com/envio/360001"),true);
eq("devolución recibida habla de reembolso",/reembolso/.test(M.ghRecMensaje(R("Devolución","Producto recibido"))),true);
console.log(`${n-f}/${n} ok${f?" — "+f+" FALLAS":""}`); if(f) process.exit(1);
