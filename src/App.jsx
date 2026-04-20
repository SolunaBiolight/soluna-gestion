import { useState, useEffect, useMemo, useRef } from "react";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from "firebase/firestore";

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
const ESTADOS_R = ["Pendiente","En proceso","Resuelto","Rechazado"];
const TIPOS_R = ["Cambio","Devolución"];
const PRODUCTOS = ["Amarillo - Marco Negro","Amarillo - M. Transparente","Naranja - Marco Negro","Naranja - M. Transparente","Rojo - Marco Negro","Rojo - M. Transparente","Clip-On","Líquido Limpia Cristales"];
const SKU_LENTE = { "AMARILLO-NN":"Amarillo","AMARILLO-TT":"Amarillo","NARAN-NN":"Naranja","NARAN-TT":"Naranja","ROJ-NN":"Rojo","ROJ-TT":"Rojo","N-N":"Negro","N-R":"Negro/Rojo","R-R":"Rojo/Rojo","CLIP-ON":"Clip-On","LIQ":"Líquido" };
const LENTE_DOT = { Amarillo:"#fbbf24",Naranja:"#fb923c",Rojo:"#f87171",Negro:"#a1a1aa","Clip-On":"#c084fc",Líquido:"#60a5fa" };
const ESTADOS_C = ["Pendiente envío","Enviado","Contenido pendiente","Contenido publicado","Finalizado","Cancelado"];
const REDES = ["Instagram","TikTok","YouTube","Twitter/X","Otro"];
const ACTIVIDADES = ["Story","Post feed","Reel","Video","TikTok","Live","Link en bio","Review","UGC/Pauta"];
const PRODUCTOS_CANJE = ["Amarillo - Marco Negro","Amarillo - M. Transparente","Naranja - Marco Negro","Naranja - M. Transparente","Rojo - Marco Negro","Rojo - M. Transparente","Clip-On","Kit Completo","A elección"];

// ─── Helpers ───
function fmtMoney(v) { const n=parseFloat(v); if(isNaN(n)) return '—'; return '$'+n.toLocaleString('es-AR',{minimumFractionDigits:0,maximumFractionDigits:0}); }
function fmtDate(d) { if(!d) return '—'; const p=d.split(' ')[0].split('/'); if(p.length===3) return `${p[0]}/${p[1]}/${p[2]}`; return d; }
function fmtTs(ts) { if(!ts?.seconds) return '—'; return new Date(ts.seconds*1000).toLocaleDateString('es-AR'); }
function fullAddress(o) { let a=o.direccion||''; if(o.dirNumero) a+=' '+o.dirNumero; if(o.piso) a+=', Piso '+o.piso; return [a,o.localidad,o.ciudad,o.cp?`CP ${o.cp}`:'',o.provincia].filter(Boolean).join(', '); }
function getLensColors(productos) { const s=new Set(); for(const p of productos){const c=SKU_LENTE[p.sku];if(c)s.add(c);} return [...s]; }
function mapEstadoEnvio(s) { return {"unpacked":"No está empaquetado","ready_to_ship":"Listo para enviar","shipped":"Enviado","delivered":"Entregado"}[s]||s||'—'; }
function mapEstadoPago(s) { return {"pending":"Pendiente","paid":"Pagado","voided":"Anulado","refunded":"Reembolsado","abandoned":"Abandonado"}[s]||s||'—'; }

function getEstadoEnvioC(T, estado) {
  const m = {
    "No está empaquetado":{ dot:T.yellow, bg:T.yellowBg, text:T.yellow },
    "Listo para enviar":  { dot:T.blue,   bg:T.blueBg,   text:T.blue   },
    "Enviado":            { dot:T.purple, bg:T.purpleBg, text:T.purple },
    "Entregado":          { dot:T.green,  bg:T.greenBg,  text:T.green  },
  };
  return m[estado] || { dot:T.textSm, bg:T.borderL, text:T.textSm };
}
function getEstadoRC(T, estado) {
  const m = {
    Pendiente:    { dot:T.blue,   bg:T.blueBg,   text:T.blue   },
    "En proceso": { dot:T.yellow, bg:T.yellowBg, text:T.yellow },
    Resuelto:     { dot:T.green,  bg:T.greenBg,  text:T.green  },
    Rechazado:    { dot:T.red,    bg:T.redBg,    text:T.red    },
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
    return {
      numero:String(o.number||o.id),
      fecha:o.created_at?new Date(o.created_at).toLocaleDateString('es-AR'):'',
      comprador:`${sh.name||''} ${sh.last_name||''}`.trim()||o.contact_name||'',
      email:o.contact_email||'', telefono:o.contact_phone||'', dni:o.contact_identification||'',
      estadoOrden:o.status||'', estadoPago:mapEstadoPago(o.payment_status),
      estadoEnvio:mapEstadoEnvio(o.shipping_status),
      total:String(o.total||''), subtotal:String(o.subtotal||''), descuento:String(o.discount||'0'),
      costoEnvio:String(o.shipping_cost_customer||'0'),
      nombreEnvio:`${sh.name||''} ${sh.last_name||''}`.trim(),
      telEnvio:o.contact_phone||'', direccion:sh.address||'', dirNumero:sh.number||'',
      piso:sh.floor||'', localidad:sh.locality||'', ciudad:sh.city||'',
      cp:sh.zipcode||'', provincia:sh.province||'',
      medioEnvio:o.shipping_option||'', medioPago:o.payment_details?.method||o.gateway_name||'',
      canal:o.storefront||'', tracking:o.shipping_tracking_number||'',
      linkOrden:`https://solunabiolight2.mitiendanube.com/admin/orders/${o.id}`,
      fechaPago:o.paid_at||'', fechaEnvio:o.shipped_at||'',
      productos:(o.products||[]).map(p=>({nombre:p.name||'',precio:String(p.price||''),cantidad:String(p.quantity||'1'),sku:p.sku||''})),
    };
  }).sort((a,b)=>parseInt(b.numero)-parseInt(a.numero));
}

// ─── UI Components ───
function Badge({T, colors, children, small}) {
  return (
    <span style={{
      display:"inline-flex", alignItems:"center", gap:6,
      padding: small ? "3px 8px" : "4px 10px",
      borderRadius:20, fontSize: small ? 11 : 12, fontWeight:600,
      background:colors.bg, color:colors.text,
      border:`1px solid ${colors.dot}33`,
      whiteSpace:"nowrap",
    }}>
      <span style={{width:6,height:6,borderRadius:"50%",background:colors.dot,flexShrink:0}}/>
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

function Modal({T, open, onClose, title, width, children}) {
  if(!open) return null;
  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:16}}>
      <div onClick={e=>e.stopPropagation()} style={{background:T.card,borderRadius:16,width:"100%",maxWidth:width||560,maxHeight:"92vh",overflow:"visible",boxShadow:"0 24px 64px rgba(0,0,0,0.4)",border:`1px solid ${T.border}`,display:"flex",flexDirection:"column"}}>
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
    <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"20px 22px",flex:"1 1 120px",minWidth:120}}>
      <div style={{fontSize:32,fontWeight:800,color,letterSpacing:-1,lineHeight:1}}>{value}</div>
      <div style={{fontSize:13,color:T.textMd,marginTop:6,fontWeight:500}}>{label}</div>
      {sub&&<div style={{fontSize:11,color:T.textSm,marginTop:2}}>{sub}</div>}
    </div>
  );
}

function InputStyle(T) {
  return {
    width:"100%", padding:"11px 14px", borderRadius:10,
    border:`1.5px solid ${T.inputBorder}`, fontSize:14,
    fontFamily:"'Inter',system-ui,sans-serif",
    outline:"none", boxSizing:"border-box",
    background:T.input, color:T.text,
    transition:"border-color 0.15s",
  };
}

function BtnPrimary(T) { return {border:"none",borderRadius:10,padding:"11px 20px",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",transition:"all 0.15s",display:"inline-flex",alignItems:"center",gap:7,background:T.accentSolid,color:"#fff"}; }
function BtnSecondary(T) { return {border:`1.5px solid ${T.border}`,borderRadius:10,padding:"10px 18px",fontSize:14,fontWeight:500,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",transition:"all 0.15s",display:"inline-flex",alignItems:"center",gap:7,background:T.card,color:T.text}; }
function BtnDanger(T) { return {border:`1.5px solid ${T.red}44`,borderRadius:10,padding:"10px 18px",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",transition:"all 0.15s",display:"inline-flex",alignItems:"center",gap:7,background:T.redBg,color:T.red}; }
function BtnPurple(T) { return {border:`1.5px solid ${T.purple}44`,borderRadius:10,padding:"10px 18px",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",transition:"all 0.15s",display:"inline-flex",alignItems:"center",gap:7,background:T.purpleBg,color:T.purple}; }

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
        <div style={{marginTop:6,background:T.bg,border:`1.5px solid ${T.border}`,borderRadius:12,maxHeight:280,overflow:"auto"}}>
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
      {q.length>0&&results.length===0&&<div style={{marginTop:6,padding:14,textAlign:"center",color:T.textSm,fontSize:14,border:`1.5px solid ${T.border}`,borderRadius:12}}>Sin resultados para "{q}"</div>}
    </div>
  );
}

// ═══════════════════════════════════════════
// APP RECLAMOS
// ═══════════════════════════════════════════
function AppReclamos({T, orders, ordersStatus, fetchOrders, fbStatus, onHome}) {
  const [reclamos,setReclamos]=useState([]);
  const [tab,setTab]=useState("pedidos");
  const [search,setSearch]=useState("");
  const [filterEnvio,setFilterEnvio]=useState("");
  const [filterReclamo,setFilterReclamo]=useState("");
  const [selectedOrder,setSelectedOrder]=useState(null);
  const [actionModal,setActionModal]=useState(null);
  const [reclamoForm,setReclamoForm]=useState(null);
  const [reclamoDetail,setReclamoDetail]=useState(null);
  const [deleteConfirm,setDeleteConfirm]=useState(null);
  const [saving,setSaving]=useState(false);
  const iS=InputStyle(T);

  useEffect(()=>{
    const unsub=onSnapshot(collection(db,"reclamos"),snap=>{
      const data=snap.docs.map(d=>({...d.data(),_docId:d.id}));
      data.sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
      setReclamos(data);
    },()=>{});
    return ()=>unsub();
  },[]);

  const emptyForm=(orderNum="")=>({_docId:null,orderNum,tipo:"Cambio",motivo:"",descripcion:"",estado:"Pendiente",resolucion:"",notas:"",productosRecibe:[{producto:"",cantidad:1}],productosEnvia:[{producto:"",cantidad:1}]});

  async function saveReclamo() {
    if(!reclamoForm?.motivo||!reclamoForm?.orderNum) return;
    setSaving(true);
    try {
      const p={orderNum:reclamoForm.orderNum,tipo:reclamoForm.tipo,motivo:reclamoForm.motivo,descripcion:reclamoForm.descripcion||"",estado:reclamoForm.estado,resolucion:reclamoForm.resolucion||"",notas:reclamoForm.notas||"",productosRecibe:reclamoForm.productosRecibe||[],productosEnvia:reclamoForm.productosEnvia||[]};
      if(reclamoForm._docId) {
        const prev=reclamos.find(r=>r._docId===reclamoForm._docId);
        await updateDoc(doc(db,"reclamos",reclamoForm._docId),{...p,updatedAt:serverTimestamp(),...(reclamoForm.estado==="Resuelto"&&prev?.estado!=="Resuelto"?{resolvedAt:serverTimestamp()}:{})});
      } else {
        await addDoc(collection(db,"reclamos"),{...p,createdAt:serverTimestamp(),updatedAt:serverTimestamp(),resolvedAt:null});
      }
      setReclamoForm(null);
    } catch(e){alert("Error al guardar.");}
    setSaving(false);
  }

  async function deleteReclamo(docId) {
    try{await deleteDoc(doc(db,"reclamos",docId));}catch(e){}
    setDeleteConfirm(null);setReclamoDetail(null);
  }

  const filteredOrders=useMemo(()=>orders.filter(o=>{
    if(filterEnvio&&o.estadoEnvio!==filterEnvio) return false;
    if(search){const s=search.toLowerCase();return o.numero.includes(s)||o.comprador.toLowerCase().includes(s)||o.email.toLowerCase().includes(s)||o.productos.some(p=>p.nombre.toLowerCase().includes(s));}
    return true;
  }),[orders,search,filterEnvio]);

  const filteredReclamos=useMemo(()=>reclamos.filter(r=>{
    if(filterReclamo&&r.estado!==filterReclamo) return false;
    if(search){const s=search.toLowerCase();const o=orders.find(o=>o.numero===r.orderNum);return r.orderNum.includes(s)||(o&&o.comprador.toLowerCase().includes(s));}
    return true;
  }),[reclamos,search,filterReclamo,orders]);

  const stats={total:reclamos.length,pendientes:reclamos.filter(r=>r.estado==="Pendiente").length,enProceso:reclamos.filter(r=>r.estado==="En proceso").length,resueltos:reclamos.filter(r=>r.estado==="Resuelto").length,rechazados:reclamos.filter(r=>r.estado==="Rechazado").length};
  const selOrder=orders.find(o=>o.numero===selectedOrder);
  const detailR=reclamos.find(r=>r._docId===reclamoDetail);
  const fbDot={connecting:T.yellow,ok:T.green,error:T.red}[fbStatus];

  return (
    <div style={{fontFamily:"'Inter',system-ui,sans-serif",background:T.bg,minHeight:"100vh",color:T.text}}>
      {/* Topbar */}
      <div style={{borderBottom:`1px solid ${T.border}`,background:T.surface,padding:"0 28px",position:"sticky",top:0,zIndex:100}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",height:62,gap:16,maxWidth:1280,margin:"0 auto"}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <button onClick={onHome} style={{...BtnSecondary(T),padding:"8px 14px",fontSize:13}}>← Inicio</button>
            <span style={{color:T.textSm,fontSize:16}}>/</span>
            <span style={{fontWeight:700,fontSize:16,color:T.text}}>📋 Reclamos</span>
            <div style={{display:"flex",alignItems:"center",gap:5,background:T.card,border:`1px solid ${T.border}`,borderRadius:20,padding:"4px 10px"}}>
              <span style={{width:7,height:7,borderRadius:"50%",background:fbDot,boxShadow:`0 0 5px ${fbDot}`}}/>
              <span style={{fontSize:11,color:T.textSm,fontWeight:500}}>{fbStatus==="ok"?"en vivo":fbStatus==="error"?"sin conexión":"conectando"}</span>
            </div>
          </div>
          <div style={{display:"flex",gap:10}}>
            <button onClick={()=>setReclamoForm(emptyForm())} style={{...BtnDanger(T),fontSize:13}}>+ Nuevo Reclamo</button>
            <button onClick={fetchOrders} disabled={ordersStatus==="loading"} style={{...BtnSecondary(T),fontSize:13,opacity:ordersStatus==="loading"?0.5:1}}>
              {ordersStatus==="loading"?"⟳ Sincronizando...":"⟳ Sincronizar"}
            </button>
          </div>
        </div>
      </div>

      <div style={{maxWidth:1280,margin:"0 auto",padding:"0 28px"}}>
        {/* Stats */}
        <div style={{display:"flex",gap:10,flexWrap:"wrap",padding:"24px 0 0"}}>
          <StatCard T={T} label="Pedidos" value={orders.length} color={T.accent}/>
          <StatCard T={T} label="Reclamos" value={stats.total} color={T.textMd}/>
          <StatCard T={T} label="Pendientes" value={stats.pendientes} color={T.blue}/>
          <StatCard T={T} label="En proceso" value={stats.enProceso} color={T.yellow}/>
          <StatCard T={T} label="Resueltos" value={stats.resueltos} color={T.green}/>
          <StatCard T={T} label="Rechazados" value={stats.rechazados} color={T.red}/>
        </div>

        {/* Tabs */}
        <div style={{display:"flex",borderBottom:`1px solid ${T.border}`,marginTop:24}}>
          {[{id:"pedidos",label:"Pedidos",icon:"📦"},{id:"reclamos",label:"Reclamos",icon:"📋"}].map(t=>(
            <button key={t.id} onClick={()=>{setTab(t.id);setSearch("");setFilterEnvio("");setFilterReclamo("");}}
              style={{padding:"14px 22px",fontSize:15,fontWeight:tab===t.id?700:400,color:tab===t.id?T.text:T.textMd,background:"none",border:"none",borderBottom:tab===t.id?`2.5px solid ${T.accent}`:"2.5px solid transparent",cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",display:"flex",alignItems:"center",gap:7,marginBottom:-1,transition:"color 0.15s"}}>
              {t.icon} {t.label}
              {t.id==="reclamos"&&stats.pendientes>0&&<span style={{background:T.accentSolid,color:"#fff",fontSize:11,fontWeight:700,borderRadius:20,padding:"2px 8px"}}>{stats.pendientes}</span>}
            </button>
          ))}
        </div>

        {/* Filters */}
        <div style={{padding:"14px 0 8px",display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
          <div style={{position:"relative",flex:"1 1 260px",minWidth:220}}>
            <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",color:T.textSm,fontSize:14}}>🔍</span>
            <input placeholder="Buscar..." value={search} onChange={e=>setSearch(e.target.value)} style={{...iS,paddingLeft:36,fontSize:14}} onFocus={e=>e.target.style.borderColor=T.accent} onBlur={e=>e.target.style.borderColor=T.inputBorder}/>
          </div>
          {tab==="pedidos"&&(
            <select value={filterEnvio} onChange={e=>setFilterEnvio(e.target.value)} style={{...iS,width:"auto",flex:"0 1 190px",fontSize:14,color:filterEnvio?T.accent:T.textMd}}>
              <option value="">Estado de envío</option>
              {["No está empaquetado","Listo para enviar","Enviado","Entregado"].map(e=><option key={e}>{e}</option>)}
            </select>
          )}
          {tab==="reclamos"&&(
            <select value={filterReclamo} onChange={e=>setFilterReclamo(e.target.value)} style={{...iS,width:"auto",flex:"0 1 160px",fontSize:14,color:filterReclamo?T.accent:T.textMd}}>
              <option value="">Estado</option>
              {ESTADOS_R.map(e=><option key={e}>{e}</option>)}
            </select>
          )}
          <span style={{fontSize:12,color:T.textSm,marginLeft:"auto"}}>{tab==="pedidos"?`${filteredOrders.length} pedidos`:`${filteredReclamos.length} reclamos`}</span>
        </div>

        {/* Pedidos */}
        {tab==="pedidos"&&(
          <div style={{paddingBottom:48}}>
            {orders.length===0?(
              <div style={{textAlign:"center",padding:"80px 20px"}}>
                <div style={{fontSize:48,marginBottom:16}}>{ordersStatus==="loading"?"⟳":"📦"}</div>
                <div style={{fontSize:18,fontWeight:600,color:T.textMd}}>{ordersStatus==="loading"?"Cargando pedidos...":ordersStatus==="error"?"Error al conectar":"Sin pedidos"}</div>
              </div>
            ):(
              <>
                <div style={{display:"grid",gridTemplateColumns:"90px 1fr 1fr 180px 120px 80px",gap:8,padding:"8px 16px",fontSize:12,color:T.textSm,fontWeight:600,textTransform:"uppercase",letterSpacing:0.6,borderBottom:`1px solid ${T.borderL}`}}>
                  <span>Pedido</span><span>Cliente</span><span>Productos</span><span>Estado envío</span><span>Total</span><span>Fecha</span>
                </div>
                {filteredOrders.map(o=>{
                  const hasR=reclamos.some(r=>r.orderNum===o.numero);
                  const ec=getEstadoEnvioC(T,o.estadoEnvio);
                  return (
                    <div key={o.numero} onClick={()=>setSelectedOrder(o.numero)}
                      style={{display:"grid",gridTemplateColumns:"90px 1fr 1fr 180px 120px 80px",gap:8,padding:"14px 16px",borderBottom:`1px solid ${T.borderL}`,cursor:"pointer",transition:"background 0.1s",alignItems:"center",borderRadius:4}}
                      onMouseEnter={e=>e.currentTarget.style.background=T.card}
                      onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <span style={{fontWeight:700,color:T.accent,fontSize:15}}>#{o.numero}</span>
                        {hasR&&<span title="Tiene reclamo" style={{color:T.red,fontSize:12}}>⚠</span>}
                      </div>
                      <div>
                        <div style={{fontSize:14,fontWeight:600,color:T.text}}>{o.comprador}</div>
                        <div style={{fontSize:12,color:T.textSm,marginTop:2}}>{o.email}</div>
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:7}}>
                        <LensDots productos={o.productos}/>
                        <span style={{fontSize:12,color:T.textSm,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                          {o.productos.map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'')).join(', ')}
                        </span>
                      </div>
                      <Badge T={T} colors={ec}>{o.estadoEnvio}</Badge>
                      <span style={{fontSize:14,fontWeight:700,color:T.text}}>{fmtMoney(o.total)}</span>
                      <span style={{fontSize:12,color:T.textSm}}>{fmtDate(o.fecha).split('/').slice(0,2).join('/')}</span>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}

        {/* Reclamos */}
        {tab==="reclamos"&&(
          <div style={{paddingBottom:48}}>
            {filteredReclamos.length===0?(
              <div style={{textAlign:"center",padding:"80px 20px"}}>
                <div style={{fontSize:48,marginBottom:16}}>📋</div>
                <div style={{fontSize:18,fontWeight:600,color:T.textMd}}>{reclamos.length===0?"Sin reclamos todavía":"Sin resultados"}</div>
              </div>
            ):(
              <>
                <div style={{display:"grid",gridTemplateColumns:"90px 1fr 1fr 130px 120px 90px",gap:8,padding:"8px 16px",fontSize:12,color:T.textSm,fontWeight:600,textTransform:"uppercase",letterSpacing:0.6,borderBottom:`1px solid ${T.borderL}`}}>
                  <span>Pedido</span><span>Cliente</span><span>Motivo</span><span>Estado</span><span>Tipo</span><span>Fecha</span>
                </div>
                {filteredReclamos.map(r=>{
                  const o=orders.find(o=>o.numero===r.orderNum);
                  const sc=getEstadoRC(T,r.estado);
                  const tc=getTipoRC(T,r.tipo);
                  return (
                    <div key={r._docId} onClick={()=>setReclamoDetail(r._docId)}
                      style={{display:"grid",gridTemplateColumns:"90px 1fr 1fr 130px 120px 90px",gap:8,padding:"14px 16px",borderBottom:`1px solid ${T.borderL}`,cursor:"pointer",transition:"background 0.1s",alignItems:"center",borderLeft:`3px solid ${sc.dot}`,borderRadius:4}}
                      onMouseEnter={e=>e.currentTarget.style.background=T.card}
                      onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                      <span style={{fontWeight:700,color:T.accent,fontSize:15}}>#{r.orderNum}</span>
                      <div>
                        <div style={{fontSize:14,fontWeight:600,color:T.text}}>{o?.comprador||"—"}</div>
                        <div style={{fontSize:12,color:T.textSm,marginTop:2}}>{o?.email||""}</div>
                      </div>
                      <span style={{fontSize:13,color:T.textMd}}>{r.motivo}</span>
                      <Badge T={T} colors={sc}>{r.estado}</Badge>
                      <Badge T={T} colors={tc}>{r.tipo}</Badge>
                      <span style={{fontSize:12,color:T.textSm}}>{fmtTs(r.createdAt)}</span>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}
      </div>

      {/* Order Detail Modal */}
      <Modal T={T} open={!!selOrder} onClose={()=>setSelectedOrder(null)} title={selOrder?`Pedido #${selOrder.numero}`:""} width={640}>
        {selOrder&&(
          <div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:18}}>
              <button onClick={()=>{setSelectedOrder(null);setReclamoForm(emptyForm(selOrder.numero));}} style={{...BtnDanger(T),fontSize:13}}>📋 Crear Reclamo</button>
              <button onClick={()=>setActionModal({type:"direccion",order:selOrder})} style={{...BtnSecondary(T),fontSize:13}}>📍 Dirección</button>
              <button onClick={()=>setActionModal({type:"etiqueta",order:selOrder})} style={{...BtnSecondary(T),fontSize:13,color:T.accent}}>🏷️ Andreani</button>
              {selOrder.linkOrden&&<a href={selOrder.linkOrden} target="_blank" rel="noopener noreferrer" style={{...BtnSecondary(T),fontSize:13,textDecoration:"none",color:T.purple}}>🔗 Tienda Nube</a>}
            </div>
            <Divider T={T}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"6px 28px",fontSize:14,marginBottom:14}}>
              {[["Cliente",selOrder.comprador],["Email",selOrder.email],["Teléfono",selOrder.telefono],["DNI/CUIT",selOrder.dni],["Fecha",fmtDate(selOrder.fecha)],["Pago",selOrder.medioPago],["Estado pago",selOrder.estadoPago],["Estado envío",selOrder.estadoEnvio],["Tracking",selOrder.tracking||"—"]].map(([l,v])=>v?(
                <div key={l} style={{display:"flex",gap:10,padding:"5px 0",borderBottom:`1px solid ${T.borderL}`}}>
                  <span style={{color:T.textSm,minWidth:100,flexShrink:0,fontSize:13}}>{l}</span>
                  <span style={{color:T.text,fontSize:13,fontWeight:500}}>{v}</span>
                </div>
              ):null)}
            </div>
            <Divider T={T}/>
            <div style={{fontSize:12,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.6,marginBottom:10}}>Productos</div>
            {selOrder.productos.map((p,i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:i<selOrder.productos.length-1?`1px solid ${T.borderL}`:"none"}}>
                <div><div style={{fontSize:14,color:T.text}}>{p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'')}</div><div style={{fontSize:12,color:T.textSm,marginTop:2}}>SKU: {p.sku} · x{p.cantidad}</div></div>
                <span style={{fontSize:14,fontWeight:700,color:T.text}}>{fmtMoney(p.precio)}</span>
              </div>
            ))}
            <div style={{display:"flex",justifyContent:"flex-end",marginTop:10,paddingTop:10,borderTop:`1px solid ${T.border}`}}>
              <span style={{fontSize:18,fontWeight:800,color:T.text}}>{fmtMoney(selOrder.total)}</span>
            </div>
            {reclamos.filter(r=>r.orderNum===selOrder.numero).length>0&&(
              <>
                <Divider T={T}/>
                <div style={{fontSize:12,textTransform:"uppercase",color:T.red,fontWeight:600,letterSpacing:0.6,marginBottom:10}}>Reclamos asociados</div>
                {reclamos.filter(r=>r.orderNum===selOrder.numero).map(r=>(
                  <div key={r._docId} onClick={()=>{setSelectedOrder(null);setReclamoDetail(r._docId);setTab("reclamos");}} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",cursor:"pointer",borderBottom:`1px solid ${T.borderL}`}}>
                    <div style={{display:"flex",gap:8,alignItems:"center"}}><Badge T={T} colors={getEstadoRC(T,r.estado)} small>{r.estado}</Badge><span style={{fontSize:13,color:T.textMd}}>{r.tipo} — {r.motivo}</span></div>
                    <span style={{color:T.accent,fontSize:13}}>→</span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </Modal>

      {/* Direccion Modal */}
      <Modal T={T} open={actionModal?.type==="direccion"} onClose={()=>setActionModal(null)} title="Dirección de Envío">
        {actionModal?.order&&(
          <div>
            <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:12,padding:24,marginBottom:16}}>
              <div style={{fontSize:18,fontWeight:700,marginBottom:14,color:T.text}}>{actionModal.order.nombreEnvio}</div>
              <div style={{fontSize:15,lineHeight:2,color:T.textMd}}>
                <div>{actionModal.order.direccion} {actionModal.order.dirNumero}{actionModal.order.piso?`, Piso ${actionModal.order.piso}`:''}</div>
                <div>{actionModal.order.localidad}{actionModal.order.ciudad?`, ${actionModal.order.ciudad}`:''}</div>
                <div style={{color:T.text,fontWeight:600}}>CP {actionModal.order.cp} — {actionModal.order.provincia}</div>
                <div style={{marginTop:6}}>📞 {actionModal.order.telEnvio||actionModal.order.telefono}</div>
              </div>
            </div>
            <button onClick={()=>navigator.clipboard.writeText(fullAddress(actionModal.order))} style={{...BtnSecondary(T),width:"100%",justifyContent:"center"}}>📋 Copiar dirección</button>
          </div>
        )}
      </Modal>

      {/* Etiqueta Modal */}
      <Modal T={T} open={actionModal?.type==="etiqueta"} onClose={()=>setActionModal(null)} title="Etiqueta Andreani" width={480}>
        {actionModal?.order&&(
          <div>
            <div style={{border:`2px dashed ${T.accent}`,borderRadius:12,padding:24,background:T.bg,marginBottom:16}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:16}}>
                <div><div style={{fontSize:11,textTransform:"uppercase",color:T.accent,fontWeight:700,letterSpacing:1}}>Remitente</div><div style={{fontSize:15,fontWeight:700,color:T.text,marginTop:4}}>Soluna Biolight</div></div>
                <div style={{fontSize:12,color:T.textSm,fontFamily:"monospace"}}>#{actionModal.order.numero}</div>
              </div>
              <div style={{borderTop:`1px solid ${T.border}`,paddingTop:16}}>
                <div style={{fontSize:11,textTransform:"uppercase",color:T.accent,fontWeight:700,letterSpacing:1,marginBottom:10}}>Destinatario</div>
                <div style={{fontSize:18,fontWeight:800,color:T.text,marginBottom:10}}>{actionModal.order.nombreEnvio}</div>
                <div style={{fontSize:14,lineHeight:1.9,color:T.textMd}}>
                  <div>{actionModal.order.direccion} {actionModal.order.dirNumero}{actionModal.order.piso?`, Piso ${actionModal.order.piso}`:''}</div>
                  <div>{actionModal.order.localidad}{actionModal.order.ciudad?` — ${actionModal.order.ciudad}`:''}</div>
                  <div style={{color:T.text,fontWeight:600}}>CP {actionModal.order.cp} — {actionModal.order.provincia}</div>
                  <div style={{marginTop:4}}>Tel: {actionModal.order.telEnvio||actionModal.order.telefono}</div>
                </div>
              </div>
              {actionModal.order.tracking&&<div style={{marginTop:16,paddingTop:14,borderTop:`1px solid ${T.border}`}}><div style={{fontSize:11,color:T.accent,fontWeight:700,textTransform:"uppercase",letterSpacing:1}}>Tracking</div><div style={{fontSize:17,fontWeight:800,fontFamily:"monospace",color:T.text,marginTop:6}}>{actionModal.order.tracking}</div></div>}
            </div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>{ const t=`DESTINATARIO: ${actionModal.order.nombreEnvio}\n${actionModal.order.direccion} ${actionModal.order.dirNumero}${actionModal.order.piso?', Piso '+actionModal.order.piso:''}\n${actionModal.order.localidad}${actionModal.order.ciudad?' — '+actionModal.order.ciudad:''}\nCP ${actionModal.order.cp} — ${actionModal.order.provincia}\nTel: ${actionModal.order.telEnvio||actionModal.order.telefono}\nPedido #${actionModal.order.numero}`; navigator.clipboard.writeText(t); }} style={{...BtnSecondary(T),flex:1,justifyContent:"center"}}>📋 Copiar</button>
              <button onClick={()=>window.print()} style={{...BtnSecondary(T),flex:1,justifyContent:"center"}}>🖨️ Imprimir</button>
            </div>
          </div>
        )}
      </Modal>

      {/* Reclamo Form Modal */}
      <Modal T={T} open={!!reclamoForm} onClose={()=>setReclamoForm(null)} title={reclamoForm?._docId?"Editar Reclamo":reclamoForm?.orderNum?`Nuevo Reclamo — #${reclamoForm.orderNum}`:"Nuevo Reclamo"}>
        {reclamoForm&&(
          <div>
            {!reclamoForm._docId&&!reclamoForm.orderNum&&<Field T={T} label="Pedido" required><OrderSearchField T={T} orders={orders} onSelect={num=>setReclamoForm(f=>({...f,orderNum:num}))}/></Field>}
            {(()=>{const o=orders.find(o=>o.numero===reclamoForm.orderNum);return o?(
              <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:"12px 16px",marginBottom:16,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div><span style={{fontWeight:700,fontSize:14,color:T.text}}>#{o.numero} — {o.comprador}</span><div style={{color:T.textSm,fontSize:12,marginTop:3}}>{o.productos.map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'')).join(', ')}</div></div>
                {!reclamoForm._docId&&<button onClick={()=>setReclamoForm(f=>({...f,orderNum:""}))} style={{...BtnDanger(T),padding:"5px 10px",fontSize:12}}>Cambiar</button>}
              </div>
            ):null;})()}
            {reclamoForm.orderNum&&(
              <>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 14px"}}>
                  <Field T={T} label="Tipo"><select style={iS} value={reclamoForm.tipo} onChange={e=>setReclamoForm(f=>({...f,tipo:e.target.value}))}>{TIPOS_R.map(t=><option key={t}>{t}</option>)}</select></Field>
                  <Field T={T} label="Motivo" required><select style={iS} value={reclamoForm.motivo} onChange={e=>setReclamoForm(f=>({...f,motivo:e.target.value}))}><option value="">Seleccionar...</option>{MOTIVOS_R.map(m=><option key={m}>{m}</option>)}</select></Field>
                </div>
                {reclamoForm.tipo==="Cambio"&&(
                  <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:12,padding:16,marginBottom:16}}>
                    <div style={{fontSize:12,textTransform:"uppercase",color:T.purple,fontWeight:700,letterSpacing:0.5,marginBottom:12}}>🔄 Detalle del cambio</div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 18px"}}>
                      {["productosRecibe","productosEnvia"].map((key,side)=>(
                        <div key={key}>
                          <div style={{fontSize:12,color:T.textSm,fontWeight:600,marginBottom:8,textTransform:"uppercase"}}>{side===0?"Nos devuelve":"Le enviamos"}</div>
                          {(reclamoForm[key]||[]).map((item,i)=>(
                            <div key={i} style={{display:"flex",gap:6,marginBottom:8,alignItems:"center"}}>
                              <select style={{...iS,flex:1,fontSize:12,padding:"8px 10px"}} value={item.producto} onChange={e=>{const arr=[...reclamoForm[key]];arr[i]={...arr[i],producto:e.target.value};setReclamoForm(f=>({...f,[key]:arr}));}}><option value="">Producto...</option>{PRODUCTOS.map(p=><option key={p}>{p}</option>)}</select>
                              <input type="number" min={1} value={item.cantidad} onChange={e=>{const arr=[...reclamoForm[key]];arr[i]={...arr[i],cantidad:parseInt(e.target.value)||1};setReclamoForm(f=>({...f,[key]:arr}));}} style={{...iS,width:52,textAlign:"center",fontSize:12,padding:"8px 4px",flexShrink:0}}/>
                              {reclamoForm[key].length>1&&<button onClick={()=>setReclamoForm(f=>({...f,[key]:f[key].filter((_,j)=>j!==i)}))} style={{...BtnDanger(T),padding:"5px 8px",fontSize:12,flexShrink:0}}>✕</button>}
                            </div>
                          ))}
                          <button onClick={()=>setReclamoForm(f=>({...f,[key]:[...(f[key]||[]),{producto:"",cantidad:1}]}))} style={{...BtnSecondary(T),width:"100%",justifyContent:"center",fontSize:12,padding:"7px"}}>+ Agregar</button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <Field T={T} label="Descripción"><textarea style={{...iS,minHeight:70,resize:"vertical"}} value={reclamoForm.descripcion} onChange={e=>setReclamoForm(f=>({...f,descripcion:e.target.value}))} placeholder="Detalle del reclamo..."/></Field>
                {reclamoForm._docId&&(
                  <Field T={T} label="Estado">
                    <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                      {ESTADOS_R.map(e=>{const c=getEstadoRC(T,e);const sel=reclamoForm.estado===e;return <button key={e} onClick={()=>setReclamoForm(f=>({...f,estado:e}))} style={{display:"flex",alignItems:"center",gap:7,padding:"9px 16px",borderRadius:10,fontSize:13,fontWeight:sel?700:500,background:sel?c.bg:T.card,color:sel?c.text:T.textMd,border:`1.5px solid ${sel?c.dot:T.border}`,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",transition:"all 0.15s"}}><span style={{width:8,height:8,borderRadius:"50%",background:sel?c.dot:T.textSm}}/>{e}</button>;})}
                    </div>
                  </Field>
                )}
                {reclamoForm._docId&&<Field T={T} label="Resolución"><textarea style={{...iS,minHeight:60,resize:"vertical"}} value={reclamoForm.resolucion} onChange={e=>setReclamoForm(f=>({...f,resolucion:e.target.value}))} placeholder="Qué se hizo..."/></Field>}
                <Field T={T} label="Notas internas"><textarea style={{...iS,minHeight:55,resize:"vertical"}} value={reclamoForm.notas} onChange={e=>setReclamoForm(f=>({...f,notas:e.target.value}))} placeholder="Notas para el equipo..."/></Field>
                <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:10}}>
                  <button onClick={()=>setReclamoForm(null)} style={BtnSecondary(T)}>Cancelar</button>
                  <button onClick={saveReclamo} disabled={saving||!reclamoForm.motivo} style={{...BtnPrimary(T),opacity:saving||!reclamoForm.motivo?0.5:1}}>{saving?"Guardando...":(reclamoForm._docId?"Guardar cambios":"Crear Reclamo")}</button>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>

      {/* Reclamo Detail Modal */}
      <Modal T={T} open={!!detailR} onClose={()=>setReclamoDetail(null)} title={detailR?`Reclamo — Pedido #${detailR.orderNum}`:""}>
        {detailR&&(()=>{
          const r=detailR; const o=orders.find(o=>o.numero===r.orderNum);
          const sc=getEstadoRC(T,r.estado); const tc=getTipoRC(T,r.tipo);
          return (
            <div>
              <div style={{background:sc.bg,border:`1px solid ${sc.dot}44`,borderRadius:12,padding:"16px 20px",marginBottom:18,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}><span style={{width:12,height:12,borderRadius:"50%",background:sc.dot,boxShadow:`0 0 8px ${sc.dot}`}}/><span style={{fontSize:17,fontWeight:700,color:sc.text}}>{r.estado}</span></div>
                <span style={{background:tc.bg,color:tc.text,padding:"5px 14px",borderRadius:20,fontSize:13,fontWeight:600}}>{r.tipo}</span>
              </div>
              {o&&<div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:12,padding:"14px 18px",marginBottom:14}}><div style={{fontWeight:700,fontSize:15,color:T.text}}>#{o.numero} — {o.comprador}</div><div style={{fontSize:13,color:T.textSm,marginTop:4}}>{o.email} · {o.telefono}</div><div style={{fontSize:13,color:T.textSm,marginTop:3}}>{o.productos.map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'')).join(', ')}</div></div>}
              <div style={{fontSize:14,marginBottom:12,color:T.textMd}}><span style={{color:T.textSm}}>Motivo: </span><span style={{fontWeight:600,color:T.text}}>{r.motivo}</span></div>
              {r.tipo==="Cambio"&&((r.productosRecibe?.length>0)||(r.productosEnvia?.length>0))&&(
                <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:12,padding:16,marginBottom:14}}>
                  <div style={{fontSize:12,textTransform:"uppercase",color:T.purple,fontWeight:700,letterSpacing:0.5,marginBottom:12}}>🔄 Detalle del cambio</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr auto 1fr",gap:12,alignItems:"start"}}>
                    <div><div style={{fontSize:12,color:T.textSm,fontWeight:600,textTransform:"uppercase",marginBottom:6}}>Nos devuelve</div>{(r.productosRecibe||[]).map((item,i)=><div key={i} style={{fontSize:14,fontWeight:600,color:T.red,marginBottom:3}}>{item.cantidad>1&&<span style={{color:T.textSm,fontSize:12}}>{item.cantidad}× </span>}{item.producto||"—"}</div>)}</div>
                    <div style={{color:T.textSm,paddingTop:22,fontSize:18}}>→</div>
                    <div><div style={{fontSize:12,color:T.textSm,fontWeight:600,textTransform:"uppercase",marginBottom:6}}>Le enviamos</div>{(r.productosEnvia||[]).map((item,i)=><div key={i} style={{fontSize:14,fontWeight:600,color:T.green,marginBottom:3}}>{item.cantidad>1&&<span style={{color:T.textSm,fontSize:12}}>{item.cantidad}× </span>}{item.producto||"—"}</div>)}</div>
                  </div>
                </div>
              )}
              {r.descripcion&&<div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:12,padding:14,marginBottom:10,fontSize:14,color:T.textMd,lineHeight:1.6}}>{r.descripcion}</div>}
              {r.resolucion&&<div style={{background:T.greenBg,border:`1px solid ${T.green}33`,borderRadius:12,padding:14,marginBottom:10}}><div style={{fontSize:11,textTransform:"uppercase",color:T.green,fontWeight:700,marginBottom:5}}>Resolución</div><div style={{fontSize:14,color:T.text,lineHeight:1.6}}>{r.resolucion}</div></div>}
              {r.notas&&<div style={{background:T.yellowBg,border:`1px solid ${T.yellow}33`,borderRadius:12,padding:14,marginBottom:10}}><div style={{fontSize:11,textTransform:"uppercase",color:T.yellow,fontWeight:700,marginBottom:5}}>Notas internas</div><div style={{fontSize:14,color:T.text,lineHeight:1.6}}>{r.notas}</div></div>}
              <div style={{fontSize:12,color:T.textSm,marginTop:12}}>Creado: {fmtTs(r.createdAt)}{r.resolvedAt?.seconds?` · Resuelto: ${fmtTs(r.resolvedAt)}`:''}</div>
              <Divider T={T}/>
              <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
                {deleteConfirm===r._docId?(
                  <div style={{display:"flex",gap:8,alignItems:"center"}}><span style={{fontSize:14,color:T.red,fontWeight:500}}>¿Eliminar?</span><button onClick={()=>deleteReclamo(r._docId)} style={{...BtnDanger(T),padding:"8px 16px",fontSize:13}}>Sí</button><button onClick={()=>setDeleteConfirm(null)} style={{...BtnSecondary(T),padding:"8px 16px",fontSize:13}}>No</button></div>
                ):(
                  <><button onClick={()=>setDeleteConfirm(r._docId)} style={{...BtnDanger(T),fontSize:13}}>Eliminar</button><button onClick={()=>{setReclamoDetail(null);setReclamoForm({...r});}} style={{...BtnSecondary(T),fontSize:13}}>Editar</button></>
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
// APP CANJES
// ═══════════════════════════════════════════
function AppCanjes({T, fbStatus, onHome}) {
  const [canjes,setCanjes]=useState([]);
  const [form,setForm]=useState(null);
  const [detail,setDetail]=useState(null);
  const [search,setSearch]=useState("");
  const [filterEstado,setFilterEstado]=useState("");
  const [filterRed,setFilterRed]=useState("");
  const [deleteConfirm,setDeleteConfirm]=useState(null);
  const [saving,setSaving]=useState(false);
  const iS=InputStyle(T);
  const fbDot={connecting:T.yellow,ok:T.green,error:T.red}[fbStatus];

  useEffect(()=>{
    const unsub=onSnapshot(collection(db,"canjes"),snap=>{
      const data=snap.docs.map(d=>({...d.data(),_docId:d.id}));
      data.sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
      setCanjes(data);
    },()=>{});
    return ()=>unsub();
  },[]);

  const emptyForm=()=>({_docId:null,influencer:"",usuario:"",red:"Instagram",seguidores:"",email:"",telefono:"",producto:"",estado:"Pendiente envío",tracking:"",actividades:[],notas:"",linkContenido:"",fechaEnvio:"",fechaPublicacion:""});

  async function saveCanje() {
    if(!form?.influencer) return;
    setSaving(true);
    try {
      const p={influencer:form.influencer,usuario:form.usuario||"",red:form.red,seguidores:form.seguidores||"",email:form.email||"",telefono:form.telefono||"",producto:form.producto||"",estado:form.estado,tracking:form.tracking||"",actividades:form.actividades||[],notas:form.notas||"",linkContenido:form.linkContenido||"",fechaEnvio:form.fechaEnvio||"",fechaPublicacion:form.fechaPublicacion||""};
      if(form._docId) {
        const prev=canjes.find(c=>c._docId===form._docId);
        await updateDoc(doc(db,"canjes",form._docId),{...p,updatedAt:serverTimestamp(),...(form.estado==="Finalizado"&&prev?.estado!=="Finalizado"?{finalizadoAt:serverTimestamp()}:{})});
      } else {
        await addDoc(collection(db,"canjes"),{...p,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
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
    if(search){const s=search.toLowerCase();return c.influencer.toLowerCase().includes(s)||(c.usuario||"").toLowerCase().includes(s)||(c.email||"").toLowerCase().includes(s);}
    return true;
  }),[canjes,search,filterEstado,filterRed]);

  const stats={total:canjes.length,pendientes:canjes.filter(c=>c.estado==="Pendiente envío").length,enviados:canjes.filter(c=>c.estado==="Enviado").length,contPend:canjes.filter(c=>c.estado==="Contenido pendiente").length,publicados:canjes.filter(c=>c.estado==="Contenido publicado").length,finalizados:canjes.filter(c=>c.estado==="Finalizado").length};
  const detailC=canjes.find(c=>c._docId===detail);

  return (
    <div style={{fontFamily:"'Inter',system-ui,sans-serif",background:T.bg,minHeight:"100vh",color:T.text}}>
      <div style={{borderBottom:`1px solid ${T.border}`,background:T.surface,padding:"0 28px",position:"sticky",top:0,zIndex:100}}>
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
          <button onClick={()=>setForm(emptyForm())} style={{...BtnPurple(T),fontSize:13}}>+ Nuevo Canje</button>
        </div>
      </div>

      <div style={{maxWidth:1280,margin:"0 auto",padding:"0 28px"}}>
        <div style={{display:"flex",gap:10,flexWrap:"wrap",padding:"24px 0 0"}}>
          <StatCard T={T} label="Total canjes" value={stats.total} color={T.textMd}/>
          <StatCard T={T} label="Pend. envío" value={stats.pendientes} color={T.yellow}/>
          <StatCard T={T} label="Enviados" value={stats.enviados} color={T.blue}/>
          <StatCard T={T} label="Cont. pendiente" value={stats.contPend} color={T.orange}/>
          <StatCard T={T} label="Publicados" value={stats.publicados} color={T.purple}/>
          <StatCard T={T} label="Finalizados" value={stats.finalizados} color={T.green}/>
        </div>

        <div style={{padding:"14px 0 8px",display:"flex",gap:10,flexWrap:"wrap",alignItems:"center",marginTop:10}}>
          <div style={{position:"relative",flex:"1 1 260px",minWidth:220}}>
            <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",color:T.textSm,fontSize:14}}>🔍</span>
            <input placeholder="Buscar influencer, usuario..." value={search} onChange={e=>setSearch(e.target.value)} style={{...iS,paddingLeft:36,fontSize:14}} onFocus={e=>e.target.style.borderColor=T.accent} onBlur={e=>e.target.style.borderColor=T.inputBorder}/>
          </div>
          <select value={filterEstado} onChange={e=>setFilterEstado(e.target.value)} style={{...iS,width:"auto",flex:"0 1 190px",fontSize:14,color:filterEstado?T.accent:T.textMd}}><option value="">Estado</option>{ESTADOS_C.map(e=><option key={e}>{e}</option>)}</select>
          <select value={filterRed} onChange={e=>setFilterRed(e.target.value)} style={{...iS,width:"auto",flex:"0 1 150px",fontSize:14,color:filterRed?T.accent:T.textMd}}><option value="">Red social</option>{REDES.map(r=><option key={r}>{r}</option>)}</select>
          <span style={{fontSize:12,color:T.textSm,marginLeft:"auto"}}>{filtered.length} canjes</span>
        </div>

        <div style={{paddingBottom:48}}>
          {filtered.length===0?(
            <div style={{textAlign:"center",padding:"80px 20px"}}>
              <div style={{fontSize:48,marginBottom:16}}>🤝</div>
              <div style={{fontSize:18,fontWeight:600,color:T.textMd}}>{canjes.length===0?"Sin canjes todavía":"Sin resultados"}</div>
            </div>
          ):(
            <>
              <div style={{display:"grid",gridTemplateColumns:"1fr 90px 160px 190px 1fr 80px",gap:8,padding:"8px 16px",fontSize:12,color:T.textSm,fontWeight:600,textTransform:"uppercase",letterSpacing:0.6,borderBottom:`1px solid ${T.borderL}`}}>
                <span>Influencer</span><span>Red</span><span>Producto</span><span>Estado</span><span>Actividades</span><span>Fecha</span>
              </div>
              {filtered.map(c=>{
                const sc=getEstadoCC(T,c.estado);
                return (
                  <div key={c._docId} onClick={()=>setDetail(c._docId)}
                    style={{display:"grid",gridTemplateColumns:"1fr 90px 160px 190px 1fr 80px",gap:8,padding:"14px 16px",borderBottom:`1px solid ${T.borderL}`,cursor:"pointer",transition:"background 0.1s",alignItems:"center",borderLeft:`3px solid ${sc.dot}`,borderRadius:4}}
                    onMouseEnter={e=>e.currentTarget.style.background=T.card}
                    onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                    <div>
                      <div style={{fontSize:14,fontWeight:700,color:T.text}}>{c.influencer}</div>
                      {c.usuario&&<div style={{fontSize:13,color:T.accent,marginTop:2}}>@{c.usuario}</div>}
                      {c.seguidores&&<div style={{fontSize:12,color:T.textSm,marginTop:1}}>{Number(c.seguidores).toLocaleString()} seg.</div>}
                    </div>
                    <span style={{fontSize:13,color:T.textMd}}>{c.red}</span>
                    <span style={{fontSize:13,color:T.textMd,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.producto||"—"}</span>
                    <Badge T={T} colors={sc}>{c.estado}</Badge>
                    <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                      {(c.actividades||[]).map((a,i)=><span key={i} style={{fontSize:11,background:T.purpleBg,color:T.purple,border:`1px solid ${T.purple}33`,borderRadius:6,padding:"2px 8px",fontWeight:500}}>{a}</span>)}
                    </div>
                    <span style={{fontSize:12,color:T.textSm}}>{fmtTs(c.createdAt)}</span>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>

      {/* Canje Form Modal */}
      <Modal T={T} open={!!form} onClose={()=>setForm(null)} title={form?._docId?"Editar Canje":"Nuevo Canje"} width={580}>
        {form&&(
          <div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 14px"}}>
              <Field T={T} label="Nombre" required><input style={iS} value={form.influencer} onChange={e=>setForm(f=>({...f,influencer:e.target.value}))} placeholder="Nombre del influencer"/></Field>
              <Field T={T} label="Usuario (@)"><input style={iS} value={form.usuario} onChange={e=>setForm(f=>({...f,usuario:e.target.value}))} placeholder="@usuario"/></Field>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"0 14px"}}>
              <Field T={T} label="Red social"><select style={iS} value={form.red} onChange={e=>setForm(f=>({...f,red:e.target.value}))}>{REDES.map(r=><option key={r}>{r}</option>)}</select></Field>
              <Field T={T} label="Seguidores"><input style={iS} type="number" value={form.seguidores} onChange={e=>setForm(f=>({...f,seguidores:e.target.value}))} placeholder="50000"/></Field>
              <Field T={T} label="Producto"><select style={iS} value={form.producto} onChange={e=>setForm(f=>({...f,producto:e.target.value}))}><option value="">Seleccionar...</option>{PRODUCTOS_CANJE.map(p=><option key={p}>{p}</option>)}</select></Field>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 14px"}}>
              <Field T={T} label="Email"><input style={iS} type="email" value={form.email} onChange={e=>setForm(f=>({...f,email:e.target.value}))} placeholder="email@ejemplo.com"/></Field>
              <Field T={T} label="Teléfono"><input style={iS} value={form.telefono} onChange={e=>setForm(f=>({...f,telefono:e.target.value}))} placeholder="+54 11..."/></Field>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 14px"}}>
              <Field T={T} label="Fecha de envío"><input style={iS} type="date" value={form.fechaEnvio} onChange={e=>setForm(f=>({...f,fechaEnvio:e.target.value}))}/></Field>
              <Field T={T} label="Tracking Andreani"><input style={iS} value={form.tracking} onChange={e=>setForm(f=>({...f,tracking:e.target.value}))} placeholder="Código de seguimiento"/></Field>
            </div>
            <Field T={T} label="Actividades comprometidas">
              <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
                {ACTIVIDADES.map(a=>{const sel=(form.actividades||[]).includes(a);return <button key={a} onClick={()=>setForm(f=>({...f,actividades:sel?f.actividades.filter(x=>x!==a):[...(f.actividades||[]),a]}))} style={{display:"flex",alignItems:"center",gap:6,padding:"7px 14px",borderRadius:8,fontSize:13,fontWeight:sel?600:400,background:sel?T.purpleBg:T.card,color:sel?T.purple:T.textMd,border:`1.5px solid ${sel?T.purple:T.border}`,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",transition:"all 0.15s"}}>{a}</button>;})}
              </div>
            </Field>
            {form._docId&&(
              <>
                <Field T={T} label="Estado">
                  <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
                    {ESTADOS_C.map(e=>{const c=getEstadoCC(T,e);const sel=form.estado===e;return <button key={e} onClick={()=>setForm(f=>({...f,estado:e}))} style={{display:"flex",alignItems:"center",gap:7,padding:"8px 14px",borderRadius:8,fontSize:13,fontWeight:sel?600:400,background:sel?c.bg:T.card,color:sel?c.text:T.textMd,border:`1.5px solid ${sel?c.dot:T.border}`,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",transition:"all 0.15s"}}><span style={{width:7,height:7,borderRadius:"50%",background:sel?c.dot:T.textSm}}/>{e}</button>;})}
                  </div>
                </Field>
                <Field T={T} label="Link del contenido"><input style={iS} value={form.linkContenido} onChange={e=>setForm(f=>({...f,linkContenido:e.target.value}))} placeholder="https://instagram.com/p/..."/></Field>
                <Field T={T} label="Fecha de publicación"><input style={iS} type="date" value={form.fechaPublicacion} onChange={e=>setForm(f=>({...f,fechaPublicacion:e.target.value}))}/></Field>
              </>
            )}
            <Field T={T} label="Notas"><textarea style={{...iS,minHeight:60,resize:"vertical"}} value={form.notas} onChange={e=>setForm(f=>({...f,notas:e.target.value}))} placeholder="Notas sobre el canje..."/></Field>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:10}}>
              <button onClick={()=>setForm(null)} style={BtnSecondary(T)}>Cancelar</button>
              <button onClick={saveCanje} disabled={saving||!form.influencer} style={{...BtnPrimary(T),opacity:saving||!form.influencer?0.5:1}}>{saving?"Guardando...":(form._docId?"Guardar":"Crear Canje")}</button>
            </div>
          </div>
        )}
      </Modal>

      {/* Canje Detail Modal */}
      <Modal T={T} open={!!detailC} onClose={()=>setDetail(null)} title={detailC?`Canje — ${detailC.influencer}`:""} width={520}>
        {detailC&&(()=>{
          const c=detailC; const sc=getEstadoCC(T,c.estado);
          return (
            <div>
              <div style={{background:sc.bg,border:`1px solid ${sc.dot}44`,borderRadius:12,padding:"16px 20px",marginBottom:18,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}><span style={{width:12,height:12,borderRadius:"50%",background:sc.dot,boxShadow:`0 0 8px ${sc.dot}`}}/><span style={{fontSize:17,fontWeight:700,color:sc.text}}>{c.estado}</span></div>
                <span style={{fontSize:13,color:T.textMd,fontWeight:500}}>{c.red}</span>
              </div>
              <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:12,padding:"16px 18px",marginBottom:14}}>
                <div style={{fontSize:18,fontWeight:800,color:T.text}}>{c.influencer}</div>
                {c.usuario&&<div style={{fontSize:14,color:T.accent,marginTop:4}}>@{c.usuario}</div>}
                {c.seguidores&&<div style={{fontSize:13,color:T.textSm,marginTop:3}}>{Number(c.seguidores).toLocaleString()} seguidores</div>}
                {c.email&&<div style={{fontSize:13,color:T.textSm,marginTop:3}}>{c.email}</div>}
                {c.telefono&&<div style={{fontSize:13,color:T.textSm,marginTop:2}}>{c.telefono}</div>}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"6px 24px",fontSize:14,marginBottom:14}}>
                {[["Producto",c.producto],["Tracking",c.tracking],["Fecha envío",c.fechaEnvio],["Fecha publicación",c.fechaPublicacion]].map(([l,v])=>v?(
                  <div key={l} style={{display:"flex",gap:10,padding:"5px 0",borderBottom:`1px solid ${T.borderL}`}}>
                    <span style={{color:T.textSm,minWidth:110,flexShrink:0,fontSize:13}}>{l}</span>
                    <span style={{fontSize:13,fontWeight:500,color:T.text}}>{v}</span>
                  </div>
                ):null)}
              </div>
              {c.actividades?.length>0&&(
                <div style={{marginBottom:14}}>
                  <div style={{fontSize:12,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:8}}>Actividades comprometidas</div>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{c.actividades.map((a,i)=><span key={i} style={{fontSize:12,background:T.purpleBg,color:T.purple,border:`1px solid ${T.purple}33`,borderRadius:6,padding:"3px 10px",fontWeight:500}}>{a}</span>)}</div>
                </div>
              )}
              {c.linkContenido&&<div style={{marginBottom:12}}><div style={{fontSize:12,textTransform:"uppercase",color:T.textSm,fontWeight:600,letterSpacing:0.5,marginBottom:6}}>Link del contenido</div><a href={c.linkContenido} target="_blank" rel="noopener noreferrer" style={{color:T.accent,fontSize:14,wordBreak:"break-all"}}>{c.linkContenido}</a></div>}
              {c.notas&&<div style={{background:T.yellowBg,border:`1px solid ${T.yellow}33`,borderRadius:12,padding:14,marginBottom:10}}><div style={{fontSize:11,textTransform:"uppercase",color:T.yellow,fontWeight:700,marginBottom:5}}>Notas</div><div style={{fontSize:14,lineHeight:1.6,color:T.text}}>{c.notas}</div></div>}
              <div style={{fontSize:12,color:T.textSm,marginTop:12}}>Creado: {fmtTs(c.createdAt)}{c.finalizadoAt?.seconds?` · Finalizado: ${fmtTs(c.finalizadoAt)}`:''}</div>
              <Divider T={T}/>
              <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
                {deleteConfirm===c._docId?(
                  <div style={{display:"flex",gap:8,alignItems:"center"}}><span style={{fontSize:14,color:T.red,fontWeight:500}}>¿Eliminar?</span><button onClick={()=>deleteCanje(c._docId)} style={{...BtnDanger(T),padding:"8px 16px",fontSize:13}}>Sí</button><button onClick={()=>setDeleteConfirm(null)} style={{...BtnSecondary(T),padding:"8px 16px",fontSize:13}}>No</button></div>
                ):(
                  <><button onClick={()=>setDeleteConfirm(c._docId)} style={{...BtnDanger(T),fontSize:13}}>Eliminar</button><button onClick={()=>{setDetail(null);setForm({...c});}} style={{...BtnSecondary(T),fontSize:13}}>Editar</button></>
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
// HOME SCREEN
// ═══════════════════════════════════════════
function HomeScreen({T, onNavigate, fbStatus, ordersCount, reclamosCount, canjesCount}) {
  const fbDot={connecting:T.yellow,ok:T.green,error:T.red}[fbStatus];
  return (
    <div style={{fontFamily:"'Inter',system-ui,sans-serif",background:T.bg,minHeight:"100vh",color:T.text,display:"flex",flexDirection:"column"}}>
      <div style={{borderBottom:`1px solid ${T.border}`,background:T.surface,padding:"0 28px"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",height:64,maxWidth:1000,margin:"0 auto"}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <div style={{width:36,height:36,borderRadius:10,background:`linear-gradient(135deg,${T.accent},${T.purple})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>🌙</div>
            <div>
              <div style={{fontWeight:800,fontSize:16,color:T.text,letterSpacing:-0.3}}>Soluna Biolight</div>
              <div style={{fontSize:12,color:T.textSm}}>Panel de Gestión</div>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:6,background:T.card,border:`1px solid ${T.border}`,borderRadius:20,padding:"5px 12px"}}>
            <span style={{width:7,height:7,borderRadius:"50%",background:fbDot,boxShadow:`0 0 6px ${fbDot}`}}/>
            <span style={{fontSize:12,color:T.textSm,fontWeight:500}}>{fbStatus==="ok"?"Firebase en vivo":fbStatus==="error"?"Sin conexión":"Conectando..."}</span>
          </div>
        </div>
      </div>

      <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"48px 28px"}}>
        <div style={{textAlign:"center",marginBottom:56,maxWidth:520}}>
          <h1 style={{fontSize:36,fontWeight:800,margin:"0 0 12px",letterSpacing:-1,color:T.text}}>Bienvenida 👋</h1>
          <p style={{fontSize:17,color:T.textMd,margin:0,lineHeight:1.7}}>Seleccioná una sección para gestionar tu negocio.</p>
        </div>

        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:24,width:"100%",maxWidth:760}}>
          {/* Reclamos */}
          <button onClick={()=>onNavigate("reclamos")}
            style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:16,padding:32,textAlign:"left",cursor:"pointer",transition:"all 0.2s",fontFamily:"'Inter',system-ui,sans-serif",color:T.text}}
            onMouseEnter={e=>{e.currentTarget.style.borderColor=T.red;e.currentTarget.style.transform="translateY(-3px)";e.currentTarget.style.boxShadow=`0 12px 32px rgba(0,0,0,0.25)`;}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor=T.border;e.currentTarget.style.transform="none";e.currentTarget.style.boxShadow="none";}}>
            <div style={{width:52,height:52,borderRadius:14,background:T.redBg,border:`1px solid ${T.red}33`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:26,marginBottom:20}}>📋</div>
            <div style={{fontSize:20,fontWeight:800,marginBottom:8,color:T.text,letterSpacing:-0.3}}>Gestión de Reclamos</div>
            <div style={{fontSize:14,color:T.textMd,lineHeight:1.6,marginBottom:20}}>Administrá cambios y devoluciones de productos vinculados a tus pedidos de Tienda Nube.</div>
            <div style={{display:"flex",