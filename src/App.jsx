import React, { useState, useEffect, useMemo, useRef } from "react";
import ReactDOM from "react-dom";
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

// --- Theme ---
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

// --- Constants ---
const MOTIVOS_R = ["Producto dañado","Color incorrecto","No cumple expectativas","Problema con el lente","Error en el pedido","Armazón roto","Otro"];
const ESTADOS_R = ["Nuevo","Contactado","Esperando producto","Producto recibido","Envío en camino","Resuelto","Rechazado"];
const TIPOS_R = ["Cambio","Devolución"];
const PRODUCTOS = ["Amarillo - Marco Negro","Amarillo - M. Transparente","Naranja - Marco Negro","Naranja - M. Transparente","Rojo - Marco Negro","Rojo - M. Transparente","Clip-On","Líquido Limpia Cristales"];
const SKU_LENTE = { "AMARILLO-NN":"Amarillo","AMARILLO-TT":"Amarillo","NARAN-NN":"Naranja","NARAN-TT":"Naranja","ROJ-NN":"Rojo","ROJ-TT":"Rojo","N-N":"Negro","N-R":"Negro/Rojo","R-R":"Rojo/Rojo","CLIP-ON":"Clip-On","LIQ":"Líquido" };
const LENTE_DOT = { Amarillo:"#fbbf24",Naranja:"#fb923c",Rojo:"#f87171",Negro:"#a1a1aa","Clip-On":"#c084fc",Líquido:"#60a5fa" };
const ESTADOS_C = ["Pendiente envío","Enviado","Contenido pendiente","Contenido entregado","Finalizado","Cancelado"];
const REDES = ["Instagram","TikTok","YouTube","Twitter/X","Otro"];
const ACTIVIDADES = ["Story","Reel","UGC","Review","Unboxing","Exp. Personal"];
const NICHOS = ["Fitness","Biohacking","Nutrición","Lifestyle","Wellness","Tech","Futbolista","Streamer","Otro"];
const PRODUCTOS_CANJE = ["Amarillo - Marco Negro","Amarillo - M. Transparente","Naranja - Marco Negro","Naranja - M. Transparente","Rojo - Marco Negro","Rojo - M. Transparente","Clip-On","Kit Completo","A elección"];

// --- Helpers ---
function fmtMoney(v) { const n=parseFloat(v); if(isNaN(n)) return '--'; return '$'+n.toLocaleString('es-AR',{minimumFractionDigits:0,maximumFractionDigits:0}); }
function fmtDate(d) { if(!d) return '--'; const p=d.split(' ')[0].split('/'); if(p.length===3) return `${p[0]}/${p[1]}/${p[2]}`; return d; }
function fmtTs(ts) { if(!ts?.seconds) return '--'; return new Date(ts.seconds*1000).toLocaleDateString('es-AR'); }
function fullAddress(o) { let a=o.direccion||''; if(o.dirNumero) a+=' '+o.dirNumero; if(o.piso) a+=', Piso '+o.piso; return [a,o.localidad,o.ciudad,o.cp?`CP ${o.cp}`:'',o.provincia].filter(Boolean).join(', '); }
function getLensColors(productos) { const s=new Set(); for(const p of productos){const c=SKU_LENTE[p.sku];if(c)s.add(c);} return [...s]; }
function mapEstadoEnvio(s) { return {"unpacked":"Por empaquetar","ready_to_ship":"Por enviar","shipped":"Enviado","delivered":"Entregado","unshipped":"Por empaquetar"}[s]||s||'--'; }
function mapEstadoPago(s) { return {"pending":"Pendiente","paid":"Pagado","voided":"Anulado","refunded":"Reembolsado","abandoned":"Abandonado"}[s]||s||'--'; }

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
    "Contenido entregado": { dot:T.purple, bg:T.purpleBg, text:T.purple },
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
    let estadoEnvio;
    const ps=o.payment_status;
    const ss=o.shipping_status;
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
      numero:String(o.number||o.id||""),
      fecha:o.created_at?new Date(o.created_at).toLocaleDateString('es-AR'):'',
      comprador:(`${sh.name||''} ${sh.last_name||''}`.trim()||o.contact_name||o.billing_address?.name||'').trim(),
      email:o.contact_email||o.billing_address?.email||'',
      telefono:o.contact_phone||o.billing_address?.phone||'',
      dni:o.contact_identification||'',
      estadoOrden:o.status||'', estadoPago:mapEstadoPago(o.payment_status||''),
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
      productos:Array.isArray(o.products)?o.products.map(p=>({
        nombre:p.name||p.product_name||'',
        precio:String(p.price||p.unit_price||''),
        cantidad:String(p.quantity||'1'),
        sku:p.sku||''
      })):[],
    };
  }).sort((a,b)=>parseInt(b.numero||0)-parseInt(a.numero||0));
}

// --- Andreani shared cache (module level) ---
const _andreaniLocsCache = { current: null };

// --- UI Components ---

// Inject spinner keyframe CSS once
if(typeof document!=="undefined"&&!document.getElementById("growith-spin")){
  const s=document.createElement("style");
  s.id="growith-spin";
  s.textContent=`
    /* -- Keyframes -- */
    @keyframes growith-spin    { to { transform: rotate(360deg); } }
    @keyframes growith-fadeIn  { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
    @keyframes growith-fadeInFast { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }
    @keyframes growith-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    @keyframes growith-skeleton{ 0%,100%{opacity:0.4} 50%{opacity:0.8} }
    @keyframes growith-toast-in{ from{opacity:0;transform:translateY(16px) scale(0.95)} to{opacity:1;transform:translateY(0) scale(1)} }
    @keyframes growith-slideIn { from{opacity:0;transform:translateX(-6px)} to{opacity:1;transform:translateX(0)} }
    @keyframes growith-scaleIn { from{opacity:0;transform:scale(0.97)} to{opacity:1;transform:scale(1)} }
    @keyframes growith-popIn   { from{opacity:0;transform:scale(0.94) translateY(6px)} to{opacity:1;transform:scale(1) translateY(0)} }

    /* -- Page / section transitions -- */
    .gh-page {
      animation: growith-fadeIn 0.22s cubic-bezier(0.22,1,0.36,1) both;
    }

    /* -- Tab content -- */
    .gh-tab-content {
      animation: growith-fadeInFast 0.18s cubic-bezier(0.22,1,0.36,1) both;
    }

    /* -- Buttons -- */
    button, a[role="button"] {
      transition: opacity 0.15s ease, transform 0.12s ease,
                  background 0.15s ease, border-color 0.15s ease,
                  box-shadow 0.15s ease !important;
    }
    button:not(:disabled):hover  { opacity: 0.88; }
    button:not(:disabled):active { transform: scale(0.95) !important; opacity: 0.75 !important; }
    button:disabled { cursor: not-allowed !important; opacity: 0.4 !important; }

    /* -- Links -- */
    a { transition: opacity 0.15s ease, color 0.15s ease !important; }
    a:active { opacity: 0.7 !important; }

    /* -- Inputs -- */
    input, textarea, select {
      transition: border-color 0.15s ease, box-shadow 0.18s ease !important;
    }
    input:focus, textarea:focus, select:focus {
      box-shadow: 0 0 0 3px rgba(124,58,237,0.14) !important;
      outline: none !important;
    }

    /* -- Clickable cards / rows -- */
    .gh-clickable {
      transition: background 0.15s ease, border-color 0.15s ease,
                  transform 0.18s cubic-bezier(0.22,1,0.36,1),
                  box-shadow 0.18s ease !important;
      cursor: pointer;
    }
    .gh-clickable:hover  { transform: translateY(-1px) !important; }
    .gh-clickable:active { transform: scale(0.98) !important; }

    .gh-row {
      transition: background 0.12s ease !important;
      cursor: pointer;
    }
    .gh-row:hover  { background: var(--gh-surface) !important; }
    .gh-row:active { background: var(--gh-card) !important; }

    /* -- Kanban cards -- */
    .gh-kanban-card {
      transition: transform 0.18s cubic-bezier(0.22,1,0.36,1),
                  box-shadow 0.18s ease, border-color 0.15s ease !important;
    }
    .gh-kanban-card:hover {
      transform: translateY(-2px) !important;
      box-shadow: 0 6px 24px rgba(0,0,0,0.2) !important;
    }

    /* -- Tabs -- */
    .gh-tab {
      transition: background 0.15s ease, color 0.15s ease,
                  border-color 0.15s ease, transform 0.12s ease !important;
    }
    .gh-tab:hover { transform: translateY(-1px) !important; }
    .gh-tab:active{ transform: scale(0.96) !important; }

    /* -- Chips / filters -- */
    .gh-chip {
      transition: all 0.16s cubic-bezier(0.22,1,0.36,1) !important;
    }
    .gh-chip:hover  { transform: translateY(-1px) !important; opacity: 0.88; }
    .gh-chip:active { transform: scale(0.95) !important; }

    /* -- Toggle switch -- */
    .gh-toggle        { transition: background 0.22s ease !important; cursor: pointer; }
    .gh-toggle-thumb  { transition: left 0.22s cubic-bezier(0.34,1.26,0.64,1) !important; }

    /* -- Modal backdrop -- */
    .gh-modal-backdrop {
      animation: growith-fadeIn 0.18s ease both;
    }

    /* -- List items staggered -- */
    .gh-list-item {
      animation: growith-fadeInFast 0.18s cubic-bezier(0.22,1,0.36,1) both;
    }

    /* -- Body theme transition -- */
    body { transition: background 0.22s ease !important; }

    /* -- Dark mode toggle smooth -- */
    * { transition: background-color 0s, color 0s; }
  `;
  document.head.appendChild(s);
}

// --- Toast system ---
let _toastSetters=[];
function useToast(){
  const [toasts,setToasts]=React.useState([]);
  React.useEffect(()=>{_toastSetters.push(setToasts);return()=>{_toastSetters=_toastSetters.filter(s=>s!==setToasts);};},[]);
  return toasts;
}
function toast(msg,type="success",duration=3000){
  const id=Date.now()+Math.random();
  _toastSetters.forEach(setter=>setter(prev=>[...prev,{id,msg,type}]));
  setTimeout(()=>{_toastSetters.forEach(setter=>setter(prev=>prev.filter(t=>t.id!==id)));},duration);
}
function ToastContainer({T}){
  const toasts=useToast();
  if(!toasts.length) return null;
  const colorMap={success:T.green,error:T.red,info:T.blue,warning:T.orange};
  return(
    <div style={{position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",zIndex:9999,display:"flex",flexDirection:"column",gap:8,alignItems:"center",pointerEvents:"none"}}>
      {toasts.map(t=>(
        <div key={t.id} style={{background:T.card,border:`1px solid ${colorMap[t.type]||T.green}55`,borderLeft:`3px solid ${colorMap[t.type]||T.green}`,borderRadius:10,padding:"10px 18px",fontSize:13,fontWeight:500,color:T.text,boxShadow:"0 4px 20px rgba(0,0,0,0.25)",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:8}}>
          <span style={{color:colorMap[t.type]||T.green,fontSize:15}}>{t.type==="success"?"✓":t.type==="error"?"✕":t.type==="warning"?"!":"i"}</span>
          {t.msg}
        </div>
      ))}
    </div>
  );
}

function Spinner({size=14,color="#fff",style={}}) {
  return (
    <span style={{display:"inline-block",width:size,height:size,border:`2px solid ${color}44`,borderTop:`2px solid ${color}`,borderRadius:"50%",animation:"growith-spin 0.7s linear infinite",flexShrink:0,...style}}/>
  );
}

// Animated page wrapper - triggers re-animation on key change
function PageView({children, pageKey}) {
  return (
    <div key={pageKey} className="gh-page" style={{flex:1}}>
      {children}
    </div>
  );
}

// Animated tab content wrapper
function TabView({children, tabKey}) {
  return (
    <div key={tabKey} className="gh-tab-content">
      {children}
    </div>
  );
}
// --- Shared AppTopbar ---
function AppTopbar({T, section, onHome, children}) {
  return (
    <div style={{borderBottom:`1px solid ${T.border}`,background:T.surface,padding:"0 24px",position:"sticky",top:0,zIndex:100}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",height:60,gap:16,maxWidth:1400,margin:"0 auto"}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <button onClick={onHome} style={{display:"flex",alignItems:"center",gap:6,padding:"6px 12px",fontSize:13,fontWeight:500,borderRadius:8,border:`1px solid ${T.border}`,background:"transparent",color:T.textMd,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",transition:"all 0.15s ease"}}
            onMouseEnter={e=>{e.currentTarget.style.background=T.card;e.currentTarget.style.color=T.text;}}
            onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=T.textMd;}}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
            Inicio
          </button>
          <span style={{color:T.borderL,fontSize:16,fontWeight:200}}>|</span>
          <span style={{fontWeight:700,fontSize:15,color:T.text,letterSpacing:-0.2}}>{section}</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          {children}
        </div>
      </div>
    </div>
  );
}

// --- Shared AppTabs - pill style ---
function AppTabs({T, tabs, active, onChange, size="normal"}) {
  const isLarge = size==="large";
  return (
    <div style={{background:T.surface,borderBottom:"1px solid "+T.border,padding:isLarge?"12px 24px":"10px 24px",position:"sticky",top:60,zIndex:99}}>
      <div style={{display:"inline-flex",background:T.bg,borderRadius:isLarge?12:10,padding:3,border:"1px solid "+T.border,gap:isLarge?3:2}}>
        {tabs.map(t=>{
          const isActive=active===t.id;
          return (
            <button key={t.id} onClick={()=>onChange(t.id)}
              style={{padding:isLarge?"10px 24px":"7px 18px",fontSize:isLarge?14:13,fontWeight:isActive?700:500,borderRadius:isLarge?10:8,border:"none",background:isActive?T.card:"transparent",color:isActive?T.text:T.textMd,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",display:"flex",alignItems:"center",gap:7,transition:"all 0.15s ease",boxShadow:isActive?"0 1px 4px rgba(0,0,0,0.15)":"none",whiteSpace:"nowrap"}}>
              {t.label}
              {t.badge!=null&&t.badge>0&&<span style={{fontSize:10,fontWeight:700,background:t.badgeColor||T.red,color:"#fff",borderRadius:4,padding:"1px 5px"}}>{t.badge}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}


// --- Avatar ---
function Avatar({src, name, size=36, radius=10, T}) {
  const [err, setErr] = React.useState(false);
  const initials = (name||"?").split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase();
  const colors = ["#7c3aed","#2563eb","#059669","#d97706","#dc2626","#9333ea","#0891b2"];
  const color = colors[(name||"").charCodeAt(0)%colors.length] || colors[0];
  if(src&&!err) return (
    <img src={src} alt={name||""} onError={()=>setErr(true)}
      style={{width:size,height:size,borderRadius:radius,objectFit:"cover",border:`1.5px solid rgba(255,255,255,0.08)`,flexShrink:0,display:"block"}}/>
  );
  return (
    <div style={{width:size,height:size,borderRadius:radius,background:color+"22",border:`1.5px solid ${color}44`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:size*0.35,fontWeight:700,color,letterSpacing:-0.5,fontFamily:"'Inter',system-ui,sans-serif"}}>
      {initials}
    </div>
  );
}

// --- Empty State ---
function EmptyState({T, icon, title, description, action}) {
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"80px 24px",textAlign:"center"}}>
      <div style={{width:64,height:64,borderRadius:16,background:T.surface,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,marginBottom:20}}>{icon}</div>
      <div style={{fontSize:17,fontWeight:700,color:T.text,marginBottom:8}}>{title}</div>
      {description&&<div style={{fontSize:14,color:T.textSm,maxWidth:320,lineHeight:1.6,marginBottom:action?20:0}}>{description}</div>}
      {action}
    </div>
  );
}



// AsyncButton - muestra spinner automáticamente mientras el onClick async procesa
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
  const [visible, setVisible] = React.useState(false);
  React.useEffect(()=>{
    if(open) { document.body.style.overflow='hidden'; requestAnimationFrame(()=>setVisible(true)); }
    else { document.body.style.overflow=''; setVisible(false); }
    return()=>{ document.body.style.overflow=''; };
  },[open]);
  if(!open) return null;
  return ReactDOM.createPortal(
    <div onClick={onClose} style={{position:"fixed",inset:0,background:`rgba(0,0,0,${visible?0.65:0})`,backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:zIndex,padding:16,transition:"background 0.2s ease",fontFamily:"'Inter',system-ui,sans-serif"}}>
      <div onClick={e=>e.stopPropagation()} style={{background:T.card,borderRadius:16,width:"100%",maxWidth:width||560,maxHeight:"90vh",overflow:"hidden",boxShadow:"0 32px 80px rgba(0,0,0,0.45)",border:`1px solid ${T.border}`,display:"flex",flexDirection:"column",transform:visible?"translateY(0) scale(1)":"translateY(16px) scale(0.97)",opacity:visible?1:0,transition:"transform 0.22s cubic-bezier(0.34,1.26,0.64,1), opacity 0.18s ease"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"20px 24px 16px",borderBottom:`1px solid ${T.borderL}`,flexShrink:0}}>
          <div style={{margin:0,fontSize:17,fontWeight:700,color:T.text,fontFamily:"'Inter',system-ui,sans-serif"}}>{title}</div>
          <button onClick={onClose} style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,width:32,height:32,fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",color:T.textMd}}>✕</button>
        </div>
        <div style={{padding:"18px 24px 24px",overflowY:"auto",flex:1}}>{children}</div>
      </div>
    </div>,
    document.body
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
    <div style={{background:T.card,border:`1px solid ${color&&color!==T.textMd?color+"33":T.border}`,borderRadius:12,padding:"14px 18px",flex:"1 1 110px",minWidth:110,position:"relative",overflow:"hidden",transition:"border-color 0.2s"}}>
      {color&&color!==T.textMd&&<div style={{position:"absolute",left:0,top:0,bottom:0,width:3,background:color,borderRadius:"3px 0 0 3px"}}/>}
      <div style={{fontSize:26,fontWeight:800,color:color||T.text,letterSpacing:-0.5,lineHeight:1}}>{value??<Spinner size={14} color={color||T.accent}/>}</div>
      <div style={{fontSize:11,color:T.textSm,marginTop:6,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em"}}>{label}</div>
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
function BtnSecondary(T) { return {border:`1px solid ${T.border}`,borderRadius:8,padding:"8px 14px",fontSize:13,fontWeight:400,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",transition:"all 0.12s",display:"inline-flex",alignItems:"center",gap:6,background:T.surface,color:T.text}; }
function BtnDanger(T) { return {border:`0.5px solid ${T.red}44`,borderRadius:8,padding:"8px 14px",fontSize:13,fontWeight:500,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",transition:"all 0.12s",display:"inline-flex",alignItems:"center",gap:6,background:T.redBg,color:T.red}; }
function BtnPurple(T) { return {border:`0.5px solid ${T.purple}44`,borderRadius:8,padding:"8px 14px",fontSize:13,fontWeight:500,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",transition:"all 0.12s",display:"inline-flex",alignItems:"center",gap:6,background:T.purpleBg,color:T.purple}; }

function OrderSearchField({T, orders, onSelect, uid}) {
  const [q,setQ]=useState("");
  const [apiResults,setApiResults]=useState([]);
  const [loading,setLoading]=useState(false);
  const inputRef=useRef(null);
  const iS = InputStyle(T);
  // Primero buscar en órdenes locales
  const localResults=useMemo(()=>{
    if(!q||q.length<2) return [];
    const s=q.toLowerCase().trim();
    return orders.filter(o=>
      o.numero.includes(s)||
      (o.comprador||"").toLowerCase().includes(s)||
      (o.email||"").toLowerCase().includes(s)||
      (o.telefono||"").includes(s)
    ).slice(0,8);
  },[q,orders]);
  // Si no hay resultados locales, buscar en API
  useEffect(()=>{
    if(!q||q.length<2){ setApiResults([]); return; }
    if(localResults.length>0){ setApiResults([]); return; } // hay locales, no buscar API
    const t=setTimeout(async()=>{
      setLoading(true);
      try{
        const r=await fetch(`/api/orders?uid=${uid||""}&q=${encodeURIComponent(q.trim())}`);
        const data=await r.json();
        if(Array.isArray(data)) setApiResults(buildOrdersFromAPI(data).slice(0,8));
      }catch(e){}
      setLoading(false);
    },400);
    return ()=>clearTimeout(t);
  },[q,localResults.length,uid]);

  const results=localResults.length>0?localResults:apiResults;
  useEffect(()=>{ if(inputRef.current) inputRef.current.focus(); },[]);

  return (
    <div>
      <div style={{position:"relative"}}>
        <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",color:T.textSm,fontSize:15}}>🔍</span>
        <input ref={inputRef} style={{...iS,paddingLeft:36}} placeholder="Nro de pedido, nombre o email..." value={q} onChange={e=>setQ(e.target.value)}/>
        {loading&&<span style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)"}}><Spinner size={13} color={T.textSm}/></span>}
      </div>
      {q.length>=2&&results.length>0&&(
        <div style={{marginTop:6,background:T.bg,border:`1px solid ${T.border}`,borderRadius:12,maxHeight:300,overflow:"auto"}}>
          {localResults.length===0&&apiResults.length>0&&<div style={{padding:"6px 14px",fontSize:10,color:T.textSm,borderBottom:`1px solid ${T.borderL}`,textTransform:"uppercase",letterSpacing:0.5}}>Resultados de TN</div>}
          {results.map((o,i)=>(
            <div key={o.numero} onClick={()=>onSelect(o.numero)} style={{padding:"12px 16px",cursor:"pointer",borderTop:i>0?`1px solid ${T.borderL}`:"none",transition:"background 0.1s"}} onMouseEnter={e=>e.currentTarget.style.background=T.surface} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10}}>
                <div style={{display:"flex",gap:10,alignItems:"center"}}>
                  <span style={{fontWeight:700,color:T.accent,fontSize:14}}>#{o.numero}</span>
                  <span style={{color:T.text,fontSize:14,fontWeight:500}}>{o.comprador||"--"}</span>
                </div>
                <span style={{fontSize:12,color:T.textSm,flexShrink:0}}>{fmtDate(o.fecha)}</span>
              </div>
              {o.productos?.length>0&&<div style={{fontSize:12,color:T.textSm,marginTop:3}}>{o.productos.map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'')).join(', ')}</div>}
              {o.email&&<div style={{fontSize:11,color:T.textSm,marginTop:1}}>✉️ {o.email}</div>}
            </div>
          ))}
        </div>
      )}
      {q.length>=2&&!loading&&results.length===0&&<div style={{marginTop:6,padding:14,textAlign:"center",color:T.textSm,fontSize:14,border:`1px solid ${T.border}`,borderRadius:12}}>Sin resultados para "{q}"</div>}
      {q.length>=2&&loading&&results.length===0&&<div style={{marginTop:6,padding:14,textAlign:"center",color:T.textSm,fontSize:13,border:`1px solid ${T.border}`,borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",gap:8}}><Spinner size={13} color={T.textSm}/>Buscando en Tienda Nube...</div>}
    </div>
  );
}


// ===========================================
// APP RECLAMOS
// ===========================================
function AppReclamos({T, orders, ordersStatus, fetchOrders, fbStatus, user, onHome, totalOrdersCount, onGenerarCanje}) {
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
  const [slaConfig,setSlaConfig]=useState({dias:3}); // SLA configurable
  const [andreaniAlertas,setAndreaniAlertas]=useState([]); // [{docId, orderNum, tracking, estado}]
  const [andreaniChecked,setAndreaniChecked]=useState(false);

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
    {id:"p1",estado:"Nuevo",tipo:"Cambio",nombre:"Confirmar reclamo",mensaje:"Hola [nombre]! Te contactamos desde Soluna Biolight. Recibimos tu solicitud de cambio para el pedido #[pedido] ([producto]). ¿Podés confirmarnos el problema con tu producto? 🙏"},
    {id:"p2",estado:"Contactado",tipo:"Cambio",nombre:"Instrucciones de devolución",mensaje:"Hola [nombre]! Para procesar tu cambio del pedido #[pedido] necesitamos que nos devuelvas el producto. Te compartimos la dirección de envío: [dirección]. Por favor avisanos el tracking cuando lo envíes 📦"},
    {id:"p3",estado:"Esperando producto",tipo:"Cambio",nombre:"Seguimiento envío",mensaje:"Hola [nombre]! ¿Pudiste enviar el producto del pedido #[pedido]? Quedamos esperando el código de seguimiento para coordinar tu cambio 😊"},
    {id:"p4",estado:"Producto recibido",tipo:"Cambio",nombre:"Producto recibido",mensaje:"Hola [nombre]! Recibimos el producto del pedido #[pedido]. Estamos preparando tu cambio y te avisamos cuando esté en camino 🎉"},
    {id:"p5",estado:"Envío en camino",tipo:"Cambio",nombre:"Cambio enviado",mensaje:"Hola [nombre]! Tu nuevo producto ya está en camino 🚀 Tracking: [tracking]. Podés seguirlo en andreani.com. Cualquier consulta estamos acá!"},
    {id:"p6",estado:"Resuelto",tipo:"Cambio",nombre:"Cierre cambio",mensaje:"Hola [nombre]! Esperamos que hayas recibido tu producto y estés conforme ✨ Gracias por elegirnos! Cualquier consulta no dudes en escribirnos."},
    {id:"p7",estado:"Nuevo",tipo:"Devolución",nombre:"Confirmar devolución",mensaje:"Hola [nombre]! Recibimos tu solicitud de devolución del pedido #[pedido] por $[monto]. ¿Podés contarnos el motivo? Así agilizamos el proceso 🙏"},
    {id:"p8",estado:"Envío en camino",tipo:"Devolución",nombre:"Reembolso procesado",mensaje:"Hola [nombre]! Ya procesamos tu reembolso de $[monto] del pedido #[pedido]. En 3-5 días hábiles debería verse reflejado en tu cuenta. Gracias por tu paciencia 💜"},
  ];

  useEffect(()=>{
    if(!user?.uid) return;
    const q=query(collection(db,"reclamos"),where("ownerId","==",user.uid));
    const unsub1=onSnapshot(q,snap=>{
      const data=snap.docs.map(d=>({...d.data(),_docId:d.id}));
      data.sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
      setReclamos(data);
    },(err)=>{ console.error("[reclamos] snapshot error:", err); });
    const unsub2=onSnapshot(doc(db,"config","plantillas"),snap=>{
      if(snap.exists()) {
        setPlantillas(snap.data().lista||DEFAULT_PLANTILLAS);
        if(snap.data().sla) setSlaConfig(snap.data().sla);
      } else setPlantillas(DEFAULT_PLANTILLAS);
    },()=>setPlantillas(DEFAULT_PLANTILLAS));
    return ()=>{unsub1();unsub2();};
  },[user?.uid]);

  const emptyForm=(orderNum="", clienteData={})=>({
    _docId:null, orderNum, tipo:"Cambio", motivo:"", descripcion:"", estado:"Nuevo",
    resolucion:"", notas:"", trackingCambio:"", trackingDevolucion:"",
    productosRecibe:[{producto:"",cantidad:1}],
    productosEnvia:[{producto:"",cantidad:1}],
    historial:[],
    estadoRecepcion:"", estadoReembolso:"",
    // Datos del cliente - se guardan para no depender del pedido en memoria
    clienteNombre: clienteData.nombre||"",
    clienteEmail:  clienteData.email||"",
    clienteTelefono: clienteData.telefono||"",
    clienteProductos: clienteData.productos||[],   // array de strings cortos
    clienteTotal: clienteData.total||"",
  });

  async function saveReclamo() {
    if(!reclamoForm?.motivo||!reclamoForm?.orderNum) return;
    setSaving(true);
    try {
      const prev=reclamos.find(r=>r._docId===reclamoForm._docId);
      const estadoCambio=prev&&prev.estado!==reclamoForm.estado;
      const histEntry=estadoCambio?[...(reclamoForm.historial||[]),{accion:`Estado > ${reclamoForm.estado}`,fecha:new Date().toISOString()}]:reclamoForm.historial||[];
      const p={
        orderNum:reclamoForm.orderNum, tipo:reclamoForm.tipo, motivo:reclamoForm.motivo,
        descripcion:reclamoForm.descripcion||"", estado:reclamoForm.estado,
        resolucion:reclamoForm.resolucion||"", notas:reclamoForm.notas||"",
        trackingCambio:reclamoForm.trackingCambio||"",
        trackingDevolucion:reclamoForm.trackingDevolucion||"",
        productosRecibe:reclamoForm.productosRecibe||[],
        productosEnvia:reclamoForm.productosEnvia||[],
        historial:histEntry,
        estadoRecepcion:reclamoForm.estadoRecepcion||"",
        estadoReembolso:reclamoForm.estadoReembolso||"",
        // Datos del cliente siempre guardados en el reclamo
        clienteNombre:reclamoForm.clienteNombre||"",
        clienteEmail:reclamoForm.clienteEmail||"",
        clienteTelefono:reclamoForm.clienteTelefono||"",
        clienteProductos:reclamoForm.clienteProductos||[],
        clienteTotal:reclamoForm.clienteTotal||"",
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
    const entry={accion:`Estado > ${nuevoEstado}`,fecha:new Date().toISOString()};
    await updateDoc(doc(db,"reclamos",docId),{estado:nuevoEstado,historial:[...(r.historial||[]),entry],updatedAt:serverTimestamp(),...(nuevoEstado==="Resuelto"&&r.estado!=="Resuelto"?{resolvedAt:serverTimestamp()}:{})});
  }

  async function deleteReclamo(docId) {
    try{await deleteDoc(doc(db,"reclamos",docId));}catch(e){}
    setDeleteConfirm(null);setActiveReclamo(null);
  }

  // -- Andreani polling: chequear trackings de devolución pendientes --
  useEffect(()=>{
    if(!reclamos.length) return;
    // Solo monitorear reclamos con trackingDevolucion y estado no resuelto
    const pendientes = reclamos.filter(r =>
      r.trackingDevolucion &&
      r.trackingDevolucion.trim() &&
      !["Resuelto","Rechazado"].includes(r.estado)
    );
    if(!pendientes.length) { setAndreaniChecked(true); return; }

    async function checkAndreani() {
      const alertas = [];
      await Promise.all(pendientes.map(async (r) => {
        const tracking = r.trackingDevolucion.trim();
        try {
          const res = await fetch(
            `https://api.andreani.com/v2/ordenes/${tracking}`,
            { headers: { "Accept": "application/json" } }
          );
          // Andreani pública no requiere auth para consultas básicas
          if(!res.ok) {
            // Fallback: intentar endpoint de seguimiento
            const res2 = await fetch(
              `https://tracking.andreani.com/api/v1/seguimiento?tracking=${tracking}`,
              { headers: { "Accept": "application/json" } }
            );
            if(!res2.ok) return;
            const d2 = await res2.json();
            const estadoAndreani = d2?.estado || d2?.ultimoEvento?.estado || "";
            if(esEnSucursal(estadoAndreani)) alertas.push({docId:r._docId, orderNum:r.orderNum, tracking, estado:estadoAndreani, nombre:r.clienteNombre});
            return;
          }
          const d = await res.json();
          const estadoAndreani = d?.estado || d?.estadoActual || "";
          if(esEnSucursal(estadoAndreani)) alertas.push({docId:r._docId, orderNum:r.orderNum, tracking, estado:estadoAndreani, nombre:r.clienteNombre});
        } catch(_) {}
      }));
      setAndreaniAlertas(alertas);
      setAndreaniChecked(true);
      // Notificación del browser si hay paquetes listos
      if(alertas.length > 0) {
        dispararNotificacionBrowser(alertas);
      }
    }

    checkAndreani();
    // Re-chequear cada 30 minutos mientras la app está abierta
    const interval = setInterval(checkAndreani, 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, [reclamos.length]);

  function esEnSucursal(estado) {
    if(!estado) return false;
    const e = estado.toLowerCase();
    return e.includes("sucursal") || e.includes("retiro") || e.includes("disponible") || e.includes("listo") || e.includes("en agencia");
  }

  function dispararNotificacionBrowser(alertas) {
    if(!("Notification" in window)) return;
    const msg = alertas.length === 1
      ? `📦 Paquete listo para retirar - Tracking ${alertas[0].tracking} (Pedido #${alertas[0].orderNum})`
      : `📦 ${alertas.length} paquetes listos para retirar en sucursal`;
    if(Notification.permission === "granted") {
      new Notification("Growith - Andreani 📦", { body: msg, icon: "/favicon.ico" });
    } else if(Notification.permission !== "denied") {
      Notification.requestPermission().then(p => {
        if(p === "granted") new Notification("Growith - Andreani 📦", { body: msg, icon: "/favicon.ico" });
      });
    }
  }

  async function savePlantillas(lista, sla) {
    const newSla=sla||slaConfig;
    try{ await setDoc(doc(db,"config","plantillas"),{lista,sla:newSla}); }catch(e){}
    setPlantillas(lista);
    setSlaConfig(newSla);
  }

  function copyMensaje(plantilla,reclamo) {
    // Priorizar datos guardados en el reclamo; fallback a pedido en memoria
    const o=orders.find(o=>o.numero===reclamo.orderNum);
    const nombre=reclamo.clienteNombre||o?.comprador||reclamo.orderNum;
    const email=reclamo.clienteEmail||o?.email||"--";
    const telefono=reclamo.clienteTelefono||o?.telefono||"--";
    const productos=(reclamo.clienteProductos||o?.productos?.map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'').trim())||[]).join(', ')||"--";
    const monto=reclamo.clienteTotal||o?.total||"--";
    let msg=plantilla.mensaje
      .replace(/\[nombre\]/g, nombre)
      .replace(/\[pedido\]/g, reclamo.orderNum)
      .replace(/\[tracking\]/g, reclamo.trackingCambio||"--")
      .replace(/\[email\]/g, email)
      .replace(/\[telefono\]/g, telefono)
      .replace(/\[producto\]/g, productos)
      .replace(/\[monto\]/g, monto)
      .replace(/\[dirección\]/g, "Av. Ejemplo 1234, Buenos Aires");
    navigator.clipboard.writeText(msg);
    setCopiedMsg(plantilla.id);
    setTimeout(()=>setCopiedMsg(null),2000);
  }

  // Stats
  const hoy=new Date().toISOString().split('T')[0];
  const hace3=new Date(Date.now()-slaConfig.dias*86400000).toISOString().split('T')[0];
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

  // Global search - usa API de TN directamente, no depende de orders local
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
      const clean0=tel.startsWith('54')?tel.slice(2):tel.startsWith('0')?tel.slice(1):tel;
      // Quitar el 9 inicial de celulares argentinos (ej: 91156333118 → 1156333118)
      const clean=clean0.startsWith('9')&&clean0.length===10?clean0.slice(1):clean0;
      let telCod='',telNum='';
      if(clean.length>=10){telCod=clean.slice(0,clean.length-8);telNum=clean.slice(clean.length-8);}
      else if(clean.length>=8){telCod=clean.slice(0,clean.length-8)||'';telNum=clean.slice(clean.length-8);}
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

  // -- Render --
  return (
    <div style={{fontFamily:"'Inter',system-ui,sans-serif",background:T.bg,minHeight:"100vh",color:T.text}}>

      {/* Topbar */}
      <AppTopbar T={T} section="Reclamos" onHome={onHome}>
        <button onClick={fetchOrders} disabled={ordersStatus==="loading"} style={{...BtnSecondary(T),fontSize:12,padding:"6px 10px",opacity:ordersStatus==="loading"?0.5:1,minWidth:32,justifyContent:"center"}}>{ordersStatus==="loading"?<Spinner size={12} color={T.textMd}/>:"⟳"}</button>
        <button onClick={()=>setReclamoForm(emptyForm())} style={{...BtnDanger(T),fontSize:13,padding:"7px 14px"}}>+ Nuevo reclamo</button>
      </AppTopbar>

      <div style={{padding:"24px 24px 64px",maxWidth:1200,margin:"0 auto",width:"100%"}}>

        {/* Tabs de navegacion */}
        <div style={{display:"inline-flex",background:T.bg,border:"1px solid "+T.border,borderRadius:10,padding:3,marginBottom:20,gap:2}}>
          {[{id:"dashboard",label:"Dashboard"},{id:"buscar",label:"Buscar pedido"},{id:"reclamos",label:"Lista"},{id:"config",label:"Plantillas"}].map(t=>{
            const isActive=view===t.id;
            return (
              <button key={t.id} onClick={()=>{setView(t.id);setActiveReclamo(null);}}
                style={{padding:"7px 16px",fontSize:13,fontWeight:isActive?700:500,borderRadius:8,border:"none",background:isActive?T.card:"transparent",color:isActive?T.text:T.textMd,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",transition:"all 0.15s ease",boxShadow:isActive?`0 1px 4px rgba(0,0,0,0.15)`:"none",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:6}}>
                {t.label}
                {t.id==="reclamos"&&stats.urgentes>0&&<span style={{fontSize:10,fontWeight:700,background:T.red,color:"#fff",borderRadius:4,padding:"1px 5px"}}>{stats.urgentes}</span>}
              </button>
            );
          })}
        </div>

        {/* BANNER ANDREANI - Paquetes listos para retirar */}
        {andreaniAlertas.length > 0 && (
          <div style={{
            background: "linear-gradient(135deg, #052e16 0%, #0a2a1a 100%)",
            border: `1.5px solid ${T.green}55`,
            borderRadius: 12,
            padding: "14px 18px",
            margin: "16px 0 4px",
            display: "flex",
            alignItems: "flex-start",
            gap: 14,
            animation: "growith-fadeIn 0.4s ease",
            boxShadow: `0 0 24px ${T.green}22`,
          }}>
            <div style={{fontSize:28,flexShrink:0}}>📦</div>
            <div style={{flex:1}}>
              <div style={{fontWeight:700,fontSize:14,color:T.green,marginBottom:4}}>
                {andreaniAlertas.length === 1
                  ? "¡Paquete listo para retirar en sucursal!"
                  : `¡${andreaniAlertas.length} paquetes listos para retirar!`}
              </div>
              {andreaniAlertas.map((a,i)=>(
                <div key={i} style={{display:"flex",alignItems:"center",gap:8,marginTop:4}}>
                  <span style={{fontSize:12,color:T.textMd}}>
                    Pedido <span style={{color:T.accent,fontWeight:600}}>#{a.orderNum}</span>
                    {a.nombre ? ` · ${a.nombre}` : ""}
                    {" · "}<span style={{color:T.green,fontWeight:600}}>{a.tracking}</span>
                  </span>
                  <a
                    href={`https://www.andreani.com/#!/informacionEnvio/${a.tracking}`}
                    target="_blank" rel="noopener noreferrer"
                    style={{fontSize:11,color:T.blue,borderBottom:`1px solid ${T.blue}44`,textDecoration:"none"}}
                  >Ver en Andreani →</a>
                  <button
                    onClick={()=>{ setActiveReclamo(a.docId); setView("reclamos"); }}
                    style={{fontSize:11,padding:"2px 8px",borderRadius:5,background:T.surface,border:`1px solid ${T.border}`,color:T.text,cursor:"pointer"}}
                  >Ver reclamo</button>
                </div>
              ))}
            </div>
            <button
              onClick={()=>setAndreaniAlertas([])}
              style={{background:"transparent",border:"none",color:T.textSm,cursor:"pointer",fontSize:18,padding:0,flexShrink:0}}
              title="Cerrar"
            >✕</button>
          </div>
        )}
        {view==="dashboard"&&(
          <div key="dashboard" className="gh-tab-content" style={{padding:"24px 0 48px"}}>

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
                                <div style={{fontSize:12,color:T.textSm,marginTop:2}}>{(o.productos||[]).map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'')).join(' · ')}</div>
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
                                  <div><div style={{fontSize:10,textTransform:"uppercase",color:T.textSm,fontWeight:600}}>Email</div><div style={{fontSize:13,color:T.text}}>{o.email||"--"}</div></div>
                                  <div><div style={{fontSize:10,textTransform:"uppercase",color:T.textSm,fontWeight:600}}>Teléfono</div><div style={{fontSize:13,color:T.text}}>{o.telefono||"--"}</div></div>
                                  <div><div style={{fontSize:10,textTransform:"uppercase",color:T.textSm,fontWeight:600}}>Pago</div><div style={{fontSize:13,color:T.text}}>{o.medioPago||"--"}</div></div>
                                  <div><div style={{fontSize:10,textTransform:"uppercase",color:T.textSm,fontWeight:600}}>Envío</div><div style={{fontSize:13,color:T.text}}>{o.esSucursal?"🏪 Sucursal":"🏠 Domicilio"} · {o.medioEnvio||"--"}</div></div>
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
                                  {(o.productos||[]).map((p,i)=>(
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
                                  <button onClick={()=>{setReclamoForm(emptyForm(o.numero,{nombre:o.comprador,email:o.email,telefono:o.telefono,productos:(o.productos||[]).map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,"").replace(/[()]/g,"").trim()).filter(Boolean),total:o.total}));setSearchGlobal("");setPedidoDetalle(null);}} style={{...BtnDanger(T),fontSize:12,padding:"8px 14px"}}>+ Crear Reclamo</button>
                                  {onGenerarCanje&&<button onClick={()=>{const prodsCanje=(o.productos||[]).map(p=>({nombre:p.nombre?.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /i,'').replace(/[()]/g,'').trim()||p.sku,cantidad:parseInt(p.cantidad)||1})).filter(p=>p.nombre);onGenerarCanje({nombre:o.comprador,email:o.email||"",telefono:o.telefono||"",productosCanje:prodsCanje,pedidoRef:o.numero});setPedidoDetalle(null);setSearchGlobal("");}} style={{...BtnSecondary(T),fontSize:12,padding:"8px 14px",color:T.purple}}>🤝 Generar Canje</button>}
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
                              <div style={{fontSize:13,fontWeight:600,color:T.text}}>#{r.orderNum} · {o?.comprador||"--"}</div>
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
                        const urgente=!["Resuelto","Rechazado"].includes(r.estado)&&dias>=slaConfig.dias;
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

        {/* -- BUSCAR -- */}
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
                              <div style={{fontSize:12,color:T.textSm,marginTop:2}}>{(o.productos||[]).map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'')).join(' · ')}</div>
                            </div>
                            <div style={{display:"flex",gap:8,alignItems:"center",flexShrink:0}}>
                              <span style={{fontSize:14,fontWeight:700,color:T.text}}>{fmtMoney(o.total)}</span>
                              <span style={{fontSize:12,color:T.textSm}}>{isOpen?"▲":"▼"}</span>
                            </div>
                          </div>
                          {isOpen&&(
                            <div style={{padding:"0 18px 18px",borderTop:`0.5px solid ${T.borderL}`}} onClick={e=>e.stopPropagation()}>
                              <div style={{display:"flex",gap:16,flexWrap:"wrap",paddingTop:12,marginBottom:12}}>
                                <div><div style={{fontSize:10,textTransform:"uppercase",color:T.textSm,fontWeight:600}}>Email</div><div style={{fontSize:13,color:T.text}}>{o.email||"--"}</div></div>
                                <div><div style={{fontSize:10,textTransform:"uppercase",color:T.textSm,fontWeight:600}}>Teléfono</div><div style={{fontSize:13,color:T.text}}>{o.telefono||"--"}</div></div>
                                <div><div style={{fontSize:10,textTransform:"uppercase",color:T.textSm,fontWeight:600}}>Pago</div><div style={{fontSize:13,color:T.text}}>{o.medioPago||"--"}</div></div>
                                <div><div style={{fontSize:10,textTransform:"uppercase",color:T.textSm,fontWeight:600}}>Envío</div><div style={{fontSize:13,color:T.text}}>{o.esSucursal?"🏪 Sucursal":"🏠 Domicilio"} · {o.medioEnvio||"--"}</div></div>
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
                                {(o.productos||[]).map((p,i)=>(
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
                                <button onClick={()=>{setReclamoForm(emptyForm(o.numero,{nombre:o.comprador,email:o.email,telefono:o.telefono,productos:(o.productos||[]).map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,"").replace(/[()]/g,"").trim()).filter(Boolean),total:o.total}));setPedidoDetalle(null);}} style={{...BtnDanger(T),fontSize:12,padding:"8px 14px"}}>+ Crear Reclamo</button>
                                {onGenerarCanje&&<button onClick={()=>{const prodsCanje=(o.productos||[]).map(p=>({nombre:p.nombre?.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /i,'').replace(/[()]/g,'').trim()||p.sku,cantidad:parseInt(p.cantidad)||1})).filter(p=>p.nombre);onGenerarCanje({nombre:o.comprador,email:o.email||"",telefono:o.telefono||"",productosCanje:prodsCanje,pedidoRef:o.numero});setPedidoDetalle(null);}} style={{...BtnSecondary(T),fontSize:12,padding:"8px 14px",color:T.purple}}>🤝 Generar Canje</button>}
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
                            <div style={{fontSize:14,fontWeight:600,color:T.text}}>#{r.orderNum} · {o?.comprador||"--"}</div>
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

        {/* -- RECLAMOS LIST + PANEL UNIFICADO -- */}
        {view==="reclamos"&&(
          <div key="reclamos" className="gh-tab-content" style={{display:"grid",gridTemplateColumns:activeR?"1fr 420px":"1fr",gap:20,padding:"20px 0 48px",alignItems:"start"}}>
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
                    const urgente=!["Resuelto","Rechazado"].includes(r.estado)&&dias>=slaConfig.dias;
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
                              <span style={{fontSize:14,fontWeight:600,color:T.text}}>{o?.comprador||"--"}</span>
                              {dias>0&&<span style={{fontSize:10,background:urgente?T.redBg:T.surface,color:urgente?T.red:T.textSm,border:`0.5px solid ${urgente?T.red+"44":T.border}`,borderRadius:4,padding:"2px 6px",fontWeight:urgente?700:400}}>{dias}d</span>}
                            </div>
                            <div style={{fontSize:12,color:T.textSm,marginBottom:6}}>{r.motivo}</div>
                            <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                              <Badge T={T} colors={sc}>{r.estado}</Badge>
                              <Badge T={T} colors={tc}>{r.tipo}</Badge>
                              {r.trackingCambio&&<span style={{fontSize:11,color:T.purple,background:T.purpleBg,border:`1px solid ${T.purple}33`,borderRadius:4,padding:"2px 6px"}}>📦 {r.trackingCambio.slice(0,12)}...</span>}
                              {r.trackingDevolucion&&<span style={{fontSize:11,color:T.green,background:T.greenBg,border:`1px solid ${T.green}33`,borderRadius:4,padding:"2px 6px"}}>📥 {r.trackingDevolucion.slice(0,12)}...</span>}
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
                    {/* Priorizar datos guardados en el reclamo, fallback al pedido en memoria */}
                    {(()=>{
                      const nombre=activeR.clienteNombre||activeOrder?.comprador||"--";
                      const email=activeR.clienteEmail||activeOrder?.email||"";
                      const tel=activeR.clienteTelefono||activeOrder?.telefono||"";
                      const prods=activeR.clienteProductos?.length>0?activeR.clienteProductos:(activeOrder?.productos||[]).map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'').trim());
                      const total=activeR.clienteTotal||activeOrder?.total||"";
                      return (
                        <div>
                          <div style={{fontSize:14,fontWeight:700,color:T.text,marginBottom:6}}>{nombre}</div>
                          {prods.length>0&&<div style={{fontSize:12,color:T.textSm,marginBottom:8}}>{prods.join(' · ')}{total&&<span style={{color:T.accent,fontWeight:600,marginLeft:8}}>${total}</span>}</div>}
                          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                            {tel&&<a href={`https://wa.me/${tel.replace(/\D/g,'')}`} target="_blank" rel="noopener noreferrer" style={{...BtnSecondary(T),fontSize:12,padding:"6px 12px",textDecoration:"none",color:T.green}}>💬 {tel}</a>}
                            {email&&<span style={{fontSize:12,color:T.textSm,display:"flex",alignItems:"center",gap:4,padding:"6px 0"}}>✉️ {email}</span>}
                          </div>
                        </div>
                      );
                    })()}
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
                      <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:6}}>Tracking del nuevo envío (a cliente)</div>
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
                      {/* Tracking devolución (viene del cliente) */}
                      <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginTop:12,marginBottom:6}}>📥 Tracking devolución (viene a nosotros)</div>
                      <div style={{display:"flex",gap:8}}>
                        <input style={{...iS,flex:1,fontSize:13,padding:"8px 12px",borderColor:activeR.trackingDevolucion?T.green+"88":iS.borderColor}} value={activeR.trackingDevolucion||""} placeholder="Código Andreani del cliente..." onChange={async e=>{await updateDoc(doc(db,"reclamos",activeR._docId),{trackingDevolucion:e.target.value,updatedAt:serverTimestamp()});}} />
                        {activeR.trackingDevolucion&&<a href={`https://www.andreani.com/#!/informacionEnvio/${activeR.trackingDevolucion}`} target="_blank" rel="noopener noreferrer" style={{...BtnSecondary(T),fontSize:12,padding:"8px 14px",textDecoration:"none",flexShrink:0,color:T.green}}>🔍 Ver</a>}
                      </div>
                      {!activeR.trackingDevolucion&&<div style={{fontSize:11,color:T.textSm,marginTop:4}}>📢 Cuando lo cargues te avisamos cuando llegue a sucursal</div>}
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
                            <option value="">-</option>
                            <option>Esperando envío</option>
                            <option>En tránsito</option>
                            <option>Recibido</option>
                            <option>Inspeccionado</option>
                          </select>
                        </div>
                        <div>
                          <div style={{fontSize:11,color:T.textSm,fontWeight:600,marginBottom:5}}>Estado del reembolso</div>
                          <select style={{...iS,fontSize:12}} value={activeR.estadoReembolso||""} onChange={async e=>{await updateDoc(doc(db,"reclamos",activeR._docId),{estadoReembolso:e.target.value,updatedAt:serverTimestamp()});}}>
                            <option value="">-</option>
                            <option>Pendiente</option>
                            <option>En proceso</option>
                            <option>Procesado</option>
                          </select>
                        </div>
                      </div>
                      {/* Tracking devolución */}
                      <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginTop:10,marginBottom:6}}>📥 Tracking devolución (viene a nosotros)</div>
                      <div style={{display:"flex",gap:8}}>
                        <input style={{...iS,flex:1,fontSize:13,padding:"8px 12px",borderColor:activeR.trackingDevolucion?T.green+"88":iS.borderColor}} value={activeR.trackingDevolucion||""} placeholder="Código Andreani del cliente..." onChange={async e=>{await updateDoc(doc(db,"reclamos",activeR._docId),{trackingDevolucion:e.target.value,updatedAt:serverTimestamp()});}} />
                        {activeR.trackingDevolucion&&<a href={`https://www.andreani.com/#!/informacionEnvio/${activeR.trackingDevolucion}`} target="_blank" rel="noopener noreferrer" style={{...BtnSecondary(T),fontSize:12,padding:"8px 14px",textDecoration:"none",flexShrink:0,color:T.green}}>🔍 Ver</a>}
                      </div>
                      {!activeR.trackingDevolucion&&<div style={{fontSize:11,color:T.textSm,marginTop:4}}>📢 Cuando lo cargues te avisamos cuando llegue a sucursal</div>}
                    </div>
                  )}

                  {/* Notas internas */}
                  <div style={{marginBottom:14}}>
                    <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:8}}>Notas internas</div>
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
                      <><button onClick={()=>setDeleteConfirm(activeR._docId)} style={{...BtnDanger(T),fontSize:12,padding:"7px 12px"}}>Eliminar</button><button onClick={()=>{setReclamoForm({...activeR,productosRecibe:activeR.productosRecibe||[{producto:"",cantidad:1}],productosEnvia:activeR.productosEnvia||[{producto:"",cantidad:1}],historial:activeR.historial||[],trackingCambio:activeR.trackingCambio||"",trackingDevolucion:activeR.trackingDevolucion||"",estadoRecepcion:activeR.estadoRecepcion||"",estadoReembolso:activeR.estadoReembolso||""});}} style={{...BtnSecondary(T),fontSize:12,padding:"7px 12px"}}>Editar todo</button>
                      {activeOrder?.linkOrden&&<a href={activeOrder.linkOrden} target="_blank" rel="noopener noreferrer" style={{...BtnSecondary(T),fontSize:12,padding:"7px 12px",textDecoration:"none",color:T.purple}}>🔗 TN</a>}</>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* -- CONFIGURACION PLANTILLAS -- */}
        {view==="config"&&(
          <div style={{padding:"24px 0 48px",maxWidth:720}}>
            <div style={{fontSize:22,fontWeight:800,color:T.text,marginBottom:6,letterSpacing:-0.5}}>⚙️ Configuración de Reclamos</div>

            {/* SLA */}
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"18px 20px",marginBottom:24}}>
              <div style={{fontSize:13,fontWeight:700,color:T.text,marginBottom:4}}>⏱ SLA - Umbral de urgencia</div>
              <div style={{fontSize:13,color:T.textMd,marginBottom:14}}>Un reclamo se marca como urgente (⚠) cuando lleva más de este tiempo sin resolverse.</div>
              <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
                {[1,2,3,5,7,10].map(d=>(
                  <button key={d} onClick={async()=>{await savePlantillas(plantillas,{dias:d});}} style={{padding:"8px 18px",fontSize:14,fontWeight:slaConfig.dias===d?700:400,borderRadius:20,border:`2px solid ${slaConfig.dias===d?T.red:T.border}`,background:slaConfig.dias===d?T.redBg:"transparent",color:slaConfig.dias===d?T.red:T.textMd,cursor:"pointer",transition:"all 0.15s"}}>
                    {d}d
                  </button>
                ))}
                <div style={{display:"flex",alignItems:"center",gap:8,marginLeft:8}}>
                  <span style={{fontSize:13,color:T.textSm}}>o escribí:</span>
                  <input type="number" min={1} max={30} value={slaConfig.dias} onChange={async e=>{const v=Math.max(1,Math.min(30,parseInt(e.target.value)||1));await savePlantillas(plantillas,{dias:v});}} style={{...InputStyle(T),width:60,fontSize:14,padding:"6px 10px",textAlign:"center"}}/>
                  <span style={{fontSize:13,color:T.textSm}}>días</span>
                </div>
              </div>
              <div style={{marginTop:12,fontSize:12,color:T.textSm,background:T.bg,borderRadius:8,padding:"8px 12px"}}>
                Actualmente: reclamos activos sin resolver por más de <strong style={{color:T.red}}>{slaConfig.dias} día{slaConfig.dias!==1?"s":""}</strong> se marcan como urgentes.
              </div>
            </div>

            {/* Plantillas */}
            <div style={{fontSize:18,fontWeight:700,color:T.text,marginBottom:4}}>📋 Plantillas de mensajes</div>
            <div style={{fontSize:13,color:T.textMd,marginBottom:16}}>
              Variables disponibles: <code style={{background:T.surface,borderRadius:4,padding:"1px 5px",fontSize:12}}>[nombre]</code> <code style={{background:T.surface,borderRadius:4,padding:"1px 5px",fontSize:12}}>[pedido]</code> <code style={{background:T.surface,borderRadius:4,padding:"1px 5px",fontSize:12}}>[tracking]</code> <code style={{background:T.surface,borderRadius:4,padding:"1px 5px",fontSize:12}}>[email]</code> <code style={{background:T.surface,borderRadius:4,padding:"1px 5px",fontSize:12}}>[telefono]</code> <code style={{background:T.surface,borderRadius:4,padding:"1px 5px",fontSize:12}}>[producto]</code> <code style={{background:T.surface,borderRadius:4,padding:"1px 5px",fontSize:12}}>[monto]</code> <code style={{background:T.surface,borderRadius:4,padding:"1px 5px",fontSize:12}}>[dirección]</code>
            </div>
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
      <Modal T={T} open={!!reclamoForm} onClose={()=>setReclamoForm(null)} title={reclamoForm?._docId?"Editar Reclamo":reclamoForm?.orderNum?`Nuevo Reclamo - #${reclamoForm.orderNum}`:"Nuevo Reclamo"} width={580}>
        {reclamoForm&&(
          <div>
            {/* Buscar pedido - solo cuando es nuevo y sin número */}
            {!reclamoForm._docId&&!reclamoForm.orderNum&&(
              <Field T={T} label="Pedido" required>
                <OrderSearchField T={T} orders={orders} uid={user?.uid} onSelect={num=>{
                  // Buscar el pedido y poblar datos del cliente automáticamente
                  const o=orders.find(o=>o.numero===num)||searchApiResults.find(o=>o.numero===num);
                  setReclamoForm(f=>({...f,
                    orderNum:num,
                    clienteNombre:o?.comprador||f.clienteNombre||"",
                    clienteEmail:o?.email||f.clienteEmail||"",
                    clienteTelefono:o?.telefono||f.clienteTelefono||"",
                    clienteProductos:o?(o.productos||[]).map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'').trim()).filter(Boolean):f.clienteProductos||[],
                    clienteTotal:o?.total||f.clienteTotal||"",
                  }));
                }}/>
              </Field>
            )}
            {/* Info del pedido + datos del cliente */}
            {reclamoForm.orderNum&&(()=>{
              const o=orders.find(o=>o.numero===reclamoForm.orderNum);
              const nombre=reclamoForm.clienteNombre||o?.comprador||"";
              const email=reclamoForm.clienteEmail||o?.email||"";
              const tel=reclamoForm.clienteTelefono||o?.telefono||"";
              const prods=(reclamoForm.clienteProductos||[]).length>0?reclamoForm.clienteProductos:(o?.productos||[]).map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'').trim()).filter(Boolean);
              const total=reclamoForm.clienteTotal||o?.total||"";
              return (
                <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:"12px 14px",marginBottom:14}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                    <div style={{flex:1}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                        <span style={{fontWeight:700,fontSize:14,color:T.accent}}>#{reclamoForm.orderNum}</span>
                        {nombre&&<span style={{fontWeight:700,fontSize:14,color:T.text}}>{nombre}</span>}
                        {total&&<span style={{fontSize:13,color:T.text,fontWeight:600,marginLeft:"auto"}}>${total}</span>}
                      </div>
                      {prods.length>0&&<div style={{fontSize:12,color:T.textSm,marginBottom:6}}>{prods.join(' · ')}</div>}
                      <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
                        {email&&<span style={{fontSize:12,color:T.textSm}}>✉️ {email}</span>}
                        {tel&&<span style={{fontSize:12,color:T.green}}>💬 {tel}</span>}
                      </div>
                    </div>
                    {!reclamoForm._docId&&<button onClick={()=>setReclamoForm(f=>({...f,orderNum:"",clienteNombre:"",clienteEmail:"",clienteTelefono:"",clienteProductos:[],clienteTotal:""}))} style={{...BtnDanger(T),padding:"4px 8px",fontSize:11,flexShrink:0,marginLeft:8}}>Cambiar</button>}
                  </div>
                </div>
              );
            })()}
            {reclamoForm.orderNum&&(<>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 14px"}}>
                <Field T={T} label="Tipo"><select style={iS} value={reclamoForm.tipo} onChange={e=>setReclamoForm(f=>({...f,tipo:e.target.value}))}>{TIPOS_R.map(t=><option key={t}>{t}</option>)}</select></Field>
                <Field T={T} label="Motivo" required><select style={iS} value={reclamoForm.motivo} onChange={e=>setReclamoForm(f=>({...f,motivo:e.target.value}))}><option value="">-</option>{MOTIVOS_R.map(m=><option key={m}>{m}</option>)}</select></Field>
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
                            <select style={{...iS,flex:1,fontSize:12,padding:"7px 8px"}} value={item.producto} onChange={e=>{const arr=[...reclamoForm[key]];arr[i]={...arr[i],producto:e.target.value};setReclamoForm(f=>({...f,[key]:arr}));}}><option value="">-</option>{PRODUCTOS.map(p=><option key={p}>{p}</option>)}</select>
                            <input type="number" min={1} value={item.cantidad} onChange={e=>{const arr=[...reclamoForm[key]];arr[i]={...arr[i],cantidad:parseInt(e.target.value)||1};setReclamoForm(f=>({...f,[key]:arr}));}} style={{...iS,width:48,textAlign:"center",fontSize:12,padding:"7px 4px",flexShrink:0}}/>
                            {reclamoForm[key].length>1&&<button onClick={()=>setReclamoForm(f=>({...f,[key]:f[key].filter((_,j)=>j!==i)}))} style={{...BtnDanger(T),padding:"4px 6px",fontSize:12,flexShrink:0}}>✕</button>}
                          </div>
                        ))}
                        <button onClick={()=>setReclamoForm(f=>({...f,[key]:[...(f[key]||[]),{producto:"",cantidad:1}]}))} style={{...BtnSecondary(T),width:"100%",justifyContent:"center",fontSize:11,padding:"5px"}}>+ Agregar</button>
                      </div>
                    ))}
                  </div>
                  <div style={{marginTop:12}}>
                  <Field T={T} label="Tracking del nuevo envío (a cliente)">
                    <input style={iS} value={reclamoForm.trackingCambio||""} onChange={e=>setReclamoForm(f=>({...f,trackingCambio:e.target.value}))} placeholder="Código Andreani del envío al cliente"/>
                  </Field>
                  </div>
                  <div style={{marginTop:4}}>
                  <Field T={T} label="📥 Tracking devolución (viene a nosotros)">
                    <div style={{position:"relative"}}>
                      <input style={{...iS, borderColor: reclamoForm.trackingDevolucion ? T.green+"88" : iS.borderColor}} value={reclamoForm.trackingDevolucion||""} onChange={e=>setReclamoForm(f=>({...f,trackingDevolucion:e.target.value}))} placeholder="Código Andreani que nos manda el cliente"/>
                      {reclamoForm.trackingDevolucion&&(
                        <a href={`https://www.andreani.com/#!/informacionEnvio/${reclamoForm.trackingDevolucion}`} target="_blank" rel="noopener noreferrer" style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",fontSize:11,color:T.blue,textDecoration:"none",background:T.card,padding:"2px 6px",borderRadius:4,border:`1px solid ${T.blue}33`}}>Ver →</a>
                      )}
                    </div>
                    <div style={{fontSize:11,color:T.textSm,marginTop:4}}>📢 Te notificamos cuando llegue a sucursal</div>
                  </Field>
                  </div>
                </div>
              )}
              <Field T={T} label="Descripción"><textarea style={{...iS,minHeight:60,resize:"vertical"}} value={reclamoForm.descripcion} onChange={e=>setReclamoForm(f=>({...f,descripcion:e.target.value}))} placeholder="Detalle del reclamo..."/></Field>
              {reclamoForm.tipo==="Devolución"&&(
                <Field T={T} label="📥 Tracking devolución (viene a nosotros)">
                  <div style={{position:"relative"}}>
                    <input style={{...iS, borderColor: reclamoForm.trackingDevolucion ? T.green+"88" : iS.borderColor}} value={reclamoForm.trackingDevolucion||""} onChange={e=>setReclamoForm(f=>({...f,trackingDevolucion:e.target.value}))} placeholder="Código Andreani que nos manda el cliente"/>
                    {reclamoForm.trackingDevolucion&&(
                      <a href={`https://www.andreani.com/#!/informacionEnvio/${reclamoForm.trackingDevolucion}`} target="_blank" rel="noopener noreferrer" style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",fontSize:11,color:T.blue,textDecoration:"none",background:T.card,padding:"2px 6px",borderRadius:4,border:`1px solid ${T.blue}33`}}>Ver →</a>
                    )}
                  </div>
                  <div style={{fontSize:11,color:T.textSm,marginTop:4}}>📢 Te notificamos cuando llegue a sucursal</div>
                </Field>
              )}
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

// --- Historial Reclamo Component ---
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


// --- Notas Rápidas Component ---
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

// ===========================================
// APP CANJES
// ===========================================
// Componentes auxiliares para el detalle de canjes (deben ser top-level para que los hooks funcionen)
function InlineField({value, onSave, placeholder, type="text", style={}, iS, T}) {
  const [editing, setEditing] = React.useState(false);
  const [val, setVal] = React.useState(value||"");
  const ref = React.useRef(null);
  React.useEffect(()=>{ setVal(value||""); }, [value]);
  React.useEffect(()=>{ if(editing&&ref.current) ref.current.focus(); }, [editing]);
  if(!editing) return (
    <span onClick={()=>setEditing(true)} title="Click para editar"
      style={{cursor:"text",color:val?T.text:T.textSm,fontSize:13,borderBottom:"1px dashed "+(val?T.border:T.borderL),paddingBottom:1,minWidth:40,display:"inline-block",...style}}>
      {val||placeholder||"\u2014"}
    </span>
  );
  return <input ref={ref} type={type} value={val}
    style={{...iS,fontSize:13,padding:"3px 8px",width:"auto",minWidth:80,...style}}
    onChange={e=>setVal(e.target.value)}
    onBlur={()=>{ setEditing(false); if(val!==(value||"")) onSave(val); }}
    onKeyDown={e=>{ if(e.key==="Enter"){setEditing(false);if(val!==(value||""))onSave(val);} if(e.key==="Escape"){setEditing(false);setVal(value||"");} }}
  />;
}

function DropdownChips({value, options, onSelect, placeholder, T, colorActive, bgActive}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  React.useEffect(()=>{
    if(!open) return;
    const handler = e=>{ if(ref.current&&!ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return ()=>document.removeEventListener("mousedown", handler);
  }, [open]);
  const ca = colorActive||T.accent;
  const ba = bgActive||(T.accentSolid+"18");
  return (
    <div ref={ref} style={{position:"relative",display:"inline-block"}}>
      <span onClick={()=>setOpen(o=>!o)} style={{cursor:"pointer",fontSize:value?11:11,
        background:value?ba:T.surface, color:value?ca:T.textSm,
        borderRadius:4, padding:"2px 8px", fontWeight:value?600:400,
        border:"1px solid "+(value?ca+"44":T.border), display:"inline-block"}}>
        {value||placeholder||"+ Agregar"}
      </span>
      {open&&(
        <div style={{position:"absolute",top:"110%",left:0,zIndex:200,background:T.card,border:"1px solid "+T.border,borderRadius:10,padding:8,display:"flex",flexWrap:"wrap",gap:5,minWidth:180,boxShadow:"0 8px 24px rgba(0,0,0,0.35)"}}>
          {options.map(opt=>(
            <button key={opt} onClick={()=>{ onSelect(value===opt?"":opt); setOpen(false); }}
              style={{fontSize:11,padding:"4px 10px",borderRadius:20,border:"1px solid "+(value===opt?ca:T.border),
                background:value===opt?ba:"transparent",color:value===opt?ca:T.textMd,cursor:"pointer",fontWeight:value===opt?600:400}}>
              {opt}
            </button>
          ))}
          {value&&<button onClick={()=>{ onSelect(""); setOpen(false); }}
            style={{fontSize:11,padding:"4px 10px",borderRadius:20,border:"1px solid "+T.border,background:"transparent",color:T.red,cursor:"pointer"}}>
            \u2715 Quitar
          </button>}
        </div>
      )}
    </div>
  );
}

// Click = copia al portapapeles, doble click = edita inline
function CopyEditField({label, value, onSave, placeholder, icon, T, iS, readOnly=false, href=null, hrefLabel=null}) {
  const [editing, setEditing] = React.useState(false);
  const [val, setVal] = React.useState(value||"");
  const [copied, setCopied] = React.useState(false);
  const ref = React.useRef(null);
  React.useEffect(()=>{ setVal(value||""); }, [value]);
  React.useEffect(()=>{ if(editing && ref.current) ref.current.focus(); }, [editing]);

  function handleClick() {
    if(!value) return;
    navigator.clipboard.writeText(value).then(()=>{
      setCopied(true);
      setTimeout(()=>setCopied(false), 1500);
    }).catch(()=>{});
  }
  function handleDoubleClick() {
    if(readOnly || !onSave) return;
    setEditing(true);
  }
  function handleSave() {
    setEditing(false);
    if(val !== (value||"") && onSave) onSave(val);
  }

  const hasValue = !!(value && value.trim());
  const labelColor = T.textSm;
  const valueColor = hasValue ? T.text : T.textSm;

  return (
    <div style={{display:"flex",flexDirection:"column",gap:3,padding:"8px 0",borderBottom:"1px solid "+T.borderL}}>
      <div style={{fontSize:10,fontWeight:700,color:labelColor,textTransform:"uppercase",letterSpacing:0.5,display:"flex",alignItems:"center",gap:4}}>
        {icon&&<span>{icon}</span>}
        {label}
        {!readOnly&&onSave&&hasValue&&<span style={{fontSize:9,color:T.textSm,fontWeight:400,marginLeft:2}}>· 2× editar</span>}
      </div>
      {editing
        ? <input ref={ref} value={val} style={{...iS,fontSize:13,padding:"4px 8px"}}
            onChange={e=>setVal(e.target.value)}
            onBlur={handleSave}
            onKeyDown={e=>{ if(e.key==="Enter") handleSave(); if(e.key==="Escape"){setEditing(false);setVal(value||"");} }}
          />
        : <div style={{display:"flex",alignItems:"center",gap:6,cursor:hasValue?"pointer":"default"}}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
            title={hasValue?(readOnly?"Click para copiar":"Click para copiar · Doble click para editar"):""}
          >
            <span style={{fontSize:13,color:hasValue?valueColor:T.textSm,fontWeight:hasValue?500:400,flex:1,wordBreak:"break-all"}}>
              {hasValue ? (
                href
                  ? <a href={href} target="_blank" rel="noopener noreferrer"
                      onClick={e=>e.stopPropagation()}
                      style={{color:T.accent,textDecoration:"none",fontWeight:600}}>
                      {hrefLabel||value}
                    </a>
                  : value
              ) : <span style={{color:T.textSm,fontStyle:"italic"}}>{onSave&&!readOnly?"Click 2× para agregar...":"--"}</span>}
            </span>
            {hasValue&&<span style={{fontSize:10,color:copied?T.green:T.textSm,fontWeight:copied?700:400,flexShrink:0,transition:"color 0.2s"}}>
              {copied?"✓ copiado":"⎘"}
            </span>}
          </div>
      }
    </div>
  );
}

function NotasInline({value, onSave, T, iS}) {
  const [editing, setEditing] = React.useState(false);
  const [val, setVal] = React.useState(value||"");
  React.useEffect(()=>{ setVal(value||""); }, [value]);
  if(!editing) return (
    <div onClick={()=>setEditing(true)}
      style={{background:value?T.yellowBg:T.bg,border:"1px dashed "+(value?T.yellow+"44":T.border),borderRadius:10,padding:"10px 14px",cursor:"text",minHeight:40,marginBottom:10}}>
      {value
        ?<><div style={{fontSize:11,textTransform:"uppercase",color:T.yellow,fontWeight:700,marginBottom:3}}>\ud83d\udcdd Notas</div>
           <div style={{fontSize:13,lineHeight:1.6,color:T.text}}>{value}</div></>
        :<div style={{fontSize:13,color:T.textSm}}>\ud83d\udcdd Click para agregar notas...</div>
      }
    </div>
  );
  return (
    <div style={{marginBottom:10}}>
      <div style={{fontSize:11,textTransform:"uppercase",color:T.yellow,fontWeight:700,marginBottom:4}}>\ud83d\udcdd Notas</div>
      <textarea autoFocus rows={3} value={val} onChange={e=>setVal(e.target.value)}
        style={{...iS,resize:"vertical",minHeight:70,fontSize:13,lineHeight:1.5,borderColor:T.yellow+"88",width:"100%"}}
        onBlur={async()=>{ setEditing(false); if(val!==(value||"")) await onSave(val); }}
        onKeyDown={e=>{ if(e.key==="Escape"){setEditing(false);setVal(value||"");} }}
      />
    </div>
  );
}


function AppCanjes({T, fbStatus, user, onHome, pendingCanje, onClearPendingCanje, initialDetail, onClearInitialDetail}) {
  const [canjes,setCanjes]=useState([]);
  const [form,setForm]=useState(null);
  const [detail,setDetail]=useState(null);
  const [search,setSearch]=useState("");
  const [filterEstado,setFilterEstado]=useState("");
  const [filterRed,setFilterRed]=useState("");
  const [deleteConfirm,setDeleteConfirm]=useState(null);
  const [saving,setSaving]=useState(false);
  const [viewTab,setViewTab]=useState("lista"); // lista | kanban | ranking | comisiones
  const [filterNicho,setFilterNicho]=useState("");
  const [filterSoloPendientes,setFilterSoloPendientes]=useState(false);
  // Comisiones UGC - overrides guardados localmente por código
  const [comisionOverrides,setComisionOverrides]=useState(()=>{
    try{return JSON.parse(localStorage.getItem("growith_comisionOverrides")||"{}");}catch(_){return {};}
  });
  const [mpComision,setMpComision]=useState(()=>{
    try{return parseFloat(localStorage.getItem("growith_mpComision")||"12");}catch(_){return 12;}
  });
  function saveMpComision(val){
    const pct=parseFloat(val)||0;
    setMpComision(pct);
    try{localStorage.setItem("growith_mpComision",String(pct));}catch(_){}
    // Recalcular comData si existe
    if(comData){
      const enriched=comData.coupons.map(c=>{
        const neto=(c.ventasPeriodo-(c.descuentoPeriodo||0))*(1-pct/100);
        return {...c,netoRecibido:neto,comisionPagar:neto*(c.comisionPct/100)};
      });
      setComData({...comData,coupons:enriched});
    }
  }
  function saveComisionOverride(code,pct){
    const updated={...comisionOverrides,[code]:pct};
    setComisionOverrides(updated);
    try{localStorage.setItem("growith_comisionOverrides",JSON.stringify(updated));}catch(_){}
    // Re-calcular comData si existe
    if(comData){
      const enriched=comData.coupons.map(c=>{
        if(c.code!==code) return c;
        const newPct=parseFloat(pct)||0;
        const neto=(c.ventasPeriodo-(c.descuentoPeriodo||0))*(1-mpComision/100);
        return {...c,comisionPct:newPct,comisionPagar:neto*(newPct/100),tieneCanje:c.tieneCanje||newPct>0};
      });
      setComData({...comData,coupons:enriched});
    }
  }
  const [comData,setComData]=useState(null);
  const [comLoading,setComLoading]=useState(false);
  const [comError,setComError]=useState("");
  const [comFechaDesde,setComFechaDesde]=useState(()=>{const d=new Date();d.setDate(1);return d.toISOString().split("T")[0];});
  const [comFechaHasta,setComFechaHasta]=useState(()=>new Date().toISOString().split("T")[0]);
  const iS=InputStyle(T);
  const fbDot={connecting:T.yellow,ok:T.green,error:T.red}[fbStatus];
  useEffect(()=>{
    if(initialDetail) {
      setDetail(initialDetail);
      if(onClearInitialDetail) onClearInitialDetail();
    }
  },[initialDetail]);

  useEffect(()=>{
    if(!user?.uid) return;
    const qc=query(collection(db,"canjes"),where("ownerId","==",user.uid));
    const unsub=onSnapshot(qc,snap=>{
      const data=snap.docs.map(d=>({...d.data(),_docId:d.id}));
      data.sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
      setCanjes(data);
    },(err)=>{ console.error("[canjes] snapshot error:", err); });
    return ()=>unsub();
  },[user?.uid]);

  useEffect(()=>{
    if(pendingCanje) {
      // Si ya viene con productosCanje formateados (desde Envíos), usarlos directo
      // Si viene con productos como strings (desde Reclamos), hacer fuzzy match con PRODUCTOS_CANJE
      let prodsCanje = pendingCanje.productosCanje || [];
      if(!prodsCanje.length && (pendingCanje.productos||[]).length) {
        prodsCanje = (pendingCanje.productos||[]).map(p => {
          const nombre = typeof p === "string" ? p : (p.nombre||"");
          // Fuzzy match: buscar el producto de PRODUCTOS_CANJE que más se parece
          const normalizar = s => s.toLowerCase()
            .replace(/anteojos soluna.*?blocker\s*/i,"")
            .replace(/[()]/g,"")
            .replace(/[---]/g," ")
            .replace(/\s+/g," ")
            .trim();
          const n = normalizar(nombre);
          const match = PRODUCTOS_CANJE.find(pc => {
            const pcN = normalizar(pc);
            // Coincidencia exacta normalizada
            if(n === pcN) return true;
            // Coincidencia por palabras clave (ej: "amarillo" + "negro")
            const palabras = n.split(" ").filter(w=>w.length>3);
            return palabras.every(w => pcN.includes(w));
          });
          return { nombre: match || nombre, cantidad: parseInt(p.cantidad)||1 };
        }).filter(p=>p.nombre);
      }
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
    codigoDescuento:"", comisionPct:"",
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
        codigoDescuento:(form.codigoDescuento||"").toUpperCase().trim(),
        comisionPct:form.comisionPct||"",
      };
      if(form._docId) {
        const prev=canjes.find(c=>c._docId===form._docId);
        await updateDoc(doc(db,"canjes",form._docId),{...p,updatedAt:serverTimestamp(),...(form.estado==="Finalizado"&&prev?.estado!=="Finalizado"?{finalizadoAt:serverTimestamp()}:{})});
      } else {
        await addDoc(collection(db,"canjes"),{...p,ownerId:user.uid,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
      }
      const editedId=form._docId;
      setForm(null);
      if(editedId) setTimeout(()=>setDetail(editedId),50);
    } catch(e){alert("Error al guardar.");}
    setSaving(false);
  }

  async function deleteCanje(docId) {
    try{await deleteDoc(doc(db,"canjes",docId));}catch(e){}
    setDeleteConfirm(null);setDetail(null);
  }

  async function fetchComisiones() {
    setComLoading(true); setComError(""); setComData(null);
    try {
      const url=`/api/coupons?uid=${user?.uid||""}&desde=${comFechaDesde}&hasta=${comFechaHasta}`;
      const r = await fetch(url);
      if(!r.ok) throw new Error("Error al conectar con TN: "+r.status);
      const data = await r.json();

      if(!data.coupons||data.coupons.length===0){
        setComError(`No se encontraron pedidos con cupones en el período ${comFechaDesde} → ${comFechaHasta}. Probá con un rango más amplio.`);
        setComLoading(false);
        return;
      }

      // Cruzar con canjes para agregar influencer y comisionPct
      const canjesPorCodigo={};
      canjes.forEach(c=>{
        if(c.codigoDescuento){
          canjesPorCodigo[c.codigoDescuento.toUpperCase()]={
            influencer:c.influencer, usuario:c.usuario||"", comisionPct:parseFloat(c.comisionPct)||0
          };
        }
      });

      const enriched = data.coupons.map(c=>{
        const canje = canjesPorCodigo[c.code] || null;
        // Prioridad: override manual > canje vinculado
        const comisionPct = parseFloat(comisionOverrides[c.code]) || canje?.comisionPct || 0;
        const netoRecibido = (c.ventasPeriodo - (c.descuentoPeriodo||0)) * (1 - mpComision/100);
        return {
          ...c,
          influencer: canje?.influencer || "",
          usuario: canje?.usuario || "",
          comisionPct,
          netoRecibido,
          comisionPagar: netoRecibido * (comisionPct/100),
          tieneCanje: !!canje,
        };
      });

      setComData({coupons: enriched, totalPedidos: data.totalPedidosAnalizados});
    } catch(e){ setComError("Error: "+e.message); }
    setComLoading(false);
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

  const stats={total:canjes.length,pendientes:canjes.filter(c=>c.estado==="Pendiente envío").length,enviados:canjes.filter(c=>c.estado==="Enviado").length,contPend:canjes.filter(c=>c.estado==="Contenido pendiente").length,publicados:canjes.filter(c=>c.estado==="Contenido entregado").length,finalizados:canjes.filter(c=>c.estado==="Finalizado").length};
  const detailC=canjes.find(c=>c._docId===detail);

  return (
    <div style={{fontFamily:"Inter,system-ui,sans-serif",background:T.bg,minHeight:"100vh",color:T.text}}>
      <AppTopbar T={T} section="Canjes" onHome={onHome}>
        <button onClick={exportCSV} style={{...BtnSecondary(T),fontSize:12,color:T.textMd}}>Exportar CSV</button>
        <button onClick={()=>setForm(emptyForm())} style={{...BtnPurple(T),fontSize:13,padding:"7px 14px"}}>+ Nuevo canje</button>
      </AppTopbar>

      <div style={{padding:"24px 24px 64px",maxWidth:1200,margin:"0 auto",width:"100%"}}>
        {/* Stats bar - clickeable para filtrar */}
        <div style={{display:"flex",gap:0,background:T.card,border:"1px solid "+T.border,borderRadius:12,overflow:"hidden",marginBottom:20}}>
          {[
            {label:"Total",value:stats.total,color:T.textMd,estado:""},
            {label:"Pend. envío",value:stats.pendientes,color:T.yellow,estado:"Pendiente envío"},
            {label:"Enviados",value:stats.enviados,color:T.blue,estado:"Enviado"},
            {label:"Cont. pendiente",value:stats.contPend,color:T.orange,estado:"Contenido pendiente"},
            {label:"Publicados",value:stats.publicados,color:T.purple,estado:"Contenido entregado"},
            {label:"Finalizados",value:stats.finalizados,color:T.green,estado:"Finalizado"},
          ].map((s,i,arr)=>{
            const isActive=filterEstado===s.estado;
            return (
              <div key={s.label} onClick={()=>{setFilterEstado(s.estado);setViewTab("lista");}}
                style={{flex:1,padding:"20px 16px",borderRight:i<arr.length-1?"1px solid "+T.borderL:"none",textAlign:"center",cursor:"pointer",background:isActive?s.color+"12":"transparent",transition:"background 0.15s ease",userSelect:"none"}}
                onMouseEnter={e=>!isActive&&(e.currentTarget.style.background=T.surface)}
                onMouseLeave={e=>!isActive&&(e.currentTarget.style.background="transparent")}>
                <div style={{fontSize:32,fontWeight:800,color:s.color,letterSpacing:-1,lineHeight:1}}>{s.value??<Spinner size={16} color={s.color}/>}</div>
                <div style={{fontSize:11,color:isActive?s.color:T.textSm,marginTop:7,fontWeight:isActive?700:500,textTransform:"uppercase",letterSpacing:"0.05em"}}>{s.label}</div>
                {isActive&&<div style={{width:28,height:2,background:s.color,borderRadius:2,margin:"7px auto 0"}}/>}
              </div>
            );
          })}
        </div>

        {/* Tabs de vista */}
        <div style={{display:"flex",gap:8,marginBottom:16,alignItems:"center"}}>
          <div style={{display:"inline-flex",background:T.bg,border:"1px solid "+T.border,borderRadius:10,padding:3,gap:2}}>
            {[{id:"lista",label:"Lista"},{id:"kanban",label:"Kanban"},{id:"ranking",label:"Ranking"},{id:"comisiones",label:"Pagos Cupones"}].map(t=>{
              const isActive=viewTab===t.id;
              return (
                <button key={t.id} onClick={()=>setViewTab(t.id)}
                  style={{padding:"7px 16px",fontSize:13,fontWeight:isActive?700:500,borderRadius:8,border:"none",background:isActive?T.card:"transparent",color:isActive?T.text:T.textMd,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",transition:"all 0.15s ease",boxShadow:isActive?"0 1px 4px rgba(0,0,0,0.15)":"none",whiteSpace:"nowrap"}}>
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>

        <div style={{padding:"14px 0 8px",display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
          {viewTab!=="ranking"&&viewTab!=="comisiones"&&<>
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
        {viewTab==="lista"&&<div key="lista" className="gh-tab-content" style={{paddingBottom:48}}>
          {filtered.length===0?(
            <EmptyState T={T}
              icon="🤝"
              title={canjes.length===0?"Sin canjes todavía":"Sin resultados"}
              description={canjes.length===0?"Creá tu primer canje para empezar a trackear influencers y contenido.":"Probá cambiando los filtros o el término de búsqueda."}
              action={canjes.length===0&&<button onClick={()=>setForm(emptyForm())} style={{...BtnPurple(T),fontSize:13,padding:"9px 20px"}}>+ Nuevo canje</button>}
            />
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
                      <Avatar src={c.foto} name={c.influencer} size={36} radius={9} T={T}/>
                      <div>
                        <div style={{fontSize:14,fontWeight:700,color:T.text}}>{c.influencer}</div>
                        <div style={{display:"flex",gap:5,marginTop:2,alignItems:"center"}}>
                          {c.usuario&&<span style={{fontSize:12,color:T.accent}}>@{c.usuario}</span>}
                          {c.nicho&&<span style={{fontSize:10,background:T.purpleBg,color:T.purple,borderRadius:4,padding:"1px 6px",fontWeight:500}}>{c.nicho}</span>}
                        </div>
                        <div style={{display:"flex",gap:6,marginTop:6,flexWrap:"wrap"}}>
                          {c.linkInstagram&&<a href={c.linkInstagram.startsWith("http")?c.linkInstagram:"https://instagram.com/"+c.linkInstagram.replace("@","")} target="_blank" rel="noopener noreferrer" style={{fontSize:11,color:"#E1306C",textDecoration:"none",background:"#E1306C18",border:"1px solid #E1306C33",borderRadius:6,padding:"3px 8px",fontWeight:600,display:"flex",alignItems:"center",gap:3}}>📸 Instagram</a>}
                          {c.telefono&&<a href={`https://wa.me/${c.telefono.replace(/\D/g,"")}`} target="_blank" rel="noopener noreferrer" style={{fontSize:11,color:T.green,textDecoration:"none",background:T.greenBg,border:`1px solid ${T.green}33`,borderRadius:6,padding:"3px 8px",fontWeight:600,display:"flex",alignItems:"center",gap:3}}>💬 WA</a>}
                        </div>
                      </div>
                    </div>
                    <span style={{fontSize:13,color:T.textMd}}>{c.red}</span>
                    <span style={{fontSize:13,color:T.textMd,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.producto||"--"}</span>
                    <div style={{display:"flex",flexDirection:"column",gap:4}}>
                      <Badge T={T} colors={sc}>{c.estado}</Badge>
                      {(()=>{const diasEnviado=c.fechaEnvio?Math.floor((Date.now()-new Date(c.fechaEnvio).getTime())/(1000*60*60*24)):null;const sinContenido=(c.contenido||[]).reduce((s,x)=>s+(x.entregados||0),0)===0;return (c.estado==="Enviado"||c.estado==="Contenido pendiente")&&diasEnviado>=7&&sinContenido?<span style={{fontSize:10,background:T.orangeBg,color:T.orange,borderRadius:4,padding:"2px 6px",fontWeight:700,whiteSpace:"nowrap"}}>⚠ {diasEnviado}d sin contenido</span>:null;})()}
                    </div>
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
          <div key="kanban" className="gh-tab-content" style={{paddingBottom:48}}>
            <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:14,paddingBottom:8}}>
              {ESTADOS_C.filter(e=>e!=="Cancelado").map(estado=>{
                const sc=getEstadoCC(T,estado);
                const cols=canjes.filter(c=>c.estado===estado);
                return (
                  <div key={estado} style={{background:T.card,borderRadius:12,border:"1px solid "+T.border,overflow:"hidden"}}>
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
                          {(()=>{const dias=c.fechaEnvio?Math.floor((Date.now()-new Date(c.fechaEnvio).getTime())/(1000*60*60*24)):null;const sinC=(c.contenido||[]).reduce((s,x)=>s+(x.entregados||0),0)===0;return (c.estado==="Enviado"||c.estado==="Contenido pendiente")&&dias>=7&&sinC?<div style={{background:T.orangeBg,border:`1px solid ${T.orange}44`,borderRadius:5,padding:"2px 7px",fontSize:10,fontWeight:700,color:T.orange,marginBottom:6}}>⚠ {dias}d sin contenido</div>:null;})()}
                          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                            <Avatar src={c.foto} name={c.influencer} size={28} radius={7} T={T}/>
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
          <div key="ranking" className="gh-tab-content" style={{paddingBottom:48}}>
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
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        )}

        {/* COMISIONES UGC */}
        {viewTab==="comisiones"&&(
          <div key="comisiones" className="gh-tab-content" style={{paddingBottom:48}}>

            {/* Filtros de fecha */}
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"18px 20px",marginBottom:20}}>
              <div style={{fontSize:13,fontWeight:700,color:T.text,marginBottom:4}}>Filtrar ventas por período</div>
              <div style={{fontSize:12,color:T.textSm,marginBottom:14}}>Los usos totales vienen directamente de TN. Las ventas y comisiones se calculan en el rango de fechas que elegís.</div>
              <div style={{display:"flex",gap:12,flexWrap:"wrap",alignItems:"flex-end"}}>
                <div style={{flex:1,minWidth:140}}>
                  <div style={{fontSize:11,color:T.textSm,fontWeight:600,marginBottom:6,textTransform:"uppercase",letterSpacing:0.5}}>Desde</div>
                  <input type="date" value={comFechaDesde} onChange={e=>setComFechaDesde(e.target.value)} style={{...iS,fontSize:13}}/>
                </div>
                <div style={{flex:1,minWidth:140}}>
                  <div style={{fontSize:11,color:T.textSm,fontWeight:600,marginBottom:6,textTransform:"uppercase",letterSpacing:0.5}}>Hasta</div>
                  <input type="date" value={comFechaHasta} onChange={e=>setComFechaHasta(e.target.value)} style={{...iS,fontSize:13}}/>
                </div>
                {/* Comisión MP configurable */}
                <div style={{minWidth:140}}>
                  <div style={{fontSize:11,color:T.textSm,fontWeight:600,marginBottom:6,textTransform:"uppercase",letterSpacing:0.5}}>Comisión MercadoPago %</div>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <input type="number" min="0" max="50" step="0.5" value={isNaN(mpComision)?12:mpComision} onChange={e=>saveMpComision(e.target.value)}
                      style={{...iS,fontSize:13,width:80,textAlign:"center",borderColor:T.blue+"88"}}/>
                    <span style={{fontSize:12,color:T.textSm}}>% sobre neto</span>
                  </div>
                  <div style={{fontSize:10,color:T.textSm,marginTop:3}}>Se descuenta del neto antes de calcular comisiones</div>
                </div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  {[
                    {label:"Este mes",fn:()=>{const d=new Date();d.setDate(1);setComFechaDesde(d.toISOString().split("T")[0]);setComFechaHasta(new Date().toISOString().split("T")[0]);}},
                    {label:"Mes anterior",fn:()=>{const d=new Date();d.setDate(1);d.setMonth(d.getMonth()-1);const h=new Date(d);h.setMonth(h.getMonth()+1);h.setDate(0);setComFechaDesde(d.toISOString().split("T")[0]);setComFechaHasta(h.toISOString().split("T")[0]);}},
                    {label:"Últimos 3 meses",fn:()=>{const d=new Date();d.setMonth(d.getMonth()-3);setComFechaDesde(d.toISOString().split("T")[0]);setComFechaHasta(new Date().toISOString().split("T")[0]);}},
                  ].map(s=>(
                    <button key={s.label} onClick={s.fn} style={{...BtnSecondary(T),fontSize:12,padding:"7px 12px",whiteSpace:"nowrap"}}>{s.label}</button>
                  ))}
                </div>
                <AsyncButton onClick={fetchComisiones} style={{...BtnPrimary(T),fontSize:13,padding:"9px 20px",whiteSpace:"nowrap"}}>
                  {comLoading?"Cargando...":"Cargar códigos"}
                </AsyncButton>
              </div>
            </div>

            {/* Estado inicial */}
            {!comLoading&&!comData&&!comError&&(
              <div style={{textAlign:"center",padding:"48px 20px",color:T.textSm}}>
                <div style={{fontSize:40,marginBottom:12}}>%</div>
                <div style={{fontSize:15,fontWeight:600,color:T.textMd,marginBottom:6}}>Hacé click en "Cargar códigos"</div>
                <div style={{fontSize:13}}>Trae todos los cupones de tu TN ordenados por usos · Si algún código está vinculado a un canje en la app, calcula la comisión automáticamente</div>
              </div>
            )}

            {comError&&<div style={{background:T.redBg,border:`1px solid ${T.red}33`,borderRadius:10,padding:"14px 16px",color:T.red,fontSize:13}}>{comError}</div>}

            {comData&&(()=>{
              try {
              const rows=comData.coupons||[];
              const fmtARS=n=>"$"+Math.round(n).toLocaleString("es-AR");
              const conVentas=rows.filter(r=>r.usosPeriodo>0);
              const totalVentas=rows.reduce((s,r)=>s+r.ventasPeriodo,0);
              const totalDescuentos=rows.reduce((s,r)=>s+(r.descuentoPeriodo||0),0);
              const totalNeto=rows.reduce((s,r)=>s+(r.netoRecibido||0),0);
              const totalComision=rows.filter(r=>r.comisionPct>0).reduce((s,r)=>s+r.comisionPagar,0);
              const conComision=rows.filter(r=>r.comisionPct>0&&r.comisionPagar>0);

              return (
                <div>
                  {/* Resumen global */}
                  <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:12,marginBottom:20}}>
                    {[
                      {label:"Codigos con uso",val:rows.length,color:T.textMd},
                      {label:"Ventas brutas",val:fmtARS(totalVentas),color:T.textMd},
                      {label:"Descuentos otorgados",val:"-"+fmtARS(totalDescuentos),color:T.red},
                      {label:`Neto (-MP ${mpComision}%)`,val:fmtARS(totalNeto),color:T.green},
                      {label:"Comisiones a pagar",val:fmtARS(totalComision),color:T.orange},
                    ].map(s=>(
                      <div key={s.label} style={{background:T.card,border:`1px solid ${s.label==="Neto recibido"?T.green+"44":T.border}`,borderRadius:12,padding:"14px 16px"}}>
                        <div style={{fontSize:11,color:T.textSm,textTransform:"uppercase",letterSpacing:0.5,marginBottom:6}}>{s.label}</div>
                        <div style={{fontSize:20,fontWeight:800,color:s.color,letterSpacing:-0.5}}>{s.val}</div>
                      </div>
                    ))}
                  </div>

                  {/* Tabla principal */}
                  <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,overflow:"hidden",marginBottom:16}}>
                    <div style={{padding:"12px 18px",borderBottom:`1px solid ${T.borderL}`,display:"flex",alignItems:"center",gap:8}}>
                      <span style={{fontSize:12,fontWeight:700,color:T.text}}>Codigos detectados en pedidos · mayor a menor usos</span>
                      <span style={{fontSize:11,color:T.textSm,marginLeft:"auto"}}>{rows.length} codigos · {comData.totalPedidos} pedidos analizados</span>
                    </div>
                    {/* Header */}
                    <div style={{display:"grid",gridTemplateColumns:"120px 85px 60px 130px 110px 110px 80px 110px",gap:8,padding:"9px 18px",background:T.surface,borderBottom:`1px solid ${T.border}`,fontSize:10,fontWeight:700,color:T.textSm,textTransform:"uppercase",letterSpacing:0.5}}>
                      <span>Codigo</span><span>Descuento TN</span><span>Usos</span><span>Influencer</span><span>Bruto</span><span style={{color:T.green}}>Neto (-MP {mpComision}%)</span><span>Comision %</span><span style={{color:T.orange}}>A pagar</span>
                    </div>
                    {rows.map((r,i)=>{
                      const descLabel=r.type==="percentage"?`${r.value}%`:r.type==="absolute"?`$${r.value}`:"Envio gratis";
                      return (
                        <div key={r.code} style={{display:"grid",gridTemplateColumns:"120px 85px 60px 130px 110px 110px 80px 110px",gap:8,padding:"12px 18px",borderBottom:i<rows.length-1?`1px solid ${T.borderL}`:"none",alignItems:"center",background:r.usosPeriodo>0?T.green+"05":"transparent",transition:"background 0.15s"}}
                          onMouseEnter={e=>e.currentTarget.style.background=T.surface}
                          onMouseLeave={e=>e.currentTarget.style.background=r.usosPeriodo>0?T.green+"05":"transparent"}>
                          <div style={{fontFamily:"monospace",fontSize:13,fontWeight:700,color:T.accent}}>{r.code}</div>
                          <div style={{fontSize:12,color:T.textMd,fontWeight:500}}>{descLabel}</div>
                          <div style={{fontSize:14,fontWeight:700,color:r.usosPeriodo>0?T.text:T.textSm}}>{r.usosPeriodo||"--"}</div>
                          <div>
                            {r.tieneCanje
                              ? <><div style={{fontSize:12,fontWeight:600,color:T.text}}>{r.influencer}</div>{r.usuario&&<div style={{fontSize:11,color:T.textSm}}>@{r.usuario}</div>}</>
                              : <span style={{fontSize:11,color:T.textSm,fontStyle:"italic"}}>Sin vincular</span>
                            }
                          </div>
                          {/* Bruto */}
                          <div>
                            <div style={{fontSize:12,color:T.textSm}}>{r.ventasPeriodo>0?fmtARS(r.ventasPeriodo):"--"}</div>
                            {r.descuentoPeriodo>0&&<div style={{fontSize:10,color:T.red}}>-{fmtARS(r.descuentoPeriodo)}</div>}
                          </div>
                          {/* Neto */}
                          <div style={{fontSize:13,fontWeight:700,color:r.netoRecibido>0?T.green:T.textSm}}>
                            {r.netoRecibido>0?fmtARS(r.netoRecibido):"--"}
                          </div>
                          {/* Comision % - solo el input */}
                          <div style={{display:"flex",alignItems:"center",gap:4}}>
                            <input
                              type="number" min="0" max="100" step="0.5"
                              value={r.comisionPct||""}
                              placeholder="0"
                              onChange={e=>saveComisionOverride(r.code,e.target.value)}
                              style={{width:48,background:T.bg,border:`1px solid ${r.comisionPct>0?T.orange+"88":T.border}`,borderRadius:6,padding:"4px 6px",fontSize:12,color:r.comisionPct>0?T.orange:T.textMd,textAlign:"center",fontWeight:600,outline:"none"}}
                            />
                            <span style={{fontSize:11,color:T.textSm}}>%</span>
                          </div>
                          {/* A pagar - columna separada */}
                          <div style={{fontSize:13,fontWeight:800,color:r.comisionPct>0&&r.netoRecibido>0?T.orange:T.textSm}}>
                            {r.comisionPct>0&&r.netoRecibido>0?fmtARS(r.comisionPagar):"--"}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Sección comisiones a pagar */}
                  {conComision.length>0&&(
                    <div style={{background:T.card,border:`1px solid ${T.orange}33`,borderRadius:12,overflow:"hidden",marginBottom:16}}>
                      <div style={{padding:"12px 18px",borderBottom:`1px solid ${T.borderL}`,background:T.orangeBg,display:"flex",alignItems:"center",gap:8}}>
                        <span style={{width:7,height:7,borderRadius:"50%",background:T.orange}}/>
                        <span style={{fontSize:12,fontWeight:700,color:T.orange,textTransform:"uppercase",letterSpacing:0.5}}>Comisiones a pagar en el período</span>
                      </div>
                      {conComision.map((r,i)=>(
                        <div key={r.code} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 18px",borderBottom:i<conComision.length-1?`1px solid ${T.borderL}`:"none"}}>
                          <div>
                            <div style={{fontSize:13,fontWeight:600,color:T.text}}>{r.influencer} <span style={{fontFamily:"monospace",fontSize:12,color:T.accent}}>({r.code})</span></div>
                            <div style={{fontSize:11,color:T.textSm,marginTop:2}}>{r.usosPeriodo} uso{r.usosPeriodo!==1?"s":""} · neto {fmtARS(r.netoRecibido||0)} (MP -{mpComision}%) · {r.comisionPct}% sobre neto</div>
                          </div>
                          <div style={{fontSize:18,fontWeight:800,color:T.orange}}>{fmtARS(r.comisionPagar)}</div>
                        </div>
                      ))}
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 18px",background:T.surface,borderTop:`1px solid ${T.border}`}}>
                        <span style={{fontSize:13,fontWeight:700,color:T.text}}>Total a pagar</span>
                        <span style={{fontSize:20,fontWeight:800,color:T.orange}}>{fmtARS(totalComision)}</span>
                      </div>
                    </div>
                  )}

                  {/* Exportar CSV */}
                  <button onClick={()=>{
                    const csvRows=rows.map(r=>`${r.code},${r.type==="percentage"?r.value+"%":r.type==="absolute"?"$"+r.value:"Envio gratis"},${r.usosPeriodo},${r.influencer||""},${r.usuario||""},${Math.round(r.ventasPeriodo)},${Math.round(r.descuentoPeriodo||0)},${Math.round(r.netoRecibido||0)},${r.comisionPct||""},${Math.round(r.comisionPagar)||""}`);
                    const header="Codigo,Descuento TN,Usos,Influencer,Usuario,Bruto ($),Descuento cupon ($),Neto ($),Comision %,Comision a pagar ($)";
                    const csv=[header,...csvRows].join("\n");
                    const a=document.createElement("a");
                    a.href="data:text/csv;charset=utf-8,"+encodeURIComponent(csv);
                    a.download=`comisiones-ugc-${comFechaDesde}-${comFechaHasta}.csv`;
                    a.click();
                  }} style={{...BtnSecondary(T),fontSize:12,padding:"8px 14px"}}>
                    Exportar CSV
                  </button>
                </div>
              );
              } catch(err) {
                return <div style={{padding:20,color:T.red,fontSize:13}}>Error al mostrar datos: {err?.message}</div>;
              }
            })()}
          </div>
        )}

      </div>
      <Modal T={T} open={!!detail} onClose={()=>{setDetail(null);setDeleteConfirm(null);}} title={detailC?detailC.influencer:""} width={560}>
        {detailC&&(()=>{
          const c=canjes.find(x=>x._docId===detailC._docId)||detailC;
          const totalAcordados=(c.contenido||[]).reduce((s,x)=>s+(x.acordados||0),0);
          const totalEntregados=(c.contenido||[]).reduce((s,x)=>s+(x.entregados||0),0);
          const progreso=totalAcordados>0?Math.round((totalEntregados/totalAcordados)*100):0;
          const hoy=new Date().toISOString().split("T")[0];
          const recordatorioVencido=c.recordatorio&&c.recordatorio<=hoy;
          const igHref=c.linkInstagram?(c.linkInstagram.startsWith("http")?c.linkInstagram:"https://instagram.com/"+c.linkInstagram.replace("@","")):(c.usuario?"https://instagram.com/"+c.usuario.replace("@",""):null);
          const bS={width:22,height:22,border:"1px solid "+T.border,borderRadius:5,background:T.surface,color:T.text,cursor:"pointer",fontSize:13,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0};
          const save=async(fields)=>{try{await updateDoc(doc(db,"canjes",c._docId),{...fields,updatedAt:serverTimestamp()});}catch(e){}};
          return (
            <div>

              {/* Estado: chips clickeables */}
              <div style={{marginBottom:14}}>
                <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                  {ESTADOS_C.filter(e=>e!=="Cancelado").map(est=>{
                    const s2=getEstadoCC(T,est);
                    const active=c.estado===est;
                    return <button key={est} onClick={async()=>{if(active)return;await save({estado:est,...(est==="Finalizado"?{finalizadoAt:serverTimestamp()}:{})});}}
                      style={{fontSize:11,fontWeight:active?700:500,padding:"5px 12px",borderRadius:20,border:"2px solid "+(active?s2.dot:T.border),background:active?s2.bg:"transparent",color:active?s2.text:T.textMd,cursor:active?"default":"pointer",transition:"all 0.15s",display:"flex",alignItems:"center",gap:5}}>
                      <span style={{width:7,height:7,borderRadius:"50%",background:s2.dot,flexShrink:0}}/>{est}
                    </button>;
                  })}
                </div>
              </div>

              {/* Info influencer */}
              <div style={{background:T.bg,border:"1px solid "+T.border,borderRadius:12,padding:"14px 16px",marginBottom:12}}>
                <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:10}}>
                  <Avatar src={c.foto} name={c.influencer} size={52} radius={12} T={T}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:17,fontWeight:800,color:T.text,marginBottom:6}}>
                      <InlineField value={c.influencer} onSave={v=>save({influencer:v})} placeholder="Nombre" T={T} iS={iS} style={{fontSize:17,fontWeight:800}}/>
                    </div>
                    <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                      <DropdownChips value={c.nicho} options={NICHOS} onSelect={v=>save({nicho:v})} placeholder="+ Nicho" T={T} colorActive={T.purple} bgActive={T.purpleBg}/>
                      <span style={{fontSize:11,color:T.textSm,display:"flex",alignItems:"center",gap:3}}>
                        👥​<InlineField value={c.seguidores?""+Number(c.seguidores).toLocaleString():""} onSave={v=>save({seguidores:v.replace(/\./g,"")})} placeholder="seguidores" T={T} iS={iS} style={{fontSize:11}}/>
                      </span>
                      <DropdownChips value={c.red} options={REDES} onSelect={v=>save({red:v})} placeholder="Red" T={T}/>
                    </div>
                  </div>
                </div>

                {/* Links de contacto */}
                <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}>
                  {igHref&&<a href={igHref} target="_blank" rel="noopener noreferrer"
                    style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:13,fontWeight:600,color:"#E1306C",textDecoration:"none",background:"#E1306C18",border:"1px solid #E1306C33",borderRadius:8,padding:"6px 14px"}}>
                    📸 {c.usuario?"@"+c.usuario.replace("@",""):"Instagram"}
                  </a>}
                  {c.telefono&&<a href={"https://wa.me/"+c.telefono.replace(/\D/g,"")} target="_blank" rel="noopener noreferrer"
                    style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:13,fontWeight:600,color:T.green,textDecoration:"none",background:T.greenBg,border:"1px solid "+T.green+"33",borderRadius:8,padding:"6px 14px"}}>
                    💬 WhatsApp
                  </a>}
                  {c.email&&<a href={"mailto:"+c.email}
                    style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:13,fontWeight:600,color:T.accent,textDecoration:"none",background:T.accentSolid+"18",border:"1px solid "+T.accentSolid+"33",borderRadius:8,padding:"6px 14px"}}>
                    ✉️ {c.email}
                  </a>}
                </div>

                {/* Campos de contacto y envío */}
                <div style={{marginTop:4}}>
                  <CopyEditField label="Instagram" icon="📸" value={c.linkInstagram||c.usuario&&("@"+c.usuario)||""}
                    onSave={v=>{const m=(v||"").match(/instagram\.com\/([^/?#\s]+)/);save({linkInstagram:v,...(m?{usuario:m[1].replace("@","")}:{})});}}
                    href={igHref} hrefLabel={c.usuario?"@"+c.usuario.replace("@",""):(c.linkInstagram||null)}
                    T={T} iS={iS} placeholder="https://instagram.com/..."/>
                  <CopyEditField label="Teléfono WA" icon="💬" value={c.telefono}
                    onSave={v=>save({telefono:v})}
                    href={c.telefono?"https://wa.me/"+c.telefono.replace(/\D/g,""):null} hrefLabel={c.telefono}
                    T={T} iS={iS} placeholder="5491155..."/>
                  <CopyEditField label="Email" icon="✉️" value={c.email}
                    onSave={v=>save({email:v})}
                    href={c.email?"mailto:"+c.email:null} hrefLabel={c.email}
                    T={T} iS={iS} placeholder="email@..."/>
                  <CopyEditField label="Pedido ref." icon="🔗" value={c.pedidoRef}
                    onSave={v=>save({pedidoRef:v})} T={T} iS={iS} placeholder="#1234"/>
                  <CopyEditField label="Codigo descuento" icon="%" value={c.codigoDescuento}
                    onSave={async v=>{await save({codigoDescuento:(v||"").toUpperCase().trim()});}} T={T} iS={iS} placeholder="SOFIA10"/>
                  <CopyEditField label="Comision %" icon="$" value={c.comisionPct?(c.comisionPct+"%"):""}
                    onSave={v=>save({comisionPct:parseFloat((v||"").replace("%",""))||""})} T={T} iS={iS} placeholder="10"/>
                  <CopyEditField label="Tracking Andreani" icon="🔍" value={c.tracking}
                    onSave={v=>save({tracking:v})}
                    href={c.tracking?"https://www.andreani.com/#!/informacionEnvio/"+c.tracking:null} hrefLabel={c.tracking}
                    T={T} iS={iS} placeholder="3600029..."/>
                  <CopyEditField label="Fecha de envío" icon="📦" value={c.fechaEnvio}
                    T={T} iS={iS} readOnly={true}/>
                  <CopyEditField label={recordatorioVencido?"⏰ Recordatorio (vencido)":"Recordatorio"} icon={recordatorioVencido?"":"📅"} value={c.recordatorio}
                    T={T} iS={iS} readOnly={true}/>
                </div>
                {/* Fecha envío y recordatorio: date pickers independientes */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:10}}>
                  {[["📦 Fecha envío","fechaEnvio",c.fechaEnvio],["📅 Recordatorio","recordatorio",c.recordatorio]].map(([label,field,val])=>(
                    <div key={field}>
                      <div style={{fontSize:10,fontWeight:700,color:T.textSm,textTransform:"uppercase",letterSpacing:0.5,marginBottom:4}}>{label}</div>
                      <input type="date" value={val||""} style={{...iS,fontSize:12,padding:"6px 8px"}}
                        onChange={async e=>save({[field]:e.target.value})}/>
                    </div>
                  ))}
                </div>
              </div>

              {/* Productos */}
              <div style={{background:T.bg,border:"1px solid "+T.border,borderRadius:12,padding:"12px 16px",marginBottom:12}}>
                <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:700,letterSpacing:0.6,marginBottom:8}}>📦 Productos enviados</div>
                {(c.productosCanje||[]).map((p,pi)=>(
                  <div key={pi} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 0",borderBottom:"1px solid "+T.borderL}}>
                    <span style={{flex:1,fontSize:13,color:T.text,fontWeight:500}}>{p.nombre}</span>
                    <button onClick={async()=>{const upd=(c.productosCanje||[]).map((x,j)=>j===pi?{...x,cantidad:Math.max(1,(x.cantidad||1)-1)}:x);await save({productosCanje:upd});}} style={bS}>−</button>
                    <span style={{fontSize:13,fontWeight:700,color:T.text,minWidth:20,textAlign:"center"}}>{p.cantidad}</span>
                    <button onClick={async()=>{const upd=(c.productosCanje||[]).map((x,j)=>j===pi?{...x,cantidad:(x.cantidad||1)+1}:x);await save({productosCanje:upd});}} style={bS}>+</button>
                    <button onClick={async()=>{const upd=(c.productosCanje||[]).filter((_,j)=>j!==pi);await save({productosCanje:upd});}} style={{...bS,border:"1px solid "+T.red+"44",color:T.red}}>✕</button>
                  </div>
                ))}
                {(c.productosCanje||[]).length===0&&<div style={{fontSize:12,color:T.textSm,padding:"4px 0"}}>Tap un producto para agregar</div>}
                <div style={{display:"flex",flexWrap:"wrap",gap:5,marginTop:8}}>
                  {PRODUCTOS_CANJE.map(pr=>{
                    const tiene=(c.productosCanje||[]).some(x=>x.nombre===pr);
                    return <button key={pr} onClick={async()=>{
                      const lista=c.productosCanje||[];
                      const ex=lista.findIndex(x=>x.nombre===pr);
                      const upd=ex>=0?lista.map((x,i)=>i===ex?{...x,cantidad:(x.cantidad||1)+1}:x):[...lista,{nombre:pr,cantidad:1}];
                      await save({productosCanje:upd,producto:upd[0]?.nombre||""});
                    }} style={{fontSize:11,padding:"4px 10px",borderRadius:20,border:"1px solid "+(tiene?T.purple:T.border),background:tiene?T.purpleBg:"transparent",color:tiene?T.purple:T.textMd,cursor:"pointer",fontWeight:tiene?600:400}}>
                      {tiene?"✓ ":"+ "}{pr}
                    </button>;
                  })}
                </div>
              </div>

              {/* Contenido comprometido */}
              <div style={{background:T.bg,border:"1px solid "+T.border,borderRadius:12,padding:"12px 16px",marginBottom:12}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                  <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:700,letterSpacing:0.6}}>🎬 Contenido</div>
                  {totalAcordados>0&&<span style={{fontSize:13,fontWeight:700,color:progreso===100?T.green:T.textMd}}>{totalEntregados}/{totalAcordados} · {progreso}%</span>}
                </div>
                {totalAcordados>0&&<div style={{height:6,background:T.borderL,borderRadius:20,overflow:"hidden",marginBottom:8}}>
                  <div style={{height:"100%",width:progreso+"%",background:progreso===100?T.green:T.accentSolid,borderRadius:20,transition:"width 0.4s"}}/>
                </div>}
                <div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:8}}>
                  {ACTIVIDADES.map(a=>{
                    const item=(c.contenido||[]).find(x=>x.tipo===a&&(x.acordados||0)>0);
                    return <button key={a} onClick={async()=>{
                      const lista=c.contenido||[];
                      const ex=lista.findIndex(x=>x.tipo===a);
                      const upd=ex>=0?lista.map((x,i)=>i===ex?{...x,acordados:(x.acordados||0)+1}:x):[...lista,{tipo:a,acordados:1,entregados:0}];
                      await save({contenido:upd});
                    }} style={{fontSize:11,padding:"4px 10px",borderRadius:20,border:"1px solid "+(item?T.accentSolid:T.border),background:item?T.accentSolid+"18":"transparent",color:item?T.accent:T.textMd,cursor:"pointer",fontWeight:item?600:400}}>
                      {item?"✓ ":"+ "}{a}{item?` (${item.acordados})`:""}
                    </button>;
                  })}
                </div>
                {(c.contenido||[]).filter(item=>(item.acordados||0)>0).map((item,ci)=>{
                  const ac=item.acordados||1;
                  const en=item.entregados||0;
                  const p=Math.min(100,Math.round((en/ac)*100));
                  const ciReal=(c.contenido||[]).findIndex(x=>x.tipo===item.tipo);
                  return (
                    <div key={ci} style={{padding:"8px 0",borderTop:"1px solid "+T.borderL}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                        <span style={{flex:1,fontSize:14,color:T.text,fontWeight:700}}>{item.tipo}</span>
                        <span style={{fontSize:12,color:p===100?T.green:T.textSm,fontWeight:600,background:p===100?T.greenBg:T.surface,borderRadius:6,padding:"2px 8px"}}>{p===100?"✅ ":""}{en}/{ac}</span>
                      </div>
                      <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:6,flexWrap:"wrap"}}>
                        <span style={{fontSize:11,color:T.textSm,minWidth:52}}>Acordados</span>
                        <button onClick={async()=>{const upd=(c.contenido||[]).map((x,j)=>j===ciReal?{...x,acordados:Math.max(0,(x.acordados||1)-1)}:x).filter(x=>x.acordados>0);await save({contenido:upd});}} style={{...bS,borderColor:T.red+"88",color:T.red}}>−</button>
                        <span style={{fontSize:14,fontWeight:700,color:T.text,minWidth:18,textAlign:"center"}}>{ac}</span>
                        <button onClick={async()=>{const upd=(c.contenido||[]).map((x,j)=>j===ciReal?{...x,acordados:(x.acordados||1)+1}:x);await save({contenido:upd});}} style={bS}>+</button>
                        <span style={{fontSize:11,color:T.textSm,minWidth:60,marginLeft:4}}>Entregados</span>
                        <button onClick={async()=>{const upd=(c.contenido||[]).map((x,j)=>j===ciReal?{...x,entregados:Math.max(0,(x.entregados||0)-1)}:x);await save({contenido:upd});}} style={bS}>−</button>
                        <span style={{fontSize:14,fontWeight:700,color:T.green,minWidth:18,textAlign:"center"}}>{en}</span>
                        <button onClick={async()=>{const upd=(c.contenido||[]).map((x,j)=>j===ciReal?{...x,entregados:Math.min((x.acordados||1),(x.entregados||0)+1)}:x);await save({contenido:upd});}} style={bS}>+</button>
                      </div>
                      <div style={{height:4,background:T.borderL,borderRadius:20,overflow:"hidden"}}>
                        <div style={{height:"100%",width:p+"%",background:p===100?T.green:T.accentSolid,borderRadius:20,transition:"width 0.3s"}}/>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Notas inline */}
              <NotasInline value={c.notas} onSave={v=>save({notas:v})} T={T} iS={iS}/>

              <NotasRapidas T={T} canje={c} onAdd={addNota}/>

              {/* Footer */}
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:4,paddingTop:10,borderTop:"1px solid "+T.borderL}}>
                <div style={{fontSize:11,color:T.textSm}}>
                  Creado {fmtTs(c.createdAt)}{c.finalizadoAt?.seconds?" · Finalizado "+fmtTs(c.finalizadoAt):""}
                </div>
                <div style={{display:"flex",gap:8}}>
                  {deleteConfirm===c._docId
                    ?<><span style={{fontSize:13,color:T.red,fontWeight:500,alignSelf:"center"}}>¿Eliminar?</span>
                       <button onClick={()=>deleteCanje(c._docId)} style={{...BtnDanger(T),padding:"6px 12px",fontSize:12}}>Sí</button>
                       <button onClick={()=>setDeleteConfirm(null)} style={{...BtnSecondary(T),padding:"6px 12px",fontSize:12}}>No</button>
                     </>
                    :<button onClick={()=>setDeleteConfirm(c._docId)} style={{...BtnDanger(T),fontSize:12,padding:"6px 12px"}}>Eliminar</button>
                  }
                  {!deleteConfirm&&<button onClick={()=>{setForm({...c,contenido:c.contenido||[],alcance:c.alcance||"",reproducciones:c.reproducciones||"",likes:c.likes||"",guardados:c.guardados||"",historial:c.historial||[],recordatorio:c.recordatorio||""});setDetail(null);}} style={{...BtnSecondary(T),fontSize:12,padding:"6px 12px"}}>✏️ Editar datos</button>}
                </div>
              </div>

            </div>
          );
        })()}
      </Modal>

      {/* Modal NUEVO canje - form mínimo */}
      <Modal T={T} open={!!form&&!form._docId} onClose={()=>setForm(null)} title="Nuevo canje 🤝" width={460}>
        {form&&!form._docId&&(
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            {/* Link Instagram - campo principal, auto-extrae @usuario */}
            <div>
              <label style={{display:"block",fontSize:11,fontWeight:700,color:T.textSm,marginBottom:6,textTransform:"uppercase",letterSpacing:0.6}}>Link de Instagram <span style={{color:T.red}}>*</span></label>
              <input autoFocus style={{...iS,fontSize:15,borderColor:form.linkInstagram?T.green:T.inputBorder}}
                value={form.linkInstagram||""}
                onChange={e=>{
                  const v=e.target.value;
                  const m=v.match(/instagram\.com\/([^/?#\s]+)/);
                  const u=m?m[1].replace("@",""):"";
                  setForm(f=>({...f,linkInstagram:v,...(u?{usuario:u,influencer:f.influencer||u}:{})}));
                }}
                placeholder="https://instagram.com/usuario o @usuario"
                onBlur={e=>{
                  // si escribió solo @usuario o usuario, construir el link
                  const v=e.target.value.trim();
                  if(v&&!v.includes("instagram.com")){
                    const u=v.replace("@","");
                    setForm(f=>({...f,linkInstagram:"https://instagram.com/"+u,usuario:f.usuario||u,influencer:f.influencer||u}));
                  }
                }}
              />
              {form.usuario&&<div style={{fontSize:12,color:T.green,marginTop:4,display:"flex",alignItems:"center",gap:5}}>✓ @{form.usuario}</div>}
            </div>
            {/* Nombre (se autocompleta desde IG, editable) */}
            <div>
              <label style={{display:"block",fontSize:11,fontWeight:700,color:T.textSm,marginBottom:6,textTransform:"uppercase",letterSpacing:0.6}}>Nombre del influencer <span style={{color:T.red}}>*</span></label>
              <input style={iS} value={form.influencer||""} onChange={e=>setForm(f=>({...f,influencer:e.target.value}))} placeholder="Ej: Ciro González"/>
            </div>
            {/* Teléfono WhatsApp */}
            <div>
              <label style={{display:"block",fontSize:11,fontWeight:700,color:T.textSm,marginBottom:6,textTransform:"uppercase",letterSpacing:0.6}}>Teléfono WhatsApp</label>
              <input style={iS} value={form.telefono||""} onChange={e=>setForm(f=>({...f,telefono:e.target.value}))} placeholder="5491155555555 (con código de país)"/>
            </div>
            {/* Producto - select rápido */}
            <div>
              <label style={{display:"block",fontSize:11,fontWeight:700,color:T.textSm,marginBottom:6,textTransform:"uppercase",letterSpacing:0.6}}>Producto a enviar</label>
              <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                {PRODUCTOS_CANJE.map(p=>{
                  const sel=(form.productosCanje||[]).some(x=>x.nombre===p);
                  return <button key={p} type="button" onClick={()=>{
                    const lista=form.productosCanje||[];
                    const upd=sel?lista.filter(x=>x.nombre!==p):[...lista,{nombre:p,cantidad:1}];
                    setForm(f=>({...f,productosCanje:upd,producto:upd[0]?.nombre||""}));
                  }} style={{fontSize:12,padding:"6px 12px",borderRadius:20,border:"1.5px solid "+(sel?T.purple:T.border),background:sel?T.purpleBg:"transparent",color:sel?T.purple:T.textMd,cursor:"pointer",fontWeight:sel?600:400,transition:"all 0.12s"}}>
                    {p}
                  </button>;
                })}
              </div>
            </div>
            {/* Nicho rápido */}
            <div>
              <label style={{display:"block",fontSize:11,fontWeight:700,color:T.textSm,marginBottom:6,textTransform:"uppercase",letterSpacing:0.6}}>Nicho</label>
              <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                {NICHOS.map(n=>{
                  const sel=form.nicho===n;
                  return <button key={n} type="button" onClick={()=>setForm(f=>({...f,nicho:sel?"":n}))}
                    style={{fontSize:12,padding:"5px 11px",borderRadius:20,border:"1.5px solid "+(sel?T.accent:T.border),background:sel?T.accentSolid+"18":"transparent",color:sel?T.accent:T.textMd,cursor:"pointer",fontWeight:sel?600:400,transition:"all 0.12s"}}>
                    {n}
                  </button>;
                })}
              </div>
            </div>
            {/* Código y comisión */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <div>
                <label style={{display:"block",fontSize:11,fontWeight:700,color:T.textSm,marginBottom:6,textTransform:"uppercase",letterSpacing:0.6}}>Código descuento</label>
                <input style={iS} value={form.codigoDescuento||""} onChange={e=>setForm(f=>({...f,codigoDescuento:e.target.value.toUpperCase()}))} placeholder="SOFIA10"/>
              </div>
              <div>
                <label style={{display:"block",fontSize:11,fontWeight:700,color:T.textSm,marginBottom:6,textTransform:"uppercase",letterSpacing:0.6}}>Comisión %</label>
                <input style={iS} type="number" min="0" max="100" value={form.comisionPct||""} onChange={e=>setForm(f=>({...f,comisionPct:e.target.value}))} placeholder="10"/>
              </div>
            </div>
            {/* Botones */}
            <div style={{display:"flex",gap:8,justifyContent:"flex-end",paddingTop:6,borderTop:"1px solid "+T.borderL}}>
              <button onClick={()=>setForm(null)} style={{...BtnSecondary(T),fontSize:13}}>Cancelar</button>
              <button onClick={saveCanje} disabled={saving||!form.influencer} style={{...BtnPurple(T),fontSize:14,padding:"10px 22px",opacity:saving||!form.influencer?0.5:1}}>
                {saving?"Creando...":"Crear canje →"}
              </button>
            </div>
            <div style={{fontSize:11,color:T.textSm,textAlign:"center"}}>El resto de los datos (tracking, fecha, notas, etc.) los completás desde la carta</div>
          </div>
        )}
      </Modal>

      {/* Modal EDITAR canje existente */}
      <Modal T={T} open={!!form&&!!form._docId} onClose={()=>setForm(null)} title={"Editar: "+((form&&form.influencer)||"")} width={480}>
        {form&&form._docId&&(
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              <div><label style={{display:"block",fontSize:11,fontWeight:700,color:T.textSm,marginBottom:5,textTransform:"uppercase",letterSpacing:0.5}}>Nombre</label><input style={iS} value={form.influencer||""} onChange={e=>setForm(f=>({...f,influencer:e.target.value}))} placeholder="Nombre del influencer"/></div>
              <div><label style={{display:"block",fontSize:11,fontWeight:700,color:T.textSm,marginBottom:5,textTransform:"uppercase",letterSpacing:0.5}}>@Usuario IG</label><input style={iS} value={form.usuario||""} onChange={e=>setForm(f=>({...f,usuario:e.target.value}))} placeholder="@usuario"/></div>
            </div>
            <div><label style={{display:"block",fontSize:11,fontWeight:700,color:T.textSm,marginBottom:5,textTransform:"uppercase",letterSpacing:0.5}}>Link Instagram</label><input style={iS} value={form.linkInstagram||""} onChange={e=>{const v=e.target.value;const m=v.match(/instagram\.com\/([^/?#\s]+)/);const u=m?m[1].replace("@",""):"";setForm(f=>({...f,linkInstagram:v,...(u?{usuario:u}:{})}));}} placeholder="https://instagram.com/usuario"/></div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              <div><label style={{display:"block",fontSize:11,fontWeight:700,color:T.textSm,marginBottom:5,textTransform:"uppercase",letterSpacing:0.5}}>Teléfono WA</label><input style={iS} value={form.telefono||""} onChange={e=>setForm(f=>({...f,telefono:e.target.value}))} placeholder="5491155..."/></div>
              <div><label style={{display:"block",fontSize:11,fontWeight:700,color:T.textSm,marginBottom:5,textTransform:"uppercase",letterSpacing:0.5}}>Email</label><input style={iS} value={form.email||""} onChange={e=>setForm(f=>({...f,email:e.target.value}))} placeholder="email@..."/></div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              <div><label style={{display:"block",fontSize:11,fontWeight:700,color:T.textSm,marginBottom:5,textTransform:"uppercase",letterSpacing:0.5}}>Seguidores</label><input style={iS} type="number" value={form.seguidores||""} onChange={e=>setForm(f=>({...f,seguidores:e.target.value}))} placeholder="50000"/></div>
              <div><label style={{display:"block",fontSize:11,fontWeight:700,color:T.textSm,marginBottom:5,textTransform:"uppercase",letterSpacing:0.5}}>Red social</label><select style={iS} value={form.red||"Instagram"} onChange={e=>setForm(f=>({...f,red:e.target.value}))}>{REDES.map(r=><option key={r}>{r}</option>)}</select></div>
            </div>
            <div><label style={{display:"block",fontSize:11,fontWeight:700,color:T.textSm,marginBottom:5,textTransform:"uppercase",letterSpacing:0.5}}>Foto (URL)</label><input style={iS} value={form.foto||""} onChange={e=>setForm(f=>({...f,foto:e.target.value}))} placeholder="https://..."/></div>
            <div style={{display:"flex",gap:8,justifyContent:"flex-end",paddingTop:6,borderTop:"1px solid "+T.borderL}}>
              <button onClick={()=>setForm(null)} style={{...BtnSecondary(T),fontSize:13}}>Cancelar</button>
              <button onClick={saveCanje} disabled={saving||!form.influencer} style={{...BtnPurple(T),fontSize:13,opacity:saving||!form.influencer?0.5:1}}>{saving?"Guardando...":"Guardar cambios"}</button>
            </div>
          </div>
        )}
      </Modal>

    </div>
  );
}

// ===========================================
// APP ENVIOS
// ===========================================
function AppEnvios({T, orders, ordersStatus, fetchOrders, user, onHome, onGenerarCanje}) {
  const [tab,setTab]=useState("panel");
  const [selected,setSelected]=useState(new Set());
  const [exportModal,setExportModal]=useState(false);
  const [exporting,setExporting]=useState(false);
  const [exportProgress,setExportProgress]=useState({step:"",pct:0,current:0,total:0});
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
  const [skuBlob,setSkuBlob]=useState(null);
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
  const [seguimientoProgress,setSeguimientoProgress]=useState({active:false,current:0,total:0,last:"",done:false,ok:0,fail:0});
  const [sendBatchActive,setSendBatchActive]=useState(false);
  const iS=InputStyle(T);

  // Pedidos exportables - usar tabOrders (local) no orders (global)
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

  // Andreani locations cache - lee del template xlsx directamente
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

    // 3. No encontrado - retornar null para mostrar modal
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
    // ESTRATEGIA 1: calle + número (funciona para HOP y sucursales normales)
    if(calle&&numero){
      const m=sucs.find(s=>{const su=cl(s);return su.includes(calle)&&su.split(' ').includes(numero);});
      if(m) return m;
      const calWords=calle.split(' ').filter(w=>w.length>=4);
      for(const cw of calWords){
        const candidates=sucs.filter(s=>{const su=cl(s);return su.includes(cw)&&su.includes(numero);});
        if(candidates.length===1) return candidates[0];
      }
    }
    if(esHop&&calle){
      const calWords=calle.split(' ').filter(w=>w.length>=4);
      for(const cw of calWords){
        const candidates=sucs.filter(s=>cl(s).includes('HOP')&&cl(s).includes(cw));
        if(candidates.length===1) return candidates[0];
      }
      if(numero){const candidates=sucs.filter(s=>cl(s).includes('HOP')&&cl(s).includes(numero));if(candidates.length===1)return candidates[0];}
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
      const clean0=tel.startsWith('54')?tel.slice(2):tel.startsWith('0')?tel.slice(1):tel;
      // Quitar el 9 inicial de celulares argentinos (ej: 91156333118 → 1156333118)
      const clean=clean0.startsWith('9')&&clean0.length===10?clean0.slice(1):clean0;
      let telCod='',telNum='';
      if(clean.length>=10){telCod=clean.slice(0,clean.length-8);telNum=clean.slice(clean.length-8);}
      else if(clean.length>=8){telCod=clean.slice(0,clean.length-8)||'';telNum=clean.slice(clean.length-8);}
      else if(clean.length>0){telNum=clean;}
      return {nombre,apellido,telCod,telNum};
    }

    // Sheet1: envíos a domicilio
    function buildDomicilioRowsXml(ords, startRow){
      let xml='';

      // Extrae el numero de calle de forma inteligente
      function extractStreetNum(direccion, dirNumero) {
        // Si ya viene el numero separado, usarlo
        const n = String(dirNumero||"").trim();
        if(n && !isNaN(n) && parseFloat(n) > 0) return n;
        // Intentar extraer numero de la direccion: buscar patron \d+ al final o tras km/nro/n°
        const dir = String(direccion||"");
        // Patron "km 1301", "KM1301", "nro 234", "N° 123"
        const kmMatch = dir.match(/(?:km|kms?)\s*(\d+)/i);
        if(kmMatch) return kmMatch[1];
        // Numero al final de la cadena
        const endNum = dir.match(/\s(\d{1,6})\s*(?:[a-z])?$/i);
        if(endNum) return endNum[1];
        // Numero precedido de espacio en la cadena
        const anyNum = dir.match(/\b(\d{1,6})\b/);
        if(anyNum) return anyNum[1];
        // Sin numero: Andreani no acepta S/N, usar 0
        return "0";
      }

      // Separa la calle del numero cuando estan en el mismo campo
      function extractStreetName(direccion, dirNumero) {
        const dir = cleanAndreani(direccion||"");
        // Si ya hay numero separado, devolver la calle limpia
        const n = String(dirNumero||"").trim();
        if(n && !isNaN(n) && parseFloat(n) > 0) return dir;
        // Quitar el numero extraido del nombre de calle
        return dir.replace(/\s*\d{1,6}\s*$/, "").replace(/\s{2,}/g," ").trim() || dir;
      }

      ords.forEach(function(o,i){
        const rn=startRow+i;
        const {nombre,apellido,telCod,telNum}=getPersonData(o);
        const ubicacion=locationOverridesRef.current[o.numero]||findAndreaniLocation(locs,o.cp,o.provincia,o.localidad||o.ciudad)||locs.list.find(l=>l.startsWith('BUENOS AIRES'))||locs.list[0]||"";
        const dirNum=extractStreetNum(o.direccion, o.dirNumero);
        const direccion=extractStreetName(o.direccion, o.dirNumero);
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
          (()=>{const d=String(o.dni||'').replace(/\D/g,'');const dniClean=d.length===11?d.slice(2,10):d;return (dniClean&&!isNaN(dniClean)&&dniClean.length>=7)?nC('J'+rn,parseFloat(dniClean)):sC('J'+rn,dniClean||'');})(),
          sC('K'+rn,cleanField(o.email||"")),
          telCod?nC('L'+rn,parseFloat(telCod)):sC('L'+rn,""),
          telNum?nC('M'+rn,parseFloat(telNum)):sC('M'+rn,""),
          sC('N'+rn,cleanAndreani(direccion)),
          (dirNum&&dirNum!=="0"&&!isNaN(dirNum)&&parseFloat(dirNum)>0)?nC('O'+rn,parseFloat(dirNum)):nC('O'+rn,parseFloat(dirNum)||0),
          sC('P'+rn,cleanField(o.piso||"")),
          sC('Q'+rn,""),
          sC('R'+rn,ubicacion),
          sC('S'+rn,""),
        ].join('');
        xml+='<row r="'+rn+'" spans="1:19" x14ac:dyDescent="0.25">'+cells+'</row>';
      });
      return xml;
    }

    // Sheet2: envíos a sucursal - col N = nombre sucursal (sin O,P,Q,R,S)
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
          sC('H'+rn,cleanAndreani(nombre)),
          sC('I'+rn,cleanAndreani(apellido)),
          (()=>{const d=String(o.dni||'').replace(/\D/g,'');const dniClean=d.length===11?d.slice(2,10):d;return (dniClean&&!isNaN(dniClean)&&dniClean.length>=7)?nC('J'+rn,parseFloat(dniClean)):sC('J'+rn,dniClean||'');})(),
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

    // Update sheet1 (domicilio) - limpiar filas de datos viejos antes de escribir
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
        .replace(/<dimension ref="[^"]+"\/>/,'<dimension ref="A1:N'+totalRows2+'"/>')
        .replace('</sheetData>',sucRowsXml+'</sheetData>');
      {const _i=newSheet2.indexOf('<dataValidations');if(_i>=0){const _j=newSheet2.indexOf('</dataValidations>');if(_j>=0)newSheet2=newSheet2.slice(0,_i)+newSheet2.slice(_j+18);}}
      zip.file('xl/worksheets/sheet2.xml',newSheet2);
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

  // Fetch local tab orders - independiente del estado global de orders
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
    // Cerrar el modal INMEDIATAMENTE - el progreso se muestra en el overlay flotante
    setExportModal(false);
    setExporting(true);
    setExportProgress({step:"Cargando ubicaciones...",pct:10,current:0,total:selOrders.length});
    await new Promise(r=>setTimeout(r,80));
    try {
      const locs=await loadAndreaniLocations();
      setExportProgress({step:"Verificando direcciones...",pct:30,current:0,total:selOrders.length});
      const domicilioOrders=selOrders.filter(o=>!isSucursalOrder(o));
      const sucursalOrders=selOrders.filter(o=>isSucursalOrder(o));

      const unresolvedDom=domicilioOrders.filter(o=>{
        if(locationOverridesRef.current[o.numero]) return false;
        return !findAndreaniLocation(locs,o.cp,o.provincia,o.localidad||o.ciudad);
      });
      const unresolvedSuc=sucursalOrders.filter(o=>{
        if(sucursalOverridesRef.current[o.numero]) return false;
        const _sf=findAndreaniSucursal(locs,o.direccion,o.pickupDetails);
        return !_sf||_sf.trim()==="";
      });

      if(unresolvedDom.length>0||unresolvedSuc.length>0){
        setExporting(false);
        setExportProgress({step:"",pct:0,current:0,total:0});
        await resolveLocationsSequentially(unresolvedDom,unresolvedSuc,locs);
        return;
      }

      const finalOrders=selOrders.filter(o=>
        locationOverridesRef.current[o.numero]!=="EXCLUIR" &&
        sucursalOverridesRef.current[o.numero]!=="EXCLUIR"
      );
      if(!finalOrders.length){
        toast("Todos los pedidos fueron excluidos","warning");
        setExporting(false);
        setExportProgress({step:"",pct:0,current:0,total:0});
        return;
      }

      setExportProgress({step:`Generando ${finalOrders.length} etiquetas...`,pct:60,current:finalOrders.length,total:finalOrders.length});
      const b=await generateAndreaniXlsx(finalOrders,locs);
      setExportProgress({step:"Descargando...",pct:90,current:finalOrders.length,total:finalOrders.length});
      const date=new Date().toISOString().split('T')[0];
      const a=document.createElement('a');
      a.href=URL.createObjectURL(b);
      a.download='EnvioMasivoExcelPaquetes-'+date+'.xlsx';
      a.click();
      try{
        const hist=JSON.parse(localStorage.getItem("growith_exportHistory")||"[]");
        hist.unshift({fecha:new Date().toISOString(),cantidad:finalOrders.length,pedidos:finalOrders.map(o=>o.numero)});
        localStorage.setItem("growith_exportHistory",JSON.stringify(hist.slice(0,50)));
      }catch(_){}
      setExportProgress({step:"¡Listo!",pct:100,current:finalOrders.length,total:finalOrders.length});
      toast(`${finalOrders.length} etiquetas generadas`,"success");
      setSelected(new Set());
      locationOverridesRef.current={};
      sucursalOverridesRef.current={};
      setTimeout(()=>setExportProgress({step:"",pct:0,current:0,total:0}),2000);
    } catch(e){
      console.error("exportAndreani:",e);
      toast("Error al exportar: "+e.message,"error");
      setExportProgress({step:"",pct:0,current:0,total:0});
    } finally {
      setExporting(false);
    }
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

  // Parse PDF - shared logic using fetch+text extraction via server
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
            // Buscar en tabOrders primero (pedidos del tab activo), luego en orders prop
            let order = tabOrders.find(o=>o.numero===pedidoNum)
                     || orders.find(o=>o.numero===pedidoNum);
            // Si no está en memoria, buscar en TN API
            if(!order) {
              try {
                const r=await fetch(`/api/orders?uid=${user?.uid||""}&q=${encodeURIComponent(pedidoNum)}&tab=total`);
                if(r.ok){
                  const data=await r.json();
                  if(Array.isArray(data)&&data.length>0){
                    const built=buildOrdersFromAPI(data);
                    order=built.find(o=>o.numero===pedidoNum)||built[0]||null;
                  }
                }
              } catch(_){}
            }
            const skuLines=order?order.productos.map(p=>`${p.sku} (x${p.cantidad})`):[];
            const skus=order?skuLines.join(', '):"No encontrado en TN";
            results.push({pagina:i+1,pedidoNum,tracking,skus,found:!!order,destinatario,skuLines});
          } else {
            results.push({pagina:i+1,tracking,pedidoNum,destinatario,status:"pending"});
          }
        }
      }
      resultSetter(results);
      if(results.length===0) toast("No se encontraron rótulos válidos en el PDF","warning");
      if(type==="sku"&&results.length>0&&results.some(r=>r.found)){
        setter(false);
        autoGenerateSkuPdf(results,file);
        return;
      }
    } catch(e){ toast("Error al procesar el PDF: "+e.message,"error"); }
    setter(false);
  }

  async function autoGenerateSkuPdf(results, file) {
    setSkuGenerating(true); setSkuProgress(20);
    try {
      const skuMap={};
      results.forEach(r=>{
        if(r.found&&r.skuLines?.length) skuMap[r.pedidoNum]={page:r.pagina,skus:r.skuLines,found:true};
        else skuMap[r.pedidoNum||r.pagina]={page:r.pagina,skus:[],found:false};
      });
      setSkuProgress(40);
      let cfg={x:10,y:10,fontSize:4,sortBy:"sin"};
      try{const s=localStorage.getItem("growith_skuCfg");if(s)cfg={...cfg,...JSON.parse(s)};}catch(_){}
      const fd=new FormData();
      fd.append("pdf",file,file.name);
      fd.append("skuMap",JSON.stringify(skuMap));
      fd.append("config",JSON.stringify(cfg));
      setSkuProgress(60);
      const resp=await fetch("/api/process-sku",{method:"POST",body:fd});
      if(!resp.ok) throw new Error("Error al generar PDF: "+resp.status);
      setSkuProgress(85);
      const blob=await resp.blob();
      setSkuBlob(blob);  // guardar - el usuario descarga cuando quiera
      setSkuProgress(100);
      const notFound=results.filter(r=>!r.found).length;
      if(notFound>0) toast(`PDF listo - ${notFound} pedido${notFound>1?"s":""} no encontrado${notFound>1?"s":""}`, "warning");
      else toast(`PDF listo para descargar - ${results.length} rotulos`, "success");
      setTimeout(()=>{setSkuGenerating(false);setSkuProgress(0);},600);
    } catch(e){ toast("Error al generar PDF: "+e.message,"error"); setSkuGenerating(false); setSkuProgress(0); }
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
      const res=await fetch(`/api/update-shipping?uid=${user.uid}&orderId=${result.pedidoNum}&tracking=${result.tracking}`);
      const data=await res.json();
      if(res.ok&&!data.error) {
        setTrackingSent(p=>({...p,[result.pedidoNum]:"ok"}));
      } else {
        // Marcar como error (no como enviado) y tirar excepción para que sendAllTracking lo cuente
        setTrackingSent(p=>({...p,[result.pedidoNum]:"error"}));
        throw new Error(data.error||"Error al actualizar tracking en TN");
      }
    } catch(e){
      setSendingTracking(p=>({...p,[result.pedidoNum]:false}));
      throw e; // re-throw para que sendAllTracking lo cuente como fail
    }
    setSendingTracking(p=>({...p,[result.pedidoNum]:false}));
  }

  async function sendAllTracking() {
    const pending=pdfResults.filter(r=>r.tracking&&r.pedidoNum&&!trackingSent[r.pedidoNum]);
    setSendBatchActive(true);
    setSeguimientoProgress({active:true,current:0,total:pending.length,last:"",done:false,ok:0,fail:0});
    let ok=0,fail=0;
    const errors=[];
    for(let i=0;i<pending.length;i++){
      const r=pending[i];
      setSeguimientoProgress(p=>({...p,current:i+1,last:`Pedido #${r.pedidoNum}`}));
      try {
        await sendTracking(r);
        ok++;
        setSeguimientoProgress(p=>({...p,ok}));
      } catch(e) {
        fail++;
        errors.push({pedido:r.pedidoNum,msg:e.message});
        setSeguimientoProgress(p=>({...p,fail}));
      }
    }
    setSendBatchActive(false);
    setSeguimientoProgress({active:false,current:pending.length,total:pending.length,last:"",done:true,ok,fail,errors});
  }

  return (
    <div style={{fontFamily:"'Inter',system-ui,sans-serif",background:T.bg,minHeight:"100vh",color:T.text}}>

      {/* Seguimientos batch progress modal */}
      {seguimientoProgress.active&&ReactDOM.createPortal(
        <div style={{position:"fixed",inset:0,zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.55)",backdropFilter:"blur(3px)",fontFamily:"'Inter',system-ui,sans-serif"}}>
          <div style={{background:T.card,borderRadius:20,padding:"36px 40px",minWidth:360,maxWidth:440,boxShadow:"0 24px 80px rgba(0,0,0,0.4)",border:`1px solid ${T.green}44`}}>
            <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:24}}>
              <div style={{width:44,height:44,borderRadius:12,background:T.green+"22",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                <div style={{width:22,height:22,border:`3px solid ${T.green}`,borderTopColor:"transparent",borderRadius:"50%",animation:"growith-spin 0.7s linear infinite"}}/>
              </div>
              <div>
                <div style={{fontSize:16,fontWeight:700,color:T.text}}>Enviando seguimientos</div>
                <div style={{fontSize:13,color:T.textSm,marginTop:2}}>{seguimientoProgress.last||"Iniciando..."}</div>
              </div>
            </div>
            {/* Barra */}
            <div style={{height:8,background:T.borderL,borderRadius:20,overflow:"hidden",marginBottom:10}}>
              <div style={{height:"100%",width:`${Math.round((seguimientoProgress.current/Math.max(1,seguimientoProgress.total))*100)}%`,background:T.green,borderRadius:20,transition:"width 0.3s ease"}}/>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:T.textSm,marginBottom:20}}>
              <span>{seguimientoProgress.current} de {seguimientoProgress.total}</span>
              <span style={{fontWeight:700,color:T.green}}>{Math.round((seguimientoProgress.current/Math.max(1,seguimientoProgress.total))*100)}%</span>
            </div>
            {/* Contador ok/fail en tiempo real */}
            <div style={{display:"flex",gap:12}}>
              <div style={{flex:1,background:T.green+"12",border:`1px solid ${T.green}33`,borderRadius:10,padding:"10px 14px",textAlign:"center"}}>
                <div style={{fontSize:20,fontWeight:800,color:T.green}}>{seguimientoProgress.ok}</div>
                <div style={{fontSize:11,color:T.textSm}}>enviados</div>
              </div>
              <div style={{flex:1,background:seguimientoProgress.fail>0?T.red+"12":T.borderL+"44",border:`1px solid ${seguimientoProgress.fail>0?T.red+"33":T.borderL}`,borderRadius:10,padding:"10px 14px",textAlign:"center"}}>
                <div style={{fontSize:20,fontWeight:800,color:seguimientoProgress.fail>0?T.red:T.textSm}}>{seguimientoProgress.fail}</div>
                <div style={{fontSize:11,color:T.textSm}}>con error</div>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Seguimientos resultado final */}
      {seguimientoProgress.done&&!seguimientoProgress.active&&ReactDOM.createPortal(
        <div style={{position:"fixed",inset:0,zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.55)",backdropFilter:"blur(3px)",fontFamily:"'Inter',system-ui,sans-serif"}}
          onClick={()=>setSeguimientoProgress(p=>({...p,done:false}))}>
          <div style={{background:T.card,borderRadius:20,padding:"36px 40px",minWidth:360,maxWidth:440,boxShadow:"0 24px 80px rgba(0,0,0,0.4)",border:`1px solid ${seguimientoProgress.fail>0?T.orange:T.green}44`}}
            onClick={e=>e.stopPropagation()}>
            <div style={{textAlign:"center",marginBottom:24}}>
              <div style={{fontSize:52,marginBottom:10}}>{seguimientoProgress.fail===0?"✅":seguimientoProgress.ok===0?"❌":"⚠️"}</div>
              <div style={{fontSize:18,fontWeight:800,color:T.text,marginBottom:6}}>
                {seguimientoProgress.fail===0?"Todos enviados":seguimientoProgress.ok===0?"Error al enviar":"Envío parcial"}
              </div>
              <div style={{fontSize:13,color:T.textSm}}>{seguimientoProgress.total} seguimiento{seguimientoProgress.total!==1?"s":""} procesados</div>
            </div>
            {/* Cards resultado */}
            <div style={{display:"flex",gap:12,marginBottom:seguimientoProgress.errors?.length>0?16:24}}>
              <div style={{flex:1,background:T.green+"12",border:`1px solid ${T.green}33`,borderRadius:12,padding:"16px",textAlign:"center"}}>
                <div style={{fontSize:28,fontWeight:800,color:T.green,letterSpacing:-1}}>{seguimientoProgress.ok}</div>
                <div style={{fontSize:12,color:T.green,fontWeight:600}}>enviados OK</div>
              </div>
              {seguimientoProgress.fail>0&&(
                <div style={{flex:1,background:T.red+"12",border:`1px solid ${T.red}33`,borderRadius:12,padding:"16px",textAlign:"center"}}>
                  <div style={{fontSize:28,fontWeight:800,color:T.red,letterSpacing:-1}}>{seguimientoProgress.fail}</div>
                  <div style={{fontSize:12,color:T.red,fontWeight:600}}>con error</div>
                </div>
              )}
            </div>
            {/* Detalle errores */}
            {seguimientoProgress.errors?.length>0&&(
              <div style={{background:T.redBg,border:`1px solid ${T.red}22`,borderRadius:10,padding:"12px 14px",marginBottom:20,maxHeight:140,overflowY:"auto"}}>
                <div style={{fontSize:11,fontWeight:700,color:T.red,textTransform:"uppercase",letterSpacing:0.5,marginBottom:8}}>Detalle de errores</div>
                {seguimientoProgress.errors.map((e,i)=>(
                  <div key={i} style={{fontSize:12,color:T.red,marginBottom:4}}>
                    <span style={{fontWeight:600}}>#{e.pedido}:</span> {e.msg}
                  </div>
                ))}
              </div>
            )}
            <button onClick={()=>setSeguimientoProgress(p=>({...p,done:false}))} style={{...BtnPrimary(T),width:"100%",justifyContent:"center",fontSize:14,padding:"12px"}}>
              Cerrar
            </button>
          </div>
        </div>,
        document.body
      )}

      {/* Export progress - overlay prominente centrado via portal */}
      {exporting&&ReactDOM.createPortal(
        <div style={{position:"fixed",inset:0,zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.55)",backdropFilter:"blur(3px)"}}>
          <div style={{background:T.card,borderRadius:20,padding:"36px 40px",minWidth:340,maxWidth:420,boxShadow:"0 24px 80px rgba(0,0,0,0.4)",border:`1px solid ${T.blue}44`,fontFamily:"'Inter',system-ui,sans-serif"}}>
            {/* Spinner + título */}
            <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:24}}>
              <div style={{width:44,height:44,borderRadius:12,background:T.blue+"22",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                {exportProgress.pct>=100
                  ? <span style={{fontSize:22,color:T.green}}>✓</span>
                  : <div style={{width:22,height:22,border:`3px solid ${T.blue}`,borderTopColor:"transparent",borderRadius:"50%",animation:"growith-spin 0.7s linear infinite"}}/>
                }
              </div>
              <div>
                <div style={{fontSize:16,fontWeight:700,color:T.text}}>Generando etiquetas</div>
                <div style={{fontSize:13,color:T.textSm,marginTop:2}}>{exportProgress.step||"Iniciando..."}</div>
              </div>
            </div>

            {/* Barra de progreso */}
            <div style={{height:8,background:T.borderL,borderRadius:20,overflow:"hidden",marginBottom:10}}>
              <div style={{height:"100%",width:`${exportProgress.pct||0}%`,background:exportProgress.pct>=100?T.green:T.blue,borderRadius:20,transition:"width 0.4s ease"}}/>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:T.textSm}}>
              <span>{exportProgress.current>0?`${exportProgress.current} pedidos`:""}</span>
              <span style={{fontWeight:700,color:exportProgress.pct>=100?T.green:T.blue}}>{exportProgress.pct||0}%</span>
            </div>

            {/* Pasos */}
            <div style={{display:"flex",gap:6,marginTop:20}}>
              {[
                {label:"Ubicaciones",done:exportProgress.pct>=30},
                {label:"Verificar",done:exportProgress.pct>=50},
                {label:"Generar",done:exportProgress.pct>=90},
                {label:"Descargar",done:exportProgress.pct>=100},
              ].map((s,i)=>(
                <div key={i} style={{flex:1,textAlign:"center"}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:s.done?T.green:T.borderL,margin:"0 auto 4px",transition:"background 0.3s ease"}}/>
                  <div style={{fontSize:9,color:s.done?T.green:T.textSm,fontWeight:s.done?600:400,transition:"color 0.3s ease"}}>{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* SKU + seguimientos progress - esquina inferior derecha */}
      {((skuGenerating&&skuProgress>0)||seguimientoProgress.active)&&(()=>{
        const isSku=skuGenerating&&skuProgress>0;
        const isSeg=seguimientoProgress.active&&!isSku;
        const pct=isSku?skuProgress:Math.round((seguimientoProgress.current/Math.max(1,seguimientoProgress.total))*100);
        const step=isSku?(skuProgress<40?"Preparando datos...":skuProgress<80?"Procesando rotulos...":"Generando PDF..."):("Enviando "+seguimientoProgress.current+"/"+seguimientoProgress.total);
        const isDone=pct>=100;
        const accent=isDone?T.green:isSku?T.purple:T.green;
        return (
          <div style={{position:"fixed",bottom:28,right:28,zIndex:9998,width:300,background:T.card,border:`1px solid ${accent}44`,borderRadius:14,boxShadow:"0 8px 32px rgba(0,0,0,0.3)",padding:"16px 18px"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
              <div style={{width:28,height:28,borderRadius:8,background:accent+"22",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                {isDone?<span style={{fontSize:14,color:T.green}}>✓</span>:<div style={{width:14,height:14,border:`2px solid ${accent}`,borderTopColor:"transparent",borderRadius:"50%",animation:"growith-spin 0.7s linear infinite"}}/>}
              </div>
              <div style={{flex:1}}><div style={{fontSize:13,fontWeight:600,color:T.text}}>{step}</div></div>
              <span style={{fontSize:12,fontWeight:700,color:accent}}>{pct}%</span>
            </div>
            <div style={{height:5,background:T.borderL,borderRadius:10,overflow:"hidden"}}>
              <div style={{height:"100%",width:`${pct}%`,background:accent,borderRadius:10,transition:"width 0.35s ease"}}/>
            </div>
          </div>
        );
      })()}

      {/* Topbar */}
      <AppTopbar T={T} section="Envíos" onHome={onHome}>
        <AsyncButton onClick={async()=>{
          tabCacheRef.current={};
          setTabOrders([]);
          await Promise.all([fetchTabOrders(tabEnvio), fetchTabCounts(user?.uid)]);
        }} style={{...BtnSecondary(T),fontSize:12,padding:"6px 12px",color:T.textMd}}>
          ⟳ Sincronizar
        </AsyncButton>
      </AppTopbar>
      <div style={{borderBottom:"1px solid "+T.border,background:T.surface}}>
        <div style={{maxWidth:1100,margin:"0 auto",padding:"0 24px",display:"flex",gap:0}}>
          {[{id:"panel",label:"📦  Panel de Envíos"},{id:"sku",label:"🔖  SKU en Rótulos"},{id:"seguimientos",label:"📮  Seguimientos"}].map(t=>{
            const isActive=tab===t.id;
            return <button key={t.id} onClick={()=>setTab(t.id)} style={{padding:"14px 20px",fontSize:13,fontWeight:isActive?700:500,border:"none",borderBottom:isActive?`2px solid ${T.accentSolid}`:"2px solid transparent",background:"transparent",color:isActive?T.text:T.textMd,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",transition:"all 0.15s ease",whiteSpace:"nowrap",marginBottom:"-1px"}}>{t.label}</button>;
          })}
        </div>
      </div>

      <div style={{padding:"16px 24px 64px",maxWidth:1100,margin:"0 auto",width:"100%"}}>

        {/* -- PANEL DE ENVIOS -- */}
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
                      {t.id!=="buscar"&&<span style={{background:isActive?t.color+"22":T.surface,color:isActive?t.color:T.textSm,fontSize:11,fontWeight:700,borderRadius:5,padding:"1px 6px",minWidth:18,textAlign:"center",border:`1px solid ${isActive?t.color+"44":T.border}`}}>
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
                    <div style={{position:"absolute",top:"110%",right:0,background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:"8px",zIndex:100,minWidth:160,boxShadow:"0 8px 24px rgba(0,0,0,0.3)"}}>
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
                  let exportedOn=null;
                  try{const hist=JSON.parse(localStorage.getItem("growith_exportHistory")||"[]");const found=hist.find(h=>h.pedidos?.includes(o.numero));if(found)exportedOn=new Date(found.fecha).toLocaleDateString("es-AR",{day:"2-digit",month:"2-digit"});}catch(_){}
                  return (
                    <div key={o.numero} onClick={()=>setOrderDetail(o)}
                      style={{display:"grid",gridTemplateColumns:["40px","80px","1fr","1fr",...(hiddenCols.has("estado")?[]:["160px"]),...(hiddenCols.has("envio")?[]:["130px"]),...(hiddenCols.has("total")?[]:["90px"])].join(" "),gap:8,padding:compactMode?"8px 14px":"15px 14px",borderBottom:`0.5px solid ${T.borderL}`,cursor:"pointer",transition:"background 0.1s",background:sel?T.accentSolid+"0a":exportedOn?T.green+"06":"transparent",alignItems:"center",animation:`growith-fadeIn 0.2s ease both`,animationDelay:`${Math.min(idx*30,300)}ms`}}
                      onMouseEnter={e=>{if(!sel)e.currentTarget.style.background=T.card;}}
                      onMouseLeave={e=>{if(!sel)e.currentTarget.style.background=sel?T.accentSolid+"0a":exportedOn?T.green+"06":"transparent";}}>
                      <div onClick={e=>{e.stopPropagation();toggleSelect(o.numero,e);}} style={{width:18,height:18,borderRadius:4,border:`1.5px solid ${sel?T.accentSolid:T.border}`,background:sel?T.accentSolid:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,zIndex:1}}>
                        {sel&&<span style={{color:"#fff",fontSize:12,lineHeight:1}}>✓</span>}
                      </div>
                      <div style={{display:"flex",flexDirection:"column",gap:3}}>
                        <span style={{fontWeight:700,color:T.accent,fontSize:14}}>#{o.numero}</span>
                        {exportedOn&&<span style={{fontSize:9,fontWeight:600,color:T.green,background:T.green+"18",borderRadius:3,padding:"1px 4px"}}>✓ {exportedOn}</span>}
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
                        <span style={{overflow:"hidden",textOverflow:"ellipsis"}}>{o.medioEnvio||"--"}</span>
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

        {/* -- HISTORIAL DE EXPORTACIONES -- */}
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

        {/* -- SKU EN ROTULOS -- */}
        {tab==="sku"&&(
          <div key="sku" className="gh-tab-content" style={{maxWidth:720,margin:"0 auto",paddingBottom:48}}>

            {/* Upload zone */}
            <label htmlFor="sku-file-input" style={{display:"block",background:T.card,border:`2px dashed ${skuFile?T.accentSolid:T.border}`,borderRadius:16,padding:"32px 24px",marginBottom:20,textAlign:"center",cursor:"pointer",transition:"all 0.2s ease"}}>
              <input id="sku-file-input" type="file" accept=".pdf" style={{display:"none"}} onChange={e=>{const f=e.target.files[0];if(f){setSkuFile(f);setSkuPending(false);setSkuResults([]);setSkuGenerating(false);setSkuProgress(0);setSkuBlob(null);parsePdf(f,"sku");}}}/>
              {skuFile && (skuProcessing || skuGenerating)
                ? <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:12,opacity:0.6}}>
                    <span style={{fontSize:28}}>📄</span>
                    <div style={{textAlign:"left"}}>
                      <div style={{fontSize:14,fontWeight:600,color:T.text}}>{skuFile.name}</div>
                      <div style={{fontSize:12,color:T.textSm,marginTop:2}}>Procesando...</div>
                    </div>
                  </div>
                : skuFile
                  ? <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:12}}>
                      <span style={{fontSize:28}}>📄</span>
                      <div style={{textAlign:"left"}}>
                        <div style={{fontSize:14,fontWeight:600,color:T.text}}>{skuFile.name}</div>
                        <div style={{fontSize:12,color:T.accent,marginTop:2}}>Click para cambiar</div>
                      </div>
                    </div>
                  : <div>
                      <div style={{fontSize:40,marginBottom:12}}>📦</div>
                      <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:6}}>Subí el PDF de rótulos de Andreani</div>
                      <div style={{fontSize:13,color:T.textSm,marginBottom:16,lineHeight:1.6}}>Detecta el pedido, busca los SKUs en TN y escribe los productos en cada etiqueta</div>
                      <div style={{display:"inline-block",background:T.accentSolid,color:"#fff",borderRadius:8,padding:"8px 22px",fontSize:13,fontWeight:600}}>Seleccionar PDF</div>
                    </div>
              }
            </label>

            {/* Barra de progreso inline — visible mientras genera el PDF */}
            {(skuProcessing||skuGenerating)&&(
              <div style={{background:"#1a1a2e",border:`1px solid ${skuGenerating?"#a78bfa44":"#60a5fa44"}`,borderRadius:14,padding:"20px 22px",marginBottom:20}}>
                <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}>
                  <div style={{width:36,height:36,borderRadius:10,background:skuGenerating?"#a78bfa22":"#60a5fa22",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                    <div style={{width:18,height:18,border:`2.5px solid ${skuGenerating?"#a78bfa":"#60a5fa"}`,borderTopColor:"transparent",borderRadius:"50%",animation:"growith-spin 0.7s linear infinite"}}/>
                  </div>
                  <div style={{flex:1}}>
                    <div style={{fontSize:14,fontWeight:700,color:"#f8fafc",marginBottom:3}}>
                      {skuProcessing?"Buscando pedidos en TN...":skuProgress<40?"Preparando datos...":skuProgress<80?"Procesando rótulos...":"Generando PDF con SKUs..."}
                    </div>
                    <div style={{fontSize:12,color:"#94a3b8"}}>
                      {skuProcessing?"Esto puede tardar unos segundos según la cantidad de pedidos":`${skuProgress}% completado`}
                    </div>
                  </div>
                  {skuGenerating&&<span style={{fontSize:13,fontWeight:700,color:"#a78bfa"}}>{skuProgress}%</span>}
                </div>
                {skuGenerating&&(
                  <div style={{height:6,background:"rgba(255,255,255,0.08)",borderRadius:10,overflow:"hidden"}}>
                    <div style={{height:"100%",width:`${skuProgress}%`,background:"linear-gradient(90deg,#7c3aed,#a78bfa)",borderRadius:10,transition:"width 0.4s ease"}}/>
                  </div>
                )}
                {skuProcessing&&(
                  <div style={{height:6,background:"rgba(255,255,255,0.08)",borderRadius:10,overflow:"hidden"}}>
                    <div style={{height:"100%",width:"100%",background:"linear-gradient(90deg,#2563eb,#60a5fa,#2563eb)",backgroundSize:"200% 100%",animation:"growith-shimmer 1.5s linear infinite",borderRadius:10}}/>
                  </div>
                )}
              </div>
            )}

            {/* Resultados */}
            {skuResults.length>0&&(()=>{
              const found=skuResults.filter(r=>r.found);
              const notFound=skuResults.filter(r=>!r.found);
              const skuTotals={};
              found.forEach(r=>(r.skuLines||[]).forEach(s=>{
                const m=s.match(/^(.+?)\s*\(x(\d+)\)$/);
                if(m){const k=m[1].trim();skuTotals[k]=(skuTotals[k]||0)+parseInt(m[2]);}
              }));

              return (<div>
                {/* Cards resumen */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:20}}>
                  <div style={{background:T.card,border:`1px solid ${T.green}44`,borderRadius:12,padding:"16px 18px"}}>
                    <div style={{fontSize:11,color:T.textSm,textTransform:"uppercase",letterSpacing:0.5,marginBottom:8}}>Encontrados</div>
                    <div style={{fontSize:28,fontWeight:800,color:T.green,letterSpacing:-1}}>{found.length}<span style={{fontSize:14,fontWeight:400,color:T.textSm,marginLeft:4}}>/ {skuResults.length}</span></div>
                  </div>
                  <div style={{background:T.card,border:`1px solid ${notFound.length>0?T.red+"44":T.border}`,borderRadius:12,padding:"16px 18px"}}>
                    <div style={{fontSize:11,color:T.textSm,textTransform:"uppercase",letterSpacing:0.5,marginBottom:8}}>No encontrados</div>
                    <div style={{fontSize:28,fontWeight:800,color:notFound.length>0?T.red:T.textSm,letterSpacing:-1}}>{notFound.length}</div>
                  </div>
                  <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"16px 18px"}}>
                    <div style={{fontSize:11,color:T.textSm,textTransform:"uppercase",letterSpacing:0.5,marginBottom:8}}>SKUs distintos</div>
                    <div style={{fontSize:28,fontWeight:800,color:T.accent,letterSpacing:-1}}>{Object.keys(skuTotals).length}</div>
                  </div>
                </div>

                {/* Botón de descarga prominente cuando está listo */}
                {skuBlob&&!skuGenerating&&(
                  <div style={{background:"linear-gradient(135deg,#16a34a18,#16a34a08)",border:`2px solid ${T.green}66`,borderRadius:14,padding:"18px 20px",marginBottom:20,display:"flex",alignItems:"center",gap:16,animation:"growith-fadeIn 0.4s ease"}}>
                    <div style={{width:44,height:44,borderRadius:12,background:T.green+"30",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:22}}>✅</div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:15,fontWeight:800,color:T.green,marginBottom:3}}>¡PDF listo para descargar!</div>
                      <div style={{fontSize:12,color:T.textSm}}>{found.length} rótulos con SKUs escritos{notFound.length>0?` · ${notFound.length} sin match`:""}</div>
                    </div>
                    <button onClick={()=>{
                      const url=URL.createObjectURL(skuBlob);
                      const a=document.createElement("a");
                      a.href=url;a.download=`rotulos-con-sku-${new Date().toISOString().slice(0,10)}.pdf`;a.click();
                      URL.revokeObjectURL(url);
                    }} style={{background:T.green,border:"none",color:"#fff",borderRadius:10,padding:"12px 24px",fontSize:15,fontWeight:800,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",display:"flex",alignItems:"center",gap:8,flexShrink:0,boxShadow:`0 4px 16px ${T.green}44`}}>
                      ⬇ Descargar PDF
                    </button>
                  </div>
                )}
                {Object.keys(skuTotals).length>0&&(
                  <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"16px 18px",marginBottom:16}}>
                    <div style={{fontSize:11,fontWeight:700,color:T.textSm,textTransform:"uppercase",letterSpacing:0.5,marginBottom:12}}>Resumen despacho</div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                      {Object.entries(skuTotals).sort((a,b)=>b[1]-a[1]).map(([sku,qty])=>(
                        <div key={sku} style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,padding:"6px 12px",display:"flex",alignItems:"center",gap:8}}>
                          <span style={{fontFamily:"monospace",fontSize:13,fontWeight:700,color:T.accent}}>{sku}</span>
                          <span style={{fontSize:12,fontWeight:700,color:"#fff",background:T.accentSolid,padding:"2px 7px",borderRadius:4}}>{qty}u</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Lista de rótulos */}
                <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,overflow:"hidden",marginBottom:16}}>
                  <div style={{padding:"12px 18px",borderBottom:`1px solid ${T.borderL}`,display:"flex",alignItems:"center",gap:8}}>
                    <span style={{fontSize:13,fontWeight:700,color:T.text}}>Detalle por página</span>
                    {notFound.length>0&&<span style={{marginLeft:"auto",fontSize:11,background:T.redBg,color:T.red,padding:"2px 8px",borderRadius:4,fontWeight:600}}>⚠ {notFound.length} sin match</span>}
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"50px 80px 1fr",gap:8,padding:"8px 18px",fontSize:10,fontWeight:700,color:T.textSm,textTransform:"uppercase",letterSpacing:0.5,borderBottom:`1px solid ${T.borderL}`,background:T.surface}}>
                    <span>Pág.</span><span>Pedido</span><span>Productos</span>
                  </div>
                  {skuResults.map((r,i)=>(
                    <div key={i} style={{display:"grid",gridTemplateColumns:"50px 80px 1fr",gap:8,padding:"11px 18px",borderBottom:i<skuResults.length-1?`1px solid ${T.borderL}`:"none",alignItems:"start",background:r.found?"transparent":T.redBg+"22"}}>
                      <span style={{fontSize:12,color:T.textSm,paddingTop:2}}>Pág.{r.pagina}</span>
                      <span style={{fontWeight:700,color:r.found?T.accent:T.red,fontSize:13,paddingTop:2}}>#{r.pedidoNum}</span>
                      <div>
                        {r.found
                          ? <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                              {(r.skuLines||[]).map((s,j)=>(
                                <span key={j} style={{fontFamily:"monospace",fontSize:12,background:T.accentSolid+"18",color:T.accent,border:`1px solid ${T.accentSolid}33`,borderRadius:5,padding:"2px 7px"}}>{s}</span>
                              ))}
                            </div>
                          : <span style={{fontSize:12,color:T.red}}>No encontrado en TN</span>
                        }
                      </div>
                    </div>
                  ))}
                </div>

                {/* Botones acción */}
                <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
                  {found.length>0&&(
                    <AsyncButton onClick={()=>{setSkuBlob(null);return autoGenerateSkuPdf(skuResults,skuFile);}} style={{...BtnSecondary(T),flex:1,justifyContent:"center",fontSize:13,padding:"10px 18px"}}>
                      {skuGenerating?"Generando...":"Regenerar PDF"}
                    </AsyncButton>
                  )}
                  {Object.keys(skuTotals).length>0&&(
                    <button onClick={()=>{
                      const lines=["RESUMEN SKU DESPACHADOS","Fecha: "+new Date().toLocaleDateString("es-AR"),"","DETALLE:",""];
                      Object.entries(skuTotals).sort().forEach(([k,v])=>lines.push(`${k}: ${v}u`));
                      const a=document.createElement("a");
                      a.href="data:text/plain;charset=utf-8,"+encodeURIComponent(lines.join("\n"));
                      a.download="resumen-sku.txt";a.click();
                    }} style={{...BtnSecondary(T),padding:"10px 18px",fontSize:13}}>
                      Exportar resumen
                    </button>
                  )}
                </div>
              </div>);
            })()}
          </div>
        )}

        {/* -- SEGUIMIENTOS -- */}
        {tab==="seguimientos"&&(
          <div key="seguimientos" className="gh-tab-content" style={{maxWidth:720,margin:"0 auto",paddingBottom:48}}>

            {/* Upload zone */}
            <label htmlFor="seg-file-input" style={{display:"block",background:T.card,border:`2px dashed ${pdfFile?T.accentSolid:T.border}`,borderRadius:16,padding:"32px 24px",marginBottom:20,textAlign:"center",cursor:"pointer",transition:"all 0.2s ease"}}>
              <input id="seg-file-input" type="file" accept=".pdf" style={{display:"none"}} onChange={e=>{const f=e.target.files[0];if(f){setPdfFile(f);setPdfPending(false);setPdfResults([]);setTrackingSent({});parsePdf(f,"tracking");}}}/>
              {pdfProcessing
                ? <div>
                    <div style={{width:44,height:44,border:`3px solid ${T.accentSolid}`,borderTopColor:"transparent",borderRadius:"50%",animation:"growith-spin 0.7s linear infinite",margin:"0 auto 14px"}}/>
                    <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:4}}>Analizando PDF...</div>
                    <div style={{fontSize:13,color:T.textSm}}>Extrayendo números de seguimiento</div>
                  </div>
                : pdfFile
                  ? <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:12}}>
                      <span style={{fontSize:28}}>📄</span>
                      <div style={{textAlign:"left"}}>
                        <div style={{fontSize:14,fontWeight:600,color:T.text}}>{pdfFile.name}</div>
                        <div style={{fontSize:12,color:T.accent,marginTop:2}}>Click para cambiar</div>
                      </div>
                    </div>
                  : <div>
                      <div style={{fontSize:40,marginBottom:12}}>📮</div>
                      <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:6}}>Subí el PDF de rótulos Andreani</div>
                      <div style={{fontSize:13,color:T.textSm,marginBottom:16,lineHeight:1.6}}>Extrae el N° de seguimiento de cada etiqueta<br/>y lo envía automáticamente a Tienda Nube</div>
                      <div style={{display:"inline-block",background:T.accentSolid,color:"#fff",borderRadius:8,padding:"8px 22px",fontSize:13,fontWeight:600}}>Seleccionar PDF</div>
                    </div>
              }
            </label>

            {/* Resultados */}
            {pdfResults.length>0&&(()=>{
              const pending=pdfResults.filter(r=>r.tracking&&r.pedidoNum&&!trackingSent[r.pedidoNum]);
              const sentCount=Object.values(trackingSent).filter(v=>v==="ok").length;
              const errorCount=Object.values(trackingSent).filter(v=>v==="error").length;
              const pct=pdfResults.length>0?Math.round((sentCount/pdfResults.length)*100):0;

              return (<div>
                {/* Cards resumen */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:20}}>
                  <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"16px 18px"}}>
                    <div style={{fontSize:11,color:T.textSm,textTransform:"uppercase",letterSpacing:0.5,marginBottom:8}}>Detectados</div>
                    <div style={{fontSize:28,fontWeight:800,color:T.text,letterSpacing:-1}}>{pdfResults.length}</div>
                    <div style={{fontSize:12,color:T.textSm}}>seguimientos</div>
                  </div>
                  <div style={{background:T.card,border:`1px solid ${sentCount>0?T.green+"44":T.border}`,borderRadius:12,padding:"16px 18px"}}>
                    <div style={{fontSize:11,color:T.textSm,textTransform:"uppercase",letterSpacing:0.5,marginBottom:8}}>Enviados</div>
                    <div style={{fontSize:28,fontWeight:800,color:sentCount>0?T.green:T.textSm,letterSpacing:-1}}>{sentCount}</div>
                    <div style={{fontSize:12,color:T.textSm}}>a Tienda Nube</div>
                  </div>
                  <div style={{background:T.card,border:`1px solid ${pending.length>0?T.orange+"44":T.border}`,borderRadius:12,padding:"16px 18px"}}>
                    <div style={{fontSize:11,color:T.textSm,textTransform:"uppercase",letterSpacing:0.5,marginBottom:8}}>Pendientes</div>
                    <div style={{fontSize:28,fontWeight:800,color:pending.length>0?T.orange:T.textSm,letterSpacing:-1}}>{pending.length}</div>
                    <div style={{fontSize:12,color:T.textSm}}>sin enviar</div>
                  </div>
                </div>

                {/* Barra progreso si hay enviados */}
                {sentCount>0&&(
                  <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"14px 18px",marginBottom:16}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                      <span style={{fontSize:13,fontWeight:600,color:T.text}}>Progreso de envío</span>
                      <span style={{fontSize:13,fontWeight:700,color:pct===100?T.green:T.accent}}>{pct}%</span>
                    </div>
                    <div style={{height:8,background:T.borderL,borderRadius:20,overflow:"hidden"}}>
                      <div style={{height:"100%",width:`${pct}%`,background:pct===100?T.green:T.accentSolid,borderRadius:20,transition:"width 0.4s ease"}}/>
                    </div>
                  </div>
                )}

                {/* Botón enviar todos */}
                {pending.length>0&&(
                  <AsyncButton onClick={sendAllTracking} style={{...BtnPrimary(T),width:"100%",justifyContent:"center",fontSize:14,padding:"13px 20px",marginBottom:16}}>
                    Enviar {pending.length} seguimiento{pending.length!==1?"s":""} pendiente{pending.length!==1?"s":""}
                  </AsyncButton>
                )}
                {pending.length===0&&sentCount>0&&(
                  <div style={{background:T.greenBg,border:`1px solid ${T.green}44`,borderRadius:10,padding:"12px 18px",marginBottom:16,display:"flex",alignItems:"center",gap:10}}>
                    <span style={{fontSize:16,color:T.green}}>✓</span>
                    <span style={{fontSize:13,fontWeight:600,color:T.green}}>Todos los seguimientos enviados</span>
                  </div>
                )}

                {/* Lista */}
                <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,overflow:"hidden"}}>
                  <div style={{display:"grid",gridTemplateColumns:"80px 1fr 140px 80px",gap:8,padding:"8px 18px",fontSize:10,fontWeight:700,color:T.textSm,textTransform:"uppercase",letterSpacing:0.5,borderBottom:`1px solid ${T.borderL}`,background:T.surface}}>
                    <span>Pedido</span><span>Destinatario + Tracking</span><span></span><span>Estado</span>
                  </div>
                  {pdfResults.map((r,i)=>{
                    const sentState=trackingSent[r.pedidoNum]; // "ok" | "error" | undefined
                    const sending=sendingTracking[r.pedidoNum];
                    return (
                      <div key={i} style={{display:"grid",gridTemplateColumns:"80px 1fr 80px",gap:8,padding:"12px 18px",borderBottom:i<pdfResults.length-1?`1px solid ${T.borderL}`:"none",alignItems:"center",background:sentState==="ok"?T.green+"08":sentState==="error"?T.red+"08":"transparent",transition:"background 0.2s ease"}}>
                        <span style={{fontWeight:700,color:T.accent,fontSize:14}}>#{r.pedidoNum||"--"}</span>
                        <div>
                          {r.destinatario&&<div style={{fontSize:13,color:T.text,fontWeight:500,marginBottom:2}}>{r.destinatario}</div>}
                          <div style={{fontSize:11,color:T.textSm,fontFamily:"monospace",letterSpacing:"0.02em"}}>{r.tracking||"Sin tracking"}</div>
                        </div>
                        <div style={{display:"flex",justifyContent:"flex-end"}}>
                          {sentState==="ok"
                            ? <span style={{fontSize:12,color:T.green,fontWeight:600}}>✓ Ok</span>
                            : sentState==="error"
                              ? <span style={{fontSize:12,color:T.red,fontWeight:600}}>✗ Error</span>
                              : sending
                                ? <Spinner size={13} color={T.yellow}/>
                                : sendBatchActive
                                  ? <span style={{fontSize:11,color:T.textSm}}>En cola...</span>
                                  : r.tracking&&r.pedidoNum
                                    ? <AsyncButton onClick={()=>sendTracking(r)} style={{...BtnSecondary(T),fontSize:11,padding:"4px 10px"}}>Enviar</AsyncButton>
                                    : <span style={{fontSize:11,color:T.red}}>Sin datos</span>
                          }
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>);
            })()}
          </div>
        )}
      </div>

      {/* Sucursal confirmed toast */}
      {copiedToast&&(
        <div style={{position:"fixed",bottom:28,left:"50%",transform:"translateX(-50%)",zIndex:2000,background:T.card,border:`1px solid ${T.border}`,borderRadius:8,padding:"8px 16px",display:"flex",alignItems:"center",gap:8,boxShadow:"0 4px 20px rgba(0,0,0,0.25)",animation:"growith-fadeIn 0.15s ease",fontSize:13,color:T.text}}>
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
              <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,padding:"14px 16px",marginBottom:14}}>
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
              <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,padding:"14px 16px",marginBottom:14}}>
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
              <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,padding:"14px 16px",marginBottom:18}}>
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
                <div style={{fontSize:13,color:T.text}}>Pedido <strong>#{order.numero}</strong> - {order.comprador}</div>
                {isSuc&&order.pickupDetails&&(
                  <div style={{fontSize:12,color:T.text,marginTop:6,background:T.surface,borderRadius:8,padding:"8px 10px"}}>
                    <div style={{fontWeight:600,color:T.accent,marginBottom:2}}>{order.pickupDetails.name}</div>
                    <div>{order.pickupDetails.address?.address} {order.pickupDetails.address?.number}</div>
                    <div style={{color:T.textSm}}>{order.pickupDetails.address?.locality}, {order.pickupDetails.address?.province}</div>
                  </div>
                )}
                {!isSuc&&<div style={{fontSize:12,color:T.textSm,marginTop:3}}>
                  {order.direccion} {order.dirNumero}, {order.localidad||order.ciudad}, {order.provincia} - CP {order.cp}
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
      <Modal T={T} open={exportModal} onClose={()=>!exporting&&setExportModal(false)} title={`Generar ${selected.size} etiqueta${selected.size!==1?"s":""} para Andreani`} width={500}>
        {(()=>{
          const selOrders=tabOrders.filter(o=>selected.has(o.numero));
          const domCount=selOrders.filter(o=>!isSucursalOrder(o)).length;
          const sucCount=selOrders.filter(o=>isSucursalOrder(o)).length;
          let hist=[];try{hist=JSON.parse(localStorage.getItem("growith_exportHistory")||"[]");}catch(_){}
          const yaExportados=selOrders.filter(o=>hist.some(h=>h.pedidos?.includes(o.numero)));
          return (
        <div>
          <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:"14px 16px",marginBottom:16}}>
            <div style={{fontSize:12,fontWeight:600,color:T.textSm,textTransform:"uppercase",letterSpacing:0.5,marginBottom:10}}>Resumen</div>
            <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
              <div style={{display:"flex",alignItems:"center",gap:6,fontSize:13}}><span style={{fontSize:15}}>🏠</span><span style={{color:T.text,fontWeight:600}}>{domCount}</span><span style={{color:T.textSm}}>domicilio{domCount!==1?"s":""}</span></div>
              <div style={{width:1,background:T.borderL}}/>
              <div style={{display:"flex",alignItems:"center",gap:6,fontSize:13}}><span style={{fontSize:15}}>🏪</span><span style={{color:T.text,fontWeight:600}}>{sucCount}</span><span style={{color:T.textSm}}>sucursal{sucCount!==1?"es":""}</span></div>
              <div style={{width:1,background:T.borderL}}/>
              <div style={{display:"flex",alignItems:"center",gap:6,fontSize:13}}><span style={{color:T.accent,fontWeight:700}}>{selOrders.length}</span><span style={{color:T.textSm}}>total</span></div>
            </div>
            {yaExportados.length>0&&(
              <div style={{marginTop:10,padding:"8px 10px",background:T.yellowBg,border:`1px solid ${T.yellow}33`,borderRadius:8,fontSize:12,color:T.yellow}}>
                Atencion: {yaExportados.length} pedido{yaExportados.length>1?"s":""} ya exportado{yaExportados.length>1?"s":""}: {yaExportados.slice(0,3).map(o=>`#${o.numero}`).join(", ")}{yaExportados.length>3?` y ${yaExportados.length-3} mas`:""}
              </div>
            )}
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
              Generar etiquetas
            </AsyncButton>
          </div>
        </div>
          );
        })()}
      </Modal>
    </div>
  );
}

// ===========================================
// HOME SCREEN
// ===========================================
function HomeScreen({T, onNavigate, fbStatus, ordersCount, reclamosCount, canjesCount, alertas, user, userPlan="free", planExpiry, isAdmin=false, darkMode, onToggleDark}) {
  const fbDot={connecting:T.yellow,ok:T.green,error:T.red}[fbStatus];
  const nombre = user?.displayName?.split(" ")[0] || "ahí";
  const hora = new Date().getHours();
  const saludo = hora < 13 ? "Buenos días" : hora < 20 ? "Buenas tardes" : "Buenas noches";
  const notificacionesCanjes = alertas||[];
  const [notifCollapsed, setNotifCollapsed] = React.useState(false);

  return (
    <div style={{fontFamily:"'Inter',system-ui,sans-serif",background:T.bg,minHeight:"100vh",color:T.text,display:"flex",flexDirection:"column"}}>

      {/* Topbar */}
      <div style={{borderBottom:`1px solid ${T.border}`,background:T.surface,padding:"0 24px"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",height:60,maxWidth:1000,margin:"0 auto"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:28,height:28,borderRadius:7,background:T.accentSolid,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>🌙</div>
            <span style={{fontWeight:800,fontSize:15,color:T.text,letterSpacing:-0.3}}>Growith</span>
            <div style={{display:"flex",alignItems:"center",gap:5,marginLeft:4}}>
              <span style={{width:6,height:6,borderRadius:"50%",background:fbDot}}/>
              <span style={{fontSize:11,color:T.textSm}}>{fbStatus==="ok"?"en vivo":"conectando"}</span>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            {user?.photoURL&&<img src={user.photoURL} style={{width:28,height:28,borderRadius:"50%",border:`1.5px solid ${T.border}`}} alt=""/>}
            <button onClick={()=>onNavigate("planes")} style={{fontSize:11,fontWeight:600,padding:"4px 9px",borderRadius:6,background:"transparent",border:`1px solid ${T.border}`,color:T.textSm,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>
              {userPlan==="free"?"Free":userPlan==="starter"?"Starter":userPlan==="pro"?"Pro":"Total"}
            </button>
            {isAdmin&&<button onClick={()=>onNavigate("admin")} style={{...BtnSecondary(T),padding:"5px 9px",fontSize:12,color:T.yellow,borderColor:T.yellow+"44"}}>👑</button>}
            <button onClick={onToggleDark} style={{...BtnSecondary(T),padding:"5px 10px",fontSize:11,color:T.textSm}}>{darkMode?"☀︎":"◑"}</button>
            <button onClick={()=>onNavigate("config")} style={{...BtnSecondary(T),padding:"5px 10px",fontSize:12,color:T.textMd}}>Config</button>
          </div>
        </div>
      </div>

      <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",padding:"40px 24px 64px"}}>
        <div style={{width:"100%",maxWidth:820}}>

          {/* Saludo */}
          <div style={{marginBottom:28}}>
            <h1 style={{fontSize:28,fontWeight:800,margin:"0 0 5px",letterSpacing:-0.8,color:T.text}}>{saludo}, {nombre}</h1>
            <p style={{fontSize:14,color:T.textSm,margin:0}}>
              {reclamosCount} reclamo{reclamosCount!==1?"s":""} activo{reclamosCount!==1?"s":""}
              {notificacionesCanjes.length>0&&<> · <span style={{color:T.orange}}>{notificacionesCanjes.length} notificación{notificacionesCanjes.length>1?"es":""} en canjes</span></>}
            </p>
          </div>

          {/* -- CARDS -- */}
          {(()=>{
            const CARD_ICONS = {
              reclamos: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
              canjes:   <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
              envios:   <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="3" width="15" height="13" rx="1"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>,
              audio:    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>,
              meta:     <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/></svg>,
              arca:     <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>,
            };
            return (
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))",gap:14,marginBottom:28}}>
            {[
              {id:"reclamos", label:"Reclamos", desc:"Cambios y devoluciones",   stat:reclamosCount, statLabel:"activos",  accent:"#f87171", accentBg:"rgba(248,113,113,0.08)"},
              {id:"canjes",   label:"Canjes",   desc:"Influencers y contenido",  stat:canjesCount,   statLabel:"canjes",   accent:"#c084fc", accentBg:"rgba(192,132,252,0.08)"},
              {id:"envios",   label:"Envíos",   desc:"Despachos y seguimientos", stat:ordersCount,   statLabel:"pedidos",  accent:"#60a5fa", accentBg:"rgba(96,165,250,0.08)"},
              {id:"audio",    label:"Audio Studio", desc:"Voces TTS con IA",     stat:null,          statLabel:"voces",    accent:"#a78bfa", accentBg:"rgba(167,139,250,0.08)"},
              {id:"meta",     label:"Meta Ads",      desc:"Campañas y creativos IA", stat:null, statLabel:"",       accent:"#60a5fa", accentBg:"rgba(96,165,250,0.08)"},
              {id:"arca",     label:"ARCA",          desc:"Facturación electrónica", stat:null, statLabel:"",       accent:"#4ade80", accentBg:"rgba(74,222,128,0.08)"},
            ].map(item=>(
              <button key={item.id} onClick={()=>onNavigate(item.id)}
                style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"24px 24px 20px",textAlign:"left",cursor:"pointer",transition:"all 0.15s",fontFamily:"'Inter',system-ui,sans-serif",color:T.text,display:"flex",flexDirection:"column",position:"relative",overflow:"hidden"}}
                onMouseEnter={e=>{e.currentTarget.style.borderColor=item.accent+"88";e.currentTarget.style.transform="translateY(-2px)";e.currentTarget.style.boxShadow=`0 8px 24px ${item.accent}18`;}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor=T.border;e.currentTarget.style.transform="translateY(0)";e.currentTarget.style.boxShadow="none";}}>
                <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:item.accent,borderRadius:"14px 14px 0 0"}}/>
                <div style={{width:40,height:40,borderRadius:10,background:item.accentBg,border:`1px solid ${item.accent}33`,display:"flex",alignItems:"center",justifyContent:"center",color:item.accent,marginBottom:14,marginTop:6}}>
                  {CARD_ICONS[item.id]}
                </div>
                <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:4}}>{item.label}</div>
                <div style={{fontSize:12,color:T.textSm,marginBottom:20,lineHeight:1.5}}>{item.desc}</div>
                <div style={{marginTop:"auto",paddingTop:18,borderTop:`1px solid ${T.borderL}`,display:"flex",alignItems:"baseline",gap:6}}>
                  {(item.id==="audio"||item.id==="meta")
                    ? <span style={{fontSize:item.id==="audio"?20:16,fontWeight:800,color:item.accent,letterSpacing:-0.5,lineHeight:1}}>{item.id==="audio"?"30 voces":"Graph API"}</span>
                    : <><span style={{fontSize:34,fontWeight:800,color:item.accent,letterSpacing:-1.5,lineHeight:1}}>{item.stat??<Spinner size={16} color={item.accent}/>}</span><span style={{fontSize:12,color:T.textSm}}>{item.statLabel}</span></>
                  }
                </div>
              </button>
            ))}
          </div>
            );
          })()}

          {/* -- NOTIFICACIONES DE CANJES -- */}
          {notificacionesCanjes.length>0&&(
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,overflow:"hidden"}}>
              <div
                onClick={()=>setNotifCollapsed(c=>!c)}
                style={{padding:"10px 18px",display:"flex",alignItems:"center",gap:8,cursor:"pointer",userSelect:"none",transition:"background 0.15s ease"}}
                onMouseEnter={e=>e.currentTarget.style.background=T.surface}
                onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                <span style={{width:6,height:6,borderRadius:"50%",background:T.orange,flexShrink:0}}/>
                <span style={{fontSize:11,fontWeight:600,color:T.textMd,textTransform:"uppercase",letterSpacing:0.5}}>Notificaciones · Canjes</span>
                <span style={{fontSize:11,background:T.orangeBg,color:T.orange,borderRadius:4,padding:"1px 7px",fontWeight:600,border:`1px solid ${T.orange}33`,marginLeft:2}}>{notificacionesCanjes.length}</span>
                <span style={{marginLeft:"auto",fontSize:13,color:T.textSm,display:"inline-block",transition:"transform 0.25s cubic-bezier(0.4,0,0.2,1)",transform:notifCollapsed?"rotate(-90deg)":"rotate(0deg)"}}>▾</span>
              </div>
              {/* maxHeight animation - no mount/unmount */}
              <div style={{
                maxHeight: notifCollapsed ? "0px" : `${notificacionesCanjes.length * 54}px`,
                overflow: "hidden",
                transition: "max-height 0.28s cubic-bezier(0.4,0,0.2,1)",
                borderTop: notifCollapsed ? "none" : `1px solid ${T.borderL}`,
              }}>
                {notificacionesCanjes.map((a,i)=>{
                  const colorMap={recordatorio:T.yellow,sinrespuesta:T.orange,contenido:T.blue};
                  const col=colorMap[a.tipo]||T.orange;
                  return (
                    <div key={i}
                      onClick={()=>onNavigate("canjes", a.canje._docId)}
                      style={{padding:"11px 18px",display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer",borderBottom:i<notificacionesCanjes.length-1?`1px solid ${T.borderL}`:"none",transition:"background 0.15s ease"}}
                      onMouseEnter={e=>e.currentTarget.style.background=T.surface}
                      onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                      <div style={{display:"flex",alignItems:"center",gap:10}}>
                        <span style={{width:5,height:5,borderRadius:"50%",background:col,flexShrink:0}}/>
                        <span style={{fontSize:13,fontWeight:600,color:T.text}}>{a.canje.influencer}</span>
                        <span style={{fontSize:12,color:T.textSm}}>{a.msg}</span>
                      </div>
                      <span style={{fontSize:11,color:T.textSm}}>Ver →</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}


// ===========================================
// AUTH SCREEN
// ===========================================
function AuthScreen({T, darkMode, onToggleDark}) {
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
      <button onClick={onToggleDark} style={{position:"fixed",top:20,right:20,background:"transparent",border:`1px solid ${T.border}`,borderRadius:7,padding:"5px 10px",fontSize:11,color:T.textSm,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>{darkMode?"☀︎ Claro":"◑ Oscuro"}</button>
      <div style={{width:"100%",maxWidth:400}}>
        {/* Logo */}
        <div style={{textAlign:"center",marginBottom:36}}>
          <div style={{width:40,height:40,borderRadius:10,background:T.accentSolid,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,margin:"0 auto 12px"}}>🌙</div>
          <div style={{fontSize:22,fontWeight:800,color:T.text,letterSpacing:-0.5}}>Growith</div>
          <div style={{fontSize:13,color:T.textSm,marginTop:3}}>{mode==="login"?"Iniciá sesión":"Creá tu cuenta"}</div>
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

// ===========================================
// CONFIG SCREEN
// ===========================================
function ConfigScreen({T, user, onBack, darkMode, onToggleDark}) {
  const [userDoc,setUserDoc]=useState(null);
  const [saving,setSaving]=useState(false);
  const [msg,setMsg]=useState("");
  const [showShopifyModal,setShowShopifyModal]=useState(false);
  const [shopifyShop,setShopifyShop]=useState("");
  const [shopifyClientId,setShopifyClientId]=useState("");
  const [shopifySecret,setShopifySecret]=useState("");
  const [connectingShopify,setConnectingShopify]=useState(false);
  const [showMLModal,setShowMLModal]=useState(false);
  const [mlClientId,setMlClientId]=useState("");
  const [mlSecret,setMlSecret]=useState("");
  const [connectingML,setConnectingML]=useState(false);
  const [connectingMeta,setConnectingMeta]=useState(false);
  const [showMetaModal,setShowMetaModal]=useState(false);
  const [metaMode,setMetaMode]=useState("oauth"); // "oauth" | "token"
  const [metaToken,setMetaToken]=useState("");

  // Detectar callback OAuth (Shopify / ML) al volver
  useEffect(()=>{
    const url=new URL(window.location.href);
    const shSuccess=url.searchParams.get("shopify_success");
    const shError=url.searchParams.get("shopify_error");
    const mlSuccess=url.searchParams.get("ml_success");
    const mlError=url.searchParams.get("ml_error");
    if(shSuccess){
      setMsg("Shopify conectado ✓");
      url.searchParams.delete("shopify_success");
      window.history.replaceState({},"",url.pathname+url.search);
    } else if(shError){
      const map={
        token_failed:"Shopify rechazó el intercambio. Verificá que el Client Secret esté correcto en Vercel.",
        missing_env_vars:"Faltan SHOPIFY_CLIENT_ID o SHOPIFY_CLIENT_SECRET en Vercel.",
        no_access_token:"Shopify no devolvió access_token.",
        user_not_found:"Tu usuario no se encontró en Firestore.",
        tn_already_connected:"Ya tenés Tienda Nube conectada. Desvinculala primero.",
        save_failed:"No se pudo guardar la conexión en Firestore.",
        missing_params:"Faltan parámetros en el callback.",
        server_error:"Error de conexión con Shopify.",
      };
      setMsg("Error Shopify: "+(map[shError]||shError));
      url.searchParams.delete("shopify_error");
      url.searchParams.delete("status");
      window.history.replaceState({},"",url.pathname+url.search);
    } else if(mlSuccess){
      setMsg("Mercado Libre conectado ✓");
      url.searchParams.delete("ml_success");
      window.history.replaceState({},"",url.pathname+url.search);
    } else if(mlError){
      const map={
        token_failed:"Mercado Libre rechazó el intercambio. Revisá ML_CLIENT_SECRET en Vercel.",
        missing_env_vars:"Faltan ML_CLIENT_ID o ML_CLIENT_SECRET en Vercel.",
        no_tokens:"ML no devolvió access_token / refresh_token.",
        user_not_found:"Tu usuario no se encontró en Firestore.",
        save_failed:"No se pudo guardar la conexión en Firestore.",
        missing_params:"Faltan parámetros en el callback.",
        state_not_found:"El proceso OAuth expiró. Probá conectar de nuevo.",
        server_error:"Error de conexión con Mercado Libre.",
      };
      setMsg("Error ML: "+(map[mlError]||mlError));
      url.searchParams.delete("ml_error");
      url.searchParams.delete("status");
      window.history.replaceState({},"",url.pathname+url.search);
    } else if(url.searchParams.get("meta_success")){
      setMsg("Meta conectada ✓");
      url.searchParams.delete("meta_success");
      window.history.replaceState({},"",url.pathname+url.search);
    } else if(url.searchParams.get("meta_error")){
      const e=url.searchParams.get("meta_error");
      const map={
        cancelled:"Cancelaste la conexión con Meta.",
        token_failed:"Meta rechazó el intercambio de credenciales.",
        me_failed:"No se pudo obtener info de tu cuenta de Meta.",
        user_not_found:"Tu usuario no se encontró en Firestore.",
        server_error:"Error de conexión con Meta.",
      };
      setMsg("Error Meta: "+(map[e]||e));
      url.searchParams.delete("meta_error");
      window.history.replaceState({},"",url.pathname+url.search);
    }
  },[]);
  const iS=InputStyle(T);

  async function connectShopify() {
    if(!shopifyShop.trim() || !shopifyClientId.trim() || !shopifySecret.trim()) {
      setMsg("Completá los 3 campos"); return;
    }
    setConnectingShopify(true);
    try {
      const r = await fetch("/api/integrations?platform=shopify&action=oauth_start", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          uid: user.uid,
          shop: shopifyShop.trim(),
          client_id: shopifyClientId.trim(),
          client_secret: shopifySecret.trim(),
        }),
      });
      const d = await r.json();
      if(d.error) { setMsg("Error: "+d.error); setConnectingShopify(false); return; }
      // Abrir Shopify para autorización
      window.open(d.url, "_blank");
      setMsg("Completá la autorización en la ventana que se abrió. Volvé acá cuando termines.");
      setShowShopifyModal(false);
      setShopifyShop(""); setShopifyClientId(""); setShopifySecret("");
    } catch(e) {
      setMsg("Error de red: "+e.message);
    } finally {
      setConnectingShopify(false);
    }
  }

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

  async function connectMetaOauth() {
    setConnectingMeta(true);
    try {
      const r = await fetch(`/api/meta?action=oauth_start&uid=${user.uid}`);
      const d = await r.json();
      if(d.error) { setMsg("Error: "+d.error); setConnectingMeta(false); return; }
      window.open(d.url, "_blank");
      setMsg("Completá la autorización en la ventana que se abrió. Volvé acá cuando termines.");
      setShowMetaModal(false);
    } catch(e) {
      setMsg("Error de red: "+e.message);
    } finally {
      setConnectingMeta(false);
    }
  }

  async function connectMetaWithToken() {
    if(!metaToken.trim()) { setMsg("Pegá tu System User Token"); return; }
    setConnectingMeta(true);
    try {
      // 1. connect: valida el token y trae info
      const cr = await fetch(`/api/meta?action=connect&uid=${user.uid}`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({access_token: metaToken.trim()}),
      }).then(r=>r.json());
      if(cr.error) { setMsg("Error: "+cr.error); setConnectingMeta(false); return; }

      // 2. select: si trae al menos 1 ad_account, auto-seleccionar el primero
      const aa = (cr.ad_accounts||[])[0];
      const pg = (cr.pages||[])[0];
      if(aa) {
        const ig = pg?.instagram_business_account;
        const sr = await fetch(`/api/meta?action=select&uid=${user.uid}&acc_id=${cr.id}`, {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({
            ad_account_id: aa.id, ad_account_name: aa.name||"",
            page_id: pg?.id||"", page_name: pg?.name||"",
            page_access_token: pg?.access_token||metaToken.trim(),
            ig_account_id: ig?.id||"", ig_username: ig?.username||"",
          }),
        }).then(r=>r.json());
        if(sr.error) { setMsg("Conectó pero falló select: "+sr.error); }
      }

      // 3. set_active
      await fetch(`/api/meta?action=set_active&uid=${user.uid}`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({id: cr.id}),
      });

      setMsg(`Meta conectada ✓${(cr.ad_accounts||[]).length>1?" — para cambiar de cuenta publicitaria andá a Meta Ads → Cuenta.":""}`);
      setShowMetaModal(false);
      setMetaToken("");
    } catch(e) {
      setMsg("Error de red: "+e.message);
    } finally {
      setConnectingMeta(false);
    }
  }

  async function disconnectMeta() {
    if(!window.confirm("¿Desvincular Meta? Vas a perder el acceso a las cuentas conectadas.")) return;
    setSaving(true);
    try {
      await fetch(`/api/meta?action=disconnect&uid=${user.uid}`, {method:"POST"});
      setMsg("Meta desvinculada.");
    } finally { setSaving(false); }
  }

  async function connectML() {
    if(!mlClientId.trim() || !mlSecret.trim()) {
      setMsg("Completá los 2 campos"); return;
    }
    setConnectingML(true);
    try {
      const r = await fetch("/api/integrations?platform=mercadolibre&action=oauth_start", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          uid: user.uid,
          client_id: mlClientId.trim(),
          client_secret: mlSecret.trim(),
        }),
      });
      const d = await r.json();
      if(d.error) { setMsg("Error: "+d.error); setConnectingML(false); return; }
      window.open(d.url, "_blank");
      setMsg("Completá la autorización en la ventana que se abrió. Volvé acá cuando termines.");
      setShowMLModal(false);
      setMlClientId(""); setMlSecret("");
    } catch(e) {
      setMsg("Error de red: "+e.message);
    } finally {
      setConnectingML(false);
    }
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
  const mlStore=userDoc?.stores?.find(s=>s.type==="mercadolibre");
  const metaConnected=!!userDoc?.meta_active_account;
  const alertasCfg=userDoc?.alertas||{recordatorio:true,sinrespuesta:true,contenido:true};

  const Toggle=({active,onToggle})=>(
    <div onClick={onToggle} style={{width:44,height:24,borderRadius:20,background:active?T.accentSolid:T.border,cursor:"pointer",position:"relative",transition:"background 0.2s",flexShrink:0}}>
      <div style={{position:"absolute",top:3,left:active?22:3,width:18,height:18,borderRadius:"50%",background:"#fff",transition:"left 0.2s",boxShadow:"0 1px 4px rgba(0,0,0,0.3)"}}/>
    </div>
  );

  return (
    <div style={{fontFamily:"'Inter',system-ui,sans-serif",background:T.bg,minHeight:"100vh",color:T.text}}>
      <div style={{borderBottom:`1px solid ${T.border}`,background:T.surface,padding:"0 24px"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",height:60,maxWidth:800,margin:"0 auto"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <button onClick={onBack} style={{...BtnSecondary(T),padding:"5px 12px",fontSize:13}}>← Inicio</button>
            <span style={{color:T.borderL,fontSize:15}}>/</span>
            <span style={{fontWeight:700,fontSize:14,color:T.text}}>Configuración</span>
          </div>
          <button onClick={onToggleDark} style={{...BtnSecondary(T),padding:"5px 10px",fontSize:11,color:T.textSm}}>{darkMode?"☀︎ Modo claro":"◑ Modo oscuro"}</button>
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
          <div style={{fontSize:11,color:T.textSm,marginBottom:10,lineHeight:1.5}}>
            Conectá <strong style={{color:T.text}}>una</strong> plataforma de e-commerce (TN <em>o</em> Shopify), <strong style={{color:T.text}}>Mercado Libre</strong> y <strong style={{color:T.text}}>Meta Ads</strong> (Facebook + Instagram) para el módulo de análisis y optimización de campañas.
          </div>
          {/* Tienda Nube */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"14px 0",borderBottom:`1px solid ${T.borderL}`,gap:10,opacity:shStore && !tnStore ? 0.5 : 1}}>
            <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>
              <div style={{width:36,height:36,borderRadius:8,background:"#00a0e3",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>☁️</div>
              <div style={{minWidth:0}}>
                <div style={{fontSize:14,fontWeight:700,color:T.text}}>Tienda Nube</div>
                {tnStore
                  ? <div style={{fontSize:11,color:T.green,marginTop:1}}>✓ {tnStore.storeName||tnStore.storeId}</div>
                  : shStore
                    ? <div style={{fontSize:11,color:T.textSm,marginTop:1}}>Desvinculá Shopify primero</div>
                    : <div style={{fontSize:11,color:T.textSm,marginTop:1}}>No conectado</div>}
              </div>
            </div>
            {tnStore
              ?<button onClick={()=>disconnectStore("tiendanube")} disabled={saving} style={{...BtnDanger(T),fontSize:12,padding:"6px 12px",flexShrink:0}}>Desvincular</button>
              :<button onClick={connectTiendaNube} disabled={!!shStore} style={{...BtnPrimary(T),fontSize:12,padding:"6px 12px",flexShrink:0,opacity:shStore?0.4:1,cursor:shStore?"not-allowed":"pointer"}}>Conectar</button>
            }
          </div>
          {/* Shopify */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"14px 0",gap:10,opacity:tnStore && !shStore ? 0.5 : 1}}>
            <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>
              <div style={{width:36,height:36,borderRadius:8,background:"#96BF48",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>🛍️</div>
              <div style={{minWidth:0}}>
                <div style={{fontSize:14,fontWeight:700,color:T.text}}>Shopify</div>
                {shStore
                  ? <div style={{fontSize:11,color:T.green,marginTop:1}}>✓ {shStore.storeName||shStore.shop}</div>
                  : tnStore
                    ? <div style={{fontSize:11,color:T.textSm,marginTop:1}}>Desvinculá Tienda Nube primero</div>
                    : <div style={{fontSize:11,color:T.textSm,marginTop:1}}>No conectado</div>}
              </div>
            </div>
            {shStore
              ?<button onClick={()=>disconnectStore("shopify")} disabled={saving} style={{...BtnDanger(T),fontSize:12,padding:"6px 12px",flexShrink:0}}>Desvincular</button>
              :<button onClick={()=>setShowShopifyModal(true)} disabled={!!tnStore} style={{...BtnPrimary(T),fontSize:12,padding:"6px 12px",flexShrink:0,opacity:tnStore?0.4:1,cursor:tnStore?"not-allowed":"pointer"}}>Conectar</button>
            }
          </div>
          {/* Mercado Libre */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"14px 0",borderTop:`1px solid ${T.borderL}`,gap:10}}>
            <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>
              <div style={{width:36,height:36,borderRadius:8,background:"#FFE600",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>🛒</div>
              <div style={{minWidth:0}}>
                <div style={{fontSize:14,fontWeight:700,color:T.text}}>Mercado Libre</div>
                {mlStore
                  ? <div style={{fontSize:11,color:T.green,marginTop:1}}>✓ {mlStore.nickname||mlStore.userId}</div>
                  : <div style={{fontSize:11,color:T.textSm,marginTop:1}}>No conectado</div>}
              </div>
            </div>
            {mlStore
              ?<button onClick={()=>disconnectStore("mercadolibre")} disabled={saving} style={{...BtnDanger(T),fontSize:12,padding:"6px 12px",flexShrink:0}}>Desvincular</button>
              :<button onClick={()=>setShowMLModal(true)} style={{...BtnPrimary(T),fontSize:12,padding:"6px 12px",flexShrink:0}}>Conectar</button>
            }
          </div>
          {/* Meta Ads */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"14px 0",borderTop:`1px solid ${T.borderL}`,gap:10}}>
            <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>
              <div style={{width:36,height:36,borderRadius:8,background:"#1877F2",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0,color:"#fff",fontWeight:800}}>f</div>
              <div style={{minWidth:0}}>
                <div style={{fontSize:14,fontWeight:700,color:T.text}}>Meta Ads <span style={{fontSize:10,color:T.textSm,fontWeight:400}}>· Facebook + Instagram</span></div>
                {metaConnected
                  ? <div style={{fontSize:11,color:T.green,marginTop:1}}>✓ Conectada</div>
                  : <div style={{fontSize:11,color:T.textSm,marginTop:1}}>No conectado</div>}
              </div>
            </div>
            {metaConnected
              ?<button onClick={disconnectMeta} disabled={saving} style={{...BtnDanger(T),fontSize:12,padding:"6px 12px",flexShrink:0}}>Desvincular</button>
              :<button onClick={()=>setShowMetaModal(true)} style={{...BtnPrimary(T),fontSize:12,padding:"6px 12px",flexShrink:0}}>Conectar</button>
            }
          </div>
        </div>

        {/* Modal conectar Shopify */}
        {showShopifyModal && (
          <div style={{position:"fixed",inset:0,zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.6)",backdropFilter:"blur(4px)",padding:16}} onClick={()=>!connectingShopify && setShowShopifyModal(false)}>
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:16,width:"100%",maxWidth:560,maxHeight:"92vh",overflowY:"auto",padding:"24px 28px"}} onClick={e=>e.stopPropagation()}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
                <div>
                  <div style={{fontSize:16,fontWeight:700,color:T.text}}>Conectar Shopify</div>
                  <div style={{fontSize:11,color:T.textSm,marginTop:2}}>Pegá las credenciales de TU app de Shopify (creada en Dev Dashboard)</div>
                </div>
                <button onClick={()=>!connectingShopify && setShowShopifyModal(false)} disabled={connectingShopify} style={{background:"transparent",border:"none",color:T.textMd,cursor:connectingShopify?"wait":"pointer",fontSize:18,padding:4,lineHeight:1}}>✕</button>
              </div>

              <div style={{padding:12,background:T.bg,border:`1px solid ${T.borderL}`,borderRadius:10,marginBottom:16,fontSize:11,color:T.textMd,lineHeight:1.65}}>
                <div style={{fontWeight:700,color:T.text,marginBottom:6}}>📖 Crear tu app en Shopify (3 minutos)</div>
                <ol style={{margin:0,paddingLeft:18}}>
                  <li>Entrá a <a href="https://dev.shopify.com/dashboard" target="_blank" rel="noopener" style={{color:T.accent,textDecoration:"underline"}}>dev.shopify.com/dashboard</a> → <strong style={{color:T.text}}>"Crear app"</strong> → nombre "Growith"</li>
                  <li>"Versiones" → <strong style={{color:T.text}}>"Crear versión"</strong> → en "Acceso" → Seleccionar alcances:
                    <div style={{margin:"3px 0",display:"flex",gap:4,flexWrap:"wrap"}}>
                      <code style={{background:T.surface,padding:"1px 6px",borderRadius:3,fontSize:10,color:T.accent}}>read_all_orders</code>
                      <code style={{background:T.surface,padding:"1px 6px",borderRadius:3,fontSize:10,color:T.accent}}>read_customers</code>
                      <code style={{background:T.surface,padding:"1px 6px",borderRadius:3,fontSize:10,color:T.accent}}>read_orders</code>
                      <code style={{background:T.surface,padding:"1px 6px",borderRadius:3,fontSize:10,color:T.accent}}>write_orders</code>
                    </div>
                  </li>
                  <li>⚠ En esa misma versión, agregá esta <strong style={{color:T.text}}>URL de redireccionamiento</strong>:
                    <div style={{marginTop:3,padding:"4px 7px",background:T.surface,borderRadius:4,fontFamily:"monospace",fontSize:9,wordBreak:"break-all"}}>{`https://www.growithapp.com/api/integrations?platform=shopify&action=callback`}</div>
                  </li>
                  <li>Publicar la versión</li>
                  <li>"Configuración" → copiá el <strong style={{color:T.text}}>ID de cliente</strong> y el <strong style={{color:T.text}}>Secreto</strong> (tocá el ojito) → pegalos abajo</li>
                </ol>
              </div>

              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div>
                  <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:6}}>Subdominio Shopify</div>
                  <input value={shopifyShop} onChange={e=>setShopifyShop(e.target.value)} placeholder="xxxx-xx" style={iS} disabled={connectingShopify} autoFocus/>
                  <div style={{fontSize:10,color:T.textSm,marginTop:4}}>Solo el subdominio (sin .myshopify.com). Lo encontrás en la URL de tu admin.</div>
                </div>
                <div>
                  <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:6}}>Client ID</div>
                  <input value={shopifyClientId} onChange={e=>setShopifyClientId(e.target.value)} placeholder="8a3b6810ff78..." style={{...iS,fontFamily:"monospace"}} disabled={connectingShopify}/>
                </div>
                <div>
                  <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:6}}>Client Secret</div>
                  <input value={shopifySecret} onChange={e=>setShopifySecret(e.target.value)} placeholder="..." type="password" style={{...iS,fontFamily:"monospace"}} disabled={connectingShopify}/>
                  <div style={{fontSize:10,color:T.textSm,marginTop:4}}>Se usa una sola vez para autorizar. Se guarda cifrado.</div>
                </div>
              </div>

              <div style={{display:"flex",gap:10,marginTop:22}}>
                <button onClick={()=>setShowShopifyModal(false)} disabled={connectingShopify} style={{...BtnSecondary(T),fontSize:13,padding:"10px 18px"}}>Cancelar</button>
                <div style={{flex:1}}/>
                <button onClick={connectShopify} disabled={connectingShopify||!shopifyShop.trim()||!shopifyClientId.trim()||!shopifySecret.trim()} style={{...BtnPrimary(T),fontSize:13,padding:"10px 24px",opacity:(!shopifyShop.trim()||!shopifyClientId.trim()||!shopifySecret.trim())?0.5:1}}>
                  {connectingShopify?"Abriendo...":"Autorizar en Shopify →"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal conectar Mercado Libre */}
        {showMLModal && (
          <div style={{position:"fixed",inset:0,zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.6)",backdropFilter:"blur(4px)",padding:16}} onClick={()=>!connectingML && setShowMLModal(false)}>
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:16,width:"100%",maxWidth:560,maxHeight:"92vh",overflowY:"auto",padding:"24px 28px"}} onClick={e=>e.stopPropagation()}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
                <div>
                  <div style={{fontSize:16,fontWeight:700,color:T.text}}>Conectar Mercado Libre</div>
                  <div style={{fontSize:11,color:T.textSm,marginTop:2}}>Pegá las credenciales de TU app de ML (creada en developers.mercadolibre.com.ar)</div>
                </div>
                <button onClick={()=>!connectingML && setShowMLModal(false)} disabled={connectingML} style={{background:"transparent",border:"none",color:T.textMd,cursor:connectingML?"wait":"pointer",fontSize:18,padding:4,lineHeight:1}}>✕</button>
              </div>

              <div style={{padding:12,background:T.bg,border:`1px solid ${T.borderL}`,borderRadius:10,marginBottom:16,fontSize:11,color:T.textMd,lineHeight:1.65}}>
                <div style={{fontWeight:700,color:T.text,marginBottom:6}}>📖 Crear tu app en Mercado Libre (5 minutos)</div>
                <ol style={{margin:0,paddingLeft:18}}>
                  <li>Entrá a <a href="https://developers.mercadolibre.com.ar/devcenter" target="_blank" rel="noopener" style={{color:T.accent,textDecoration:"underline"}}>developers.mercadolibre.com.ar/devcenter</a> con tu cuenta ML y vinculá tu cuenta de developer</li>
                  <li><strong style={{color:T.text}}>"Crear aplicación"</strong> → completá nombre, descripción, propósito "Negocios"</li>
                  <li>En <strong style={{color:T.text}}>Flujos OAuth</strong> marcá: <code style={{background:T.surface,padding:"1px 6px",borderRadius:3,fontSize:10,color:T.accent}}>Authorization Code</code> y <code style={{background:T.surface,padding:"1px 6px",borderRadius:3,fontSize:10,color:T.accent}}>Refresh Token</code></li>
                  <li>En <strong style={{color:T.text}}>Negocios</strong> marcá <code style={{background:T.surface,padding:"1px 6px",borderRadius:3,fontSize:10,color:T.accent}}>Mercado Libre</code></li>
                  <li>En <strong style={{color:T.text}}>Permisos</strong> dale "Lectura y escritura" a: Usuarios, Facturación, Venta y envíos. Y "Lectura" a Métricas del negocio.</li>
                  <li>⚠ En <strong style={{color:T.text}}>Redirect URIs</strong> agregá exactamente:
                    <div style={{marginTop:3,padding:"4px 7px",background:T.surface,borderRadius:4,fontFamily:"monospace",fontSize:9,wordBreak:"break-all"}}>{`https://www.growithapp.com/api/integrations?platform=mercadolibre&action=callback`}</div>
                  </li>
                  <li>Guardá → te aparece el <strong style={{color:T.text}}>App ID</strong> (Client ID) y el <strong style={{color:T.text}}>Secret Key</strong> (Client Secret) → pegalos abajo</li>
                </ol>
              </div>

              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div>
                  <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:6}}>App ID (Client ID)</div>
                  <input value={mlClientId} onChange={e=>setMlClientId(e.target.value)} placeholder="6123377008994979" style={{...iS,fontFamily:"monospace"}} disabled={connectingML} autoFocus/>
                </div>
                <div>
                  <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:6}}>Secret Key (Client Secret)</div>
                  <input value={mlSecret} onChange={e=>setMlSecret(e.target.value)} placeholder="..." type="password" style={{...iS,fontFamily:"monospace"}} disabled={connectingML}/>
                  <div style={{fontSize:10,color:T.textSm,marginTop:4}}>Se guarda cifrado para refrescar el token automáticamente cada 6 hs.</div>
                </div>
              </div>

              <div style={{display:"flex",gap:10,marginTop:22}}>
                <button onClick={()=>setShowMLModal(false)} disabled={connectingML} style={{...BtnSecondary(T),fontSize:13,padding:"10px 18px"}}>Cancelar</button>
                <div style={{flex:1}}/>
                <button onClick={connectML} disabled={connectingML||!mlClientId.trim()||!mlSecret.trim()} style={{...BtnPrimary(T),fontSize:13,padding:"10px 24px",opacity:(!mlClientId.trim()||!mlSecret.trim())?0.5:1}}>
                  {connectingML?"Abriendo...":"Autorizar en ML →"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal conectar Meta */}
        {showMetaModal && (
          <div style={{position:"fixed",inset:0,zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.6)",backdropFilter:"blur(4px)",padding:16}} onClick={()=>!connectingMeta && setShowMetaModal(false)}>
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:16,width:"100%",maxWidth:640,maxHeight:"92vh",overflowY:"auto",padding:"24px 28px"}} onClick={e=>e.stopPropagation()}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
                <div>
                  <div style={{fontSize:16,fontWeight:700,color:T.text}}>Conectar Meta Ads</div>
                  <div style={{fontSize:11,color:T.textSm,marginTop:2}}>Elegí cómo querés autorizar el acceso a tus campañas</div>
                </div>
                <button onClick={()=>!connectingMeta && setShowMetaModal(false)} disabled={connectingMeta} style={{background:"transparent",border:"none",color:T.textMd,cursor:connectingMeta?"wait":"pointer",fontSize:18,padding:4}}>✕</button>
              </div>

              {/* Tabs OAuth / Token */}
              <div style={{display:"flex",gap:2,background:T.bg,padding:3,borderRadius:8,border:`1px solid ${T.borderL}`,marginBottom:16}}>
                <button onClick={()=>setMetaMode("oauth")} style={{flex:1,padding:"9px 12px",fontSize:12,fontWeight:600,border:"none",borderRadius:6,background:metaMode==="oauth"?T.card:"transparent",color:metaMode==="oauth"?T.text:T.textSm,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>🔗 Facebook (1 clic)</button>
                <button onClick={()=>setMetaMode("token")} style={{flex:1,padding:"9px 12px",fontSize:12,fontWeight:600,border:"none",borderRadius:6,background:metaMode==="token"?T.card:"transparent",color:metaMode==="token"?T.text:T.textSm,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>🔑 System Token</button>
              </div>

              {metaMode === "oauth" ? (
                <div>
                  <div style={{padding:"12px 14px",background:T.bg,border:`1px solid ${T.borderL}`,borderRadius:10,fontSize:12,color:T.textMd,lineHeight:1.6,marginBottom:14}}>
                    Te abre Facebook en una pestaña nueva → autorizás los permisos (ads_management, ads_read, etc.) → volvés conectado a Growith. <strong style={{color:T.text}}>Lo más simple si funciona.</strong>
                  </div>
                  <div style={{padding:"10px 14px",background:T.yellowBg,border:`1px solid ${T.yellow}33`,borderRadius:8,fontSize:11,color:T.textMd,lineHeight:1.5,marginBottom:14}}>
                    ⚠ Si te aparece <em>"La app no está activa"</em>, es porque la app de Meta de Growith todavía está en modo Development. Usá la opción <strong style={{color:T.text}}>System Token</strong> de al lado — funciona aunque la app no esté publicada.
                  </div>
                  <div style={{display:"flex",justifyContent:"flex-end",gap:10}}>
                    <button onClick={()=>setShowMetaModal(false)} disabled={connectingMeta} style={{...BtnSecondary(T),fontSize:13,padding:"10px 18px"}}>Cancelar</button>
                    <button onClick={connectMetaOauth} disabled={connectingMeta} style={{...BtnPrimary(T),fontSize:13,padding:"10px 24px"}}>
                      {connectingMeta?"Abriendo Facebook...":"Conectar con Facebook →"}
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <div style={{padding:"12px 14px",background:T.bg,border:`1px solid ${T.borderL}`,borderRadius:10,fontSize:11,color:T.textMd,lineHeight:1.65,marginBottom:14}}>
                    <div style={{fontWeight:700,color:T.text,marginBottom:8}}>📋 Cómo generar tu System User Token (5 min)</div>
                    <ol style={{margin:0,paddingLeft:18}}>
                      <li>Entrá a <a href="https://business.facebook.com/settings/system-users" target="_blank" rel="noopener" style={{color:T.accent,textDecoration:"underline"}}>business.facebook.com → Configuración del negocio → Usuarios → Usuarios del sistema</a></li>
                      <li>Click en <strong style={{color:T.text}}>+ Agregar</strong> → ponele un nombre (ej: "Growith") → rol: <strong style={{color:T.text}}>Administrador</strong> → Crear usuario del sistema</li>
                      <li>Click en los <strong style={{color:T.text}}>3 puntos</strong> del usuario que creaste → <strong style={{color:T.text}}>Asignar activos</strong> → seleccioná tu Ad Account y tu Página → <strong style={{color:T.text}}>permisos completos</strong> → Guardar</li>
                      <li>Click en <strong style={{color:T.text}}>Generar token</strong> → elegí cualquier app tuya (o pedile a Growith que cree una) → permisos: <code style={{background:T.surface,padding:"1px 5px",borderRadius:3,fontSize:10,color:T.accent}}>ads_management</code> <code style={{background:T.surface,padding:"1px 5px",borderRadius:3,fontSize:10,color:T.accent}}>ads_read</code> <code style={{background:T.surface,padding:"1px 5px",borderRadius:3,fontSize:10,color:T.accent}}>pages_show_list</code> <code style={{background:T.surface,padding:"1px 5px",borderRadius:3,fontSize:10,color:T.accent}}>business_management</code> → vencimiento: <strong style={{color:T.text}}>Nunca</strong> → Generar token</li>
                      <li>Copiá el token (empieza con <code style={{background:T.surface,padding:"1px 5px",borderRadius:3,fontSize:10,color:T.accent}}>EAA...</code>) y pegalo abajo</li>
                    </ol>
                    <div style={{marginTop:10,padding:"8px 12px",background:T.greenBg,border:`1px solid ${T.green}33`,borderRadius:6,fontSize:11,color:T.green}}>
                      ✓ El token "Nunca vence" — no vas a tener que renovarlo.
                    </div>
                  </div>
                  <div style={{marginBottom:14}}>
                    <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:6}}>System User Token</div>
                    <textarea value={metaToken} onChange={e=>setMetaToken(e.target.value)} placeholder="EAA..." rows={4} style={{...iS,fontFamily:"monospace",fontSize:11,resize:"vertical",minHeight:84}} disabled={connectingMeta}/>
                    <div style={{fontSize:10,color:T.textSm,marginTop:4}}>Se guarda cifrado en Firestore. Solo Growith lo usa para llamar a la API de Meta en tu nombre.</div>
                  </div>
                  <div style={{display:"flex",justifyContent:"flex-end",gap:10}}>
                    <button onClick={()=>setShowMetaModal(false)} disabled={connectingMeta} style={{...BtnSecondary(T),fontSize:13,padding:"10px 18px"}}>Cancelar</button>
                    <button onClick={connectMetaWithToken} disabled={connectingMeta||!metaToken.trim()} style={{...BtnPrimary(T),fontSize:13,padding:"10px 24px",opacity:metaToken.trim()?1:0.5}}>
                      {connectingMeta?"Conectando...":"Conectar →"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

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

// ===========================================

// ===========================================
// APP PLANES - Página de suscripción
// ===========================================
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
          <div style={{fontSize:20,fontWeight:700,color:planSelecc?.color}}>{planSelecc?.icon} {planSelecc?.nombre} - ${planSelecc?.precio} USDT/mes</div>
        </div>

        {/* Dirección USDT */}
        <div style={{marginBottom:24}}>
          <div style={{fontSize:12,fontWeight:600,color:T.textSm,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:10}}>Enviá exactamente ${planSelecc?.precio} USDT (TRC20) a esta dirección:</div>
          <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:10,padding:"14px 16px",display:"flex",alignItems:"center",gap:10}}>
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

// ===========================================
// APP ADMIN - Panel de administrador
// ===========================================
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
            <div key={i} style={{background:T.card,border:`1px solid ${T.border}`,borderLeft:`3px solid ${s.color}`,borderRadius:10,padding:"14px 18px",flex:"1 1 120px",minWidth:110}}>
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
              const fecha=p.createdAt?.toDate?.()?.toLocaleDateString("es-AR")||"--";
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
                <div key={u._id} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:"14px 16px",marginBottom:8,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
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


// ===========================================
// APP ARCA — Facturación electrónica AFIP
// ===========================================
function AppArca({T, user, onHome}) {
  const [cuits, setCuits] = useState([]);
  const [cuitSel, setCuitSel] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showCuitMenu, setShowCuitMenu] = useState(false);
  const [showGuia, setShowGuia] = useState(false);

  // Wizard CUIT - individual states to avoid re-render focus loss
  const [showWizard, setShowWizard] = useState(false);
  const [wizStep, setWizStep] = useState(0);
  const [wizCuit, setWizCuit] = useState("");
  const [wizTipoPersona, setWizTipoPersona] = useState("FISICA");
  const [wizRazonSocial, setWizRazonSocial] = useState("");
  const [wizNombreFantasia, setWizNombreFantasia] = useState("");
  const [wizDomicilio, setWizDomicilio] = useState("");
  const [wizFechaInicio, setWizFechaInicio] = useState("");
  const [wizCondicion, setWizCondicion] = useState("RESPONSABLE_INSCRIPTO");
  const [wizPuntoVenta, setWizPuntoVenta] = useState("1");
  const [wizArcaProd, setWizArcaProd] = useState(false);
  const [wizIngresosBrutos, setWizIngresosBrutos] = useState("");
  const [certText, setCertText] = useState("");
  const [keyText, setKeyText] = useState("");
  const [certFileName, setCertFileName] = useState("");
  const [keyFileName, setKeyFileName] = useState("");
  const [certFileError, setCertFileError] = useState("");
  const [keyFileError, setKeyFileError] = useState("");
  const [csrPem, setCsrPem] = useState("");
  const [genLoading, setGenLoading] = useState(false);
  const [genError, setGenError] = useState("");
  const [csrCopied, setCsrCopied] = useState(false);
  const [savingCuit, setSavingCuit] = useState(false);

  // Modal edición CUIT
  const [showEditCuit, setShowEditCuit] = useState(false);
  const [editCuit, setEditCuit] = useState(null);
  const [savingEdit, setSavingEdit] = useState(false);

  // Test conexión con ARCA del CUIT activo
  const [testingConn, setTestingConn] = useState(false);
  const [testConnResult, setTestConnResult] = useState(null);

  // Dashboard del CUIT activo (stats del mes)
  const [dashboardStats, setDashboardStats] = useState(null);

  // Ventas pendientes de las integraciones (TN/Shopify/ML)
  const [tnLoading, setTnLoading] = useState(false);
  const [tnData, setTnData] = useState(null); // {connected, store_name, ordenes, total_pending}
  const [tnSelected, setTnSelected] = useState({}); // {orderId: true|false}
  const [periodoModo, setPeriodoModo] = useState("7"); // "1"|"7"|"15"|"30"|"60"|"90"|"custom"
  const [fechaDesde, setFechaDesde] = useState(new Date(Date.now()-7*24*60*60*1000).toISOString().slice(0,10));
  const [fechaHasta, setFechaHasta] = useState(new Date().toISOString().slice(0,10));
  const [canalSel, setCanalSel] = useState("todos"); // "todos" | "tn" | "shopify" | "ml"
  const [montoMin, setMontoMin] = useState("");
  const [montoMax, setMontoMax] = useState("");
  const [showManualUpload, setShowManualUpload] = useState(false);

  // Historial de batches (facturaciones recientes)
  const [batches, setBatches] = useState([]);
  const [expandedBatch, setExpandedBatch] = useState(null);
  const [batchPdfs, setBatchPdfs] = useState({}); // {batchId: [pdfs]}
  const [loadingBatchPdfs, setLoadingBatchPdfs] = useState(null);

  // Modal facturación manual (mayoristas, etc)
  const [showManual, setShowManual] = useState(false);
  const [manualNombre, setManualNombre] = useState("");
  const [manualDocTipo, setManualDocTipo] = useState("CUIT");
  const [manualDocNro, setManualDocNro] = useState("");
  const [manualItems, setManualItems] = useState([{nombre:"",cantidad:1,precio:0}]);
  const [emittingManual, setEmittingManual] = useState(false);
  const [manualResult, setManualResult] = useState(null);
  const [testingCuit, setTestingCuit] = useState(null);
  const [testResult, setTestResult] = useState(null);

  // Facturar
  const [archivo, setArchivo] = useState(null);
  const [parsing, setParsing] = useState(false);
  const [ordenes, setOrdenes] = useState(null);
  const [productos, setProductos] = useState([]);
  const [productMap, setProductMap] = useState({});
  const [emitting, setEmitting] = useState(false);
  const [mesImputacion, setMesImputacion] = useState("actual"); // "actual" | "anterior"
  const [resultados, setResultados] = useState(null);
  const [pdfs, setPdfs] = useState([]);

  const uid = user?.uid;
  const cuitActivo = cuits.find(c => c.cuit === cuitSel);
  const iS = {width:"100%",background:T.input,border:`1px solid ${T.inputBorder}`,borderRadius:8,padding:"10px 13px",fontSize:13,color:T.text,fontFamily:"'Inter',system-ui,sans-serif",boxSizing:"border-box",outline:"none"};
  const labelS = {fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.6,marginBottom:6,display:"block"};
  // Mes navegado en el dashboard (default = mes actual ARG)
  const _now = new Date();
  const [dashMonth, setDashMonth] = useState(_now.getMonth()+1); // 1-12
  const [dashYear, setDashYear] = useState(_now.getFullYear());
  const mesesNombres = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
  const mesActual = `${mesesNombres[dashMonth-1]} ${dashYear}`;
  const esMesActualReal = dashMonth === _now.getMonth()+1 && dashYear === _now.getFullYear();
  function navMes(delta) {
    let m = dashMonth + delta, y = dashYear;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    // No permitir navegar a futuro
    if (y > _now.getFullYear() || (y === _now.getFullYear() && m > _now.getMonth()+1)) return;
    setDashMonth(m); setDashYear(y);
  }

  const api = (action, method="GET", body=null, extra={}) => {
    const params = new URLSearchParams({action, uid, ...extra});
    return fetch(`/api/arca?${params}`, {
      method,
      headers: method!=="GET"&&!(body instanceof FormData) ? {"Content-Type":"application/json"} : undefined,
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    }).then(r=>r.json());
  };

  useEffect(()=>{
    if(!uid) return;
    api("list_cuits").then(d=>{ if(d.cuits){ setCuits(d.cuits); if(d.cuits.length>0 && !cuitSel) setCuitSel(d.cuits[0].cuit); } }).finally(()=>setLoading(false));
  },[uid]);

  useEffect(()=>{
    if(!uid || !cuitSel) { setDashboardStats(null); setBatches([]); setTnData(null); return; }
    api("dashboard_stats","GET",null,{cuit:cuitSel,month:dashMonth,year:dashYear}).then(d=>{
      if(!d.error) setDashboardStats(d);
    });
    api("list_batches","GET",null,{cuit:cuitSel,month:dashMonth,year:dashYear}).then(d=>{
      if(!d.error) setBatches(d.batches||[]);
    });
  },[uid, cuitSel, dashMonth, dashYear]);

  useEffect(()=>{
    if(!uid || !cuitSel) return;
    if(periodoModo === "custom" && !fechaDesde) return;
    loadPendingOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[uid, cuitSel, periodoModo, fechaDesde, fechaHasta]);

  useEffect(()=>{
    if(!showCuitMenu) return;
    const h = (e) => { if(!e.target.closest('.arca-cuit-menu')) setShowCuitMenu(false); };
    document.addEventListener('click', h);
    return ()=>document.removeEventListener('click', h);
  },[showCuitMenu]);

  const formatCuit = (c) => c && c.length===11 ? c.slice(0,2)+"-"+c.slice(2,10)+"-"+c.slice(10) : c;

  function resetWizard(){
    setShowWizard(false); setWizStep(0);
    setWizCuit(""); setWizTipoPersona("FISICA"); setWizRazonSocial(""); setWizNombreFantasia("");
    setWizDomicilio(""); setWizFechaInicio(""); setWizCondicion("RESPONSABLE_INSCRIPTO");
    setWizPuntoVenta("1"); setWizArcaProd(false); setWizIngresosBrutos("");
    setCertText(""); setKeyText(""); setCertFileName(""); setKeyFileName("");
    setCertFileError(""); setKeyFileError(""); setTestResult(null);
    setCsrPem(""); setGenError(""); setCsrCopied(false);
  }

  async function generarCsrYKey() {
    if(!wizCuit || wizCuit.length!==11) { setGenError("Completá tu CUIT (11 dígitos) en el paso anterior"); return; }
    if(!wizRazonSocial.trim()) { setGenError("Completá tu razón social en el paso anterior"); return; }
    setGenLoading(true); setGenError(""); setCsrCopied(false);
    try {
      const forge = (await import("node-forge")).default;
      // Generación async para no bloquear el thread principal del browser
      const keypair = await new Promise((resolve, reject) => {
        forge.pki.rsa.generateKeyPair({ bits: 2048, workers: -1 }, (err, kp) => err ? reject(err) : resolve(kp));
      });
      const csr = forge.pki.createCertificationRequest();
      csr.publicKey = keypair.publicKey;
      // Subject DN para ARCA: serialNumber=CUIT XXX es obligatorio
      const cn = (wizNombreFantasia || wizRazonSocial).slice(0, 64);
      csr.setSubject([
        { name: "countryName", value: "AR" },
        { name: "organizationName", value: wizRazonSocial.slice(0, 64) },
        { name: "commonName", value: cn },
        { type: "2.5.4.5", value: "CUIT " + wizCuit }, // serialNumber attribute
      ]);
      csr.sign(keypair.privateKey, forge.md.sha256.create());
      const csrPemOut = forge.pki.certificationRequestToPem(csr);
      const keyPemOut = forge.pki.privateKeyToPem(keypair.privateKey);
      setCsrPem(csrPemOut);
      setKeyText(keyPemOut);
      setKeyFileName(`growith-${wizCuit}.key`);
      // Auto-descarga del .csr — es el archivo que el usuario tiene que subir a ARCA YA
      const blob = new Blob([csrPemOut], { type: "application/pkcs10" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `growith-${wizCuit}.csr`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) {
      setGenError("No se pudo generar el par: " + (e.message || String(e)));
    } finally {
      setGenLoading(false);
    }
  }

  function descargarCsr() {
    if(!csrPem) return;
    const blob = new Blob([csrPem], { type: "application/pkcs10" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `growith-${wizCuit}.csr`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function copiarCsr() {
    if(!csrPem) return;
    try { await navigator.clipboard.writeText(csrPem); setCsrCopied(true); setTimeout(()=>setCsrCopied(false), 2000); }
    catch { toast("No se pudo copiar al portapapeles","error"); }
  }

  function readPemFile(file, kind, setText, setName, setErr) {
    setErr("");
    // ARCA descarga el .crt sin extensión (formato "Alias_NroSerie"), así que solo validamos por contenido
    if(file.size > 100*1024) { setErr("Archivo demasiado grande (>100 KB)"); return; }
    const reader = new FileReader();
    reader.onload = ev => {
      const txt = String(ev.target.result||"").trim();
      const beginToken = kind==="cert" ? "-----BEGIN CERTIFICATE-----" : "-----BEGIN";
      if(!txt.includes(beginToken)) {
        setErr(kind==="cert"
          ? "El archivo no parece un certificado PEM válido (falta -----BEGIN CERTIFICATE-----)"
          : "El archivo no parece una clave privada PEM válida (falta -----BEGIN ... PRIVATE KEY-----)");
        return;
      }
      if(kind==="key" && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(txt)) {
        setErr("El archivo no parece una clave privada PEM válida");
        return;
      }
      setText(txt);
      setName(file.name);
    };
    reader.onerror = () => setErr("No se pudo leer el archivo");
    reader.readAsText(file);
  }

  async function handleSaveCuit() {
    if(!wizCuit.trim()||!wizRazonSocial.trim()) return toast("Completá CUIT y razón social","warning");
    setSavingCuit(true);
    const fd = new FormData();
    fd.append("cuit", wizCuit); fd.append("tipo_persona", wizTipoPersona);
    fd.append("razon_social", wizRazonSocial); fd.append("nombre_fantasia", wizNombreFantasia);
    fd.append("domicilio", wizDomicilio); fd.append("fecha_inicio", wizFechaInicio);
    fd.append("condicion_fiscal", wizCondicion); fd.append("punto_venta", wizPuntoVenta);
    fd.append("arca_prod", String(wizArcaProd)); fd.append("ingresos_brutos", wizIngresosBrutos);
    if(certText.trim()) fd.append("cert_pem", certText.trim());
    if(keyText.trim()) fd.append("key_pem", keyText.trim());
    const d = await fetch(`/api/arca?action=save_cuit&uid=${uid}`,{method:"POST",body:fd}).then(r=>r.json());
    if(d.error){toast(d.error,"error");setSavingCuit(false);return;}
    toast("CUIT guardado ✓","success");
    const updated = await api("list_cuits");
    if(updated.cuits){ setCuits(updated.cuits); setCuitSel(wizCuit); }
    resetWizard(); setSavingCuit(false);
  }

  async function handleTestCuitWiz() {
    setTestingCuit(wizCuit);
    const fd = new FormData();
    fd.append("cuit", wizCuit); fd.append("tipo_persona", wizTipoPersona);
    fd.append("razon_social", wizRazonSocial); fd.append("nombre_fantasia", wizNombreFantasia);
    fd.append("domicilio", wizDomicilio); fd.append("fecha_inicio", wizFechaInicio);
    fd.append("condicion_fiscal", wizCondicion); fd.append("punto_venta", wizPuntoVenta);
    fd.append("arca_prod", String(wizArcaProd));
    if(certText.trim()) fd.append("cert_pem", certText.trim());
    if(keyText.trim()) fd.append("key_pem", keyText.trim());
    await fetch(`/api/arca?action=save_cuit&uid=${uid}`,{method:"POST",body:fd}).then(r=>r.json());
    const d = await api("test_cuit","POST",null,{cuit:wizCuit});
    if(d.error){ toast("Error: "+d.error,"error"); setTestResult({ok:false,msg:d.error}); }
    else { toast("Conexión OK · Último F-B: "+d.ultimo_b,"success"); setTestResult({ok:true,msg:"Último comprobante: "+d.ultimo_b}); }
    setTestingCuit(null);
  }

  async function handleDeleteCuit(cuitNum) {
    if(!window.confirm("¿Eliminar CUIT "+cuitNum+"? Se borra de Growith pero el certificado en ARCA queda activo.")) return;
    await fetch(`/api/arca?action=delete_cuit&uid=${uid}&cuit=${cuitNum}`,{method:"DELETE"}).then(r=>r.json());
    setCuits(prev=>prev.filter(c=>c.cuit!==cuitNum));
    if(cuitSel===cuitNum) setCuitSel(cuits.find(c=>c.cuit!==cuitNum)?.cuit||null);
    toast("CUIT eliminado","success");
  }

  function openEditCuit(c) {
    setEditCuit({...c});
    setShowEditCuit(true);
    setShowCuitMenu(false);
  }

  async function handleSaveEditCuit() {
    if(!editCuit) return;
    setSavingEdit(true);
    const fd = new FormData();
    fd.append("cuit", editCuit.cuit);
    fd.append("razon_social", editCuit.razon_social||"");
    fd.append("nombre_fantasia", editCuit.nombre_fantasia||"");
    fd.append("domicilio", editCuit.domicilio||"");
    fd.append("fecha_inicio", editCuit.fecha_inicio||"");
    fd.append("condicion_fiscal", editCuit.condicion_fiscal||"RESPONSABLE_INSCRIPTO");
    fd.append("punto_venta", String(editCuit.punto_venta||1));
    fd.append("arca_prod", String(editCuit.arca_prod||false));
    fd.append("ingresos_brutos", editCuit.ingresos_brutos||"");
    const d = await fetch(`/api/arca?action=save_cuit&uid=${uid}`,{method:"POST",body:fd}).then(r=>r.json());
    if(d.error){toast(d.error,"error");setSavingEdit(false);return;}
    const updated = await api("list_cuits");
    if(updated.cuits) setCuits(updated.cuits);
    toast("CUIT actualizado ✓","success");
    setShowEditCuit(false); setEditCuit(null); setSavingEdit(false);
  }

  async function loadPendingOrders() {
    if(!cuitSel) return;
    const params = {cuit:cuitSel};
    if(periodoModo === "custom") {
      if(!fechaDesde) return;
      params.since = fechaDesde;
      params.until = fechaHasta || new Date().toISOString().slice(0,10);
    } else {
      params.days = parseInt(periodoModo);
    }
    setTnLoading(true);
    const d = await api("pending_orders","GET",null,params);
    setTnLoading(false);
    if(d.error) { toast("Error: "+d.error,"error"); return; }
    // Normalizar para mantener compat: connections es array, agregamos flag connected si hay al menos 1
    d.connected = (d.connections||[]).some(c => c.connected);
    setTnData(d);
    // Mantener selecciones previas si las órdenes siguen ahí; las nuevas quedan deseleccionadas por default
    const newSel = {};
    Object.keys(d.ordenes||{}).forEach(id => { newSel[id] = tnSelected[id] || false; });
    setTnSelected(newSel);
  }

  function facturarSeleccionadas() {
    if(!tnData?.ordenes) return;
    const filtered = {};
    Object.entries(tnData.ordenes).forEach(([id,o])=>{
      if(tnSelected[id]) filtered[id] = o;
    });
    if(Object.keys(filtered).length === 0) return toast("Tildá al menos una venta","warning");
    setOrdenes(filtered);
    const productos = [...new Set(Object.values(filtered).flatMap(o => o.items.map(i => i.nombre_original)))];
    setProductos(productos);
    setProductMap(Object.fromEntries(productos.map(p=>[p,""])));
    toast(`${Object.keys(filtered).length} ventas listas para emitir`,"success");
    // Scroll suave hacia el preview
    setTimeout(()=>{
      document.getElementById("arca-preview-ordenes")?.scrollIntoView({behavior:"smooth",block:"start"});
    }, 100);
  }

  async function refreshDashboard() {
    if(!cuitSel) return;
    const d = await api("dashboard_stats","GET",null,{cuit:cuitSel,month:dashMonth,year:dashYear});
    if(!d.error) setDashboardStats(d);
    const b = await api("list_batches","GET",null,{cuit:cuitSel,month:dashMonth,year:dashYear});
    if(!b.error) setBatches(b.batches||[]);
  }

  async function loadBatchPdfs(batch) {
    if(batchPdfs[batch.batch_id]) return batchPdfs[batch.batch_id];
    setLoadingBatchPdfs(batch.batch_id);
    const d = await api("get_batch_pdfs","POST",{cuit:cuitSel, comprobante_ids:batch.comprobante_ids||[]});
    setLoadingBatchPdfs(null);
    if(d.error) { toast("Error al cargar PDFs: "+d.error,"error"); return null; }
    setBatchPdfs(prev=>({...prev, [batch.batch_id]: d.pdfs||[]}));
    return d.pdfs;
  }

  async function downloadBatchZip(batch) {
    const pdfList = await loadBatchPdfs(batch);
    if(!pdfList) return;
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for(const p of pdfList) {
      zip.file(p.nombre, p.bytes, {base64: true});
    }
    const blob = await zip.generateAsync({type:"blob"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const fechaStr = batch.emitido_at?.slice(0,10) || "facturas";
    a.download = `growith-facturas-${fechaStr}-${batch.batch_id}.zip`;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
  }

  async function downloadCurrentBatchZip() {
    if(!pdfs.length) return;
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for(const p of pdfs) {
      zip.file(p.nombre, p.bytes, {base64: true});
    }
    const blob = await zip.generateAsync({type:"blob"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `growith-facturas-${new Date().toISOString().slice(0,10)}.zip`;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
  }

  async function handleTestConnection() {
    if(!cuitSel) return toast("Seleccioná un CUIT primero","warning");
    setTestingConn(true); setTestConnResult(null);
    const d = await api("test_cuit","POST",null,{cuit:cuitSel});
    if(d.error){
      setTestConnResult({ok:false, msg:d.error});
      toast("Error de conexión","error");
    } else {
      setTestConnResult({ok:true, msg:`Último comprobante B autorizado: ${d.ultimo_b}`});
      toast("Conexión con ARCA OK ✓","success");
    }
    setTestingConn(false);
    setTimeout(()=>setTestConnResult(null), 8000);
  }

  function resetManual() {
    setShowManual(false); setManualNombre(""); setManualDocTipo("CUIT");
    setManualDocNro(""); setManualItems([{nombre:"",cantidad:1,precio:0}]);
    setManualResult(null);
  }

  async function handleEmitManual() {
    if(!cuitSel) return toast("Seleccioná un CUIT emisor","warning");
    const itemsValid = manualItems.filter(it => it.nombre.trim() && it.cantidad > 0 && it.precio > 0);
    if(itemsValid.length === 0) return toast("Agregá al menos un ítem con nombre, cantidad y precio","warning");
    if(manualDocTipo !== "CF" && !manualDocNro.trim()) return toast("Completá el número de documento o elegí 'Consumidor Final'","warning");

    const total = itemsValid.reduce((s,it)=>s + it.cantidad*it.precio, 0);
    const docNro = manualDocTipo === "CF" ? "" : manualDocNro.replace(/\D/g,"");
    const orderId = "MANUAL-" + Date.now();
    const orden = {
      nombre: manualNombre.trim() || "Consumidor Final",
      doc_tipo: manualDocTipo,
      doc_nro: docNro,
      dni: docNro,
      total,
      subtotal: total,
      descuento: 0,
      envio: 0,
      estado_pago: "paid",
      fecha: new Date().toISOString().slice(0,10),
      ciudad: "", provincia: "",
      metodo_pago: "Manual",
      items: itemsValid.map(it => ({
        nombre: it.nombre.trim(), nombre_original: it.nombre.trim(),
        cantidad: parseInt(it.cantidad), precio: parseFloat(it.precio), descuento_item: 0,
      })),
    };

    setEmittingManual(true); setManualResult(null);
    const d = await api("emit","POST",{cuit:cuitSel, ordenes:{[orderId]:orden}, product_map:{}});
    if(d.error){toast(d.error,"error");setEmittingManual(false);return;}
    const r = (d.resultados||[])[0];
    const pdf = (d.pdfs||[])[0];
    setManualResult({r, pdf});
    if(r?.ok) { toast(`Factura ${r.letra} N° ${String(r.comprobante).padStart(8,"0")} emitida ✓`,"success"); refreshDashboard(); }
    else toast("Error: "+(r?.obs||"falló la emisión"),"error");
    setEmittingManual(false);
  }

  async function handleParseFile() {
    if(!archivo) return toast("Seleccioná un archivo","warning");
    if(!cuitSel) return toast("Seleccioná un CUIT emisor","warning");
    setParsing(true); setOrdenes(null); setResultados(null); setPdfs([]);
    const fd = new FormData(); fd.append("file", archivo);
    const d = await fetch(`/api/arca?action=parse&uid=${uid}`,{method:"POST",body:fd}).then(r=>r.json());
    if(d.error){toast(d.error,"error");setParsing(false);return;}
    setOrdenes(d.ordenes); setProductos(d.productos||[]);
    setProductMap(Object.fromEntries((d.productos||[]).map(p=>[p,""])));
    toast(d.total+" órdenes listas para facturar","success"); setParsing(false);
  }

  async function handleEmit() {
    if(!ordenes||!cuitSel) return;
    // Chequear duplicados del mes
    const orderIds = Object.keys(ordenes);
    const dupRes = await api("check_duplicates","POST",{cuit:cuitSel, order_ids:orderIds});
    const duplicates = dupRes?.duplicates || [];
    let msg = "¿Emitir "+orderIds.length+" facturas en ARCA?";
    if(duplicates.length > 0) {
      const ids = duplicates.slice(0, 5).map(d => `· ${d.orden_id} (F${d.letra} ${String(d.nro).padStart(8,"0")})`).join("\n");
      const masMsg = duplicates.length > 5 ? `\n…y ${duplicates.length - 5} más` : "";
      msg = `⚠ Hay ${duplicates.length} órden${duplicates.length>1?"es":""} ya facturada${duplicates.length>1?"s":""} este mes:\n${ids}${masMsg}\n\n¿Querés refacturarla${duplicates.length>1?"s":""} igual? Se van a emitir nuevos comprobantes (los anteriores no se anulan).`;
    }
    if(!window.confirm(msg)) return;
    setEmitting(true);
    const d = await api("emit","POST",{cuit:cuitSel,ordenes,product_map:productMap,mes_imputacion:mesImputacion});
    if(d.error){toast(d.error,"error");setEmitting(false);return;}
    setResultados(d.resultados||[]); setPdfs(d.pdfs||[]);
    const ok = (d.resultados||[]).filter(r=>r.ok).length;
    const err = (d.resultados||[]).filter(r=>!r.ok).length;
    toast(ok+" facturas emitidas"+(err>0?" · "+err+" con error":""),"success"); setEmitting(false);
    refreshDashboard();
  }

  function downloadPDF(pdf) { const a=document.createElement("a"); a.href="data:application/pdf;base64,"+pdf.bytes; a.download=pdf.nombre; a.click(); }
  function downloadAllPDFs() { pdfs.forEach((pdf,i)=>setTimeout(()=>downloadPDF(pdf),i*300)); }

  if(loading) return (
    <div style={{fontFamily:"'Inter',system-ui,sans-serif",background:T.bg,minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <Spinner size={28} color={T.accent}/>
    </div>
  );

  const CONDICIONES=[{id:"RESPONSABLE_INSCRIPTO",label:"Responsable Inscripto"},{id:"MONOTRIBUTO",label:"Monotributista"}];
  const TIPOS_PERSONA=[{id:"FISICA",label:"Persona física"},{id:"JURIDICA",label:"Persona jurídica"}];
  const esRI = cuitActivo?.condicion_fiscal === "RESPONSABLE_INSCRIPTO";
  const esMono = cuitActivo?.condicion_fiscal === "MONOTRIBUTO";

  return (
    <div style={{fontFamily:"'Inter',system-ui,sans-serif",background:T.bg,minHeight:"100vh",display:"flex",flexDirection:"column"}}>
      {/* ── TOPBAR ── */}
      <AppTopbar T={T} section="ARCA" onHome={onHome}>
        <div className="arca-cuit-menu" style={{position:"relative"}}>
          <button onClick={(e)=>{e.stopPropagation();setShowCuitMenu(s=>!s);}} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 12px",borderRadius:10,border:"1px solid "+T.border,background:T.card,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",minWidth:200}}>
            {cuitActivo ? (
              <>
                <div style={{width:8,height:8,borderRadius:"50%",background:T.green,flexShrink:0}}/>
                <div style={{flex:1,textAlign:"left"}}>
                  <div style={{fontSize:12,fontWeight:700,color:T.text,lineHeight:1.2}}>{cuitActivo.nombre_fantasia||cuitActivo.razon_social}</div>
                  <div style={{fontSize:10,color:T.textSm}}>CUIT {formatCuit(cuitActivo.cuit)} · PV {String(cuitActivo.punto_venta||1).padStart(5,"0")}</div>
                </div>
                <span style={{padding:"2px 7px",borderRadius:5,fontSize:10,fontWeight:700,border:"1px solid "+T.green+"44",color:T.green,background:T.greenBg}}>
                  {cuitActivo.condicion_fiscal==="MONOTRIBUTO"?"MT":"RI"}
                </span>
              </>
            ) : (
              <span style={{fontSize:12,color:T.textSm}}>Seleccionar CUIT</span>
            )}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={T.textMd} strokeWidth="2.5" strokeLinecap="round"><path d="M6 9l6 6 6-6"/></svg>
          </button>
          {showCuitMenu && (
            <div style={{position:"absolute",top:"calc(100% + 6px)",right:0,minWidth:280,background:T.card,border:"1px solid "+T.border,borderRadius:12,padding:6,zIndex:200,boxShadow:"0 8px 30px rgba(0,0,0,0.35)"}}>
              {cuits.map(c=>(
                <div key={c.cuit} style={{display:"flex",alignItems:"center",gap:4,padding:"4px",borderRadius:8,background:cuitSel===c.cuit?T.accentSolid+"18":"transparent"}}
                  onMouseEnter={e=>{if(cuitSel!==c.cuit)e.currentTarget.style.background=T.surface;}}
                  onMouseLeave={e=>{if(cuitSel!==c.cuit)e.currentTarget.style.background="transparent";}}>
                  <button onClick={()=>{setCuitSel(c.cuit);setShowCuitMenu(false);}} style={{display:"flex",alignItems:"center",gap:10,flex:1,padding:"7px 8px",borderRadius:6,border:"none",background:"transparent",cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:T.green,flexShrink:0}}/>
                    <div style={{flex:1,textAlign:"left"}}>
                      <div style={{fontSize:13,fontWeight:600,color:T.text}}>{c.nombre_fantasia||c.razon_social}</div>
                      <div style={{fontSize:11,color:T.textSm}}>{formatCuit(c.cuit)} · vinculado</div>
                    </div>
                    {cuitSel===c.cuit && <span style={{color:T.accent,fontSize:14}}>✓</span>}
                  </button>
                  <button onClick={(e)=>{e.stopPropagation();openEditCuit(c);}} title="Editar datos" style={{background:"transparent",border:"none",cursor:"pointer",padding:"6px",borderRadius:6,fontSize:13,color:T.textMd,display:"flex",alignItems:"center"}}
                    onMouseEnter={e=>e.currentTarget.style.background=T.bg}
                    onMouseLeave={e=>e.currentTarget.style.background="transparent"}>✏️</button>
                  <button onClick={(e)=>{e.stopPropagation();handleDeleteCuit(c.cuit);}} title="Eliminar CUIT" style={{background:"transparent",border:"none",cursor:"pointer",padding:"6px",borderRadius:6,fontSize:13,color:T.red,display:"flex",alignItems:"center"}}
                    onMouseEnter={e=>e.currentTarget.style.background=T.redBg}
                    onMouseLeave={e=>e.currentTarget.style.background="transparent"}>🗑</button>
                </div>
              ))}
              <div style={{borderTop:"1px solid "+T.border,marginTop:4,paddingTop:4}}>
                <button onClick={()=>{setShowCuitMenu(false);setShowWizard(true);}} style={{display:"flex",alignItems:"center",gap:8,width:"100%",padding:"10px 12px",borderRadius:8,border:"none",background:"transparent",cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",color:T.accent,fontSize:13,fontWeight:600}}
                  onMouseEnter={e=>e.currentTarget.style.background=T.surface}
                  onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  + Conectar nuevo CUIT
                </button>
              </div>
            </div>
          )}
        </div>
      </AppTopbar>

      <div style={{maxWidth:1100,margin:"0 auto",padding:"28px 24px",width:"100%"}}>

        {/* ══ SIN CUITs → ONBOARDING ══ */}
        {cuits.length===0 ? (
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"60px 24px",textAlign:"center"}}>
            <div style={{width:72,height:72,borderRadius:18,background:T.surface,border:"1px solid "+T.border,display:"flex",alignItems:"center",justifyContent:"center",fontSize:34,marginBottom:24}}>🧾</div>
            <div style={{fontSize:20,fontWeight:800,color:T.text,marginBottom:8}}>Facturación electrónica con ARCA</div>
            <div style={{fontSize:14,color:T.textMd,maxWidth:520,lineHeight:1.7,marginBottom:28}}>
              Conectá tu CUIT con tu certificado digital de ARCA y empezá a emitir facturas electrónicas directo desde tus ventas de Mercado Libre, Shopify y Tienda Nube. El sistema detecta automáticamente el tipo de comprobante según tu condición fiscal y los datos de cada cliente.
            </div>
            <button onClick={()=>setShowWizard(true)} style={{background:T.accentSolid,border:"none",color:"#fff",borderRadius:10,padding:"12px 28px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",display:"flex",alignItems:"center",gap:8}}>
              + Conectar mi primer CUIT
            </button>

            {/* Guía inline en onboarding */}
            <div style={{marginTop:48,width:"100%",maxWidth:750,textAlign:"left"}}>
              <div style={{fontSize:16,fontWeight:700,color:T.text,marginBottom:20,textAlign:"center"}}>📖 ¿Cómo funciona?</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
                {[
                  {step:"1",title:"Tocá 'Conectar CUIT' y completá tus datos",desc:"El wizard te pide CUIT, razón social, condición frente al IVA (Responsable Inscripto o Monotributista) y punto de venta. Necesitás clave fiscal nivel 3 en ARCA y estar inscripto como RI o Monotributo (no Consumidor Final).",color:T.accent},
                  {step:"2",title:"Generá tu certificado (modo automático)",desc:"Growith genera por vos un par RSA-2048 directamente en tu navegador — la clave privada nunca sale de tu computadora hasta que termines. Te da un CSR para copiar/pegar en ARCA (Administración de Certificados Digitales → Nuevo) y guardás el .key como backup. ARCA te devuelve un .crt que subís en el wizard, y listo. Si ya tenés tus archivos, hay modo manual para subir .crt y .key directo.",color:T.blue},
                  {step:"3",title:"Subí tus ventas para facturar",desc:"Descargá el reporte de ventas desde tu plataforma: en Mercado Libre es un archivo Excel (.xlsx) que bajás desde Ventas → Facturación, y en Shopify es un CSV que exportás desde Orders. Arrastrá ese archivo en la zona de carga y Growith lo procesa automáticamente: identifica cada cliente, el monto, y prepara las facturas.",color:T.yellow},
                  {step:"4",title:"Emití y descargá los PDFs",desc:"Revisá la previsualización de las facturas. Podés renombrar los productos si querés que aparezcan distinto en el comprobante. Tocá 'Emitir' y en segundos tenés todas las facturas con CAE válido emitidas en ARCA. Descargá los PDFs uno por uno o todos juntos en un click.",color:T.green},
                ].map(s=>(
                  <div key={s.step} style={{display:"flex",gap:12,padding:18,background:T.card,borderRadius:12,border:"1px solid "+T.border}}>
                    <div style={{width:34,height:34,borderRadius:9,background:s.color+"18",border:"1px solid "+s.color+"33",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,fontWeight:800,color:s.color,flexShrink:0}}>{s.step}</div>
                    <div>
                      <div style={{fontSize:13,fontWeight:700,color:T.text,marginBottom:6}}>{s.title}</div>
                      <div style={{fontSize:11,color:T.textMd,lineHeight:1.65}}>{s.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{marginTop:20,padding:16,background:T.purpleBg,border:"1px solid "+T.purple+"33",borderRadius:10}}>
                <div style={{fontSize:12,fontWeight:600,color:T.purple,marginBottom:6}}>💡 ¿Qué tipo de factura emite Growith?</div>
                <div style={{fontSize:12,color:T.textMd,lineHeight:1.7}}>
                  <strong style={{color:T.text}}>Si sos Responsable Inscripto:</strong> Growith emite Factura A cuando el cliente tiene CUIT y también es RI. Si ARCA rechaza la Factura A (porque ese CUIT no es RI), automáticamente reintenta como Factura B sin que hagas nada. Para clientes con DNI o sin datos fiscales, emite Factura B directamente.<br/><br/>
                  <strong style={{color:T.text}}>Si sos Monotributista:</strong> Siempre se emite Factura C, sin importar quién sea el cliente. Los monotributistas no discriminan IVA en sus comprobantes.
                </div>
              </div>
            </div>
          </div>

        ) : (
          <>
            {/* ══ CON CUITs → PANEL PRINCIPAL ══ */}

            {/* Guía colapsable */}
            <div style={{background:T.card,border:"1px solid "+T.border,borderRadius:14,overflow:"hidden",marginBottom:24}}>
              <button onClick={()=>setShowGuia(s=>!s)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",width:"100%",padding:"16px 20px",background:"transparent",border:"none",cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <span style={{fontSize:18}}>📖</span>
                  <div style={{textAlign:"left"}}>
                    <div style={{fontSize:14,fontWeight:700,color:T.text}}>¿Cómo funciona la facturación en ARCA?</div>
                    <div style={{fontSize:12,color:T.textSm,marginTop:2}}>Guía completa paso a paso — tocá para {showGuia?"cerrar":"abrir"}</div>
                  </div>
                </div>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={T.textMd} strokeWidth="2.5" strokeLinecap="round" style={{transform:showGuia?"rotate(180deg)":"none",transition:"transform 0.2s ease"}}><path d="M6 9l6 6 6-6"/></svg>
              </button>
              {showGuia&&(
                <div style={{padding:"0 20px 20px",borderTop:"1px solid "+T.border}}>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginTop:20}}>
                    {[
                      {step:"1",title:"Conectá tu CUIT",desc:"Tocá el selector de CUIT arriba a la derecha → '+ Conectar nuevo CUIT'. El wizard tiene 3 pasos: tus datos fiscales, generación del certificado (Growith genera el par RSA y te da el CSR para subir a ARCA → ARCA te devuelve un .crt que subís acá), y verificación. Si ya tenés un certificado de ARCA con su clave privada, hay un modo manual para subir ambos archivos directo.",color:T.accent},
                      {step:"2",title:"Subí tu archivo de ventas",desc:"Descargá el Excel de ventas de Mercado Libre (.xlsx) desde Ventas → Facturación, o el CSV de Shopify desde Orders → Export. Arrastrá el archivo en la zona de carga de abajo. Growith lee las órdenes automáticamente y prepara cada factura con los datos del comprador (nombre, CUIT/DNI, monto, productos).",color:T.blue},
                      {step:"3",title:"Revisá y ajustá",desc:"Antes de emitir podés revisar cada orden: el sistema muestra el tipo de comprobante que va a generar (Factura A, B o C según tu condición fiscal y los datos del cliente). También podés cambiar el nombre de los productos para que aparezcan distinto en el PDF final del comprobante.",color:T.yellow},
                      {step:"4",title:"Emití y descargá PDFs",desc:"Tocá 'Emitir facturas en ARCA' y el sistema se comunica directo con ARCA para generar cada comprobante con CAE válido. En segundos tenés los resultados: facturas exitosas con su número de comprobante y CAE. Descargá los PDFs uno por uno o todos juntos.",color:T.green},
                    ].map(s=>(
                      <div key={s.step} style={{display:"flex",gap:12,padding:16,background:T.bg,borderRadius:10,border:"1px solid "+T.border}}>
                        <div style={{width:32,height:32,borderRadius:8,background:s.color+"18",border:"1px solid "+s.color+"33",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:800,color:s.color,flexShrink:0}}>{s.step}</div>
                        <div>
                          <div style={{fontSize:13,fontWeight:700,color:T.text,marginBottom:5}}>{s.title}</div>
                          <div style={{fontSize:11,color:T.textMd,lineHeight:1.65}}>{s.desc}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{marginTop:16,padding:14,background:T.purpleBg,border:"1px solid "+T.purple+"33",borderRadius:10}}>
                    <div style={{fontSize:12,fontWeight:600,color:T.purple,marginBottom:6}}>💡 Tipos de factura según tu condición fiscal</div>
                    <div style={{fontSize:11,color:T.textMd,lineHeight:1.7}}>
                      <strong style={{color:T.text}}>Responsable Inscripto →</strong> Factura A (cliente RI con CUIT) o Factura B (consumidor final, cliente con DNI, o sin datos). Si ARCA rechaza una Factura A porque el CUIT del cliente no es RI, Growith reintenta como Factura B automáticamente.<br/>
                      <strong style={{color:T.text}}>Monotributista →</strong> Siempre Factura C, independientemente de quién sea el cliente. Los monotributistas no discriminan IVA.
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Navegador de meses del dashboard */}
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14,padding:"10px 14px",background:T.card,border:"1px solid "+T.border,borderRadius:12}}>
              <button onClick={()=>navMes(-1)} style={{background:"transparent",border:"1px solid "+T.border,color:T.text,borderRadius:8,padding:"6px 12px",fontSize:14,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>←</button>
              <div style={{flex:1,textAlign:"center"}}>
                <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5}}>Mes en vista</div>
                <div style={{fontSize:15,fontWeight:700,color:T.text,textTransform:"capitalize",marginTop:2}}>{mesActual}{esMesActualReal && <span style={{fontSize:10,color:T.green,marginLeft:6,fontWeight:500,textTransform:"none"}}>· actual</span>}</div>
              </div>
              <button onClick={()=>navMes(1)} disabled={esMesActualReal} style={{background:"transparent",border:"1px solid "+T.border,color:esMesActualReal?T.textSm:T.text,borderRadius:8,padding:"6px 12px",fontSize:14,cursor:esMesActualReal?"not-allowed":"pointer",fontFamily:"'Inter',system-ui,sans-serif",opacity:esMesActualReal?0.4:1}}>→</button>
            </div>

            {/* Dashboard del mes */}
            <div style={{display:"grid",gridTemplateColumns: esRI ? "1fr 1fr 1fr" : "1fr 1fr",gap:14,marginBottom:24}}>
              <div style={{background:T.card,border:"1px solid "+T.border,borderRadius:12,padding:"18px 20px"}}>
                <div style={{fontSize:10,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.6,marginBottom:8}}>Monto facturado · {mesActual}</div>
                <div style={{fontSize:26,fontWeight:800,color:T.text,letterSpacing:-1}}>
                  {dashboardStats ? "$ "+dashboardStats.total_facturado.toLocaleString("es-AR",{minimumFractionDigits:2}) : "$ 0,00"}
                </div>
                <div style={{fontSize:11,color:T.textSm,marginTop:6,lineHeight:1.5}}>Total facturado en el mes (IVA incluido).</div>
              </div>
              {esRI && (
                <div style={{background:T.card,border:"1px solid "+T.border,borderRadius:12,padding:"18px 20px"}}>
                  <div style={{fontSize:10,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.6,marginBottom:8}}>IVA Débito fiscal · {mesActual}</div>
                  <div style={{fontSize:26,fontWeight:800,color:T.text,letterSpacing:-1}}>
                    {dashboardStats ? "$ "+dashboardStats.iva_debito.toLocaleString("es-AR",{minimumFractionDigits:2}) : "$ 0,00"}
                  </div>
                  <div style={{fontSize:11,color:T.textSm,marginTop:6,lineHeight:1.5}}>IVA que cobraste a tus clientes en facturas A y B.</div>
                </div>
              )}
              <div style={{background:T.card,border:"1px solid "+T.border,borderRadius:12,padding:"18px 20px"}}>
                <div style={{fontSize:10,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.6,marginBottom:8}}>Facturas emitidas · {mesActual}</div>
                <div style={{fontSize:26,fontWeight:800,color:T.text,letterSpacing:-1}}>
                  {dashboardStats ? dashboardStats.facturas_emitidas : 0}
                </div>
                <div style={{fontSize:11,color:T.textSm,marginTop:6,lineHeight:1.5}}>
                  {dashboardStats && (dashboardStats.por_letra.A + dashboardStats.por_letra.B + dashboardStats.por_letra.C) > 0
                    ? `A: ${dashboardStats.por_letra.A} · B: ${dashboardStats.por_letra.B} · C: ${dashboardStats.por_letra.C}`
                    : "Historial de comprobantes emitidos desde Growith."}
                </div>
              </div>
            </div>

            {/* Zona de facturación */}
            <div style={{display:"grid",gridTemplateColumns:ordenes?"1fr 340px":"1fr",gap:20,alignItems:"start"}}>
              <div>
                {/* Upload */}
                {/* ══ VENTAS PENDIENTES (desde integraciones conectadas) ══ */}
                <div style={{background:T.card,border:"1px solid "+T.border,borderRadius:14,padding:"22px 24px",marginBottom:16}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,marginBottom:14,flexWrap:"wrap"}}>
                    <div>
                      <div style={{fontSize:14,fontWeight:700,color:T.text}}>Ventas pendientes de facturar</div>
                      <div style={{fontSize:11,color:T.textSm,marginTop:2}}>Importadas en vivo de tus integraciones · Tildá las que querés facturar en esta pasada</div>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                      <span style={{fontSize:11,color:T.textSm}}>Período</span>
                      <select value={periodoModo} onChange={e=>setPeriodoModo(e.target.value)} style={{...iS,width:"auto",padding:"6px 10px",fontSize:12}}>
                        <option value="1">Hoy</option>
                        <option value="7">Últimos 7 días</option>
                        <option value="15">Últimos 15 días</option>
                        <option value="30">Últimos 30 días</option>
                        <option value="60">Últimos 60 días</option>
                        <option value="90">Últimos 90 días</option>
                        <option value="custom">Personalizado</option>
                      </select>
                      {periodoModo === "custom" && (
                        <>
                          <input type="date" value={fechaDesde} max={fechaHasta} onChange={e=>setFechaDesde(e.target.value)} style={{...iS,width:"auto",padding:"6px 10px",fontSize:12,colorScheme:"dark"}}/>
                          <span style={{fontSize:11,color:T.textSm}}>a</span>
                          <input type="date" value={fechaHasta} min={fechaDesde} max={new Date().toISOString().slice(0,10)} onChange={e=>setFechaHasta(e.target.value)} style={{...iS,width:"auto",padding:"6px 10px",fontSize:12,colorScheme:"dark"}}/>
                        </>
                      )}
                      <span style={{fontSize:11,color:T.textSm,marginLeft:6}}>Canal</span>
                      <select value={canalSel} onChange={e=>setCanalSel(e.target.value)} style={{...iS,width:"auto",padding:"6px 10px",fontSize:12}}>
                        <option value="todos">Todos</option>
                        <option value="tiendanube">Tienda Nube</option>
                        <option value="shopify">Shopify</option>
                        <option value="mercadolibre">Mercado Libre</option>
                      </select>
                      <span style={{fontSize:11,color:T.textSm,marginLeft:6}}>Monto $</span>
                      <input type="number" placeholder="min" value={montoMin} onChange={e=>setMontoMin(e.target.value)} style={{...iS,width:78,padding:"6px 8px",fontSize:12}}/>
                      <span style={{fontSize:11,color:T.textSm}}>–</span>
                      <input type="number" placeholder="max" value={montoMax} onChange={e=>setMontoMax(e.target.value)} style={{...iS,width:78,padding:"6px 8px",fontSize:12}}/>
                      <button onClick={loadPendingOrders} disabled={tnLoading} title="Refrescar" style={{background:"transparent",border:"1px solid "+T.border,color:T.textMd,borderRadius:8,padding:"6px 10px",fontSize:13,cursor:tnLoading?"wait":"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>
                        {tnLoading ? <Spinner size={12} color={T.textMd}/> : "🔄"}
                      </button>
                    </div>
                  </div>

                  {/* Tags de conexiones */}
                  <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:14}}>
                    {(()=>{
                      const meta = {
                        tiendanube: { icon:"🔵", label:"Tienda Nube" },
                        shopify:    { icon:"🛍️", label:"Shopify" },
                        mercadolibre:{ icon:"🛒", label:"Mercado Libre" },
                      };
                      const conns = tnData?.connections || [
                        { platform:"tiendanube", connected:false },
                        { platform:"shopify", connected:false },
                        { platform:"mercadolibre", connected:false },
                      ];
                      return conns.map(c => {
                        const m = meta[c.platform] || { icon:"⚪", label:c.platform };
                        return (
                          <span key={c.platform} style={{fontSize:11,padding:"4px 10px",borderRadius:6,border:"1px solid "+(c.connected?T.green+"44":T.border),color:c.connected?T.green:T.textSm,background:c.connected?T.greenBg:T.bg,fontWeight:c.connected?600:500}}>
                            {m.icon} {m.label} · {c.connected ? "conectada" : "no conectada"}
                          </span>
                        );
                      });
                    })()}
                  </div>

                  {/* Tip Shopify: cómo capturar DNI/CUIT en el checkout — se oculta si ya hay
                      al menos 1 venta de Shopify con documento cargado (config OK) */}
                  {(() => {
                    const shConnected = tnData?.connections?.find(c => c.platform === "shopify" && c.connected);
                    if (!shConnected) return null;
                    const algunShopifyConDoc = Object.values(tnData?.ordenes || {}).some(o => o._platform === "shopify" && o.dni && String(o.dni).length > 0);
                    if (algunShopifyConDoc) return null; // ya está configurado, no molestamos
                    return (
                    <details style={{marginBottom:12}}>
                      <summary style={{cursor:"pointer",fontSize:12,fontWeight:600,color:T.text,padding:"10px 14px",background:T.yellowBg,border:"1px solid "+T.yellow+"44",borderRadius:8,listStyle:"none"}}>
                        ⚠ ¿Las ventas de Shopify no traen DNI/CUIT? — Click para ver cómo configurar tu checkout
                      </summary>
                      <div style={{padding:"14px 16px",background:T.bg,border:"1px solid "+T.borderL,borderTop:"none",borderRadius:"0 0 8px 8px",fontSize:12,color:T.textMd,lineHeight:1.7}}>
                        <div style={{marginBottom:10}}>
                          Shopify no tiene un campo nativo de "DNI/CUIT" — pero sí tiene el campo <strong style={{color:T.text}}>"Empresa"</strong> (<em>Company name</em>) que vamos a reutilizar para que tus clientes carguen su documento. Hay que hacer 2 cosas en tu admin de Shopify:
                        </div>

                        <div style={{marginTop:14,marginBottom:6,fontSize:11,textTransform:"uppercase",color:T.accent,fontWeight:700,letterSpacing:0.5}}>Paso 1 — Activar el campo "Empresa" como requerido</div>
                        <ol style={{margin:0,paddingLeft:20}}>
                          <li>Admin de Shopify → <strong style={{color:T.text}}>Configuración</strong> (abajo a la izquierda del sidebar)</li>
                          <li>Click en <strong style={{color:T.text}}>Pagar</strong> / <strong style={{color:T.text}}>Checkout</strong></li>
                          <li>Scroll hasta la sección <strong style={{color:T.text}}>"Opciones del formulario"</strong> / <strong style={{color:T.text}}>"Form options"</strong></li>
                          <li>En <strong style={{color:T.text}}>"Nombre de la empresa"</strong> / <strong style={{color:T.text}}>"Company name"</strong> cambiá la opción de <em>"Oculto"</em> a <strong style={{color:T.text}}>"Obligatorio"</strong> / <strong style={{color:T.text}}>"Required"</strong></li>
                          <li>Click en <strong style={{color:T.text}}>"Guardar"</strong> arriba a la derecha</li>
                        </ol>

                        <div style={{marginTop:14,marginBottom:6,fontSize:11,textTransform:"uppercase",color:T.accent,fontWeight:700,letterSpacing:0.5}}>Paso 2 — Renombrar el label "Empresa" → "DNI o CUIT"</div>
                        <ol style={{margin:0,paddingLeft:20}}>
                          <li>Admin de Shopify → <strong style={{color:T.text}}>Tienda online</strong> (en el sidebar izquierdo, debajo de "Canales de ventas")</li>
                          <li>En el <strong style={{color:T.text}}>tema actual</strong> (el que dice "Tema actual" / "Current theme") tocá el botón <strong style={{color:T.text}}>⋮</strong> (tres puntos, al lado de "Editar tema")</li>
                          <li>En el menú que se abre, click en <strong style={{color:T.text}}>"Editar contenido predeterminado del tema"</strong> / <strong style={{color:T.text}}>"Edit default theme content"</strong></li>
                          <li>Te abre una pantalla con categorías y un buscador. En la barra de búsqueda escribí: <code style={{background:T.surface,padding:"1px 6px",borderRadius:3,fontSize:11,color:T.accent}}>company</code></li>
                          <li>Buscá la(s) entrada(s) del <strong style={{color:T.text}}>checkout</strong> / <strong style={{color:T.text}}>pago</strong> que digan "Empresa" o "Company" (suele haber varias — modificá <strong style={{color:T.text}}>todas</strong> las que estén dentro de "checkout" o "contact")</li>
                          <li>Cambiá el texto a: <code style={{background:T.surface,padding:"2px 8px",borderRadius:3,fontSize:11,color:T.green,fontWeight:700}}>DNI o CUIT (sin puntos ni guiones)</code></li>
                          <li>Click en <strong style={{color:T.text}}>"Guardar"</strong></li>
                        </ol>

                        <div style={{marginTop:12,padding:"10px 14px",background:T.greenBg,border:"1px solid "+T.green+"44",borderRadius:8,fontSize:11,color:T.textMd,lineHeight:1.6}}>
                          ✅ <strong style={{color:T.green}}>Resultado:</strong> tus clientes verán un campo obligatorio "DNI o CUIT" en el checkout. Si ponen <strong style={{color:T.text}}>CUIT válido</strong> → Growith emite <strong style={{color:T.text}}>Factura A</strong>. Si ponen <strong style={{color:T.text}}>DNI</strong> → Growith emite <strong style={{color:T.text}}>Factura B</strong>. Si lo dejan vacío (no debería pasar si lo marcaste "Obligatorio") → Factura B a Consumidor Final.
                        </div>
                        <div style={{marginTop:8,fontSize:10,color:T.textSm,fontStyle:"italic"}}>
                          Nota: las ventas anteriores a este cambio no van a tener el documento. Solo las nuevas. Para esas viejas, usá el botón "Factura manual" o cargá el doc de cada una.
                        </div>
                        <div style={{marginTop:8,fontSize:10,color:T.green,fontStyle:"italic"}}>
                          🔄 Este aviso desaparece automáticamente en cuanto Growith detecte la primera venta de Shopify con DNI o CUIT cargado.
                        </div>
                      </div>
                    </details>
                  );})()}

                  {tnLoading && !tnData ? (
                    <div style={{padding:"40px 20px",textAlign:"center"}}>
                      <Spinner size={18} color={T.accent}/>
                      <div style={{fontSize:12,color:T.textSm,marginTop:12}}>Trayendo tus ventas...</div>
                    </div>
                  ) : !tnData?.connected ? (
                    <div style={{padding:"20px 16px",background:T.yellowBg,border:"1px solid "+T.yellow+"33",borderRadius:10,fontSize:12,color:T.textMd,lineHeight:1.6,marginBottom:8}}>
                      ⚠ No tenés ninguna integración conectada todavía. Andá a la configuración de la app para conectar Tienda Nube, Shopify o Mercado Libre (o usá subir archivo manual abajo).
                    </div>
                  ) : Object.keys(tnData.ordenes||{}).length === 0 ? (
                    <div style={{padding:"30px 16px",textAlign:"center",background:T.bg,borderRadius:10}}>
                      <div style={{fontSize:28,marginBottom:8}}>✨</div>
                      <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:4}}>No hay ventas pendientes</div>
                      <div style={{fontSize:11,color:T.textSm}}>No encontramos ventas pagas sin facturar en el período seleccionado.</div>
                    </div>
                  ) : (() => {
                    // El backend ya manda ordenado por fecha desc. Filtros locales: canal y rango de monto.
                    const all = Object.entries(tnData.ordenes);
                    const minN = montoMin === "" ? null : parseFloat(montoMin);
                    const maxN = montoMax === "" ? null : parseFloat(montoMax);
                    const items = all.filter(([, o]) => {
                      if (canalSel !== "todos" && o._platform !== canalSel) return false;
                      if (minN !== null && !isNaN(minN) && (o.total||0) < minN) return false;
                      if (maxN !== null && !isNaN(maxN) && (o.total||0) > maxN) return false;
                      return true;
                    });
                    if (items.length === 0) {
                      return (
                        <div style={{padding:"30px 16px",textAlign:"center",background:T.bg,borderRadius:10}}>
                          <div style={{fontSize:22,marginBottom:6}}>🔍</div>
                          <div style={{fontSize:12,color:T.textSm}}>No hay ventas que coincidan con los filtros aplicados.</div>
                        </div>
                      );
                    }
                    // Solo se pueden seleccionar/contar las NO facturadas
                    const itemsSelectables = items.filter(([, o]) => !o._billed);
                    const allSel = itemsSelectables.length > 0 && itemsSelectables.every(([id])=>tnSelected[id]);
                    const someSel = itemsSelectables.some(([id])=>tnSelected[id]);
                    const selectedCount = itemsSelectables.filter(([id])=>tnSelected[id]).length;
                    const selectedTotal = itemsSelectables.filter(([id])=>tnSelected[id]).reduce((s,[,o])=>s+(o.total||0),0);
                    const badgeColor = (plat) => plat === "shopify" ? "#96BF48" : plat === "mercadolibre" ? "#FFE600" : T.blue;
                    const badgeTextColor = (plat) => plat === "mercadolibre" ? "#333" : "#fff";
                    const fmtFechaHora = (iso) => {
                      if (!iso) return "—";
                      const d = new Date(iso);
                      if (isNaN(d)) return "—";
                      const dia = String(d.getDate()).padStart(2,"0");
                      const mes = String(d.getMonth()+1).padStart(2,"0");
                      const hh = String(d.getHours()).padStart(2,"0");
                      const mm = String(d.getMinutes()).padStart(2,"0");
                      return `${dia}/${mes} ${hh}:${mm}`;
                    };
                    const seleccionarPorcentaje = (pct) => {
                      const shuffled = [...itemsSelectables].sort(() => Math.random() - 0.5);
                      const n = Math.round(itemsSelectables.length * pct / 100);
                      const selIds = new Set(shuffled.slice(0, n).map(([id]) => id));
                      const ns = {...tnSelected};
                      itemsSelectables.forEach(([id]) => ns[id] = selIds.has(id));
                      setTnSelected(ns);
                    };
                    return (
                      <>
                        <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",background:T.bg,borderRadius:8,marginBottom:6,flexWrap:"wrap"}}>
                          <div onClick={()=>{
                            const ns = {...tnSelected}; itemsSelectables.forEach(([id])=>ns[id]=!allSel); setTnSelected(ns);
                          }} style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer"}}>
                            <input type="checkbox" checked={allSel} ref={el=>{ if(el) el.indeterminate = someSel && !allSel; }} readOnly style={{cursor:"pointer"}}/>
                            <span style={{fontSize:12,fontWeight:600,color:T.text}}>{allSel?"Deseleccionar":"Seleccionar"} todas ({itemsSelectables.length})</span>
                          </div>
                          <select onChange={e=>{const v=parseInt(e.target.value); if(v) seleccionarPorcentaje(v); e.target.value="";}} value="" style={{background:T.input,border:`1px solid ${T.inputBorder}`,borderRadius:6,padding:"5px 8px",fontSize:11,color:T.text,fontFamily:"'Inter',system-ui,sans-serif",cursor:"pointer"}}>
                            <option value="">Selección parcial…</option>
                            <option value="10">10% (aleatorio)</option>
                            <option value="20">20% (aleatorio)</option>
                            <option value="30">30% (aleatorio)</option>
                            <option value="40">40% (aleatorio)</option>
                            <option value="50">50% (aleatorio)</option>
                            <option value="60">60% (aleatorio)</option>
                            <option value="70">70% (aleatorio)</option>
                            <option value="80">80% (aleatorio)</option>
                            <option value="90">90% (aleatorio)</option>
                          </select>
                          <span style={{fontSize:11,color:T.textSm,marginLeft:"auto"}}>Total disponible: $ {itemsSelectables.reduce((s,[,o])=>s+(o.total||0),0).toLocaleString("es-AR",{minimumFractionDigits:2})}</span>
                        </div>
                        <div style={{maxHeight:420,overflowY:"auto"}}>
                          {items.map(([id,o])=>{
                            const billed = !!o._billed;
                            const sel = !billed && !!tnSelected[id];
                            const fechaHora = fmtFechaHora(o.fecha);
                            const tipoFact = esMono ? "C" : (o.doc_tipo === "CUIT" ? "A" : "B");
                            const plat = o._platform;
                            const label = o._platform_label || (plat==="tiendanube"?"TN":plat==="shopify"?"SH":plat==="mercadolibre"?"ML":"—");
                            const bg = billed ? T.green+"18" : sel ? T.accentSolid+"10" : "transparent";
                            const bord = billed ? "1px solid "+T.green+"33" : "1px solid "+T.borderL;
                            return (
                              <div key={id} onClick={()=>{ if(!billed) setTnSelected(prev=>({...prev,[id]:!prev[id]})); }} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderRadius:8,cursor:billed?"default":"pointer",background:bg,borderBottom:bord,opacity:billed?0.85:1}}>
                                <input type="checkbox" checked={billed?true:sel} disabled={billed} readOnly style={{cursor:billed?"not-allowed":"pointer",accentColor:billed?T.green:undefined}}/>
                                <span style={{fontSize:10,color:T.textSm,minWidth:74}}>{fechaHora}</span>
                                <span style={{fontSize:9,padding:"2px 6px",borderRadius:4,background:badgeColor(plat),color:badgeTextColor(plat),fontWeight:700,minWidth:24,textAlign:"center"}}>{label}</span>
                                <div style={{flex:1,minWidth:0,overflow:"hidden"}}>
                                  <div style={{fontSize:12,fontWeight:600,color:billed?T.green:T.text,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>#{id} · {o.nombre||"sin nombre"}</div>
                                  <div style={{fontSize:10,color:billed?T.green:T.textSm}}>
                                    {billed
                                      ? `✓ Ya facturada · F${o._billed_info?.letra||""} N° ${String(o._billed_info?.nro||"").padStart(8,"0")}`
                                      : `F${tipoFact} · ${o.doc_tipo==="CUIT"?`CUIT ${o.doc_nro}`:o.doc_tipo==="DNI"?`DNI ${o.doc_nro}`:"Consumidor Final"}`}
                                  </div>
                                </div>
                                <div style={{fontSize:13,fontWeight:700,color:billed?T.green:T.text,flexShrink:0}}>$ {(o.total||0).toLocaleString("es-AR",{minimumFractionDigits:2})}</div>
                              </div>
                            );
                          })}
                        </div>
                        <div style={{display:"flex",alignItems:"center",gap:10,marginTop:14,paddingTop:14,borderTop:"1px solid "+T.borderL}}>
                          <div style={{flex:1,fontSize:12,color:T.textSm}}>
                            {selectedCount} seleccionada{selectedCount===1?"":"s"} · <strong style={{color:T.text}}>$ {selectedTotal.toLocaleString("es-AR",{minimumFractionDigits:2})}</strong>
                          </div>
                          <button onClick={facturarSeleccionadas} disabled={selectedCount===0} style={{background:T.accentSolid,border:"none",color:"#fff",borderRadius:10,padding:"11px 22px",fontSize:13,fontWeight:700,cursor:selectedCount===0?"not-allowed":"pointer",fontFamily:"'Inter',system-ui,sans-serif",opacity:selectedCount===0?0.5:1,display:"flex",alignItems:"center",gap:6}}>
                            Facturar {selectedCount} →
                          </button>
                        </div>
                      </>
                    );
                  })()}

                </div>

                {/* Preview órdenes */}
                {ordenes&&(() => {
                  const totalGeneral = Object.values(ordenes).reduce((s,o)=>s+(o.total||0), 0);
                  const netoTotal = esMono ? totalGeneral : Math.round((totalGeneral / 1.21) * 100) / 100;
                  const ivaTotal = esMono ? 0 : Math.round((totalGeneral - netoTotal) * 100) / 100;
                  return (
                  <div id="arca-preview-ordenes" style={{background:T.card,border:"1px solid "+T.border,borderRadius:14,padding:"18px 22px",marginBottom:16}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
                      <span style={{width:28,height:28,borderRadius:8,background:T.green+"18",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:800,color:T.green}}>2</span>
                      <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.6}}>
                        {Object.keys(ordenes).length} órdenes a facturar
                      </div>
                    </div>

                    {/* Resumen totales */}
                    <div style={{display:"grid",gridTemplateColumns: esRI ? "1fr 1fr 1fr" : "1fr",gap:10,marginBottom:14,padding:"12px 14px",background:T.bg,border:"1px solid "+T.borderL,borderRadius:10}}>
                      {esRI ? (
                        <>
                          <div>
                            <div style={{fontSize:10,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:3}}>Subtotal neto</div>
                            <div style={{fontSize:15,fontWeight:700,color:T.text}}>$ {netoTotal.toLocaleString("es-AR",{minimumFractionDigits:2})}</div>
                          </div>
                          <div style={{borderLeft:"1px solid "+T.borderL,paddingLeft:14}}>
                            <div style={{fontSize:10,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:3}}>IVA 21%</div>
                            <div style={{fontSize:15,fontWeight:700,color:T.text}}>$ {ivaTotal.toLocaleString("es-AR",{minimumFractionDigits:2})}</div>
                          </div>
                          <div style={{borderLeft:"1px solid "+T.borderL,paddingLeft:14}}>
                            <div style={{fontSize:10,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:3}}>Total a facturar</div>
                            <div style={{fontSize:16,fontWeight:800,color:T.accent,letterSpacing:-0.3}}>$ {totalGeneral.toLocaleString("es-AR",{minimumFractionDigits:2})}</div>
                          </div>
                        </>
                      ) : (
                        <div>
                          <div style={{fontSize:10,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:3}}>Total a facturar (Factura C)</div>
                          <div style={{fontSize:18,fontWeight:800,color:T.accent,letterSpacing:-0.3}}>$ {totalGeneral.toLocaleString("es-AR",{minimumFractionDigits:2})}</div>
                        </div>
                      )}
                    </div>

                    {/* Selector mes de imputación */}
                    {(() => {
                      const nowArg = new Date(new Date().toLocaleString("en-US",{timeZone:"America/Argentina/Buenos_Aires"}));
                      const diaHoy = nowArg.getDate();
                      const puedeMesAnterior = diaHoy <= 12; // margen amplio; el backend valida el rango de 10 días corridos
                      const meses = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
                      const mesActualLabel = meses[nowArg.getMonth()];
                      const mesAnteriorLabel = meses[(nowArg.getMonth()+11)%12];
                      const yearAnterior = nowArg.getMonth() === 0 ? nowArg.getFullYear()-1 : nowArg.getFullYear();
                      return (
                        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14,padding:"10px 14px",background:T.bg,border:"1px solid "+T.borderL,borderRadius:10,flexWrap:"wrap"}}>
                          <span style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5}}>Imputar al mes</span>
                          <label style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer",fontSize:12,color:T.text}}>
                            <input type="radio" name="mes-imp" checked={mesImputacion==="actual"} onChange={()=>setMesImputacion("actual")}/>
                            <span style={{fontWeight:600,textTransform:"capitalize"}}>{mesActualLabel} {nowArg.getFullYear()}</span>
                          </label>
                          <label style={{display:"flex",alignItems:"center",gap:6,cursor:puedeMesAnterior?"pointer":"not-allowed",fontSize:12,color:puedeMesAnterior?T.text:T.textSm,opacity:puedeMesAnterior?1:0.5}}>
                            <input type="radio" name="mes-imp" checked={mesImputacion==="anterior"} disabled={!puedeMesAnterior} onChange={()=>setMesImputacion("anterior")}/>
                            <span style={{fontWeight:600,textTransform:"capitalize"}}>{mesAnteriorLabel} {yearAnterior}</span>
                            {!puedeMesAnterior && <span style={{fontSize:10,color:T.textSm}}>(solo en los primeros días del mes)</span>}
                          </label>
                          {mesImputacion==="anterior" && (
                            <div style={{flexBasis:"100%",fontSize:10,color:T.textSm,marginTop:2,lineHeight:1.4}}>
                              ⓘ ARCA va a registrar las facturas con fecha del último día hábil de {mesAnteriorLabel}, así caen contablemente ese mes.
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    <div style={{maxHeight:350,overflowY:"auto",borderRadius:8}}>
                      {Object.entries(ordenes).map(([id,o])=>(
                        <div key={id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",borderBottom:"1px solid "+T.borderL}}>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontSize:12,fontWeight:600,color:T.text}}>{o.nombre||"Consumidor Final"}</div>
                            <div style={{fontSize:11,color:T.textSm}}>{id} · {esMono?"Factura C":(o.doc_tipo==="CUIT"?"Factura A":"Factura B")}{o.doc_nro?" · "+o.doc_tipo+" "+o.doc_nro:""}</div>
                          </div>
                          <div style={{fontSize:13,fontWeight:700,color:T.text,flexShrink:0}}>${o.total.toLocaleString("es-AR",{minimumFractionDigits:2})}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                  );
                })()}

                {/* Resultados */}
                {resultados&&(
                  <div style={{background:T.card,border:"1px solid "+T.border,borderRadius:14,padding:"18px 22px"}}>
                    <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.6,marginBottom:14}}>Resultado de emisión</div>
                    {resultados.map((r,i)=>(
                      <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",borderBottom:"1px solid "+T.borderL}}>
                        <span style={{fontSize:16,flexShrink:0}}>{r.ok?"✅":"🔴"}</span>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:12,fontWeight:600,color:T.text}}>{r.orden_id}</div>
                          {r.ok
                            ? <div style={{fontSize:11,color:T.textSm}}>F-{r.letra} Nro {String(r.comprobante).padStart(8,"0")} · CAE {r.cae} · Vto {r.cae_vto}</div>
                            : <div style={{fontSize:11,color:T.red}}>{r.obs}</div>}
                        </div>
                        <div style={{fontSize:12,fontWeight:600,color:T.text,flexShrink:0}}>${r.total?.toLocaleString("es-AR",{minimumFractionDigits:2})}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Sidebar */}
              {ordenes && (
                <div style={{display:"flex",flexDirection:"column",gap:16,position:"sticky",top:80}}>
                  {productos.length>0&&(
                    <div style={{background:T.card,border:"1px solid "+T.border,borderRadius:12,padding:"16px 18px"}}>
                      <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.6,marginBottom:4}}>Nombre en factura</div>
                      <div style={{fontSize:11,color:T.textSm,marginBottom:12,lineHeight:1.4}}>Podés cambiar cómo aparece cada producto en el PDF del comprobante. Dejalo vacío para usar el nombre original.</div>
                      {productos.map(p=>(
                        <div key={p} style={{marginBottom:10}}>
                          <div style={{fontSize:11,color:T.textSm,marginBottom:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p}</div>
                          <input value={productMap[p]||""} onChange={e=>setProductMap(prev=>({...prev,[p]:e.target.value}))} placeholder={p.slice(0,35)+"..."} style={{...iS,fontSize:12}}/>
                        </div>
                      ))}
                    </div>
                  )}
                  {!resultados&&(
                    <button onClick={handleEmit} disabled={emitting||!cuitSel} style={{background:"#16a34a",border:"none",color:"#fff",borderRadius:10,padding:"13px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
                      {emitting?<><Spinner size={14} color="#fff"/> Emitiendo en ARCA...</>:"🧾 Emitir facturas en ARCA"}
                    </button>
                  )}
                  {pdfs.length>0&&(
                    <div style={{background:T.card,border:"1px solid "+T.border,borderRadius:12,padding:"16px 18px"}}>
                      <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.6,marginBottom:12}}>{pdfs.length} PDFs generados</div>
                      <button onClick={downloadCurrentBatchZip} style={{background:T.accentSolid,border:"none",color:"#fff",borderRadius:8,padding:"9px 16px",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:6,marginBottom:10}}>⬇ Descargar todos (.zip)</button>
                      <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:200,overflowY:"auto"}}>
                        {pdfs.map((pdf,i)=>(
                          <button key={i} onClick={()=>downloadPDF(pdf)} style={{background:"transparent",border:"1px solid "+T.border,color:T.textMd,borderRadius:8,padding:"6px 10px",fontSize:11,fontWeight:500,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",textAlign:"left",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                            📄 {pdf.nombre}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {(ordenes||resultados)&&(
                    <button onClick={()=>{setOrdenes(null);setResultados(null);setPdfs([]);setArchivo(null);}} style={{background:"transparent",border:"1px solid "+T.border,color:T.textMd,borderRadius:8,padding:"9px 16px",fontSize:12,fontWeight:500,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
                      Nueva facturación
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* ══ EMISIÓN DE FACTURAS · Info y acciones ══ */}
            <div style={{marginTop:32,paddingTop:24,borderTop:"1px solid "+T.border}}>
              <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:16,marginBottom:8}}>
                <div>
                  <div style={{fontSize:22,fontWeight:800,color:T.text}}>
                    Emisión de facturas <span style={{color:T.accent}}>en ARCA</span>
                  </div>
                  <div style={{fontSize:13,color:T.textMd,marginTop:6,lineHeight:1.6,maxWidth:650}}>
                    {esRI && "El bot decide solo el tipo de factura (A o B) según los datos del cliente."}
                    {esMono && "Se emiten Facturas C automáticamente para todas las ventas."}
                  </div>
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:8,alignItems:"flex-end",flexShrink:0}}>
                  <button onClick={()=>setShowManual(true)} disabled={!cuitSel} style={{background:T.accentSolid,border:"none",color:"#fff",borderRadius:10,padding:"10px 16px",fontSize:13,fontWeight:600,cursor:cuitSel?"pointer":"not-allowed",fontFamily:"'Inter',system-ui,sans-serif",display:"flex",alignItems:"center",gap:6,whiteSpace:"nowrap",opacity:cuitSel?1:0.5}}>
                    + Factura manual
                  </button>
                  <button onClick={handleTestConnection} disabled={!cuitSel||testingConn} style={{background:"transparent",border:"1px solid "+T.border,color:T.textMd,borderRadius:10,padding:"8px 14px",fontSize:12,fontWeight:500,cursor:(!cuitSel||testingConn)?"not-allowed":"pointer",fontFamily:"'Inter',system-ui,sans-serif",display:"flex",alignItems:"center",gap:6,whiteSpace:"nowrap",opacity:(!cuitSel||testingConn)?0.5:1}}>
                    {testingConn ? <><Spinner size={11} color={T.textMd}/> Probando...</> : "🔌 Probar conexión"}
                  </button>
                </div>
              </div>
              <div style={{fontSize:12,color:T.textSm,marginTop:-4,marginBottom:12}}>
                ¿Vendiste por afuera de las integraciones? Usá <strong style={{color:T.text}}>Factura manual</strong> para emitir una factura puntual (mayoristas, ventas directas, etc.)
              </div>
              {testConnResult && (
                <div style={{padding:"10px 14px",borderRadius:10,marginBottom:12,fontSize:12,fontWeight:500,lineHeight:1.5,background:testConnResult.ok?T.greenBg:T.redBg,border:"1px solid "+(testConnResult.ok?T.green:T.red)+"33",color:testConnResult.ok?T.green:T.red}}>
                  {testConnResult.ok ? "✅ Conexión exitosa con ARCA" : "❌ Error conectando con ARCA"} — {testConnResult.msg}
                </div>
              )}

              {/* Info condición fiscal */}
              {cuitActivo && (
                <div style={{background:T.card,border:"1px solid "+T.border,borderRadius:14,padding:"18px 22px",marginTop:14}}>
                  <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
                    <span style={{padding:"4px 10px",borderRadius:6,fontSize:11,fontWeight:700,border:"1px solid "+T.green+"44",color:T.green,background:T.greenBg,textTransform:"uppercase",letterSpacing:0.4}}>
                      {esMono?"Monotributista":"Responsable Inscripto"}
                    </span>
                    <span style={{fontSize:12,color:T.textMd}}>
                      {esMono?"Siempre se emite Factura C.":"El tipo de factura se elige automáticamente según el cliente."}
                    </span>
                  </div>
                  <div style={{display:"flex",flexDirection:"column",gap:8}}>
                    {esRI ? [
                      {icon:"🟢",title:"Cliente con CUIT y es Responsable Inscripto",desc:"Se emite Factura A. Incluye IVA discriminado (21%). Si ARCA rechaza porque ese CUIT no es RI, automáticamente reintenta como Factura B sin que tengas que hacer nada."},
                      {icon:"🔵",title:"Cliente con DNI (consumidor final)",desc:"Se emite Factura B a nombre del cliente. El IVA va incluido en el precio final, no se discrimina en el comprobante."},
                      {icon:"⚪",title:"Sin datos del cliente",desc:"Si la plataforma no trae DNI ni CUIT del comprador (porque no completó el campo 'empresa' o 'documento'), se emite Factura B a Consumidor Final con CUIT genérico."},
                    ].map((r,i)=>(
                      <div key={i} style={{display:"flex",gap:10,padding:"12px 14px",background:T.bg,borderRadius:10,border:"1px solid "+T.borderL}}>
                        <span style={{fontSize:14,flexShrink:0,marginTop:1}}>{r.icon}</span>
                        <div>
                          <div style={{fontSize:12,fontWeight:700,color:T.text}}>{r.title}</div>
                          <div style={{fontSize:11,color:T.textSm,lineHeight:1.6,marginTop:3}}>{r.desc}</div>
                        </div>
                      </div>
                    )) : [
                      {icon:"🟣",title:"Todos los clientes → Factura C",desc:"Como monotributista, todos tus comprobantes son Factura C independientemente de si el cliente tiene CUIT, DNI o ningún dato. La Factura C no discrimina IVA — el monto total es lo que figura en el comprobante."},
                    ].map((r,i)=>(
                      <div key={i} style={{display:"flex",gap:10,padding:"12px 14px",background:T.bg,borderRadius:10,border:"1px solid "+T.borderL}}>
                        <span style={{fontSize:14,flexShrink:0,marginTop:1}}>{r.icon}</span>
                        <div>
                          <div style={{fontSize:12,fontWeight:700,color:T.text}}>{r.title}</div>
                          <div style={{fontSize:11,color:T.textSm,lineHeight:1.6,marginTop:3}}>{r.desc}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* ══ HISTORIAL DE BATCHES ══ */}
            {batches.length > 0 && (
              <div style={{background:T.card,border:"1px solid "+T.border,borderRadius:14,padding:"20px 22px",marginTop:24}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
                  <div>
                    <div style={{fontSize:14,fontWeight:700,color:T.text}}>Facturaciones recientes</div>
                    <div style={{fontSize:12,color:T.textSm,marginTop:2}}>Cada lote queda registrado. Tocá uno para ver el detalle o descargar de nuevo los PDFs.</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:10,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.4}}>Total facturado · histórico</div>
                    <div style={{fontSize:16,fontWeight:800,color:T.text}}>$ {batches.reduce((s,b)=>s+(b.total||0),0).toLocaleString("es-AR",{minimumFractionDigits:2})}</div>
                  </div>
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:8}}>
                  {batches.map(b=>{
                    const fechaStr = b.emitido_at ? new Date(b.emitido_at).toLocaleString("es-AR",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"}) : "—";
                    const isExpanded = expandedBatch === b.batch_id;
                    return (
                      <div key={b.batch_id} style={{border:"1px solid "+T.borderL,borderRadius:10,overflow:"hidden",background:T.bg}}>
                        <div style={{display:"flex",alignItems:"center",gap:10,padding:"12px 14px",cursor:"pointer"}} onClick={()=>setExpandedBatch(isExpanded ? null : b.batch_id)}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={T.textMd} strokeWidth="2.5" strokeLinecap="round" style={{transform:isExpanded?"rotate(90deg)":"none",transition:"transform 0.15s",flexShrink:0}}><path d="M9 18l6-6-6-6"/></svg>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontSize:13,fontWeight:600,color:T.text}}>{fechaStr}</div>
                            <div style={{fontSize:11,color:T.textSm}}>{b.cantidad} factura{b.cantidad===1?"":"s"} · {b.batch_id}</div>
                          </div>
                          <div style={{fontSize:14,fontWeight:700,color:T.text,marginRight:8}}>$ {(b.total||0).toLocaleString("es-AR",{minimumFractionDigits:2})}</div>
                          <button onClick={(e)=>{e.stopPropagation();downloadBatchZip(b);}} style={{background:T.accent,border:"none",color:"#fff",borderRadius:6,padding:"6px 12px",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap"}}>
                            {loadingBatchPdfs===b.batch_id ? <><Spinner size={10} color="#fff"/> ZIP</> : "⬇ ZIP"}
                          </button>
                        </div>
                        {isExpanded && (
                          <div style={{borderTop:"1px solid "+T.borderL,background:T.card}}>
                            {(b.resumen||[]).map((r,i)=>(
                              <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",borderBottom:i<b.resumen.length-1?"1px solid "+T.borderL:"none"}}>
                                <div style={{padding:"2px 7px",borderRadius:5,fontSize:10,fontWeight:700,border:"1px solid "+T.accent+"44",color:T.accent,background:T.accent+"11",flexShrink:0}}>F{r.letra}</div>
                                <div style={{flex:1,minWidth:0,overflow:"hidden"}}>
                                  <div style={{fontSize:12,fontWeight:500,color:T.text,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{r.orden_id}</div>
                                  <div style={{fontSize:11,color:T.textSm}}>N° {String(r.comprobante).padStart(8,"0")} · CAE {r.cae}</div>
                                </div>
                                <div style={{fontSize:12,fontWeight:600,color:T.text,flexShrink:0}}>$ {(r.total||0).toLocaleString("es-AR",{minimumFractionDigits:2})}</div>
                                <button onClick={async()=>{
                                  const list = await loadBatchPdfs(b);
                                  if(!list) return;
                                  const pdf = list[i];
                                  if(pdf) downloadPDF(pdf);
                                }} style={{background:"transparent",border:"1px solid "+T.border,color:T.textMd,borderRadius:6,padding:"5px 10px",fontSize:10,fontWeight:500,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",flexShrink:0}}>
                                  ⬇ PDF
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ══ WIZARD MODAL ══ */}
      {showWizard && (
        <div style={{position:"fixed",inset:0,zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.6)",backdropFilter:"blur(4px)"}} onClick={resetWizard}>
          <div style={{background:T.card,border:"1px solid "+T.border,borderRadius:16,width:"100%",maxWidth:560,maxHeight:"90vh",overflowY:"auto",padding:"28px 32px"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:24}}>
              <div style={{fontSize:17,fontWeight:700,color:T.accent}}>Conectar nuevo CUIT a ARCA</div>
              <button onClick={resetWizard} style={{background:"transparent",border:"none",color:T.textMd,cursor:"pointer",fontSize:18,padding:4,lineHeight:1}}>✕</button>
            </div>

            {/* Progress bar */}
            <div style={{display:"flex",gap:6,marginBottom:8}}>
              {["Datos fiscales","Certificado en ARCA","Verificar"].map((_,i)=>(
                <div key={i} style={{flex:1,height:4,borderRadius:2,background:i<=wizStep?T.accent:T.border,transition:"background 0.2s ease"}}/>
              ))}
            </div>
            <div style={{display:"flex",gap:6,marginBottom:24,fontSize:10,color:T.textSm,fontWeight:600,textTransform:"uppercase",letterSpacing:0.4}}>
              {["Datos fiscales","Certificado en ARCA","Verificar"].map((label,i)=>(
                <div key={i} style={{flex:1,textAlign:"center",color:i===wizStep?T.accent:T.textSm}}>{label}</div>
              ))}
            </div>

            {/* Step 0: Datos */}
            {wizStep===0&&(
              <div style={{display:"flex",flexDirection:"column",gap:16}}>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
                  <div>
                    <label style={labelS}>CUIT (11 dígitos)</label>
                    <input value={wizCuit} onChange={e=>setWizCuit(e.target.value.replace(/\D/g,"").slice(0,11))} placeholder="20345678901" style={iS}/>
                    <div style={{fontSize:10,color:T.textSm,marginTop:3}}>Con o sin guiones</div>
                  </div>
                  <div>
                    <label style={labelS}>Tipo de persona</label>
                    <select value={wizTipoPersona} onChange={e=>setWizTipoPersona(e.target.value)} style={iS}>
                      {TIPOS_PERSONA.map(t=><option key={t.id} value={t.id}>{t.label}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  <label style={labelS}>Razón social / Nombre completo</label>
                  <input value={wizRazonSocial} onChange={e=>setWizRazonSocial(e.target.value)} placeholder="García López María Eugenia" style={iS}/>
                </div>
                <div>
                  <label style={labelS}>Nombre de fantasía (opcional)</label>
                  <input value={wizNombreFantasia} onChange={e=>setWizNombreFantasia(e.target.value)} placeholder="Mi Tienda Online" style={iS}/>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
                  <div>
                    <label style={labelS}>Condición frente al IVA</label>
                    <select value={wizCondicion} onChange={e=>setWizCondicion(e.target.value)} style={iS}>
                      {CONDICIONES.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}
                    </select>
                    <div style={{fontSize:10,color:T.textSm,marginTop:3}}>{wizCondicion==="MONOTRIBUTO"?"Emite Factura C":"Emite Factura A o B"}</div>
                  </div>
                  <div>
                    <label style={labelS}>Punto de venta</label>
                    <input value={wizPuntoVenta} onChange={e=>setWizPuntoVenta(e.target.value)} placeholder="1" style={iS}/>
                  </div>
                </div>
                <div>
                  <label style={labelS}>Domicilio comercial</label>
                  <input value={wizDomicilio} onChange={e=>setWizDomicilio(e.target.value)} placeholder="Av. Corrientes 1234, CABA" style={iS}/>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
                  <div>
                    <label style={labelS}>Fecha inicio actividades</label>
                    <input value={wizFechaInicio} onChange={e=>setWizFechaInicio(e.target.value)} placeholder="01/02/2024" style={iS}/>
                  </div>
                  <div>
                    <label style={labelS}>Ingresos brutos</label>
                    <input value={wizIngresosBrutos} onChange={e=>setWizIngresosBrutos(e.target.value)} placeholder="(default: tu CUIT)" style={iS}/>
                  </div>
                </div>
                <div>
                  <label style={labelS}>Ambiente ARCA</label>
                  <select value={wizArcaProd?"prod":"homo"} onChange={e=>setWizArcaProd(e.target.value==="prod")} style={iS}>
                    <option value="homo">Homologación (pruebas — las facturas no son reales)</option>
                    <option value="prod">Producción (facturas reales con CAE válido — cuidado)</option>
                  </select>
                </div>
              </div>
            )}

            {/* Step 1: Certificado + Clave (modo auto o manual) */}
            {wizStep===1&&(
              <div>
                <>
                    {/* Bloque 1: Generar (solo visible mientras no se generó) */}
                    {!csrPem && (
                      <div style={{background:T.card,border:"1px solid "+T.border,borderRadius:12,padding:18,marginBottom:14}}>
                        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                          <div style={{width:26,height:26,borderRadius:7,background:T.accentSolid+"22",border:"1px solid "+T.accent+"44",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:800,color:T.accent}}>1</div>
                          <div style={{fontSize:13,fontWeight:700,color:T.text}}>Generá tu archivo para ARCA</div>
                        </div>
                        <div style={{fontSize:12,color:T.textMd,lineHeight:1.6,marginBottom:12}}>
                          Tocá el botón y Growith genera tu CSR (Certificate Signing Request). Lo vas a descargar como <code style={{background:T.bg,padding:"1px 5px",borderRadius:3,fontSize:11}}>growith-{wizCuit||"CUIT"}.csr</code> para subirlo a ARCA en el paso siguiente.
                        </div>
                        <button onClick={generarCsrYKey} disabled={genLoading} style={{background:T.accent,border:"none",color:"#fff",borderRadius:8,padding:"12px 18px",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:8,opacity:genLoading?0.7:1}}>
                          {genLoading ? <><Spinner size={13} color="#fff"/> Generando (10-20 seg)...</> : "🔐 Generar mi archivo para ARCA"}
                        </button>
                        {genError && (
                          <div style={{marginTop:10,padding:"8px 12px",background:T.redBg,border:"1px solid "+T.red+"33",borderRadius:8,fontSize:11,color:T.red}}>⚠ {genError}</div>
                        )}
                      </div>
                    )}

                    {/* Bloque 2: Subir CSR a ARCA */}
                    {csrPem && (
                      <div style={{background:T.card,border:"1px solid "+T.border,borderRadius:12,padding:18,marginBottom:14}}>
                        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                          <div style={{width:26,height:26,borderRadius:7,background:T.accentSolid+"22",border:"1px solid "+T.accent+"44",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:800,color:T.accent}}>2</div>
                          <div style={{fontSize:13,fontWeight:700,color:T.text}}>Subí el CSR a ARCA</div>
                        </div>
                        <div style={{fontSize:11,color:T.textMd,background:T.bg,border:"1px solid "+T.borderL,borderRadius:6,padding:"7px 10px",marginBottom:10,lineHeight:1.5}}>
                          📎 ARCA te va a pedir <strong style={{color:T.text}}>subir un archivo</strong>. Ya descargamos tu <code style={{background:T.surface,padding:"1px 4px",borderRadius:3}}>growith-{wizCuit}.csr</code> al generar — buscalo en tu carpeta de Descargas.
                        </div>
                        {!wizArcaProd && (
                          <div style={{fontSize:11,color:T.yellow,background:T.yellowBg,border:"1px solid "+T.yellow+"33",borderRadius:6,padding:"7px 10px",marginBottom:10,lineHeight:1.5}}>
                            ⚠ Elegiste ambiente <strong>Homologación</strong>. En "Administración de Certificados Digitales" buscá la opción de Homologación antes de agregar el alias — los certs de homologación no funcionan en producción.
                          </div>
                        )}

                        <div style={{fontSize:11,fontWeight:700,color:T.text,marginBottom:6,textTransform:"uppercase",letterSpacing:0.4}}>Parte A — Crear el alias en ARCA (sube el .csr)</div>
                        <ol style={{margin:"4px 0 10px",paddingLeft:18,fontSize:12,color:T.textMd,lineHeight:1.8}}>
                          <li>Entrá a <a href="https://www.afip.gob.ar" target="_blank" rel="noopener" style={{color:T.accent,textDecoration:"underline"}}>arca.gob.ar</a> con tu CUIT y clave fiscal <strong style={{color:T.text}}>nivel 3</strong></li>
                          <li>Entrá al servicio <strong style={{color:T.text}}>"Administración de Certificados Digitales"</strong> → tocá <strong style={{color:T.text}}>"Agregar alias"</strong></li>
                          <li>Escribí un <strong style={{color:T.text}}>nombre de alias</strong> (ej. <code style={{background:T.bg,padding:"1px 4px",borderRadius:3,fontSize:11}}>growith</code>), tocá <strong style={{color:T.text}}>"Seleccionar archivo"</strong> y elegí el <code style={{background:T.bg,padding:"1px 4px",borderRadius:3,fontSize:11}}>.csr</code> que descargaste. Después tocá <strong style={{color:T.text}}>"Agregar alias"</strong></li>
                          <li style={{color:T.yellow}}>⏱ Esperá unos segundos. ARCA puede tardar en mostrar el alias creado — <strong style={{color:T.text}}>no toques "Agregar alias" dos veces</strong> o vas a duplicarlo</li>
                          <li>Tocá <strong style={{color:T.text}}>"VOLVER"</strong> → en la tabla "Certificados" vas a ver tu alias → tocá <strong style={{color:T.text}}>"Ver"</strong> en esa fila → tocá el ícono <strong style={{color:T.text}}>"Descargar"</strong>. ARCA descarga el certificado <strong style={{color:T.text}}>sin extensión</strong>, no te preocupes — el dropzone de abajo lo acepta igual</li>
                        </ol>
                        <details style={{margin:"0 0 14px",fontSize:11,color:T.textSm}}>
                          <summary style={{cursor:"pointer",padding:"6px 10px",background:T.bg,borderRadius:6,border:"1px solid "+T.borderL}}>▶ ¿No te aparece "Administración de Certificados Digitales" en tus servicios? (solo primera vez)</summary>
                          <ol style={{margin:"8px 0 0",paddingLeft:18,fontSize:11,color:T.textMd,lineHeight:1.7}}>
                            <li>Entrá a <strong style={{color:T.text}}>"Administrador de Relaciones de Clave Fiscal"</strong> → tocá <strong style={{color:T.text}}>"Adherir Servicio"</strong></li>
                            <li>Aparece una grilla de organismos (ANAC, ANSES, ARCA, ASIP...). Tocá el botón <strong style={{color:T.text}}>ARCA</strong> y se despliega su menú</li>
                            <li>Tocá <strong style={{color:T.text}}>"Servicios Interactivos"</strong> → buscá y elegí <strong style={{color:T.text}}>"Administración de Certificados Digitales"</strong> → Confirmar</li>
                            <li>Cerrá sesión y volvé a entrar para que aparezca en tu lista</li>
                          </ol>
                        </details>

                        <div style={{fontSize:11,fontWeight:700,color:T.text,marginBottom:6,textTransform:"uppercase",letterSpacing:0.4}}>Parte B — Autorizar el alias para Facturación Electrónica</div>
                        <ol style={{margin:"4px 0 14px",paddingLeft:18,fontSize:12,color:T.textMd,lineHeight:1.8}}>
                          <li>Volvé al portal de ARCA → <strong style={{color:T.text}}>"Administrador de Relaciones de Clave Fiscal"</strong> → tocá <strong style={{color:T.text}}>"Nueva Relación"</strong></li>
                          <li>
                            En la fila <strong style={{color:T.text}}>"Servicio"</strong> tocá <strong style={{color:T.text}}>BUSCAR</strong>:
                            <ul style={{margin:"4px 0 0",paddingLeft:18,lineHeight:1.7}}>
                              <li>Tocá <strong style={{color:T.text}}>ARCA</strong> en la grilla de organismos</li>
                              <li>Se despliega → tocá <strong style={{color:T.text}}>"WebServices"</strong></li>
                              <li>En la lista (ordenada alfabéticamente) buscá <strong style={{color:T.text}}>"Facturación Electrónica"</strong> (Nivel de seguridad mínimo requerido 3) — ojo, NO es "Facturación Electrónica con Detalle - MTXCA" ni "Factura electronica de exportacion", es el del medio sin sufijos</li>
                            </ul>
                          </li>
                          <li>
                            En la fila <strong style={{color:T.text}}>"Representante"</strong> tocá <strong style={{color:T.text}}>BUSCAR</strong>:
                            <ul style={{margin:"4px 0 0",paddingLeft:18,lineHeight:1.7}}>
                              <li>Te abre "Selección del Representante a autorizar"</li>
                              <li>En el desplegable <strong style={{color:T.text}}>"Computador Fiscal"</strong> elegí el alias que creaste en la Parte A. Si no aparece, refrescá la página y volvé a entrar</li>
                            </ul>
                          </li>
                          <li style={{color:T.red}}>⚠ <strong>NO confirmes sin haber cambiado el Representante</strong>. Si dejás "{(wizRazonSocial||"tu nombre").toUpperCase()} [Clave Fiscal Nivel 3]" (vos mismo), ARCA te tira error: "El dador de la autorización no debe ser igual al autorizado"</li>
                          <li>Tocá <strong style={{color:T.text}}>"Confirmar"</strong> para guardar la relación</li>
                        </ol>


                      </div>
                    )}

                    {/* Bloque 3: Subir .crt que devolvió ARCA */}
                    {csrPem && (
                      <div style={{background:T.card,border:"1px solid "+T.border,borderRadius:12,padding:18}}>
                        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                          <div style={{width:26,height:26,borderRadius:7,background:certText?T.green+"22":T.accentSolid+"22",border:"1px solid "+(certText?T.green:T.accent)+"44",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:800,color:certText?T.green:T.accent}}>{certText?"✓":"3"}</div>
                          <div style={{fontSize:13,fontWeight:700,color:T.text}}>Subí el certificado (.crt) que te devolvió ARCA</div>
                        </div>
                        <div
                          onClick={()=>document.getElementById('cert-file-input-auto')?.click()}
                          onDragOver={e=>{e.preventDefault();e.currentTarget.style.borderColor=T.accent;}}
                          onDragLeave={e=>{e.currentTarget.style.borderColor=T.border;}}
                          onDrop={e=>{e.preventDefault();e.currentTarget.style.borderColor=T.border;const f=e.dataTransfer.files[0];if(f)readPemFile(f,"cert",setCertText,setCertFileName,setCertFileError);}}
                          style={{border:"2px dashed "+(certText?T.green:T.border),borderRadius:10,padding:"22px 18px",textAlign:"center",cursor:"pointer",background:certText?T.greenBg:"transparent",transition:"all 0.15s"}}>
                          {certText ? (
                            <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:10}}>
                              <span style={{fontSize:22}}>📄</span>
                              <div style={{textAlign:"left"}}>
                                <div style={{fontSize:13,fontWeight:600,color:T.text}}>{certFileName||"certificado.crt"}</div>
                                <div style={{fontSize:11,color:T.green}}>✓ Certificado válido cargado · Click para cambiar</div>
                              </div>
                              <button onClick={e=>{e.stopPropagation();setCertText("");setCertFileName("");setCertFileError("");}} style={{background:"transparent",border:"none",color:T.textMd,cursor:"pointer",fontSize:16,padding:4,marginLeft:8}}>✕</button>
                            </div>
                          ) : (
                            <>
                              <span style={{fontSize:26,display:"block",marginBottom:6}}>📥</span>
                              <div style={{fontSize:13,fontWeight:600,color:T.text}}>Arrastrá el .crt que descargaste de ARCA</div>
                              <div style={{fontSize:11,color:T.textSm,marginTop:4}}>Acepta .crt, .pem o .cer</div>
                            </>
                          )}
                          <input id="cert-file-input-auto" type="file" accept=".crt,.pem,.cer" onChange={e=>{const f=e.target.files[0];if(f)readPemFile(f,"cert",setCertText,setCertFileName,setCertFileError);e.target.value="";}} style={{display:"none"}}/>
                        </div>
                        {certFileError && (
                          <div style={{marginTop:10,padding:"8px 12px",background:T.redBg,border:"1px solid "+T.red+"33",borderRadius:8,fontSize:11,color:T.red}}>⚠ {certFileError}</div>
                        )}
                      </div>
                    )}
                </>
              </div>
            )}

            {/* Step 2: Verificar */}
            {wizStep===2&&(
              <div>
                <div style={{background:T.bg,border:"1px solid "+T.border,borderRadius:12,padding:18,marginBottom:20}}>
                  <div style={{fontSize:14,fontWeight:700,color:T.text,marginBottom:14}}>Resumen de tu CUIT</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                    {[
                      ["CUIT",formatCuit(wizCuit)],
                      ["Razón social",wizRazonSocial||"—"],
                      ["Fantasía",wizNombreFantasia||"—"],
                      ["Condición",wizCondicion==="MONOTRIBUTO"?"Monotributista (Factura C)":"Resp. Inscripto (Factura A/B)"],
                      ["Punto de venta",wizPuntoVenta],
                      ["Ambiente",wizArcaProd?"⚠️ Producción (real)":"Homologación (pruebas)"],
                      ["Certificado",certText.trim()?"✅ Cargado":"❌ Sin cargar"],
                      ["Clave privada",keyText.trim()?"✅ Cargada":"❌ Sin cargar"],
                    ].map(([k,v],i)=>(
                      <div key={i} style={{padding:"10px 12px",background:T.card,borderRadius:8,border:"1px solid "+T.borderL}}>
                        <div style={{fontSize:10,color:T.textSm,textTransform:"uppercase",fontWeight:600,letterSpacing:0.4}}>{k}</div>
                        <div style={{fontSize:12,color:T.text,fontWeight:500,marginTop:3}}>{v}</div>
                      </div>
                    ))}
                  </div>
                </div>
                {testResult&&(
                  <div style={{padding:14,borderRadius:8,marginBottom:16,background:testResult.ok?T.greenBg:T.redBg,border:"1px solid "+(testResult.ok?T.green:T.red)+"33",fontSize:12,color:testResult.ok?T.green:T.red,fontWeight:500}}>
                    {testResult.ok?"✅ Conexión exitosa con ARCA":"❌ Error al conectar con ARCA"} — {testResult.msg}
                  </div>
                )}
                <button onClick={handleTestCuitWiz} disabled={testingCuit||!certText.trim()||!keyText.trim()} style={{background:"transparent",border:"1px solid "+T.border,color:T.textMd,borderRadius:8,padding:"10px 16px",fontSize:12,fontWeight:500,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:6,marginBottom:12,opacity:(!certText.trim()||!keyText.trim())?0.5:1}}>
                  {testingCuit?<><Spinner size={12} color={T.textMd}/> Testeando conexión...</>:"🔌 Testear conexión con ARCA (opcional)"}
                </button>
                <div style={{fontSize:11,color:T.textSm,textAlign:"center",lineHeight:1.5}}>
                  El test guarda el CUIT temporalmente y verifica que ARCA responda. Si no querés testear, podés guardar directo.
                </div>
              </div>
            )}

            {/* Nav buttons */}
            <div style={{display:"flex",gap:10,marginTop:24}}>
              {wizStep>0?(
                <button onClick={()=>setWizStep(s=>s-1)} style={{background:"transparent",border:"1px solid "+T.border,color:T.textMd,borderRadius:8,padding:"10px 20px",fontSize:13,fontWeight:500,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>
                  ← Atrás
                </button>
              ):(
                <button onClick={resetWizard} style={{background:"transparent",border:"1px solid "+T.border,color:T.textMd,borderRadius:8,padding:"10px 20px",fontSize:13,fontWeight:500,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>
                  Cancelar
                </button>
              )}
              <div style={{flex:1}}/>
              {wizStep<2?(
                <button onClick={()=>setWizStep(s=>s+1)} disabled={wizStep===1 && (!certText.trim()||!keyText.trim())} style={{background:T.accent,border:"none",color:"#fff",borderRadius:8,padding:"10px 24px",fontSize:13,fontWeight:600,cursor:(wizStep===1&&(!certText.trim()||!keyText.trim()))?"not-allowed":"pointer",fontFamily:"'Inter',system-ui,sans-serif",display:"flex",alignItems:"center",gap:6,opacity:(wizStep===1&&(!certText.trim()||!keyText.trim()))?0.5:1}}>
                  Continuar →
                </button>
              ):(
                <button onClick={handleSaveCuit} disabled={savingCuit} style={{background:"#16a34a",border:"none",color:"#fff",borderRadius:8,padding:"10px 24px",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",display:"flex",alignItems:"center",gap:6}}>
                  {savingCuit?<><Spinner size={13} color="#fff"/> Guardando...</>:"✅ Guardar CUIT"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ══ MODAL EDITAR CUIT ══ */}
      {showEditCuit && editCuit && (
        <div style={{position:"fixed",inset:0,zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.6)",backdropFilter:"blur(4px)"}} onClick={()=>setShowEditCuit(false)}>
          <div style={{background:T.card,border:"1px solid "+T.border,borderRadius:16,width:"100%",maxWidth:520,maxHeight:"90vh",overflowY:"auto",padding:"24px 28px"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
              <div>
                <div style={{fontSize:16,fontWeight:700,color:T.text}}>Editar datos del CUIT</div>
                <div style={{fontSize:11,color:T.textSm,marginTop:2}}>CUIT {formatCuit(editCuit.cuit)} — el certificado y la clave no se modifican</div>
              </div>
              <button onClick={()=>setShowEditCuit(false)} style={{background:"transparent",border:"none",color:T.textMd,cursor:"pointer",fontSize:18,padding:4,lineHeight:1}}>✕</button>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:14}}>
              <div>
                <label style={labelS}>Razón social / Nombre</label>
                <input value={editCuit.razon_social||""} onChange={e=>setEditCuit({...editCuit,razon_social:e.target.value})} style={iS}/>
              </div>
              <div>
                <label style={labelS}>Nombre de fantasía</label>
                <input value={editCuit.nombre_fantasia||""} onChange={e=>setEditCuit({...editCuit,nombre_fantasia:e.target.value})} style={iS}/>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
                <div>
                  <label style={labelS}>Condición IVA</label>
                  <select value={editCuit.condicion_fiscal||"RESPONSABLE_INSCRIPTO"} onChange={e=>setEditCuit({...editCuit,condicion_fiscal:e.target.value})} style={iS}>
                    {CONDICIONES.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelS}>Punto de venta</label>
                  <input value={editCuit.punto_venta||"1"} onChange={e=>setEditCuit({...editCuit,punto_venta:e.target.value.replace(/\D/g,"")})} style={iS}/>
                </div>
              </div>
              <div>
                <label style={labelS}>Domicilio</label>
                <input value={editCuit.domicilio||""} onChange={e=>setEditCuit({...editCuit,domicilio:e.target.value})} style={iS}/>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
                <div>
                  <label style={labelS}>Fecha inicio actividades</label>
                  <input value={editCuit.fecha_inicio||""} onChange={e=>setEditCuit({...editCuit,fecha_inicio:e.target.value})} placeholder="01/02/2024" style={iS}/>
                </div>
                <div>
                  <label style={labelS}>Ingresos brutos</label>
                  <input value={editCuit.ingresos_brutos||""} onChange={e=>setEditCuit({...editCuit,ingresos_brutos:e.target.value})} style={iS}/>
                </div>
              </div>
              <div>
                <label style={labelS}>Ambiente ARCA</label>
                <select value={editCuit.arca_prod?"prod":"homo"} onChange={e=>setEditCuit({...editCuit,arca_prod:e.target.value==="prod"})} style={iS}>
                  <option value="homo">Homologación (pruebas)</option>
                  <option value="prod">Producción (facturas reales)</option>
                </select>
              </div>
            </div>
            <div style={{display:"flex",gap:10,marginTop:22}}>
              <button onClick={()=>setShowEditCuit(false)} style={{background:"transparent",border:"1px solid "+T.border,color:T.textMd,borderRadius:8,padding:"10px 20px",fontSize:13,fontWeight:500,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>
                Cancelar
              </button>
              <div style={{flex:1}}/>
              <button onClick={handleSaveEditCuit} disabled={savingEdit} style={{background:T.accent,border:"none",color:"#fff",borderRadius:8,padding:"10px 24px",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",display:"flex",alignItems:"center",gap:6}}>
                {savingEdit?<><Spinner size={13} color="#fff"/> Guardando...</>:"Guardar cambios"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══ MODAL FACTURACIÓN MANUAL ══ */}
      {showManual && ReactDOM.createPortal(
        <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.6)",backdropFilter:"blur(4px)",padding:16}} onClick={()=>!emittingManual && resetManual()}>
          <div style={{background:T.card,border:"1px solid "+T.border,borderRadius:16,width:"100%",maxWidth:640,maxHeight:"92vh",overflowY:"auto",padding:"24px 28px"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:18}}>
              <div>
                <div style={{fontSize:16,fontWeight:700,color:T.text}}>Emitir factura manual</div>
                <div style={{fontSize:11,color:T.textSm,marginTop:2}}>Para ventas fuera de tus integraciones (mayoristas, venta directa, etc.)</div>
              </div>
              <button onClick={resetManual} disabled={emittingManual} style={{background:"transparent",border:"none",color:T.textMd,cursor:emittingManual?"wait":"pointer",fontSize:18,padding:4,lineHeight:1}}>✕</button>
            </div>

            {!manualResult ? (
              <>
                {/* Cliente */}
                <div style={{fontSize:11,fontWeight:700,color:T.textSm,textTransform:"uppercase",letterSpacing:0.4,marginBottom:8}}>Cliente</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:8}}>
                  <div>
                    <label style={labelS}>Nombre / Razón social</label>
                    <input value={manualNombre} onChange={e=>setManualNombre(e.target.value)} placeholder="Distribuidora SRL" style={iS}/>
                  </div>
                  <div>
                    <label style={labelS}>Tipo de documento</label>
                    <select value={manualDocTipo} onChange={e=>setManualDocTipo(e.target.value)} style={iS}>
                      <option value="CUIT">CUIT</option>
                      <option value="DNI">DNI</option>
                      <option value="CF">Consumidor Final (sin doc)</option>
                    </select>
                  </div>
                </div>
                {manualDocTipo !== "CF" && (
                  <div style={{marginBottom:18}}>
                    <label style={labelS}>{manualDocTipo === "CUIT" ? "CUIT del cliente" : "DNI del cliente"}</label>
                    <input value={manualDocNro} onChange={e=>setManualDocNro(e.target.value.replace(/\D/g,""))} placeholder={manualDocTipo === "CUIT" ? "30712345678" : "12345678"} style={iS}/>
                    {esRI && manualDocTipo === "CUIT" && <div style={{fontSize:10,color:T.textSm,marginTop:3}}>Si el cliente es Responsable Inscripto se emite Factura A, sino se reintenta como B</div>}
                  </div>
                )}

                {/* Items */}
                <div style={{fontSize:11,fontWeight:700,color:T.textSm,textTransform:"uppercase",letterSpacing:0.4,marginBottom:8,marginTop:6}}>Ítems</div>
                <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:8}}>
                  {manualItems.map((it,i)=>(
                    <div key={i} style={{display:"grid",gridTemplateColumns:"1fr 70px 110px 30px",gap:8,alignItems:"center"}}>
                      <input value={it.nombre} onChange={e=>{const arr=[...manualItems];arr[i].nombre=e.target.value;setManualItems(arr);}} placeholder="Producto / servicio" style={{...iS,fontSize:12}}/>
                      <input value={it.cantidad} onChange={e=>{const arr=[...manualItems];arr[i].cantidad=parseInt(e.target.value.replace(/\D/g,""))||0;setManualItems(arr);}} placeholder="Cant." style={{...iS,fontSize:12,textAlign:"center"}}/>
                      <input value={it.precio||""} onChange={e=>{const arr=[...manualItems];arr[i].precio=parseFloat(e.target.value)||0;setManualItems(arr);}} placeholder="Precio s/IVA" type="number" step="0.01" style={{...iS,fontSize:12,textAlign:"right"}}/>
                      <button onClick={()=>setManualItems(manualItems.filter((_,j)=>j!==i))} disabled={manualItems.length===1} style={{background:"transparent",border:"none",cursor:manualItems.length===1?"not-allowed":"pointer",color:T.red,fontSize:14,opacity:manualItems.length===1?0.3:1}}>🗑</button>
                    </div>
                  ))}
                </div>
                <button onClick={()=>setManualItems([...manualItems,{nombre:"",cantidad:1,precio:0}])} style={{background:"transparent",border:"1px dashed "+T.border,color:T.textMd,borderRadius:8,padding:"7px 12px",fontSize:11,fontWeight:500,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",width:"100%",marginBottom:14}}>
                  + Agregar ítem
                </button>

                {/* Total */}
                <div style={{padding:"14px 16px",background:T.bg,border:"1px solid "+T.borderL,borderRadius:10,display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                  <div style={{fontSize:12,color:T.textMd}}>Total {esMono ? "(sin IVA discriminado)" : "(IVA incluido al 21%)"}</div>
                  <div style={{fontSize:18,fontWeight:800,color:T.text,letterSpacing:-0.5}}>
                    ${manualItems.reduce((s,it)=>s+(it.cantidad||0)*(it.precio||0),0).toLocaleString("es-AR",{minimumFractionDigits:2})}
                  </div>
                </div>
                <div style={{fontSize:11,color:T.textSm,marginBottom:18,lineHeight:1.5}}>
                  Tipo de comprobante: <strong style={{color:T.text}}>
                    {esMono ? "Factura C" : (manualDocTipo === "CUIT" ? "Factura A (con fallback a B)" : "Factura B")}
                  </strong> · Punto de venta {String(cuitActivo?.punto_venta||1).padStart(5,"0")}
                </div>

                <div style={{display:"flex",gap:10}}>
                  <button onClick={resetManual} disabled={emittingManual} style={{background:"transparent",border:"1px solid "+T.border,color:T.textMd,borderRadius:8,padding:"10px 20px",fontSize:13,fontWeight:500,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>
                    Cancelar
                  </button>
                  <div style={{flex:1}}/>
                  <button onClick={handleEmitManual} disabled={emittingManual} style={{background:"#16a34a",border:"none",color:"#fff",borderRadius:8,padding:"10px 24px",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",display:"flex",alignItems:"center",gap:6}}>
                    {emittingManual?<><Spinner size={13} color="#fff"/> Emitiendo en ARCA...</>:"🧾 Emitir factura"}
                  </button>
                </div>
              </>
            ) : (
              <>
                {/* Resultado */}
                {manualResult.r?.ok ? (
                  <div style={{padding:18,background:T.greenBg,border:"1px solid "+T.green+"33",borderRadius:10,marginBottom:14}}>
                    <div style={{fontSize:14,fontWeight:700,color:T.green,marginBottom:6}}>✅ Factura emitida</div>
                    <div style={{fontSize:12,color:T.text,lineHeight:1.7}}>
                      Factura <strong>{manualResult.r.letra}</strong> N° <strong>{String(manualResult.r.comprobante).padStart(8,"0")}</strong><br/>
                      CAE: <strong>{manualResult.r.cae}</strong> (vto. {manualResult.r.cae_vto})<br/>
                      Total: <strong>${manualResult.r.total?.toLocaleString("es-AR",{minimumFractionDigits:2})}</strong>
                    </div>
                  </div>
                ) : (
                  <div style={{padding:14,background:T.redBg,border:"1px solid "+T.red+"33",borderRadius:10,marginBottom:14,fontSize:12,color:T.red}}>
                    ❌ {manualResult.r?.obs || "Error desconocido"}
                  </div>
                )}
                <div style={{display:"flex",gap:10}}>
                  <button onClick={resetManual} style={{background:"transparent",border:"1px solid "+T.border,color:T.textMd,borderRadius:8,padding:"10px 20px",fontSize:13,fontWeight:500,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>
                    Cerrar
                  </button>
                  <div style={{flex:1}}/>
                  {manualResult.pdf && (
                    <button onClick={()=>downloadPDF(manualResult.pdf)} style={{background:T.accentSolid,border:"none",color:"#fff",borderRadius:8,padding:"10px 20px",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",display:"flex",alignItems:"center",gap:6}}>
                      ⬇ Descargar PDF
                    </button>
                  )}
                  {manualResult.r?.ok && (
                    <button onClick={()=>{setManualResult(null);setManualNombre("");setManualDocNro("");setManualItems([{nombre:"",cantidad:1,precio:0}]);}} style={{background:"#16a34a",border:"none",color:"#fff",borderRadius:8,padding:"10px 20px",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>
                      Emitir otra
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}


// ===========================================
// APP META ADS
// ===========================================
function AppAudioStudio({T, user, onHome}) {
  const VOICES_DATA=[
    {name:"Zephyr",desc:"Brillante",gen:"f",tono:"energica"},
    {name:"Puck",desc:"Animada",gen:"m",tono:"energica"},
    {name:"Charon",desc:"Informativa",gen:"m",tono:"neutra"},
    {name:"Kore",desc:"Firme",gen:"f",tono:"neutra"},
    {name:"Fenrir",desc:"Excitable",gen:"m",tono:"energica"},
    {name:"Leda",desc:"Juvenil",gen:"f",tono:"calma"},
    {name:"Orus",desc:"Firme",gen:"m",tono:"neutra"},
    {name:"Aoede",desc:"Suave",gen:"f",tono:"calma"},
    {name:"Callirrhoe",desc:"Tranquila",gen:"f",tono:"calma"},
    {name:"Autonoe",desc:"Brillante",gen:"f",tono:"energica"},
    {name:"Enceladus",desc:"Susurrante",gen:"m",tono:"calma"},
    {name:"Iapetus",desc:"Clara",gen:"m",tono:"neutra"},
    {name:"Umbriel",desc:"Tranquila",gen:"m",tono:"calma"},
    {name:"Algieba",desc:"Suave",gen:"m",tono:"calma"},
    {name:"Despina",desc:"Suave",gen:"f",tono:"calma"},
    {name:"Erinome",desc:"Clara",gen:"f",tono:"neutra"},
    {name:"Algenib",desc:"Grave",gen:"m",tono:"neutra"},
    {name:"Rasalgethi",desc:"Informativa",gen:"m",tono:"neutra"},
    {name:"Laomedeia",desc:"Animada",gen:"f",tono:"energica"},
    {name:"Achernar",desc:"Suave",gen:"f",tono:"calma"},
    {name:"Alnilam",desc:"Firme",gen:"m",tono:"neutra"},
    {name:"Schedar",desc:"Equilibrada",gen:"f",tono:"neutra"},
    {name:"Gacrux",desc:"Madura",gen:"f",tono:"neutra"},
    {name:"Pulcherrima",desc:"Decidida",gen:"f",tono:"energica"},
    {name:"Achird",desc:"Amigable",gen:"m",tono:"calma"},
    {name:"Zubenelgenubi",desc:"Casual",gen:"m",tono:"neutra"},
    {name:"Vindemiatrix",desc:"Gentil",gen:"f",tono:"calma"},
    {name:"Sadachbia",desc:"Animada",gen:"m",tono:"energica"},
    {name:"Sadaltager",desc:"Sabio",gen:"m",tono:"neutra"},
    {name:"Sulafat",desc:"Cálida",gen:"f",tono:"calma"},
  ];

  const [filtroGen,setFiltroGen]=useState("todos");
  const [filtroTono,setFiltroTono]=useState("todos");
  const [voiceSel,setVoiceSel]=useState("Zephyr");
  const [text,setText]=useState("");
  const [applyStyle,setApplyStyle]=useState(true);
  const [generating,setGenerating]=useState(false);
  const [genError,setGenError]=useState(null);
  const [previewLoading,setPreviewLoading]=useState(null);
  const [previewAudio,setPreviewAudio]=useState({});
  const [previewPlaying,setPreviewPlaying]=useState(null);
  const [history,setHistory]=useState([]);
  const [playingId,setPlayingId]=useState(null);
  const previewRefs=useRef({});
  const audioRefs=useRef({});
  const MAX_CHARS=3000;

  const voicesFiltradas=VOICES_DATA.filter(v=>{
    if(filtroGen!=="todos"&&v.gen!==filtroGen) return false;
    if(filtroTono!=="todos"&&v.tono!==filtroTono) return false;
    return true;
  });

  async function handlePreview(voiceName) {
    if(previewAudio[voiceName]) {
      const audio=previewRefs.current[voiceName];
      if(!audio) return;
      if(previewPlaying===voiceName){audio.pause();setPreviewPlaying(null);}
      else{
        if(previewPlaying&&previewRefs.current[previewPlaying]) previewRefs.current[previewPlaying].pause();
        audio.currentTime=0; audio.play(); setPreviewPlaying(voiceName);
        audio.onended=()=>setPreviewPlaying(null);
      }
      return;
    }
    setPreviewLoading(voiceName);
    try{
      const r=await fetch(`/api/audio?action=sample&voice=${voiceName}`);
      const d=await r.json();
      if(!d.audioBase64) throw new Error(d.error||"Error");
      const url=`data:${d.mimeType};base64,${d.audioBase64}`;
      setPreviewAudio(prev=>({...prev,[voiceName]:url}));
      if(previewPlaying&&previewRefs.current[previewPlaying]) previewRefs.current[previewPlaying].pause();
      setTimeout(()=>{
        const audio=previewRefs.current[voiceName];
        if(audio){audio.currentTime=0;audio.play();setPreviewPlaying(voiceName);audio.onended=()=>setPreviewPlaying(null);}
      },50);
    }catch(e){toast("Error al previsualizar: "+e.message,"error");}
    finally{setPreviewLoading(null);}
  }

  async function handleGenerate() {
    if(!text.trim()) return toast("Escribí algo antes de generar","warning");
    if(!voiceSel) return toast("Seleccioná una voz","warning");
    if(text.length>MAX_CHARS) return toast(`Máximo ${MAX_CHARS} caracteres`,"warning");
    setGenerating(true); setGenError(null);
    try{
      const r=await fetch("/api/audio",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({text,voice_name:voiceSel,apply_style:applyStyle,uid:user?.uid}),
      });
      const d=await r.json();
      if(!r.ok||d.error) throw new Error(d.error||"Error al generar");
      const url=`data:${d.mimeType};base64,${d.audioBase64}`;
      const id=Date.now();
      setHistory(prev=>[{
        id,url,voice:d.voice,duration:d.duration,chars:d.chars,
        text:text.slice(0,120)+(text.length>120?"…":""),
        ts:new Date().toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"}),
        mimeType:d.mimeType,
      },...prev].slice(0,20));
      toast("Audio generado ✓","success");
    }catch(e){setGenError(e.message);toast(e.message,"error");}
    finally{setGenerating(false);}
  }

  function togglePlay(id) {
    if(playingId===id){audioRefs.current[id]?.pause();setPlayingId(null);}
    else{
      if(playingId&&audioRefs.current[playingId]) audioRefs.current[playingId].pause();
      const a=audioRefs.current[id];
      if(a){a.currentTime=0;a.play();setPlayingId(id);a.onended=()=>setPlayingId(null);}
    }
  }

  function downloadAudio(item) {
    const a=document.createElement("a");
    a.href=item.url;
    a.download=`growith_audio_${item.voice}_${Date.now()}.wav`;
    a.click();
  }

  const iS={width:"100%",background:T.input,border:`1px solid ${T.inputBorder}`,borderRadius:10,padding:"10px 14px",fontSize:13,color:T.text,fontFamily:"'Inter',system-ui,sans-serif",boxSizing:"border-box"};
  const BtnSec={background:"transparent",border:`1px solid ${T.border}`,color:T.textMd,borderRadius:8,padding:"7px 14px",fontSize:12,fontWeight:500,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",display:"flex",alignItems:"center",gap:6};
  const BtnPri={background:T.accentSolid,border:"none",color:"#fff",borderRadius:8,padding:"11px 20px",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",display:"flex",alignItems:"center",gap:8};
  const TONO_DOT={calma:T.blue,neutra:T.textSm,energica:T.orange};

  return (
    <div style={{fontFamily:"'Inter',system-ui,sans-serif",background:T.bg,minHeight:"100vh",display:"flex",flexDirection:"column"}}>
      <AppTopbar T={T} section="Audio Studio" onHome={onHome}>
        <div style={{fontSize:12,color:T.textSm,display:"flex",alignItems:"center",gap:5}}>
          <span style={{width:6,height:6,borderRadius:"50%",background:T.green,display:"inline-block"}}/>
          Gemini TTS · {VOICES_DATA.length} voces
        </div>
      </AppTopbar>

      <div style={{flex:1,maxWidth:1280,margin:"0 auto",padding:"24px 24px",width:"100%",display:"grid",gridTemplateColumns:"1fr 370px",gap:24,alignItems:"start"}}>

        {/* IZQUIERDA — selector de voces */}
        <div>
          {/* Filtros */}
          <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
            <div style={{display:"flex",background:T.surface,borderRadius:8,padding:3,border:`1px solid ${T.border}`,gap:2}}>
              {[["todos","Todas"],["f","Femeninas"],["m","Masculinas"]].map(([val,label])=>(
                <button key={val} onClick={()=>setFiltroGen(val)} style={{padding:"5px 12px",fontSize:12,fontWeight:filtroGen===val?700:400,borderRadius:6,border:"none",background:filtroGen===val?T.card:"transparent",color:filtroGen===val?T.text:T.textMd,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",boxShadow:filtroGen===val?"0 1px 3px rgba(0,0,0,0.15)":"none"}}>{label}</button>
              ))}
            </div>
            <div style={{display:"flex",background:T.surface,borderRadius:8,padding:3,border:`1px solid ${T.border}`,gap:2}}>
              {[["todos","Todos"],["calma","Calma"],["neutra","Neutra"],["energica","Enérgica"]].map(([val,label])=>(
                <button key={val} onClick={()=>setFiltroTono(val)} style={{padding:"5px 12px",fontSize:12,fontWeight:filtroTono===val?700:400,borderRadius:6,border:"none",background:filtroTono===val?T.card:"transparent",color:filtroTono===val?T.text:T.textMd,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",boxShadow:filtroTono===val?"0 1px 3px rgba(0,0,0,0.15)":"none"}}>{label}</button>
              ))}
            </div>
            <span style={{fontSize:12,color:T.textSm,marginLeft:"auto"}}>{voicesFiltradas.length} de {VOICES_DATA.length} voces</span>
          </div>

          {/* Grid voces */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(168px,1fr))",gap:10}}>
            {voicesFiltradas.map(v=>{
              const isSel=voiceSel===v.name;
              const isLoadPrev=previewLoading===v.name;
              const isPlayPrev=previewPlaying===v.name;
              const cached=!!previewAudio[v.name];
              return (
                <div key={v.name} onClick={()=>setVoiceSel(v.name)}
                  style={{background:isSel?T.accentSolid+"15":T.card,border:`1px solid ${isSel?T.accentSolid+"88":T.border}`,borderRadius:12,padding:"13px 13px 11px",cursor:"pointer",transition:"all 0.15s",position:"relative",boxShadow:isSel?`0 0 0 2px ${T.accentSolid}33`:"none"}}
                  onMouseEnter={e=>{if(!isSel)e.currentTarget.style.borderColor=T.accent+"55";}}
                  onMouseLeave={e=>{if(!isSel)e.currentTarget.style.borderColor=T.border;}}>
                  {previewAudio[v.name]&&<audio ref={el=>previewRefs.current[v.name]=el} src={previewAudio[v.name]} preload="auto" style={{display:"none"}}/>}
                  {isSel&&<div style={{position:"absolute",top:10,right:10,width:7,height:7,borderRadius:"50%",background:T.accentSolid}}/>}
                  <div style={{width:36,height:36,borderRadius:9,background:isSel?T.accentSolid:T.surface,border:`1px solid ${isSel?T.accentSolid:T.border}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,marginBottom:9,color:isSel?"#fff":T.textMd}}>
                    {v.gen==="f"?"♀":"♂"}
                  </div>
                  <div style={{fontSize:13,fontWeight:700,color:T.text,marginBottom:2}}>{v.name}</div>
                  <div style={{fontSize:11,color:T.textSm,marginBottom:9}}>{v.desc}</div>
                  <div style={{display:"flex",alignItems:"center",gap:4,marginBottom:9}}>
                    <span style={{width:5,height:5,borderRadius:"50%",background:TONO_DOT[v.tono]||T.textSm,flexShrink:0}}/>
                    <span style={{fontSize:10,color:T.textSm,textTransform:"capitalize"}}>{v.tono}</span>
                    <span style={{fontSize:10,color:T.textSm}}>·</span>
                    <span style={{fontSize:10,color:T.textSm}}>{v.gen==="f"?"Fem":"Mas"}</span>
                  </div>
                  <button onClick={e=>{e.stopPropagation();handlePreview(v.name);}}
                    style={{width:"100%",padding:"5px 0",fontSize:11,fontWeight:600,borderRadius:6,border:`1px solid ${isSel?T.accentSolid+"55":T.border}`,background:"transparent",color:isSel?T.accent:T.textMd,cursor:isLoadPrev?"wait":"pointer",fontFamily:"'Inter',system-ui,sans-serif",display:"flex",alignItems:"center",justifyContent:"center",gap:4}}>
                    {isLoadPrev?<><Spinner size={9} color={T.accent}/>Cargando...</>:isPlayPrev?"⏸ Pausar":cached?"▶ Escuchar":"▶ Preview"}
                  </button>
                </div>
              );
            })}
            {voicesFiltradas.length===0&&(
              <div style={{gridColumn:"1/-1",textAlign:"center",padding:40,color:T.textSm,fontSize:13}}>No hay voces con esos filtros</div>
            )}
          </div>
        </div>

        {/* DERECHA — editor + historial */}
        <div style={{display:"flex",flexDirection:"column",gap:16,position:"sticky",top:80}}>

          {/* Panel generación */}
          <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:20}}>
            <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.6,marginBottom:14}}>Generar audio</div>

            {/* Voz seleccionada */}
            {voiceSel&&(()=>{
              const v=VOICES_DATA.find(x=>x.name===voiceSel);
              return v?(
                <div style={{background:T.surface,border:`1px solid ${T.accentSolid}44`,borderRadius:10,padding:"9px 13px",marginBottom:14,display:"flex",alignItems:"center",gap:9}}>
                  <div style={{width:30,height:30,borderRadius:8,background:T.accentSolid+"22",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>{v.gen==="f"?"♀":"♂"}</div>
                  <div>
                    <div style={{fontSize:13,fontWeight:700,color:T.text}}>{v.name}</div>
                    <div style={{fontSize:11,color:T.textSm}}>{v.desc} · {v.tono}</div>
                  </div>
                </div>
              ):null;
            })()}

            {/* Textarea */}
            <div style={{position:"relative",marginBottom:14}}>
              <textarea value={text} onChange={e=>setText(e.target.value)}
                placeholder="Escribí el texto para generar la locución..." maxLength={MAX_CHARS}
                style={{...iS,minHeight:140,resize:"vertical",lineHeight:1.6,padding:"12px 14px"}}/>
              <div style={{position:"absolute",bottom:10,right:12,fontSize:11,color:text.length>MAX_CHARS*0.9?T.orange:T.textSm}}>
                {text.length}/{MAX_CHARS}
              </div>
            </div>

            {/* Toggle acento */}
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:16,cursor:"pointer"}} onClick={()=>setApplyStyle(s=>!s)}>
              <div className="gh-toggle" style={{width:34,height:18,borderRadius:9,background:applyStyle?T.accentSolid:T.border,position:"relative",flexShrink:0}}>
                <div className="gh-toggle-thumb" style={{width:14,height:14,borderRadius:"50%",background:"#fff",position:"absolute",top:2,left:applyStyle?18:2}}/>
              </div>
              <div>
                <div style={{fontSize:12,fontWeight:600,color:T.text}}>Acento porteño</div>
                <div style={{fontSize:11,color:T.textSm}}>Fuerza pronunciación rioplatense</div>
              </div>
            </div>

            {genError&&(
              <div style={{background:T.redBg,border:`1px solid ${T.red}44`,borderRadius:8,padding:"10px 14px",fontSize:12,color:T.red,marginBottom:12}}>{genError}</div>
            )}

            <button onClick={handleGenerate} disabled={generating||!text.trim()||!voiceSel}
              style={{...BtnPri,width:"100%",justifyContent:"center",padding:"12px",fontSize:14}}>
              {generating?<><Spinner size={14} color="#fff"/>Generando...</>:"🎙️ Generar audio"}
            </button>
          </div>

          {/* Historial sesión */}
          {history.length>0&&(
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:20}}>
              <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.6,marginBottom:14}}>
                Generados esta sesión <span style={{fontSize:10,fontWeight:400}}>({history.length})</span>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:10,maxHeight:480,overflowY:"auto"}}>
                {history.map(item=>(
                  <div key={item.id} style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:10,padding:"11px 13px"}}>
                    <audio ref={el=>audioRefs.current[item.id]=el} src={item.url} preload="auto" style={{display:"none"}}/>
                    <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:6}}>
                      <span style={{fontSize:11,fontWeight:700,color:T.accent}}>{item.voice}</span>
                      {item.duration&&<span style={{fontSize:11,color:T.textSm}}>{item.duration}s</span>}
                      <span style={{fontSize:11,color:T.textSm,marginLeft:"auto"}}>{item.ts}</span>
                    </div>
                    <div style={{fontSize:12,color:T.textMd,marginBottom:9,lineHeight:1.4}}>{item.text}</div>
                    <div style={{display:"flex",gap:7}}>
                      <button onClick={()=>togglePlay(item.id)} style={{...BtnSec,flex:1,justifyContent:"center",padding:"6px 0"}}>
                        {playingId===item.id?"⏸ Pausar":"▶ Escuchar"}
                      </button>
                      <button onClick={()=>downloadAudio(item)} style={{...BtnSec,padding:"6px 11px"}} title="Descargar WAV">⬇</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}



// ===========================================
// META ADS · Rule Editor (Fase 3 optimizador)
// ===========================================
function RuleEditor({T, initialRule, onSave, onCancel}) {
  const METRICS = [
    {id:"spend",label:"Gasto ($)",unit:"$"},
    {id:"roas",label:"ROAS (x)",unit:"x"},
    {id:"cpa",label:"CPA ($)",unit:"$"},
    {id:"ctr",label:"CTR (%)",unit:"%"},
    {id:"frequency",label:"Frecuencia",unit:""},
    {id:"impressions",label:"Impresiones",unit:""},
    {id:"purchases",label:"Compras",unit:""},
    {id:"clicks",label:"Clicks",unit:""},
    {id:"cpm",label:"CPM ($)",unit:"$"},
    {id:"cpc",label:"CPC ($)",unit:"$"},
  ];
  const OPS=[{id:">=",l:"≥"},{id:">",l:">"},{id:"<=",l:"≤"},{id:"<",l:"<"},{id:"=",l:"="}];
  const WINDOWS=[1,3,7,14,30];

  const [name,setName]=useState(initialRule?.name||"");
  const [level,setLevel]=useState(initialRule?.level||"ad");
  const [logic,setLogic]=useState(initialRule?.logic||"AND");
  const [action,setAction]=useState(initialRule?.action||"pause");
  const [active,setActive]=useState(initialRule?.active!==false);
  const [conditions,setConditions]=useState(initialRule?.conditions?.length?[...initialRule.conditions]:[{metric:"spend",op:">=",value:"",window_days:7}]);
  const [saving,setSaving]=useState(false);

  const updateCond=(i,patch)=>{
    setConditions(prev=>prev.map((c,idx)=>idx===i?{...c,...patch}:c));
  };
  const addCond=()=>setConditions(prev=>[...prev,{metric:"roas",op:"<",value:"",window_days:7}]);
  const removeCond=i=>setConditions(prev=>prev.filter((_,idx)=>idx!==i));

  async function handleSave() {
    if(!name.trim()){alert("Ponele un nombre");return;}
    const validConds = conditions.filter(c=>c.value!==""&&c.value!==null);
    if(validConds.length===0){alert("Necesita al menos 1 condición con valor");return;}
    setSaving(true);
    const ok = await onSave({
      ...(initialRule?{id:initialRule.id}:{}),
      name:name.trim(), level, logic, action, active,
      conditions: validConds.map(c=>({metric:c.metric,op:c.op,value:parseFloat(c.value),window_days:parseInt(c.window_days)||7})),
    });
    setSaving(false);
    if(!ok) return; // se queda abierto si falló
  }

  return ReactDOM.createPortal(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.6)",backdropFilter:"blur(4px)",padding:16}} onClick={()=>!saving&&onCancel()}>
      <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:16,width:"100%",maxWidth:680,maxHeight:"92vh",overflowY:"auto",padding:"24px 28px"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:18}}>
          <div>
            <div style={{fontSize:17,fontWeight:700,color:T.text}}>{initialRule?"Editar regla":"Nueva regla"}</div>
            <div style={{fontSize:11,color:T.textSm,marginTop:2}}>Definí cuándo y qué pausar automáticamente</div>
          </div>
          <button onClick={onCancel} disabled={saving} style={{background:"transparent",border:"none",color:T.textMd,cursor:saving?"wait":"pointer",fontSize:18,padding:4}}>✕</button>
        </div>

        {/* Nombre */}
        <div style={{marginBottom:14}}>
          <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:6}}>Nombre</div>
          <input value={name} onChange={e=>setName(e.target.value)} placeholder='Ej. "Pausar ads con CPA alto"' style={{width:"100%",background:T.input,border:`1px solid ${T.inputBorder}`,borderRadius:8,padding:"10px 13px",fontSize:13,color:T.text,fontFamily:"'Inter',system-ui,sans-serif",boxSizing:"border-box"}}/>
        </div>

        {/* Nivel + Lógica */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
          <div>
            <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:6}}>Aplicar a</div>
            <div style={{display:"flex",gap:2,background:T.bg,padding:3,borderRadius:8,border:`1px solid ${T.borderL}`}}>
              {[{id:"campaign",l:"Campañas"},{id:"adset",l:"Adsets"},{id:"ad",l:"Ads"}].map(o=>(
                <button key={o.id} onClick={()=>setLevel(o.id)} style={{flex:1,padding:"7px 10px",fontSize:12,fontWeight:600,border:"none",borderRadius:6,background:level===o.id?T.card:"transparent",color:level===o.id?T.text:T.textSm,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>{o.l}</button>
              ))}
            </div>
          </div>
          <div>
            <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:6}}>Cumplir</div>
            <div style={{display:"flex",gap:2,background:T.bg,padding:3,borderRadius:8,border:`1px solid ${T.borderL}`}}>
              <button onClick={()=>setLogic("AND")} style={{flex:1,padding:"7px 10px",fontSize:12,fontWeight:600,border:"none",borderRadius:6,background:logic==="AND"?T.card:"transparent",color:logic==="AND"?T.text:T.textSm,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>Todas (AND)</button>
              <button onClick={()=>setLogic("OR")} style={{flex:1,padding:"7px 10px",fontSize:12,fontWeight:600,border:"none",borderRadius:6,background:logic==="OR"?T.card:"transparent",color:logic==="OR"?T.text:T.textSm,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>Alguna (OR)</button>
            </div>
          </div>
        </div>

        {/* Condiciones */}
        <div style={{marginBottom:14}}>
          <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:8}}>Condiciones</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {conditions.map((c,i)=>{
              const M=METRICS.find(m=>m.id===c.metric);
              return (
                <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",background:T.bg,border:`1px solid ${T.borderL}`,borderRadius:8,flexWrap:"wrap"}}>
                  <select value={c.metric} onChange={e=>updateCond(i,{metric:e.target.value})} style={{background:T.input,border:`1px solid ${T.inputBorder}`,borderRadius:6,padding:"6px 8px",fontSize:12,color:T.text,fontFamily:"'Inter',system-ui,sans-serif",minWidth:130}}>
                    {METRICS.map(m=><option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                  <select value={c.op} onChange={e=>updateCond(i,{op:e.target.value})} style={{background:T.input,border:`1px solid ${T.inputBorder}`,borderRadius:6,padding:"6px 8px",fontSize:14,color:T.text,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:700,width:54,textAlign:"center"}}>
                    {OPS.map(o=><option key={o.id} value={o.id}>{o.l}</option>)}
                  </select>
                  <div style={{display:"flex",alignItems:"center",gap:4}}>
                    {M?.unit==="$"&&<span style={{fontSize:13,color:T.textSm}}>$</span>}
                    <input type="number" value={c.value} onChange={e=>updateCond(i,{value:e.target.value})} placeholder="valor" style={{background:T.input,border:`1px solid ${T.inputBorder}`,borderRadius:6,padding:"6px 8px",fontSize:12,color:T.text,fontFamily:"'Inter',system-ui,sans-serif",width:92}}/>
                    {M?.unit&&M.unit!=="$"&&<span style={{fontSize:13,color:T.textSm}}>{M.unit}</span>}
                  </div>
                  <span style={{fontSize:11,color:T.textSm}}>en últimos</span>
                  <select value={c.window_days} onChange={e=>updateCond(i,{window_days:parseInt(e.target.value)})} style={{background:T.input,border:`1px solid ${T.inputBorder}`,borderRadius:6,padding:"6px 8px",fontSize:12,color:T.text,fontFamily:"'Inter',system-ui,sans-serif"}}>
                    {WINDOWS.map(w=><option key={w} value={w}>{w} día{w>1?"s":""}</option>)}
                  </select>
                  {conditions.length>1&&<button onClick={()=>removeCond(i)} style={{marginLeft:"auto",background:"transparent",border:`1px solid ${T.red}33`,color:T.red,borderRadius:6,padding:"4px 8px",fontSize:11,cursor:"pointer"}}>✕</button>}
                </div>
              );
            })}
          </div>
          <button onClick={addCond} style={{marginTop:8,padding:"7px 12px",fontSize:11,border:`1px dashed ${T.border}`,borderRadius:8,background:"transparent",color:T.textMd,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>+ Agregar condición</button>
        </div>

        {/* Acción + Estado */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:18}}>
          <div>
            <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:6}}>Acción</div>
            <div style={{display:"flex",gap:2,background:T.bg,padding:3,borderRadius:8,border:`1px solid ${T.borderL}`}}>
              <button onClick={()=>setAction("pause")} style={{flex:1,padding:"7px 10px",fontSize:12,fontWeight:600,border:"none",borderRadius:6,background:action==="pause"?T.card:"transparent",color:action==="pause"?T.text:T.textSm,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>⏸ Pausar</button>
              <button onClick={()=>setAction("notify")} style={{flex:1,padding:"7px 10px",fontSize:12,fontWeight:600,border:"none",borderRadius:6,background:action==="notify"?T.card:"transparent",color:action==="notify"?T.text:T.textSm,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>📢 Solo notificar</button>
            </div>
          </div>
          <div>
            <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:6}}>Estado</div>
            <div style={{display:"flex",gap:2,background:T.bg,padding:3,borderRadius:8,border:`1px solid ${T.borderL}`}}>
              <button onClick={()=>setActive(true)} style={{flex:1,padding:"7px 10px",fontSize:12,fontWeight:600,border:"none",borderRadius:6,background:active?T.green+"33":"transparent",color:active?T.green:T.textSm,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>● Activa</button>
              <button onClick={()=>setActive(false)} style={{flex:1,padding:"7px 10px",fontSize:12,fontWeight:600,border:"none",borderRadius:6,background:!active?T.textSm+"33":"transparent",color:!active?T.text:T.textSm,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>⏸ Pausada</button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
          <button onClick={onCancel} disabled={saving} style={{padding:"10px 18px",fontSize:13,border:`1px solid ${T.border}`,borderRadius:8,background:"transparent",color:T.textMd,cursor:saving?"wait":"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>Cancelar</button>
          <button onClick={handleSave} disabled={saving} style={{padding:"10px 24px",fontSize:13,fontWeight:700,border:"none",borderRadius:8,background:T.accentSolid,color:"#fff",cursor:saving?"wait":"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>
            {saving?"Guardando...":"Guardar regla"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ===========================================
// APP META ADS
// ===========================================
function AppMetaAds({T, user, onHome}) {
  const OBJECTIVES=[
    {id:"OUTCOME_SALES",label:"Ventas"},{id:"OUTCOME_TRAFFIC",label:"Tráfico"},
    {id:"OUTCOME_ENGAGEMENT",label:"Interacción"},{id:"OUTCOME_LEADS",label:"Clientes potenciales"},
    {id:"OUTCOME_AWARENESS",label:"Reconocimiento"},
  ];
  const CTAS=["LEARN_MORE","SHOP_NOW","SIGN_UP","GET_OFFER","ORDER_NOW","BUY_NOW","CONTACT_US","WHATSAPP_MESSAGE"];
  const TONOS=["directo","emocional","urgencia","educativo"];
  const LARGOS=["corto","medio","largo"];
  const FORMATOS=["storytelling","directo","pregunta","testimonial"];

  const [tab,setTab]=useState("analisis");
  const [loading,setLoading]=useState(true);
  const [accounts,setAccounts]=useState([]);
  const [activeAccId,setActiveAccId]=useState(null);

  // Estado del tab Análisis (Ads Manager)
  const [aLevel,setALevel]=useState("campaign"); // campaign | adset | ad
  const [aSince,setASince]=useState(()=>new Date(Date.now()-7*86400000).toISOString().slice(0,10));
  const [aUntil,setAUntil]=useState(()=>new Date().toISOString().slice(0,10));
  const [aRows,setARows]=useState([]);
  const [aLoading,setALoading]=useState(false);
  const [aSort,setASort]=useState({key:"spend",dir:"desc"});
  const [aQuery,setAQuery]=useState("");
  const [aFilterStatus,setAFilterStatus]=useState("all"); // all | active | paused
  const [aBusyIds,setABusyIds]=useState({}); // ids siendo pausadas/activadas

  // Estado del tab Biblioteca
  const [libAds,setLibAds]=useState([]);
  const [libLoading,setLibLoading]=useState(false);
  const [libQuery,setLibQuery]=useState("");
  const [libSort,setLibSort]=useState("spend"); // spend | roas | recent
  const [analyzingId,setAnalyzingId]=useState(null);
  const [expandedAdId,setExpandedAdId]=useState(null);

  // Estado del tab Reglas
  const [rules,setRules]=useState([]);
  const [ruleLog,setRuleLog]=useState([]);
  const [rulesLoading,setRulesLoading]=useState(false);
  const [editingRule,setEditingRule]=useState(null); // null | "new" | rule object
  const [evaluatingNow,setEvaluatingNow]=useState(false);

  // Conexión System User Token
  const [tokenInput,setTokenInput]=useState("");
  const [connecting,setConnecting]=useState(false);
  const [connectData,setConnectData]=useState(null); // {id, ad_accounts, pages}
  const [selAdAcc,setSelAdAcc]=useState("");
  const [selPage,setSelPage]=useState("");
  const [savingSetup,setSavingSetup]=useState(false);
  const [showGuide,setShowGuide]=useState(false);

  // Campañas
  const [campaigns,setCampaigns]=useState([]);
  const [adsets,setAdsets]=useState([]);
  const [campsLoading,setCampsLoading]=useState(false);
  const [showNewCamp,setShowNewCamp]=useState(false);
  const [showNewAdset,setShowNewAdset]=useState(false);
  const [newCamp,setNewCamp]=useState({name:"",objective:"OUTCOME_SALES",cbo_daily_budget_ars:"",is_cbo:true});
  const [newAdset,setNewAdset]=useState({name:"",campaign_id:"",daily_budget_ars:"3000",is_cbo:false,start_time:""});
  const [campCreating,setCampCreating]=useState(false);
  const [adsetCreating,setAdsetCreating]=useState(false);

  // Creativos
  const [creatives,setCreatives]=useState([]);
  const [creativesLoading,setCreativesLoading]=useState(false);
  const [selCreative,setSelCreative]=useState(null);
  const [addingUrl,setAddingUrl]=useState(false);
  const [newCUrl,setNewCUrl]=useState("");
  const [newCName,setNewCName]=useState("");
  const [newCKind,setNewCKind]=useState("image");
  const [generatingCopy,setGeneratingCopy]=useState(null);
  const [publishing,setPublishing]=useState(null);

  // Brand
  const [brand,setBrand]=useState("");
  const [brandSaving,setBrandSaving]=useState(false);

  const uid=user?.uid;
  const activeAcc=accounts.find(a=>a.id===activeAccId)||null;

  const iS={width:"100%",background:T.input,border:`1px solid ${T.inputBorder}`,borderRadius:8,padding:"9px 12px",fontSize:13,color:T.text,fontFamily:"'Inter',system-ui,sans-serif",boxSizing:"border-box"};
  const BtnPri={background:T.accentSolid,border:"none",color:"#fff",borderRadius:8,padding:"9px 16px",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",display:"flex",alignItems:"center",gap:6};
  const BtnSec={background:"transparent",border:`1px solid ${T.border}`,color:T.textMd,borderRadius:8,padding:"7px 14px",fontSize:12,fontWeight:500,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",display:"flex",alignItems:"center",gap:6};
  const Card={background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"20px",marginBottom:16};
  const Label={fontSize:11,color:T.textSm,fontWeight:500,marginBottom:5,display:"block"};

  const metaApi=(action,method="GET",body=null,extra={})=>{
    const params=new URLSearchParams({action,uid,...extra});
    return fetch(`/api/meta?${params}`,{
      method,
      headers:method!=="GET"?{"Content-Type":"application/json"}:undefined,
      body:body?JSON.stringify(body):undefined,
    }).then(r=>r.json());
  };

  useEffect(()=>{
    if(!uid) return;
    metaApi("accounts").then(d=>{
      const accs=d.accounts||[];
      setAccounts(accs);
      if(d.active) setActiveAccId(d.active);
      else if(accs.length>0) setActiveAccId(accs[0].id);
      metaApi("brand").then(d=>{if(d.text!==undefined)setBrand(d.text);}).catch(()=>{});
    }).catch(()=>{}).finally(()=>setLoading(false));
  },[uid]);

  // Auto-evaluación de reglas en background al entrar al módulo Meta.
  // Si pasaron >6h desde la última eval, se dispara automaticamente.
  // No requiere cron de Vercel ni nada externo — corre del lado del navegador.
  useEffect(()=>{
    if(!activeAccId) return;
    const key = `growith_meta_lasteval_${activeAccId}`;
    const last = parseInt(localStorage.getItem(key) || "0");
    const sixHours = 6 * 3600 * 1000;
    if (Date.now() - last < sixHours) return;
    // Dispara en background sin bloquear UI
    metaApi("evaluate_rules","POST",null,{acc_id:activeAccId}).then(d=>{
      if(d?.error) return;
      localStorage.setItem(key, Date.now().toString());
      if(d?.actions > 0) toast(`Auto-eval: ${d.actions} acción${d.actions===1?"":"es"} aplicada${d.actions===1?"":"s"}`,"success");
    }).catch(()=>{});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[activeAccId]);

  useEffect(()=>{
    if(tab==="campanas"&&activeAccId) loadCampaigns();
    if(tab==="creativos"&&activeAccId) loadCreatives();
    if(tab==="analisis"&&activeAccId) loadInsights();
    if(tab==="biblioteca"&&activeAccId) loadLibrary();
    if(tab==="reglas"&&activeAccId) loadRules();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[tab,activeAccId]);

  async function loadLibrary() {
    if(!activeAccId) return;
    setLibLoading(true);
    try {
      const d = await metaApi("ads_library","GET",null,{acc_id:activeAccId});
      if(d.error) { toast("Error: "+d.error,"error"); setLibAds([]); }
      else setLibAds(d.ads||[]);
    } finally { setLibLoading(false); }
  }

  async function analyzeAd(ad) {
    setAnalyzingId(ad.id);
    try {
      const d = await metaApi("analyze_ad","POST",{ad},{acc_id:activeAccId});
      if(d.error) { toast("Error IA: "+d.error,"error"); return; }
      setLibAds(prev => prev.map(a => a.id === ad.id ? {...a, analysis: d.analysis, analyzed_at: new Date().toISOString()} : a));
      setExpandedAdId(ad.id);
      toast("Análisis listo ✓","success");
    } finally { setAnalyzingId(null); }
  }

  // ── Reglas ──
  async function loadRules() {
    if(!activeAccId) return;
    setRulesLoading(true);
    try {
      const [r, l] = await Promise.all([
        metaApi("rules_list","GET",null,{acc_id:activeAccId}),
        metaApi("rule_log","GET"),
      ]);
      if(!r.error) setRules(r.rules||[]);
      if(!l.error) setRuleLog(l.log||[]);
    } finally { setRulesLoading(false); }
  }

  async function saveRule(rule) {
    const d = await metaApi("rule_save","POST",{rule:{...rule, acc_id:activeAccId}});
    if(d.error) { toast("Error: "+d.error,"error"); return false; }
    toast("Regla guardada ✓","success");
    await loadRules();
    setEditingRule(null);
    return true;
  }

  async function deleteRule(ruleId) {
    if(!window.confirm("¿Borrar esta regla?")) return;
    const params=new URLSearchParams({action:"rule_delete",uid,rule_id:ruleId});
    const d=await fetch(`/api/meta?${params}`,{method:"DELETE"}).then(r=>r.json());
    if(d.error) { toast("Error: "+d.error,"error"); return; }
    toast("Regla eliminada","success");
    loadRules();
  }

  async function toggleRuleActive(rule) {
    await saveRule({...rule, active: !rule.active});
  }

  async function evaluateRulesNow() {
    setEvaluatingNow(true);
    try {
      const d = await metaApi("evaluate_rules","POST",null,{acc_id:activeAccId});
      if(d.error) { toast("Error: "+d.error,"error"); return; }
      toast(`Evaluación lista · ${d.actions||0} acciones aplicadas`,"success");
      loadRules();
    } finally { setEvaluatingNow(false); }
  }

  useEffect(()=>{
    if(tab==="analisis"&&activeAccId) loadInsights();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[aLevel,aSince,aUntil]);

  async function loadInsights() {
    if(!activeAccId) return;
    setALoading(true);
    try {
      const d = await metaApi("insights","GET",null,{acc_id:activeAccId,level:aLevel,since:aSince,until:aUntil});
      if(d.error) { toast("Error: "+d.error,"error"); setARows([]); }
      else setARows(d.rows||[]);
    } finally { setALoading(false); }
  }

  async function toggleStatus(row) {
    const targetStatus = row.effective_status === "ACTIVE" ? "PAUSED" : "ACTIVE";
    setABusyIds(b=>({...b,[row.id]:true}));
    try {
      const d = await metaApi("set_status","POST",{node_id:row.id,status:targetStatus},{acc_id:activeAccId});
      if(d.error) toast("Error: "+d.error,"error");
      else {
        toast(`${targetStatus==="PAUSED"?"Pausado":"Activado"} ✓`,"success");
        // Actualizar el row local sin recargar todo
        setARows(prev => prev.map(r => r.id === row.id ? {...r, effective_status: targetStatus, status: targetStatus} : r));
      }
    } finally {
      setABusyIds(b => { const n={...b}; delete n[row.id]; return n; });
    }
  }

  // ── Conectar System User Token ────────────────────────
  async function handleConnect() {
    if(!tokenInput.trim()) return toast("Pegá tu System User Token","warning");
    setConnecting(true);
    const d=await metaApi("connect","POST",{access_token:tokenInput.trim()});
    if(d.error){toast(d.error,"error");setConnecting(false);return;}
    // Si tiene 1 ad account y 1 página, guardar directo sin selector
    if((d.ad_accounts||[]).length===1 && (d.pages||[]).length===1) {
      const aa=d.ad_accounts[0];
      const pg=d.pages[0];
      const ig=pg.instagram_business_account;
      const s=await metaApi("select","POST",{
        ad_account_id:aa.id, ad_account_name:aa.name||"",
        page_id:pg.id, page_name:pg.name||"",
        page_access_token:pg.access_token||tokenInput.trim(),
        ig_account_id:ig?.id||"", ig_username:ig?.username||"",
      },{acc_id:d.id});
      if(s.error){toast(s.error,"error");setConnecting(false);return;}
      const newAcc={...d.account,...(s.account||{})};
      setAccounts(prev=>[...prev.filter(a=>a.id!==d.id),newAcc]);
      setActiveAccId(d.id);
      await metaApi("set_active","POST",{id:d.id});
      setTokenInput("");
      toast("Cuenta conectada ✓","success");
    } else {
      // Tiene múltiples — mostrar selector
      setConnectData(d);
      if((d.ad_accounts||[]).length>0) setSelAdAcc(d.ad_accounts[0].id);
      if((d.pages||[]).length>0) setSelPage(d.pages[0].id);
    }
    setConnecting(false);
  }

  async function handleSaveSetup() {
    if(!selAdAcc) return toast("Seleccioná un Ad Account","warning");
    setSavingSetup(true);
    const aa=(connectData.ad_accounts||[]).find(a=>a.id===selAdAcc);
    const pg=(connectData.pages||[]).find(p=>p.id===selPage);
    const ig=pg?.instagram_business_account;
    const d=await metaApi("select","POST",{
      ad_account_id:selAdAcc, ad_account_name:aa?.name||"",
      page_id:selPage||"", page_name:pg?.name||"",
      page_access_token:pg?.access_token||tokenInput||"",
      ig_account_id:ig?.id||"", ig_username:ig?.username||"",
    },{acc_id:connectData.id});
    if(d.error){toast(d.error,"error");setSavingSetup(false);return;}
    setAccounts(prev=>[...prev.filter(a=>a.id!==connectData.id),{...connectData,...(d.account||{})}]);
    setActiveAccId(connectData.id);
    await metaApi("set_active","POST",{id:connectData.id});
    setConnectData(null); setTokenInput("");
    toast("Cuenta configurada ✓","success");
    setSavingSetup(false);
  }

  async function handleDisconnect(accId) {
    if(!window.confirm("¿Desconectar esta cuenta de Meta?")) return;
    await fetch(`/api/meta?action=delete_account&uid=${uid}&acc_id=${accId}`,{method:"DELETE"});
    setAccounts(prev=>prev.filter(a=>a.id!==accId));
    if(activeAccId===accId) setActiveAccId(null);
    toast("Cuenta desconectada","success");
  }

  // ── Campañas ──────────────────────────────────────────
  async function loadCampaigns() {
    setCampsLoading(true);
    const d=await metaApi("campaigns","GET",null,{acc_id:activeAccId});
    if(d.error){toast(d.error,"error");setCampsLoading(false);return;}
    setCampaigns(d.campaigns||[]);
    setAdsets(d.adsets||[]);
    setCampsLoading(false);
  }

  async function handleCreateCampaign() {
    if(!newCamp.name.trim()) return toast("Poné un nombre","warning");
    setCampCreating(true);
    const d=await metaApi("create_campaign","POST",newCamp,{acc_id:activeAccId});
    if(d.error){toast(d.error,"error");setCampCreating(false);return;}
    toast(`Campaña "${d.name}" creada ✓`,"success");
    setShowNewCamp(false);
    setNewCamp({name:"",objective:"OUTCOME_SALES",cbo_daily_budget_ars:"",is_cbo:true});
    loadCampaigns(); setCampCreating(false);
  }

  async function handleCreateAdset() {
    if(!newAdset.campaign_id) return toast("Elegí una campaña","warning");
    if(!newAdset.name.trim()) return toast("Poné un nombre","warning");
    setAdsetCreating(true);
    const d=await metaApi("create_adset","POST",newAdset,{acc_id:activeAccId});
    if(d.error){toast(d.error,"error");setAdsetCreating(false);return;}
    toast(`AdSet "${d.name}" creado ✓`,"success");
    setShowNewAdset(false);
    setNewAdset({name:"",campaign_id:"",daily_budget_ars:"3000",is_cbo:false,start_time:""});
    loadCampaigns(); setAdsetCreating(false);
  }

  // ── Creativos ─────────────────────────────────────────
  async function loadCreatives() {
    setCreativesLoading(true);
    const d=await metaApi("creatives","GET",null,{acc_id:activeAccId});
    if(d.creatives) setCreatives(d.creatives);
    setCreativesLoading(false);
  }

  async function handleAddCreative() {
    if(!newCUrl.trim()||!newCName.trim()) return toast("Completá URL y nombre","warning");
    const d=await metaApi("add_creative","POST",{filename:newCName,kind:newCKind,url:newCUrl},{acc_id:activeAccId});
    if(d.error){toast(d.error,"error");return;}
    setCreatives(prev=>[d.creative,...prev]);
    setNewCUrl("");setNewCName("");setAddingUrl(false);
    toast("Creativo agregado ✓","success");
  }

  async function handleGenerateCopy(c) {
    setGeneratingCopy(c.id);
    const params=new URLSearchParams({action:"generate_copy",uid,cid:c.id});
    const d=await fetch(`/api/meta?${params}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tone:c.tone,length:c.length,format:c.format,notes:c.notes||""})}).then(r=>r.json());
    if(d.error){toast(d.error,"error");setGeneratingCopy(null);return;}
    setCreatives(prev=>prev.map(x=>x.id===c.id?d.creative:x));
    setSelCreative(d.creative);
    toast("Copy generado ✓","success");
    setGeneratingCopy(null);
  }

  async function handlePatch(c,updates) {
    const params=new URLSearchParams({action:"patch_creative",uid,cid:c.id});
    const d=await fetch(`/api/meta?${params}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(updates)}).then(r=>r.json());
    if(d.error){toast(d.error,"error");return;}
    setCreatives(prev=>prev.map(x=>x.id===c.id?d.creative:x));
    setSelCreative(d.creative);
  }

  async function handlePublish(c) {
    if(!c.copy?.trim()) return toast("Generá el copy primero","warning");
    if(!c.adset_id) return toast("Asigná un AdSet","warning");
    if(!c.url) return toast("El creativo necesita URL","warning");
    setPublishing(c.id);
    const d=await metaApi("publish","POST",{creative_id:c.id,activate:false},{acc_id:activeAccId});
    if(d.error){toast(d.error,"error");setPublishing(null);return;}
    toast(`Ad publicado en PAUSED ✓ (ID: ${d.ad_id})`,"success");
    setPublishing(null);
  }

  async function handleSaveBrand() {
    setBrandSaving(true);
    await metaApi("save_brand","POST",{text:brand});
    toast("Brand context guardado ✓","success");
    setBrandSaving(false);
  }

  if(loading) return(
    <div style={{background:T.bg,minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <Spinner size={28} color={T.accent}/>
    </div>
  );

  const TABS=[
    {id:"analisis",label:"📊 Análisis"},
    {id:"biblioteca",label:"📚 Biblioteca"},
    {id:"reglas",label:"⚡ Reglas"},
    {id:"cuenta",label:"Cuenta"},
    {id:"campanas",label:"Campañas & AdSets"},
    {id:"creativos",label:"Creativos"},
  ];

  // Guía paso a paso para obtener System User Token
  const GuiaToken=()=>(
    <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,padding:"16px 18px",marginBottom:16}}>
      <div style={{fontSize:12,fontWeight:700,color:T.text,marginBottom:12}}>📋 Cómo obtener tu System User Token (5 min)</div>
      {[
        {n:1,txt:"Entrá a",link:"https://business.facebook.com/settings/system-users",linkTxt:"business.facebook.com → Configuración → Usuarios → Usuarios del sistema"},
        {n:2,txt:"Hacé click en + Agregar → Ponele un nombre (ej: Growith) → Rol: Administrador → Crear usuario del sistema"},
        {n:3,txt:"Click en los 3 puntos del usuario creado → Asignar activos → Seleccioná tu Ad Account y tu Página → Permisos completos → Guardar"},
        {n:4,txt:"Click en Generar token → Elegí la app Growith → Permisos: ads_management, ads_read, pages_show_list → Vencimiento: Nunca → Generar token"},
        {n:5,txt:"Copiá el token y pegalo acá abajo"},
      ].map(s=>(
        <div key={s.n} style={{display:"flex",gap:10,marginBottom:10}}>
          <div style={{width:22,height:22,borderRadius:"50%",background:T.accentSolid,color:"#fff",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:1}}>{s.n}</div>
          <div style={{fontSize:12,color:T.textMd,lineHeight:1.5}}>
            {s.txt}{" "}
            {s.link&&<a href={s.link} target="_blank" rel="noopener noreferrer" style={{color:T.accent,textDecoration:"none"}}>{s.linkTxt}</a>}
          </div>
        </div>
      ))}
      <div style={{background:T.greenBg,border:`1px solid ${T.green}33`,borderRadius:8,padding:"8px 12px",marginTop:8,fontSize:11,color:T.green}}>
        ✓ El token "Nunca vence" — no vas a tener que renovarlo ni reconectar la cuenta
      </div>
    </div>
  );

  return(
    <div style={{fontFamily:"'Inter',system-ui,sans-serif",background:T.bg,minHeight:"100vh",display:"flex",flexDirection:"column"}}>
      <AppTopbar T={T} section="Meta Ads" onHome={onHome}>
        {activeAcc&&(
          <div style={{fontSize:12,color:T.textSm,display:"flex",alignItems:"center",gap:5}}>
            <span style={{width:6,height:6,borderRadius:"50%",background:T.green,display:"inline-block"}}/>
            {activeAcc.ad_account_name||activeAcc.user_name||"Conectado"}
          </div>
        )}
      </AppTopbar>
      <AppTabs T={T} tabs={TABS} active={tab} onChange={setTab}/>

      <div style={{maxWidth:1280,margin:"0 auto",padding:"28px 24px",width:"100%"}}>

        {/* ── ANÁLISIS (Ads Manager) ──────────────────── */}
        {tab==="analisis"&&(
          <div>
            {!activeAccId ? (
              <div style={{background:T.yellowBg,border:`1px solid ${T.yellow}44`,borderRadius:12,padding:"22px 24px",fontSize:13,color:T.textMd,lineHeight:1.6}}>
                ⚠ Conectá tu cuenta de Meta primero. Andá a <strong style={{color:T.text}}>Config → Tiendas conectadas → Meta Ads</strong> y dale "Conectar".
              </div>
            ) : (
              <>
                {/* Header con controles */}
                <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"16px 20px",marginBottom:16}}>
                  <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                    {/* Sub-tabs nivel */}
                    <div style={{display:"flex",gap:2,background:T.bg,padding:3,borderRadius:8,border:`1px solid ${T.borderL}`}}>
                      {[{id:"campaign",label:"Campañas"},{id:"adset",label:"Adsets"},{id:"ad",label:"Ads"}].map(l=>(
                        <button key={l.id} onClick={()=>setALevel(l.id)} style={{padding:"6px 14px",fontSize:12,fontWeight:600,border:"none",borderRadius:6,background:aLevel===l.id?T.card:"transparent",color:aLevel===l.id?T.text:T.textSm,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>{l.label}</button>
                      ))}
                    </div>
                    {/* Date range */}
                    <span style={{fontSize:11,color:T.textSm,marginLeft:8}}>Período</span>
                    <input type="date" value={aSince} max={aUntil} onChange={e=>setASince(e.target.value)} style={{background:T.input,border:`1px solid ${T.inputBorder}`,borderRadius:8,padding:"6px 10px",fontSize:12,color:T.text,colorScheme:"dark",fontFamily:"'Inter',system-ui,sans-serif"}}/>
                    <span style={{fontSize:11,color:T.textSm}}>a</span>
                    <input type="date" value={aUntil} min={aSince} max={new Date().toISOString().slice(0,10)} onChange={e=>setAUntil(e.target.value)} style={{background:T.input,border:`1px solid ${T.inputBorder}`,borderRadius:8,padding:"6px 10px",fontSize:12,color:T.text,colorScheme:"dark",fontFamily:"'Inter',system-ui,sans-serif"}}/>
                    {/* Presets rápidos */}
                    <div style={{display:"flex",gap:4}}>
                      {[{d:7,l:"7d"},{d:14,l:"14d"},{d:30,l:"30d"}].map(p=>(
                        <button key={p.d} onClick={()=>{setASince(new Date(Date.now()-p.d*86400000).toISOString().slice(0,10));setAUntil(new Date().toISOString().slice(0,10));}} style={{padding:"5px 10px",fontSize:11,border:`1px solid ${T.border}`,borderRadius:6,background:"transparent",color:T.textMd,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>{p.l}</button>
                      ))}
                    </div>
                    {/* Filtro estado */}
                    <select value={aFilterStatus} onChange={e=>setAFilterStatus(e.target.value)} style={{background:T.input,border:`1px solid ${T.inputBorder}`,borderRadius:8,padding:"6px 10px",fontSize:12,color:T.text,fontFamily:"'Inter',system-ui,sans-serif"}}>
                      <option value="all">Todos los estados</option>
                      <option value="active">Solo activos</option>
                      <option value="paused">Solo pausados</option>
                    </select>
                    {/* Búsqueda */}
                    <input type="text" placeholder="🔍 Buscar por nombre…" value={aQuery} onChange={e=>setAQuery(e.target.value)} style={{flex:1,minWidth:160,background:T.input,border:`1px solid ${T.inputBorder}`,borderRadius:8,padding:"6px 12px",fontSize:12,color:T.text,fontFamily:"'Inter',system-ui,sans-serif"}}/>
                    <button onClick={loadInsights} disabled={aLoading} title="Refrescar" style={{background:"transparent",border:`1px solid ${T.border}`,color:T.textMd,borderRadius:8,padding:"6px 10px",fontSize:13,cursor:aLoading?"wait":"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>
                      {aLoading?<Spinner size={12} color={T.textMd}/>:"🔄"}
                    </button>
                  </div>
                </div>

                {/* Tabla de insights */}
                {aLoading && aRows.length === 0 ? (
                  <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"60px 20px",textAlign:"center"}}>
                    <Spinner size={20} color={T.accent}/>
                    <div style={{fontSize:13,color:T.textSm,marginTop:14}}>Trayendo métricas de Meta...</div>
                  </div>
                ) : (() => {
                  // Filtrar + sortear
                  let filtered = aRows;
                  if (aQuery.trim()) {
                    const q = aQuery.trim().toLowerCase();
                    filtered = filtered.filter(r => (r.name||"").toLowerCase().includes(q));
                  }
                  if (aFilterStatus === "active") filtered = filtered.filter(r => r.effective_status === "ACTIVE");
                  if (aFilterStatus === "paused") filtered = filtered.filter(r => r.effective_status === "PAUSED");
                  filtered = [...filtered].sort((a,b) => {
                    const k = aSort.key; const dir = aSort.dir === "asc" ? 1 : -1;
                    if (typeof a[k] === "string") return (a[k]||"").localeCompare(b[k]||"") * dir;
                    return ((a[k]||0) - (b[k]||0)) * dir;
                  });

                  if (filtered.length === 0) {
                    return (
                      <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"50px 20px",textAlign:"center"}}>
                        <div style={{fontSize:32,marginBottom:8}}>📭</div>
                        <div style={{fontSize:13,color:T.textSm}}>No hay {aLevel === "campaign" ? "campañas" : aLevel === "adset" ? "adsets" : "ads"} en este rango.</div>
                      </div>
                    );
                  }

                  // Totales
                  const sumSpend = filtered.reduce((s,r)=>s+r.spend,0);
                  const sumPurchaseValue = filtered.reduce((s,r)=>s+r.purchase_value,0);
                  const sumPurchases = filtered.reduce((s,r)=>s+r.purchases,0);
                  const sumImpr = filtered.reduce((s,r)=>s+r.impressions,0);
                  const sumClicks = filtered.reduce((s,r)=>s+r.clicks,0);
                  const totalRoas = sumSpend > 0 ? sumPurchaseValue / sumSpend : 0;
                  const totalCpa = sumPurchases > 0 ? sumSpend / sumPurchases : 0;
                  const totalCtr = sumImpr > 0 ? (sumClicks / sumImpr) * 100 : 0;

                  const fmt = (n) => n.toLocaleString("es-AR",{minimumFractionDigits:2, maximumFractionDigits:2});
                  const fmtInt = (n) => Math.round(n).toLocaleString("es-AR");
                  const headerCell = (key, label, align="right") => (
                    <th onClick={()=>setASort(s=>({key, dir: s.key===key && s.dir==="desc" ? "asc" : "desc"}))} style={{padding:"10px 12px",textAlign:align,fontSize:10,fontWeight:700,color:T.textSm,textTransform:"uppercase",letterSpacing:0.5,cursor:"pointer",borderBottom:`1px solid ${T.border}`,whiteSpace:"nowrap",userSelect:"none"}}>
                      {label} {aSort.key===key && (aSort.dir==="desc"?"▼":"▲")}
                    </th>
                  );

                  return (
                    <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,overflow:"hidden"}}>
                      <div style={{overflowX:"auto"}}>
                        <table style={{width:"100%",borderCollapse:"collapse",fontFamily:"'Inter',system-ui,sans-serif"}}>
                          <thead style={{background:T.bg,position:"sticky",top:0,zIndex:1}}>
                            <tr>
                              <th style={{padding:"10px 12px",textAlign:"left",fontSize:10,fontWeight:700,color:T.textSm,textTransform:"uppercase",letterSpacing:0.5,borderBottom:`1px solid ${T.border}`,width:54}}>Acción</th>
                              {headerCell("name", aLevel==="campaign"?"Campaña":aLevel==="adset"?"AdSet":"Ad", "left")}
                              {headerCell("spend","Gasto")}
                              {headerCell("purchases","Compras")}
                              {headerCell("purchase_value","Valor compras")}
                              {headerCell("roas","ROAS")}
                              {headerCell("cpa","CPA")}
                              {headerCell("ctr","CTR")}
                              {headerCell("cpm","CPM")}
                              {headerCell("cpc","CPC")}
                              {headerCell("frequency","Frec.")}
                              {headerCell("impressions","Impr.")}
                              {headerCell("reach","Alcance")}
                            </tr>
                          </thead>
                          <tbody>
                            {filtered.map(r => {
                              const busy = !!aBusyIds[r.id];
                              const isActive = r.effective_status === "ACTIVE";
                              return (
                                <tr key={r.id} style={{borderBottom:`1px solid ${T.borderL}`,opacity:isActive?1:0.6}}>
                                  <td style={{padding:"10px 12px"}}>
                                    <button onClick={()=>toggleStatus(r)} disabled={busy} title={isActive?"Pausar":"Activar"} style={{background:isActive?T.green+"22":T.red+"22",border:`1px solid ${isActive?T.green:T.red}55`,color:isActive?T.green:T.red,borderRadius:6,padding:"4px 8px",fontSize:11,cursor:busy?"wait":"pointer",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>
                                      {busy?<Spinner size={10} color={isActive?T.green:T.red}/>:isActive?"⏸":"▶"}
                                    </button>
                                  </td>
                                  <td style={{padding:"10px 12px",fontSize:12,color:T.text,maxWidth:280,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                                    <div style={{fontWeight:600}}>{r.name||"(sin nombre)"}</div>
                                    <div style={{fontSize:10,color:T.textSm,marginTop:1}}>
                                      <span style={{padding:"1px 6px",borderRadius:4,background:isActive?T.green+"22":T.red+"22",color:isActive?T.green:T.red,fontWeight:600}}>{r.effective_status||"—"}</span>
                                      {r.daily_budget && <span style={{marginLeft:6}}>· ${fmt(r.daily_budget)}/día</span>}
                                    </div>
                                  </td>
                                  <td style={{padding:"10px 12px",textAlign:"right",fontSize:12,color:T.text,fontWeight:600,whiteSpace:"nowrap"}}>${fmt(r.spend)}</td>
                                  <td style={{padding:"10px 12px",textAlign:"right",fontSize:12,color:T.text}}>{r.purchases}</td>
                                  <td style={{padding:"10px 12px",textAlign:"right",fontSize:12,color:T.text,whiteSpace:"nowrap"}}>${fmt(r.purchase_value)}</td>
                                  <td style={{padding:"10px 12px",textAlign:"right",fontSize:12,color:r.roas>=2?T.green:r.roas>=1?T.text:T.red,fontWeight:700}}>{fmt(r.roas)}x</td>
                                  <td style={{padding:"10px 12px",textAlign:"right",fontSize:12,color:T.text,whiteSpace:"nowrap"}}>{r.cpa?"$"+fmt(r.cpa):"—"}</td>
                                  <td style={{padding:"10px 12px",textAlign:"right",fontSize:12,color:T.text}}>{fmt(r.ctr)}%</td>
                                  <td style={{padding:"10px 12px",textAlign:"right",fontSize:12,color:T.text,whiteSpace:"nowrap"}}>${fmt(r.cpm)}</td>
                                  <td style={{padding:"10px 12px",textAlign:"right",fontSize:12,color:T.text,whiteSpace:"nowrap"}}>${fmt(r.cpc)}</td>
                                  <td style={{padding:"10px 12px",textAlign:"right",fontSize:12,color:T.text}}>{fmt(r.frequency)}</td>
                                  <td style={{padding:"10px 12px",textAlign:"right",fontSize:12,color:T.text}}>{fmtInt(r.impressions)}</td>
                                  <td style={{padding:"10px 12px",textAlign:"right",fontSize:12,color:T.text}}>{fmtInt(r.reach)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                          <tfoot style={{background:T.bg}}>
                            <tr>
                              <td style={{padding:"10px 12px"}}></td>
                              <td style={{padding:"10px 12px",fontSize:11,fontWeight:700,color:T.textSm,textTransform:"uppercase",letterSpacing:0.4}}>Totales · {filtered.length} {aLevel}{filtered.length===1?"":"s"}</td>
                              <td style={{padding:"10px 12px",textAlign:"right",fontSize:12,fontWeight:700,color:T.text,whiteSpace:"nowrap"}}>${fmt(sumSpend)}</td>
                              <td style={{padding:"10px 12px",textAlign:"right",fontSize:12,fontWeight:700,color:T.text}}>{sumPurchases}</td>
                              <td style={{padding:"10px 12px",textAlign:"right",fontSize:12,fontWeight:700,color:T.text,whiteSpace:"nowrap"}}>${fmt(sumPurchaseValue)}</td>
                              <td style={{padding:"10px 12px",textAlign:"right",fontSize:12,fontWeight:700,color:totalRoas>=2?T.green:totalRoas>=1?T.text:T.red}}>{fmt(totalRoas)}x</td>
                              <td style={{padding:"10px 12px",textAlign:"right",fontSize:12,fontWeight:700,color:T.text,whiteSpace:"nowrap"}}>{totalCpa?"$"+fmt(totalCpa):"—"}</td>
                              <td style={{padding:"10px 12px",textAlign:"right",fontSize:12,fontWeight:700,color:T.text}}>{fmt(totalCtr)}%</td>
                              <td colSpan="5"></td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        )}

        {/* ── BIBLIOTECA DE ANUNCIOS ──────────────────── */}
        {tab==="biblioteca"&&(
          <div>
            {!activeAccId ? (
              <div style={{background:T.yellowBg,border:`1px solid ${T.yellow}44`,borderRadius:12,padding:"22px 24px",fontSize:13,color:T.textMd}}>
                ⚠ Conectá tu cuenta de Meta primero desde Config.
              </div>
            ) : (
              <>
                <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"16px 20px",marginBottom:16}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8,flexWrap:"wrap",gap:10}}>
                    <div>
                      <div style={{fontSize:15,fontWeight:700,color:T.text}}>Biblioteca de anuncios</div>
                      <div style={{fontSize:11,color:T.textSm,marginTop:2}}>Tus anuncios con métricas reales de los últimos 7 días. Tocá "Analizar con IA" para que Gemini desglose qué hace cada uno.</div>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                      <input type="text" placeholder="🔍 Buscar…" value={libQuery} onChange={e=>setLibQuery(e.target.value)} style={{background:T.input,border:`1px solid ${T.inputBorder}`,borderRadius:8,padding:"6px 12px",fontSize:12,color:T.text,minWidth:180,fontFamily:"'Inter',system-ui,sans-serif"}}/>
                      <select value={libSort} onChange={e=>setLibSort(e.target.value)} style={{background:T.input,border:`1px solid ${T.inputBorder}`,borderRadius:8,padding:"6px 10px",fontSize:12,color:T.text,fontFamily:"'Inter',system-ui,sans-serif"}}>
                        <option value="spend">Más gasto 7d</option>
                        <option value="roas">Mejor ROAS 7d</option>
                        <option value="recent">Recién analizados</option>
                      </select>
                      <button onClick={loadLibrary} disabled={libLoading} style={{background:"transparent",border:`1px solid ${T.border}`,color:T.textMd,borderRadius:8,padding:"6px 10px",fontSize:13,cursor:libLoading?"wait":"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>{libLoading?<Spinner size={12} color={T.textMd}/>:"🔄"}</button>
                    </div>
                  </div>
                </div>

                {libLoading && libAds.length===0 ? (
                  <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"60px 20px",textAlign:"center"}}>
                    <Spinner size={20} color={T.accent}/>
                    <div style={{fontSize:13,color:T.textSm,marginTop:14}}>Cargando tus anuncios desde Meta...</div>
                  </div>
                ) : (() => {
                  let filtered = libAds;
                  if (libQuery.trim()) {
                    const q = libQuery.trim().toLowerCase();
                    filtered = filtered.filter(a => (a.name||"").toLowerCase().includes(q) || (a.creative_body||"").toLowerCase().includes(q) || (a.creative_title||"").toLowerCase().includes(q));
                  }
                  filtered = [...filtered].sort((a,b) => {
                    if (libSort === "spend") return (b.spend||0) - (a.spend||0);
                    if (libSort === "roas") return (b.roas||0) - (a.roas||0);
                    if (libSort === "recent") return (b.analyzed_at||"").localeCompare(a.analyzed_at||"");
                    return 0;
                  });

                  if (filtered.length === 0) {
                    return (
                      <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"50px 20px",textAlign:"center"}}>
                        <div style={{fontSize:32,marginBottom:8}}>📭</div>
                        <div style={{fontSize:13,color:T.textSm}}>No hay anuncios para mostrar.</div>
                      </div>
                    );
                  }

                  const fmt = (n) => (n||0).toLocaleString("es-AR",{minimumFractionDigits:2,maximumFractionDigits:2});

                  return (
                    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(340px, 1fr))",gap:16}}>
                      {filtered.map(ad => {
                        const isActive = ad.effective_status === "ACTIVE";
                        const isExpanded = expandedAdId === ad.id;
                        const analyzing = analyzingId === ad.id;
                        const A = ad.analysis;
                        const roasColor = ad.roas >= 2 ? T.green : ad.roas >= 1 ? T.text : ad.roas > 0 ? T.red : T.textSm;
                        return (
                          <div key={ad.id} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,overflow:"hidden",display:"flex",flexDirection:"column"}}>
                            {/* Thumbnail */}
                            <div style={{width:"100%",aspectRatio:"16/9",background:T.bg,position:"relative",overflow:"hidden"}}>
                              {ad.creative_thumbnail
                                ? <img src={ad.creative_thumbnail} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}} onError={e=>{e.target.style.display="none";}}/>
                                : <div style={{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:38,color:T.textSm}}>🖼️</div>
                              }
                              <span style={{position:"absolute",top:8,right:8,fontSize:10,padding:"3px 8px",borderRadius:5,background:isActive?T.green:T.red,color:"#fff",fontWeight:700,letterSpacing:0.3}}>
                                {isActive ? "ACTIVO" : (ad.effective_status||"PAUSADO")}
                              </span>
                            </div>

                            {/* Cuerpo */}
                            <div style={{padding:"14px 16px",display:"flex",flexDirection:"column",gap:8,flex:1}}>
                              <div>
                                <div style={{fontSize:13,fontWeight:700,color:T.text,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{ad.name||"(sin nombre)"}</div>
                                {ad.creative_title && <div style={{fontSize:11,color:T.accent,marginTop:2,fontWeight:600,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{ad.creative_title}</div>}
                              </div>
                              {ad.creative_body && (
                                <div style={{fontSize:11,color:T.textMd,lineHeight:1.5,maxHeight:54,overflow:"hidden",display:"-webkit-box",WebkitLineClamp:3,WebkitBoxOrient:"vertical"}}>{ad.creative_body}</div>
                              )}

                              {/* Métricas */}
                              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginTop:6,padding:"10px 12px",background:T.bg,borderRadius:8,border:`1px solid ${T.borderL}`}}>
                                <div>
                                  <div style={{fontSize:9,color:T.textSm,textTransform:"uppercase",fontWeight:600,letterSpacing:0.4}}>Gasto 7d</div>
                                  <div style={{fontSize:13,fontWeight:700,color:T.text,marginTop:2}}>${fmt(ad.spend)}</div>
                                </div>
                                <div>
                                  <div style={{fontSize:9,color:T.textSm,textTransform:"uppercase",fontWeight:600,letterSpacing:0.4}}>ROAS 7d</div>
                                  <div style={{fontSize:13,fontWeight:700,color:roasColor,marginTop:2}}>{fmt(ad.roas)}x</div>
                                </div>
                                <div>
                                  <div style={{fontSize:9,color:T.textSm,textTransform:"uppercase",fontWeight:600,letterSpacing:0.4}}>Compras</div>
                                  <div style={{fontSize:13,fontWeight:700,color:T.text,marginTop:2}}>{ad.purchases||0}</div>
                                </div>
                              </div>

                              {/* Análisis IA */}
                              {A ? (
                                <>
                                  <div style={{fontSize:11,color:T.textMd,lineHeight:1.55,padding:"8px 10px",background:T.accent+"10",borderLeft:`2px solid ${T.accent}`,borderRadius:4,marginTop:4}}>
                                    <span style={{fontSize:9,color:T.accent,fontWeight:700,textTransform:"uppercase",letterSpacing:0.5}}>🤖 Resumen IA</span>
                                    <div style={{marginTop:4}}>{A.descripcion_corta}</div>
                                  </div>
                                  {isExpanded && (
                                    <div style={{fontSize:11,color:T.textMd,lineHeight:1.65,padding:"10px 12px",background:T.bg,border:`1px solid ${T.borderL}`,borderRadius:8,marginTop:2,display:"flex",flexDirection:"column",gap:8}}>
                                      <div><strong style={{color:T.text}}>Audiencia:</strong> {A.audiencia_target}</div>
                                      <div><strong style={{color:T.text}}>Hook:</strong> "{A.hook}"</div>
                                      <div><strong style={{color:T.text}}>Ángulos:</strong> {(A.angulos||[]).join(" · ")}</div>
                                      <div><strong style={{color:T.text}}>Tono / Formato:</strong> {A.tono} · {A.formato}</div>
                                      <div><strong style={{color:T.text}}>Estrategia:</strong> {A.estrategia}</div>
                                      {A.fortalezas?.length>0 && (
                                        <div>
                                          <strong style={{color:T.green}}>Fortalezas:</strong>
                                          <ul style={{margin:"4px 0 0",paddingLeft:16}}>{A.fortalezas.map((f,i)=><li key={i}>{f}</li>)}</ul>
                                        </div>
                                      )}
                                      {A.oportunidades?.length>0 && (
                                        <div>
                                          <strong style={{color:T.yellow||"#eab308"}}>Mejoras:</strong>
                                          <ul style={{margin:"4px 0 0",paddingLeft:16}}>{A.oportunidades.map((o,i)=><li key={i}>{o}</li>)}</ul>
                                        </div>
                                      )}
                                      <div style={{padding:"8px 10px",background:T.surface,borderRadius:6,marginTop:2}}>
                                        <strong style={{color:T.text}}>📈 Performance:</strong>
                                        <div style={{marginTop:3}}>{A.performance_takeaway}</div>
                                      </div>
                                      <div style={{padding:"8px 10px",background:A.accion_recomendada==="escalar"?T.green+"15":A.accion_recomendada==="pausar"?T.red+"15":T.yellow+"15",border:`1px solid ${A.accion_recomendada==="escalar"?T.green+"55":A.accion_recomendada==="pausar"?T.red+"55":T.yellow+"55"}`,borderRadius:6,marginTop:2}}>
                                        <strong style={{color:T.text,textTransform:"uppercase",fontSize:10,letterSpacing:0.5}}>Acción recomendada: {A.accion_recomendada}</strong>
                                        <div style={{marginTop:3}}>{A.razon_accion}</div>
                                      </div>
                                    </div>
                                  )}
                                  <div style={{display:"flex",gap:8,marginTop:6}}>
                                    <button onClick={()=>setExpandedAdId(isExpanded?null:ad.id)} style={{flex:1,padding:"7px 12px",fontSize:11,fontWeight:600,border:`1px solid ${T.border}`,borderRadius:7,background:"transparent",color:T.textMd,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>
                                      {isExpanded ? "− Cerrar análisis" : "+ Ver análisis FULL"}
                                    </button>
                                    <button onClick={()=>analyzeAd(ad)} disabled={analyzing} title="Re-analizar" style={{padding:"7px 10px",fontSize:11,border:`1px solid ${T.border}`,borderRadius:7,background:"transparent",color:T.textMd,cursor:analyzing?"wait":"pointer"}}>
                                      {analyzing ? <Spinner size={10} color={T.textMd}/> : "🔄"}
                                    </button>
                                  </div>
                                </>
                              ) : (
                                <button onClick={()=>analyzeAd(ad)} disabled={analyzing} style={{marginTop:"auto",padding:"9px 14px",fontSize:12,fontWeight:600,border:"none",borderRadius:8,background:T.accentSolid,color:"#fff",cursor:analyzing?"wait":"pointer",fontFamily:"'Inter',system-ui,sans-serif",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
                                  {analyzing ? <><Spinner size={12} color="#fff"/>Analizando con Gemini...</> : "🤖 Analizar con IA"}
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        )}

        {/* ── REGLAS (Fase 3 optimizador) ──────────────── */}
        {tab==="reglas"&&(
          <div>
            {!activeAccId ? (
              <div style={{background:T.yellowBg,border:`1px solid ${T.yellow}44`,borderRadius:12,padding:"22px 24px",fontSize:13,color:T.textMd}}>
                ⚠ Conectá tu cuenta de Meta primero desde Config.
              </div>
            ) : (
              <>
                <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"16px 20px",marginBottom:16,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
                  <div>
                    <div style={{fontSize:15,fontWeight:700,color:T.text}}>Reglas de optimización</div>
                    <div style={{fontSize:11,color:T.textSm,marginTop:2}}>Se auto-evalúan cada 6 hs mientras tengas Growith abierto. También podés disparar manualmente.</div>
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={evaluateRulesNow} disabled={evaluatingNow||rules.filter(r=>r.active).length===0} style={{padding:"8px 14px",fontSize:12,fontWeight:600,border:`1px solid ${T.border}`,borderRadius:8,background:"transparent",color:T.textMd,cursor:evaluatingNow?"wait":"pointer",fontFamily:"'Inter',system-ui,sans-serif",display:"flex",alignItems:"center",gap:6}}>
                      {evaluatingNow ? <><Spinner size={12} color={T.textMd}/>Evaluando...</> : "▶ Evaluar ahora"}
                    </button>
                    <button onClick={()=>setEditingRule("new")} style={{padding:"8px 14px",fontSize:12,fontWeight:700,border:"none",borderRadius:8,background:T.accentSolid,color:"#fff",cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>+ Nueva regla</button>
                  </div>
                </div>

                {/* Lista de reglas */}
                {rulesLoading && rules.length===0 ? (
                  <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"40px 20px",textAlign:"center"}}>
                    <Spinner size={18} color={T.accent}/>
                  </div>
                ) : rules.length===0 ? (
                  <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"50px 20px",textAlign:"center"}}>
                    <div style={{fontSize:32,marginBottom:8}}>⚡</div>
                    <div style={{fontSize:14,fontWeight:600,color:T.text,marginBottom:6}}>Sin reglas todavía</div>
                    <div style={{fontSize:12,color:T.textSm,maxWidth:420,margin:"0 auto"}}>Creá tu primera regla para que Growith pause automáticamente ads que cumplan ciertos criterios (gasto, ROAS, CPA, etc.).</div>
                  </div>
                ) : (
                  <div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:24}}>
                    {rules.map(r => {
                      const fmtVal = (m, v) => m==="spend"||m==="cpa"||m==="purchase_value"||m==="cpm"||m==="cpc"?`$${v}`:m==="ctr"?`${v}%`:m==="roas"?`${v}x`:v;
                      return (
                        <div key={r.id} style={{background:T.card,border:`1px solid ${r.active?T.green+"44":T.border}`,borderRadius:12,padding:"14px 18px"}}>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12,flexWrap:"wrap"}}>
                            <div style={{flex:1,minWidth:0}}>
                              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6,flexWrap:"wrap"}}>
                                <span style={{fontSize:14,fontWeight:700,color:T.text}}>{r.name}</span>
                                <span style={{fontSize:9,padding:"2px 8px",borderRadius:4,background:r.active?T.green+"22":T.textSm+"22",color:r.active?T.green:T.textSm,fontWeight:700,letterSpacing:0.4,textTransform:"uppercase"}}>{r.active?"Activa":"Pausada"}</span>
                                <span style={{fontSize:10,color:T.textSm}}>· {r.level==="campaign"?"Campañas":r.level==="adset"?"Adsets":"Ads"} · {r.action==="pause"?"⏸ Pausar":"📢 Notificar"}</span>
                              </div>
                              <div style={{fontSize:11,color:T.textMd,lineHeight:1.6}}>
                                <strong>{r.logic==="AND"?"Si TODAS estas condiciones son ciertas":"Si AL MENOS UNA condición es cierta"}:</strong>
                                <ul style={{margin:"4px 0 0",paddingLeft:18}}>
                                  {(r.conditions||[]).map((c,i)=>(
                                    <li key={i}><code style={{background:T.surface,padding:"1px 5px",borderRadius:3,color:T.accent,fontFamily:"monospace",fontSize:11}}>{c.metric}</code> {c.op} {fmtVal(c.metric,c.value)} <span style={{color:T.textSm}}>(últimos {c.window_days||7}d)</span></li>
                                  ))}
                                </ul>
                              </div>
                              {r.last_evaluated_at && <div style={{fontSize:10,color:T.textSm,marginTop:6}}>Última eval: {new Date(r.last_evaluated_at).toLocaleString("es-AR")}</div>}
                            </div>
                            <div style={{display:"flex",flexDirection:"column",gap:6,flexShrink:0}}>
                              <button onClick={()=>toggleRuleActive(r)} style={{padding:"5px 10px",fontSize:11,border:`1px solid ${T.border}`,borderRadius:6,background:"transparent",color:T.textMd,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>{r.active?"Pausar":"Activar"}</button>
                              <button onClick={()=>setEditingRule(r)} style={{padding:"5px 10px",fontSize:11,border:`1px solid ${T.border}`,borderRadius:6,background:"transparent",color:T.textMd,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>Editar</button>
                              <button onClick={()=>deleteRule(r.id)} style={{padding:"5px 10px",fontSize:11,border:`1px solid ${T.red}33`,borderRadius:6,background:"transparent",color:T.red,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>Borrar</button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Log de acciones */}
                {ruleLog.length > 0 && (
                  <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"16px 20px"}}>
                    <div style={{fontSize:13,fontWeight:700,color:T.text,marginBottom:10}}>Historial de acciones <span style={{fontSize:11,color:T.textSm,fontWeight:400}}>· {ruleLog.length} eventos</span></div>
                    <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:420,overflowY:"auto"}}>
                      {ruleLog.map(ev => (
                        <div key={ev.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",background:T.bg,borderRadius:8,border:`1px solid ${T.borderL}`,fontSize:11}}>
                          <span style={{fontSize:14}}>{ev.ok?(ev.action_taken==="pause"?"⏸":"📢"):"❌"}</span>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{color:T.text,fontWeight:600,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{ev.node_name||"(sin nombre)"} <span style={{color:T.textSm,fontWeight:400}}>· {ev.rule_name}</span></div>
                            <div style={{color:T.textSm,marginTop:2}}>{(ev.triggered||[]).map((t,i)=><span key={i}>{i>0?" · ":""}<code style={{background:T.surface,padding:"0 4px",borderRadius:2,color:T.accent}}>{t.metric}={Number(t.actual).toFixed(2)}</code></span>)}</div>
                          </div>
                          <span style={{fontSize:10,color:T.textSm,whiteSpace:"nowrap"}}>{new Date(ev.ts).toLocaleString("es-AR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Tip: cron 24/7 sin Growith abierto */}
                <details style={{marginTop:16,background:T.card,border:`1px solid ${T.border}`,borderRadius:12}}>
                  <summary style={{cursor:"pointer",padding:"12px 16px",fontSize:12,fontWeight:600,color:T.text,listStyle:"none"}}>
                    ⏰ ¿Querés que las reglas se evalúen aunque no abras Growith?
                  </summary>
                  <div style={{padding:"0 16px 16px",fontSize:12,color:T.textMd,lineHeight:1.7}}>
                    Hoy las reglas se evalúan automáticamente <strong style={{color:T.text}}>cada 6 horas cuando entrás a Meta Ads</strong> en Growith. Si querés que corran 24/7 sin tener que abrir la app, configurá un cron externo gratis:
                    <ol style={{margin:"10px 0",paddingLeft:18}}>
                      <li>Andá a <a href="https://cron-job.org" target="_blank" rel="noopener" style={{color:T.accent,textDecoration:"underline"}}>cron-job.org</a> y crea una cuenta gratis</li>
                      <li>Click en <strong style={{color:T.text}}>"Create cronjob"</strong></li>
                      <li>URL: <code style={{background:T.surface,padding:"2px 6px",borderRadius:4,fontSize:11,color:T.accent,wordBreak:"break-all"}}>{`https://www.growithapp.com/api/meta?action=evaluate_rules&uid=${uid}&acc_id=${activeAccId||"TU_ACC_ID"}`}</code></li>
                      <li>Schedule: cada 6 horas (o lo que prefieras)</li>
                      <li>Method: <strong style={{color:T.text}}>POST</strong></li>
                      <li>Guardar</li>
                    </ol>
                    <div style={{padding:"10px 12px",background:T.greenBg,border:`1px solid ${T.green}33`,borderRadius:8,fontSize:11}}>
                      ✓ Listo. Cron-job.org va a llamar a Growith en el schedule que pongas y disparar la evaluación automática. <strong style={{color:T.green}}>Sin tocar Vercel ni nada</strong>.
                    </div>
                  </div>
                </details>

                {/* Editor de regla (modal) */}
                {editingRule && <RuleEditor T={T} initialRule={editingRule==="new"?null:editingRule} onSave={saveRule} onCancel={()=>setEditingRule(null)}/>}
              </>
            )}
          </div>
        )}

        {/* ── CUENTA ──────────────────────────────────── */}
        {tab==="cuenta"&&(
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20,alignItems:"start"}}>
            <div>
              {/* Cuentas conectadas */}
              <div style={Card}>
                <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.6,marginBottom:14}}>Cuentas conectadas</div>
                {accounts.length===0?(
                  <div style={{textAlign:"center",padding:"24px 0",color:T.textSm,fontSize:13}}>No hay cuentas. Conectá una abajo.</div>
                ):accounts.map(a=>(
                  <div key={a.id} onClick={()=>{setActiveAccId(a.id);metaApi("set_active","POST",{id:a.id});}}
                    style={{background:activeAccId===a.id?T.accentSolid+"12":T.surface,border:`1px solid ${activeAccId===a.id?T.accentSolid+"55":T.border}`,borderRadius:10,padding:"12px 14px",marginBottom:8,cursor:"pointer",transition:"all 0.15s"}}>
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      <div style={{width:32,height:32,borderRadius:8,background:T.blueBg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>📘</div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:13,fontWeight:600,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{a.user_name||"Cuenta Meta"}</div>
                        <div style={{fontSize:11,color:T.textSm,marginTop:2}}>{a.ad_account_name||"Sin ad account"}{a.ig_username?` · @${a.ig_username}`:""}</div>
                        <div style={{fontSize:10,color:T.green,marginTop:2}}>✓ System User Token · No vence</div>
                      </div>
                      {activeAccId===a.id&&<span style={{fontSize:10,background:T.accentSolid,color:"#fff",borderRadius:4,padding:"2px 7px",fontWeight:600,flexShrink:0}}>ACTIVA</span>}
                      <button onClick={e=>{e.stopPropagation();handleDisconnect(a.id);}} style={{...BtnSec,padding:"4px 8px",fontSize:11,color:T.red,borderColor:T.red+"44",flexShrink:0}}>✕</button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Selector post-conexión si tiene múltiples */}
              {connectData&&(
                <div style={{...Card,border:`1px solid ${T.accentSolid}55`}}>
                  <div style={{fontSize:12,fontWeight:700,color:T.text,marginBottom:14}}>✓ Token válido — {connectData.user_name} · Elegí tu ad account y página</div>
                  <label style={Label}>Ad Account</label>
                  <select value={selAdAcc} onChange={e=>setSelAdAcc(e.target.value)} style={{...iS,marginBottom:12}}>
                    <option value="">— Seleccioná —</option>
                    {(connectData.ad_accounts||[]).map(a=><option key={a.id} value={a.id}>{a.name||a.id} ({a.id})</option>)}
                  </select>
                  {(connectData.pages||[]).length>0&&(
                    <>
                      <label style={Label}>Página de Facebook</label>
                      <select value={selPage} onChange={e=>setSelPage(e.target.value)} style={{...iS,marginBottom:14}}>
                        <option value="">— Opcional —</option>
                        {(connectData.pages||[]).map(p=><option key={p.id} value={p.id}>{p.name}{p.instagram_business_account?` · IG @${p.instagram_business_account.username}`:""}</option>)}
                      </select>
                    </>
                  )}
                  <button onClick={handleSaveSetup} disabled={savingSetup} style={{...BtnPri,width:"100%",justifyContent:"center"}}>
                    {savingSetup?<><Spinner size={13} color="#fff"/>Guardando...</>:"Guardar configuración"}
                  </button>
                </div>
              )}

              {/* Form conectar */}
              {!connectData&&(
                <div style={Card}>
                  <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.6,marginBottom:10}}>
                    {accounts.length>0?"Agregar otra cuenta":"Conectar cuenta Meta"}
                  </div>

                  {/* Botón mostrar/ocultar guía */}
                  <button onClick={()=>setShowGuide(s=>!s)} style={{...BtnSec,marginBottom:12,width:"100%",justifyContent:"center",fontSize:12}}>
                    {showGuide?"▲ Ocultar guía":"❓ ¿Cómo obtengo el token?"}
                  </button>
                  {showGuide&&<GuiaToken/>}

                  <label style={Label}>System User Token</label>
                  <textarea
                    value={tokenInput}
                    onChange={e=>setTokenInput(e.target.value)}
                    placeholder="Pegá tu System User Token acá..."
                    style={{...iS,minHeight:80,resize:"none",fontFamily:"monospace",fontSize:11,marginBottom:12,lineHeight:1.5}}
                  />
                  <button onClick={handleConnect} disabled={connecting||!tokenInput.trim()} style={{...BtnPri,width:"100%",justifyContent:"center"}}>
                    {connecting?<><Spinner size={13} color="#fff"/>Verificando...</>:"Conectar cuenta →"}
                  </button>
                </div>
              )}
            </div>

            {/* Brand context */}
            <div style={Card}>
              <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.6,marginBottom:6}}>Contexto de marca</div>
              <div style={{fontSize:12,color:T.textSm,marginBottom:12,lineHeight:1.5}}>La IA usa esta info para generar el copy. Producto, beneficios, target, precio, URL de destino.</div>
              <textarea value={brand} onChange={e=>setBrand(e.target.value)}
                placeholder="Ej: Vendemos anteojos con filtro de luz azul. Colores: Rojo, Naranja, Amarillo. Target: 30-60 años con pantallas. Precio: $25.000. Link: mitienda.com"
                style={{...iS,minHeight:200,resize:"vertical",lineHeight:1.6,marginBottom:12}}/>
              <button onClick={handleSaveBrand} disabled={brandSaving} style={{...BtnSec,width:"100%",justifyContent:"center"}}>
                {brandSaving?<><Spinner size={12} color={T.textMd}/>Guardando...</>:"Guardar brand context"}
              </button>
            </div>
          </div>
        )}

        {/* ── CAMPAÑAS ────────────────────────────────── */}
        {tab==="campanas"&&(
          !activeAcc
          ?<div style={{textAlign:"center",padding:60,color:T.textSm}}>Conectá una cuenta Meta primero en la pestaña Cuenta</div>
          :<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
            {/* Campañas */}
            <div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
                <div style={{fontSize:13,fontWeight:700,color:T.text}}>Campañas ({campaigns.length})</div>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={loadCampaigns} disabled={campsLoading} style={{...BtnSec,padding:"6px 10px"}}>↻</button>
                  <button onClick={()=>setShowNewCamp(s=>!s)} style={{...BtnSec,fontSize:12,padding:"6px 12px"}}>+ Nueva</button>
                </div>
              </div>
              {showNewCamp&&(
                <div style={{...Card,border:`1px solid ${T.accentSolid}44`}}>
                  <input value={newCamp.name} onChange={e=>setNewCamp(p=>({...p,name:e.target.value}))} placeholder="Nombre campaña" style={{...iS,marginBottom:10}}/>
                  <select value={newCamp.objective} onChange={e=>setNewCamp(p=>({...p,objective:e.target.value}))} style={{...iS,marginBottom:10}}>
                    {OBJECTIVES.map(o=><option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,cursor:"pointer"}} onClick={()=>setNewCamp(p=>({...p,is_cbo:!p.is_cbo}))}>
                    <div className="gh-toggle" style={{width:34,height:18,borderRadius:9,background:newCamp.is_cbo?T.accentSolid:T.border,position:"relative",flexShrink:0}}>
                      <div className="gh-toggle-thumb" style={{width:14,height:14,borderRadius:"50%",background:"#fff",position:"absolute",top:2,left:newCamp.is_cbo?18:2}}/>
                    </div>
                    <span style={{fontSize:12,color:T.text}}>CBO</span>
                    {newCamp.is_cbo&&<input onClick={e=>e.stopPropagation()} value={newCamp.cbo_daily_budget_ars} onChange={e=>setNewCamp(p=>({...p,cbo_daily_budget_ars:e.target.value}))} placeholder="Budget diario ARS" style={{...iS,width:160}}/>}
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={handleCreateCampaign} disabled={campCreating} style={{...BtnPri,flex:1,justifyContent:"center"}}>{campCreating?<><Spinner size={12} color="#fff"/>Creando...</>:"Crear campaña"}</button>
                    <button onClick={()=>setShowNewCamp(false)} style={{...BtnSec,padding:"9px 14px"}}>✕</button>
                  </div>
                </div>
              )}
              {campsLoading?<div style={{textAlign:"center",padding:40}}><Spinner size={24} color={T.accent}/></div>
              :campaigns.length===0?<div style={{textAlign:"center",padding:32,color:T.textSm,fontSize:13}}>No hay campañas</div>
              :campaigns.map(c=>(
                <div key={c.id} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:"11px 14px",marginBottom:8}}>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:13,fontWeight:600,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.name}</div>
                      <div style={{fontSize:11,color:T.textSm}}>{OBJECTIVES.find(o=>o.id===c.objective)?.label||c.objective}{c.daily_budget?` · $${Math.round(c.daily_budget/100).toLocaleString("es-AR")}/día`:""}</div>
                    </div>
                    <span style={{fontSize:10,padding:"2px 7px",borderRadius:4,fontWeight:600,background:c.effective_status==="ACTIVE"?T.greenBg:T.surface,color:c.effective_status==="ACTIVE"?T.green:T.textSm,border:`1px solid ${c.effective_status==="ACTIVE"?T.green+"33":T.border}`,flexShrink:0}}>{c.effective_status||c.status}</span>
                  </div>
                </div>
              ))}
            </div>
            {/* AdSets */}
            <div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
                <div style={{fontSize:13,fontWeight:700,color:T.text}}>AdSets ({adsets.length})</div>
                <button onClick={()=>setShowNewAdset(s=>!s)} style={{...BtnSec,fontSize:12,padding:"6px 12px"}}>+ Nuevo</button>
              </div>
              {showNewAdset&&(
                <div style={{...Card,border:`1px solid ${T.accentSolid}44`}}>
                  <select value={newAdset.campaign_id} onChange={e=>setNewAdset(p=>({...p,campaign_id:e.target.value}))} style={{...iS,marginBottom:10}}>
                    <option value="">— Campaña —</option>
                    {campaigns.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <input value={newAdset.name} onChange={e=>setNewAdset(p=>({...p,name:e.target.value}))} placeholder="Nombre AdSet" style={{...iS,marginBottom:10}}/>
                  <input value={newAdset.daily_budget_ars} onChange={e=>setNewAdset(p=>({...p,daily_budget_ars:e.target.value}))} placeholder="Presupuesto diario ARS" style={{...iS,marginBottom:10}}/>
                  <input type="datetime-local" value={newAdset.start_time} onChange={e=>setNewAdset(p=>({...p,start_time:e.target.value}))} style={{...iS,marginBottom:12}}/>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={handleCreateAdset} disabled={adsetCreating} style={{...BtnPri,flex:1,justifyContent:"center"}}>{adsetCreating?<><Spinner size={12} color="#fff"/>Creando...</>:"Crear AdSet"}</button>
                    <button onClick={()=>setShowNewAdset(false)} style={{...BtnSec,padding:"9px 14px"}}>✕</button>
                  </div>
                </div>
              )}
              {adsets.length===0?<div style={{textAlign:"center",padding:32,color:T.textSm,fontSize:13}}>No hay adsets</div>
              :adsets.map(a=>{
                const camp=campaigns.find(c=>c.id===a.campaign_id);
                return(
                  <div key={a.id} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:"11px 14px",marginBottom:8}}>
                    <div style={{fontSize:13,fontWeight:600,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{a.name}</div>
                    <div style={{fontSize:11,color:T.textSm,marginTop:2}}>{camp?.name||a.campaign_id} · {a.effective_status||a.status}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── CREATIVOS ────────────────────────────────── */}
        {tab==="creativos"&&(
          !activeAcc
          ?<div style={{textAlign:"center",padding:60,color:T.textSm}}>Conectá una cuenta Meta primero</div>
          :<div style={{display:"grid",gridTemplateColumns:"1fr 380px",gap:20,alignItems:"start"}}>
            <div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
                <div style={{fontSize:13,fontWeight:700,color:T.text}}>Creativos ({creatives.length})</div>
                <button onClick={()=>setAddingUrl(s=>!s)} style={{...BtnSec,fontSize:12,padding:"6px 12px"}}>+ Agregar por URL</button>
              </div>
              {addingUrl&&(
                <div style={{...Card,border:`1px solid ${T.accentSolid}44`}}>
                  <input value={newCUrl} onChange={e=>setNewCUrl(e.target.value)} placeholder="URL pública del archivo" style={{...iS,marginBottom:10}}/>
                  <input value={newCName} onChange={e=>setNewCName(e.target.value)} placeholder="Nombre (ej: reel_dolor.mp4)" style={{...iS,marginBottom:10}}/>
                  <select value={newCKind} onChange={e=>setNewCKind(e.target.value)} style={{...iS,marginBottom:12}}>
                    <option value="image">Imagen</option>
                    <option value="video">Video</option>
                  </select>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={handleAddCreative} style={{...BtnPri,flex:1,justifyContent:"center"}}>Agregar</button>
                    <button onClick={()=>setAddingUrl(false)} style={{...BtnSec,padding:"9px 14px"}}>✕</button>
                  </div>
                </div>
              )}
              {creativesLoading?<div style={{textAlign:"center",padding:40}}><Spinner size={24} color={T.accent}/></div>
              :creatives.length===0?<div style={{textAlign:"center",padding:40,color:T.textSm,fontSize:13}}>No hay creativos. Agregá uno con URL pública.</div>
              :creatives.map(c=>(
                <div key={c.id} onClick={()=>setSelCreative(selCreative?.id===c.id?null:c)}
                  style={{background:selCreative?.id===c.id?T.accentSolid+"12":T.card,border:`1px solid ${selCreative?.id===c.id?T.accentSolid+"55":T.border}`,borderRadius:10,padding:"12px 14px",marginBottom:8,cursor:"pointer",transition:"all 0.15s"}}>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <span style={{fontSize:20,flexShrink:0}}>{c.kind==="video"?"🎬":"🖼️"}</span>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:13,fontWeight:600,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.filename}</div>
                      <div style={{fontSize:11,color:T.textSm,marginTop:2}}>
                        {c.ia_status==="ok"?<span style={{color:T.green}}>✓ Copy listo</span>:<span>Sin copy</span>}
                        {c.adset_id?<span style={{color:T.blue,marginLeft:8}}>· AdSet ✓</span>:""}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {selCreative&&(
              <div style={{...Card,position:"sticky",top:80}}>
                <div style={{fontSize:11,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.6,marginBottom:14}}>{selCreative.filename_base}</div>
                {[{label:"Tono",key:"tone",opts:TONOS},{label:"Largo",key:"length",opts:LARGOS},{label:"Formato",key:"format",opts:FORMATOS}].map(({label,key,opts})=>(
                  <div key={key} style={{marginBottom:10}}>
                    <label style={Label}>{label}</label>
                    <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                      {opts.map(o=>(
                        <button key={o} onClick={()=>{const u={...selCreative,[key]:o};setSelCreative(u);handlePatch(selCreative,{[key]:o});}}
                          style={{padding:"4px 10px",fontSize:11,borderRadius:6,border:`1px solid ${selCreative[key]===o?T.accentSolid+"88":T.border}`,background:selCreative[key]===o?T.accentSolid+"18":"transparent",color:selCreative[key]===o?T.accent:T.textMd,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif"}}>
                          {o}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                <label style={Label}>Notas para la IA</label>
                <textarea value={selCreative.notes||""} onChange={e=>setSelCreative(p=>({...p,notes:e.target.value}))} onBlur={()=>handlePatch(selCreative,{notes:selCreative.notes})} placeholder="Indicaciones extras..." style={{...iS,minHeight:60,resize:"vertical",marginBottom:12}}/>
                <button onClick={()=>handleGenerateCopy(selCreative)} disabled={!!generatingCopy} style={{...BtnPri,width:"100%",justifyContent:"center",marginBottom:14}}>
                  {generatingCopy===selCreative.id?<><Spinner size={13} color="#fff"/>Generando...</>:"✨ Generar copy con Gemini"}
                </button>
                {selCreative.copy&&(
                  <>
                    <label style={Label}>Copy</label>
                    <textarea value={selCreative.copy} onChange={e=>{const u={...selCreative,copy:e.target.value};setSelCreative(u);}} onBlur={()=>handlePatch(selCreative,{copy:selCreative.copy})} style={{...iS,minHeight:90,resize:"vertical",marginBottom:10}}/>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
                      <div>
                        <label style={Label}>Titular</label>
                        <input value={selCreative.title||""} onChange={e=>{const u={...selCreative,title:e.target.value};setSelCreative(u);}} onBlur={()=>handlePatch(selCreative,{title:selCreative.title})} style={iS}/>
                      </div>
                      <div>
                        <label style={Label}>Descripción</label>
                        <input value={selCreative.description||""} onChange={e=>{const u={...selCreative,description:e.target.value};setSelCreative(u);}} onBlur={()=>handlePatch(selCreative,{description:selCreative.description})} style={iS}/>
                      </div>
                    </div>
                    <label style={Label}>AdSet</label>
                    <select value={selCreative.adset_id||""} onChange={e=>{const u={...selCreative,adset_id:e.target.value};setSelCreative(u);handlePatch(selCreative,{adset_id:e.target.value});}} style={{...iS,marginBottom:10}}>
                      <option value="">— Elegí un AdSet —</option>
                      {adsets.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                    <label style={Label}>CTA</label>
                    <select value={selCreative.cta||"LEARN_MORE"} onChange={e=>{const u={...selCreative,cta:e.target.value};setSelCreative(u);handlePatch(selCreative,{cta:e.target.value});}} style={{...iS,marginBottom:14}}>
                      {CTAS.map(c=><option key={c} value={c}>{c}</option>)}
                    </select>
                    <button onClick={()=>handlePublish(selCreative)} disabled={!!publishing} style={{...BtnPri,width:"100%",justifyContent:"center",background:"#16a34a"}}>
                      {publishing===selCreative.id?<><Spinner size={13} color="#fff"/>Publicando...</>:"🚀 Publicar en Meta (PAUSED)"}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}


// ROOT APP
// ===========================================
export default function App() {
  const [user,setUser]=useState(undefined); // undefined=loading, null=no auth, object=authed
  const [page,setPage]=useState("home");
  const [pendingCanje,setPendingCanje]=useState(null); // datos pre-cargados desde un pedido
  const [pendingCanjeDetail,setPendingCanjeDetail]=useState(null); // _docId a abrir directo
  const [orders,setOrders]=useState([]);
  const [ordersStatus,setOrdersStatus]=useState("idle");
  const [totalOrdersCount,setTotalOrdersCount]=useState(null);
  const [fbStatus,setFbStatus]=useState("connecting");
  const [reclamosCount,setReclamosCount]=useState(0);
  const [canjesCount,setCanjesCount]=useState(0);
  const [alertas,setAlertas]=useState([]);
  const [darkMode,setDarkMode]=useState(()=>{ try { return localStorage.getItem("growith_theme")!=="light"; } catch(e){ return true; } });
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
    try { localStorage.setItem("growith_theme", darkMode?"dark":"light"); } catch(e){}
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

  // Fetch orders on login - fetch empaquetar tab por defecto + total count
  useEffect(()=>{
    if(!user) return;
    try{ localStorage.removeItem(`growith_orders_${user.uid}`); localStorage.removeItem("growith_orders_v3"); }catch(e){}
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
        try{ localStorage.removeItem(`growith_orders_${user.uid}`); }catch(e){}
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

  // Loading
  if(user===undefined) return (
    <div style={{fontFamily:"'Inter',system-ui,sans-serif",background:T.bg,minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{textAlign:"center"}}>
        <div style={{width:32,height:32,borderRadius:8,background:T.accentSolid,margin:"0 auto 16px",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>🌙</div>
        <div style={{fontSize:14,color:T.textSm}}>Cargando...</div>
      </div>
    </div>
  );

  // Not logged in
  if(!user) return <AuthScreen T={T} darkMode={darkMode} onToggleDark={()=>setDarkMode(d=>!d)}/>;

  // Config
  if(page==="planes") return <AppPlanes T={T} user={user} userPlan={userPlan} planExpiry={planExpiry} onBack={()=>setPage("home")} USDT_ADDRESS={USDT_ADDRESS} SUPPORT_EMAIL={SUPPORT_EMAIL}/>;
  if(page==="admin"&&isAdmin) return <AppAdmin T={T} user={user} onBack={()=>setPage("home")}/>;
  if(page==="config") return <ConfigScreen T={T} user={user} onBack={()=>setPage("home")} darkMode={darkMode} onToggleDark={()=>setDarkMode(d=>!d)}/>;

  // App
  if(page==="arca") return <PageView pageKey="arca"><AppArca T={T} user={user} onHome={()=>setPage("home")}/><ToastContainer T={T}/></PageView>;
  if(page==="meta") return <PageView pageKey="meta"><AppMetaAds T={T} user={user} onHome={()=>setPage("home")}/><ToastContainer T={T}/></PageView>;
  if(page==="audio") return <PageView pageKey="audio"><AppAudioStudio T={T} user={user} onHome={()=>setPage("home")}/><ToastContainer T={T}/></PageView>;
  if(page==="reclamos") return <PageView pageKey="reclamos"><AppReclamos T={T} orders={orders} ordersStatus={ordersStatus} fetchOrders={fetchOrders} fbStatus={fbStatus} user={user} onHome={()=>setPage("home")} totalOrdersCount={totalOrdersCount} onGenerarCanje={(datos)=>{setPendingCanje(datos);setPage("canjes");}}/><ToastContainer T={T}/></PageView>;
  if(page==="canjes") return <PageView pageKey="canjes"><AppCanjes T={T} fbStatus={fbStatus} user={user} onHome={()=>setPage("home")} pendingCanje={pendingCanje} onClearPendingCanje={()=>setPendingCanje(null)} initialDetail={pendingCanjeDetail} onClearInitialDetail={()=>setPendingCanjeDetail(null)}/><ToastContainer T={T}/></PageView>;
  if(page==="envios") return <PageView pageKey="envios"><AppEnvios T={T} orders={orders} ordersStatus={ordersStatus} fetchOrders={(tab)=>fetchOrders(user?.uid,tab)} user={user} onHome={()=>setPage("home")} onGenerarCanje={(datos)=>{setPendingCanje(datos);setPage("canjes");}}/><ToastContainer T={T}/></PageView>;
  return <HomeScreen T={T} onNavigate={(page, docId)=>{
    if(page==="canjes"&&docId){ setPendingCanjeDetail(docId); }
    setPage(page);
  }} fbStatus={fbStatus} ordersCount={totalOrdersCount??orders.length} reclamosCount={reclamosCount} canjesCount={canjesCount} alertas={alertas} user={user} userPlan={userPlan} planExpiry={planExpiry} isAdmin={isAdmin} darkMode={darkMode} onToggleDark={()=>setDarkMode(d=>!d)}/>;
}
