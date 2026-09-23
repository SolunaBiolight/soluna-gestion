// Pruebas del núcleo de matcheo de sucursales, extraído de src/App.jsx.
const fs=require("fs");
const src=fs.readFileSync("src/App.jsx","utf8").replace(/\r\n/g,"\n");
function fn(name){ const i=src.indexOf(`\nfunction ${name}(`); if(i<0) throw new Error("no "+name); const j=src.indexOf("\n}\n",i); return src.slice(i,j+3); }
const core=src.slice(src.indexOf("// GH_SUC_MATCH_BEGIN"),src.indexOf("// GH_SUC_MATCH_END"));
const code=core+fn("ghStripUnidad")+fn("ghTplDeOficial")+"\nreturn {ghNrmSuc,ghDirParse,ghMismaCalle,ghPuntoDeOrden,ghConflictoPunto,ghCoincidePunto,ghMatchOficial,ghMatchSucursal,ghStripUnidad,ghTplDeOficial,ghEsHop,ghSucursalNombradaUnica};";
const M=new Function(code)();
let fails=0, n=0;
function eq(desc,got,exp){ n++; const ok=JSON.stringify(got)===JSON.stringify(exp); if(!ok){ fails++; console.log("FAIL",desc,"\n   got:",JSON.stringify(got),"\n   exp:",JSON.stringify(exp)); } }
const pd=(name,address,number,locality,zipcode)=>({pickupDetails:{name,address:{address,number,locality,zipcode}}});
const suc=(id,descripcion,calle,numero,localidad,codigoPostal,extra)=>({id,descripcion,direccion:{calle,numero,localidad,codigoPostal},...(extra||{})});

// ── ghStripUnidad
eq("strip local",M.ghStripUnidad("Juramento 2385 Local 9 y 10"),"Juramento 2385");
eq("Entre Ríos se conserva",M.ghStripUnidad("Av. Entre Ríos 1234"),"Av. Entre Ríos 1234");
eq("entre X y Z se corta",M.ghStripUnidad("Mitre 1200 entre Sarmiento y Belgrano"),"Mitre 1200");
eq("esq se corta",M.ghStripUnidad("Corrientes 1500 esq. Paraná"),"Corrientes 1500");

// ── ghDirParse
eq("num embebido",M.ghDirParse("Cosme Beccar 274","").num,"274");
eq("num aparte y embebido igual",M.ghDirParse("Cosme Beccar 274","274").calle,"COSME BECCAR");
eq("num con sufijo",M.ghDirParse("Libertador 3916","3916 Dpto 2").num,"3916");
eq("rango",M.ghDirParse("Mitre","1234/36").num,"1234");
eq("calle numerada",M.ghDirParse("Calle 13","621"),{calle:"CALLE 13",num:"621",toks:["13"],words:[],nums:["13"]});
eq("S/N",M.ghDirParse("Ruta 8","S/N").num,"");
eq("acentos",M.ghDirParse("Libertador Gral. San Martín","3916").words,["LIBERTADOR","MARTIN"]);

// ── ghMismaCalle
const D=(c,n)=>M.ghDirParse(c,n);
eq("R. Balbín ⊂ Ricardo Balbín",M.ghMismaCalle(D("R. Balbín","1"),D("Ricardo Balbín","1")),true);
eq("Juramento = Av. Juramento",M.ghMismaCalle(D("Juramento",""),D("Avenida Juramento","")),true);
eq("Martin ≠ Martinez",M.ghMismaCalle(D("San Martín",""),D("Martinez","")),false);
eq("Calle 13 = Calle 13",M.ghMismaCalle(D("Calle 13","621"),D("Calle 13","621")),true);
eq("Calle 13 ≠ Calle 14",M.ghMismaCalle(D("Calle 13","621"),D("Calle 14","621")),false);
eq("Mendoza ≠ San Justo",M.ghMismaCalle(D("Mendoza","2552"),D("Arieta","3050")),false);

// ── Ruta / intersección sin número (caso #6721 Merlo, San Luis)
{
  const merlo=M.ghPuntoDeOrden(pd("SUCURSAL ANDREANI","RUTA 5 Y AV.EL ROSEDAL S/N","","Merlo","5881"));
  const m1=suc(501,"VILLA DE MERLO (RUTA 5)","RUTA 5 Y AV.EL ROSEDAL S/N","","Merlo","5881");
  const m2=suc(502,"VILLA DE MERLO (RUTA 5)","Ruta 5 Y Av.El Rosedal","1276","Villa De Merlo","5881");
  const m3=suc(503,"VILLA DE MERLO","","","Merlo","5881");
  const chiv=suc(504,"CHIVILCOY (RUTA 5)","Ruta 5","S/N","Chivilcoy","6620");
  eq("Merlo S/N: matchea directo",M.ghMatchOficial([chiv,m3,m1,m2],merlo)?.descripcion,"VILLA DE MERLO (RUTA 5)");
  eq("Merlo S/N: coincide",M.ghCoincidePunto(merlo,m1),true);
  eq("Merlo S/N: Chivilcoy no",M.ghMatchOficial([chiv],merlo),null);
  eq("Merlo S/N: otro CP no",M.ghMatchOficial([suc(505,"X","RUTA 5 Y AV.EL ROSEDAL S/N","","Otra","5700")],merlo),null);
  eq("Ruta 5 sola no es la intersección",M.ghMatchOficial([suc(506,"X","Ruta 5","","Merlo","5881")],merlo),null);
  eq("calle común S/N no se adivina",M.ghMatchOficial([suc(507,"X","Mitre","1200","San Justo","1754")],M.ghPuntoDeOrden(pd("SUCURSAL ANDREANI","Mitre S/N","","San Justo","1754"))),null);
}

// ── Conflicto / coincide
const balbin=pd("Punto Andreani HOP Balbín","Balbín","3301","CABA","1430");
const mym=suc(9,"MYM LOGISTICA","Ricardo Balbín","5617","San Martín","1650");
eq("Balbín: otro número → grave",M.ghConflictoPunto(M.ghPuntoDeOrden(balbin),mym).grave,true);
eq("Balbín: no coincide",M.ghCoincidePunto(M.ghPuntoDeOrden(balbin),mym),false);
const lib=pd("Punto Andreani HOP","Libertador General San Martín","3916","San Justo","1754");
const libOk=suc(1,"PUNTO ANDREANI HOP LIBERTADOR GENERAL SAN MARTIN","Libertador Gral. San Martín","3916","San Justo","1754");
const libCpVecino=suc(2,"HOP LIBERTADOR","Libertador Gral San Martin","3916","San Justo","1753");
const libOtraLoc=suc(3,"HOP LIBERTADOR","Libertador Gral San Martin","3916","Villa Luzuriaga","1753");
const avLib=suc(4,"PUNTO ANDREANI HOP AVENIDA DEL LIBERTADOR GENERAL","Av. del Libertador","5000","Vicente López","1638");
eq("Libertador exacto coincide",M.ghCoincidePunto(M.ghPuntoDeOrden(lib),libOk),true);
eq("Libertador sin conflicto",M.ghConflictoPunto(M.ghPuntoDeOrden(lib),libOk),null);
eq("mismo domicilio, CP vecino, misma loc → no grave",M.ghConflictoPunto(M.ghPuntoDeOrden(lib),libCpVecino).grave,false);
eq("mismo domicilio, CP vecino, misma loc → coincide",M.ghCoincidePunto(M.ghPuntoDeOrden(lib),libCpVecino),true);
const cOtra=M.ghConflictoPunto(M.ghPuntoDeOrden(lib),libOtraLoc);
eq("mismo domicilio, otro CP y otra loc → grave mismoDom",[cOtra.grave,cOtra.mismoDom],[true,true]);
eq("Av. del Libertador 5000 → grave (misma calle laxa, otro número)",M.ghConflictoPunto(M.ghPuntoDeOrden(lib),avLib).grave,true);
// Mitre 1200 en otra ciudad
const mitre=pd("Punto HOP Mitre","Mitre","1200","San Miguel","1663");
const mitreBB=suc(5,"BAHIA BLANCA (MITRE)","Mitre","1200","Bahía Blanca","8000");
eq("Mitre 1200 otra ciudad → grave",M.ghConflictoPunto(M.ghPuntoDeOrden(mitre),mitreBB).grave,true);
eq("Mitre 1200 otra ciudad no coincide",M.ghCoincidePunto(M.ghPuntoDeOrden(mitre),mitreBB),false);
// CABA vs GBA
const caba=pd("HOP Rivadavia","Av. Rivadavia","12000","C.A.B.A.","1408");
const ciud=suc(6,"CIUDADELA","Av. Rivadavia","12000","Ciudadela","1702");
eq("CABA vs GBA → grave",M.ghConflictoPunto(M.ghPuntoDeOrden(caba),ciud).grave,true);
// Sin pickupDetails: dirección del pedido es la sucursal
const clas={direccion:"Mendoza",dirNumero:"2552",localidad:"San Justo",cp:"1754"};
const sj=suc(7,"SAN JUSTO (CENTRO)","Mendoza","2552","San Justo","1754");
eq("sin pickup coincide",M.ghCoincidePunto(M.ghPuntoDeOrden(clas),sj),true);
eq("sin datos → null",M.ghPuntoDeOrden({}),null);

// ── ghMatchOficial (auto-match silencioso)
eq("dir exacta única → match",M.ghMatchOficial([libOk,avLib],M.ghPuntoDeOrden(lib))?.id,1);
eq("nombre 'HOP Libertador' con Av. Libertador 5000 → veto (otro número)",M.ghMatchOficial([avLib],M.ghPuntoDeOrden(pd("Punto Andreani HOP Libertador","Libertador General San Martín","3916","San Justo","1754"))),null);
eq("Balbín: nombre coincide pero número no → null",M.ghMatchOficial([mym],M.ghPuntoDeOrden(balbin)),null);
eq("Mitre 1200 otra ciudad único → null",M.ghMatchOficial([mitreBB],M.ghPuntoDeOrden(mitre)),null);
eq("nombre genérico solo → null",M.ghMatchOficial([suc(8,"PUNTO ANDREANI HOP","Otra","1","San Justo","1754")],M.ghPuntoDeOrden(lib)),null);
eq("nombre no genérico sin dirección oficial → match",M.ghMatchOficial([suc(8,"HOP JURAMENTO","","","","")],M.ghPuntoDeOrden(pd("Punto HOP Juramento","Juramento","2385","CABA","1428")))?.id,8);
eq("nombre coincide, calle distinta con números → null",M.ghMatchOficial([suc(8,"HOP JURAMENTO","Cabildo","2000","CABA","1428")],M.ghPuntoDeOrden(pd("Punto HOP Juramento","Juramento","2385","CABA","1428"))),null);
eq("dos domicilios distintos → null",M.ghMatchOficial([libOk,suc(11,"OTRO","Libertador Gral San Martin","3916","San Justo","1754",{})],M.ghPuntoDeOrden(lib))?.direccion?.numero,"3916");
eq("variantes mismo nombre → 1",M.ghMatchOficial([suc(12,"SAN MIGUEL (CENTRO)","Mendoza","2552","San Justo","1754"),suc(13,"SAN MIGUEL (CENTRO)","Mendoza 2552","","San Justo","")],M.ghPuntoDeOrden(clas))?.id,12);
eq("distancia > 4 km con ancla exacta → veto",M.ghMatchOficial([{...libOk,distM:9000}],M.ghPuntoDeOrden(lib),{exacto:true}),null);
eq("distancia sin ancla exacta → no veta",M.ghMatchOficial([{...libOk,distM:9000}],M.ghPuntoDeOrden(lib),{exacto:false})?.id,1);
eq("dobles espacios / acentos",M.ghMatchOficial([suc(14,"HOP  BELGRANO","Belgrano","995","San Justo","1754")],M.ghPuntoDeOrden(pd("Punto HOP Belgrano","Belgrano","995","San Justo","1754")))?.id,14);

// ── ghMatchSucursal (template)
const locs={sucursales:["SAN JUSTO (CENTRO)","PUNTO ANDREANI HOP LIBERTADOR GENERAL SAN MARTÍN","PUNTO ANDREANI HOP AVENIDA DEL LIBERTADOR GENERAL","HOP JURAMENTO 2621","HOP JURAMENTO 367","HOP BELGRANO  995","HOP BELGRANO 995","PUNTO ANDREANI HOP BALBIN 3301","CALLE 13 621 LA PLATA"]};
eq("tpl: nombre exacto",M.ghMatchSucursal(locs,"",{name:"Punto Andreani HOP Libertador General San Martín",address:{address:"x",number:""}}),"PUNTO ANDREANI HOP LIBERTADOR GENERAL SAN MARTÍN");
// #6510 (Gabriela Schiavo): TN manda nombre genérico "PUNTO ANDREANI HOP" +
// "Libertador General San Martín 3916"; el desplegable recorta el nombre a 50
// caracteres y pierde el número → la entrada recortada es el comienzo literal.
eq("tpl: nombre genérico + entrada recortada (#6510)",M.ghMatchSucursal(locs,"",{name:"Punto Andreani HOP",address:{address:"Libertador General San Martín",number:"3916"}}),"PUNTO ANDREANI HOP LIBERTADOR GENERAL SAN MARTÍN");
eq("tpl: recortada no matchea otra calle parecida",M.ghMatchSucursal({sucursales:["PUNTO ANDREANI HOP AVENIDA DEL LIBERTADOR GENERAL"]},"",{name:"Punto Andreani HOP",address:{address:"Libertador General San Martín",number:"3916"}}),null);
eq("tpl: recortada exige número en el pedido",M.ghMatchSucursal(locs,"",{name:"Punto Andreani HOP",address:{address:"Libertador General San Martín",number:""}}),null);
eq("tpl: nombre corto sin número NO es recortado",M.ghMatchSucursal({sucursales:["PUNTO ANDREANI HOP BALBIN"]},"",{name:"Punto Andreani HOP",address:{address:"Balbín",number:"3301"}}),null);
// #6453 (Agustina Villemur): "Avenida Doctor Ricardo Balbín 3301" — 9 entradas
// idénticas recortadas + otras de la misma calle CON número distinto.
const locsBal={sucursales:["PUNTO ANDREANI HOP AV DR R BALBIN 3133","PUNTO ANDREANI HOP AVENIDA DOCTOR RICARDO BALBÍN","PUNTO ANDREANI HOP AVENIDA DOCTOR RICARDO BALBÍN","PUNTO ANDREANI HOP AVENIDA DOCTOR RICARDO BALBÍN ","PUNTO ANDREANI HOP AV DR RICARDO BALBÍN 1327","PUNTO ANDREANI HOP JULIÁN BALBÍN 450"]};
eq("tpl: Balbín 3301 → entrada recortada (#6453)",M.ghMatchSucursal(locsBal,"",{name:"Punto Andreani HOP",address:{address:"Avenida Doctor Ricardo Balbín",number:"3301"}}),"PUNTO ANDREANI HOP AVENIDA DOCTOR RICARDO BALBÍN");
eq("tpl: Balbín 3133 → la que tiene número (abreviada)",M.ghMatchSucursal(locsBal,"",{name:"Punto Andreani HOP",address:{address:"Avenida Doctor Ricardo Balbín",number:"3133"}}),"PUNTO ANDREANI HOP AV DR R BALBIN 3133");
eq("tpl: Julián Balbín 450 no se confunde con Ricardo",M.ghMatchSucursal(locsBal,"",{name:"Punto Andreani HOP",address:{address:"Julián Balbín",number:"450"}}),"PUNTO ANDREANI HOP JULIÁN BALBÍN 450");
// Calles de puras palabras cortas / títulos y abreviaturas del desplegable
eq("tpl: Av. Santa Fe 2081",M.ghMatchSucursal({sucursales:["PUNTO ANDREANI HOP AV SANTA FE 2081","PUNTO ANDREANI HOP SANTA ROSA 2081"]},"",{name:"Punto Andreani HOP",address:{address:"Av. Santa Fe",number:"2081"}}),"PUNTO ANDREANI HOP AV SANTA FE 2081");
eq("tpl: Bartolomé Mitre 1570 = AV B MITRE 1570",M.ghMatchSucursal({sucursales:["PUNTO ANDREANI HOP AV B MITRE 1570","PUNTO ANDREANI HOP AV MITRE 899"]},"",{name:"Punto Andreani HOP",address:{address:"Bartolomé Mitre",number:"1570"}}),"PUNTO ANDREANI HOP AV B MITRE 1570");
eq("tpl: Hipólito Yrigoyen 2550 = AV PTE H YRIGOYEN 2550",M.ghMatchSucursal({sucursales:["PUNTO ANDREANI HOP AV PTE H YRIGOYEN 2550"]},"",{name:"Punto Andreani HOP",address:{address:"Hipólito Yrigoyen",number:"2550"}}),"PUNTO ANDREANI HOP AV PTE H YRIGOYEN 2550");
eq("tpl: Brig. Gral. Juan Manuel de Rosas 160",M.ghMatchSucursal({sucursales:["PUNTO ANDREANI HOP AV. B. GRAL. J. M. DE ROSAS 160"]},"",{name:"Punto Andreani HOP",address:{address:"Av. Brig. Gral. Juan Manuel de Rosas",number:"160"}}),"PUNTO ANDREANI HOP AV. B. GRAL. J. M. DE ROSAS 160");
eq("tpl: Almirante Brown 1465 = ALTE G BROWN 1465",M.ghMatchSucursal({sucursales:["PUNTO ANDREANI HOP ALTE G BROWN 1465"]},"",{name:"Punto Andreani HOP",address:{address:"Almirante Brown",number:"1465"}}),"PUNTO ANDREANI HOP ALTE G BROWN 1465");
eq("tpl: mismo número en dos calles distintas → null",M.ghMatchSucursal({sucursales:["PUNTO ANDREANI HOP MITRE 1200","PUNTO ANDREANI HOP SARMIENTO 1200"]},"",{name:"Punto Andreani HOP",address:{address:"Belgrano",number:"1200"}}),null);
eq("tpl: misma calle, dos puntos con número distinto, pedido con otro → null",M.ghMatchSucursal({sucursales:["PUNTO ANDREANI HOP MITRE 1200","PUNTO ANDREANI HOP MITRE 1570"]},"",{name:"Punto Andreani HOP",address:{address:"Mitre",number:"899"}}),null);
eq("tpl: nombre con prefijo HOP vs sin prefijo",M.ghMatchSucursal({sucursales:["PUNTO ANDREANI HOP KIOSCO LA ESQUINA"]},"",{name:"Kiosco La Esquina",address:{address:"x",number:""}}),"PUNTO ANDREANI HOP KIOSCO LA ESQUINA");
eq("parse: Santa Fe conserva palabras",M.ghDirParse("Av. Santa Fe","2081").words,["SANTA","FE"]);
eq("parse: San Martín sigue siendo MARTIN",M.ghDirParse("Av. San Martín","100").words,["MARTIN"]);
eq("parse: Ruta 8 sin palabras",M.ghDirParse("Ruta 8","S/N"),{calle:"RUTA 8",num:"",toks:["8"],words:[],nums:["8"]});
eq("esHop: nombre genérico",M.ghEsHop({pickupDetails:{name:"PUNTO ANDREANI HOP"}}),true);
eq("esHop: sucursal clásica",M.ghEsHop({pickupDetails:{name:"Andreani Sucursal San Justo (Centro)"},medioEnvio:"Andreani Sucursal"}),false);
// Desplegable REAL (scripts/fixtures/tpl_sucursales.txt, generado con
// node scripts/tpl_fixture.cjs): los dos pedidos reales y calles difíciles.
try{
  const real={sucursales:fs.readFileSync(__dirname+"/fixtures/tpl_sucursales.txt","utf8").split("\n").filter(Boolean)};
  eq("real #6510 Libertador Gral San Martín 3916",M.ghMatchSucursal(real,"",{name:"PUNTO ANDREANI HOP",address:{address:"Libertador General San Martín",number:"3916",locality:"Gba Oeste",zipcode:"1754"}}),"PUNTO ANDREANI HOP LIBERTADOR GENERAL SAN MARTÍN");
  eq("real #6453 Balbín 3301",M.ghMatchSucursal(real,"",{name:"PUNTO ANDREANI HOP",address:{address:"Avenida Doctor Ricardo Balbín",number:"3301",locality:"Sin Region",zipcode:"1430"}}),"PUNTO ANDREANI HOP AVENIDA DOCTOR RICARDO BALBÍN");
  eq("real Santa Fe 2081",M.ghMatchSucursal(real,"",{name:"PUNTO ANDREANI HOP",address:{address:"Av. Santa Fe",number:"2081"}}),"PUNTO ANDREANI HOP AV SANTA FE 2081");
  eq("real Bartolomé Mitre 1570",M.ghMatchSucursal(real,"",{name:"PUNTO ANDREANI HOP",address:{address:"Bartolomé Mitre",number:"1570"}}),"PUNTO ANDREANI HOP AV B MITRE 1570");
  eq("real Balbín 5617 (MyM, no es HOP) → null",M.ghMatchSucursal(real,"",{name:"PUNTO ANDREANI HOP",address:{address:"Ricardo Balbín",number:"5617"}}),null);
  eq("real sin número → null",M.ghMatchSucursal(real,"",{name:"PUNTO ANDREANI HOP",address:{address:"Avenida Doctor Ricardo Balbín",number:""}}),null);
}catch(e){ console.log("(sin fixture real: "+e.message.split("\n")[0]+")"); }
eq("tpl: calle+num único",M.ghMatchSucursal(locs,"",{name:"HOP",address:{address:"Juramento",number:"2621"}}),"HOP JURAMENTO 2621");
eq("tpl: calle sin número → null",M.ghMatchSucursal(locs,"",{name:"HOP",address:{address:"Juramento",number:""}}),null);
eq("tpl: dobles espacios dedupe",M.ghMatchSucursal(locs,"",{name:"HOP",address:{address:"Av. Belgrano",number:"995"}})?.replace(/\s+/g," "),"HOP BELGRANO 995");
eq("tpl: Balbín 5617 no matchea 3301",M.ghMatchSucursal(locs,"",{name:"HOP",address:{address:"Balbín",number:"5617"}}),null);
eq("tpl: calle numerada",M.ghMatchSucursal(locs,"",{name:"HOP",address:{address:"Calle 13",number:"621"}}),"CALLE 13 621 LA PLATA");
eq("tpl: dirección sin pickup con dirNumero",M.ghMatchSucursal(locs,"Juramento",null,"367"),"HOP JURAMENTO 367");
eq("tpl: dirección sin pickup sin número → null",M.ghMatchSucursal(locs,"Juramento",null,""),null);

// ── ghTplDeOficial
eq("tplDeOficial: exacto",M.ghTplDeOficial(locs,libOk),"PUNTO ANDREANI HOP LIBERTADOR GENERAL SAN MARTÍN");
eq("tplDeOficial: Juramento 2621 no pasa por 367",M.ghTplDeOficial(locs,suc(1,"HOP JURAMENTO","Juramento","2621","CABA","1428")),"HOP JURAMENTO 2621");
eq("tplDeOficial: palabra ajena (ROSARIO) rechaza",M.ghTplDeOficial({sucursales:["HOP BELGRANO ROSARIO"]},suc(1,"HOP BELGRANO","Belgrano","995","CABA","1428")),null);
eq("tplDeOficial: SAN JUSTO CENTRO",M.ghTplDeOficial(locs,sj),"SAN JUSTO (CENTRO)");

// ── Paridad con la copia del servidor (api/_suc_match.js): mismos casos, mismos resultados
(async()=>{
  const S=await import("../api/_suc_match.js");
  const casos=[[balbin,mym],[lib,libOk],[lib,libCpVecino],[lib,libOtraLoc],[lib,avLib],[mitre,mitreBB],[caba,ciud],[clas,sj]];
  for(const [o,s] of casos){
    const p1=M.ghPuntoDeOrden(o), p2=S.ghPuntoDeOrden(o);
    eq("paridad conflicto "+s.descripcion,S.ghConflictoPunto(p2,s),M.ghConflictoPunto(p1,s));
    eq("paridad coincide "+s.descripcion,S.ghCoincidePunto(p2,s),M.ghCoincidePunto(p1,s));
  }
  eq("paridad matchOficial",S.ghMatchOficial([libOk,avLib],S.ghPuntoDeOrden(lib))?.id,M.ghMatchOficial([libOk,avLib],M.ghPuntoDeOrden(lib))?.id);
  eq("paridad strip",S.ghStripUnidad("Av. Entre Ríos 1234 Local 3"),M.ghStripUnidad("Av. Entre Ríos 1234 Local 3"));
  for(const [c,n] of [["Av. Santa Fe","2081"],["AV B MITRE 1570",""],["Av. Brig. Gral. Juan Manuel de Rosas","160"],["Calle 13","621"],["Ruta 8","S/N"]]) eq("paridad parse "+c,S.ghDirParse(c,n),M.ghDirParse(c,n));
  eq("paridad esHop",S.ghEsHop({pickupDetails:{name:"PUNTO ANDREANI HOP"}}),M.ghEsHop({pickupDetails:{name:"PUNTO ANDREANI HOP"}}));
  eq("clave → punto",S.ghPuntoDeClave("PUNTO HOP|BALBIN|3301|1430"),{nombre:"PUNTO HOP",calle:"BALBIN",num:"3301",loc:"",cp:"1430",conPickup:true});
  eq("conflictoTpl grave",S.ghConflictoTpl(S.ghPuntoDeClave("PUNTO HOP|BALBIN|3301|1430"),"PUNTO ANDREANI HOP BALBIN 5617")?.grave,true);
  eq("conflictoTpl ok",S.ghConflictoTpl(S.ghPuntoDeClave("PUNTO HOP|BALBIN|3301|1430"),"PUNTO ANDREANI HOP BALBIN 3301"),null);
  // ── Puntos HOP reales (api/_hop_index.json, 16/9/2026): lo que ve el lote
  // por API una vez que sucursalesPorCp/sucursalesTodas mezclan el índice.
  {
    const IDX=JSON.parse(fs.readFileSync("api/_hop_index.json","utf8"));
    const exp=r=>({id:r[0],codigo:r[1]||null,numero:r[1]?String(r[1]).replace(/\D/g,""):null,descripcion:r[2],direccion:{calle:r[3],numero:r[4],provincia:r[6],localidad:r[5],region:r[7],pais:"Argentina",codigoPostal:r[8]},horarioDeAtencion:r[11],lat:r[9],lng:r[10],hop:true});
    const HOP=IDX.recs.map(exp);
    const TPL={sucursales:fs.readFileSync("scripts/fixtures/tpl_sucursales.txt","utf8").split(/\r?\n/).filter(Boolean)};
    eq("índice HOP: tamaño",HOP.length>2500,true);
    eq("índice HOP: todos con CP y coordenadas",HOP.every(h=>/^\d{4}$/.test(h.direccion.codigoPostal)&&h.lat!=null&&h.lng!=null),true);
    eq("índice HOP: ids únicos",new Set(HOP.map(h=>h.id)).size,HOP.length);
    eq("índice HOP: ghEsHop los reconoce a todos",HOP.every(h=>M.ghEsHop({pickupDetails:{name:h.descripcion}})),true);
    // Lista por CP como la arma el servidor: oficiales de Andreani + HOP del CP
    const l1754=[suc(10020,"SAN JUSTO (CENTRO)","Mendoza","2552","San Justo","1754"),...HOP.filter(h=>h.direccion.codigoPostal==="1754")];
    const o6510=pd("PUNTO ANDREANI HOP","Libertador General San Martín","3916","Gba Oeste","1754");
    const p6510=M.ghPuntoDeOrden(o6510);
    eq("#6510 lote API: match silencioso al HOP 14685",M.ghMatchOficial(l1754,p6510)?.id,14685);
    eq("#6510 sin conflicto grave (la ciudad de TN es la región Gba Oeste)",M.ghConflictoPunto(p6510,HOP.find(h=>h.id===14685))?.grave||false,false);
    eq("#6510 coincide",M.ghCoincidePunto(p6510,HOP.find(h=>h.id===14685)),true);
    eq("#6510 Excel: traducción al desplegable",M.ghTplDeOficial(TPL,HOP.find(h=>h.id===14685)),"PUNTO ANDREANI HOP LIBERTADOR GENERAL SAN MARTÍN");
    const l1430=[suc(10004,"VILLA URQUIZA (AV  ALVAREZ TOMAS)","Av. Alvarez Thomas","3500","C.a.b.a.","1427"),...HOP.filter(h=>h.direccion.codigoPostal==="1430")];
    const o6453=pd("PUNTO ANDREANI HOP","Avenida Doctor Ricardo Balbín","3301","Sin Region","1430");
    const p6453=M.ghPuntoDeOrden(o6453);
    eq("#6453 lote API: match silencioso al HOP 16652",M.ghMatchOficial(l1430,p6453)?.id,16652);
    // Buscador global (todo el índice + los 9 Balbín de nombre idéntico): sigue único
    eq("#6453 buscador global: único entre todos los HOP",M.ghMatchOficial(HOP,p6453)?.id,16652);
    eq("#6510 buscador global: único entre todos los HOP",M.ghMatchOficial(HOP,p6510)?.id,14685);
    const tpl6453=M.ghTplDeOficial(TPL,HOP.find(h=>h.id===16652));
    eq("#6453 Excel: traducción al desplegable (nombre recortado)",String(tpl6453||"").trim(),"PUNTO ANDREANI HOP AVENIDA DOCTOR RICARDO BALBÍN");
    // Un pedido a OTRO Balbín (5617) no puede caer en el 3301
    const pOtro=M.ghPuntoDeOrden(pd("PUNTO ANDREANI HOP","Avenida Doctor Ricardo Balbín","5617","C.a.b.a.","1431"));
    const mOtro=M.ghMatchOficial(HOP,pOtro);
    eq("Balbín 5617 no matchea al 3301",mOtro?.id===16652,false);
    eq("Balbín 5617: si matchea, es el de número 5617",!mOtro||mOtro.direccion.numero==="5617",true);
    // Muestra amplia: para cada HOP con número, un pedido con su calle+número+CP lo encuentra a él (o a nadie), nunca a otro
    let malos=0, hallados=0, probados=0;
    for(const h of HOP.filter((_,i)=>i%7===0)){ if(!/^\d+$/.test(h.direccion.numero)) continue; probados++; const p=M.ghPuntoDeOrden(pd("PUNTO ANDREANI HOP",h.direccion.calle,h.direccion.numero,h.direccion.localidad,h.direccion.codigoPostal)); const m=M.ghMatchOficial(HOP.filter(x=>x.direccion.codigoPostal===h.direccion.codigoPostal),p); if(m){ hallados++; if(m.id!==h.id&&!(m.direccion.calle===h.direccion.calle&&m.direccion.numero===h.direccion.numero)) malos++; } }
    eq(`muestra ${probados} HOP por CP: ninguno cae en OTRO punto`,malos,0);
    eq(`muestra ${probados} HOP por CP: la gran mayoría se encuentra (${hallados})`,hallados>=probados*0.9,true);
  }
  { const TPL2={sucursales:fs.readFileSync("scripts/fixtures/tpl_sucursales.txt","utf8").split(/\r?\n/).filter(Boolean)};
    const P={calle:"San Martín",num:"2127",loc:"Rosario",cp:"2000"};
    eq("Rosario (Av San Martin) única en su calle → match",M.ghSucursalNombradaUnica(TPL2.sucursales,"ROSARIO (AV SAN MARTIN)",P),true);
    eq("otra calle de Rosario no",M.ghSucursalNombradaUnica(TPL2.sucursales,"ROSARIO (CIRCUNVALACION)",P),false);
    eq("otra ciudad no",M.ghSucursalNombradaUnica(TPL2.sucursales,"ROSARIO (AV SAN MARTIN)",{...P,loc:"Santa Fe"}),false);
    eq("sin número de puerta no",M.ghSucursalNombradaUnica(TPL2.sucursales,"ROSARIO (AV SAN MARTIN)",{...P,num:""}),false);
    eq("HOP recortado no",M.ghSucursalNombradaUnica(TPL2.sucursales,"PUNTO ANDREANI HOP AVENIDA DOCTOR RICARDO BALBÍN",{calle:"Ricardo Balbín",num:"3301",loc:"CABA"}),false);
    eq("dos hermanas en la misma calle → no",M.ghSucursalNombradaUnica(["X (SAN MARTIN)","X (AV SAN MARTIN)"],"X (SAN MARTIN)",{...P,loc:"X"}),false);
  }
  console.log(`${n-fails}/${n} ok${fails?` — ${fails} FALLAS`:""}`);
  process.exit(fails?1:0);
})();
