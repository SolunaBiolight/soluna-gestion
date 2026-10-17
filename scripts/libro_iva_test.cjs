// Pruebas del Libro IVA Digital (api/_libro_iva.js). Sin dependencias: node scripts/libro_iva_test.cjs
const fs=require("fs"); const src=fs.readFileSync("api/_libro_iva.js","utf8");
const L=new Function(src.replace(/export (const|function)/g,"$1")+"\nreturn {libroIva,libroAlicDe};")();
let n=0,f=0; const eq=(d,g,e)=>{ n++; if(JSON.stringify(g)!==JSON.stringify(e)){ f++; console.log("FAIL",d,"\n   got:",JSON.stringify(g),"\n   exp:",JSON.stringify(e)); } };
const ventas=[
  {fecha:"2026-09-02",tipo:6,pv:3,nro:125,docTipo:99,docNro:"",nombre:"",total:12100,neto:10000,iva:2100},
  {fecha:"2026-09-01",tipo:1,pv:3,nro:40,docTipo:80,docNro:"30-71234567-8",nombre:"Ñandú S.A. Óptica",total:11050,neto:10000,iva:1050,alic:[{id:4,base:10000,importe:1050}]},
  {fecha:"2026-09-03",tipo:11,pv:3,nro:1,total:500}, // factura C: no va
  {fecha:"2026-09-04",tipo:6,pv:3,nro:126,docTipo:96,docNro:"30111222",nombre:"Ana",total:800,neto:0,iva:0,exento:800},
];
const compras=[
  {fecha:"2026-09-05",tipo:1,pv:2,nro:999,docNro:"20123456789",nombre:"Proveedor",total:1210,neto:1000,iva:210},
  {fecha:"2026-09-06",tipo:11,pv:1,nro:7,docNro:"27111222333",nombre:"Mono",total:300,neto:300,iva:0},
];
const r=L.libroIva({ventas,compras});
const vl=r.ventasCbte.split("\r\n").filter(Boolean), al=r.ventasAlic.split("\r\n").filter(Boolean);
const cl=r.comprasCbte.split("\r\n").filter(Boolean), cal=r.comprasAlic.split("\r\n").filter(Boolean);
eq("ventas sin la C",vl.length,3);
eq("largo ventas 266",vl.map(l=>l.length),[266,266,266]);
eq("largo alícuotas ventas 62",al.map(l=>l.length),[62,62,62]);
eq("largo compras 325",cl.map(l=>l.length),[325,325]);
eq("largo alícuotas compras 84",cal.map(l=>l.length),[84]);
eq("ordenadas por fecha: primero la A",vl[0].slice(0,11),"20260901001");
eq("CUIT sin guiones a 20",vl[0].slice(56,78),"8000000000030712345678");
eq("nombre sin acentos",vl[0].slice(78,108),"NANDU S.A. OPTICA             ");
eq("total con 2 decimales",vl[0].slice(108,123),"000000001105000");
eq("consumidor final: doc 99 y nro 0",vl[1].slice(56,78),"9900000000000000000000");
eq("alícuota 10,5 = código 4",al[0].slice(43,47),"0004");
eq("alícuota 21 deducida",al[1].slice(28,62),"000000001000000"+"0005"+"000000000210000");
eq("exento: operación E y alícuota 0",[vl[2][242],al[2].slice(43,47)],["E","0003"]);
eq("compra C sin alícuotas, no gravado",[cl[1][238],cl[1][237],cl[1].slice(119,134)],["N","0","000000000030000"]);
eq("crédito fiscal computable",cl[0].slice(239,254),"000000000021000");
eq("libroAlicDe 27%",L.libroAlicDe(100,27),6);
console.log(`${n-f}/${n} ok`); process.exit(f?1:0);
