// Pruebas de la métrica de recompra (api/orders.js: recompraVentas, recompraNuevas, recompraDe). node scripts/recompra_test.cjs
const fs=require("fs"); const src=fs.readFileSync("api/orders.js","utf8");
const i=src.indexOf("export const RECOMPRA_SHARDS"); const j=src.indexOf("// ── Dirección y documento de Shopify",i);
const {createHash}=require("crypto");
const R=new Function("createHash",src.slice(i,j).replace(/export (const|function)/g,"$1")+"\nreturn {recompraVentas,recompraNuevas,recompraDe,recompraHash};")(createHash);
let n=0,f=0; const eq=(d,g,e)=>{ n++; if(JSON.stringify(g)!==JSON.stringify(e)){ f++; console.log("FAIL",d,"\n   got:",JSON.stringify(g),"\n   exp:",JSON.stringify(e)); } };
const raw={orders_detail:[
  {id:"1",platform:"tiendanube",cust:"111",fecha:"2026-10-05T10:00",revenue:"1000"}, // nueva
  {id:"2",platform:"tiendanube",cust:"222",fecha:"2026-10-06T10:00",revenue:"2000"}, // ya compró en septiembre (índice)
  {id:"3",platform:"tiendanube",cust:"111",fecha:"2026-10-20T10:00",revenue:"500"},  // segunda compra en el período
  {id:"4",platform:"tiendanube",cust:"333",fecha:"2026-10-07T10:00",revenue:"300"},
  {id:"5",platform:"tiendanube",cust:"333",fecha:"2026-10-07T18:00",revenue:"200"},  // mismo día, otra orden
  {id:"6",platform:"tiendanube",cust:"",fecha:"2026-10-07",revenue:"999"},           // sin cliente: no cuenta
  {id:"7",platform:"tiendanube",cust:"444",fecha:"2026-10-08",revenue:"0"},          // $0: no cuenta
], ml_data:{ml_orders_detail:[
  {id:"m1",cust:"222",fecha:"2026-10-09",revenue:"700"},                // comprador ML 222 ≠ cliente tienda 222
  {id:"m2",cust:"999",fecha:"2026-10-10",revenue:"100",refunded:true},  // devuelta: no cuenta
]}};
const V=R.recompraVentas(raw);
eq("ventas válidas",V.length,6);
const idx0={[R.recompraHash("tiendanube:222")]:"2026-09-12|90"};
const nuevas=R.recompraNuevas(V,idx0);
eq("primeras compras nuevas",Object.keys(nuevas).length,3); // 111, 333 y ml:222
eq("primera de 111 = orden 1",nuevas[R.recompraHash("tiendanube:111")],"2026-10-05|1");
eq("no pisa la de septiembre",nuevas[R.recompraHash("tiendanube:222")],undefined);
const idx={...idx0,...nuevas};
const r=R.recompraDe(V,idx);
// recompra: orden 2 (2000, ya había comprado), orden 3 (500, segunda), orden 5 (200, mismo día otra orden) = 2700 de 4700
eq("facturación",r.facturacion,4700);
eq("recompra",r.recompra,2700);
eq("% de facturación",r.pct,57.4);
eq("órdenes de recompra",[r.ordenes,r.ordenesRecompra],[6,3]);
eq("clientes y los que volvieron",[r.clientes,r.clientesVolvieron],[4,3]);
eq("ML aparte: no es recompra",R.recompraDe([V.find(v=>v.id==="m1")],idx).recompra,0);
eq("índice vacío: todo nuevo salvo repetidos",R.recompraDe(V,R.recompraNuevas(V,{})).recompra,700);
console.log(`${n-f}/${n} ok${f?" — "+f+" FALLAS":""}`); if(f) process.exit(1);
