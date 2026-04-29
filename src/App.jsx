import React, { useState, useEffect, useMemo, useRef } from "react";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, setDoc, getDoc, query, where, getDocs, orderBy } from "firebase/firestore";
import { getAuth, signInWithPopup, GoogleAuthProvider, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged, updateProfile } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyDT-cAeF1lm-xhIDtv0FZam88yhvLIcbMo",
  authDomain: "soluna-gestion.firebaseapp.com",
  projectId: "soluna-gestion",
  storageBucket: "soluna-gestion.firebasestorage.app",
  messagingSenderId: "377364762337",
  appId: "1:377364762337:web:ec1d8ec0d33bda382771a0"
};
const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);
const auth = getAuth(fbApp);
const googleProvider = new GoogleAuthProvider();

// Owner email for existing data migration
const OWNER_EMAIL = "soluna.biolight@gmail.com";

// ─── Theme ───
const DARK = {
  bg:       "#0d1117",
  surface:  "#13181f",
  card:     "#161b22",
  border:   "#27272a",
  borderL:  "#1f1f22",
  text:     "#fafafa",
  textMd:   "#a1a1aa",
  textSm:   "#71717a",
  accent:   "#a78bfa",
  accentSolid:"#7c3aed",
  green:    "#4ade80",
  greenBg:  "#052e16",
  yellow:   "#fbbf24",
  yellowBg: "#1c1400",
  red:      "#f87171",
  redBg:    "#1f0707",
  purple:   "#c084fc",
  purpleBg: "#1a0a2e",
  blue:     "#60a5fa",
  blueBg:   "#0a1628",
  orange:   "#fb923c",
  orangeBg: "#1c0a00",
  input:    "#18181b",
  inputBorder:"#3f3f46",
  badge: (dot) => ({ bg: dot+"18", border: dot+"33" }),
};

const LIGHT = {
  bg:       "#f4f4f5",
  surface:  "#fafafa",
  card:     "#ffffff",
  border:   "#e4e4e7",
  borderL:  "#f0f0f2",
  text:     "#09090b",
  textMd:   "#52525b",
  textSm:   "#a1a1aa",
  accent:   "#7c3aed",
  accentSolid:"#7c3aed",
  green:    "#16a34a",
  greenBg:  "#f0fdf4",
  yellow:   "#ca8a04",
  yellowBg: "#fefce8",
  red:      "#dc2626",
  redBg:    "#fef2f2",
  purple:   "#7c3aed",
  purpleBg: "#f5f3ff",
  blue:     "#2563eb",
  blueBg:   "#eff6ff",
  orange:   "#ea580c",
  orangeBg: "#fff7ed",
  input:    "#ffffff",
  inputBorder:"#d4d4d8",
  badge: (dot) => ({ bg: dot+"18", border: dot+"33" }),
};

// ─── Constants ───
const MOTIVOS_R = ["Producto dañado","Color incorrecto","No cumple expectativas","Problema con el lente","Error en el pedido","Armazón roto","Otro"];
const ESTADOS_R = ["Nuevo","Contactado","Esperando producto","Producto recibido","Envío en camino","Resuelto","Rechazado"];
const TIPOS_R = ["Cambio","Devolución"];
const PRODUCTOS = ["Amarillo - Marco Negro","Amarillo - M. Transparente","Naranja - Marco Negro","Naranja - M. Transparente","Rojo - Marco Negro","Rojo - M. Transparente","Clip-On","Líquido Limpia Cristales"];
const SKU_LENTE = { "AMARILLO-NN":"Amarillo","AMARILLO-TT":"Amarillo","NARAN-NN":"Naranja","NARAN-TT":"Naranja","ROJ-NN":"Rojo","ROJ-TT":"Rojo","N-N":"Negro","N-R":"Negro/Rojo","R-R":"Rojo/Rojo","CLIP-ON":"Clip-On","LIQ":"Líquido" };
const LENTE_DOT = { Amarillo:"#fbbf24",Naranja:"#fb923c",Rojo:"#f87171",Negro:"#a1a1aa","Clip-On":"#c084fc",Líquido:"#60a5fa" };
const ESTADOS_C = ["Pendiente envío","Enviado","Contenido pendiente","Contenido publicado","Finalizado","Cancelado"];
const REDES = ["Instagram","TikTok","YouTube","Twitter/X","Otro"];
const ACTIVIDADES = ["Story","Reel","UGC","Review","Unboxing","Exp. Personal"];
const NICHOS = ["Fitness","Biohacking","Nutrición","Lifestyle","Wellness","Tech","Futbolista","Streamer","Otro"];
const PRODUCTOS_CANJE = ["Amarillo - Marco Negro","Amarillo - M. Transparente","Naranja - Marco Negro","Naranja - M. Transparente","Rojo - Marco Negro","Rojo - M. Transparente","Clip-On","Kit Completo","A elección"];

// ─── Helpers ───
function fmtMoney(v) { const n=parseFloat(v); if(isNaN(n)) return '—'; return '$'+n.toLocaleString('es-AR',{minimumFractionDigits:0,maximumFractionDigits:0}); }
function fmtDate(d) { if(!d) return '—'; const p=d.split(' ')[0].split('/'); if(p.length===3) return `${p[0]}/${p[1]}/${p[2]}`; return d; }
function fmtTs(ts) { if(!ts?.seconds) return '—'; return new Date(ts.seconds*1000).toLocaleDateString('es-AR'); }
function fullAddress(o) { let a=o.direccion||''; if(o.dirNumero) a+=' '+o.dirNumero; if(o.piso) a+=', Piso '+o.piso; return [a,o.localidad,o.ciudad,o.cp?`CP ${o.cp}`:'',o.provincia].filter(Boolean).join(', '); }
function getLensColors(productos) { const s=new Set(); for(const p of productos){const c=SKU_LENTE[p.sku];if(c)s.add(c);} return [...s]; }
function mapEstadoEnvio(s) { return {"unpacked":"Por empaquetar","ready_to_ship":"Por enviar","shipped":"Enviado","delivered":"Entregado","unshipped":"Por empaquetar"}[s]||s||'—'; }
function mapEstadoPago(s) { return {"pending":"Pendiente","paid":"Pagado","voided":"Anulado","refunded":"Reembolsado","abandoned":"Abandonado"}[s]||s||'—'; }

function getEstadoEnvioC(T, estado) {
  const m = {
    "Por cobrar":     { dot:T.orange, bg:T.orangeBg, text:T.orange },
    "Por empaquetar": { dot:T.yellow, bg:T.yellowBg, text:T.yellow },
    "Por enviar":     { dot:T.blue,   bg:T.blueBg,   text:T.blue   },
    "Enviado":        { dot:T.purple, bg:T.purpleBg, text:T.purple },
    "Entregado":      { dot:T.green,  bg:T.greenBg,  text:T.green  },
  };
  return m[estado] || { dot:T.textSm, bg:T.borderL, text:T.textSm };
}
function getEstadoRC(T, estado) {
  const m = {
    Nuevo:               { dot:T.blue,   bg:T.blueBg,   text:T.blue   },
    Contactado:          { dot:T.yellow, bg:T.yellowBg, text:T.yellow },
    "Esperando producto":{ dot:T.orange, bg:T.orangeBg, text:T.orange },
    "Producto recibido": { dot:T.purple, bg:T.purpleBg, text:T.purple },
    "Envío en camino":   { dot:T.accent, bg:T.accentSolid+"18", text:T.accent },
    Resuelto:            { dot:T.green,  bg:T.greenBg,  text:T.green  },
    Rechazado:           { dot:T.red,    bg:T.redBg,    text:T.red    },
    // legacy
    Pendiente:           { dot:T.blue,   bg:T.blueBg,   text:T.blue   },
    "En proceso":        { dot:T.yellow, bg:T.yellowBg, text:T.yellow },
  };
  return m[estado] || { dot:T.textSm, bg:T.borderL, text:T.textSm };
}
function getEstadoCC(T, estado) {
  const m = {
    "Pendiente envío":     { dot:T.yellow, bg:T.yellowBg, text:T.yellow },
    "Enviado":             { dot:T.blue,   bg:T.blueBg,   text:T.blue   },
    "Contenido pendiente": { dot:T.orange, bg:T.orangeBg, text:T.orange },
    "Contenido publicado": { dot:T.purple, bg:T.purpleBg, text:T.purple },
    "Finalizado":          { dot:T.green,  bg:T.greenBg,  text:T.green  },
    "Cancelado":           { dot:T.red,    bg:T.redBg,    text:T.red    },
  };
  return m[estado] || { dot:T.textSm, bg:T.borderL, text:T.textSm };
}
function getTipoRC(T, tipo) {
  return tipo === "Cambio"
    ? { bg:T.purpleBg, text:T.purple }
    : { bg:T.orangeBg, text:T.orange };
}

function buildOrdersFromAPI(data) {
  if(!Array.isArray(data)) return [];
  return data.map(o=>{
    const sh=o.shipping_address||{};
    // Determinar tab de TN exacto según combinación pago+envío
    let estadoEnvio;
    const ps=o.payment_status; // pending|paid|partially_paid|partially_refunded|voided|refunded|abandoned
    const ss=o.shipping_status; // unpacked|ready_to_ship|shipped|delivered|partially_shipped
    if(ps==="pending"||ps==="partially_paid") {
      estadoEnvio="Por cobrar";
    } else if((ps==="paid"||ps==="partially_paid"||ps==="partially_refunded")&&(ss==="unpacked"||ss==="partially_shipped"||!ss)) {
      estadoEnvio="Por empaquetar";
    } else if((ps==="paid"||ps==="partially_refunded")&&(ss==="ready_to_ship"||ss==="partially_shipped")) {
      estadoEnvio="Por enviar";
    } else if(ss==="shipped"||ss==="delivered") {
      estadoEnvio=mapEstadoEnvio(ss);
    } else {
      estadoEnvio=mapEstadoEnvio(ss);
    }
    return {
      numero:String(o.number||o.id),
      fecha:o.created_at?new Date(o.created_at).toLocaleDateString('es-AR'):'',
      comprador:`${sh.name||''} ${sh.last_name||''}`.trim()||o.contact_name||'',
      email:o.contact_email||'', telefono:o.contact_phone||'', dni:o.contact_identification||'',
      estadoOrden:o.status||'', estadoPago:mapEstadoPago(o.payment_status),
      estadoEnvio,
      total:String(o.total||''), subtotal:String(o.subtotal||''), descuento:String(o.discount||'0'),
      costoEnvio:String(o.shipping_cost_customer||'0'),
      nombreEnvio:`${sh.name||''} ${sh.last_name||''}`.trim(),
      telEnvio:o.contact_phone||'', direccion:sh.address||'', dirNumero:sh.number||'',
      piso:sh.floor||'', localidad:sh.locality||'', ciudad:sh.city||'',
      cp:sh.zipcode||'', provincia:sh.province||'',
      medioEnvio:o.shipping_option||'', medioPago:o.payment_details?.method||o.gateway_name||'',
      esSucursal:o.fulfillments?.some(f=>f.shipping?.option?.name?.toLowerCase().includes('sucursal'))||o.shipping_option==="Punto de retiro"||false,
      pickupDetails:o.shipping_pickup_details||null,
      canal:o.storefront||'', tracking:o.shipping_tracking_number||'',
      linkOrden:`https://solunabiolight2.mitiendanube.com/admin/orders/${o.id}`,
      fechaPago:o.paid_at||'', fechaEnvio:o.shipped_at||'',
      productos:(o.products||[]).map(p=>({nombre:p.name||'',precio:String(p.price||''),cantidad:String(p.quantity||'1'),sku:p.sku||''})),
    };
  }).sort((a,b)=>parseInt(b.numero)-parseInt(a.numero));
}

// ─── Andreani shared cache (module level) ───
const _andreaniLocsCache = { current: null };

// ─── UI Components ───

// Inject spinner keyframe CSS once
if(typeof document!=="undefined"&&!document.getElementById("growith-spin")){
  const s=document.createElement("style");
  s.id="growith-spin";
  s.textContent=`@keyframes growith-spin{to{transform:rotate(360deg)}} @keyframes growith-fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}} @keyframes growith-skeleton{0%,100%{opacity:0.4}50%{opacity:0.8}}`;
  document.head.appendChild(s);
}

function Spinner({size=14,color="#fff",style={}}) {
  return (
    <span style={{display:"inline-block",width:size,height:size,border:`2px solid ${color}44`,borderTop:`2px solid ${color}`,borderRadius:"50%",animation:"growith-spin 0.7s linear infinite",flexShrink:0,...style}}/>
  );
}

// AsyncButton — muestra spinner automáticamente mientras el onClick async procesa
function AsyncButton({onClick, children, style, disabled, ...props}) {
  const [loading, setLoading] = React.useState(false);
  const handleClick = async (e) => {
    if(loading || disabled) return;
    setLoading(true);
    try { await onClick(e); } catch(err) { console.error(err); }
    finally { setLoading(false); }
  };
  const spinnerColor = style?.color || "#fff";
  return (
    <button {...props} onClick={handleClick} disabled={loading || disabled}
      style={{...style, opacity: loading ? 0.75 : (disabled ? 0.4 : 1), cursor: loading ? "wait" : (disabled ? "not-allowed" : "pointer")}}>
      {loading
        ? <><Spinner size={13} color={spinnerColor}/>{typeof children === "string" ? " " + children : children}</>
        : children}
    </button>
  );
}

function Badge({T, colors, children, small}) {
  return (
    <span style={{
      display:"inline-flex", alignItems:"center", gap:4,
      padding: small ? "2px 6px" : "2px 8px",
      borderRadius:5, fontSize:11, fontWeight:500,
      background:colors.bg, color:colors.text||colors.dot,
      border:`0.5px solid ${colors.dot}33`,
      whiteSpace:"nowrap", letterSpacing:"0.02em",
    }}>
      {children}
    </span>
  );
}

function LensDots({productos}) {
  return (
    <span style={{display:"inline-flex",gap:4,alignItems:"center"}}>
      {getLensColors(productos).map((c,i)=>(
        <span key={i} style={{width:10,height:10,borderRadius:"50%",background:LENTE_DOT[c]||"#888"}} title={c}/>
      ))}
    </span>
  );
}

function Modal({T, open, onClose, title, width, children, zIndex=1000}) {
  if(!open) return null;
  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:zIndex,padding:16}}>
      <div onClick={e=>e.stopPropagation()} style={{background:T.card,borderRadius:16,width:"100%",maxWidth:width||560,maxHeight:"92vh",overflow:"visible",boxShadow:"0 32px 80px rgba(0,0,0,0.35)",border:`0.5px solid ${T.border}`,display:"flex",flexDirection:"column"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"20px 24px 16px",borderBottom:`1px solid ${T.borderL}`,flexShrink:0}}>
          <h2 style={{margin:0,fontSize:17,fontWeight:700,color:T.text}}>{title}</h2>
          <button onClick={onClose} style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,width:32,height:32,fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",color:T.textMd}}>✕</button>
        </div>
        <div style={{padding:"18px 24px 24px",overflow:"auto",flex:1}}>{children}</div>
      </div>
    </div>
  );
}

function Field({T, label, children, required}) {
  return (
    <div style={{marginBottom:14}}>
      <label style={{display:"block",fontSize:12,fontWeight:600,color:T.textMd,marginBottom:6,letterSpacing:0.5,textTransform:"uppercase"}}>
        {label}{required&&<span style={{color:T.red,marginLeft:3}}>*</span>}
      </label>
      {children}
    </div>
  );
}

function Divider({T}) { return <div style={{height:1,background:T.borderL,margin:"14px 0"}}/>; }

function StatCard({T, label, value, color, sub}) {
  return (
    <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:14,padding:"18px 20px",flex:"1 1 120px",minWidth:120,position:"relative",overflow:"hidden"}}>
      {color&&color!==T.textMd&&<div style={{position:"absolute",left:0,top:0,bottom:0,width:3,background:color,borderRadius:"3px 0 0 3px"}}/>}
      <div style={{fontSize:28,fontWeight:700,color,letterSpacing:-0.5,lineHeight:1}}>{value}</div>
      <div style={{fontSize:12,color:T.textSm,marginTop:6,fontWeight:500,textTransform:"uppercase",letterSpacing:"0.04em"}}>{label}</div>
      {sub&&<div style={{fontSize:11,color:T.textSm,marginTop:3}}>{sub}</div>}
    </div>
  );
}

function InputStyle(T) {
  return {
    width:"100%", padding:"10px 14px", borderRadius:8,
    border:`0.5px solid ${T.inputBorder}`, fontSize:13,
    fontFamily:"'Inter',system-ui,sans-serif",
    outline:"none", boxSizing:"border-box",
    background:T.input, color:T.text,
    transition:"border-color 0.12s",
  };
}

function BtnPrimary(T) { return {border:"none",borderRadius:8,padding:"9px 16px",fontSize:13,fontWeight:500,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",transition:"all 0.12s",display:"inline-flex",alignItems:"center",gap:6,background:T.accentSolid,color:"#fff",letterSpacing:"0.01em"}; }
function BtnSecondary(T) { return {border:`0.5px solid ${T.border}`,borderRadius:8,padding:"8px 14px",fontSize:13,fontWeight:400,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",transition:"all 0.12s",display:"inline-flex",alignItems:"center",gap:6,background:T.surface,color:T.text}; }
function BtnDanger(T) { return {border:`0.5px solid ${T.red}44`,borderRadius:8,padding:"8px 14px",fontSize:13,fontWeight:500,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",transition:"all 0.12s",display:"inline-flex",alignItems:"center",gap:6,background:T.redBg,color:T.red}; }
function BtnPurple(T) { return {border:`0.5px solid ${T.purple}44`,borderRadius:8,padding:"8px 14px",fontSize:13,fontWeight:500,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",transition:"all 0.12s",display:"inline-flex",alignItems:"center",gap:6,background:T.purpleBg,color:T.purple}; }

function OrderSearchField({T, orders, onSelect}) {
  const [q,setQ]=useState(""); const inputRef=useRef(null);
  const iS = InputStyle(T);
  const results=useMemo(()=>{ if(!q) return []; const s=q.toLowerCase(); return orders.filter(o=>o.numero.includes(s)||o.comprador.toLowerCase().includes(s)||o.email.toLowerCase().includes(s)).slice(0,10); },[q,orders]);
  useEffect(()=>{ if(inputRef.current) inputRef.current.focus(); },[]);
  return (
    <div>
      <div style={{position:"relative"}}>
        <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",color:T.textSm,fontSize:15}}>🔍</span>
        <input ref={inputRef} style={{...iS,paddingLeft:36}} placeholder="Nro de pedido, nombre o email..." value={q} onChange={e=>setQ(e.target.value)}/>
      </div>
      {q.length>0&&results.length>0&&(
        <div style={{marginTop:6,background:T.bg,border:`0.5px solid ${T.border}`,borderRadius:12,maxHeight:280,overflow:"auto"}}>
          {results.map((o,i)=>(
            <div key={o.numero} onClick={()=>onSelect(o.numero)} style={{padding:"12px 16px",cursor:"pointer",borderTop:i>0?`1px solid ${T.borderL}`:"none",transition:"background 0.1s"}} onMouseEnter={e=>e.currentTarget.style.background=T.surface} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10}}>
                <div style={{display:"flex",gap:10,alignItems:"center"}}>
                  <span style={{fontWeight:700,color:T.accent,fontSize:14}}>#{o.numero}</span>
                  <span style={{color:T.text,fontSize:14,fontWeight:500}}>{o.comprador}</span>
                </div>
                <span style={{fontSize:12,color:T.textSm}}>{fmtDate(o.fecha)}</span>
              </div>
              <div style={{fontSize:12,color:T.textSm,marginTop:3}}>{o.productos.map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'')).join(', ')}</div>
            </div>
          ))}
        </div>
      )}
      {q.length>0&&results.length===0&&<div style={{marginTop:6,padding:14,textAlign:"center",color:T.textSm,fontSize:14,border:`0.5px solid ${T.border}`,borderRadius:12}}>Sin resultados para "{q}"</div>}
    </div>
  );
}


// ═══════════════════════════════════════════
// APP RECLAMOS
// ═══════════════════════════════════════════
function AppReclamos({T, orders, ordersStatus, fetchOrders, fbStatus, user, onHome, totalOrdersCount}) {
  const [reclamos,setReclamos]=useState([]);
  const [plantillas,setPlantillas]=useState([]);
  const [view,setView]=useState("dashboard"); // dashboard | buscar | reclamos | config
  const [dashView,setDashView]=useState("kanban"); // kanban | pipeline
  const [kanbanTipo,setKanbanTipo]=useState("Todos");
  const [search,setSearch]=useState("");
  const [filterEstado,setFilterEstado]=useState("");
  const [filterTipo,setFilterTipo]=useState("");
  const [filterUrgentes,setFilterUrgentes]=useState(false);
  const [activeReclamo,setActiveReclamo]=useState(null);
  const [reclamoForm,setReclamoForm]=useState(null);
  const [deleteConfirm,setDeleteConfirm]=useState(null);
  const [saving,setSaving]=useState(false);
  const [plantillaEdit,setPlantillaEdit]=useState(null);
  const [copiedMsg,setCopiedMsg]=useState(null);
  const [searchGlobal,setSearchGlobal]=useState("");
  const [searchApiResults,setSearchApiResults]=useState([]);
  const [searchApiLoading,setSearchApiLoading]=useState(false);
  const [pedidoDetalle,setPedidoDetalle]=useState(null);

  // Atajos de teclado en reclamos
  useEffect(()=>{
    function handleKey(e) {
      if(e.target.tagName==="INPUT"||e.target.tagName==="TEXTAREA") return;
      if(e.key==="Escape") { setActiveReclamo(null); setSearchGlobal(""); setPedidoDetalle(null); }
    }
    window.addEventListener("keydown", handleKey);
    return ()=>window.removeEventListener("keydown", handleKey);
  },[]);
  const iS=InputStyle(T);
  const fbDot={connecting:T.yellow,ok:T.green,error:T.red}[fbStatus];

  // Default plantillas
  const DEFAULT_PLANTILLAS=[
    {id:"p1",estado:"Nuevo",tipo:"Cambio",nombre:"Confirmar reclamo",mensaje:"Hola [nombre]! Te contactamos desde Soluna Biolight. Recibimos tu solicitud de cambio para el pedido #[pedido]. ¿Podés confirmarnos el problema con tu producto? 🙏"},
    {id:"p2",estado:"Contactado",tipo:"Cambio",nombre:"Instrucciones de devolución",mensaje:"Hola [nombre]! Para procesar tu cambio necesitamos que nos devuelvas el producto. Te compartimos la dirección de envío: [dirección]. Por favor avisanos el tracking cuando lo envíes 📦"},
    {id:"p3",estado:"Esperando producto",tipo:"Cambio",nombre:"Seguimiento envío",mensaje:"Hola [nombre]! ¿Pudiste enviar el producto? Quedamos esperando el código de seguimiento para coordinar tu cambio 😊"},
    {id:"p4",estado:"Producto recibido",tipo:"Cambio",nombre:"Producto recibido",mensaje:"Hola [nombre]! Recibimos el producto. Estamos preparando tu cambio y te avisamos cuando esté en camino 🎉"},
    {id:"p5",estado:"Envío en camino",tipo:"Cambio",nombre:"Cambio enviado",mensaje:"Hola [nombre]! Tu nuevo producto ya está en camino 🚀 Tracking: [tracking]. Podés seguirlo en andreani.com. Cualquier consulta estamos acá!"},
    {id:"p6",estado:"Resuelto",tipo:"Cambio",nombre:"Cierre cambio",mensaje:"Hola [nombre]! Esperamos que hayas recibido tu producto y estés conforme ✨ Gracias por elegirnos! Cualquier consulta no dudes en escribirnos."},
    {id:"p7",estado:"Nuevo",tipo:"Devolución",nombre:"Confirmar devolución",mensaje:"Hola [nombre]! Recibimos tu solicitud de devolución del pedido #[pedido]. ¿Podés contarnos el motivo? Así agilizamos el proceso 🙏"},
    {id:"p8",estado:"Envío en camino",tipo:"Devolución",nombre:"Reembolso procesado",mensaje:"Hola [nombre]! Ya procesamos tu reembolso. En 3-5 días hábiles debería verse reflejado en tu cuenta. Gracias por tu paciencia 💜"},
  ];

  useEffect(()=>{
    const q=query(collection(db,"reclamos"),where("ownerId","==",user?.uid||"__none__"));
    const unsub1=onSnapshot(q,snap=>{
      const data=snap.docs.map(d=>({...d.data(),_docId:d.id}));
      data.sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
      setReclamos(data);
    },()=>{});
    const unsub2=onSnapshot(doc(db,"config","plantillas"),snap=>{
      if(snap.exists()) setPlantillas(snap.data().lista||DEFAULT_PLANTILLAS);
      else setPlantillas(DEFAULT_PLANTILLAS);
    },()=>setPlantillas(DEFAULT_PLANTILLAS));
    return ()=>{unsub1();unsub2();};
  },[]);

  const emptyForm=(orderNum="")=>({
    _docId:null, orderNum, tipo:"Cambio", motivo:"", descripcion:"", estado:"Nuevo",
    resolucion:"", notas:"", trackingCambio:"",
    productosRecibe:[{producto:"",cantidad:1}],
    productosEnvia:[{producto:"",cantidad:1}],
    historial:[],
    // devolución
    estadoRecepcion:"", estadoReembolso:"",
  });

  async function saveReclamo() {
    if(!reclamoForm?.motivo||!reclamoForm?.orderNum) return;
    setSaving(true);
    try {
      const prev=reclamos.find(r=>r._docId===reclamoForm._docId);
      const estadoCambio=prev&&prev.estado!==reclamoForm.estado;
      const histEntry=estadoCambio?[...(reclamoForm.historial||[]),{accion:`Estado → ${reclamoForm.estado}`,fecha:new Date().toISOString()}]:reclamoForm.historial||[];
      const p={
        orderNum:reclamoForm.orderNum, tipo:reclamoForm.tipo, motivo:reclamoForm.motivo,
        descripcion:reclamoForm.descripcion||"", estado:reclamoForm.estado,
        resolucion:reclamoForm.resolucion||"", notas:reclamoForm.notas||"",
        trackingCambio:reclamoForm.trackingCambio||"",
        productosRecibe:reclamoForm.productosRecibe||[],
        productosEnvia:reclamoForm.productosEnvia||[],
        historial:histEntry,
        estadoRecepcion:reclamoForm.estadoRecepcion||"",
        estadoReembolso:reclamoForm.estadoReembolso||"",
      };
      if(reclamoForm._docId) {
        await updateDoc(doc(db,"reclamos",reclamoForm._docId),{...p,updatedAt:serverTimestamp(),...(reclamoForm.estado==="Resuelto"&&prev?.estado!=="Resuelto"?{resolvedAt:serverTimestamp()}:{})});
      } else {
        await addDoc(collection(db,"reclamos"),{...p,ownerId:user.uid,createdAt:serverTimestamp(),updatedAt:serverTimestamp(),resolvedAt:null,historial:[{accion:"Reclamo creado",fecha:new Date().toISOString()}]});
      }
      setReclamoForm(null);
    } catch(e){alert("Error al guardar.");}
    setSaving(false);
  }

  async function addNotaReclamo(docId,texto) {
    if(!texto.trim()) return;
    const r=reclamos.find(r=>r._docId===docId);
    if(!r) return;
    const entry={accion:`Nota: ${texto}`,fecha:new Date().toISOString()};
    await updateDoc(doc(db,"reclamos",docId),{historial:[...(r.historial||[]),entry],updatedAt:serverTimestamp()});
  }

  async function updateEstado(docId,nuevoEstado) {
    const r=reclamos.find(r=>r._docId===docId);
    if(!r) return;
    const entry={accion:`Estado → ${nuevoEstado}`,fecha:new Date().toISOString()};
    await updateDoc(doc(db,"reclamos",docId),{estado:nuevoEstado,historial:[...(r.historial||[]),entry],updatedAt:serverTimestamp(),...(nuevoEstado==="Resuelto"&&r.estado!=="Resuelto"?{resolvedAt:serverTimestamp()}:{})});
  }

  async function deleteReclamo(docId) {
    try{await deleteDoc(doc(db,"reclamos",docId));}catch(e){}
    setDeleteConfirm(null);setActiveReclamo(null);
  }

  async function savePlantillas(lista) {
    try{ await setDoc(doc(db,"config","plantillas"),{lista}); }catch(e){}
    setPlantillas(lista);
  }

  function copyMensaje(plantilla,reclamo) {
    const o=orders.find(o=>o.numero===reclamo.orderNum);
    let msg=plantilla.mensaje
      .replace(/\[nombre\]/g, o?.comprador||reclamo.orderNum)
      .replace(/\[pedido\]/g, reclamo.orderNum)
      .replace(/\[tracking\]/g, reclamo.trackingCambio||"—")
      .replace(/\[dirección\]/g, "Av. Ejemplo 1234, Buenos Aires");
    navigator.clipboard.writeText(msg);
    setCopiedMsg(plantilla.id);
    setTimeout(()=>setCopiedMsg(null),2000);
  }

  // Stats
  const hoy=new Date().toISOString().split('T')[0];
  const hace3=new Date(Date.now()-3*86400000).toISOString().split('T')[0];
  const _baseCount=totalOrdersCount||orders.length;
  const pctCambios=_baseCount>0?((reclamos.filter(r=>r.tipo==="Cambio").length/_baseCount)*100).toFixed(1):null;
  const pctDevoluciones=_baseCount>0?((reclamos.filter(r=>r.tipo==="Devolución").length/_baseCount)*100).toFixed(1):null;
  const stats={
    total:reclamos.length,
    pendientes:reclamos.filter(r=>r.estado==="Nuevo").length,
    resueltos:reclamos.filter(r=>r.estado==="Resuelto").length,
    rechazados:reclamos.filter(r=>r.estado==="Rechazado").length,
    cambios:reclamos.filter(r=>r.tipo==="Cambio").length,
    devoluciones:reclamos.filter(r=>r.tipo==="Devolución").length,
    urgentes:reclamos.filter(r=>!["Resuelto","Rechazado"].includes(r.estado)&&r.createdAt?.seconds&&new Date(r.createdAt.seconds*1000).toISOString().split('T')[0]<=hace3).length,
  };

  // Filtered reclamos
  const filteredReclamos=useMemo(()=>reclamos.filter(r=>{
    if(filterEstado&&r.estado!==filterEstado) return false;
    if(filterTipo&&r.tipo!==filterTipo) return false;
    if(filterUrgentes){
      if(["Resuelto","Rechazado"].includes(r.estado)) return false;
      if(!r.createdAt?.seconds||new Date(r.createdAt.seconds*1000).toISOString().split('T')[0]>hace3) return false;
    }
    if(search){
      const s=search.toLowerCase().trim();
      if(r.orderNum===s) return true; // exacto primero
      if(r.orderNum.includes(s)) return true;
      if((r.motivo||"").toLowerCase().includes(s)) return true;
      if((r.tipo||"").toLowerCase().includes(s)) return true;
      const o=orders.find(o=>o.numero===r.orderNum);
      if(o&&(o.comprador.toLowerCase().includes(s)||o.email.toLowerCase().includes(s)||o.telefono.includes(s))) return true;
      return false;
    }
    return true;
  }),[reclamos,search,filterEstado,filterTipo,filterUrgentes,hace3]);

  // Global search — usa API de TN directamente, no depende de orders local
  const globalResults=useMemo(()=>{
    if(!searchGlobal||searchGlobal.length<1) return {pedidos:[],reclamos:[]};
    const s=searchGlobal.toLowerCase().trim();
    const pedidos=searchApiResults.slice(0,8);
    // Reclamos: match por número exacto, parcial, nombre o motivo
    const recls=reclamos.filter(r=>{
      if(r.orderNum===s) return true; // exacto primero
      if(r.orderNum.includes(s)) return true;
      if((r.motivo||"").toLowerCase().includes(s)) return true;
      if((r.tipo||"").toLowerCase().includes(s)) return true;
      const o=searchApiResults.find(o=>o.numero===r.orderNum);
      return o&&(o.comprador.toLowerCase().includes(s)||o.email.toLowerCase().includes(s));
    }).slice(0,8);
    return {pedidos,recls};
  },[searchGlobal,searchApiResults,reclamos]);

  // Buscar en TN API cuando cambia searchGlobal
  useEffect(()=>{
    if(!searchGlobal||searchGlobal.length<2){ setSearchApiResults([]); return; }
    const timer=setTimeout(async()=>{
      setSearchApiLoading(true);
      try{
        const r=await fetch(`/api/orders?uid=${user?.uid}&q=${encodeURIComponent(searchGlobal.trim())}`);
        const data=await r.json();
        if(Array.isArray(data)) setSearchApiResults(buildOrdersFromAPI(data));
      }catch(e){}
      setSearchApiLoading(false);
    },400); // debounce 400ms
    return ()=>clearTimeout(timer);
  },[searchGlobal,user?.uid]);

  const activeR=reclamos.find(r=>r._docId===activeReclamo);
  const [activeOrderCache,setActiveOrderCache]=useState({});

  // Andreani functions (using shared module-level cache)
  async function loadAndreaniLocations() {
    if(_andreaniLocsCache.current) return _andreaniLocsCache.current;
    if(!window.JSZip){await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';s.onload=resolve;s.onerror=reject;document.head.appendChild(s);});}
    const res=await fetch('/andreani_template.xlsx?v='+Date.now());
    if(!res.ok) throw new Error("No se pudo cargar el template");
    const buf=await res.arrayBuffer();
    const zip=await window.JSZip.loadAsync(buf);
    const ssXml=await zip.file('xl/sharedStrings.xml').async('string');
    const strings=[];const rx=/<t[^>]*>([\s\S]*?)<\/t>/g;let m;while((m=rx.exec(ssXml))!==null)strings.push(m[1]);
    const locPattern=/^[A-ZÁÉÍÓÚÑÜ\s]+ \/ [A-ZÁÉÍÓÚÑÜ\s0-9]+ \/ \d+$/;
    const list=strings.filter(s=>locPattern.test(s.trim()));
    const cpIndex={};list.forEach(loc=>{const parts=loc.split(' / ');if(parts.length===3){const cp=parts[2].trim();if(!cpIndex[cp])cpIndex[cp]=[];cpIndex[cp].push(loc);}});
    const provIndex={};list.forEach(loc=>{const prov=loc.split(' / ')[0].trim();if(!provIndex[prov])provIndex[prov]=[];provIndex[prov].push(loc);});
    const sheet4Xml=await zip.file('xl/worksheets/sheet4.xml').async('string');
    const aCells=[...sheet4Xml.matchAll(/<c r="A(\d+)"[^>]*t="s"[^>]*><v>(\d+)<\/v>/g)];
    const sucursales=aCells.map(([,row,idx])=>strings[parseInt(idx)]||"").filter(s=>s.trim()&&s!=="Sucursal");
    _andreaniLocsCache.current={list,cpIndex,provIndex,sucursales};
    return _andreaniLocsCache.current;
  }

  async function generarEtiquetaAndreani(o) {
    if(!o) return alert("No se encontró el pedido");
    try {
      const locs=await loadAndreaniLocations();
      // Use the same xlsx generation from AppEnvios - simplified version
      if(!window.JSZip){await new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';s.onload=res;s.onerror=rej;document.head.appendChild(s);});}
      const tRes=await fetch('/andreani_template.xlsx?v='+Date.now());
      if(!tRes.ok) throw new Error("No se pudo cargar el template");
      const tBuf=await tRes.arrayBuffer();
      const zip=await window.JSZip.loadAsync(tBuf);
      const ssXml=await zip.file('xl/sharedStrings.xml').async('string');
      const existSS=[];const ssRx=/<t[^>]*>([\s\S]*?)<\/t>/g;let mx;while((mx=ssRx.exec(ssXml))!==null)existSS.push(mx[1]);
      const ssMap=new Map();existSS.forEach((s,i)=>ssMap.set(s,i));const newSS=[...existSS];
      function idx(s){const k=String(s==null?"":s);if(ssMap.has(k))return ssMap.get(k);const i=newSS.length;newSS.push(k);ssMap.set(k,i);return i;}
      function sC(ref,val){return '<c r="'+ref+'" t="s"><v>'+idx(val)+'</v></c>';}
      function nC(ref,val){return (val===''||val===null||val===undefined)?sC(ref,''):'<c r="'+ref+'"><v>'+val+'</v></c>';}
      function cl(s){return String(s||"").replace(/[-\/\|#*]+/g,' ').replace(/\s{2,}/g,' ').trim();}
      const partes=o.comprador.trim().split(' ');
      const nombre=cl(partes[0]||"");const apellido=cl(partes.slice(1).join(' ')||"");
      const tel=(o.telefono||"").replace(/[^0-9]/g,'');
      const clean=tel.startsWith('54')?tel.slice(2):tel.startsWith('0')?tel.slice(1):tel;
      let telCod='',telNum='';
      if(clean.length>=10){telCod=clean.slice(0,clean.length-8);telNum=clean.slice(clean.length-8);}
      else if(clean.length>0){telNum=clean;}
      // Localidad
      const cpIndex=locs.cpIndex;const provIndex=locs.provIndex;
      const cpStr=String(o.cp||"").trim();
      const provU=(o.provincia||"").toUpperCase().replace(/^CIUDAD AUTONOMA.*/,"CAPITAL FEDERAL");
      const locU=(o.localidad||o.ciudad||"").toUpperCase();
      let ubicacion="";
      const byCp=cpIndex[cpStr]||[];
      if(byCp.length>=1){const byProv=byCp.find(l=>l.startsWith(provU));ubicacion=byProv||byCp[0];}
      if(!ubicacion){const provList=provIndex[provU]||[];if(provList.length>0)ubicacion=provList[0];}
      if(!ubicacion)ubicacion=locs.list.find(l=>l.startsWith('BUENOS AIRES'))||locs.list[0]||"";
      const dirNum=String(o.dirNumero||"");
      const direccion=cl(o.direccion||"");
      const rn=3;
      const cells=[sC('A'+rn,""),nC('B'+rn,200),nC('C'+rn,5),nC('D'+rn,5),nC('E'+rn,5),nC('F'+rn,6000),sC('G'+rn,'#'+o.numero),sC('H'+rn,nombre),sC('I'+rn,apellido),(o.dni&&!isNaN(o.dni))?nC('J'+rn,parseFloat(o.dni)):sC('J'+rn,o.dni||""),sC('K'+rn,cl(o.email||"")),telCod?nC('L'+rn,parseFloat(telCod)):sC('L'+rn,""),telNum?nC('M'+rn,parseFloat(telNum)):sC('M'+rn,""),sC('N'+rn,direccion),(dirNum&&!isNaN(dirNum)&&dirNum!=='')?nC('O'+rn,parseFloat(dirNum)):nC('O'+rn,0),sC('P'+rn,cl(o.piso||"")),sC('Q'+rn,""),sC('R'+rn,ubicacion),sC('S'+rn,"")].join('');
      const rowXml='<row r="3" spans="1:19" x14ac:dyDescent="0.25">'+cells+'</row>';
      const sheet1=await zip.file('xl/worksheets/sheet1.xml').async('string');
      const newSheet1=sheet1.replace(/<dimension ref="[^"]+"\/>/,'<dimension ref="A1:S3"/>').replace('</sheetData>',rowXml+'</sheetData>').replace(/<dataValidations[\s\S]*?<\/dataValidations>/g,'');
      zip.file('xl/worksheets/sheet1.xml',newSheet1);
      const newSsItems=newSS.map(s=>{const esc=s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');const sp=(s!==s.trim()||s.indexOf(String.fromCharCode(10))>=0)?' xml:space="preserve"':'';return '<si><t'+sp+'>'+esc+'</t></si>';}).join('');
      zip.file('xl/sharedStrings.xml','<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="'+newSS.length+'" uniqueCount="'+newSS.length+'">'+newSsItems+'</sst>');
      const blob=await zip.generateAsync({type:'blob',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',compression:'DEFLATE'});
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`EnvioMasivoExcelPaquetes-${o.numero}.xlsx`;a.click();
    } catch(e){ alert("Error al generar etiqueta: "+e.message); }
  }
  const activeOrder=activeR?(orders.find(o=>o.numero===activeR.orderNum)||activeOrderCache[activeR.orderNum]||null):null;

  // Cuando cambia activeR y no tenemos el pedido, buscarlo en la API
  useEffect(()=>{
    if(!activeR) return;
    if(orders.find(o=>o.numero===activeR.orderNum)||activeOrderCache[activeR.orderNum]) return;
    // Buscar el pedido en TN
    fetch(`/api/orders?uid=${user?.uid}&q=${activeR.orderNum}`)
      .then(r=>r.json())
      .then(data=>{
        if(Array.isArray(data)){
          const built=buildOrdersFromAPI(data);
          const found=built.find(o=>o.numero===activeR.orderNum);
          if(found) setActiveOrderCache(prev=>({...prev,[activeR.orderNum]:found}));
        }
      })
      .catch(()=>{});
  },[activeR?._docId]);

  // ── Render ──
  return (
    <div style={{fontFamily:"'Inter',system-ui,sans-serif",background:T.bg,minHeight:"100vh",color:T.text}}>

      {/* Topbar */}
      <div style={{borderBottom:`1px solid ${T.border}`,background:T.surface,padding:"0 16px",position:"sticky",top:0,zIndex:100}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",height:60,gap:16,maxWidth:1400,margin:"0 auto"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <button onClick={onHome} style={{...BtnSecondary(T),padding:"6px 12px",fontSize:13}}>← Inicio</button>
            <span style={{color:T.textSm,fontSize:15}}>/</span>
            <span style={{fontWeight:700,fontSize:15,color:T.text}}>📋 Reclamos</span>
            <div style={{display:"flex",alignItems:"center",gap:4,background:T.card,border:`1px solid ${T.border}`,borderRadius:20,padding:"3px 10px"}}>
              <span style={{width:6,height:6,borderRadius:"50%",background:fbDot,boxShadow:`0 0 5px ${fbDot}`}}/>
              <span style={{fontSize:11,color:T.textSm}}>{fbStatus==="ok"?"en vivo":"conectando"}</span>
            </div>
          </div>
          <div style={{display:"flex",gap:6}}>
            {["dashboard","buscar","reclamos","config"].map(v=>{
              const labels={dashboard:"📊 Dashboard",buscar:"🔍 Buscar",reclamos:"📋 Reclamos",config:"⚙️ Plantillas"};
              const isCurrent=view===v;
              return <button key={v} onClick={()=>{setView(v);setActiveReclamo(null);}} style={{padding:"7px 14px",fontSize:12,fontWeight:isCurrent?600:400,border:"none",borderRadius:7,background:isCurrent?T.accentSolid:"transparent",color:isCurrent?"#fff":T.textMd,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",transition:"all 0.12s",display:"inline-flex",alignItems:"center",gap:5}}>{labels[v]}{v==="reclamos"&&stats.urgentes>0&&<span style={{background:T.red,color:"#fff",fontSize:10,fontWeight:700,borderRadius:4,padding:"1px 5px",marginLeft:2}}>{stats.urgentes}</span>}</button>;
            })}
            <button onClick={()=>setReclamoForm(emptyForm())} style={{...BtnDanger(T),fontSize:12,padding:"6px 12px"}}>+ Nuevo</button>
            <button onClick={fetchOrders} disabled={ordersStatus==="loading"} style={{...BtnSecondary(T),fontSize:12,padding:"6px 12px",opacity:ordersStatus==="loading"?0.5:1}}>{ordersStatus==="loading"?<Spinner size={12} color={T.textMd}/>:"⟳"}</button>
          </div>
        </div>
      </div>

      <div style={{maxWidth:1400,margin:"0 auto",padding:"0 16px"}}>

        {/* ── DASHBOARD ── */}
        {view==="dashboard"&&(
          <div style={{padding:"24px 0 48px"}}>

            {/* Buscador prominente */}
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"20px 22px",marginBottom:24}}>
              <div style={{fontSize:13,fontWeight:600,color:T.textMd,marginBottom:10}}>🔍 Buscar cliente o pedido</div>
              <div style={{position:"relative"}}>
                <span style={{position:"absolute",left:14,top:"50%",transform:"translateY(-50%)",fontSize:18,color:T.textSm}}>🔍</span>
                <input
                  autoFocus
                  style={{...InputStyle(T),paddingLeft:44,fontSize:16,padding:"14px 14px 14px 44px",borderRadius:10,borderColor:T.inputBorder}}
                  placeholder="Nombre, email, teléfono o número de pedido..."
                  value={searchGlobal}
                  onChange={e=>setSearchGlobal(e.target.value)}
                  onFocus={e=>e.target.style.borderColor=T.accent}
                  onBlur={e=>e.target.style.borderColor=T.inputBorder}
                />
              </div>
              {searchGlobal.length>=1&&(
                <div style={{marginTop:12}}>
                  {globalResults.pedidos?.length>0&&(
                    <>
                      <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.6,marginBottom:8}}>Pedidos ({globalResults.pedidos.length})</div>
                      {globalResults.pedidos.map(o=>{
                        const hasR=reclamos.filter(r=>r.orderNum===o.numero);
                        const isOpen=pedidoDetalle===o.numero;
                        return (
                          <div key={o.numero} style={{background:isOpen?T.surface:T.bg,border:`1.5px solid ${isOpen?T.accent:hasR.length>0?T.red+"44":T.border}`,borderRadius:10,marginBottom:8,overflow:"hidden",transition:"all 0.15s",cursor:"pointer"}}
                            onClick={()=>setPedidoDetalle(isOpen?null:o.numero)}>
                            {/* Fila compacta */}
                            <div style={{padding:"12px 16px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                              <div>
                                <div style={{fontSize:14,fontWeight:700,color:T.text}}>{o.comprador} <span style={{color:T.accent,fontWeight:500}}>#{o.numero}</span></div>
                                <div style={{fontSize:12,color:T.textSm,marginTop:2}}>{o.productos.map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'')).join(' · ')}</div>
                              </div>
                              <div style={{display:"flex",gap:6,alignItems:"center",flexShrink:0}}>
                                <span style={{fontSize:13,fontWeight:700,color:T.text}}>{fmtMoney(o.total)}</span>
                                <span style={{fontSize:12,color:T.textSm}}>{isOpen?"▲":"▼"}</span>
                              </div>
                            </div>
                            {/* Detalle expandido */}
                            {isOpen&&(
                              <div style={{padding:"0 16px 16px",borderTop:`0.5px solid ${T.borderL}`}} onClick={e=>e.stopPropagation()}>
                                {/* Info cliente */}
                                <div style={{display:"flex",gap:16,flexWrap:"wrap",paddingTop:12,marginBottom:12}}>
                                  <div><div style={{fontSize:10,textTransform:"uppercase",color:T.textSm,fontWeight:600}}>Email</div><div style={{fontSize:13,color:T.text}}>{o.email||"—"}</div></div>
                                  <div><div style={{fontSize:10,textTransform:"uppercase",color:T.textSm,fontWeight:600}}>Teléfono</div><div style={{fontSize:13,color:T.text}}>{o.telefono||"—"}</div></div>
                                  <div><div style={{fontSize:10,textTransform:"uppercase",color:T.textSm,fontWeight:600}}>Pago</div><div style={{fontSize:13,color:T.text}}>{o.medioPago||"—"}</div></div>
                                  <div><div style={{fontSize:10,textTransform:"uppercase",color:T.textSm,fontWeight:600}}>Envío</div><div style={{fontSize:13,color:T.text}}>{o.esSucursal?"🏪 Sucursal":"🏠 Domicilio"} · {o.medioEnvio||"—"}</div></div>
                                </div>
                                {/* Dirección */}
                                <div style={{background:T.bg,borderRadius:8,padding:"10px 12px",marginBottom:12,fontSize:12,color:T.text}}>
                                  <div style={{fontWeight:600,color:T.textSm,fontSize:10,textTransform:"uppercase",marginBottom:4}}>Dirección de envío</div>
                                  {o.esSucursal&&o.pickupDetails?(
                                    <div>
                                      <div style={{fontWeight:600}}>{o.pickupDetails.name}</div>
                                      <div>{o.pickupDetails.address?.address} {o.pickupDetails.address?.number}</div>
                                      <div style={{color:T.textSm}}>{o.pickupDetails.address?.locality}, {o.pickupDetails.address?.province}</div>
                                    </div>
                                  ):(
                                    <div>{o.direccion} {o.dirNumero}{o.piso?`, ${o.piso}`:""}, {o.localidad||o.ciudad}, {o.provincia} CP {o.cp}</div>
                                  )}
                                </div>
                                {/* Productos */}
                                <div style={{marginBottom:12}}>
                                  <div style={{fontSize:10,textTransform:"uppercase",color:T.textSm,fontWeight:600,marginBottom:6}}>Productos</div>
                                  {o.productos.map((p,i)=>(
                                    <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:13,padding:"4px 0",borderBottom:i<o.productos.length-1?`1px solid ${T.borderL}`:"none"}}>
                                      <span>{p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'')}</span>
                                      <span style={{color:T.textSm,flexShrink:0,marginLeft:8}}>{p.cantidad>1?`${p.cantidad}x `:""}${fmtMoney(p.precio)}</span>
                                    </div>
                                  ))}
                                  <div style={{display:"flex",justifyContent:"flex-end",marginTop:6,fontWeight:700,fontSize:14,color:T.text}}>Total: {fmtMoney(o.total)}</div>
                                </div>
                                {/* Reclamos existentes */}
                                {hasR.length>0&&(
                                  <div style={{marginBottom:12}}>
                                    {hasR.map(r=>(
                                      <span key={r._docId} onClick={()=>{setActiveReclamo(r._docId);setView("reclamos");setSearchGlobal("");setPedidoDetalle(null);}} style={{display:"inline-flex",alignItems:"center",gap:5,background:T.redBg,border:`1px solid ${T.red}33`,borderRadius:6,padding:"4px 12px",marginRight:6,cursor:"pointer",fontSize:12,color:T.red,fontWeight:500}}>
                                        ⚠ {r.tipo} · {r.estado}
                                      </span>
                                    ))}
                                  </div>
                                )}
                                {/* Acciones */}
                                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                                  <button onClick={()=>{setReclamoForm(emptyForm(o.numero));setSearchGlobal("");setPedidoDetalle(null);}} style={{...BtnDanger(T),fontSize:12,padding:"8px 14px"}}>+ Crear Reclamo</button>
                                  {onGenerarCanje&&<button onClick={()=>{const prods=o.productos?.map(p=>p.nombre?.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'').trim()||p.sku).filter(Boolean)||[];onGenerarCanje({influencer:o.comprador,email:o.email||"",telefono:o.telefono||"",productos:prods,producto:prods[0]||"",notas:`Pedido #${o.numero} · ${new Date().toLocaleDateString('es-AR')}`,estado:"Pendiente envío",red:"Instagram",usuario:"",seguidores:"",foto:"",nicho:"",tracking:"",linkContenido:"",fechaEnvio:"",fechaPublicacion:"",contenido:[],alcance:"",reproducciones:"",likes:"",guardados:"",historial:[],recordatorio:""});setPedidoDetalle(null);setSearchGlobal("");}} style={{...BtnSecondary(T),fontSize:12,padding:"8px 14px",color:T.purple}}>🤝 Generar Canje</button>}
                                  <AsyncButton onClick={()=>generarEtiquetaAndreani(o)} style={{...BtnSecondary(T),fontSize:12,padding:"8px 14px",color:T.blue}}>📦 Etiqueta Andreani</AsyncButton>
                                  {o.telefono&&<a href={`https://wa.me/${o.telefono.replace(/\D/g,'')}`} target="_blank" rel="noopener noreferrer" style={{...BtnSecondary(T),fontSize:12,padding:"8px 14px",textDecoration:"none",color:T.green}}>💬 WhatsApp</a>}
                                  {o.linkOrden&&<a href={o.linkOrden} target="_blank" rel="noopener noreferrer" style={{...BtnSecondary(T),fontSize:12,padding:"8px 14px",textDecoration:"none",color:T.purple}}>🔗 Ver en TN</a>}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </>
                  )}
                  {globalResults.recls?.length>0&&(
                    <>
                      <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.6,marginBottom:8,marginTop:12}}>Reclamos activos ({globalResults.recls.length})</div>
                      {globalResults.recls.map(r=>{
                        const o=orders.find(o=>o.numero===r.orderNum);
                        const sc=getEstadoRC(T,r.estado);
                        return (
                          <div key={r._docId} onClick={()=>{setActiveReclamo(r._docId);setView("reclamos");setSearchGlobal("");}} style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,padding:"10px 14px",marginBottom:6,cursor:"pointer",transition:"background 0.1s",display:"flex",justifyContent:"space-between",alignItems:"center"}} onMouseEnter={e=>e.currentTarget.style.background=T.surface} onMouseLeave={e=>e.currentTarget.style.background=T.bg}>
                            <div>
                              <div style={{fontSize:13,fontWeight:600,color:T.text}}>#{r.orderNum} · {o?.comprador||"—"}</div>
                              <div style={{fontSize:12,color:T.textSm,marginTop:2}}>{r.tipo} · {r.motivo}</div>
                            </div>
                            <Badge T={T} colors={sc}>{r.estado}</Badge>
                          </div>
                        );
                      })}
                    </>
                  )}
                  {searchApiLoading&&<div style={{textAlign:"center",padding:"16px",color:T.textSm,fontSize:13,display:"flex",alignItems:"center",justifyContent:"center",gap:8}}><Spinner size={13} color={T.textSm}/> Buscando...</div>}
                  {!searchApiLoading&&!globalResults.pedidos?.length&&!globalResults.recls?.length&&(
                    <div style={{textAlign:"center",padding:"20px",color:T.textSm,fontSize:14}}>Sin resultados para "{searchGlobal}"</div>
                  )}
                </div>
              )}
            </div>

            {/* Stats row */}
            <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:28}}>
              <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"18px 20px",flex:"1 1 120px",minWidth:120}}>
                <div style={{fontSize:11,color:T.textSm,marginBottom:6}}>📋 Reclamos totales</div>
                <div style={{fontSize:32,fontWeight:800,color:T.text,letterSpacing:-1}}>{stats.total}</div>
              </div>
              <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"18px 20px",flex:"1 1 120px",minWidth:120}}>
                <div style={{fontSize:11,color:T.textSm,marginBottom:6}}>🆕 Pendientes</div>
                <div style={{fontSize:32,fontWeight:800,color:stats.pendientes>0?T.blue:T.textMd,letterSpacing:-1}}>{stats.pendientes}</div>
              </div>
              <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"18px 20px",flex:"1 1 120px",minWidth:120}}>
                <div style={{fontSize:11,color:T.textSm,marginBottom:6}}>✅ Resueltos</div>
                <div style={{fontSize:32,fontWeight:800,color:T.green,letterSpacing:-1}}>{stats.resueltos}</div>
              </div>
              <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"18px 20px",flex:"1 1 120px",minWidth:120}}>
                <div style={{fontSize:11,color:T.textSm,marginBottom:6}}>🔄 Cambios</div>
                <div style={{fontSize:32,fontWeight:800,color:T.purple,letterSpacing:-1}}>{stats.cambios}</div>
                {pctCambios&&<div style={{fontSize:12,color:T.textSm,marginTop:4,fontWeight:500}}>{pctCambios}% de pedidos</div>}
              </div>
              <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"18px 20px",flex:"1 1 120px",minWidth:120}}>
                <div style={{fontSize:11,color:T.textSm,marginBottom:6}}>↩️ Devoluciones</div>
                <div style={{fontSize:32,fontWeight:800,color:T.orange,letterSpacing:-1}}>{stats.devoluciones}</div>
                {pctDevoluciones&&<div style={{fontSize:12,color:T.textSm,marginTop:4,fontWeight:500}}>{pctDevoluciones}% de pedidos</div>}
              </div>
            </div>

            {/* Pipeline por estado */}
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,flexWrap:"wrap",gap:8}}>
              <div style={{fontSize:13,fontWeight:600,color:T.textMd,textTransform:"uppercase",letterSpacing:0.6}}>Pipeline de reclamos</div>
              <div style={{display:"flex",gap:4,background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,padding:3}}>
                {[{id:"kanban",label:"⬜ Kanban"},{id:"pipeline",label:"📊 Pipeline"}].map(v=>(
                  <button key={v.id} onClick={()=>setDashView(v.id)} style={{padding:"5px 14px",fontSize:12,fontWeight:dashView===v.id?700:400,borderRadius:6,border:"none",background:dashView===v.id?T.accentSolid:"transparent",color:dashView===v.id?"#fff":T.textMd,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",transition:"all 0.15s"}}>{v.label}</button>
                ))}
              </div>
            </div>

            {/* Vista Pipeline */}
            {dashView==="pipeline"&&(
            <div style={{display:"flex",gap:10,overflowX:"auto",paddingBottom:8,marginBottom:28}}>
              {ESTADOS_R.map(estado=>{
                const sc=getEstadoRC(T,estado);
                const count=reclamos.filter(r=>r.estado===estado).length;
                return (
                  <div key={estado} onClick={()=>{setView("reclamos");setFilterEstado(estado);}} style={{background:T.card,border:`1px solid ${sc.dot}44`,borderRadius:12,padding:"16px 18px",flex:"0 0 150px",cursor:"pointer",transition:"all 0.15s"}} onMouseEnter={e=>e.currentTarget.style.borderColor=sc.dot} onMouseLeave={e=>e.currentTarget.style.borderColor=sc.dot+"44"}>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
                      <span style={{width:8,height:8,borderRadius:"50%",background:sc.dot}}/>
                      <span style={{fontSize:11,fontWeight:600,color:sc.text}}>{estado}</span>
                    </div>
                    <div style={{fontSize:28,fontWeight:800,color:T.text,letterSpacing:-1}}>{count}</div>
                  </div>
                );
              })}
            </div>
            )}

            {/* Vista Kanban */}
            {dashView==="kanban"&&(
            <div>
              {/* Filtro tipo */}
              <div style={{display:"flex",gap:6,marginBottom:14}}>
                {["Todos","Cambio","Devolución","Consulta"].map(t=>(
                  <button key={t} onClick={()=>setKanbanTipo(t)} style={{padding:"5px 14px",fontSize:12,fontWeight:kanbanTipo===t?700:400,borderRadius:20,border:`1px solid ${kanbanTipo===t?T.accentSolid:T.border}`,background:kanbanTipo===t?T.accentSolid:"transparent",color:kanbanTipo===t?"#fff":T.textMd,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",transition:"all 0.15s"}}>{t}</button>
                ))}
              </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:12,marginBottom:28}}>
              {ESTADOS_R.map(estado=>{
                const sc=getEstadoRC(T,estado);
                const items=reclamos.filter(r=>r.estado===estado&&(kanbanTipo==="Todos"||r.tipo===kanbanTipo));
                return (
                  <div key={estado} style={{background:T.card,border:`1px solid ${sc.dot}44`,borderRadius:12,overflow:"hidden",minHeight:80}}>
                    <div style={{padding:"10px 14px",background:sc.dot+"18",borderBottom:`1px solid ${sc.dot}33`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <span style={{width:8,height:8,borderRadius:"50%",background:sc.dot,flexShrink:0}}/>
                        <span style={{fontSize:12,fontWeight:700,color:sc.text}}>{estado}</span>
                      </div>
                      <span style={{fontSize:11,fontWeight:800,color:sc.dot,background:sc.dot+"22",borderRadius:20,padding:"1px 8px"}}>{items.length}</span>
                    </div>
                    <div style={{padding:8,display:"flex",flexDirection:"column",gap:6,maxHeight:380,overflowY:"auto"}}>
                      {items.length===0&&(
                        <div style={{textAlign:"center",padding:"16px 8px",fontSize:12,color:T.textSm}}>Sin reclamos</div>
                      )}
                      {items.map(r=>{
                        const o=orders.find(o=>o.numero===r.orderNum);
                        const dias=r.createdAt?.seconds?Math.floor((Date.now()-r.createdAt.seconds*1000)/86400000):null;
                        const urgente=!["Resuelto","Rechazado"].includes(r.estado)&&dias>=3;
                        const tieneNota=!!r.notasInternas;
                        return (
                          <div key={r._docId} onClick={()=>{setActiveReclamo(r._docId);setView("reclamos");}}
                            style={{background:T.bg,border:`1px solid ${urgente?T.red+"44":T.borderL}`,borderRadius:8,padding:"10px 12px",cursor:"pointer",transition:"all 0.12s",borderLeft:urgente?`3px solid ${T.red}`:"3px solid transparent"}}
                            onMouseEnter={e=>e.currentTarget.style.borderColor=sc.dot}
                            onMouseLeave={e=>e.currentTarget.style.borderColor=urgente?T.red+"44":T.borderL}>
                            <div style={{fontSize:12,fontWeight:700,color:T.text,marginBottom:3,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{o?.comprador||`Pedido #${r.orderNum}`}</div>
                            <div style={{fontSize:11,color:T.accent,marginBottom:4}}>#{r.orderNum}</div>
                            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:4,flexWrap:"wrap"}}>
                              <span style={{fontSize:10,background:T.surface,border:`1px solid ${T.borderL}`,borderRadius:4,padding:"1px 6px",color:T.textMd}}>{r.tipo}</span>
                              <div style={{display:"flex",gap:4,alignItems:"center"}}>
                                {tieneNota&&<span style={{fontSize:10,color:T.yellow}} title="Tiene notas internas">🔒</span>}
                                {dias!==null&&<span style={{fontSize:10,color:urgente?T.red:T.textSm,fontWeight:urgente?700:400}}>{dias}d</span>}
                              </div>
                            </div>
                            {r.motivo&&<div style={{fontSize:10,color:T.textSm,marginTop:4,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{r.motivo}</div>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            </div>
            )}

            {/* Urgentes */}
            {stats.urgentes>0&&(
              <>
                <div style={{fontSize:13,fontWeight:600,color:T.red,textTransform:"uppercase",letterSpacing:0.6,marginBottom:12}}>⚠ Reclamos urgentes (más de 3 días sin resolver)</div>
                <div style={{display:"flex",flexDirection:"column",gap:8}}>
                  {reclamos.filter(r=>!["Resuelto","Rechazado"].includes(r.estado)&&r.createdAt?.seconds&&new Date(r.createdAt.seconds*1000).toISOString().split('T')[0]<=hace3).map(r=>{
                    const o=orders.find(o=>o.numero===r.orderNum);
                    const dias=r.createdAt?.seconds?Math.floor((Date.now()-r.createdAt.seconds*1000)/86400000):0;
                    const sc=getEstadoRC(T,r.estado);
                    return (
                      <div key={r._docId} onClick={()=>{setActiveReclamo(r._docId);setView("reclamos");}} style={{background:T.card,border:`1.5px solid ${T.red}44`,borderLeft:`4px solid ${T.red}`,borderRadius:10,padding:"14px 18px",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",transition:"background 0.1s"}} onMouseEnter={e=>e.currentTarget.style.background=T.surface} onMouseLeave={e=>e.currentTarget.style.background=T.card}>
                        <div style={{display:"flex",gap:12,alignItems:"center"}}>
                          <div style={{background:T.redBg,border:`1px solid ${T.red}44`,borderRadius:8,padding:"6px 10px",fontSize:13,fontWeight:700,color:T.red}}>{dias}d</div>
                          <div>
                            <div style={{fontSize:14,fontWeight:700,color:T.text}}>{o?.comprador||`Pedido #${r.orderNum}`}</div>
                            <div style={{fontSize:12,color:T.textSm,marginTop:2}}>#{r.orderNum} · {r.motivo} · {r.tipo}</div>
                          </div>
                        </div>
                        <Badge T={T} colors={sc}>{r.estado}</Badge>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── BUSCAR ── */}
        {view==="buscar"&&(
          <div style={{padding:"28px 0 48px",maxWidth:700}}>
            <div style={{fontSize:22,fontWeight:800,color:T.text,marginBottom:6,letterSpacing:-0.5}}>Buscar cliente o pedido</div>
            <div style={{fontSize:14,color:T.textMd,marginBottom:20}}>Buscá por nombre, email, teléfono o número de pedido.</div>
            <div style={{position:"relative",marginBottom:20}}>
              <span style={{position:"absolute",left:14,top:"50%",transform:"translateY(-50%)",fontSize:16,color:T.textSm}}>🔍</span>
              <input autoFocus style={{...iS,paddingLeft:42,fontSize:16,padding:"14px 14px 14px 42px"}} placeholder="Ej: Guillermo, +5411..., #1369" value={searchGlobal} onChange={e=>setSearchGlobal(e.target.value)}/>
            </div>
            {searchGlobal.length>=1&&(
              <div>
                {globalResults.pedidos?.length>0&&(
                  <>
                    <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.6,marginBottom:10}}>Pedidos ({globalResults.pedidos.length})</div>
                    {globalResults.pedidos.map(o=>{
                      const hasR=reclamos.filter(r=>r.orderNum===o.numero);
                      const isOpen=pedidoDetalle===o.numero;
                      return (
                        <div key={o.numero} style={{background:isOpen?T.surface:T.card,border:`1.5px solid ${isOpen?T.accent:hasR.length>0?T.red+"44":T.border}`,borderRadius:12,marginBottom:10,overflow:"hidden",transition:"all 0.15s",cursor:"pointer"}}
                          onClick={()=>setPedidoDetalle(isOpen?null:o.numero)}>
                          <div style={{padding:"14px 18px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                            <div>
                              <div style={{fontSize:15,fontWeight:800,color:T.text}}>{o.comprador} <span style={{color:T.accent,fontWeight:500,fontSize:13}}>#{o.numero}</span></div>
                              <div style={{fontSize:12,color:T.textSm,marginTop:2}}>{o.productos.map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'')).join(' · ')}</div>
                            </div>
                            <div style={{display:"flex",gap:8,alignItems:"center",flexShrink:0}}>
                              <span style={{fontSize:14,fontWeight:700,color:T.text}}>{fmtMoney(o.total)}</span>
                              <span style={{fontSize:12,color:T.textSm}}>{isOpen?"▲":"▼"}</span>
                            </div>
                          </div>
                          {isOpen&&(
                            <div style={{padding:"0 18px 18px",borderTop:`0.5px solid ${T.borderL}`}} onClick={e=>e.stopPropagation()}>
                              <div style={{display:"flex",gap:16,flexWrap:"wrap",paddingTop:12,marginBottom:12}}>
                                <div><div style={{fontSize:10,textTransform:"uppercase",color:T.textSm,fontWeight:600}}>Email</div><div style={{fontSize:13,color:T.text}}>{o.email||"—"}</div></div>
                                <div><div style={{fontSize:10,textTransform:"uppercase",color:T.textSm,fontWeight:600}}>Teléfono</div><div style={{fontSize:13,color:T.text}}>{o.telefono||"—"}</div></div>
                                <div><div style={{fontSize:10,textTransform:"uppercase",color:T.textSm,fontWeight:600}}>Pago</div><div style={{fontSize:13,color:T.text}}>{o.medioPago||"—"}</div></div>
                                <div><div style={{fontSize:10,textTransform:"uppercase",color:T.textSm,fontWeight:600}}>Envío</div><div style={{fontSize:13,color:T.text}}>{o.esSucursal?"🏪 Sucursal":"🏠 Domicilio"} · {o.medioEnvio||"—"}</div></div>
                              </div>
                              <div style={{background:T.bg,borderRadius:8,padding:"10px 12px",marginBottom:12,fontSize:13,color:T.text}}>
                                <div style={{fontWeight:600,color:T.textSm,fontSize:10,textTransform:"uppercase",marginBottom:4}}>Dirección</div>
                                {o.esSucursal&&o.pickupDetails?(
                                  <div><div style={{fontWeight:600}}>{o.pickupDetails.name}</div><div>{o.pickupDetails.address?.address} {o.pickupDetails.address?.number}</div><div style={{color:T.textSm}}>{o.pickupDetails.address?.locality}, {o.pickupDetails.address?.province}</div></div>
                                ):(
                                  <div>{o.direccion} {o.dirNumero}{o.piso?`, ${o.piso}`:""}, {o.localidad||o.ciudad}, {o.provincia} CP {o.cp}</div>
                                )}
                              </div>
                              <div style={{marginBottom:12}}>
                                <div style={{fontSize:10,textTransform:"uppercase",color:T.textSm,fontWeight:600,marginBottom:6}}>Productos</div>
                                {o.productos.map((p,i)=>(
                                  <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:13,padding:"4px 0",borderBottom:i<o.productos.length-1?`1px solid ${T.borderL}`:"none"}}>
                                    <span>{p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'')}</span>
                                    <span style={{color:T.textSm,flexShrink:0,marginLeft:8}}>{p.cantidad>1?`${p.cantidad}x`:""} {fmtMoney(p.precio)}</span>
                                  </div>
                                ))}
                                <div style={{display:"flex",justifyContent:"flex-end",marginTop:6,fontWeight:700,fontSize:14}}>Total: {fmtMoney(o.total)}</div>
                              </div>
                              {hasR.length>0&&(
                                <div style={{marginBottom:12}}>
                                  {hasR.map(r=>(
                                    <span key={r._docId} onClick={()=>{setActiveReclamo(r._docId);setView("reclamos");setSearchGlobal("");setPedidoDetalle(null);}} style={{display:"inline-flex",alignItems:"center",gap:5,background:T.redBg,border:`1px solid ${T.red}33`,borderRadius:6,padding:"4px 12px",marginRight:6,cursor:"pointer",fontSize:12,color:T.red,fontWeight:500}}>
                                      ⚠ {r.tipo} · {r.estado}
                                    </span>
                                  ))}
                                </div>
                              )}
                              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                                <button onClick={()=>{setReclamoForm(emptyForm(o.numero));setPedidoDetalle(null);}} style={{...BtnDanger(T),fontSize:12,padding:"8px 14px"}}>+ Crear Reclamo</button>
                                {onGenerarCanje&&<button onClick={()=>{const prods=o.productos?.map(p=>p.nombre?.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'').trim()||p.sku).filter(Boolean)||[];onGenerarCanje({influencer:o.comprador,email:o.email||"",telefono:o.telefono||"",productos:prods,producto:prods[0]||"",notas:`Pedido #${o.numero} · ${new Date().toLocaleDateString('es-AR')}`,estado:"Pendiente envío",red:"Instagram",usuario:"",seguidores:"",foto:"",nicho:"",tracking:"",linkContenido:"",fechaEnvio:"",fechaPublicacion:"",contenido:[],alcance:"",reproducciones:"",likes:"",guardados:"",historial:[],recordatorio:""});setPedidoDetalle(null);}} style={{...BtnSecondary(T),fontSize:12,padding:"8px 14px",color:T.purple}}>🤝 Generar Canje</button>}
                                <button onClick={()=>generarEtiquetaAndreani(o)} style={{...BtnSecondary(T),fontSize:12,padding:"8px 14px",color:T.blue}}>📦 Etiqueta Andreani</button>
                                {o.telefono&&<a href={`https://wa.me/${o.telefono.replace(/\D/g,'')}`} target="_blank" rel="noopener noreferrer" style={{...BtnSecondary(T),fontSize:12,padding:"8px 14px",textDecoration:"none",color:T.green}}>💬 WhatsApp</a>}
                                {o.linkOrden&&<a href={o.linkOrden} target="_blank" rel="noopener noreferrer" style={{...BtnSecondary(T),fontSize:12,padding:"8px 14px",textDecoration:"none",color:T.purple}}>🔗 Ver en TN</a>}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </>
                )}
                {globalResults.recls?.length>0&&(
                  <>
                    <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.6,marginBottom:10,marginTop:16}}>Reclamos activos ({globalResults.recls.length})</div>
                    {globalResults.recls.map(r=>{
                      const o=orders.find(o=>o.numero===r.orderNum);
                      const sc=getEstadoRC(T,r.estado);
                      return (
                        <div key={r._docId} onClick={()=>{setActiveReclamo(r._docId);setView("reclamos");}} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:"12px 16px",marginBottom:8,cursor:"pointer",transition:"background 0.1s",display:"flex",justifyContent:"space-between",alignItems:"center"}} onMouseEnter={e=>e.currentTarget.style.background=T.surface} onMouseLeave={e=>e.currentTarget.style.background=T.card}>
                          <div>
                            <div style={{fontSize:14,fontWeight:600,color:T.text}}>#{r.orderNum} · {o?.comprador||"—"}</div>
                            <div style={{fontSize:12,color:T.textSm,marginTop:2}}>{r.tipo} · {r.motivo}</div>
                          </div>
                          <Badge T={T} colors={sc}>{r.estado}</Badge>
                        </div>
                      );
                    })}
                  </>
                )}
                {!globalResults.pedidos?.length&&!globalResults.recls?.length&&(
                  <div style={{textAlign:"center",padding:"40px 20px",color:T.textSm}}>
                    <div style={{fontSize:32,marginBottom:10}}>🔍</div>
                    <div style={{fontSize:15,color:T.textMd}}>Sin resultados para "{searchGlobal}"</div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── RECLAMOS LIST + PANEL UNIFICADO ── */}
        {view==="reclamos"&&(
          <div style={{display:"grid",gridTemplateColumns:activeR?"1fr 420px":"1fr",gap:20,padding:"20px 0 48px",alignItems:"start"}}>
            {/* Lista */}
            <div>
              {/* Filters */}
              <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:14,alignItems:"center"}}>
                <div style={{position:"relative",flex:"1 1 200px",minWidth:180}}>
                  <span style={{position:"absolute",left:11,top:"50%",transform:"translateY(-50%)",color:T.textSm}}>🔍</span>
                  <input placeholder="Buscar..." value={search} onChange={e=>setSearch(e.target.value)} style={{...iS,paddingLeft:32,fontSize:13}} onFocus={e=>e.target.style.borderColor=T.accent} onBlur={e=>e.target.style.borderColor=T.inputBorder}/>
                </div>
                <select value={filterEstado} onChange={e=>setFilterEstado(e.target.value)} style={{...iS,width:"auto",flex:"0 1 160px",fontSize:12,color:filterEstado?T.accent:T.textMd}}><option value="">Estado</option>{ESTADOS_R.map(e=><option key={e}>{e}</option>)}</select>
                <select value={filterTipo} onChange={e=>setFilterTipo(e.target.value)} style={{...iS,width:"auto",flex:"0 1 130px",fontSize:12,color:filterTipo?T.accent:T.textMd}}><option value="">Tipo</option>{TIPOS_R.map(t=><option key={t}>{t}</option>)}</select>
                <button onClick={()=>setFilterUrgentes(v=>!v)} style={{...BtnSecondary(T),fontSize:12,padding:"7px 12px",borderColor:filterUrgentes?T.red:T.border,color:filterUrgentes?T.red:T.textMd,background:filterUrgentes?T.redBg:T.card}}>⚠ Urgentes</button>
                <span style={{fontSize:11,color:T.textSm,marginLeft:"auto"}}>{filteredReclamos.length} reclamos</span>
              </div>

              {filteredReclamos.length===0?(
                <div style={{textAlign:"center",padding:"60px 20px",color:T.textSm}}>
                  <div style={{fontSize:36,marginBottom:10}}>📋</div>
                  <div style={{fontSize:15,color:T.textMd}}>{reclamos.length===0?"Sin reclamos todavía":"Sin resultados"}</div>
                </div>
              ):(
                <div style={{display:"flex",flexDirection:"column",gap:6}}>
                  {filteredReclamos.map((r,rIdx)=>{
                    const o=orders.find(o=>o.numero===r.orderNum);
                    const sc=getEstadoRC(T,r.estado);
                    const tc=getTipoRC(T,r.tipo);
                    const dias=r.createdAt?.seconds?Math.floor((Date.now()-r.createdAt.seconds*1000)/86400000):0;
                    const urgente=!["Resuelto","Rechazado"].includes(r.estado)&&dias>=3;
                    const isActive=activeReclamo===r._docId;
                    return (
                      <div key={r._docId} onClick={()=>setActiveReclamo(isActive?null:r._docId)}
                        style={{background:isActive?T.surface:T.card,border:`0.5px solid ${isActive?T.accentSolid:urgente?T.red+"44":T.border}`,borderLeft:`3px solid ${sc.dot}`,borderRadius:10,padding:"15px 16px",cursor:"pointer",transition:"all 0.1s",animation:"growith-fadeIn 0.2s ease both",animationDelay:`${Math.min(rIdx*25,200)}ms`}}
                        onMouseEnter={e=>{if(!isActive)e.currentTarget.style.background=T.surface;}}
                        onMouseLeave={e=>{if(!isActive)e.currentTarget.style.background=T.card;}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
                          <div style={{flex:1}}>
                            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                              <span style={{fontWeight:700,fontSize:14,color:T.accent}}>#{r.orderNum}</span>
                              <span style={{fontSize:14,fontWeight:600,color:T.text}}>{o?.comprador||"—"}</span>
                              {dias>0&&<span style={{fontSize:10,background:urgente?T.redBg:T.surface,color:urgente?T.red:T.textSm,border:`0.5px solid ${urgente?T.red+"44":T.border}`,borderRadius:4,padding:"2px 6px",fontWeight:urgente?700:400}}>{dias}d</span>}
                            </div>
                            <div style={{fontSize:12,color:T.textSm,marginBottom:6}}>{r.motivo}</div>
                            <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                              <Badge T={T} colors={sc}>{r.estado}</Badge>
                              <Badge T={T} colors={tc}>{r.tipo}</Badge>
                              {r.trackingCambio&&<span style={{fontSize:11,color:T.purple,background:T.purpleBg,border:`1px solid ${T.purple}33`,borderRadius:4,padding:"2px 6px"}}>📦 {r.trackingCambio.slice(0,12)}...</span>}
                            </div>
                          </div>
                          <div style={{fontSize:11,color:T.textSm,whiteSpace:"nowrap"}}>{fmtTs(r.createdAt)}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Panel unificado */}
            {activeR&&(
              <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,overflow:"hidden",position:"sticky",top:76}}>
                {/* Header panel */}
                <div style={{background:T.surface,borderBottom:`1px solid ${T.border}`,padding:"16px 18px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div>
                    <div style={{fontSize:16,fontWeight:800,color:T.text}}>{activeOrder?.comprador||`Pedido #${activeR.orderNum}`}</div>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginTop:4,flexWrap:"wrap"}}>
                      <span style={{fontSize:12,color:T.accent}}>Pedido #{activeR.orderNum} · {activeR.tipo}</span>
                      {activeOrder?.estadoEnvio&&(()=>{const ec=getEstadoEnvioC(T,activeOrder.estadoEnvio);return <span style={{fontSize:11,background:ec.bg,color:ec.text,border:`0.5px solid ${ec.dot}33`,borderRadius:5,padding:"1px 7px",fontWeight:500}}>{activeOrder.estadoEnvio}</span>;})()}
                      {activeOrder?.medioPago&&<span style={{fontSize:11,color:T.textSm}}>{activeOrder.medioPago}</span>}
                    </div>
                    {!activeOrder&&<div style={{fontSize:11,color:T.textSm,marginTop:2}}>⏳ Cargando datos del pedido...</div>}
                  </div>
                  <button onClick={()=>setActiveReclamo(null)} style={{...BtnSecondary(T),padding:"4px 8px",fontSize:14}}>✕</button>
                </div>

                <div style={{maxHeight:"80vh",overflow:"auto",padding:"16px 18px"}}>

                  {/* Estado actual + cambio rápido */}
                  {(()=>{const sc=getEstadoRC(T,activeR.estado);return(
                    <div style={{background:sc.bg,border:`1px solid ${sc.dot}33`,borderRadius:10,padding:"12px 14px",marginBottom:14}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                        <span style={{width:10,height:10,borderRadius:"50%",background:sc.dot,boxShadow:`0 0 6px ${sc.dot}`}}/>
                        <span style={{fontSize:15,fontWeight:700,color:sc.text}}>{activeR.estado}</span>
                      </div>
                      <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                        {ESTADOS_R.filter(e=>e!==activeR.estado).map(e=>{const c=getEstadoRC(T,e);return(
                          <button key={e} onClick={()=>updateEstado(activeR._docId,e)} style={{fontSize:11,fontWeight:500,padding:"4px 10px",borderRadius:6,background:T.card,color:c.text,border:`1px solid ${c.dot}44`,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>{e}</button>
                        );})}
                      </div>
                    </div>
                  );})()}

                  {/* Datos del cliente */}
                  <div style={{marginBottom:14}}>
                    <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:8}}>Cliente</div>
                    <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                      {activeOrder?.telefono&&<a href={`https://wa.me/${activeOrder.telefono.replace(/\D/g,'')}`} target="_blank" rel="noopener noreferrer" style={{...BtnSecondary(T),fontSize:12,padding:"6px 12px",textDecoration:"none",color:T.green}}>💬 {activeOrder.telefono}</a>}
                      {activeOrder?.email&&<span style={{fontSize:12,color:T.textSm,display:"flex",alignItems:"center",gap:4}}>✉️ {activeOrder.email}</span>}
                    </div>
                  </div>

                  {/* Productos del pedido */}
                  <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:"12px 14px",marginBottom:14}}>
                    <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:8}}>Productos comprados</div>
                    {(activeOrder?.productos||[]).map((p,i)=>(
                      <div key={i} style={{fontSize:13,color:T.text,padding:"4px 0",borderBottom:i<(activeOrder?.productos?.length||0)-1?`1px solid ${T.borderL}`:"none",display:"flex",justifyContent:"space-between"}}>
                        <span>{p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'')}</span>
                        <span style={{color:T.textSm}}>x{p.cantidad}</span>
                      </div>
                    ))}
                  </div>

                  {/* Detalle del cambio */}
                  {activeR.tipo==="Cambio"&&(
                    <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:"12px 14px",marginBottom:14}}>
                      <div style={{fontSize:11,textTransform:"uppercase",color:T.purple,fontWeight:600,letterSpacing:0.5,marginBottom:10}}>🔄 Cambio</div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr auto 1fr",gap:8,alignItems:"start",marginBottom:12}}>
                        <div>
                          <div style={{fontSize:10,color:T.textSm,fontWeight:600,textTransform:"uppercase",marginBottom:4}}>Nos devuelve</div>
                          {(activeR.productosRecibe||[]).filter(p=>p.producto).map((item,i)=><div key={i} style={{fontSize:13,fontWeight:600,color:T.red,marginBottom:2}}>{item.cantidad>1&&<span style={{color:T.textSm,fontSize:11}}>{item.cantidad}× </span>}{item.producto}</div>)}
                        </div>
                        <div style={{color:T.textSm,paddingTop:18,fontSize:16}}>→</div>
                        <div>
                          <div style={{fontSize:10,color:T.textSm,fontWeight:600,textTransform:"uppercase",marginBottom:4}}>Le enviamos</div>
                          {(activeR.productosEnvia||[]).filter(p=>p.producto).map((item,i)=><div key={i} style={{fontSize:13,fontWeight:600,color:T.green,marginBottom:2}}>{item.cantidad>1&&<span style={{color:T.textSm,fontSize:11}}>{item.cantidad}× </span>}{item.producto}</div>)}
                        </div>
                      </div>
                      {/* Tracking del cambio */}
                      <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:6}}>Tracking del nuevo envío</div>
                      <div style={{display:"flex",gap:8,flexDirection:"column"}}>
                        <div style={{display:"flex",gap:8}}>
                          <input style={{...iS,flex:1,fontSize:13,padding:"8px 12px"}} value={activeR.trackingCambio||""} placeholder="Código Andreani..." onChange={async e=>{await updateDoc(doc(db,"reclamos",activeR._docId),{trackingCambio:e.target.value,updatedAt:serverTimestamp()});}} />
                          {activeR.trackingCambio&&<a href={`https://www.andreani.com/#!/informacionEnvio/${activeR.trackingCambio}`} target="_blank" rel="noopener noreferrer" style={{...BtnPurple(T),fontSize:12,padding:"8px 14px",textDecoration:"none",flexShrink:0}}>📦 Seguimiento</a>}
                        </div>
                        {activeR.trackingCambio&&(
                          <AsyncButton onClick={async()=>{
                            const r=await fetch(`/api/update-shipping?uid=${user?.uid}&orderId=${activeR.orderNum}&tracking=${activeR.trackingCambio}`);
                            const d=await r.json();
                            if(r.ok) alert("✅ Tracking actualizado en Tienda Nube");
                            else alert("Error: "+(d.error||"no se pudo actualizar"));
                          }} style={{...BtnSecondary(T),fontSize:12,padding:"7px 12px",color:T.green,alignSelf:"flex-start"}}>
                            ↑ Subir tracking a Tienda Nube
                          </AsyncButton>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Devolución */}
                  {activeR.tipo==="Devolución"&&(
                    <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:"12px 14px",marginBottom:14}}>
                      <div style={{fontSize:11,textTransform:"uppercase",color:T.orange,fontWeight:600,letterSpacing:0.5,marginBottom:10}}>↩️ Devolución</div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 12px"}}>
                        <div style={{marginBottom:10}}>
                          <div style={{fontSize:11,color:T.textSm,fontWeight:600,marginBottom:5}}>Recepción del producto</div>
                          <select style={{...iS,fontSize:12}} value={activeR.estadoRecepcion||""} onChange={async e=>{await updateDoc(doc(db,"reclamos",activeR._docId),{estadoRecepcion:e.target.value,updatedAt:serverTimestamp()});}}>
                            <option value="">—</option>
                            <option>Esperando envío</option>
                            <option>En tránsito</option>
                            <option>Recibido</option>
                            <option>Inspeccionado</option>
                          </select>
                        </div>
                        <div>
                          <div style={{fontSize:11,color:T.textSm,fontWeight:600,marginBottom:5}}>Estado del reembolso</div>
                          <select style={{...iS,fontSize:12}} value={activeR.estadoReembolso||""} onChange={async e=>{await updateDoc(doc(db,"reclamos",activeR._docId),{estadoReembolso:e.target.value,updatedAt:serverTimestamp()});}}>
                            <option value="">—</option>
                            <option>Pendiente</option>
                            <option>En proceso</option>
                            <option>Procesado</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Notas internas */}
                  <div style={{marginBottom:14}}>
                    <div style={{fontSize:11,textTransform:"uppercase",color:T.yellow,fontWeight:600,letterSpacing:0.5,marginBottom:8}}>🔒 Notas internas</div>
                    <textarea
                      rows={3}
                      placeholder="Notas privadas (no visibles para el cliente)..."
                      defaultValue={activeR.notasInternas||""}
                      onBlur={async e=>{
                        const val=e.target.value;
                        if(val!==(activeR.notasInternas||""))
                          await updateDoc(doc(db,"reclamos",activeR._docId),{notasInternas:val,updatedAt:serverTimestamp()});
                      }}
                      style={{...InputStyle(T),width:"100%",resize:"vertical",fontSize:12,padding:"8px 10px",lineHeight:1.5,fontFamily:"'Inter',system-ui,sans-serif",boxSizing:"border-box",minHeight:70,background:T.yellowBg||T.surface,borderColor:T.yellow+"44"}}
                      onFocus={e=>e.target.style.borderColor=T.yellow}
                    />
                  </div>

                  {/* Plantillas de mensajes */}
                  <div style={{marginBottom:14}}>
                    <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:8}}>Mensajes rápidos</div>
                    <div style={{display:"flex",flexDirection:"column",gap:6}}>
                      {plantillas.filter(p=>p.tipo===activeR.tipo||p.estado===activeR.estado).slice(0,4).map(p=>(
                        <button key={p.id} onClick={()=>copyMensaje(p,activeR)}
                          style={{...BtnSecondary(T),fontSize:12,padding:"8px 12px",justifyContent:"space-between",width:"100%",background:copiedMsg===p.id?T.greenBg:T.card,borderColor:copiedMsg===p.id?T.green:T.border,color:copiedMsg===p.id?T.green:T.text,transition:"all 0.2s"}}>
                          <span>{p.nombre}</span>
                          <span style={{fontSize:11,color:copiedMsg===p.id?T.green:T.textSm}}>{copiedMsg===p.id?"✓ Copiado":"📋 Copiar"}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Historial */}
                  <div style={{marginBottom:14}}>
                    <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:8}}>Historial</div>
                    <HistorialReclamo T={T} reclamo={activeR} onAdd={addNotaReclamo}/>
                  </div>

                  {/* Acciones */}
                  {/* Acciones */}
                  <div style={{display:"flex",gap:8,paddingTop:12,borderTop:`0.5px solid ${T.borderL}`,flexWrap:"wrap"}}>
                    {/* Generar etiqueta Andreani */}
                    <AsyncButton onClick={()=>generarEtiquetaAndreani(activeOrder)} disabled={!activeOrder} style={{...BtnSecondary(T),fontSize:12,padding:"7px 12px",color:T.blue}}>📦 Etiqueta Andreani</AsyncButton>
                    {deleteConfirm===activeR._docId?(
                      <div style={{display:"flex",gap:6,alignItems:"center"}}><span style={{fontSize:12,color:T.red}}>¿Eliminar?</span><AsyncButton onClick={()=>deleteReclamo(activeR._docId)} style={{...BtnDanger(T),padding:"6px 12px",fontSize:12}}>Sí</AsyncButton><button onClick={()=>setDeleteConfirm(null)} style={{...BtnSecondary(T),padding:"6px 12px",fontSize:12}}>No</button></div>
                    ):(
                      <><button onClick={()=>setDeleteConfirm(activeR._docId)} style={{...BtnDanger(T),fontSize:12,padding:"7px 12px"}}>Eliminar</button><button onClick={()=>{setReclamoForm({...activeR,productosRecibe:activeR.productosRecibe||[{producto:"",cantidad:1}],productosEnvia:activeR.productosEnvia||[{producto:"",cantidad:1}],historial:activeR.historial||[],trackingCambio:activeR.trackingCambio||"",estadoRecepcion:activeR.estadoRecepcion||"",estadoReembolso:activeR.estadoReembolso||""});}} style={{...BtnSecondary(T),fontSize:12,padding:"7px 12px"}}>Editar todo</button>
                      {activeOrder?.linkOrden&&<a href={activeOrder.linkOrden} target="_blank" rel="noopener noreferrer" style={{...BtnSecondary(T),fontSize:12,padding:"7px 12px",textDecoration:"none",color:T.purple}}>🔗 TN</a>}</>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── CONFIGURACION PLANTILLAS ── */}
        {view==="config"&&(
          <div style={{padding:"24px 0 48px",maxWidth:720}}>
            <div style={{fontSize:22,fontWeight:800,color:T.text,marginBottom:6,letterSpacing:-0.5}}>⚙️ Plantillas de mensajes</div>
            <div style={{fontSize:14,color:T.textMd,marginBottom:24}}>Editá los mensajes pre-armados. Usá [nombre], [pedido], [tracking] como variables que se reemplazan automáticamente.</div>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {plantillas.map((p,i)=>(
                <div key={p.id} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"16px 18px"}}>
                  {plantillaEdit===p.id?(
                    <div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"0 12px",marginBottom:10}}>
                        <div><div style={{fontSize:11,color:T.textSm,fontWeight:600,marginBottom:4}}>Nombre</div><input style={{...iS,fontSize:13}} value={p.nombre} onChange={e=>{const l=[...plantillas];l[i]={...p,nombre:e.target.value};setPlantillas(l);}}/></div>
                        <div><div style={{fontSize:11,color:T.textSm,fontWeight:600,marginBottom:4}}>Tipo</div><select style={{...iS,fontSize:13}} value={p.tipo} onChange={e=>{const l=[...plantillas];l[i]={...p,tipo:e.target.value};setPlantillas(l);}}><option>Cambio</option><option>Devolución</option></select></div>
                        <div><div style={{fontSize:11,color:T.textSm,fontWeight:600,marginBottom:4}}>Estado</div><select style={{...iS,fontSize:13}} value={p.estado} onChange={e=>{const l=[...plantillas];l[i]={...p,estado:e.target.value};setPlantillas(l);}}>{ESTADOS_R.map(e=><option key={e}>{e}</option>)}</select></div>
                      </div>
                      <div style={{marginBottom:10}}><div style={{fontSize:11,color:T.textSm,fontWeight:600,marginBottom:4}}>Mensaje</div><textarea style={{...iS,minHeight:80,resize:"vertical",fontSize:13}} value={p.mensaje} onChange={e=>{const l=[...plantillas];l[i]={...p,mensaje:e.target.value};setPlantillas(l);}}/></div>
                      <div style={{display:"flex",gap:8}}>
                        <button onClick={()=>{savePlantillas(plantillas);setPlantillaEdit(null);}} style={{...BtnPrimary(T),fontSize:12,padding:"7px 14px"}}>Guardar</button>
                        <button onClick={()=>setPlantillaEdit(null)} style={{...BtnSecondary(T),fontSize:12,padding:"7px 14px"}}>Cancelar</button>
                      </div>
                    </div>
                  ):(
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12}}>
                      <div style={{flex:1}}>
                        <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:6}}>
                          <span style={{fontSize:14,fontWeight:700,color:T.text}}>{p.nombre}</span>
                          <Badge T={T} colors={getTipoRC(T,p.tipo)} small>{p.tipo}</Badge>
                          <Badge T={T} colors={getEstadoRC(T,p.estado)} small>{p.estado}</Badge>
                        </div>
                        <div style={{fontSize:13,color:T.textMd,lineHeight:1.5}}>{p.mensaje}</div>
                      </div>
                      <div style={{display:"flex",gap:6,flexShrink:0}}>
                        <button onClick={()=>setPlantillaEdit(p.id)} style={{...BtnSecondary(T),fontSize:12,padding:"6px 10px"}}>Editar</button>
                        <button onClick={()=>{const l=plantillas.filter((_,j)=>j!==i);savePlantillas(l);}} style={{...BtnDanger(T),fontSize:12,padding:"6px 10px"}}>✕</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <button onClick={()=>{const nueva={id:`p${Date.now()}`,nombre:"Nueva plantilla",tipo:"Cambio",estado:"Nuevo",mensaje:"Hola [nombre]!"};const l=[...plantillas,nueva];savePlantillas(l);setPlantillaEdit(nueva.id);}} style={{...BtnPrimary(T),fontSize:13,marginTop:16}}>+ Agregar plantilla</button>
          </div>
        )}
      </div>

      {/* Form Modal - Nuevo/Editar Reclamo */}
      <Modal T={T} open={!!reclamoForm} onClose={()=>setReclamoForm(null)} title={reclamoForm?._docId?"Editar Reclamo":reclamoForm?.orderNum?`Nuevo Reclamo — #${reclamoForm.orderNum}`:"Nuevo Reclamo"} width={580}>
        {reclamoForm&&(
          <div>
            {!reclamoForm._docId&&!reclamoForm.orderNum&&<Field T={T} label="Pedido" required><OrderSearchField T={T} orders={orders} onSelect={num=>setReclamoForm(f=>({...f,orderNum:num}))}/></Field>}
            {(()=>{const o=orders.find(o=>o.numero===reclamoForm.orderNum);return o?(<div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:"10px 14px",marginBottom:14,display:"flex",justifyContent:"space-between",alignItems:"center"}}><div><span style={{fontWeight:700,fontSize:14,color:T.text}}>#{o.numero} — {o.comprador}</span><div style={{color:T.textSm,fontSize:12,marginTop:2}}>{o.productos.map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'')).join(', ')}</div></div>{!reclamoForm._docId&&<button onClick={()=>setReclamoForm(f=>({...f,orderNum:""}))} style={{...BtnDanger(T),padding:"4px 8px",fontSize:11}}>Cambiar</button>}</div>):null;})()}
            {reclamoForm.orderNum&&(<>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 14px"}}>
                <Field T={T} label="Tipo"><select style={iS} value={reclamoForm.tipo} onChange={e=>setReclamoForm(f=>({...f,tipo:e.target.value}))}>{TIPOS_R.map(t=><option key={t}>{t}</option>)}</select></Field>
                <Field T={T} label="Motivo" required><select style={iS} value={reclamoForm.motivo} onChange={e=>setReclamoForm(f=>({...f,motivo:e.target.value}))}><option value="">—</option>{MOTIVOS_R.map(m=><option key={m}>{m}</option>)}</select></Field>
              </div>
              {reclamoForm.tipo==="Cambio"&&(
                <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:14,marginBottom:12}}>
                  <div style={{fontSize:11,textTransform:"uppercase",color:T.purple,fontWeight:700,letterSpacing:0.5,marginBottom:10}}>🔄 Detalle del cambio</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 16px"}}>
                    {["productosRecibe","productosEnvia"].map((key,side)=>(
                      <div key={key}>
                        <div style={{fontSize:11,color:T.textSm,fontWeight:600,marginBottom:6,textTransform:"uppercase"}}>{side===0?"Nos devuelve":"Le enviamos"}</div>
                        {(reclamoForm[key]||[]).map((item,i)=>(
                          <div key={i} style={{display:"flex",gap:4,marginBottom:6,alignItems:"center"}}>
                            <select style={{...iS,flex:1,fontSize:12,padding:"7px 8px"}} value={item.producto} onChange={e=>{const arr=[...reclamoForm[key]];arr[i]={...arr[i],producto:e.target.value};setReclamoForm(f=>({...f,[key]:arr}));}}><option value="">—</option>{PRODUCTOS.map(p=><option key={p}>{p}</option>)}</select>
                            <input type="number" min={1} value={item.cantidad} onChange={e=>{const arr=[...reclamoForm[key]];arr[i]={...arr[i],cantidad:parseInt(e.target.value)||1};setReclamoForm(f=>({...f,[key]:arr}));}} style={{...iS,width:48,textAlign:"center",fontSize:12,padding:"7px 4px",flexShrink:0}}/>
                            {reclamoForm[key].length>1&&<button onClick={()=>setReclamoForm(f=>({...f,[key]:f[key].filter((_,j)=>j!==i)}))} style={{...BtnDanger(T),padding:"4px 6px",fontSize:12,flexShrink:0}}>✕</button>}
                          </div>
                        ))}
                        <button onClick={()=>setReclamoForm(f=>({...f,[key]:[...(f[key]||[]),{producto:"",cantidad:1}]}))} style={{...BtnSecondary(T),width:"100%",justifyContent:"center",fontSize:11,padding:"5px"}}>+ Agregar</button>
                      </div>
                    ))}
                  </div>
                  <div style={{marginTop:12}}>
                  <Field T={T} label="Tracking del nuevo envío">
                    <input style={iS} value={reclamoForm.trackingCambio||""} onChange={e=>setReclamoForm(f=>({...f,trackingCambio:e.target.value}))} placeholder="Código Andreani"/>
                  </Field>
                  </div>
                </div>
              )}
              <Field T={T} label="Descripción"><textarea style={{...iS,minHeight:60,resize:"vertical"}} value={reclamoForm.descripcion} onChange={e=>setReclamoForm(f=>({...f,descripcion:e.target.value}))} placeholder="Detalle del reclamo..."/></Field>
              {reclamoForm._docId&&(
                <Field T={T} label="Estado">
                  <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                    {ESTADOS_R.map(e=>{const c=getEstadoRC(T,e);const sel=reclamoForm.estado===e;return(<button key={e} onClick={()=>setReclamoForm(f=>({...f,estado:e}))} style={{display:"flex",alignItems:"center",gap:6,padding:"7px 12px",borderRadius:8,fontSize:12,fontWeight:sel?700:400,background:sel?c.bg:T.card,color:sel?c.text:T.textMd,border:`1.5px solid ${sel?c.dot:T.border}`,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",transition:"all 0.15s"}}><span style={{width:7,height:7,borderRadius:"50%",background:sel?c.dot:T.textSm}}/>{e}</button>);})}
                  </div>
                </Field>
              )}
              <Field T={T} label="Notas internas"><textarea style={{...iS,minHeight:50,resize:"vertical"}} value={reclamoForm.notas||""} onChange={e=>setReclamoForm(f=>({...f,notas:e.target.value}))} placeholder="Notas para el equipo..."/></Field>
              <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:10}}>
                <button onClick={()=>setReclamoForm(null)} style={BtnSecondary(T)}>Cancelar</button>
                <AsyncButton onClick={saveReclamo} disabled={!reclamoForm.motivo} style={{...BtnPrimary(T)}}>{reclamoForm._docId?"Guardar":"Crear Reclamo"}</AsyncButton>
              </div>
            </>)}
          </div>
        )}
      </Modal>
    </div>
  );
}

// ─── Historial Reclamo Component ───
function HistorialReclamo({T, reclamo, onAdd}) {
  const [texto,setTexto]=useState("");
  const [guardando,setGuardando]=useState(false);
  const iS=InputStyle(T);
  const historial=[...(reclamo.historial||[])].sort((a,b)=>new Date(b.fecha)-new Date(a.fecha));
  async function handleAdd(){
    if(!texto.trim()) return;
    setGuardando(true);
    await onAdd(reclamo._docId,texto);
    setTexto("");setGuardando(false);
  }
  return(
    <div>
      <div style={{display:"flex",gap:6,marginBottom:10}}>
        <input style={{...iS,flex:1,fontSize:12,padding:"7px 10px"}} value={texto} onChange={e=>setTexto(e.target.value)} placeholder="Agregar nota..." onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();handleAdd();}}}/>
        <button onClick={handleAdd} disabled={guardando||!texto.trim()} style={{...BtnPrimary(T),padding:"7px 12px",fontSize:12,opacity:guardando||!texto.trim()?0.5:1}}>+</button>
      </div>
      {historial.length>0&&(
        <div style={{display:"flex",flexDirection:"column",gap:5,maxHeight:200,overflow:"auto"}}>
          {historial.map((n,i)=>(
            <div key={i} style={{background:T.bg,border:`1px solid ${T.borderL}`,borderRadius:7,padding:"7px 10px",display:"flex",gap:8}}>
              <span style={{fontSize:13,flexShrink:0}}>{n.accion.startsWith("Nota:")?"💬":"📌"}</span>
              <div style={{flex:1}}>
                <div style={{fontSize:12,color:T.text,lineHeight:1.4}}>{n.accion.replace("Nota: ","")}</div>
                <div style={{fontSize:10,color:T.textSm,marginTop:2}}>{new Date(n.fecha).toLocaleDateString('es-AR')} {new Date(n.fecha).toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'})}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// ─── Notas Rápidas Component ───
function NotasRapidas({T, canje, onAdd}) {
  const [texto,setTexto]=useState("");
  const [guardando,setGuardando]=useState(false);
  const historial=[...(canje.historial||[])].sort((a,b)=>new Date(b.fecha)-new Date(a.fecha));

  async function handleAdd() {
    if(!texto.trim()) return;
    setGuardando(true);
    await onAdd(canje._docId,texto);
    setTexto("");
    setGuardando(false);
  }

  const iS=InputStyle(T);
  return (
    <div style={{marginBottom:14}}>
      <div style={{fontSize:12,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:8}}>Historial de seguimiento</div>
      <div style={{display:"flex",gap:8,marginBottom:10}}>
        <input style={{...iS,flex:1,fontSize:13}} value={texto} onChange={e=>setTexto(e.target.value)} placeholder="Ej: Habló hoy, publica la semana que viene..." onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();handleAdd();}}}/>
        <button onClick={handleAdd} disabled={guardando||!texto.trim()} style={{...BtnPrimary(T),padding:"10px 16px",fontSize:13,opacity:guardando||!texto.trim()?0.5:1,flexShrink:0}}>+</button>
      </div>
      {historial.length>0&&(
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          {historial.map((n,i)=>(
            <div key={n.id||i} style={{background:T.bg,border:`1px solid ${T.borderL}`,borderRadius:8,padding:"9px 12px",display:"flex",gap:10,alignItems:"flex-start"}}>
              <div style={{width:32,height:32,borderRadius:"50%",background:T.surface,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,flexShrink:0}}>💬</div>
              <div style={{flex:1}}>
                <div style={{fontSize:13,color:T.text,lineHeight:1.5}}>{n.texto}</div>
                <div style={{fontSize:11,color:T.textSm,marginTop:3}}>{new Date(n.fecha).toLocaleDateString('es-AR')} · {new Date(n.fecha).toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'})}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════
// APP CANJES
// ═══════════════════════════════════════════
function AppCanjes({T, fbStatus, user, onHome, pendingCanje, onClearPendingCanje}) {
  const [canjes,setCanjes]=useState([]);
  const [form,setForm]=useState(null);
  const [detail,setDetail]=useState(null);
  const [search,setSearch]=useState("");
  const [filterEstado,setFilterEstado]=useState("");
  const [filterRed,setFilterRed]=useState("");
  const [deleteConfirm,setDeleteConfirm]=useState(null);
  const [saving,setSaving]=useState(false);
  const [viewTab,setViewTab]=useState("lista"); // lista | kanban | ranking
  const [filterNicho,setFilterNicho]=useState("");
  const [filterSoloPendientes,setFilterSoloPendientes]=useState(false);
  const iS=InputStyle(T);
  const fbDot={connecting:T.yellow,ok:T.green,error:T.red}[fbStatus];

  useEffect(()=>{
    const qc=query(collection(db,"canjes"),where("ownerId","==",user?.uid||"__none__"));
    const unsub=onSnapshot(qc,snap=>{
      const data=snap.docs.map(d=>({...d.data(),_docId:d.id}));
      data.sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
      setCanjes(data);
    },()=>{});
    return ()=>unsub();
  },[]);

  useEffect(()=>{
    if(pendingCanje) {
      const prodsCanje=pendingCanje.productosCanje||(pendingCanje.productos||[]).map(p=>({nombre:typeof p==="string"?p:p.nombre,cantidad:1})).filter(p=>p.nombre);
      setForm({...emptyForm(),...pendingCanje,_docId:null,
        influencer:pendingCanje.nombre||pendingCanje.influencer||"",
        usuario:pendingCanje.usuario||pendingCanje.nombre||"",
        pedidoRef:pendingCanje.pedidoRef||"",
        productosCanje:prodsCanje,
        contenido:pendingCanje.contenido?.length?pendingCanje.contenido:[],
      });
      if(onClearPendingCanje) onClearPendingCanje();
    }
  },[pendingCanje]);

  const emptyForm=()=>({
    _docId:null, influencer:"", usuario:"", red:"Instagram", seguidores:"", email:"", telefono:"", linkInstagram:"", pedidoRef:"",
    producto:"", productosCanje:[], estado:"Pendiente envío", tracking:"", notas:"", linkContenido:"",
    fechaEnvio:"", fechaPublicacion:"",
    foto:"", nicho:"",
    contenido: ACTIVIDADES.map(tipo=>({tipo, acordados:0, entregados:0})),
    alcance:"", reproducciones:"", likes:"", guardados:"",
    historial:[],
    recordatorio:"",
  });

  async function saveCanje() {
    if(!form?.influencer) return;
    setSaving(true);
    try {
      const p={
        influencer:form.influencer, usuario:form.usuario||"", red:form.red, linkInstagram:form.linkInstagram||"", pedidoRef:form.pedidoRef||"",
        seguidores:form.seguidores||"", email:form.email||"", telefono:form.telefono||"",
        producto:form.producto||((form.productosCanje||[])[0]?.nombre||""),
        productosCanje:form.productosCanje||[],
        estado:form.estado, tracking:form.tracking||"",
        notas:form.notas||"", linkContenido:form.linkContenido||"",
        fechaEnvio:form.fechaEnvio||"", fechaPublicacion:form.fechaPublicacion||"",
        foto:form.foto||"", nicho:form.nicho||"",
        contenido:form.contenido||ACTIVIDADES.map(tipo=>({tipo,acordados:0,entregados:0})),
        alcance:form.alcance||"", reproducciones:form.reproducciones||"",
        likes:form.likes||"", guardados:form.guardados||"",
        historial:form.historial||[],
        recordatorio:form.recordatorio||"",
      };
      if(form._docId) {
        const prev=canjes.find(c=>c._docId===form._docId);
        await updateDoc(doc(db,"canjes",form._docId),{...p,updatedAt:serverTimestamp(),...(form.estado==="Finalizado"&&prev?.estado!=="Finalizado"?{finalizadoAt:serverTimestamp()}:{})});
      } else {
        await addDoc(collection(db,"canjes"),{...p,ownerId:user.uid,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
      }
      setForm(null);
    } catch(e){alert("Error al guardar.");}
    setSaving(false);
  }

  async function deleteCanje(docId) {
    try{await deleteDoc(doc(db,"canjes",docId));}catch(e){}
    setDeleteConfirm(null);setDetail(null);
  }

  const filtered=useMemo(()=>canjes.filter(c=>{
    if(filterEstado&&c.estado!==filterEstado) return false;
    if(filterRed&&c.red!==filterRed) return false;
    if(filterNicho&&c.nicho!==filterNicho) return false;
    if(filterSoloPendientes){
      const cont=c.contenido||[];
      const total=cont.reduce((s,x)=>s+(x.acordados||0),0);
      const entregados=cont.reduce((s,x)=>s+(x.entregados||0),0);
      if(total===0||entregados>=total) return false;
    }
    if(search){const s=search.toLowerCase();return c.influencer.toLowerCase().includes(s)||(c.usuario||"").toLowerCase().includes(s)||(c.email||"").toLowerCase().includes(s);}
    return true;
  }),[canjes,search,filterEstado,filterRed,filterNicho,filterSoloPendientes]);

  // Alertas
  const alertas=useMemo(()=>{
    const hoy=new Date().toISOString().split('T')[0];
    const hace15=new Date(Date.now()-15*86400000).toISOString().split('T')[0];
    const alerts=[];
    canjes.forEach(c=>{
      if(c.recordatorio&&c.recordatorio<=hoy) alerts.push({tipo:"recordatorio",canje:c,msg:`Recordatorio vencido`});
      if(c.estado==="Enviado"&&c.fechaEnvio&&c.fechaEnvio<=hace15) alerts.push({tipo:"sinrespuesta",canje:c,msg:`Enviado hace +15 días sin respuesta`});
      if(c.estado==="Contenido pendiente"){
        const cont=c.contenido||[];
        const total=cont.reduce((s,x)=>s+(x.acordados||0),0);
        const entregados=cont.reduce((s,x)=>s+(x.entregados||0),0);
        if(total>0&&entregados<total) alerts.push({tipo:"contenido",canje:c,msg:`Debe ${total-entregados} contenido(s)`});
      }
    });
    return alerts;
  },[canjes]);

  async function addNota(docId, texto) {
    if(!texto.trim()) return;
    const c=canjes.find(c=>c._docId===docId);
    if(!c) return;
    const nuevaNota={texto,fecha:new Date().toISOString(),id:Date.now().toString()};
    const historial=[...(c.historial||[]),nuevaNota];
    await updateDoc(doc(db,"canjes",docId),{historial,updatedAt:serverTimestamp()});
  }

  function exportCSV() {
    const headers=["Nombre","Usuario","Red","Nicho","Seguidores","Producto","Estado","Fecha Envío","Tracking","Alcance","Reproducciones","Likes","Guardados","Email","Teléfono","Notas"];
    const rows=canjes.map(c=>[c.influencer,c.usuario,c.red,c.nicho||"",c.seguidores||"",c.producto,c.estado,c.fechaEnvio||"",c.tracking||"",c.alcance||"",c.reproducciones||"",c.likes||"",c.guardados||"",c.email||"",c.telefono||"",(c.notas||"").replace(/\n/g," ")]);
    const csv=[headers,...rows].map(r=>r.map(v=>`"${v}"`).join(",")).join("\n");
    const blob=new Blob([csv],{type:"text/csv;charset=utf-8;"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");a.href=url;a.download="canjes-growith.csv";a.click();URL.revokeObjectURL(url);
  }

  const stats={total:canjes.length,pendientes:canjes.filter(c=>c.estado==="Pendiente envío").length,enviados:canjes.filter(c=>c.estado==="Enviado").length,contPend:canjes.filter(c=>c.estado==="Contenido pendiente").length,publicados:canjes.filter(c=>c.estado==="Contenido publicado").length,finalizados:canjes.filter(c=>c.estado==="Finalizado").length};
  const detailC=canjes.find(c=>c._docId===detail);

  return (
    <div style={{fontFamily:"'Inter',system-ui,sans-serif",background:T.bg,minHeight:"100vh",color:T.text}}>
      <div style={{borderBottom:`1px solid ${T.border}`,background:T.surface,padding:"0 16px",position:"sticky",top:0,zIndex:100}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",height:62,gap:16,maxWidth:1280,margin:"0 auto"}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <button onClick={onHome} style={{...BtnSecondary(T),padding:"8px 14px",fontSize:13}}>← Inicio</button>
            <span style={{color:T.textSm,fontSize:16}}>/</span>
            <span style={{fontWeight:700,fontSize:16,color:T.text}}>🤝 Canjes</span>
            <div style={{display:"flex",alignItems:"center",gap:5,background:T.card,border:`1px solid ${T.border}`,borderRadius:20,padding:"4px 10px"}}>
              <span style={{width:7,height:7,borderRadius:"50%",background:fbDot,boxShadow:`0 0 5px ${fbDot}`}}/>
              <span style={{fontSize:11,color:T.textSm,fontWeight:500}}>{fbStatus==="ok"?"en vivo":"conectando"}</span>
            </div>
          </div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={exportCSV} style={{...BtnSecondary(T),fontSize:13}}>⬇️ Exportar CSV</button>
            <button onClick={()=>setForm(emptyForm())} style={{...BtnPurple(T),fontSize:13}}>+ Nuevo Canje</button>
          </div>
        </div>
      </div>

      <div style={{maxWidth:1280,margin:"0 auto",padding:"0 16px"}}>
        <div style={{display:"flex",gap:10,flexWrap:"wrap",padding:"24px 0 0"}}>
          <StatCard T={T} label="Total canjes" value={stats.total} color={T.textMd}/>
          <StatCard T={T} label="Pend. envío" value={stats.pendientes} color={T.yellow}/>
          <StatCard T={T} label="Enviados" value={stats.enviados} color={T.blue}/>
          <StatCard T={T} label="Cont. pendiente" value={stats.contPend} color={T.orange}/>
          <StatCard T={T} label="Publicados" value={stats.publicados} color={T.purple}/>
          <StatCard T={T} label="Finalizados" value={stats.finalizados} color={T.green}/>
        </div>

        {/* Tabs */}
        <div style={{display:"flex",borderBottom:`1px solid ${T.border}`,marginTop:20}}>
          {[{id:"lista",label:"Lista",icon:"☰"},{id:"kanban",label:"Kanban",icon:"⬜"},{id:"ranking",label:"Ranking",icon:"🏆"}].map(t=>(
            <button key={t.id} onClick={()=>setViewTab(t.id)}
              style={{padding:"13px 20px",fontSize:14,fontWeight:viewTab===t.id?700:400,color:viewTab===t.id?T.text:T.textMd,background:"none",border:"none",borderBottom:viewTab===t.id?`2.5px solid ${T.accent}`:"2.5px solid transparent",cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",display:"flex",alignItems:"center",gap:7,marginBottom:-1,transition:"color 0.15s"}}>
              {t.icon} {t.label}
            </button>
          ))}
        </div>

        <div style={{padding:"14px 0 8px",display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
          {viewTab!=="ranking"&&<>
            <div style={{position:"relative",flex:"1 1 220px",minWidth:180}}>
              <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",color:T.textSm,fontSize:14}}>🔍</span>
              <input placeholder="Buscar influencer..." value={search} onChange={e=>setSearch(e.target.value)} style={{...iS,paddingLeft:36,fontSize:14}} onFocus={e=>e.target.style.borderColor=T.accent} onBlur={e=>e.target.style.borderColor=T.inputBorder}/>
            </div>
            <select value={filterEstado} onChange={e=>setFilterEstado(e.target.value)} style={{...iS,width:"auto",flex:"0 1 170px",fontSize:13,color:filterEstado?T.accent:T.textMd}}><option value="">Estado</option>{ESTADOS_C.map(e=><option key={e}>{e}</option>)}</select>
            <select value={filterRed} onChange={e=>setFilterRed(e.target.value)} style={{...iS,width:"auto",flex:"0 1 130px",fontSize:13,color:filterRed?T.accent:T.textMd}}><option value="">Red</option>{REDES.map(r=><option key={r}>{r}</option>)}</select>
            <select value={filterNicho} onChange={e=>setFilterNicho(e.target.value)} style={{...iS,width:"auto",flex:"0 1 130px",fontSize:13,color:filterNicho?T.accent:T.textMd}}><option value="">Nicho</option>{NICHOS.map(n=><option key={n}>{n}</option>)}</select>
            <button onClick={()=>setFilterSoloPendientes(p=>!p)} style={{...BtnSecondary(T),fontSize:12,padding:"8px 12px",borderColor:filterSoloPendientes?T.orange:T.border,color:filterSoloPendientes?T.orange:T.textMd,background:filterSoloPendientes?T.orangeBg:T.card}}>⏳ Cont. pendiente</button>
            <span style={{fontSize:12,color:T.textSm,marginLeft:"auto"}}>{filtered.length} canjes</span>
          </>}
        </div>

        {/* LISTA */}
        {viewTab==="lista"&&<div style={{paddingBottom:48}}>
          {filtered.length===0?(
            <div style={{textAlign:"center",padding:"80px 20px"}}>
              <div style={{fontSize:48,marginBottom:16}}>🤝</div>
              <div style={{fontSize:18,fontWeight:600,color:T.textMd}}>{canjes.length===0?"Sin canjes todavía":"Sin resultados"}</div>
            </div>
          ):(
            <>
              <div style={{display:"grid",gridTemplateColumns:"1fr 90px 160px 190px 1fr 80px",gap:8,padding:"8px 16px",fontSize:12,color:T.textSm,fontWeight:600,textTransform:"uppercase",letterSpacing:0.6,borderBottom:`1px solid ${T.borderL}`}}>
                <span>Influencer</span><span>Red</span><span>Producto</span><span>Estado</span><span>Contenido</span><span>Fecha</span>
              </div>
              {filtered.map((c,ci)=>{
                const sc=getEstadoCC(T,c.estado);
                return (
                  <div key={c._docId} onClick={()=>setDetail(c._docId)}
                    style={{display:"grid",gridTemplateColumns:"1fr 90px 160px 190px 1fr 80px",gap:8,padding:"14px 16px",borderBottom:`1px solid ${T.borderL}`,cursor:"pointer",transition:"background 0.1s",alignItems:"center",borderLeft:`3px solid ${sc.dot}`,borderRadius:4}}
                    onMouseEnter={e=>e.currentTarget.style.background=T.card}
                    onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      {c.foto?<img src={c.foto} style={{width:32,height:32,borderRadius:"50%",objectFit:"cover",border:`1px solid ${T.border}`,flexShrink:0}} onError={e=>e.target.style.display="none"} alt=""/>:<div style={{width:32,height:32,borderRadius:"50%",background:T.surface,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,color:T.textSm,flexShrink:0}}>👤</div>}
                      <div>
                        <div style={{fontSize:14,fontWeight:700,color:T.text}}>{c.influencer}</div>
                        <div style={{display:"flex",gap:5,marginTop:2,alignItems:"center"}}>
                          {c.usuario&&<span style={{fontSize:12,color:T.accent}}>@{c.usuario}</span>}
                          {c.nicho&&<span style={{fontSize:10,background:T.purpleBg,color:T.purple,borderRadius:4,padding:"1px 6px",fontWeight:500}}>{c.nicho}</span>}
                        </div>
                      </div>
                    </div>
                    <span style={{fontSize:13,color:T.textMd}}>{c.red}</span>
                    <span style={{fontSize:13,color:T.textMd,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.producto||"—"}</span>
                    <Badge T={T} colors={sc}>{c.estado}</Badge>
                    <div style={{display:"flex",flexDirection:"column",gap:3}}>
                      {(()=>{
                        const cont=c.contenido||[];
                        const total=cont.reduce((s,x)=>s+(x.acordados||0),0);
                        const entregados=cont.reduce((s,x)=>s+(x.entregados||0),0);
                        if(total===0) return <span style={{fontSize:12,color:T.textSm}}>Sin acordar</span>;
                        const p=Math.round((entregados/total)*100);
                        return (
                          <>
                            <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:T.textSm,marginBottom:2}}>
                              <span>{entregados}/{total} contenidos</span>
                              <span style={{color:p===100?T.green:T.textSm,fontWeight:600}}>{p}%</span>
                            </div>
                            <div style={{height:5,background:T.borderL,borderRadius:20,overflow:"hidden",width:"100%"}}>
                              <div style={{height:"100%",width:`${p}%`,background:p===100?T.green:T.accentSolid,borderRadius:20}}/>
                            </div>
                          </>
                        );
                      })()}
                    </div>
                    <span style={{fontSize:12,color:T.textSm}}>{fmtTs(c.createdAt)}</span>
                  </div>
                );
              })}
            </>
          )}
        </div>}

        {/* KANBAN */}
        {viewTab==="kanban"&&(
          <div style={{paddingBottom:48,overflowX:"auto"}}>
            <div style={{display:"flex",gap:14,minWidth:900,paddingBottom:8}}>
              {ESTADOS_C.filter(e=>e!=="Cancelado").map(estado=>{
                const sc=getEstadoCC(T,estado);
                const cols=canjes.filter(c=>c.estado===estado);
                return (
                  <div key={estado} style={{flex:"0 0 200px",background:T.card,borderRadius:12,border:`1px solid ${T.border}`,overflow:"hidden"}}>
                    <div style={{padding:"12px 14px",borderBottom:`1px solid ${T.borderL}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <div style={{display:"flex",alignItems:"center",gap:7}}>
                        <span style={{width:8,height:8,borderRadius:"50%",background:sc.dot}}/>
                        <span style={{fontSize:12,fontWeight:700,color:sc.text}}>{estado}</span>
                      </div>
                      <span style={{fontSize:12,fontWeight:700,color:T.textSm,background:T.bg,borderRadius:20,padding:"2px 8px"}}>{cols.length}</span>
                    </div>
                    <div style={{padding:"8px",display:"flex",flexDirection:"column",gap:8,minHeight:100}}>
                      {cols.map(c=>(
                        <div key={c._docId} onClick={()=>setDetail(c._docId)}
                          style={{background:T.bg,border:`1px solid ${T.borderL}`,borderRadius:10,padding:"12px",cursor:"pointer",transition:"all 0.15s"}}
                          onMouseEnter={e=>{e.currentTarget.style.borderColor=sc.dot;e.currentTarget.style.transform="translateY(-1px)";}}
                          onMouseLeave={e=>{e.currentTarget.style.borderColor=T.borderL;e.currentTarget.style.transform="none";}}>
                          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                            {c.foto?<img src={c.foto} style={{width:28,height:28,borderRadius:"50%",objectFit:"cover",border:`1px solid ${T.border}`}} onError={e=>e.target.style.display="none"} alt=""/>:<div style={{width:28,height:28,borderRadius:"50%",background:T.surface,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,color:T.textSm}}>👤</div>}
                            <div>
                              <div style={{fontSize:12,fontWeight:700,color:T.text,lineHeight:1.2}}>{c.influencer}</div>
                              {c.usuario&&<div style={{fontSize:11,color:T.accent}}>@{c.usuario}</div>}
                            </div>
                          </div>
                          {c.nicho&&<span style={{fontSize:10,background:T.purpleBg,color:T.purple,borderRadius:4,padding:"2px 6px",fontWeight:500}}>{c.nicho}</span>}
                          {(()=>{
                            const cont=c.contenido||[];
                            const total=cont.reduce((s,x)=>s+(x.acordados||0),0);
                            const ent=cont.reduce((s,x)=>s+(x.entregados||0),0);
                            if(!total) return null;
                            const p=Math.round((ent/total)*100);
                            return <div style={{marginTop:8}}><div style={{height:4,background:T.borderL,borderRadius:20,overflow:"hidden"}}><div style={{height:"100%",width:`${p}%`,background:p===100?T.green:T.accentSolid,borderRadius:20}}/></div><div style={{fontSize:10,color:T.textSm,marginTop:3}}>{ent}/{total} contenidos</div></div>;
                          })()}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* RANKING */}
        {viewTab==="ranking"&&(
          <div style={{paddingBottom:48}}>
            {canjes.filter(c=>c.alcance||c.reproducciones).length===0?(
              <div style={{textAlign:"center",padding:"80px 20px"}}>
                <div style={{fontSize:48,marginBottom:16}}>🏆</div>
                <div style={{fontSize:18,fontWeight:600,color:T.textMd}}>Sin métricas cargadas todavía</div>
                <div style={{fontSize:14,color:T.textSm,marginTop:8}}>Editá los canjes y cargá alcance, reproducciones, likes y guardados para ver el ranking.</div>
              </div>
            ):(()=>{
              const ranked=[...canjes]
                .filter(c=>c.alcance||c.reproducciones||c.likes)
                .map(c=>({
                  ...c,
                  score: (Number(c.alcance||0)*1) + (Number(c.reproducciones||0)*0.8) + (Number(c.likes||0)*2) + (Number(c.guardados||0)*3),
                  totalContenido:(c.contenido||[]).reduce((s,x)=>s+(x.entregados||0),0),
                  totalAcordado:(c.contenido||[]).reduce((s,x)=>s+(x.acordados||0),0),
                }))
                .sort((a,b)=>b.score-a.score);
              const maxScore=ranked[0]?.score||1;
              return (
                <div style={{display:"flex",flexDirection:"column",gap:10,marginTop:8}}>
                  <div style={{fontSize:12,color:T.textSm,marginBottom:4,padding:"0 4px"}}>Ordenados por score combinado: alcance + reproducciones + likes + guardados</div>
                  {ranked.map((c,idx)=>{
                    const pct=Math.round((c.score/maxScore)*100);
                    const medal=["🥇","🥈","🥉"][idx]||`${idx+1}.`;
                    return (
                      <div key={c._docId} onClick={()=>setDetail(c._docId)}
                        style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"18px 20px",cursor:"pointer",transition:"all 0.15s"}}
                        onMouseEnter={e=>{e.currentTarget.style.borderColor=T.accent;e.currentTarget.style.transform="translateY(-1px)";}}
                        onMouseLeave={e=>{e.currentTarget.style.borderColor=T.border;e.currentTarget.style.transform="none";}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                          <div style={{display:"flex",alignItems:"center",gap:12}}>
                            <span style={{fontSize:22}}>{medal}</span>
                            <div>
                              <div style={{fontSize:16,fontWeight:700,color:T.text}}>{c.influencer}</div>
                              <div style={{fontSize:13,color:T.accent}}>@{c.usuario} · {c.red}</div>
                            </div>
                          </div>
                          <div style={{textAlign:"right"}}>
                            <div style={{fontSize:20,fontWeight:800,color:idx===0?T.yellow:T.text,letterSpacing:-0.5}}>{Math.round(c.score).toLocaleString('es-AR')}</div>
                            <div style={{fontSize:11,color:T.textSm}}>score</div>
                          </div>
                        </div>
                        {/* Barra de score */}
                        <div style={{height:6,background:T.borderL,borderRadius:20,overflow:"hidden",marginBottom:12}}>
                          <div style={{height:"100%",width:`${pct}%`,background:idx===0?T.yellow:idx===1?T.textSm:T.accentSolid,borderRadius:20}}/>
                        </div>
                        {/* Métricas */}
                        <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
                          {c.alcance&&<div style={{textAlign:"center"}}><div style={{fontSize:15,fontWeight:700,color:T.text}}>{Number(c.alcance).toLocaleString('es-AR')}</div><div style={{fontSize:11,color:T.textSm}}>Alcance</div></div>}
                          {c.reproducciones&&<div style={{textAlign:"center"}}><div style={{fontSize:15,fontWeight:700,color:T.text}}>{Number(c.reproducciones).toLocaleString('es-AR')}</div><div style={{fontSize:11,color:T.textSm}}>Repros.</div></div>}
                          {c.likes&&<div style={{textAlign:"center"}}><div style={{fontSize:15,fontWeight:700,color:T.text}}>{Number(c.likes).toLocaleString('es-AR')}</div><div style={{fontSize:11,color:T.textSm}}>Likes</div></div>}
                          {c.guardados&&<div style={{textAlign:"center"}}><div style={{fontSize:15,fontWeight:700,color:T.text}}>{Number(c.guardados).toLocaleString('es-AR')}</div><div style={{fontSize:11,color:T.textSm}}>Guardados</div></div>}
                          {c.seguidores&&c.alcance&&<div style={{textAlign:"center"}}><div style={{fontSize:15,fontWeight:700,color:T.green}}>{((Number(c.alcance)/Number(c.seguidores))*100).toFixed(1)}%</div><div style={{fontSize:11,color:T.textSm}}>Tasa alcance</div></div>}
                          {c.totalAcordado>0&&<div style={{textAlign:"center"}}><div style={{fontSize:15,fontWeight:700,color:c.totalContenido===c.totalAcordado?T.green:T.orange}}>{c.totalContenido}/{c.totalAcordado}</div><div style={{fontSize:11,color:T.textSm}}>Contenidos</div></div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {/* Canje Form Modal */}
      <Modal T={T} open={!!form} onClose={()=>setForm(null)} title={form?._docId?"Editar Canje":"Nuevo Canje"} width={600}>
        {form&&(
          <div>
            {/* Datos básicos */}
            <div style={{display:"grid",gridTemplateColumns:"60px 1fr 1fr",gap:"0 14px",alignItems:"start"}}>
              <Field T={T} label="Foto">
                <div style={{width:52,height:52,borderRadius:10,border:`1.5px solid ${T.inputBorder}`,overflow:"hidden",background:T.bg,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>{const url=prompt("URL de la foto de perfil:");if(url)setForm(f=>({...f,foto:url}));}}>
                  {form.foto?<img src={form.foto} style={{width:"100%",height:"100%",objectFit:"cover"}} onError={e=>e.target.style.display="none"} alt=""/>:<span style={{fontSize:22,color:T.textSm}}>👤</span>}
                </div>
              </Field>
              <Field T={T} label="Nombre" required><input style={iS} value={form.influencer} onChange={e=>setForm(f=>({...f,influencer:e.target.value}))} placeholder="Nombre del influencer"/></Field>
              <Field T={T} label="Usuario (@)"><input style={iS} value={form.usuario} onChange={e=>setForm(f=>({...f,usuario:e.target.value}))} placeholder="@usuario"/></Field>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:"0 14px"}}>
              <Field T={T} label="Red social"><select style={iS} value={form.red} onChange={e=>setForm(f=>({...f,red:e.target.value}))}>{REDES.map(r=><option key={r}>{r}</option>)}</select></Field>
              <Field T={T} label="Nicho"><select style={iS} value={form.nicho||""} onChange={e=>setForm(f=>({...f,nicho:e.target.value}))}><option value="">—</option>{NICHOS.map(n=><option key={n}>{n}</option>)}</select></Field>
              <Field T={T} label="Seguidores"><input style={iS} type="number" value={form.seguidores} onChange={e=>setForm(f=>({...f,seguidores:e.target.value}))} placeholder="50000"/></Field>
              <Field T={T} label="Producto"><select style={iS} value={form.producto} onChange={e=>setForm(f=>({...f,producto:e.target.value}))}><option value="">—</option>{PRODUCTOS_CANJE.map(p=><option key={p}>{p}</option>)}</select></Field>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 14px"}}>
              <Field T={T} label="Email"><input style={iS} type="email" value={form.email} onChange={e=>setForm(f=>({...f,email:e.target.value}))} placeholder="email@ejemplo.com"/></Field>
              <Field T={T} label="Teléfono / WhatsApp"><input style={iS} value={form.telefono} onChange={e=>setForm(f=>({...f,telefono:e.target.value}))} placeholder="+54 11..."/></Field>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 14px"}}>
              <Field T={T} label="Fecha de envío"><input style={iS} type="date" value={form.fechaEnvio} onChange={e=>setForm(f=>({...f,fechaEnvio:e.target.value}))}/></Field>
              <Field T={T} label="Tracking Andreani"><input style={iS} value={form.tracking} onChange={e=>setForm(f=>({...f,tracking:e.target.value}))} placeholder="Código de seguimiento"/></Field>
            </div>

            {/* Contenido comprometido */}
            <Field T={T} label="Contenido comprometido">
              <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,overflow:"hidden"}}>
                <div style={{display:"grid",gridTemplateColumns:"1fr 80px 80px",gap:0,padding:"8px 14px",fontSize:11,color:T.textSm,fontWeight:600,textTransform:"uppercase",letterSpacing:0.5,borderBottom:`1px solid ${T.borderL}`}}>
                  <span>Tipo</span><span style={{textAlign:"center"}}>Acordados</span><span style={{textAlign:"center"}}>Entregados</span>
                </div>
                {(form.contenido||ACTIVIDADES.map(tipo=>({tipo,acordados:0,entregados:0}))).map((item,i)=>(
                  <div key={item.tipo} style={{display:"grid",gridTemplateColumns:"1fr 80px 80px",alignItems:"center",padding:"8px 14px",borderBottom:i<ACTIVIDADES.length-1?`1px solid ${T.borderL}`:"none"}}>
                    <span style={{fontSize:13,fontWeight:500,color:T.text}}>{item.tipo}</span>
                    <input type="number" min={0} value={item.acordados} onChange={e=>{const arr=[...form.contenido];arr[i]={...arr[i],acordados:parseInt(e.target.value)||0};setForm(f=>({...f,contenido:arr}));}} style={{...iS,textAlign:"center",padding:"6px 4px",fontSize:13,width:"60px",margin:"0 auto"}}/>
                    <input type="number" min={0} value={item.entregados} onChange={e=>{const arr=[...form.contenido];arr[i]={...arr[i],entregados:parseInt(e.target.value)||0};setForm(f=>({...f,contenido:arr}));}} style={{...iS,textAlign:"center",padding:"6px 4px",fontSize:13,width:"60px",margin:"0 auto"}}/>
                  </div>
                ))}
              </div>
            </Field>

            {form._docId&&(
              <>
                <Field T={T} label="Estado">
                  <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
                    {ESTADOS_C.map(e=>{const c=getEstadoCC(T,e);const sel=form.estado===e;return <button key={e} onClick={()=>setForm(f=>({...f,estado:e}))} style={{display:"flex",alignItems:"center",gap:7,padding:"8px 14px",borderRadius:8,fontSize:13,fontWeight:sel?600:400,background:sel?c.bg:T.card,color:sel?c.text:T.textMd,border:`1.5px solid ${sel?c.dot:T.border}`,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",transition:"all 0.15s"}}><span style={{width:7,height:7,borderRadius:"50%",background:sel?c.dot:T.textSm}}/>{e}</button>;})}
                  </div>
                </Field>
                <Field T={T} label="Link del contenido publicado"><input style={iS} value={form.linkContenido} onChange={e=>setForm(f=>({...f,linkContenido:e.target.value}))} placeholder="https://instagram.com/p/..."/></Field>
                <Field T={T} label="Fecha de publicación"><input style={iS} type="date" value={form.fechaPublicacion} onChange={e=>setForm(f=>({...f,fechaPublicacion:e.target.value}))}/></Field>

                {/* Métricas */}
                <div style={{fontSize:12,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:8,marginTop:4}}>Métricas del contenido</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 14px"}}>
                  <Field T={T} label="Alcance"><input style={iS} type="number" value={form.alcance} onChange={e=>setForm(f=>({...f,alcance:e.target.value}))} placeholder="0"/></Field>
                  <Field T={T} label="Reproducciones"><input style={iS} type="number" value={form.reproducciones} onChange={e=>setForm(f=>({...f,reproducciones:e.target.value}))} placeholder="0"/></Field>
                  <Field T={T} label="Likes"><input style={iS} type="number" value={form.likes} onChange={e=>setForm(f=>({...f,likes:e.target.value}))} placeholder="0"/></Field>
                  <Field T={T} label="Guardados"><input style={iS} type="number" value={form.guardados} onChange={e=>setForm(f=>({...f,guardados:e.target.value}))} placeholder="0"/></Field>
                </div>

                {/* Recordatorio */}
                <Field T={T} label="Recordatorio de seguimiento"><input style={iS} type="date" value={form.recordatorio} onChange={e=>setForm(f=>({...f,recordatorio:e.target.value}))}/></Field>
              </>
            )}
            <Field T={T} label="Notas"><textarea style={{...iS,minHeight:60,resize:"vertical"}} value={form.notas} onChange={e=>setForm(f=>({...f,notas:e.target.value}))} placeholder="Notas sobre el canje..."/></Field>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:10}}>
              <button onClick={()=>setForm(null)} style={BtnSecondary(T)}>Cancelar</button>
              <AsyncButton onClick={saveCanje} disabled={!form.influencer} style={{...BtnPrimary(T)}}>{form._docId?"Guardar":"Crear Canje"}</AsyncButton>
            </div>
          </div>
        )}
      </Modal>

      {/* Canje Detail Modal */}
      <Modal T={T} open={!!detailC} onClose={()=>setDetail(null)} title={detailC?`${detailC.influencer}`:""} width={560}>
        {detailC&&(()=>{
          const c=canjes.find(x=>x._docId===detailC._docId)||detailC; const sc=getEstadoCC(T,c.estado);
          const totalAcordados=(c.contenido||[]).reduce((s,x)=>s+(x.acordados||0),0);
          const totalEntregados=(c.contenido||[]).reduce((s,x)=>s+(x.entregados||0),0);
          const progreso=totalAcordados>0?Math.round((totalEntregados/totalAcordados)*100):0;
          const hoy=new Date().toISOString().split('T')[0];
          const recordatorioVencido=c.recordatorio&&c.recordatorio<=hoy;
          return (
            <div>
              {/* Status banner */}
              <div style={{background:sc.bg,border:`1px solid ${sc.dot}44`,borderRadius:12,padding:"14px 18px",marginBottom:16,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}><span style={{width:12,height:12,borderRadius:"50%",background:sc.dot,boxShadow:`0 0 8px ${sc.dot}`}}/><span style={{fontSize:16,fontWeight:700,color:sc.text}}>{c.estado}</span></div>
                <span style={{fontSize:12,color:T.textMd,fontWeight:500}}>{c.red}</span>
              </div>

              {/* Recordatorio vencido */}
              {recordatorioVencido&&(
                <div style={{background:T.yellowBg,border:`1px solid ${T.yellow}44`,borderRadius:10,padding:"10px 14px",marginBottom:14,display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:16}}>⏰</span>
                  <span style={{fontSize:13,fontWeight:600,color:T.yellow}}>Recordatorio de seguimiento: {c.recordatorio}</span>
                </div>
              )}

              {/* Info principal con acciones rápidas */}
              <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:12,padding:"16px 18px",marginBottom:14}}>
                <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:10}}>
                  {c.foto?<img src={c.foto} style={{width:48,height:48,borderRadius:12,objectFit:"cover",border:`1px solid ${T.border}`,flexShrink:0}} onError={e=>e.target.style.display="none"} alt=""/>:<div style={{width:48,height:48,borderRadius:12,background:T.surface,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0}}>👤</div>}
                  <div>
                    <div style={{fontSize:20,fontWeight:800,color:T.text}}>{c.influencer}</div>
                    <div style={{display:"flex",gap:8,marginTop:3,flexWrap:"wrap",alignItems:"center"}}>
                      {c.nicho&&<span style={{fontSize:11,background:T.purpleBg,color:T.purple,borderRadius:4,padding:"2px 8px",fontWeight:600}}>{c.nicho}</span>}
                      {c.seguidores&&<span style={{fontSize:12,color:T.textSm}}>👥 {Number(c.seguidores).toLocaleString()}</span>}
                      {c.email&&<span style={{fontSize:12,color:T.textSm}}>✉️ {c.email}</span>}
                    </div>
                  </div>
                </div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
                  {c.usuario&&(
                    <a href={`https://${c.red.toLowerCase().includes('tiktok')?'tiktok.com/@':'instagram.com/'}${c.usuario.replace('@','')}`}
                      target="_blank" rel="noopener noreferrer"
                      style={{display:"inline-flex",alignItems:"center",gap:5,fontSize:13,color:T.accent,textDecoration:"none",background:T.accentSolid+"18",border:`1px solid ${T.accentSolid}33`,borderRadius:8,padding:"5px 12px",fontWeight:500}}>
                      {c.red.toLowerCase().includes('tiktok')?'🎵':'📸'} @{c.usuario.replace('@','')}
                    </a>
                  )}
                  {c.telefono&&(
                    <a href={`https://wa.me/${c.telefono.replace(/\D/g,'')}`}
                      target="_blank" rel="noopener noreferrer"
                      style={{display:"inline-flex",alignItems:"center",gap:5,fontSize:13,color:T.green,textDecoration:"none",background:T.greenBg,border:`1px solid ${T.green}33`,borderRadius:8,padding:"5px 12px",fontWeight:500}}>
                      💬 WhatsApp
                    </a>
                  )}
                  {c.tracking&&(
                    <a href={`https://www.andreani.com/#!/informacionEnvio/${c.tracking}`}
                      target="_blank" rel="noopener noreferrer"
                      style={{display:"inline-flex",alignItems:"center",gap:5,fontSize:13,color:T.purple,textDecoration:"none",background:T.purpleBg,border:`1px solid ${T.purple}33`,borderRadius:8,padding:"5px 12px",fontWeight:500}}>
                      📦 Seguimiento
                    </a>
                  )}
                  {c.linkContenido&&(
                    <a href={c.linkContenido} target="_blank" rel="noopener noreferrer"
                      style={{display:"inline-flex",alignItems:"center",gap:5,fontSize:13,color:T.orange,textDecoration:"none",background:T.orangeBg,border:`1px solid ${T.orange}33`,borderRadius:8,padding:"5px 12px",fontWeight:500}}>
                      🎬 Ver contenido
                    </a>
                  )}
                  {c.producto&&<span style={{fontSize:12,color:T.textSm,marginLeft:4}}>📦 {c.producto}</span>}
                </div>
              </div>

              {/* Productos del canje */}
              <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:12,padding:"14px 18px",marginBottom:14}}>
                <div style={{fontSize:12,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:10}}>Productos enviados</div>
                {(c.productosCanje||[]).map((p,pi)=>(
                  <div key={pi} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 0",borderBottom:`1px solid ${T.borderL}`}}>
                    <span style={{flex:1,fontSize:13,color:T.text,fontWeight:500}}>{p.nombre}</span>
                    <button onClick={async()=>{const upd=(c.productosCanje||[]).map((x,j)=>j===pi?{...x,cantidad:Math.max(1,(x.cantidad||1)-1)}:x);await updateDoc(doc(db,"canjes",c._docId),{productosCanje:upd,updatedAt:serverTimestamp()});}} style={{width:22,height:22,border:`1px solid ${T.border}`,borderRadius:4,background:T.surface,color:T.text,cursor:"pointer",fontSize:13,display:"flex",alignItems:"center",justifyContent:"center"}}>−</button>
                    <span style={{fontSize:13,fontWeight:600,color:T.text,minWidth:24,textAlign:"center"}}>{p.cantidad}</span>
                    <button onClick={async()=>{const upd=(c.productosCanje||[]).map((x,j)=>j===pi?{...x,cantidad:(x.cantidad||1)+1}:x);await updateDoc(doc(db,"canjes",c._docId),{productosCanje:upd,updatedAt:serverTimestamp()});}} style={{width:22,height:22,border:`1px solid ${T.border}`,borderRadius:4,background:T.surface,color:T.text,cursor:"pointer",fontSize:13,display:"flex",alignItems:"center",justifyContent:"center"}}>+</button>
                    <button onClick={async()=>{const upd=(c.productosCanje||[]).filter((_,j)=>j!==pi);await updateDoc(doc(db,"canjes",c._docId),{productosCanje:upd,updatedAt:serverTimestamp()});}} style={{width:22,height:22,border:`1px solid ${T.red}44`,borderRadius:4,background:T.redBg,color:T.red,cursor:"pointer",fontSize:11,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
                  </div>
                ))}
                {(c.productosCanje||[]).length===0&&<div style={{fontSize:13,color:T.textSm,padding:"6px 0"}}>Sin productos cargados</div>}
                <select defaultValue="" onChange={async e=>{const val=e.target.value;if(!val)return;e.target.value="";const lista=c.productosCanje||[];const ex=lista.findIndex(x=>x.nombre===val);const upd=ex>=0?lista.map((x,i)=>i===ex?{...x,cantidad:(x.cantidad||1)+1}:x):[...lista,{nombre:val,cantidad:1}];await updateDoc(doc(db,"canjes",c._docId),{productosCanje:upd,updatedAt:serverTimestamp()});}} style={{...iS,fontSize:12,color:T.textSm,marginTop:8}}>
                  <option value="">+ Agregar producto...</option>
                  {PRODUCTOS_CANJE.map(pr=><option key={pr} value={pr}>{pr}</option>)}
                </select>
              </div>

              {/* Progreso de contenido */}
              {totalAcordados>0&&(
                <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:12,padding:"14px 18px",marginBottom:14}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                    <div style={{fontSize:12,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5}}>Progreso de contenido</div>
                    <span style={{fontSize:13,fontWeight:700,color:progreso===100?T.green:T.textMd}}>{totalEntregados}/{totalAcordados} · {progreso}%</span>
                  </div>
                  {/* Barra de progreso */}
                  <div style={{height:8,background:T.borderL,borderRadius:20,overflow:"hidden",marginBottom:12}}>
                    <div style={{height:"100%",width:`${progreso}%`,background:progreso===100?T.green:T.accentSolid,borderRadius:20,transition:"width 0.5s ease"}}/>
                  </div>
                  {/* Tabla por tipo */}
                  {(c.contenido||[]).filter(item=>item.acordados>0).map((item,i)=>{
                    const p=item.acordados>0?Math.round((item.entregados/item.acordados)*100):0;
                    return (
                      <div key={item.tipo} style={{display:"flex",alignItems:"center",gap:10,padding:"5px 0",borderTop:i>0?`1px solid ${T.borderL}`:"none"}}>
                        <span style={{fontSize:13,color:T.text,fontWeight:500,minWidth:100}}>{item.tipo}</span>
                        <div style={{flex:1,height:5,background:T.borderL,borderRadius:20,overflow:"hidden"}}>
                          <div style={{height:"100%",width:`${p}%`,background:p===100?T.green:T.accent,borderRadius:20}}/>
                        </div>
                        <span style={{fontSize:12,color:p===100?T.green:T.textSm,fontWeight:600,minWidth:50,textAlign:"right"}}>{item.entregados}/{item.acordados}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Métricas */}
              {(c.alcance||c.reproducciones||c.likes||c.guardados)&&(
                <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:12,padding:"14px 18px",marginBottom:14}}>
                  <div style={{fontSize:12,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:12}}>Métricas</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    {[["👁️ Alcance",c.alcance],["▶️ Repros.",c.reproducciones],["❤️ Likes",c.likes],["🔖 Guardados",c.guardados]].map(([l,v])=>v?(
                      <div key={l} style={{background:T.surface,borderRadius:8,padding:"10px 12px",border:`1px solid ${T.borderL}`}}>
                        <div style={{fontSize:11,color:T.textSm,marginBottom:3}}>{l}</div>
                        <div style={{fontSize:18,fontWeight:700,color:T.text,letterSpacing:-0.5}}>{Number(v).toLocaleString('es-AR')}</div>
                      </div>
                    ):null)}
                  </div>
                  {c.alcance&&c.seguidores&&(
                    <div style={{marginTop:10,fontSize:12,color:T.textSm,padding:"8px 10px",background:T.surface,borderRadius:8,border:`1px solid ${T.borderL}`}}>
                      📊 Tasa de alcance: <span style={{fontWeight:600,color:T.text}}>{((Number(c.alcance)/Number(c.seguidores))*100).toFixed(1)}%</span>
                    </div>
                  )}
                </div>
              )}

              {/* Info adicional */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"6px 20px",fontSize:13,marginBottom:14}}>
                {[["Fecha envío",c.fechaEnvio],["Fecha publicación",c.fechaPublicacion],["Recordatorio",c.recordatorio]].map(([l,v])=>v?(
                  <div key={l} style={{display:"flex",gap:8,padding:"5px 0",borderBottom:`1px solid ${T.borderL}`}}>
                    <span style={{color:T.textSm,minWidth:110,flexShrink:0,fontSize:12}}>{l}</span>
                    <span style={{fontSize:12,fontWeight:500,color:recordatorioVencido&&l==="Recordatorio"?T.yellow:T.text}}>{v}</span>
                  </div>
                ):null)}
              </div>

              {c.notas&&<div style={{background:T.yellowBg,border:`1px solid ${T.yellow}33`,borderRadius:12,padding:14,marginBottom:12}}><div style={{fontSize:11,textTransform:"uppercase",color:T.yellow,fontWeight:700,marginBottom:5}}>Notas</div><div style={{fontSize:14,lineHeight:1.6,color:T.text}}>{c.notas}</div></div>}

              {/* Historial de notas rápidas */}
              <NotasRapidas T={T} canje={c} onAdd={addNota}/>

              <div style={{fontSize:12,color:T.textSm}}>Creado: {fmtTs(c.createdAt)}{c.finalizadoAt?.seconds?` · Finalizado: ${fmtTs(c.finalizadoAt)}`:''}</div>
              <Divider T={T}/>
              <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
                {deleteConfirm===c._docId?(
                  <div style={{display:"flex",gap:8,alignItems:"center"}}><span style={{fontSize:14,color:T.red,fontWeight:500}}>¿Eliminar?</span><button onClick={()=>deleteCanje(c._docId)} style={{...BtnDanger(T),padding:"8px 16px",fontSize:13}}>Sí</button><button onClick={()=>setDeleteConfirm(null)} style={{...BtnSecondary(T),padding:"8px 16px",fontSize:13}}>No</button></div>
                ):(
                  <><button onClick={()=>setDeleteConfirm(c._docId)} style={{...BtnDanger(T),fontSize:13}}>Eliminar</button><button onClick={()=>{setDetail(null);setForm({...c,contenido:c.contenido||ACTIVIDADES.map(tipo=>({tipo,acordados:0,entregados:0})),alcance:c.alcance||"",reproducciones:c.reproducciones||"",likes:c.likes||"",guardados:c.guardados||"",historial:c.historial||[],recordatorio:c.recordatorio||""});}} style={{...BtnSecondary(T),fontSize:13}}>Editar</button></>
                )}
              </div>
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}

// ═══════════════════════════════════════════
// APP ENVIOS
// ═══════════════════════════════════════════
function AppEnvios({T, orders, ordersStatus, fetchOrders, user, onHome, onGenerarCanje}) {
  const [tab,setTab]=useState("panel");
  const [selected,setSelected]=useState(new Set());
  const [exportModal,setExportModal]=useState(false);
  const [exporting,setExporting]=useState(false);
  const [exportCfg,setExportCfg]=useState(()=>{
    try {
      const saved=localStorage.getItem("growith_exportCfg");
      if(saved) return {...{peso:"200",alto:"5",ancho:"5",prof:"5",valor:"6000",separar:false},...JSON.parse(saved)};
    } catch(e) {}
    return {peso:"200",alto:"5",ancho:"5",prof:"5",valor:"6000",separar:false};
  });
  // Guardar config cuando cambia
  useEffect(()=>{ try{localStorage.setItem("growith_exportCfg",JSON.stringify(exportCfg));}catch(e){} },[exportCfg]);
  const [tabEnvio,setTabEnvio]=useState("empaquetar");
  const [searchEnvios,setSearchEnvios]=useState("");
  const [searchLibre,setSearchLibre]=useState(false);
  const [locationModal,setLocationModal]=useState(null);
  const [locSearch,setLocSearch]=useState("");
  const [locSearchType,setLocSearchType]=useState("ciudad");
  const [sucursalConfirmed,setSucursalConfirmed]=useState(null);
  const [copiedToast,setCopiedToast]=useState(null);
  const [orderDetail,setOrderDetail]=useState(null);
  const [skuGenerating,setSkuGenerating]=useState(false);
  const [skuProgress,setSkuProgress]=useState(0);
  function copyToClipboard(text, label) {
    navigator.clipboard.writeText(text).then(()=>{
      setCopiedToast(label||"Copiado");
      setTimeout(()=>setCopiedToast(null), 1500);
    }).catch(()=>{});
  }
  const [tabCounts,setTabCounts]=useState({cobrar:null,empaquetar:null,enviar:null});
  const [filterTipoEnvio,setFilterTipoEnvio]=useState("todos");
  const [tabOrders,setTabOrders]=useState([]);
  const [tabLoading,setTabLoading]=useState(false);
  const tabCacheRef=useRef({});
  const [buscarQuery,setBuscarQuery]=useState("");
  const [buscarLoading,setBuscarLoading]=useState(false);
  const [compactMode,setCompactMode]=useState(false);
  const [hiddenCols,setHiddenCols]=useState(new Set());
  const [showColMenu,setShowColMenu]=useState(false);
  function toggleCol(col){setHiddenCols(s=>{const n=new Set(s);n.has(col)?n.delete(col):n.add(col);return n;});}
  // SKU tab
  const [skuFile,setSkuFile]=useState(null);
  const [skuPending,setSkuPending]=useState(false); // file selected, waiting confirm
  const [skuResults,setSkuResults]=useState([]);
  const [skuProcessing,setSkuProcessing]=useState(false);
  // Seguimientos tab
  const [pdfFile,setPdfFile]=useState(null);
  const [pdfPending,setPdfPending]=useState(false);
  const [pdfResults,setPdfResults]=useState([]);
  const [pdfProcessing,setPdfProcessing]=useState(false);
  const [sendingTracking,setSendingTracking]=useState({});
  const [trackingSent,setTrackingSent]=useState({});
  const iS=InputStyle(T);

  // Pedidos exportables — usar tabOrders (local) no orders (global)
  const exportables=useMemo(()=>{
    let base=tabOrders;
    if(filterTipoEnvio==="domicilio") base=base.filter(o=>!isSucursalOrder(o));
    if(filterTipoEnvio==="sucursal") base=base.filter(o=>isSucursalOrder(o));
    if(searchEnvios){
      const s=searchEnvios.toLowerCase();
      return base.filter(o=>o.numero.includes(s)||o.comprador.toLowerCase().includes(s)||o.email.toLowerCase().includes(s));
    }
    return base;
  },[tabOrders,searchEnvios,filterTipoEnvio]);

  // Fetch contadores de los 3 tabs activos en paralelo
  async function fetchTabCounts(uid) {
    const tabs=["cobrar","empaquetar","enviar"];
    const results = await Promise.all(
      tabs.map(tab=>
        fetch(`/api/orders?uid=${uid}&tab=${tab}&countOnly=true`)
          .then(r=>r.json())
          .then(d=>Array.isArray(d)?d.length:0)
          .catch(()=>0)
      )
    );
    setTabCounts({cobrar:results[0],empaquetar:results[1],enviar:results[2]});
  }

  const counts=tabCounts;

  const lastSelectedRef=useRef(null);
  function toggleSelect(num,e){
    if(e?.shiftKey&&lastSelectedRef.current){
      const nums=exportables.map(o=>o.numero);
      const a=nums.indexOf(lastSelectedRef.current),b=nums.indexOf(num);
      if(a>=0&&b>=0){
        const [from,to]=[Math.min(a,b),Math.max(a,b)];
        setSelected(s=>{const n=new Set(s);nums.slice(from,to+1).forEach(x=>n.add(x));return n;});
        return;
      }
    }
    lastSelectedRef.current=num;
    setSelected(prev=>{const n=new Set(prev);n.has(num)?n.delete(num):n.add(num);return n;});
  }
  function toggleAll(){if(selected.size===exportables.length)setSelected(new Set());else setSelected(new Set(exportables.map(o=>o.numero)));}

  // Andreani locations cache — lee del template xlsx directamente
  const andreaniLocsRef=_andreaniLocsCache;
  async function loadAndreaniLocations() {
    if(andreaniLocsRef.current) return andreaniLocsRef.current;
    const res=await fetch('/andreani_template.xlsx');
    if(!res.ok) throw new Error("No se pudo cargar el template de Andreani");
    const buf=await res.arrayBuffer();
    if(!window.JSZip){await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';s.onload=resolve;s.onerror=reject;document.head.appendChild(s);});}
    const zip=await window.JSZip.loadAsync(buf);
    const ssXml=await zip.file('xl/sharedStrings.xml').async('string');
    const strings=[];
    const rx=/<t[^>]*>([\s\S]*?)<\/t>/g;
    let m;while((m=rx.exec(ssXml))!==null)strings.push(m[1]);

    // Localidades domicilio: PROVINCIA / LOCALIDAD / CP
    const locPattern=/^[A-ZÁÉÍÓÚÑÜ\s]+ \/ [A-ZÁÉÍÓÚÑÜ\s0-9]+ \/ \d+$/;
    const list=strings.filter(s=>locPattern.test(s.trim()));
    const cpIndex={};
    list.forEach(loc=>{
      const parts=loc.split(' / ');
      if(parts.length===3){const cp=parts[2].trim();if(!cpIndex[cp])cpIndex[cp]=[];cpIndex[cp].push(loc);}
    });
    const provIndex={};
    list.forEach(loc=>{
      const prov=loc.split(' / ')[0].trim();
      if(!provIndex[prov])provIndex[prov]=[];
      provIndex[prov].push(loc);
    });

    // Sucursales: leer col A de sheet4 (Configuracion!A2:A2552)
    const sheet4Xml=await zip.file('xl/worksheets/sheet4.xml').async('string');
    const aCells=[...sheet4Xml.matchAll(/<c r="A(\d+)"[^>]*t="s"[^>]*><v>(\d+)<\/v>/g)];
    const sucursales=aCells
      .map(([,row,idx])=>strings[parseInt(idx)]||"")
      .filter(s=>s.trim()&&s!=="Sucursal");

    // Índice de sucursales para búsqueda rápida
    andreaniLocsRef.current={list,cpIndex,provIndex,sucursales};
    return andreaniLocsRef.current;
  }
  function findAndreaniLocation(locs,cp,provincia,localidad) {
    const cpStr=String(cp||"").trim();
    const provU=(provincia||"").toUpperCase().trim()
      .replace(/^CIUDAD AUTONOMA.*/,"CAPITAL FEDERAL")
      .replace(/^CABA$/,"CAPITAL FEDERAL");
    const locU=(localidad||"").toUpperCase().trim();

    // 1. CP exacto + localidad
    const byCp=locs.cpIndex[cpStr]||[];
    if(byCp.length===1) return byCp[0];
    if(byCp.length>1){
      const byLoc=byCp.find(l=>l.toUpperCase().includes(locU)&&locU.length>2);
      if(byLoc) return byLoc;
      const byProv=byCp.find(l=>l.startsWith(provU));
      if(byProv) return byProv;
      return byCp[0];
    }

    // 2. Provincia + localidad
    const provList=locs.provIndex[provU]||[];
    if(provList.length>0){
      const byLoc=provList.find(l=>l.toUpperCase().includes(locU)&&locU.length>2);
      if(byLoc) return byLoc;
    }

    // 3. No encontrado — retornar null para mostrar modal
    return null;
  }

  function searchAndreaniLocations(locs, query, type) {
    if(!query||query.length<2) return [];
    const q=query.toUpperCase().trim();
    if(type==="cp") return (locs.cpIndex[q]||[]).slice(0,20);
    if(type==="ciudad") return locs.list.filter(l=>l.toUpperCase().includes(q)).slice(0,20);
    if(type==="calle") return locs.list.filter(l=>l.toUpperCase().includes(q)).slice(0,20);
    return [];
  }

  function findAndreaniSucursal(locs, direccion, pickupDetails) {
    if(!locs.sucursales) return null;

    function cl(s){ return (s||"").toUpperCase().replace(/[^A-Z0-9\s]/g,' ').replace(/\s+/g,' ').trim(); }
    function firstNum(s){ const m=String(s||"").match(/(\d+)/); return m?m[1]:""; }

    if(!pickupDetails) return null;

    const nombre=cl(pickupDetails.name);
    const calle=cl(pickupDetails.address?.address);
    const numero=firstNum(pickupDetails.address?.number);
    const localidad=cl(pickupDetails.address?.locality);
    const esHop=nombre.includes("HOP");
    const sucs=locs.sucursales;

    // ESTRATEGIA 1: PUNTO ANDREANI HOP
    // Usa cl() existente para normalizar (elimina chars no ASCII incluyendo tildes)
    if(esHop){
      const calleN=cl(pickupDetails.address?.address||"");
      if(calleN&&numero){
        // Buscar match normalizando tildes en ambos lados via cl()
        const exactMatch=sucs.find(s=>{
          const sn=cl(s);
          return sn.includes(calleN)&&(sn.endsWith(" "+numero)||sn.includes(" "+numero+" ")||sn===calleN+" "+numero);
        });
        if(exactMatch) return exactMatch;
        // Buscar por palabras de calle + numero
        const words=calleN.split(" ").filter(w=>w.length>=4);
        for(const w of words){
          const wm=sucs.find(s=>cl(s).includes(w)&&cl(s).includes(numero));
          if(wm) return wm;
        }
      }
      return null;
    }

    // ESTRATEGIA 2: Para SUCURSAL ANDREANI, buscar por localidad+calle
    // Las sucursales clásicas tienen nombres propios que no podemos construir
    if(!esHop){
      // Calle + número
      if(calle&&numero){
        const m=sucs.find(s=>{const su=cl(s);return su.includes(calle)&&su.includes(numero);});
        if(m) return m;
      }
      // Localidad sola
      if(localidad){
        const locWords=localidad.split(' ').filter(w=>w.length>=3);
        for(const lw of locWords){
          const matches=sucs.filter(s=>cl(s).includes(lw)&&!cl(s).includes('HOP'));
          if(matches.length===1) return matches[0];
          if(matches.length>1&&calle){
            const calWords=calle.split(' ').filter(w=>w.length>=3);
            for(const cw of calWords){
              const wc=matches.find(s=>cl(s).includes(cw));
              if(wc) return wc;
            }
          }
        }
      }
      // Palabras de calle
      if(calle){
        const words=calle.split(' ').filter(w=>w.length>=4);
        for(const w of words){
          const matches=sucs.filter(s=>cl(s).includes(w)&&!cl(s).includes('HOP'));
          if(matches.length===1) return matches[0];
        }
      }
    }

    // 4. Número único en lista
    if(numero&&numero.length>=3){
      const byNum=sucs.filter(s=>cl(s).split(' ').includes(numero));
      if(byNum.length===1) return byNum[0];
    }

    return null; // Mostrar modal solo para SUCURSAL ANDREANI sin match
  }

  function searchSucursales(locs, query) {
    if(!query||query.length<2||!locs.sucursales) return [];
    const q=query.toUpperCase().trim();
    return locs.sucursales.filter(s=>s.toUpperCase().includes(q)).slice(0,25);
  }
  async function generateAndreaniXlsx(ordersData,locs,cfgOverride) {
    if(!window.JSZip){await new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';s.onload=res;s.onerror=rej;document.head.appendChild(s);});}
    const tRes=await fetch('/andreani_template.xlsx?v='+Date.now());
    if(!tRes.ok) throw new Error("No se pudo cargar el template. Verificá que andreani_template.xlsx esté en public/");
    const tBuf=await tRes.arrayBuffer();
    const zip=await window.JSZip.loadAsync(tBuf);
    const ssXml=await zip.file('xl/sharedStrings.xml').async('string');
    const existSS=[];
    const ssRx=/<t[^>]*>([\s\S]*?)<\/t>/g;
    let mx;while((mx=ssRx.exec(ssXml))!==null)existSS.push(mx[1]);
    const ssMap=new Map();existSS.forEach((s,i)=>ssMap.set(s,i));
    const newSS=[...existSS];
    function idx(s){const k=String(s==null?"":s);if(ssMap.has(k))return ssMap.get(k);const i=newSS.length;newSS.push(k);ssMap.set(k,i);return i;}
    function sC(ref,val){return '<c r="'+ref+'" t="s"><v>'+idx(val)+'</v></c>';}
    function nC(ref,val){return (val===''||val===null||val===undefined)?sC(ref,''):'<c r="'+ref+'"><v>'+val+'</v></c>';}
    const cfg=cfgOverride||exportCfg;
    let rowsXml='';
    // Clean invalid chars for Andreani (-, /, etc → space)
    function cleanField(s){return String(s||"").replace(/["']/g,"").replace(/[-\/\\|#*]+/g,' ').replace(/\s{2,}/g,' ').trim();}
    function cleanAndreani(s){return cleanField(s).normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^\x00-\x7F]/g,"");}

    // Separate domicilio vs sucursal
    function isSucursal(o){
      if(o.esSucursal!==undefined) return o.esSucursal;
      const dir=(o.direccion||"").toUpperCase();
      return dir.includes('PUNTO ANDREANI')||dir.includes('HOP ')||dir.includes('SUCURSAL ')||dir==="NO INFORMADO";
    }
    const domicilioOrders=ordersData.filter(o=>!isSucursal(o));
    const sucursalOrders=ordersData.filter(o=>isSucursal(o));

    function getPersonData(o){
      const partes=o.comprador.trim().split(' ');
      const nombre=cleanField(partes[0]||"");
      const apellido=cleanField(partes.slice(1).join(' ')||"");
      const tel=(o.telefono||"").replace(/[^0-9]/g,'');
      const clean=tel.startsWith('54')?tel.slice(2):tel.startsWith('0')?tel.slice(1):tel;
      let telCod='',telNum='';
      if(clean.length>=10){telCod=clean.slice(0,clean.length-8);telNum=clean.slice(clean.length-8);}
      else if(clean.length>0){telNum=clean;}
      return {nombre,apellido,telCod,telNum};
    }

    // Sheet1: envíos a domicilio
    function buildDomicilioRowsXml(ords, startRow){
      let xml='';
      ords.forEach(function(o,i){
        const rn=startRow+i;
        const {nombre,apellido,telCod,telNum}=getPersonData(o);
        const ubicacion=locationOverridesRef.current[o.numero]||findAndreaniLocation(locs,o.cp,o.provincia,o.localidad||o.ciudad)||locs.list.find(l=>l.startsWith('BUENOS AIRES'))||locs.list[0]||"";
        const dirNum=String(o.dirNumero||"");
        const direccion=cleanField(o.direccion||"");
        const cells=[
          sC('A'+rn,""),
          nC('B'+rn,parseInt(cfg&&cfg.peso)||200),
          nC('C'+rn,parseInt(cfg&&cfg.alto)||5),
          nC('D'+rn,parseInt(cfg&&cfg.ancho)||5),
          nC('E'+rn,parseInt(cfg&&cfg.prof)||5),
          nC('F'+rn,parseInt(cfg&&cfg.valor)||6000),
          sC('G'+rn,'#'+o.numero),
          sC('H'+rn,cleanAndreani(nombre)),
          sC('I'+rn,cleanAndreani(apellido)),
          (o.dni&&!isNaN(o.dni))?nC('J'+rn,parseFloat(o.dni)):sC('J'+rn,o.dni||""),
          sC('K'+rn,cleanField(o.email||"")),
          telCod?nC('L'+rn,parseFloat(telCod)):sC('L'+rn,""),
          telNum?nC('M'+rn,parseFloat(telNum)):sC('M'+rn,""),
          sC('N'+rn,direccion),
          (dirNum&&!isNaN(dirNum)&&dirNum!==''&&parseFloat(dirNum)>0)?nC('O'+rn,parseFloat(dirNum)):sC('O'+rn,''),
          sC('P'+rn,cleanField(o.piso||"")),
          sC('Q'+rn,""),
          sC('R'+rn,ubicacion),
          sC('S'+rn,""),
        ].join('');
        xml+='<row r="'+rn+'" spans="1:19" x14ac:dyDescent="0.25">'+cells+'</row>';
      });
      return xml;
    }

    // Sheet2: envíos a sucursal — col N = nombre sucursal (sin O,P,Q,R,S)
    function buildSucursalRowsXml(ords, startRow){
      let xml='';
      ords.forEach(function(o,i){
        const rn=startRow+i;
        const {nombre,apellido,telCod,telNum}=getPersonData(o);
        const sucursal=sucursalOverridesRef.current[o.numero]||findAndreaniSucursal(locs,o.direccion,o.pickupDetails)||"";
        const cells=[
          sC('A'+rn,""),
          nC('B'+rn,parseInt(cfg&&cfg.peso)||200),
          nC('C'+rn,parseInt(cfg&&cfg.alto)||5),
          nC('D'+rn,parseInt(cfg&&cfg.ancho)||5),
          nC('E'+rn,parseInt(cfg&&cfg.prof)||5),
          nC('F'+rn,parseInt(cfg&&cfg.valor)||6000),
          sC('G'+rn,'#'+o.numero),
          sC('H'+rn,nombre),
          sC('I'+rn,apellido),
          (o.dni&&!isNaN(o.dni))?nC('J'+rn,parseFloat(o.dni)):sC('J'+rn,o.dni||""),
          sC('K'+rn,cleanField(o.email||"")),
          telCod?nC('L'+rn,parseFloat(telCod)):sC('L'+rn,""),
          telNum?nC('M'+rn,parseFloat(telNum)):sC('M'+rn,""),
          sC('N'+rn,sucursal),
        ].join('');
        xml+='<row r="'+rn+'" spans="1:14" x14ac:dyDescent="0.25">'+cells+'</row>';
      });
      return xml;
    }

    const domRowsXml=buildDomicilioRowsXml(domicilioOrders,3);
    const sucRowsXml=buildSucursalRowsXml(sucursalOrders,3);

    // Update sheet1 (domicilio) — limpiar filas de datos viejos antes de escribir
    const sheet1=await zip.file('xl/worksheets/sheet1.xml').async('string');
    const totalRows1=2+domicilioOrders.length;
    // Eliminar cualquier fila de datos existente (fila 3 en adelante) del template
    let newSheet1=sheet1
      .replace(/<dimension ref="[^"]+"\/>/,'<dimension ref="A1:S'+totalRows1+'"/>')
      .replace('</sheetData>',domRowsXml+'</sheetData>');
    {const _i=newSheet1.indexOf('<dataValidations');if(_i>=0){const _j=newSheet1.indexOf('</dataValidations>');if(_j>=0)newSheet1=newSheet1.slice(0,_i)+newSheet1.slice(_j+18);}}
    zip.file('xl/worksheets/sheet1.xml',newSheet1);

    // Update sheet2 (sucursal) if exists
    const sheet2file=zip.file('xl/worksheets/sheet2.xml');
    if(sheet2file&&sucursalOrders.length>0){
      const sheet2=await sheet2file.async('string');
      const totalRows2=2+sucursalOrders.length;
      let newSheet2=sheet2
        .replace(/<dimension ref="[^"]+"\/>/,\'<dimension ref="A1:S\'+totalRows2+\'"/>\')
        .replace(\'</sheetData>\',sucRowsXml+\'</sheetData>\');
      {const _i=newSheet2.indexOf(\'<dataValidations\');if(_i>=0){const _j=newSheet2.indexOf(\'</dataValidations>\');if(_j>=0)newSheet2=newSheet2.slice(0,_i)+newSheet2.slice(_j+18);}}
      zip.file(\'xl/worksheets/sheet2.xml\',newSheet2);
    }
    const newSsItems=newSS.map(function(s){
      const esc=s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const sp=(s!==s.trim()||s.indexOf(String.fromCharCode(10))>=0)?' xml:space="preserve"':'';
      return '<si><t'+sp+'>'+esc+'</t></si>';
    }).join('');
    const total=newSS.length;
    zip.file('xl/sharedStrings.xml','<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="'+total+'" uniqueCount="'+total+'">'+newSsItems+'</sst>');
    return zip.generateAsync({type:'blob',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',compression:'DEFLATE'});
  }
  const locationOverridesRef=useRef({});
  const sucursalOverridesRef=useRef({});

  // Atajos de teclado
  useEffect(()=>{
    function handleKey(e) {
      if(e.target.tagName==="INPUT"||e.target.tagName==="TEXTAREA"||e.target.tagName==="SELECT") return;
      if((e.ctrlKey||e.metaKey)&&e.key==="a"&&tab==="panel") { e.preventDefault(); toggleAll(); }
      if(e.key==="Escape") { setSelected(new Set()); setSearchEnvios(""); setBuscarQuery(""); }
      if(e.key==="Enter"&&selected.size>0&&!exportModal) { setExportModal(true); }
    }
    window.addEventListener("keydown", handleKey);
    return ()=>window.removeEventListener("keydown", handleKey);
  },[selected, tab, exportModal, tabOrders]);

  // Fetch local tab orders — independiente del estado global de orders
  async function fetchTabOrders(tab) {
    if(!user?.uid) return;
    if(tabCacheRef.current[tab]) {
      setTabOrders(tabCacheRef.current[tab]);
      return;
    }
    setTabLoading(true);
    try {
      const res=await fetch(`/api/orders?uid=${user.uid}&tab=${tab}`);
      const data=await res.json();
      if(Array.isArray(data)){
        const built=buildOrdersFromAPI(data);
        tabCacheRef.current[tab]=built;
        setTabOrders(built);
      }
    } catch(e){ console.error(e); }
    setTabLoading(false);
  }

  // Al montar: cargar tab empaquetar + contadores
  useEffect(()=>{
    if(user?.uid){
      fetchTabCounts(user.uid);
      fetchTabOrders("empaquetar");
    }
  },[]);

  function isSucursalOrder(o) {
    // Usar el campo esSucursal calculado en buildOrdersFromAPI
    if(o.esSucursal!==undefined) return o.esSucursal;
    // Fallback para compatibilidad
    const dir=(o.direccion||"").toUpperCase();
    return dir.includes('PUNTO ANDREANI')||dir.includes('HOP ')||dir.includes('SUCURSAL ')||dir==="NO INFORMADO";
  }

  async function exportAndreani() {
    const selOrders=tabOrders.filter(o=>selected.has(o.numero));
    if(!selOrders.length) return;
    setExporting(true);
    await new Promise(r=>setTimeout(r,100));
    try {
      const locs=await loadAndreaniLocations();
      const domicilioOrders=selOrders.filter(o=>!isSucursalOrder(o));
      const sucursalOrders=selOrders.filter(o=>isSucursalOrder(o));

      // Check unresolved domicilios
      const unresolvedDom=domicilioOrders.filter(o=>{
        if(locationOverridesRef.current[o.numero]) return false;
        return !findAndreaniLocation(locs,o.cp,o.provincia,o.localidad||o.ciudad);
      });

      // Check unresolved sucursales
      const unresolvedSuc=sucursalOrders.filter(o=>{
        if(sucursalOverridesRef.current[o.numero]) return false;
        const _sf=findAndreaniSucursal(locs,o.direccion,o.pickupDetails);
        return !_sf||_sf.trim()==="";
      });

      if(unresolvedDom.length>0||unresolvedSuc.length>0){
        setExporting(false);
        await resolveLocationsSequentially(unresolvedDom,unresolvedSuc,locs);
        return;
      }

      const date=new Date().toISOString().split('T')[0];
      // Filtrar pedidos excluidos manualmente
      const finalOrders=selOrders.filter(o=>
        locationOverridesRef.current[o.numero]!=="EXCLUIR" &&
        sucursalOverridesRef.current[o.numero]!=="EXCLUIR"
      );
      if(!finalOrders.length){ alert("Todos los pedidos fueron excluidos."); setExporting(false); return; }
      const b=await generateAndreaniXlsx(finalOrders,locs);
      const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='EnvioMasivoExcelPaquetes-'+date+'.xlsx';a.click();
      // Guardar historial de exportaciones
      try{
        const hist=JSON.parse(localStorage.getItem("growith_exportHistory")||"[]");
        hist.unshift({fecha:new Date().toISOString(),cantidad:finalOrders.length,pedidos:finalOrders.map(o=>o.numero)});
        localStorage.setItem("growith_exportHistory",JSON.stringify(hist.slice(0,50)));
      }catch(e){}
      setExportModal(false);setSelected(new Set());
      locationOverridesRef.current={};sucursalOverridesRef.current={};
    } catch(e){alert("Error al exportar: "+e.message);}
    setExporting(false);
  }

  async function resolveLocationsSequentially(unresolvedDom,unresolvedSuc,locs) {
    for(const o of unresolvedDom){
      const chosen=await new Promise(resolve=>{
        setLocationModal({order:o,locs,resolve,type:"domicilio"});
        setLocSearch("");setLocSearchType("ciudad");
      });
      if(chosen===null) return; // cancelar todo
      if(chosen==="EXCLUIR"){ locationOverridesRef.current[o.numero]="EXCLUIR"; continue; }
      locationOverridesRef.current[o.numero]=chosen;
    }
    for(const o of unresolvedSuc){
      const chosen=await new Promise(resolve=>{
        // Pre-fill search with calle+numero from pickupDetails for easier finding
        const pd=o.pickupDetails;
        const prefill=pd?`${pd.address?.address||""} ${(pd.address?.number||"").replace(/\D.*/,"").trim()}`.trim():"";
        setLocationModal({order:o,locs,resolve,type:"sucursal"});
        setLocSearch(prefill);setLocSearchType("ciudad");
      });
      if(chosen===null) return; // cancelar todo
      if(chosen==="EXCLUIR"){ sucursalOverridesRef.current[o.numero]="EXCLUIR"; continue; }
      sucursalOverridesRef.current[o.numero]=chosen;
      setSucursalConfirmed({numero:o.numero,nombre:chosen});
      await new Promise(r=>setTimeout(r,1200));
      setSucursalConfirmed(null);
    }
    setExportModal(true);
    setTimeout(()=>exportAndreani(),100);
  }

  // Parse PDF — shared logic using fetch+text extraction via server
  async function parsePdf(file, type) {
    const setter=type==="sku"?setSkuProcessing:setPdfProcessing;
    const resultSetter=type==="sku"?setSkuResults:setPdfResults;
    setter(true);
    resultSetter([]);

    try {
      const text=await extractPdfText(file);
      const pages=text.split("---PAGE---");
      const results=[];

      for(let i=0;i<pages.length;i++) {
        const pageText=pages[i];
        // N° seguimiento Andreani: 15 dígitos empezando con 36
        const trackingMatch=pageText.match(/(36\d{13})/);
        // N° Interno: acepta variaciones de espaciado
        const internoMatch=pageText.match(/N[°ºo]?\s*[°º]?\s*Interno\s*:?\s*#?\s*(\d{3,6})/i);
        // Destinatario
        const destMatch=pageText.match(/Destinatario\s*:\s*([^\n\r]{2,60})/i);

        if(trackingMatch&&internoMatch) {
          const tracking=trackingMatch[1].trim();
          const pedidoNum=internoMatch[1].trim();
          const destinatario=destMatch?destMatch[1].trim():"";
          if(type==="sku") {
            const order=orders.find(o=>o.numero===pedidoNum);
            const skus=order?order.productos.map(p=>`${p.sku} (x${p.cantidad})`).join(', '):"No encontrado en TN";
            results.push({pagina:i+1,pedidoNum,tracking,skus,found:!!order,destinatario});
          } else {
            results.push({pagina:i+1,tracking,pedidoNum,destinatario,status:"pending"});
          }
        }
      }
      resultSetter(results);
      if(results.length===0) alert("No se encontraron rótulos válidos en el PDF. Verificá que sea un archivo de etiquetas de Andreani con N° Interno y N° de seguimiento.");
    } catch(e){ alert("Error al procesar el PDF: "+e.message); }
    setter(false);
  }

  async function extractPdfText(file) {
    if(!window.pdfjsLib) {
      await new Promise((resolve,reject)=>{
        const s=document.createElement('script');
        s.src='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
        s.onload=resolve;s.onerror=reject;
        document.head.appendChild(s);
      });
      window.pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
    const arrayBuffer=await file.arrayBuffer();
    const pdf=await window.pdfjsLib.getDocument({data:arrayBuffer}).promise;
    const pages=[];
    for(let i=1;i<=pdf.numPages;i++) {
      const page=await pdf.getPage(i);
      const content=await page.getTextContent();
      // Agrupar items por línea (coordenada Y redondeada) para reconstruir texto sin fragmentar
      const lineMap={};
      for(const item of content.items) {
        if(!item.str) continue;
        const y=Math.round(item.transform[5]);
        if(!lineMap[y]) lineMap[y]=[];
        lineMap[y].push(item.str);
      }
      // Ordenar líneas de arriba hacia abajo (Y mayor = más arriba en PDF)
      const sortedYs=Object.keys(lineMap).map(Number).sort((a,b)=>b-a);
      const lines=sortedYs.map(y=>lineMap[y].join(''));
      // Unir todas las líneas con espacio para búsqueda de patrones
      const pageText=lines.join(' ');
      pages.push(pageText);
    }
    return pages.join('---PAGE---');
  }

  async function sendTracking(result) {
    if(!result.pedidoNum||!result.tracking) return;
    setSendingTracking(p=>({...p,[result.pedidoNum]:true}));
    try {
      // update-shipping busca el ID interno de TN por número de pedido directamente
      const res=await fetch(`/api/update-shipping?uid=${user.uid}&orderId=${result.pedidoNum}&tracking=${result.tracking}`);
      const data=await res.json();
      if(res.ok&&!data.error) {
        setTrackingSent(p=>({...p,[result.pedidoNum]:true}));
      } else {
        throw new Error(data.error||"Error al actualizar tracking en TN");
      }
    } catch(e){
      alert("❌ Error pedido #"+result.pedidoNum+": "+e.message);
    }
    setSendingTracking(p=>({...p,[result.pedidoNum]:false}));
  }

  async function sendAllTracking() {
    for(const r of pdfResults.filter(r=>r.tracking&&r.pedidoNum&&!trackingSent[r.pedidoNum])) {
      await sendTracking(r);
    }
  }

  return (
    <div style={{fontFamily:"'Inter',system-ui,sans-serif",background:T.bg,minHeight:"100vh",color:T.text}}>
      {/* Topbar */}
      <div style={{borderBottom:`1px solid ${T.border}`,background:T.surface,padding:"0 16px",position:"sticky",top:0,zIndex:100}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",height:60,maxWidth:1280,margin:"0 auto"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <button onClick={onHome} style={{...BtnSecondary(T),padding:"6px 12px",fontSize:13}}>← Inicio</button>
            <span style={{color:T.textSm,fontSize:15}}>/</span>
            <span style={{fontWeight:700,fontSize:15,color:T.text}}>🚚 Envíos</span>
          </div>
          <AsyncButton onClick={async()=>{
            tabCacheRef.current={};
            setTabOrders([]);
            await Promise.all([fetchTabOrders(tabEnvio), fetchTabCounts(user?.uid)]);
          }} style={{...BtnSecondary(T),fontSize:12,padding:"6px 12px",color:T.textMd}}>
            ⟳ Sincronizar
          </AsyncButton>
        </div>
      </div>

      {/* Tabs */}
      <div style={{borderBottom:`1px solid ${T.border}`,background:T.surface,padding:"0 16px"}}>
        <div style={{display:"flex",maxWidth:1280,margin:"0 auto"}}>
          {[{id:"panel",label:"📦 Panel de Envíos"},{id:"sku",label:"🏷️ SKU en Rótulos"},{id:"seguimientos",label:"📍 Seguimientos"}].map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)} style={{padding:"13px 18px",fontSize:14,fontWeight:tab===t.id?700:400,color:tab===t.id?T.text:T.textMd,background:"none",border:"none",borderBottom:tab===t.id?`2.5px solid ${T.accent}`:"2.5px solid transparent",cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",marginBottom:-1,transition:"color 0.15s"}}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{maxWidth:1280,margin:"0 auto",padding:"20px 16px 64px"}}>

        {/* ── PANEL DE ENVIOS ── */}
        {tab==="panel"&&(
          <div>
            {/* Tabs */}
            <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
              {/* Segmented control */}
              <div style={{display:"flex",background:T.surface,borderRadius:10,padding:3,gap:0}}>
                {[
                  {id:"cobrar",    label:"Por cobrar",     color:T.orange},
                  {id:"empaquetar",label:"Por empaquetar", color:T.yellow},
                  {id:"enviar",    label:"Por enviar",     color:T.blue},
                  {id:"buscar",    label:"🔍 Buscar",      color:T.accent},
                ].map(t=>{
                  const isActive=tabEnvio===t.id;
                  return (
                    <button key={t.id} onClick={()=>{
                      setTabEnvio(t.id);setSelected(new Set());setSearchEnvios("");
                      if(t.id==="buscar"){setBuscarQuery("");setTabOrders([]);}
                      else{fetchTabOrders(t.id);if(!tabCounts[t.id])fetchTabCounts(user?.uid);}
                    }} style={{display:"inline-flex",alignItems:"center",gap:6,padding:"7px 14px",borderRadius:8,fontSize:13,fontWeight:isActive?600:400,border:"none",background:isActive?T.card:"transparent",color:isActive?T.text:T.textMd,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",transition:"all 0.12s",boxShadow:isActive?"0 1px 3px rgba(0,0,0,0.15)":"none",whiteSpace:"nowrap"}}>
                      {t.label}
                      {t.id!=="buscar"&&<span style={{background:isActive?t.color:"transparent",color:isActive?"#fff":T.textSm,fontSize:11,fontWeight:700,borderRadius:5,padding:"1px 6px",minWidth:18,textAlign:"center",border:isActive?"none":`1px solid ${T.border}`}}>
                        {counts[t.id]===null?"·":counts[t.id]}
                      </span>}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Panel buscar */}
            {tabEnvio==="buscar"&&(
              <div style={{marginBottom:16}}>
                <div style={{display:"flex",gap:8,marginBottom:12}}>
                  <div style={{position:"relative",flex:1}}>
                    <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",fontSize:16,color:T.textSm}}>🔍</span>
                    <input
                      autoFocus
                      placeholder="Número de pedido, nombre o email..."
                      value={buscarQuery}
                      onChange={e=>setBuscarQuery(e.target.value)}
                      onKeyDown={async e=>{
                        if(e.key==="Enter"&&buscarQuery.trim().length>=2){
                          setBuscarLoading(true);
                          try{
                            const r=await fetch(`/api/orders?uid=${user?.uid}&q=${encodeURIComponent(buscarQuery.trim())}`);
                            const data=await r.json();
                            if(Array.isArray(data)) setTabOrders(buildOrdersFromAPI(data));
                          }catch(ex){}
                          setBuscarLoading(false);
                        }
                      }}
                      style={{...iS,paddingLeft:40,fontSize:14}}
                    />
                  </div>
                  <AsyncButton onClick={async()=>{
                    if(!buscarQuery.trim()) return;
                    const r=await fetch(`/api/orders?uid=${user?.uid}&q=${encodeURIComponent(buscarQuery.trim())}`);
                    const data=await r.json();
                    if(Array.isArray(data)) setTabOrders(buildOrdersFromAPI(data));
                  }} style={{...BtnPrimary(T),fontSize:13}}>
                    Buscar
                  </AsyncButton>
                </div>
              </div>
            )}

            {/* Acciones (solo cuando no es buscar o hay resultados) */}
            {(tabEnvio!=="buscar"||tabOrders.length>0)&&(
            <div style={{display:"flex",gap:8,marginBottom:14,alignItems:"center",flexWrap:"wrap"}}>
              {tabEnvio!=="buscar"&&<div style={{display:"flex",gap:4,background:T.surface,borderRadius:8,padding:2}}>
                {[["todos","Todos"],["domicilio","🏠 Domicilio"],["sucursal","🏪 Sucursal"]].map(([v,l])=>(
                  <button key={v} onClick={()=>{setFilterTipoEnvio(v);setSelected(new Set());}} style={{padding:"5px 10px",fontSize:12,border:"none",borderRadius:6,background:filterTipoEnvio===v?T.card:"transparent",color:filterTipoEnvio===v?T.text:T.textMd,cursor:"pointer",fontWeight:filterTipoEnvio===v?500:400,transition:"all 0.1s",boxShadow:filterTipoEnvio===v?"0 1px 3px rgba(0,0,0,0.12)":"none",whiteSpace:"nowrap"}}>{l}</button>
                ))}
              </div>}
              <button onClick={toggleAll} style={{...BtnSecondary(T),fontSize:13}}>
                {selected.size===exportables.length&&exportables.length>0?"✕ Deseleccionar todo":"☑ Seleccionar todo"}
              </button>
              <button onClick={()=>setCompactMode(c=>!c)} style={{...BtnSecondary(T),fontSize:12,padding:"7px 10px",color:compactMode?T.accent:T.textMd,borderColor:compactMode?T.accent:T.border}} title={compactMode?"Vista normal":"Vista compacta"}>
                {compactMode?"⊟":"⊞"} Compacto
              </button>
              {/* Columnas configurables */}
              <div style={{position:"relative"}}>
                <button onClick={e=>{e.stopPropagation();setShowColMenu(v=>!v);}} style={{...BtnSecondary(T),fontSize:12,padding:"7px 10px",color:hiddenCols.size>0?T.accent:T.textMd}}>⚙ Columnas</button>
                {showColMenu&&(
                  <>
                    <div onClick={()=>setShowColMenu(false)} style={{position:"fixed",inset:0,zIndex:99}}/>
                    <div style={{position:"absolute",top:"110%",right:0,background:T.card,border:`0.5px solid ${T.border}`,borderRadius:10,padding:"8px",zIndex:100,minWidth:160,boxShadow:"0 8px 24px rgba(0,0,0,0.3)"}}>
                      {[["estado","Estado"],["envio","Envío"],["total","Total"]].map(([col,label])=>(
                        <label key={col} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 8px",cursor:"pointer",fontSize:13,color:T.text,borderRadius:6}}>
                          <input type="checkbox" checked={!hiddenCols.has(col)} onChange={()=>toggleCol(col)} style={{cursor:"pointer"}}/>
                          {label}
                        </label>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {selected.size>0&&(
                <button onClick={()=>setExportModal(true)} style={{...BtnPrimary(T),fontSize:13}}>
                  ⬇️ Generar {selected.size} etiqueta{selected.size!==1?"s":""}
                </button>
              )}
              <span style={{fontSize:11,color:T.textSm,marginLeft:"auto",display:"flex",gap:10,alignItems:"center"}}>
                <span>{exportables.length} {exportables.length===1?"pedido":"pedidos"}</span>
                <span style={{opacity:0.5}}>· Ctrl+A todos · Shift+click rango · Esc limpiar · Enter exportar</span>
              </span>
            </div>
            )}

            {tabLoading||buscarLoading?(
              <div>
                {[...Array(6)].map((_,i)=>(
                  <div key={i} style={{display:"grid",gridTemplateColumns:"40px 80px 1fr 1fr 160px 130px 90px",gap:8,padding:"15px 14px",borderBottom:`0.5px solid ${T.borderL}`,alignItems:"center",opacity:1-i*0.12}}>
                    {[40,70,120,100,140,100,70].map((w,j)=>(
                      <div key={j} style={{height:12,borderRadius:6,background:T.surface,animation:"growith-skeleton 1.4s ease infinite",animationDelay:`${i*80+j*40}ms`,width:w,maxWidth:"100%"}}/>
                    ))}
                  </div>
                ))}
              </div>
            ):exportables.length===0?(
              <div style={{textAlign:"center",padding:"72px 20px"}}>
                <div style={{width:60,height:60,borderRadius:14,background:T.surface,display:"flex",alignItems:"center",justifyContent:"center",fontSize:26,margin:"0 auto 18px"}}>
                  {tabEnvio==="buscar"?"🔍":tabEnvio==="cobrar"?"💰":tabEnvio==="empaquetar"?"📦":"🚀"}
                </div>
                <div style={{fontSize:15,fontWeight:600,color:T.text,marginBottom:6}}>
                  {tabEnvio==="buscar"?"Buscá por número, nombre o email":tabEnvio==="cobrar"?"Sin pedidos pendientes de cobro":tabEnvio==="empaquetar"?"Todo empaquetado 🎉":"Sin pedidos para enviar"}
                </div>
                <div style={{fontSize:12,color:T.textSm,maxWidth:300,margin:"0 auto"}}>
                  {tabEnvio==="buscar"?"Escribí y presioná Enter o el botón Buscar":tabEnvio==="cobrar"?"Los pedidos pagados pasan a Por empaquetar":tabEnvio==="empaquetar"?"Los pedidos empaquetados van a Por enviar":"Marcá pedidos como empaquetados en Tienda Nube"}
                </div>
              </div>
            ):(
              <>
                <div style={{display:"grid",gridTemplateColumns:["40px","80px","1fr","1fr",...(hiddenCols.has("estado")?[]:["160px"]),...(hiddenCols.has("envio")?[]:["130px"]),...(hiddenCols.has("total")?[]:["90px"])].join(" "),gap:8,padding:"8px 14px",fontSize:11,color:T.textSm,fontWeight:600,textTransform:"uppercase",letterSpacing:0.6,borderBottom:`1px solid ${T.borderL}`}}>
                  <span/><span>Pedido</span><span>Cliente</span><span>Productos</span>
                  {!hiddenCols.has("estado")&&<span>Estado</span>}
                  {!hiddenCols.has("envio")&&<span>Envío</span>}
                  {!hiddenCols.has("total")&&<span>Total</span>}
                </div>
                {exportables.map((o,idx)=>{
                  const sel=selected.has(o.numero);
                  const ec=getEstadoEnvioC(T,o.estadoEnvio);
                  const isSuc=o.medioEnvio&&(o.medioEnvio.toLowerCase().includes('sucursal')||o.medioEnvio.toLowerCase().includes('hop')||o.medioEnvio.toLowerCase().includes('punto'));
                  return (
                    <div key={o.numero} onClick={()=>setOrderDetail(o)}
                      style={{display:"grid",gridTemplateColumns:["40px","80px","1fr","1fr",...(hiddenCols.has("estado")?[]:["160px"]),...(hiddenCols.has("envio")?[]:["130px"]),...(hiddenCols.has("total")?[]:["90px"])].join(" "),gap:8,padding:compactMode?"8px 14px":"15px 14px",borderBottom:`0.5px solid ${T.borderL}`,cursor:"pointer",transition:"background 0.1s",background:sel?T.accentSolid+"0a":"transparent",alignItems:"center",animation:`growith-fadeIn 0.2s ease both`,animationDelay:`${Math.min(idx*30,300)}ms`}}
                      onMouseEnter={e=>{if(!sel)e.currentTarget.style.background=T.card;}}
                      onMouseLeave={e=>{if(!sel)e.currentTarget.style.background="transparent";}}>
                      <div onClick={e=>{e.stopPropagation();toggleSelect(o.numero,e);}} style={{width:18,height:18,borderRadius:4,border:`1.5px solid ${sel?T.accentSolid:T.border}`,background:sel?T.accentSolid:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,zIndex:1}}>
                        {sel&&<span style={{color:"#fff",fontSize:12,lineHeight:1}}>✓</span>}
                      </div>
                      <div style={{display:"flex",flexDirection:"column",gap:3}}>
                        <span style={{fontWeight:700,color:T.accent,fontSize:14}}>#{o.numero}</span>
                      </div>
                      <div>
                        <div style={{fontSize:compactMode?12:13,fontWeight:600,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{o.comprador}</div>
                        {!compactMode&&<div style={{fontSize:11,color:T.textSm,marginTop:1}}>{o.localidad||o.ciudad}{o.provincia?`, ${o.provincia}`:""}</div>}
                      </div>
                      <div style={{fontSize:12,color:T.textSm,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                        <LensDots productos={o.productos}/>
                        {!compactMode&&<span style={{marginLeft:6}}>{o.productos.map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'')).join(', ')}</span>}
                      </div>
                      {!hiddenCols.has("estado")&&<Badge T={T} colors={ec}>{o.estadoEnvio}</Badge>}
                      {!hiddenCols.has("envio")&&<div style={{fontSize:11,color:o.esSucursal?T.purple:T.blue,fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:4}}>
                        <span>{o.esSucursal?"🏪":"🏠"}</span>
                        <span style={{overflow:"hidden",textOverflow:"ellipsis"}}>{o.medioEnvio||"—"}</span>
                        {o.esSucursal&&o.pickupDetails&&<span title="Puede requerir confirmar sucursal al exportar" style={{fontSize:10,color:T.yellow,flexShrink:0}}>⚠</span>}
                      </div>}
                      {!hiddenCols.has("total")&&<span style={{fontSize:13,fontWeight:700,color:T.text}}>{fmtMoney(o.total)}</span>}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}

        {/* ── HISTORIAL DE EXPORTACIONES ── */}
        {tab==="panel"&&(()=>{
          let hist=[];
          try{hist=JSON.parse(localStorage.getItem("growith_exportHistory")||"[]").slice(0,5);}catch(e){}
          if(!hist.length) return null;
          return (
            <div style={{marginTop:24,borderTop:`0.5px solid ${T.borderL}`,paddingTop:20}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div style={{fontSize:11,fontWeight:600,color:T.textSm,textTransform:"uppercase",letterSpacing:"0.05em"}}>Últimas exportaciones</div>
                <button onClick={()=>{localStorage.removeItem("growith_exportHistory");}} style={{fontSize:11,color:T.textSm,background:"none",border:"none",cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>Limpiar</button>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                {hist.map((h,i)=>{
                  const d=new Date(h.fecha);
                  const f=d.toLocaleDateString("es-AR",{day:"2-digit",month:"2-digit"})+" "+d.toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"});
                  const nums=h.pedidos.slice(0,3).join(", ")+(h.pedidos.length>3?` y ${h.pedidos.length-3} más`:"");
                  return (
                    <div key={i} style={{display:"flex",alignItems:"center",gap:12,padding:"8px 12px",background:T.surface,borderRadius:8,fontSize:12}}>
                      <span style={{color:T.textSm,minWidth:100}}>{f}</span>
                      <span style={{color:T.accent,fontWeight:600}}>{h.cantidad} etiqueta{h.cantidad!==1?"s":""}</span>
                      <span style={{color:T.textSm,flex:1}}>#{nums}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* ── SKU EN ROTULOS ── */}
        {tab==="sku"&&(
          <div style={{maxWidth:700}}>
            <div style={{fontSize:14,color:T.textMd,marginBottom:20,lineHeight:1.6}}>
              Subí el PDF de rótulos de Andreani. La app detecta el N° de pedido, busca los SKUs en tus pedidos de Tienda Nube y genera un resumen de lo despachado.
            </div>

            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:20,marginBottom:16}}>
              <div style={{fontSize:12,fontWeight:600,color:T.textSm,marginBottom:10,textTransform:"uppercase",letterSpacing:0.5}}>1. Seleccioná el PDF de rótulos</div>
              <input type="file" accept=".pdf" onChange={e=>{const f=e.target.files[0];if(f){setSkuFile(f);setSkuPending(true);setSkuResults([]);}}} style={{...iS,cursor:"pointer",fontSize:13,marginBottom:skuPending?12:0}}/>
              {skuPending&&!skuProcessing&&(
                <button onClick={()=>{setSkuPending(false);parsePdf(skuFile,"sku");}} style={{...BtnPrimary(T),width:"100%",justifyContent:"center",fontSize:14,marginTop:12}}>
                  🔍 Analizar PDF
                </button>
              )}
            </div>

            {skuProcessing&&(
              <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:32,textAlign:"center",marginBottom:16}}>
                <div style={{fontSize:28,marginBottom:10}}>⏳</div>
                <div style={{fontSize:15,fontWeight:600,color:T.text}}>Analizando PDF...</div>
                <div style={{fontSize:13,color:T.textSm,marginTop:6}}>Extrayendo SKUs de cada rótulo</div>
                <div style={{width:60,height:4,background:T.accentSolid,borderRadius:20,margin:"16px auto 0",animation:"pulse 1s infinite"}}/>
              </div>
            )}

            {skuResults.length>0&&(
              <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,overflow:"hidden"}}>
                <div style={{padding:"14px 18px",borderBottom:`1px solid ${T.borderL}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontSize:14,fontWeight:700,color:T.text}}>✅ {skuResults.length} rótulos analizados</span>
                  <button onClick={()=>{
                    const lines=["RESUMEN DE SKU DESPACHADOS","Fecha: "+new Date().toLocaleDateString('es-AR'),"Total de páginas: "+skuResults.length,"","DETALLE DE SKU DESPACHADOS:",""];
                    const skuMap={};
                    skuResults.forEach(r=>{const order=orders.find(o=>o.numero===r.pedidoNum);if(order)order.productos.forEach(p=>{skuMap[p.sku]=(skuMap[p.sku]||0)+(parseInt(p.cantidad)||1);});});
                    Object.entries(skuMap).sort().forEach(([sku,qty])=>lines.push(`${sku}: CANTIDAD TOTAL: ${qty}`));
                    const blob=new Blob([lines.join('\n')],{type:"text/plain"});
                    const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="resumen-sku.txt";a.click();
                  }} style={{...BtnPrimary(T),fontSize:12,padding:"6px 14px"}}>⬇️ Exportar resumen</button>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"60px 80px 1fr",gap:8,padding:"8px 18px",fontSize:11,color:T.textSm,fontWeight:600,textTransform:"uppercase",letterSpacing:0.5,borderBottom:`1px solid ${T.borderL}`}}>
                  <span>Página</span><span>Pedido</span><span>SKUs</span>
                </div>
                {skuResults.map((r,i)=>(
                  <div key={i} style={{display:"grid",gridTemplateColumns:"60px 80px 1fr",gap:8,padding:"12px 18px",borderBottom:i<skuResults.length-1?`1px solid ${T.borderL}`:"none",alignItems:"center"}}>
                    <span style={{fontSize:12,color:T.textSm}}>Pág. {r.pagina}</span>
                    <span style={{fontWeight:700,color:r.found?T.accent:T.red,fontSize:13}}>#{r.pedidoNum||"—"}</span>
                    <div>
                      <div style={{fontSize:13,color:r.found?T.text:T.red}}>{r.skus}</div>
                      {!r.found&&<div style={{fontSize:11,color:T.red,marginTop:2}}>⚠ Pedido no encontrado</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {skuResults.length>0&&skuResults.some(r=>r.found)&&(
              <div style={{marginTop:16}}>
                {!skuGenerating&&(
                  <button onClick={async()=>{
                    setSkuGenerating(true);setSkuProgress(10);
                    try{
                      const skuMap={};
                      skuResults.forEach(r=>{
                        if(r.found&&r.skuLines?.length)skuMap[r.pedidoNum]={page:r.pagina,skus:r.skuLines,found:true};
                        else skuMap[r.pedidoNum||r.pagina]={page:r.pagina,skus:[],found:false};
                      });
                      setSkuProgress(35);
                      let cfg={x:10,y:10,fontSize:4,sortBy:"sin"};
                      try{const s=localStorage.getItem("growith_skuCfg");if(s)cfg={...cfg,...JSON.parse(s)};}catch(_){}
                      const fd=new FormData();
                      fd.append("pdf",skuFile,skuFile.name);
                      fd.append("skuMap",JSON.stringify(skuMap));
                      fd.append("config",JSON.stringify(cfg));
                      setSkuProgress(55);
                      const resp=await fetch("/api/process-sku",{method:"POST",body:fd});
                      if(!resp.ok)throw new Error("Error al generar PDF: "+resp.status);
                      setSkuProgress(80);
                      const blob=await resp.blob();
                      const url=URL.createObjectURL(blob);
                      const a=document.createElement("a");
                      a.href=url;a.download=`rotulos-con-sku-${new Date().toISOString().slice(0,10)}.pdf`;a.click();
                      URL.revokeObjectURL(url);
                      setSkuProgress(100);
                      setTimeout(()=>{setSkuGenerating(false);setSkuProgress(0);},1800);
                    }catch(e){alert("Error al generar PDF: "+e.message);setSkuGenerating(false);setSkuProgress(0);}
                  }} style={{...BtnPrimary(T),width:"100%",justifyContent:"center",fontSize:15,padding:"14px 20px"}}>
                    📥 Generar PDF con SKUs y descargar
                  </button>
                )}
                {skuGenerating&&(
                  <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:24,textAlign:"center"}}>
                    <div style={{fontSize:15,fontWeight:600,color:T.text,marginBottom:8}}>
                      {skuProgress<40?"Preparando datos...":skuProgress<80?"Procesando rótulos...":skuProgress<100?"Descargando PDF...":"✅ ¡PDF listo!"}
                    </div>
                    <div style={{height:8,background:T.borderL,borderRadius:4,overflow:"hidden",margin:"12px 0 6px"}}>
                      <div style={{height:"100%",width:`${skuProgress}%`,background:skuProgress===100?T.green:T.accentSolid,borderRadius:4,transition:"width 0.4s ease"}}></div>
                    </div>
                    <div style={{fontSize:13,color:T.textSm}}>{skuProgress}%</div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── SEGUIMIENTOS ── */}
        {tab==="seguimientos"&&(
          <div style={{maxWidth:700}}>
            <div style={{fontSize:14,color:T.textMd,marginBottom:20,lineHeight:1.6}}>
              Subí el PDF de rótulos de Andreani ya impresos. La app extrae el N° de seguimiento y pedido, y los envía a Tienda Nube automáticamente.
            </div>

            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:20,marginBottom:16}}>
              <div style={{fontSize:12,fontWeight:600,color:T.textSm,marginBottom:10,textTransform:"uppercase",letterSpacing:0.5}}>1. Seleccioná el PDF de rótulos Andreani</div>
              <input type="file" accept=".pdf" onChange={e=>{const f=e.target.files[0];if(f){setPdfFile(f);setPdfPending(true);setPdfResults([]);setTrackingSent({});}}} style={{...iS,cursor:"pointer",fontSize:13}}/>
              {pdfPending&&!pdfProcessing&&(
                <button onClick={()=>{setPdfPending(false);parsePdf(pdfFile,"tracking");}} style={{...BtnPrimary(T),width:"100%",justifyContent:"center",fontSize:14,marginTop:12}}>
                  🔍 Analizar PDF y extraer seguimientos
                </button>
              )}
            </div>

            {pdfProcessing&&(
              <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:32,textAlign:"center",marginBottom:16}}>
                <div style={{fontSize:28,marginBottom:10}}>⏳</div>
                <div style={{fontSize:15,fontWeight:600,color:T.text}}>Analizando PDF...</div>
                <div style={{fontSize:13,color:T.textSm,marginTop:6}}>Extrayendo números de seguimiento</div>
              </div>
            )}

            {pdfResults.length>0&&(
              <div style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:12,overflow:"hidden"}}>
                <div style={{padding:"14px 18px",borderBottom:`0.5px solid ${T.borderL}`,display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                  <div>
                    <span style={{fontSize:14,fontWeight:700,color:T.text}}>{pdfResults.length} etiquetas detectadas</span>
                    {Object.keys(trackingSent).length>0&&<span style={{fontSize:12,color:T.green,marginLeft:10}}>· {Object.keys(trackingSent).length} enviados ✓</span>}
                  </div>
                  <AsyncButton onClick={sendAllTracking} style={{...BtnPrimary(T),fontSize:13,padding:"8px 18px"}}>
                    ↑ Enviar seguimientos ({pdfResults.filter(r=>!trackingSent[r.pedidoNum]).length} pendientes)
                  </AsyncButton>
                </div>
                {pdfResults.map((r,i)=>{
                  const sent=trackingSent[r.pedidoNum];
                  const sending=sendingTracking[r.pedidoNum];
                  return (
                    <div key={i} style={{padding:"12px 18px",borderBottom:i<pdfResults.length-1?`0.5px solid ${T.borderL}`:"none",display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,background:sent?T.greenBg:"transparent",transition:"background 0.3s"}}>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:3,flexWrap:"wrap"}}>
                          <span style={{fontWeight:700,color:T.accent,fontSize:14}}>#{r.pedidoNum||"—"}</span>
                          {r.destinatario&&<span style={{fontSize:13,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.destinatario}</span>}
                        </div>
                        <div style={{fontSize:11,color:T.textSm,fontFamily:"monospace",letterSpacing:"0.03em"}}>{r.tracking||"Sin tracking"}</div>
                      </div>
                      <div style={{flexShrink:0}}>
                        {sent?<span style={{fontSize:12,color:T.green,fontWeight:600}}>✓ Enviado</span>
                        :sending?<span style={{fontSize:12,color:T.yellow}}>⏳...</span>
                        :r.tracking&&r.pedidoNum?
                          <AsyncButton onClick={()=>sendTracking(r)} style={{...BtnSecondary(T),fontSize:11,padding:"5px 12px"}}>↑ Enviar</AsyncButton>
                        :<span style={{fontSize:11,color:T.red}}>Sin datos</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Sucursal confirmed toast */}
      {copiedToast&&(
        <div style={{position:"fixed",bottom:28,left:"50%",transform:"translateX(-50%)",zIndex:2000,background:T.card,border:`0.5px solid ${T.border}`,borderRadius:8,padding:"8px 16px",display:"flex",alignItems:"center",gap:8,boxShadow:"0 4px 20px rgba(0,0,0,0.25)",animation:"growith-fadeIn 0.15s ease",fontSize:13,color:T.text}}>
          <span style={{fontSize:14}}>📋</span> {copiedToast}
        </div>
      )}
      {sucursalConfirmed&&(
        <div style={{position:"fixed",bottom:28,left:"50%",transform:"translateX(-50%)",zIndex:2000,background:T.card,border:`0.5px solid ${T.green}44`,borderLeft:`3px solid ${T.green}`,borderRadius:10,padding:"12px 20px",display:"flex",alignItems:"center",gap:10,boxShadow:"0 8px 40px rgba(0,0,0,0.3)",animation:"fadeIn 0.2s ease",minWidth:280}}>
          <span style={{fontSize:16}}>✅</span>
          <div>
            <div style={{fontSize:13,fontWeight:600,color:T.green}}>Sucursal confirmada · #{sucursalConfirmed.numero}</div>
            <div style={{fontSize:11,color:T.textSm,marginTop:2}}>{sucursalConfirmed.nombre}</div>
          </div>
        </div>
      )}

      {/* Order Detail Modal */}
      <Modal T={T} open={!!orderDetail} onClose={()=>setOrderDetail(null)} title={orderDetail?`Pedido #${orderDetail.numero}`:""} width={580}>
        {orderDetail&&(()=>{
          const o=orderDetail;
          const ec=getEstadoEnvioC(T,o.estadoEnvio);
          return (
            <div>
              <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:18,flexWrap:"wrap"}}>
                <Badge T={T} colors={ec}>{o.estadoEnvio}</Badge>
                <span style={{fontSize:20,fontWeight:700,color:T.text,marginLeft:"auto"}}>{fmtMoney(o.total)}</span>
              </div>
              <div style={{background:T.surface,border:`0.5px solid ${T.border}`,borderRadius:12,padding:"14px 16px",marginBottom:14}}>
                <div style={{fontSize:11,fontWeight:600,color:T.textSm,textTransform:"uppercase",letterSpacing:0.5,marginBottom:10}}>Cliente</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"6px 20px",fontSize:13}}>
                  {[["Nombre",o.comprador],["Email",o.email],["Teléfono",o.telefono],["DNI",o.dni],["Fecha",o.fecha],["Pago",o.estadoPago],["Medio de pago",o.medioPago]].map(([l,v])=>v?(
                    <div key={l} style={{display:"flex",flexDirection:"column",gap:2,padding:"5px 0",borderBottom:`1px solid ${T.borderL}`}}>
                      <span style={{fontSize:11,color:T.textSm,fontWeight:500}}>{l}</span>
                      <span style={{fontWeight:500,color:T.text}}>{v}</span>
                    </div>
                  ):null)}
                </div>
              </div>
              <div style={{background:T.surface,border:`0.5px solid ${T.border}`,borderRadius:12,padding:"14px 16px",marginBottom:14}}>
                <div style={{fontSize:11,fontWeight:600,color:T.textSm,textTransform:"uppercase",letterSpacing:0.5,marginBottom:10}}>Envío</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"6px 20px",fontSize:13}}>
                  {o.esSucursal?(<>
                    <div style={{display:"flex",flexDirection:"column",gap:2,padding:"5px 0",borderBottom:`1px solid ${T.borderL}`,gridColumn:"1/-1"}}>
                      <span style={{fontSize:11,color:T.textSm,fontWeight:500}}>Punto de retiro</span>
                      <span style={{fontWeight:500,color:T.purple}}>{o.pickupDetails?.name}</span>
                    </div>
                  </>):(
                    [["Dirección",`${o.direccion||""} ${o.dirNumero||""}${o.piso?`, Piso ${o.piso}`:""}`],["Localidad",o.localidad||o.ciudad],["Provincia",o.provincia],["CP",o.cp]].map(([l,v])=>v&&v.trim()?(
                      <div key={l} style={{display:"flex",flexDirection:"column",gap:2,padding:"5px 0",borderBottom:`1px solid ${T.borderL}`}}>
                        <span style={{fontSize:11,color:T.textSm,fontWeight:500}}>{l}</span>
                        <span style={{fontWeight:500,color:T.text}}>{v}</span>
                      </div>
                    ):null)
                  )}
                  {[["Modalidad",o.medioEnvio],["Tracking",o.tracking]].map(([l,v])=>v?(
                    <div key={l} style={{display:"flex",flexDirection:"column",gap:2,padding:"5px 0",borderBottom:`1px solid ${T.borderL}`}}>
                      <span style={{fontSize:11,color:T.textSm,fontWeight:500}}>{l}</span>
                      <span style={{fontWeight:500,color:T.text}}>{v}</span>
                    </div>
                  ):null)}
                </div>
              </div>
              <div style={{background:T.surface,border:`0.5px solid ${T.border}`,borderRadius:12,padding:"14px 16px",marginBottom:18}}>
                <div style={{fontSize:11,fontWeight:600,color:T.textSm,textTransform:"uppercase",letterSpacing:0.5,marginBottom:10}}>Productos</div>
                {o.productos.map((p,i)=>(
                  <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:i<o.productos.length-1?`1px solid ${T.borderL}`:"none",fontSize:13}}>
                    <div><div style={{fontWeight:500,color:T.text}}>{p.nombre}</div>{p.sku&&<div style={{fontSize:11,color:T.textSm,fontFamily:"monospace"}}>{p.sku}</div>}</div>
                    <div style={{display:"flex",gap:12,alignItems:"center"}}><span style={{fontSize:12,color:T.textSm}}>x{p.cantidad}</span><span style={{fontWeight:600,color:T.text}}>{fmtMoney(p.precio)}</span></div>
                  </div>
                ))}
                <div style={{display:"flex",justifyContent:"space-between",marginTop:10,paddingTop:10,borderTop:`1px solid ${T.border}`,fontSize:13}}><span style={{color:T.textSm}}>Subtotal</span><span style={{fontWeight:500}}>{fmtMoney(o.subtotal)}</span></div>
                {parseFloat(o.descuento)>0&&<div style={{display:"flex",justifyContent:"space-between",fontSize:13}}><span style={{color:T.green}}>Descuento</span><span style={{color:T.green}}>−{fmtMoney(o.descuento)}</span></div>}
                <div style={{display:"flex",justifyContent:"space-between",fontSize:14,fontWeight:700,marginTop:6}}><span>Total</span><span style={{color:T.text}}>{fmtMoney(o.total)}</span></div>
              </div>
              <div style={{display:"flex",gap:10,justifyContent:"space-between",alignItems:"center",flexWrap:"wrap"}}>
                <a href={o.linkOrden} target="_blank" rel="noopener noreferrer" style={{...BtnSecondary(T),textDecoration:"none",fontSize:13}}>🔗 Ver en TN</a>
                {onGenerarCanje&&(
                  <button onClick={()=>{setOrderDetail(null);const prodsCanje=o.productos.map(p=>({nombre:p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /i,"").replace(/[()]/g,"").trim()||p.sku||p.nombre,cantidad:parseInt(p.cantidad)||1})).filter(p=>p.nombre);onGenerarCanje({nombre:o.comprador,email:o.email,telefono:o.telefono,productosCanje:prodsCanje,pedidoRef:o.numero});}} style={{...BtnPrimary(T),fontSize:13}}>🤝 Generar Canje</button>
                )}
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* Location / Sucursal Resolution Modal */}
      <Modal T={T} open={!!locationModal} onClose={()=>{if(locationModal){locationModal.resolve(null);setLocationModal(null);}}} title={locationModal?.type==="sucursal"?"Confirmar sucursal Andreani":"Confirmar localidad Andreani"} width={560} zIndex={2000}>
        {locationModal&&(()=>{
          const {order,locs,resolve,type}=locationModal;
          const isSuc=type==="sucursal";
          const results=isSuc?searchSucursales(locs,locSearch):searchAndreaniLocations(locs,locSearch,locSearchType);
          return (
            <div>
              <div style={{background:T.yellowBg,border:`1px solid ${T.yellow}44`,borderRadius:10,padding:"12px 14px",marginBottom:16}}>
                <div style={{fontSize:13,fontWeight:700,color:T.yellow,marginBottom:4}}>
                  ⚠ {isSuc?"No se encontró la sucursal exacta":"No se encontró la localidad exacta"}
                </div>
                <div style={{fontSize:13,color:T.text}}>Pedido <strong>#{order.numero}</strong> — {order.comprador}</div>
                {isSuc&&order.pickupDetails&&(
                  <div style={{fontSize:12,color:T.text,marginTop:6,background:T.surface,borderRadius:8,padding:"8px 10px"}}>
                    <div style={{fontWeight:600,color:T.accent,marginBottom:2}}>{order.pickupDetails.name}</div>
                    <div>{order.pickupDetails.address?.address} {order.pickupDetails.address?.number}</div>
                    <div style={{color:T.textSm}}>{order.pickupDetails.address?.locality}, {order.pickupDetails.address?.province}</div>
                  </div>
                )}
                {!isSuc&&<div style={{fontSize:12,color:T.textSm,marginTop:3}}>
                  {order.direccion} {order.dirNumero}, {order.localidad||order.ciudad}, {order.provincia} — CP {order.cp}
                </div>}
              </div>
              <div style={{marginBottom:14}}>
                <div style={{fontSize:12,fontWeight:600,color:T.textSm,marginBottom:8,textTransform:"uppercase",letterSpacing:0.5}}>
                  {isSuc?"Buscar sucursal Andreani":"Buscar localidad Andreani"}
                </div>
                {!isSuc&&(
                  <div style={{display:"flex",gap:6,marginBottom:10}}>
                    {["ciudad","cp","calle"].map(t=>(
                      <button key={t} onClick={()=>{setLocSearchType(t);setLocSearch("");}}
                        style={{padding:"6px 14px",fontSize:12,fontWeight:locSearchType===t?700:400,borderRadius:8,border:`1.5px solid ${locSearchType===t?T.accentSolid:T.border}`,background:locSearchType===t?T.accentSolid:"transparent",color:locSearchType===t?"#fff":T.textMd,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",textTransform:"capitalize"}}>
                        {t==="cp"?"Código Postal":t==="ciudad"?"Ciudad":"Calle"}
                      </button>
                    ))}
                  </div>
                )}
                <input
                  autoFocus
                  style={{...InputStyle(T),fontSize:14,marginBottom:10}}
                  placeholder={isSuc?"Ej: BELGRANO, MONROE, HOP...":locSearchType==="cp"?"Ej: 1712":locSearchType==="ciudad"?"Ej: Córdoba, Rosario...":"Ej: San Martín..."}
                  value={locSearch}
                  onChange={e=>setLocSearch(e.target.value)}
                />
                {results.length>0&&(
                  <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,maxHeight:280,overflow:"auto"}}>
                    {results.map((item,i)=>{
                      if(isSuc){
                        return (
                          <div key={i} onClick={()=>{resolve(item);setLocationModal(null);}}
                            style={{padding:"11px 14px",cursor:"pointer",borderBottom:i<results.length-1?`1px solid ${T.borderL}`:"none",transition:"background 0.1s"}}
                            onMouseEnter={e=>e.currentTarget.style.background=T.card}
                            onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                            <div style={{fontSize:13,fontWeight:600,color:T.text}}>{item}</div>
                          </div>
                        );
                      }
                      const parts=item.split(' / ');
                      return (
                        <div key={i} onClick={()=>{resolve(item);setLocationModal(null);}}
                          style={{padding:"11px 14px",cursor:"pointer",borderBottom:i<results.length-1?`1px solid ${T.borderL}`:"none",transition:"background 0.1s"}}
                          onMouseEnter={e=>e.currentTarget.style.background=T.card}
                          onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                          <div style={{fontSize:13,fontWeight:600,color:T.text}}>{parts[1]}</div>
                          <div style={{fontSize:11,color:T.textSm,marginTop:2}}>{parts[0]} · CP {parts[2]}</div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {locSearch.length>=2&&results.length===0&&(
                  <div style={{padding:"20px",textAlign:"center",color:T.textSm,fontSize:13,background:T.bg,borderRadius:10,border:`1px solid ${T.border}`}}>
                    Sin resultados para "{locSearch}"
                  </div>
                )}
              </div>
              <div style={{display:"flex",gap:8,justifyContent:"flex-end",paddingTop:12,borderTop:`0.5px solid ${T.borderL}`,flexWrap:"wrap"}}>
                <button onClick={()=>{resolve(null);setLocationModal(null);}} style={{...BtnSecondary(T),fontSize:13}}>Cancelar exportación</button>
                <button onClick={()=>{resolve("EXCLUIR");setLocationModal(null);}} style={{...BtnDanger(T),fontSize:13}}>Excluir este pedido</button>
                {!isSuc&&<button onClick={()=>{
                  const fallback=locs.list.find(l=>l.startsWith((order.provincia||"BUENOS AIRES").toUpperCase()))||locs.list[0]||"";
                  resolve(fallback);setLocationModal(null);
                }} style={{...BtnSecondary(T),fontSize:13,color:T.orange}}>Usar primera disponible</button>}
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* Export Modal */}
      <Modal T={T} open={exportModal} onClose={()=>!exporting&&setExportModal(false)} title={`Generar ${selected.size} etiqueta${selected.size!==1?"s":""} para Andreani`} width={480}>
        <div>
          <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:"12px 16px",marginBottom:18,fontSize:13,color:T.textMd}}>
            <span style={{fontWeight:700,color:T.text}}>{selected.size}</span> pedido{selected.size!==1?"s":""} seleccionado{selected.size!==1?"s":""}. Se exportarán solo los marcados.
          </div>
          <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:10}}>📦 Paquete</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 14px"}}>
            <Field T={T} label="Peso (g)"><input style={iS} type="number" value={exportCfg.peso} onChange={e=>setExportCfg(c=>({...c,peso:e.target.value}))} placeholder="200"/></Field>
            <Field T={T} label="Valor declarado ($)"><input style={iS} type="number" value={exportCfg.valor} onChange={e=>setExportCfg(c=>({...c,valor:e.target.value}))} placeholder="6000"/></Field>
            <Field T={T} label="Alto (cm)"><input style={iS} type="number" value={exportCfg.alto} onChange={e=>setExportCfg(c=>({...c,alto:e.target.value}))} placeholder="5"/></Field>
            <Field T={T} label="Ancho (cm)"><input style={iS} type="number" value={exportCfg.ancho} onChange={e=>setExportCfg(c=>({...c,ancho:e.target.value}))} placeholder="5"/></Field>
          </div>
          <Field T={T} label="Prof. (cm)"><input style={iS} type="number" value={exportCfg.prof} onChange={e=>setExportCfg(c=>({...c,prof:e.target.value}))} placeholder="5"/></Field>
          <div onClick={()=>!exporting&&setExportCfg(c=>({...c,separar:!c.separar}))} style={{display:"flex",alignItems:"flex-start",gap:12,padding:"14px",background:T.bg,border:`1.5px solid ${exportCfg.separar?T.accentSolid:T.border}`,borderRadius:10,cursor:"pointer",marginBottom:20,transition:"all 0.15s"}}>
            <div style={{width:20,height:20,borderRadius:4,border:`2px solid ${exportCfg.separar?T.accentSolid:T.border}`,background:exportCfg.separar?T.accentSolid:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:1}}>
              {exportCfg.separar&&<span style={{color:"#fff",fontSize:12}}>✓</span>}
            </div>
            <div>
              <div style={{fontSize:13,fontWeight:600,color:T.text}}>Separar Domicilios / Sucursales</div>
              <div style={{fontSize:12,color:T.textSm,marginTop:3}}>Genera 2 archivos CSV en lugar de uno</div>
            </div>
          </div>
          <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
            <button onClick={()=>setExportModal(false)} disabled={exporting} style={{...BtnSecondary(T),opacity:exporting?0.5:1}}>Cancelar</button>
            <AsyncButton onClick={exportAndreani} style={{...BtnPrimary(T),minWidth:160,justifyContent:"center"}}>
              ⬇️ Generar etiquetas
            </AsyncButton>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ═══════════════════════════════════════════
// HOME SCREEN
// ═══════════════════════════════════════════
function HomeScreen({T, onNavigate, fbStatus, ordersCount, reclamosCount, canjesCount, alertas, user, userPlan="free", planExpiry, isAdmin=false}) {
  const fbDot={connecting:T.yellow,ok:T.green,error:T.red}[fbStatus];
  return (
    <div style={{fontFamily:"'Inter',system-ui,sans-serif",background:T.bg,minHeight:"100vh",color:T.text,display:"flex",flexDirection:"column"}}>
      <div style={{borderBottom:`1px solid ${T.border}`,background:T.surface,padding:"0 16px"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",height:64,maxWidth:1000,margin:"0 auto"}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <div style={{width:36,height:36,borderRadius:10,background:`linear-gradient(135deg,${T.accent},${T.purple})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>🌙</div>
            <div>
              <div style={{fontWeight:800,fontSize:16,color:T.text,letterSpacing:-0.3}}>Growith</div>
              <div style={{fontSize:12,color:T.textSm}}>Gestión de tu negocio</div>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            {user?.photoURL&&<img src={user.photoURL} style={{width:32,height:32,borderRadius:"50%",border:`2px solid ${T.border}`}} alt=""/>}
            <div style={{display:"flex",alignItems:"center",gap:6,background:T.card,border:`1px solid ${T.border}`,borderRadius:20,padding:"5px 12px"}}>
              <span style={{width:7,height:7,borderRadius:"50%",background:fbDot,boxShadow:`0 0 6px ${fbDot}`}}/>
              <span style={{fontSize:12,color:T.textSm,fontWeight:500}}>{fbStatus==="ok"?"en vivo":"conectando"}</span>
            </div>
            {/* Plan badge */}
            <button onClick={()=>onNavigate("planes")} style={{display:"inline-flex",alignItems:"center",gap:5,padding:"5px 10px",borderRadius:8,background:userPlan==="free"?T.surface:userPlan==="starter"?"#1c1400":userPlan==="pro"?"#0a1628":"#1a0a2e",border:`0.5px solid ${userPlan==="free"?T.border:userPlan==="starter"?"#fbbf24":userPlan==="pro"?"#60a5fa":"#a78bfa"}`,fontSize:12,fontWeight:600,color:userPlan==="free"?T.textSm:userPlan==="starter"?"#fbbf24":userPlan==="pro"?"#60a5fa":"#a78bfa",cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>
              {userPlan==="free"?"Free":userPlan==="starter"?"Starter":userPlan==="pro"?"Pro":"Total"}
            </button>
            {isAdmin&&<button onClick={()=>onNavigate("admin")} style={{...BtnSecondary(T),padding:"6px 10px",fontSize:12,color:T.yellow,borderColor:T.yellow+"44"}} title="Panel de administrador">👑</button>}
            <button onClick={()=>onNavigate("config")} style={{...BtnSecondary(T),padding:"6px 12px",fontSize:13}}>⚙️</button>
          </div>
        </div>
      </div>

      <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",padding:"32px 16px"}}>
        <div style={{textAlign:"center",marginBottom:48,maxWidth:520}}>
          <h1 style={{fontSize:36,fontWeight:800,margin:"0 0 12px",letterSpacing:-1,color:T.text}}>Bienvenida 👋</h1>
          <p style={{fontSize:17,color:T.textMd,margin:0,lineHeight:1.7}}>Seleccioná una sección para gestionar tu negocio.</p>
        </div>

        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:16,width:"100%",maxWidth:760,marginBottom:32}}>
          {/* Reclamos */}
          <button onClick={()=>onNavigate("reclamos")}
            style={{background:T.card,border:`0.5px solid ${T.border}`,borderLeft:`3px solid ${T.red}`,borderRadius:14,padding:28,textAlign:"left",cursor:"pointer",transition:"all 0.15s",fontFamily:"'Inter',system-ui,sans-serif",color:T.text}}
            onMouseEnter={e=>{e.currentTarget.style.background=T.surface;}}
            onMouseLeave={e=>{e.currentTarget.style.background=T.card;}}>
            <div style={{width:44,height:44,borderRadius:10,background:T.redBg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,marginBottom:18}}>📋</div>
            <div style={{fontSize:18,fontWeight:700,marginBottom:8,color:T.text,letterSpacing:-0.3}}>Gestión de Reclamos</div>
            <div style={{fontSize:14,color:T.textMd,lineHeight:1.6,marginBottom:20}}>Administrá cambios y devoluciones de productos vinculados a tus pedidos de Tienda Nube.</div>
            <div style={{display:"flex",gap:16,paddingTop:16,borderTop:`0.5px solid ${T.borderL}`}}>
              <div><div style={{fontSize:26,fontWeight:700,color:T.accent,letterSpacing:-0.5}}>{ordersCount??<Spinner size={16} color={T.accent}/>}</div><div style={{fontSize:11,color:T.textSm,marginTop:3,textTransform:"uppercase",letterSpacing:"0.04em"}}>pedidos totales</div></div>
              <div style={{width:1,background:T.borderL}}/>
              <div><div style={{fontSize:26,fontWeight:800,color:T.red,letterSpacing:-1}}>{reclamosCount}</div><div style={{fontSize:12,color:T.textSm,marginTop:2}}>reclamos</div></div>
            </div>
          </button>

          {/* Canjes */}
          <button onClick={()=>onNavigate("canjes")}
            style={{background:T.card,border:`0.5px solid ${T.border}`,borderLeft:`3px solid ${T.purple}`,borderRadius:14,padding:28,textAlign:"left",cursor:"pointer",transition:"all 0.15s",fontFamily:"'Inter',system-ui,sans-serif",color:T.text}}
            onMouseEnter={e=>{e.currentTarget.style.background=T.surface;}}
            onMouseLeave={e=>{e.currentTarget.style.background=T.card;}}>
            <div style={{width:52,height:52,borderRadius:14,background:T.purpleBg,border:`1px solid ${T.purple}33`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:26,marginBottom:20}}>🤝</div>
            <div style={{fontSize:20,fontWeight:800,marginBottom:8,color:T.text,letterSpacing:-0.3}}>Gestión de Canjes</div>
            <div style={{fontSize:14,color:T.textMd,lineHeight:1.6,marginBottom:20}}>Seguimiento de influencers, productos enviados, actividades comprometidas y contenido publicado.</div>
            <div style={{display:"flex",gap:16,paddingTop:16,borderTop:`0.5px solid ${T.borderL}`}}>
              <div><div style={{fontSize:26,fontWeight:800,color:T.purple,letterSpacing:-1}}>{canjesCount}</div><div style={{fontSize:12,color:T.textSm,marginTop:2}}>canjes</div></div>
            </div>
          </button>

          {/* Envios */}
          <button onClick={()=>onNavigate("envios")}
            style={{background:T.card,border:`0.5px solid ${T.border}`,borderLeft:`3px solid ${T.blue}`,borderRadius:14,padding:28,textAlign:"left",cursor:"pointer",transition:"all 0.15s",fontFamily:"'Inter',system-ui,sans-serif",color:T.text}}
            onMouseEnter={e=>{e.currentTarget.style.background=T.surface;}}
            onMouseLeave={e=>{e.currentTarget.style.background=T.card;}}>
            <div style={{width:44,height:44,borderRadius:10,background:T.blueBg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,marginBottom:18}}>🚚</div>
            <div style={{fontSize:18,fontWeight:700,marginBottom:8,color:T.text,letterSpacing:-0.3}}>Gestión de Envíos</div>
            <div style={{fontSize:14,color:T.textMd,lineHeight:1.6,marginBottom:20}}>Exportá pedidos para Andreani, insertá SKUs en rótulos y enviá seguimientos a Tienda Nube automáticamente.</div>
            <div style={{display:"flex",gap:16,paddingTop:16,borderTop:`0.5px solid ${T.borderL}`}}>
              <div><div style={{fontSize:26,fontWeight:700,color:T.blue,letterSpacing:-0.5}}>{ordersCount??<Spinner size={16} color={T.blue}/>}</div><div style={{fontSize:11,color:T.textSm,marginTop:3,textTransform:"uppercase",letterSpacing:"0.04em"}}>pedidos totales</div></div>
            </div>
          </button>
        </div>

        {/* Alertas */}
        {alertas&&alertas.length>0&&(
          <div style={{width:"100%",maxWidth:760}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
              <span style={{fontSize:16}}>⚠️</span>
              <span style={{fontSize:14,fontWeight:700,color:T.text}}>Alertas pendientes</span>
              <span style={{background:T.red,color:"#fff",fontSize:11,fontWeight:700,borderRadius:20,padding:"2px 8px"}}>{alertas.length}</span>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {alertas.map((a,i)=>{
                const colorMap={recordatorio:T.yellow,sinrespuesta:T.orange,contenido:T.blue};
                const iconMap={recordatorio:"⏰",sinrespuesta:"📦",contenido:"🎬"};
                const col=colorMap[a.tipo]||T.yellow;
                return (
                  <div key={i} onClick={()=>onNavigate("canjes")}
                    style={{background:T.card,border:`1px solid ${col}44`,borderLeft:`4px solid ${col}`,borderRadius:10,padding:"12px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer",transition:"all 0.15s"}}
                    onMouseEnter={e=>e.currentTarget.style.background=T.surface}
                    onMouseLeave={e=>e.currentTarget.style.background=T.card}>
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      <span style={{fontSize:16}}>{iconMap[a.tipo]}</span>
                      <div>
                        <div style={{fontSize:13,fontWeight:700,color:T.text}}>{a.canje.influencer}</div>
                        <div style={{fontSize:12,color:col,fontWeight:500,marginTop:1}}>{a.msg}</div>
                      </div>
                    </div>
                    <span style={{fontSize:12,color:T.textSm}}>→ Ver canjes</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// AUTH SCREEN
// ═══════════════════════════════════════════
function AuthScreen({T}) {
  const [mode,setMode]=useState("login"); // login | register
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [nombre,setNombre]=useState("");
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(false);
  const iS=InputStyle(T);

  const errMsg=(code)=>{
    const map={
      "auth/user-not-found":"No existe una cuenta con ese email.",
      "auth/wrong-password":"Contraseña incorrecta.",
      "auth/email-already-in-use":"Ya existe una cuenta con ese email.",
      "auth/weak-password":"La contraseña debe tener al menos 6 caracteres.",
      "auth/invalid-email":"El email no es válido.",
      "auth/invalid-credential":"Email o contraseña incorrectos.",
      "auth/popup-closed-by-user":"Cerraste el popup antes de completar el login.",
    };
    return map[code]||"Ocurrió un error. Intentá de nuevo.";
  };

  async function handleGoogle() {
    setLoading(true); setError("");
    try {
      const result = await signInWithPopup(auth, googleProvider);
      await ensureUserDoc(result.user);
    } catch(e){ setError(errMsg(e.code)); }
    setLoading(false);
  }

  async function handleEmail() {
    if(!email||!password) return setError("Completá email y contraseña.");
    setLoading(true); setError("");
    try {
      if(mode==="register") {
        if(!nombre.trim()) return setError("Ingresá tu nombre.");
        const result = await createUserWithEmailAndPassword(auth, email, password);
        await updateProfile(result.user, {displayName: nombre});
        await ensureUserDoc(result.user, nombre);
      } else {
        const result = await signInWithEmailAndPassword(auth, email, password);
        await ensureUserDoc(result.user);
      }
    } catch(e){ setError(errMsg(e.code)); }
    setLoading(false);
  }

  async function ensureUserDoc(user, displayName) {
    const ref = doc(db, "users", user.uid);
    const snap = await getDoc(ref);
    if(!snap.exists()) {
      await setDoc(ref, {
        uid: user.uid,
        email: user.email,
        nombre: displayName || user.displayName || user.email.split("@")[0],
        createdAt: serverTimestamp(),
        plan: "free",
        stores: [],
      });
    }
  }

  return (
    <div style={{fontFamily:"'Inter',system-ui,sans-serif",background:T.bg,minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div style={{width:"100%",maxWidth:420}}>
        {/* Logo */}
        <div style={{textAlign:"center",marginBottom:40}}>
          <div style={{width:56,height:56,borderRadius:16,background:`linear-gradient(135deg,${T.accentSolid},${T.purple})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,margin:"0 auto 14px"}}>🌙</div>
          <div style={{fontSize:24,fontWeight:800,color:T.text,letterSpacing:-0.5}}>Growith</div>
          <div style={{fontSize:14,color:T.textMd,marginTop:4}}>{mode==="login"?"Iniciá sesión en tu cuenta":"Creá tu cuenta gratis"}</div>
        </div>

        <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:16,padding:28}}>
          {/* Google */}
          <button onClick={handleGoogle} disabled={loading} style={{...BtnSecondary(T),width:"100%",justifyContent:"center",padding:"13px",fontSize:15,marginBottom:20,opacity:loading?0.6:1}}>
            <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
            Continuar con Google
          </button>

          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20}}>
            <div style={{flex:1,height:1,background:T.border}}/>
            <span style={{fontSize:12,color:T.textSm}}>o con email</span>
            <div style={{flex:1,height:1,background:T.border}}/>
          </div>

          {mode==="register"&&(
            <div style={{marginBottom:12}}>
              <label style={{display:"block",fontSize:12,fontWeight:600,color:T.textMd,marginBottom:5,textTransform:"uppercase",letterSpacing:0.5}}>Nombre</label>
              <input style={iS} placeholder="Tu nombre" value={nombre} onChange={e=>setNombre(e.target.value)} onFocus={e=>e.target.style.borderColor=T.accent} onBlur={e=>e.target.style.borderColor=T.inputBorder}/>
            </div>
          )}
          <div style={{marginBottom:12}}>
            <label style={{display:"block",fontSize:12,fontWeight:600,color:T.textMd,marginBottom:5,textTransform:"uppercase",letterSpacing:0.5}}>Email</label>
            <input style={iS} type="email" placeholder="tu@email.com" value={email} onChange={e=>setEmail(e.target.value)} onFocus={e=>e.target.style.borderColor=T.accent} onBlur={e=>e.target.style.borderColor=T.inputBorder}/>
          </div>
          <div style={{marginBottom:20}}>
            <label style={{display:"block",fontSize:12,fontWeight:600,color:T.textMd,marginBottom:5,textTransform:"uppercase",letterSpacing:0.5}}>Contraseña</label>
            <input style={iS} type="password" placeholder="••••••••" value={password} onChange={e=>setPassword(e.target.value)} onFocus={e=>e.target.style.borderColor=T.accent} onBlur={e=>e.target.style.borderColor=T.inputBorder} onKeyDown={e=>e.key==="Enter"&&handleEmail()}/>
          </div>

          {error&&<div style={{background:T.redBg,border:`1px solid ${T.red}44`,borderRadius:8,padding:"10px 14px",fontSize:13,color:T.red,marginBottom:16}}>{error}</div>}

          <button onClick={handleEmail} disabled={loading} style={{...BtnPrimary(T),width:"100%",justifyContent:"center",padding:"13px",fontSize:15,opacity:loading?0.6:1}}>
            {loading?"Cargando...":(mode==="login"?"Iniciar sesión":"Crear cuenta")}
          </button>

          <div style={{textAlign:"center",marginTop:18,fontSize:13,color:T.textMd}}>
            {mode==="login"?<>¿No tenés cuenta? <button onClick={()=>{setMode("register");setError("");}} style={{background:"none",border:"none",color:T.accent,fontWeight:600,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",fontSize:13}}>Registrate</button></>
            :<>¿Ya tenés cuenta? <button onClick={()=>{setMode("login");setError("");}} style={{background:"none",border:"none",color:T.accent,fontWeight:600,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",fontSize:13}}>Iniciá sesión</button></>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// CONFIG SCREEN
// ═══════════════════════════════════════════
function ConfigScreen({T, user, onBack}) {
  const [userDoc,setUserDoc]=useState(null);
  const [saving,setSaving]=useState(false);
  const [msg,setMsg]=useState("");
  const iS=InputStyle(T);

  useEffect(()=>{
    if(!user) return;
    const unsub=onSnapshot(doc(db,"users",user.uid),snap=>{
      if(snap.exists()) setUserDoc(snap.data());
    });
    return ()=>unsub();
  },[user]);

  async function handleSignOut() {
    await signOut(auth);
  }

  async function connectTiendaNube() {
    const clientId = "30036";
    const redirectUri = encodeURIComponent(`${window.location.origin}/api/tn-callback`);
    const state = encodeURIComponent(user.uid);
    const url = `https://www.tiendanube.com/apps/${clientId}/authorize?state=${state}&redirect_uri=${redirectUri}`;
    window.open(url, "_blank");
    setMsg("Completá la autorización en la ventana que se abrió. Una vez autorizado, tu tienda aparecerá conectada.");
  }

  async function disconnectStore(storeType) {
    if(!window.confirm(`¿Desvincular ${storeType}?`)) return;
    setSaving(true);
    const stores=(userDoc?.stores||[]).filter(s=>s.type!==storeType);
    await updateDoc(doc(db,"users",user.uid),{stores});
    setSaving(false);
    setMsg(`${storeType} desvinculado.`);
  }

  async function toggleAlerta(key) {
    const current=userDoc?.alertas||{recordatorio:true,sinrespuesta:true,contenido:true};
    const updated={...current,[key]:!current[key]};
    await updateDoc(doc(db,"users",user.uid),{alertas:updated});
  }

  const tnStore=userDoc?.stores?.find(s=>s.type==="tiendanube");
  const shStore=userDoc?.stores?.find(s=>s.type==="shopify");
  const alertasCfg=userDoc?.alertas||{recordatorio:true,sinrespuesta:true,contenido:true};

  const Toggle=({active,onToggle})=>(
    <div onClick={onToggle} style={{width:44,height:24,borderRadius:20,background:active?T.accentSolid:T.border,cursor:"pointer",position:"relative",transition:"background 0.2s",flexShrink:0}}>
      <div style={{position:"absolute",top:3,left:active?22:3,width:18,height:18,borderRadius:"50%",background:"#fff",transition:"left 0.2s",boxShadow:"0 1px 4px rgba(0,0,0,0.3)"}}/>
    </div>
  );

  return (
    <div style={{fontFamily:"'Inter',system-ui,sans-serif",background:T.bg,minHeight:"100vh",color:T.text}}>
      <div style={{borderBottom:`1px solid ${T.border}`,background:T.surface,padding:"0 16px"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",height:56,maxWidth:800,margin:"0 auto"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <button onClick={onBack} style={{...BtnSecondary(T),padding:"6px 12px",fontSize:13}}>← Volver</button>
            <span style={{fontWeight:700,fontSize:15,color:T.text}}>⚙️ Configuración</span>
          </div>
        </div>
      </div>

      <div style={{maxWidth:800,margin:"0 auto",padding:"20px 16px 80px"}}>

        {/* Perfil */}
        <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"20px",marginBottom:16}}>
          <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.6,marginBottom:14}}>Cuenta</div>
          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16,flexWrap:"wrap"}}>
            {user?.photoURL?<img src={user.photoURL} style={{width:44,height:44,borderRadius:"50%",border:`2px solid ${T.border}`,flexShrink:0}} alt=""/>:<div style={{width:44,height:44,borderRadius:"50%",background:T.surface,border:`2px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>👤</div>}
            <div style={{minWidth:0}}>
              <div style={{fontSize:15,fontWeight:700,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{user?.displayName||userDoc?.nombre||"Usuario"}</div>
              <div style={{fontSize:12,color:T.textSm,marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{user?.email}</div>
              <div style={{fontSize:11,color:T.accent,marginTop:3,fontWeight:500}}>Plan {userDoc?.plan||"free"}</div>
            </div>
          </div>
          <button onClick={handleSignOut} style={{...BtnDanger(T),fontSize:13,width:"100%",justifyContent:"center"}}>Cerrar sesión</button>
        </div>

        {/* Tiendas */}
        <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"20px",marginBottom:16}}>
          <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.6,marginBottom:14}}>Tiendas conectadas</div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"14px 0",borderBottom:`1px solid ${T.borderL}`,gap:10}}>
            <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>
              <div style={{width:36,height:36,borderRadius:8,background:"#00a0e3",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>☁️</div>
              <div style={{minWidth:0}}>
                <div style={{fontSize:14,fontWeight:700,color:T.text}}>Tienda Nube</div>
                {tnStore?<div style={{fontSize:11,color:T.green,marginTop:1}}>✓ {tnStore.storeName||tnStore.storeId}</div>:<div style={{fontSize:11,color:T.textSm,marginTop:1}}>No conectado</div>}
              </div>
            </div>
            {tnStore
              ?<button onClick={()=>disconnectStore("tiendanube")} disabled={saving} style={{...BtnDanger(T),fontSize:12,padding:"6px 12px",flexShrink:0}}>Desvincular</button>
              :<button onClick={connectTiendaNube} style={{...BtnPrimary(T),fontSize:12,padding:"6px 12px",flexShrink:0}}>Conectar</button>
            }
          </div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"14px 0",gap:10}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <div style={{width:36,height:36,borderRadius:8,background:"#96BF48",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>🛍️</div>
              <div>
                <div style={{fontSize:14,fontWeight:700,color:T.text}}>Shopify</div>
                <div style={{fontSize:11,color:T.textSm,marginTop:1}}>Próximamente</div>
              </div>
            </div>
            <button disabled style={{...BtnSecondary(T),fontSize:12,padding:"6px 12px",opacity:0.4,flexShrink:0}}>Próximamente</button>
          </div>
        </div>

        {/* Alertas de Canjes */}
        <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"20px",marginBottom:16}}>
          <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.6,marginBottom:14}}>Alertas de canjes</div>
          {[
            {key:"recordatorio",icon:"⏰",label:"Recordatorios vencidos",desc:"Avisar cuando un recordatorio de seguimiento pasó su fecha"},
            {key:"sinrespuesta",icon:"📦",label:"Enviados sin respuesta",desc:"Avisar cuando un canje lleva +15 días enviado sin respuesta"},
            {key:"contenido",icon:"🎬",label:"Contenido pendiente",desc:"Avisar cuando un influencer debe contenido y no lo entregó"},
          ].map(a=>(
            <div key={a.key} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 0",borderBottom:`1px solid ${T.borderL}`,gap:12}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:14,fontWeight:600,color:T.text,display:"flex",alignItems:"center",gap:7}}><span>{a.icon}</span>{a.label}</div>
                <div style={{fontSize:12,color:T.textSm,marginTop:3,lineHeight:1.4}}>{a.desc}</div>
              </div>
              <Toggle active={alertasCfg[a.key]!==false} onToggle={()=>toggleAlerta(a.key)}/>
            </div>
          ))}
        </div>

        {msg&&<div style={{background:T.greenBg,border:`1px solid ${T.green}44`,borderRadius:10,padding:"12px 16px",fontSize:13,color:T.green,marginBottom:16}}>{msg}</div>}

        {/* Plan / Suscripción */}
        <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"20px",marginBottom:16}}>
          <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.6,marginBottom:16}}>Plan actual</div>

          {/* Plan cards */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:12,marginBottom:16}}>
            {/* Free */}
            <div style={{border:`2px solid ${userDoc?.plan==="free"||!userDoc?.plan?T.accentSolid:T.border}`,borderRadius:12,padding:"18px 20px",position:"relative",background:userDoc?.plan==="free"||!userDoc?.plan?T.accentSolid+"0a":T.bg}}>
              {(userDoc?.plan==="free"||!userDoc?.plan)&&<div style={{position:"absolute",top:-10,left:16,background:T.accentSolid,color:"#fff",fontSize:10,fontWeight:700,borderRadius:20,padding:"2px 10px"}}>PLAN ACTUAL</div>}
              <div style={{fontSize:17,fontWeight:800,color:T.text,marginBottom:4}}>Free</div>
              <div style={{fontSize:26,fontWeight:800,color:T.text,letterSpacing:-1,marginBottom:12}}>$0<span style={{fontSize:13,fontWeight:400,color:T.textSm}}>/mes</span></div>
              <div style={{display:"flex",flexDirection:"column",gap:7,marginBottom:16}}>
                {["1 tienda conectada","Gestión de reclamos","Gestión de canjes","Hasta 500 pedidos/mes"].map(f=>(
                  <div key={f} style={{display:"flex",alignItems:"center",gap:7,fontSize:13,color:T.textMd}}>
                    <span style={{color:T.green,fontSize:12}}>✓</span>{f}
                  </div>
                ))}
                {["Meta Ads automático","Publicación de campañas","Soporte prioritario"].map(f=>(
                  <div key={f} style={{display:"flex",alignItems:"center",gap:7,fontSize:13,color:T.textSm}}>
                    <span style={{color:T.textSm,fontSize:12}}>✕</span>{f}
                  </div>
                ))}
              </div>
              <div style={{fontSize:12,color:T.textSm,fontStyle:"italic"}}>Plan gratuito para siempre</div>
            </div>

            {/* Total */}
            <div style={{border:`2px solid ${userDoc?.plan==="total"?T.accentSolid:T.border}`,borderRadius:12,padding:"18px 20px",position:"relative",background:userDoc?.plan==="total"?T.accentSolid+"0a":T.bg}}>
              {userDoc?.plan==="total"&&<div style={{position:"absolute",top:-10,left:16,background:T.accentSolid,color:"#fff",fontSize:10,fontWeight:700,borderRadius:20,padding:"2px 10px"}}>PLAN ACTUAL</div>}
              <div style={{position:"absolute",top:-10,right:16,background:`linear-gradient(135deg,${T.accentSolid},${T.purple})`,color:"#fff",fontSize:10,fontWeight:700,borderRadius:20,padding:"2px 10px"}}>⚡ RECOMENDADO</div>
              <div style={{fontSize:17,fontWeight:800,color:T.text,marginBottom:4}}>Total</div>
              <div style={{fontSize:26,fontWeight:800,color:T.text,letterSpacing:-1,marginBottom:12}}>$29<span style={{fontSize:13,fontWeight:400,color:T.textSm}}>/mes</span></div>
              <div style={{display:"flex",flexDirection:"column",gap:7,marginBottom:16}}>
                {["Tiendas ilimitadas","Gestión de reclamos","Gestión de canjes","Pedidos ilimitados","Meta Ads automático","Publicación de campañas","Reportes avanzados","Soporte prioritario"].map(f=>(
                  <div key={f} style={{display:"flex",alignItems:"center",gap:7,fontSize:13,color:T.textMd}}>
                    <span style={{color:T.green,fontSize:12}}>✓</span>{f}
                  </div>
                ))}
              </div>
              {userDoc?.plan==="total"
                ?<AsyncButton onClick={async()=>{if(window.confirm("¿Cancelar suscripción Total?"))await updateDoc(doc(db,"users",user.uid),{plan:"free"});}} style={{...BtnDanger(T),width:"100%",justifyContent:"center",fontSize:13}}>Cancelar suscripción</AsyncButton>
                :<button onClick={()=>{setMsg("Próximamente podrás suscribirte al plan Total. Te avisaremos cuando esté disponible! 🚀");}} style={{...BtnPrimary(T),width:"100%",justifyContent:"center",fontSize:13}}>Quiero el plan Total</button>
              }
            </div>
          </div>
          <div style={{fontSize:12,color:T.textSm,textAlign:"center"}}>¿Preguntas sobre los planes? Escribinos a <span style={{color:T.accent}}>hola@growith.app</span></div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════

// ═══════════════════════════════════════════
// APP PLANES — Página de suscripción
// ═══════════════════════════════════════════
function AppPlanes({T, user, userPlan, planExpiry, onBack, USDT_ADDRESS, SUPPORT_EMAIL}) {
  const iS=InputStyle(T);
  const [step,setStep]=useState("planes"); // planes | pago | enviado
  const [planSel,setPlanSel]=useState(null);
  const [comprobante,setComprobante]=useState("");
  const [txHash,setTxHash]=useState("");
  const [sending,setSending]=useState(false);

  const PLANES=[
    {id:"starter",nombre:"Starter",precio:9,color:T.yellow,icon:"⭐",desc:"Para empezar",features:["Gestión de Reclamos","Buscador de pedidos","Hasta 100 pedidos/mes"]},
    {id:"pro",nombre:"Pro",precio:19,color:T.blue,icon:"🚀",desc:"El más popular",popular:true,features:["Todo lo de Starter","Gestión de Envíos completa","Exportar etiquetas Andreani","Canjes e influencers","Sin límite de pedidos"]},
    {id:"total",nombre:"Total",precio:39,color:T.purple,icon:"💎",desc:"Máximo poder",features:["Todo lo de Pro","Soporte prioritario","Acceso anticipado a nuevas funciones","Multi-tienda (próximamente)"]},
  ];

  const planActual=PLANES.find(p=>p.id===userPlan);
  const planSelecc=PLANES.find(p=>p.id===planSel);

  async function enviarComprobante() {
    if(!txHash&&!comprobante) return alert("Completá el hash de transacción o adjuntá comprobante");
    setSending(true);
    try {
      // Guardar solicitud en Firestore
      await addDoc(collection(db,"pagos"),{
        uid: user.uid,
        email: user.email,
        plan: planSel,
        txHash,
        comprobante,
        estado: "pendiente",
        createdAt: serverTimestamp(),
      });
      setStep("enviado");
    } catch(e){ alert("Error: "+e.message); }
    setSending(false);
  }

  if(step==="enviado") return (
    <div style={{fontFamily:"'Inter',system-ui,sans-serif",background:T.bg,minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div style={{textAlign:"center",maxWidth:420}}>
        <div style={{fontSize:64,marginBottom:20}}>✅</div>
        <div style={{fontSize:22,fontWeight:800,color:T.text,marginBottom:8}}>¡Comprobante enviado!</div>
        <div style={{fontSize:14,color:T.textMd,marginBottom:24,lineHeight:1.6}}>Revisaremos tu pago y activaremos tu plan <strong>{planSelecc?.nombre}</strong> en las próximas horas. Te notificaremos por email a {user?.email}.</div>
        <button onClick={onBack} style={{...BtnPrimary(T),justifyContent:"center",width:"100%"}}>Volver al inicio</button>
      </div>
    </div>
  );

  if(step==="pago") return (
    <div style={{fontFamily:"'Inter',system-ui,sans-serif",background:T.bg,minHeight:"100vh",padding:"0 0 64px"}}>
      <div style={{borderBottom:`0.5px solid ${T.border}`,background:T.surface,padding:"0 20px",height:60,display:"flex",alignItems:"center",gap:12}}>
        <button onClick={()=>setStep("planes")} style={{...BtnSecondary(T),padding:"6px 12px",fontSize:13}}>← Volver</button>
        <span style={{fontWeight:700,fontSize:15,color:T.text}}>Pagar plan {planSelecc?.nombre}</span>
      </div>
      <div style={{maxWidth:480,margin:"0 auto",padding:"32px 20px"}}>
        {/* Resumen */}
        <div style={{background:T.card,border:`0.5px solid ${planSelecc?.color}44`,borderLeft:`3px solid ${planSelecc?.color}`,borderRadius:12,padding:"18px 20px",marginBottom:24}}>
          <div style={{fontSize:13,color:T.textSm,marginBottom:4}}>Plan seleccionado</div>
          <div style={{fontSize:20,fontWeight:700,color:planSelecc?.color}}>{planSelecc?.icon} {planSelecc?.nombre} — ${planSelecc?.precio} USDT/mes</div>
        </div>

        {/* Dirección USDT */}
        <div style={{marginBottom:24}}>
          <div style={{fontSize:12,fontWeight:600,color:T.textSm,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:10}}>Enviá exactamente ${planSelecc?.precio} USDT (TRC20) a esta dirección:</div>
          <div style={{background:T.surface,border:`0.5px solid ${T.border}`,borderRadius:10,padding:"14px 16px",display:"flex",alignItems:"center",gap:10}}>
            <code style={{flex:1,fontSize:12,color:T.text,wordBreak:"break-all",fontFamily:"monospace"}}>{USDT_ADDRESS}</code>
            <button onClick={()=>{navigator.clipboard.writeText(USDT_ADDRESS);}} style={{...BtnSecondary(T),padding:"6px 10px",fontSize:12,flexShrink:0}}>📋 Copiar</button>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:6,marginTop:8,padding:"8px 12px",background:T.yellowBg,border:`0.5px solid ${T.yellow}44`,borderRadius:8}}>
            <span style={{fontSize:14}}>⚠️</span>
            <span style={{fontSize:12,color:T.yellow}}>Solo enviar USDT en la red TRC20. Otras redes no son compatibles.</span>
          </div>
        </div>

        {/* Comprobante */}
        <div style={{marginBottom:20}}>
          <div style={{fontSize:12,fontWeight:600,color:T.textSm,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:8}}>Hash de transacción (TxID)</div>
          <input style={{...iS,fontSize:13,fontFamily:"monospace"}} placeholder="Pegá el hash de la transacción aquí..." value={txHash} onChange={e=>setTxHash(e.target.value)}/>
          <div style={{fontSize:11,color:T.textSm,marginTop:6}}>Lo encontrás en tu wallet después de enviar. Ejemplo: abc123def456...</div>
        </div>
        <div style={{marginBottom:28}}>
          <div style={{fontSize:12,fontWeight:600,color:T.textSm,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:8}}>Nota adicional (opcional)</div>
          <textarea style={{...iS,minHeight:80,resize:"vertical",fontSize:13}} placeholder="Algún dato adicional, screenshot URL, etc..." value={comprobante} onChange={e=>setComprobante(e.target.value)}/>
        </div>

        <AsyncButton onClick={enviarComprobante} style={{...BtnPrimary(T),width:"100%",justifyContent:"center",fontSize:15,padding:"13px"}}>
          Enviar comprobante para activar plan
        </AsyncButton>
        <div style={{textAlign:"center",fontSize:12,color:T.textSm,marginTop:12}}>Tu plan se activa en menos de 24hs hábiles una vez confirmado el pago.</div>
      </div>
    </div>
  );

  return (
    <div style={{fontFamily:"'Inter',system-ui,sans-serif",background:T.bg,minHeight:"100vh",padding:"0 0 64px"}}>
      {/* Topbar */}
      <div style={{borderBottom:`0.5px solid ${T.border}`,background:T.surface,padding:"0 20px",height:60,display:"flex",alignItems:"center",gap:12,position:"sticky",top:0,zIndex:100}}>
        <button onClick={onBack} style={{...BtnSecondary(T),padding:"6px 12px",fontSize:13}}>← Inicio</button>
        <span style={{fontWeight:700,fontSize:15,color:T.text}}>Planes y suscripción</span>
      </div>

      <div style={{maxWidth:860,margin:"0 auto",padding:"40px 20px"}}>
        {/* Plan actual */}
        {userPlan!=="free"&&planActual&&(
          <div style={{background:T.card,border:`0.5px solid ${planActual.color}44`,borderLeft:`3px solid ${planActual.color}`,borderRadius:12,padding:"16px 20px",marginBottom:32,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
            <div>
              <div style={{fontSize:12,color:T.textSm,marginBottom:2}}>Plan activo</div>
              <div style={{fontSize:18,fontWeight:700,color:planActual.color}}>{planActual.icon} {planActual.nombre}</div>
              {planExpiry&&<div style={{fontSize:12,color:T.textSm,marginTop:2}}>Vence: {planExpiry.toLocaleDateString("es-AR",{day:"2-digit",month:"2-digit",year:"numeric"})}</div>}
            </div>
            <div style={{fontSize:13,color:T.textSm}}>¿Querés cambiar de plan? Seleccioná uno abajo.</div>
          </div>
        )}

        <div style={{textAlign:"center",marginBottom:40}}>
          <div style={{fontSize:28,fontWeight:800,color:T.text,letterSpacing:-0.5,marginBottom:8}}>Elegí tu plan</div>
          <div style={{fontSize:15,color:T.textMd}}>Pagos en USDT (TRC20) · Sin suscripción automática · Se activa en 24hs</div>
        </div>

        {/* Cards de planes */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(240px,1fr))",gap:16,marginBottom:40}}>
          {PLANES.map(p=>(
            <div key={p.id} style={{background:T.card,border:`0.5px solid ${planSel===p.id?p.color:p.popular?p.color+"44":T.border}`,borderTop:p.popular?`3px solid ${p.color}`:"none",borderRadius:14,padding:"24px 20px",position:"relative",cursor:"pointer",transition:"all 0.15s",boxShadow:planSel===p.id?`0 0 0 2px ${p.color}33`:""}}
              onClick={()=>setPlanSel(p.id)}>
              {p.popular&&<div style={{position:"absolute",top:-1,left:"50%",transform:"translateX(-50%) translateY(-50%)",background:p.color,color:"#fff",fontSize:10,fontWeight:700,padding:"3px 10px",borderRadius:20}}>MÁS POPULAR</div>}
              <div style={{fontSize:28,marginBottom:12}}>{p.icon}</div>
              <div style={{fontSize:18,fontWeight:700,color:p.color,marginBottom:2}}>{p.nombre}</div>
              <div style={{fontSize:12,color:T.textSm,marginBottom:16}}>{p.desc}</div>
              <div style={{fontSize:32,fontWeight:800,color:T.text,letterSpacing:-1,marginBottom:4}}>${p.precio}</div>
              <div style={{fontSize:12,color:T.textSm,marginBottom:20}}>USDT / mes</div>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {p.features.map((f,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"flex-start",gap:8,fontSize:13,color:T.textMd}}>
                    <span style={{color:p.color,flexShrink:0,marginTop:1}}>✓</span>{f}
                  </div>
                ))}
              </div>
              {planSel===p.id&&<div style={{marginTop:16,padding:"6px 0",textAlign:"center",fontSize:12,fontWeight:600,color:p.color}}>✓ Seleccionado</div>}
            </div>
          ))}
        </div>

        {planSel&&(
          <div style={{textAlign:"center"}}>
            <button onClick={()=>setStep("pago")} style={{...BtnPrimary(T),fontSize:15,padding:"13px 32px",justifyContent:"center"}}>
              Continuar con plan {planSelecc?.nombre} →
            </button>
          </div>
        )}

        <div style={{marginTop:40,padding:"20px",background:T.surface,borderRadius:12,textAlign:"center"}}>
          <div style={{fontSize:13,color:T.textSm}}>¿Dudas? Escribinos a <a href={`mailto:${SUPPORT_EMAIL}`} style={{color:T.accent}}>{SUPPORT_EMAIL}</a></div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// APP ADMIN — Panel de administrador
// ═══════════════════════════════════════════
function AppAdmin({T, user, onBack}) {
  const iS=InputStyle(T);
  const [usuarios,setUsuarios]=useState([]);
  const [pagos,setPagos]=useState([]);
  const [loading,setLoading]=useState(true);
  const [search,setSearch]=useState("");
  const [tab,setTab]=useState("pagos"); // pagos | usuarios

  useEffect(()=>{
    loadData();
  },[]);

  async function loadData() {
    setLoading(true);
    try {
      // Load pending payments
      const pagSnap=await getDocs(query(collection(db,"pagos"),orderBy("createdAt","desc")));
      setPagos(pagSnap.docs.map(d=>({_id:d.id,...d.data()})));
      // Load all users
      const usSnap=await getDocs(collection(db,"users"));
      setUsuarios(usSnap.docs.map(d=>({_id:d.id,...d.data()})));
    } catch(e){ alert("Error: "+e.message); }
    setLoading(false);
  }

  async function activarPlan(uid, plan, meses=1) {
    const expiry=new Date();
    expiry.setMonth(expiry.getMonth()+meses);
    await updateDoc(doc(db,"users",uid),{
      plan,
      planExpiry: expiry,
      planActivadoBy: user.uid,
      planActivadoAt: serverTimestamp(),
    });
    setUsuarios(u=>u.map(u2=>u2._id===uid?{...u2,plan,planExpiry:expiry}:u2));
    alert(`✅ Plan ${plan} activado para ${meses} mes${meses>1?"es":""}`);
  }

  async function desactivarPlan(uid) {
    if(!window.confirm("¿Desactivar plan?")) return;
    await updateDoc(doc(db,"users",uid),{plan:"free",planExpiry:null});
    setUsuarios(u=>u.map(u2=>u2._id===uid?{...u2,plan:"free",planExpiry:null}:u2));
  }

  async function confirmarPago(pagoId, uid, plan) {
    await activarPlan(uid, plan, 1);
    await updateDoc(doc(db,"pagos",pagoId),{estado:"confirmado",confirmadoBy:user.uid,confirmadoAt:serverTimestamp()});
    setPagos(p=>p.map(p2=>p2._id===pagoId?{...p2,estado:"confirmado"}:p2));
  }

  async function rechazarPago(pagoId) {
    if(!window.confirm("¿Rechazar pago?")) return;
    await updateDoc(doc(db,"pagos",pagoId),{estado:"rechazado"});
    setPagos(p=>p.map(p2=>p2._id===pagoId?{...p2,estado:"rechazado"}:p2));
  }

  const PLAN_C={free:T.textSm,starter:T.yellow,pro:T.blue,total:T.purple};
  const filteredUsers=usuarios.filter(u=>!search||(u.email||"").toLowerCase().includes(search.toLowerCase())||(u.nombre||"").toLowerCase().includes(search.toLowerCase()));
  const pagosPendientes=pagos.filter(p=>p.estado==="pendiente");

  return (
    <div style={{fontFamily:"'Inter',system-ui,sans-serif",background:T.bg,minHeight:"100vh",padding:"0 0 64px"}}>
      <div style={{borderBottom:`0.5px solid ${T.border}`,background:T.surface,padding:"0 20px",height:60,display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:100}}>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <button onClick={onBack} style={{...BtnSecondary(T),padding:"6px 12px",fontSize:13}}>← Inicio</button>
          <span style={{fontWeight:700,fontSize:15,color:T.yellow}}>👑 Panel Admin</span>
        </div>
        <AsyncButton onClick={loadData} style={{...BtnSecondary(T),fontSize:12,padding:"6px 12px"}}>⟳ Recargar</AsyncButton>
      </div>

      <div style={{maxWidth:900,margin:"0 auto",padding:"24px 20px"}}>
        {/* Stats */}
        <div style={{display:"flex",gap:12,marginBottom:24,flexWrap:"wrap"}}>
          {[
            {label:"Pagos pendientes",value:pagosPendientes.length,color:T.yellow},
            {label:"Usuarios Pro",value:usuarios.filter(u=>u.plan==="pro").length,color:T.blue},
            {label:"Usuarios Total",value:usuarios.filter(u=>u.plan==="total").length,color:T.purple},
            {label:"Total usuarios",value:usuarios.length,color:T.textMd},
          ].map((s,i)=>(
            <div key={i} style={{background:T.card,border:`0.5px solid ${T.border}`,borderLeft:`3px solid ${s.color}`,borderRadius:10,padding:"14px 18px",flex:"1 1 120px",minWidth:110}}>
              <div style={{fontSize:24,fontWeight:700,color:s.color}}>{s.value}</div>
              <div style={{fontSize:11,color:T.textSm,marginTop:3,textTransform:"uppercase",letterSpacing:"0.04em"}}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div style={{display:"flex",background:T.surface,borderRadius:10,padding:3,gap:0,marginBottom:20,width:"fit-content"}}>
          {[["pagos",`Pagos${pagosPendientes.length>0?` (${pagosPendientes.length})`:""}`],["usuarios","Usuarios"]].map(([id,label])=>(
            <button key={id} onClick={()=>setTab(id)} style={{padding:"7px 16px",borderRadius:8,fontSize:13,border:"none",background:tab===id?T.card:"transparent",color:tab===id?T.text:T.textMd,fontWeight:tab===id?600:400,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",boxShadow:tab===id?"0 1px 3px rgba(0,0,0,0.2)":"none"}}>{label}</button>
          ))}
        </div>

        {loading&&<div style={{textAlign:"center",padding:40}}><Spinner size={32} color={T.accent}/></div>}

        {/* PAGOS */}
        {!loading&&tab==="pagos"&&(
          <div>
            {pagos.length===0&&<div style={{textAlign:"center",padding:40,color:T.textSm}}>No hay pagos registrados</div>}
            {pagos.map(p=>{
              const u=usuarios.find(u=>u._id===p.uid);
              const fecha=p.createdAt?.toDate?.()?.toLocaleDateString("es-AR")||"—";
              return (
                <div key={p._id} style={{background:T.card,border:`0.5px solid ${p.estado==="pendiente"?T.yellow+"44":p.estado==="confirmado"?T.green+"44":T.border}`,borderRadius:12,padding:"16px 18px",marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:10}}>
                    <div>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                        <span style={{fontWeight:700,fontSize:14,color:T.text}}>{u?.email||p.email}</span>
                        <span style={{fontSize:11,padding:"2px 8px",borderRadius:5,fontWeight:600,background:p.estado==="pendiente"?T.yellowBg:p.estado==="confirmado"?T.greenBg:T.redBg,color:p.estado==="pendiente"?T.yellow:p.estado==="confirmado"?T.green:T.red}}>{p.estado}</span>
                      </div>
                      <div style={{fontSize:13,color:T.textMd}}>Plan solicitado: <strong style={{color:PLAN_C[p.plan]||T.text}}>{p.plan}</strong> · {fecha}</div>
                      {p.txHash&&<div style={{fontSize:12,color:T.textSm,fontFamily:"monospace",marginTop:4,wordBreak:"break-all"}}>TxID: {p.txHash}</div>}
                      {p.comprobante&&<div style={{fontSize:12,color:T.textSm,marginTop:4}}>Nota: {p.comprobante}</div>}
                    </div>
                    {p.estado==="pendiente"&&(
                      <div style={{display:"flex",gap:8,flexShrink:0}}>
                        <AsyncButton onClick={()=>confirmarPago(p._id,p.uid,p.plan)} style={{...BtnPrimary(T),fontSize:12,padding:"7px 14px"}}>✓ Confirmar y activar</AsyncButton>
                        <AsyncButton onClick={()=>rechazarPago(p._id)} style={{...BtnDanger(T),fontSize:12,padding:"7px 12px"}}>✕ Rechazar</AsyncButton>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* USUARIOS */}
        {!loading&&tab==="usuarios"&&(
          <div>
            <input style={{...iS,marginBottom:16,fontSize:13}} placeholder="Buscar por email o nombre..." value={search} onChange={e=>setSearch(e.target.value)}/>
            {filteredUsers.map(u=>{
              const expiry=u.planExpiry?.toDate?.()?.toLocaleDateString("es-AR")||null;
              return (
                <div key={u._id} style={{background:T.card,border:`0.5px solid ${T.border}`,borderRadius:10,padding:"14px 16px",marginBottom:8,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
                  <div>
                    <div style={{fontSize:13,fontWeight:600,color:T.text}}>{u.email||u.nombre}</div>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginTop:3}}>
                      <span style={{fontSize:11,padding:"2px 7px",borderRadius:5,fontWeight:600,background:u.plan==="free"?T.surface:u.plan==="pro"?T.blueBg:u.plan==="total"?T.purpleBg:T.yellowBg,color:PLAN_C[u.plan]||T.textSm}}>{u.plan||"free"}</span>
                      {expiry&&<span style={{fontSize:11,color:T.textSm}}>Vence: {expiry}</span>}
                    </div>
                  </div>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                    {["starter","pro","total"].map(plan=>(
                      <AsyncButton key={plan} onClick={()=>activarPlan(u._id,plan,1)} style={{...BtnSecondary(T),fontSize:11,padding:"5px 10px",color:plan==="starter"?T.yellow:plan==="pro"?T.blue:T.purple}}>
                        +1m {plan}
                      </AsyncButton>
                    ))}
                    {u.plan!=="free"&&<AsyncButton onClick={()=>desactivarPlan(u._id)} style={{...BtnDanger(T),fontSize:11,padding:"5px 10px"}}>Free</AsyncButton>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ROOT APP
// ═══════════════════════════════════════════
export default function App() {
  const [user,setUser]=useState(undefined); // undefined=loading, null=no auth, object=authed
  const [page,setPage]=useState("home");
  const [pendingCanje,setPendingCanje]=useState(null); // datos pre-cargados desde un pedido
  const [orders,setOrders]=useState([]);
  const [ordersStatus,setOrdersStatus]=useState("idle");
  const [totalOrdersCount,setTotalOrdersCount]=useState(null);
  const [fbStatus,setFbStatus]=useState("connecting");
  const [reclamosCount,setReclamosCount]=useState(0);
  const [canjesCount,setCanjesCount]=useState(0);
  const [alertas,setAlertas]=useState([]);
  const [darkMode,setDarkMode]=useState(()=>{ try { return localStorage.getItem("soluna_theme")!=="light"; } catch(e){ return true; } });
  const [migrated,setMigrated]=useState(false);
  const [userPlan,setUserPlan]=useState("free"); // free | starter | pro | total
  const [planExpiry,setPlanExpiry]=useState(null); // Date or null
  const [isAdmin,setIsAdmin]=useState(false);

  const ADMIN_UIDS=["WJH3ArqDPQcNLha9lOinvkVi9uJ2","ADMIN_UID_2"]; // ADMIN_UID_2: completar cuando tengas el segundo
  const USDT_ADDRESS="XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Dirección TRC20
  const SUPPORT_EMAIL="xxxxxx@gmail.com";

  const T = darkMode ? DARK : LIGHT;

  useEffect(()=>{
    document.title="Growith";
    const l=document.createElement("link");
    l.href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap";
    l.rel="stylesheet";
    document.head.appendChild(l);
    // Viewport meta for mobile
    let meta=document.querySelector('meta[name="viewport"]');
    if(!meta){meta=document.createElement("meta");meta.name="viewport";document.head.appendChild(meta);}
    meta.content="width=device-width, initial-scale=1, maximum-scale=1";
    // Global responsive styles
    const style=document.createElement("style");
    style.textContent=`
      *{box-sizing:border-box;}
      body{margin:0;overflow-x:hidden;}
      @media(max-width:600px){
        .hide-mobile{display:none!important;}
        .stack-mobile{flex-direction:column!important;}
        .full-mobile{width:100%!important;min-width:0!important;}
        .pad-mobile{padding:12px 14px!important;}
        .font-mobile{font-size:13px!important;}
      }
    `;
    document.head.appendChild(style);
  },[]);

  useEffect(()=>{
    document.body.style.margin="0";
    document.body.style.background=T.bg;
  },[T.bg]);

  useEffect(()=>{
    try { localStorage.setItem("soluna_theme", darkMode?"dark":"light"); } catch(e){}
  },[darkMode]);

  // Auth state listener
  useEffect(()=>{
    const unsub=onAuthStateChanged(auth, async (u)=>{
      setUser(u);
      if(u) {
        // Migrate legacy data for owner account
        if(u.email===OWNER_EMAIL && !migrated) {
          await migrateLegacyData(u.uid);
          setMigrated(true);
        }
        // Load plan from Firestore
        try {
          const userRef=doc(db,"users",u.uid);
          const userSnap=await getDoc(userRef);
          if(userSnap.exists()){
            const d=userSnap.data();
            setUserPlan(d.plan||"free");
            setPlanExpiry(d.planExpiry?.toDate?.()||null);
          }
          // Check admin
          setIsAdmin(["WJH3ArqDPQcNLha9lOinvkVi9uJ2","ADMIN_UID_2"].includes(u.uid));
        } catch(e){}
      } else {
        setUserPlan("free");
        setIsAdmin(false);
      }
    });
    return ()=>unsub();
  },[]);

  // Migrate existing data to owner's uid
  async function migrateLegacyData(uid) {
    try {
      // Check reclamos without ownerId
      const recSnap = await getDocs(query(collection(db,"reclamos"), where("ownerId","==",uid)));
      if(recSnap.empty) {
        // Assign ownerId to all existing reclamos
        const allRec = await getDocs(collection(db,"reclamos"));
        for(const d of allRec.docs) {
          if(!d.data().ownerId) await updateDoc(d.ref,{ownerId:uid});
        }
      }
      // Same for canjes
      const canSnap = await getDocs(query(collection(db,"canjes"), where("ownerId","==",uid)));
      if(canSnap.empty) {
        const allCan = await getDocs(collection(db,"canjes"));
        for(const d of allCan.docs) {
          if(!d.data().ownerId) await updateDoc(d.ref,{ownerId:uid});
        }
      }
    } catch(e){}
  }

  async function fetchOrders(uid, tab) {
    const targetUid = uid || user?.uid;
    if(!targetUid) return;
    setOrdersStatus("loading");
    try {
      const tabParam = tab ? `&tab=${tab}` : "";
      const res=await fetch(`/api/orders?uid=${targetUid}${tabParam}`);
      const data=await res.json();
      if(!Array.isArray(data)) throw new Error("Bad response");
      const built=buildOrdersFromAPI(data);
      setOrders(built);
      // Guardar en cache por tab
      if(tab) tabCacheRef.current[tab]=built;
      setOrdersStatus("ok");
    } catch(e){setOrdersStatus("error");}
  }

  // Fetch orders on login — fetch empaquetar tab por defecto + total count
  useEffect(()=>{
    if(!user) return;
    try{ localStorage.removeItem(`soluna_orders_${user.uid}`); localStorage.removeItem("soluna_orders_v3"); }catch(e){}
    fetchOrders(user.uid, "empaquetar");
    // Traer total de pedidos pagados para mostrar en Home y Reclamos
    fetch(`/api/orders?uid=${user.uid}&tab=total`)
      .then(r=>r.json())
      .then(d=>{ if(Array.isArray(d)) setTotalOrdersCount(d.length); })
      .catch(()=>{});
  },[user?.uid]);

  // Re-fetch when store connects/disconnects
  const prevTnRef=useRef(null);
  useEffect(()=>{
    if(!user) return;
    const unsub=onSnapshot(doc(db,"users",user.uid),snap=>{
      if(!snap.exists()) return;
      const tn=snap.data().stores?.find(s=>s.type==="tiendanube");
      const newId=tn?.storeId||null;
      if(prevTnRef.current!==null && prevTnRef.current!==newId) {
        try{ localStorage.removeItem(`soluna_orders_${user.uid}`); }catch(e){}
        setOrders([]);
        fetchOrders(user.uid, "empaquetar");
      }
      prevTnRef.current=newId;
    });
    return ()=>unsub();
  },[user?.uid]);

  useEffect(()=>{
    if(!user) return;
    const q1=query(collection(db,"reclamos"),where("ownerId","==",user.uid));
    const q2=query(collection(db,"canjes"),where("ownerId","==",user.uid));
    const u1=onSnapshot(q1,snap=>{setReclamosCount(snap.size);setFbStatus("ok");},()=>setFbStatus("error"));
    const u2=onSnapshot(q2,snap=>{
      const canjesData=snap.docs.map(d=>({...d.data(),_docId:d.id}));
      setCanjesCount(canjesData.length);
      getDoc(doc(db,"users",user.uid)).then(userSnap=>{
        const alertasCfg=userSnap.data()?.alertas||{recordatorio:true,sinrespuesta:true,contenido:true};
        const hoy=new Date().toISOString().split('T')[0];
        const hace15=new Date(Date.now()-15*86400000).toISOString().split('T')[0];
        const alerts=[];
        canjesData.forEach(c=>{
          if(alertasCfg.recordatorio!==false&&c.recordatorio&&c.recordatorio<=hoy) alerts.push({tipo:"recordatorio",canje:c,msg:`Recordatorio vencido`});
          if(alertasCfg.sinrespuesta!==false&&c.estado==="Enviado"&&c.fechaEnvio&&c.fechaEnvio<=hace15) alerts.push({tipo:"sinrespuesta",canje:c,msg:`Enviado hace +15 días sin respuesta`});
          if(alertasCfg.contenido!==false&&c.estado==="Contenido pendiente"){
            const cont=c.contenido||[];
            const total=cont.reduce((s,x)=>s+(x.acordados||0),0);
            const entregados=cont.reduce((s,x)=>s+(x.entregados||0),0);
            if(total>0&&entregados<total) alerts.push({tipo:"contenido",canje:c,msg:`Debe ${total-entregados} contenido(s)`});
          }
        });
        setAlertas(alerts);
      }).catch(()=>{});
    },()=>{});
    return ()=>{u1();u2();};
  },[user]);

  const themeBtn = (
    <button onClick={()=>setDarkMode(d=>!d)}
      style={{position:"fixed",bottom:24,right:24,zIndex:999,width:48,height:48,borderRadius:"50%",background:T.card,border:`1px solid ${T.border}`,fontSize:22,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 4px 16px rgba(0,0,0,0.2)",transition:"all 0.2s"}}
      title={darkMode?"Modo claro":"Modo oscuro"}>
      {darkMode?"☀️":"🌙"}
    </button>
  );

  // Loading
  if(user===undefined) return (
    <div style={{fontFamily:"'Inter',system-ui,sans-serif",background:T.bg,minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{textAlign:"center"}}>
        <div style={{fontSize:40,marginBottom:16}}>🌙</div>
        <div style={{fontSize:16,color:T.textMd}}>Cargando...</div>
      </div>
    </div>
  );

  // Not logged in
  if(!user) return <>{themeBtn}<AuthScreen T={T}/></>;

  // Config
  if(page==="planes") return <><AppPlanes T={T} user={user} userPlan={userPlan} planExpiry={planExpiry} onBack={()=>setPage("home")} USDT_ADDRESS={USDT_ADDRESS} SUPPORT_EMAIL={SUPPORT_EMAIL}/>{themeBtn}</>;
  if(page==="admin"&&isAdmin) return <><AppAdmin T={T} user={user} onBack={()=>setPage("home")}/>{themeBtn}</>;
  if(page==="config") return <>{themeBtn}<ConfigScreen T={T} user={user} onBack={()=>setPage("home")}/></>;

  // App
  if(page==="reclamos") return <><AppReclamos T={T} orders={orders} ordersStatus={ordersStatus} fetchOrders={fetchOrders} fbStatus={fbStatus} user={user} onHome={()=>setPage("home")} totalOrdersCount={totalOrdersCount} onGenerarCanje={(datos)=>{setPendingCanje(datos);setPage("canjes");}}/>{themeBtn}</>;
  if(page==="canjes") return <><AppCanjes T={T} fbStatus={fbStatus} user={user} onHome={()=>setPage("home")} pendingCanje={pendingCanje} onClearPendingCanje={()=>setPendingCanje(null)}/>{themeBtn}</>;
  if(page==="envios") return <><AppEnvios T={T} orders={orders} ordersStatus={ordersStatus} fetchOrders={(tab)=>fetchOrders(user?.uid,tab)} user={user} onHome={()=>setPage("home")} onGenerarCanje={(datos)=>{setPendingCanje(datos);setPage("canjes");}}/>{themeBtn}</>;
  return <><HomeScreen T={T} onNavigate={setPage} fbStatus={fbStatus} ordersCount={totalOrdersCount??orders.length} reclamosCount={reclamosCount} canjesCount={canjesCount} alertas={alertas} user={user} userPlan={userPlan} planExpiry={planExpiry} isAdmin={isAdmin}/>{themeBtn}</>;
}
