// Pruebas del núcleo de matcheo de sucursales, extraído de src/App.jsx.
const fs=require("fs");
const src=fs.readFileSync("src/App.jsx","utf8").replace(/\r\n/g,"\n");
function fn(name){ const i=src.indexOf(`\nfunction ${name}(`); if(i<0) throw new Error("no "+name); const j=src.indexOf("\n}\n",i); return src.slice(i,j+3); }
const core=src.slice(src.indexOf("// GH_SUC_MATCH_BEGIN"),src.indexOf("// GH_SUC_MATCH_END"));
const code=core+fn("ghStripUnidad")+fn("ghTplDeOficial")+"\nreturn {ghNrmSuc,ghDirParse,ghMismaCalle,ghPuntoDeOrden,ghConflictoPunto,ghCoincidePunto,ghMatchOficial,ghMatchSucursal,ghStripUnidad,ghTplDeOficial};";
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
eq("tpl: nombre genérico no matchea nada",M.ghMatchSucursal(locs,"",{name:"Punto Andreani HOP",address:{address:"Libertador General San Martín",number:"3916"}}),null);
eq("tpl: calle+num único",M.ghMatchSucursal(locs,"",{name:"HOP",address:{address:"Juramento",number:"2621"}}),"HOP JURAMENTO 2621");
eq("tpl: calle sin número → null",M.ghMatchSucursal(locs,"",{name:"HOP",address:{address:"Juramento",number:""}}),null);
eq("tpl: dobles espacios dedupe",M.ghMatchSucursal(locs,"",{name:"HOP",address:{address:"Av. Belgrano",number:"995"}})?.replace(/s+/g," "),"HOP BELGRANO 995");
eq("tpl: Balbín 5617 no matchea 3301",M.ghMatchSucursal(locs,"",{name:"HOP",address:{address:"Balbín",number:"5617"}}),null);
eq("tpl: calle numerada",M.ghMatchSucursal(locs,"",{name:"HOP",address:{address:"Calle 13",number:"621"}}),"CALLE 13 621 LA PLATA");
eq("tpl: dirección sin pickup con dirNumero",M.ghMatchSucursal(locs,"Juramento",null,"367"),"HOP JURAMENTO 367");
eq("tpl: dirección sin pickup sin número → null",M.ghMatchSucursal(locs,"Juramento",null,""),null);

// ── ghTplDeOficial
eq("tplDeOficial: exacto",M.ghTplDeOficial(locs,libOk),"PUNTO ANDREANI HOP LIBERTADOR GENERAL SAN MARTÍN");
eq("tplDeOficial: Juramento 2621 no pasa por 367",M.ghTplDeOficial(locs,suc(1,"HOP JURAMENTO","Juramento","2621","CABA","1428")),"HOP JURAMENTO 2621");
eq("tplDeOficial: palabra ajena (ROSARIO) rechaza",M.ghTplDeOficial({sucursales:["HOP BELGRANO ROSARIO"]},suc(1,"HOP BELGRANO","Belgrano","995","CABA","1428")),null);
eq("tplDeOficial: SAN JUSTO CENTRO",M.ghTplDeOficial(locs,sj),"SAN JUSTO (CENTRO)");

console.log(`${n-fails}/${n} ok${fails?` — ${fails} FALLAS`:""}`);
process.exit(fails?1:0);
