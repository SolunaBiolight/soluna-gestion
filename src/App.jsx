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

// ─── Design Tokens ───
const C = {
  bg:"#0d1117", surface:"#161b22", surface2:"#1c2128",
  border:"#30363d", borderL:"#21262d",
  text:"#e6edf3", textMd:"#8b949e", textSm:"#6e7681",
  accent:"#58a6ff", accentBg:"#388bfd1a",
  green:"#3fb950", greenBg:"#3fb9501a",
  yellow:"#d29922", yellowBg:"#d299221a",
  red:"#f85149", redBg:"#f851491a",
  purple:"#bc8cff", purpleBg:"#bc8cff1a",
  orange:"#f0883e", orangeBg:"#f0883e1a",
  pink:"#ff7eb6", pinkBg:"#ff7eb61a",
};

// ─── Shared Styles ───
const iSt = { width:"100%",padding:"7px 11px",borderRadius:6,border:`1px solid ${C.border}`,fontSize:13,fontFamily:"'Inter',system-ui,sans-serif",outline:"none",boxSizing:"border-box",background:C.surface,color:C.text,transition:"border-color 0.15s" };
const selSt = { ...iSt,cursor:"pointer" };
const btnBase = { border:"none",borderRadius:6,padding:"6px 14px",fontSize:13,fontWeight:500,cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",transition:"all 0.15s",display:"inline-flex",alignItems:"center",gap:6 };
const btnPrimary = { ...btnBase,background:"#238636",color:"#fff",border:"1px solid #2ea043" };
const btnSecondary = { ...btnBase,background:C.surface,color:C.text,border:`1px solid ${C.border}` };
const btnDanger = { ...btnBase,background:C.redBg,color:C.red,border:`1px solid ${C.red}44` };
const btnPurple = { ...btnBase,background:C.purpleBg,color:C.purple,border:`1px solid ${C.purple}44` };

// ─── Constants: Reclamos ───
const MOTIVOS_R = ["Producto dañado","Color incorrecto","No cumple expectativas","Problema con el lente","Error en el pedido","Armazón roto","Otro"];
const ESTADOS_R = ["Pendiente","En proceso","Resuelto","Rechazado"];
const TIPOS_R = ["Cambio","Devolución"];
const PRODUCTOS = ["Amarillo - Marco Negro","Amarillo - M. Transparente","Naranja - Marco Negro","Naranja - M. Transparente","Rojo - Marco Negro","Rojo - M. Transparente","Clip-On","Líquido Limpia Cristales"];
const SKU_LENTE = { "AMARILLO-NN":"Amarillo","AMARILLO-TT":"Amarillo","NARAN-NN":"Naranja","NARAN-TT":"Naranja","ROJ-NN":"Rojo","ROJ-TT":"Rojo","N-N":"Negro","N-R":"Negro/Rojo","R-R":"Rojo/Rojo","CLIP-ON":"Clip-On","LIQ":"Líquido" };
const LENTE_DOT = { Amarillo:"#d29922",Naranja:"#f0883e",Rojo:"#f85149",Negro:"#6e7681","Clip-On":"#bc8cff",Líquido:"#58a6ff" };
const ESTADO_ENVIO_C = { "No está empaquetado":{bg:C.yellowBg,text:C.yellow,dot:C.yellow},"Listo para enviar":{bg:C.accentBg,text:C.accent,dot:C.accent},"Enviado":{bg:C.purpleBg,text:C.purple,dot:C.purple},"Entregado":{bg:C.greenBg,text:C.green,dot:C.green} };
const ESTADO_R_C = { Pendiente:{bg:C.accentBg,text:C.accent,dot:C.accent},"En proceso":{bg:C.yellowBg,text:C.yellow,dot:C.yellow},Resuelto:{bg:C.greenBg,text:C.green,dot:C.green},Rechazado:{bg:C.redBg,text:C.red,dot:C.red} };
const TIPO_R_C = { Cambio:{bg:C.purpleBg,text:C.purple},Devolución:{bg:C.orangeBg,text:C.orange} };

// ─── Constants: Canjes ───
const ESTADOS_C = ["Pendiente envío","Enviado","Contenido pendiente","Contenido publicado","Finalizado","Cancelado"];
const REDES = ["Instagram","TikTok","YouTube","Twitter/X","Otro"];
const ACTIVIDADES = ["Story","Post feed","Reel","Video","TikTok","Live","Link en bio","Review"];
const PRODUCTOS_CANJE = ["Amarillo - Marco Negro","Amarillo - M. Transparente","Naranja - Marco Negro","Naranja - M. Transparente","Rojo - Marco Negro","Rojo - M. Transparente","Clip-On","Kit Completo","A elección"];
const ESTADO_C_C = {
  "Pendiente envío":{bg:C.yellowBg,text:C.yellow,dot:C.yellow},
  "Enviado":{bg:C.accentBg,text:C.accent,dot:C.accent},
  "Contenido pendiente":{bg:C.orangeBg,text:C.orange,dot:C.orange},
  "Contenido publicado":{bg:C.purpleBg,text:C.purple,dot:C.purple},
  "Finalizado":{bg:C.greenBg,text:C.green,dot:C.green},
  "Cancelado":{bg:C.redBg,text:C.red,dot:C.red},
};

// ─── Helpers ───
function fmtMoney(v) { const n=parseFloat(v); if(isNaN(n)) return '—'; return '$'+n.toLocaleString('es-AR',{minimumFractionDigits:0,maximumFractionDigits:0}); }
function fmtDate(d) { if(!d) return '—'; const p=d.split(' ')[0].split('/'); if(p.length===3) return `${p[0]}/${p[1]}/${p[2]}`; return d; }
function fmtTs(ts) { if(!ts?.seconds) return '—'; return new Date(ts.seconds*1000).toLocaleDateString('es-AR'); }
function fullAddress(o) { let a=o.direccion||''; if(o.dirNumero) a+=' '+o.dirNumero; if(o.piso) a+=', Piso '+o.piso; return [a,o.localidad,o.ciudad,o.cp?`CP ${o.cp}`:'',o.provincia].filter(Boolean).join(', '); }
function getLensColors(productos) { const s=new Set(); for(const p of productos){const c=SKU_LENTE[p.sku];if(c)s.add(c);} return [...s]; }
function mapEstadoEnvio(s) { return {"unpacked":"No está empaquetado","ready_to_ship":"Listo para enviar","shipped":"Enviado","delivered":"Entregado"}[s]||s||'—'; }
function mapEstadoPago(s) { return {"pending":"Pendiente","paid":"Pagado","voided":"Anulado","refunded":"Reembolsado","abandoned":"Abandonado"}[s]||s||'—'; }

function buildOrdersFromAPI(data) {
  if(!Array.isArray(data)) return [];
  return data.map(o=>{
    const sh=o.shipping_address||{};
    return {
      numero:String(o.number||o.id), fecha:o.created_at?new Date(o.created_at).toLocaleDateString('es-AR'):'',
      comprador:`${sh.name||''} ${sh.last_name||''}`.trim()||o.contact_name||'',
      email:o.contact_email||'', telefono:o.contact_phone||'', dni:o.contact_identification||'',
      estadoOrden:o.status||'', estadoPago:mapEstadoPago(o.payment_status), estadoEnvio:mapEstadoEnvio(o.shipping_status),
      total:String(o.total||''), subtotal:String(o.subtotal||''), descuento:String(o.discount||'0'),
      costoEnvio:String(o.shipping_cost_customer||'0'), nombreEnvio:`${sh.name||''} ${sh.last_name||''}`.trim(),
      telEnvio:o.contact_phone||'', direccion:sh.address||'', dirNumero:sh.number||'', piso:sh.floor||'',
      localidad:sh.locality||'', ciudad:sh.city||'', cp:sh.zipcode||'', provincia:sh.province||'',
      medioEnvio:o.shipping_option||'', medioPago:o.payment_details?.method||o.gateway_name||'',
      canal:o.storefront||'', tracking:o.shipping_tracking_number||'',
      linkOrden:`https://solunabiolight2.mitiendanube.com/admin/orders/${o.id}`,
      fechaPago:o.paid_at||'', fechaEnvio:o.shipped_at||'',
      productos:(o.products||[]).map(p=>({ nombre:p.name||'', precio:String(p.price||''), cantidad:String(p.quantity||'1'), sku:p.sku||'' })),
    };
  }).sort((a,b)=>parseInt(b.numero)-parseInt(a.numero));
}

// ─── UI Components ───
function Badge({colors,children,small}) {
  return <span style={{display:"inline-flex",alignItems:"center",gap:5,padding:small?"1px 6px":"2px 8px",borderRadius:20,fontSize:small?10:11,fontWeight:500,background:colors.bg,color:colors.text,border:`1px solid ${colors.dot||colors.text}33`,whiteSpace:"nowrap"}}><span style={{width:6,height:6,borderRadius:"50%",background:colors.dot||colors.text,flexShrink:0}}/>{children}</span>;
}
function LensDots({productos}) {
  return <span style={{display:"inline-flex",gap:3,alignItems:"center"}}>{getLensColors(productos).map((c,i)=><span key={i} style={{width:9,height:9,borderRadius:"50%",background:LENTE_DOT[c]||C.textSm,border:`1px solid ${C.border}`}} title={c}/>)}</span>;
}
function Modal({open,onClose,title,width,children}) {
  if(!open) return null;
  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",backdropFilter:"blur(2px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:16}}>
      <div onClick={e=>e.stopPropagation()} style={{background:C.surface,borderRadius:12,width:"100%",maxWidth:width||520,maxHeight:"92vh",overflow:"visible",boxShadow:`0 16px 48px rgba(0,0,0,0.5)`,border:`1px solid ${C.border}`,display:"flex",flexDirection:"column"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"16px 20px 12px",borderBottom:`1px solid ${C.borderL}`,flexShrink:0}}>
          <h2 style={{margin:0,fontSize:15,fontWeight:600,color:C.text}}>{title}</h2>
          <button onClick={onClose} style={{...btnSecondary,padding:"3px 8px",fontSize:15}}>✕</button>
        </div>
        <div style={{padding:"16px 20px 20px",overflow:"auto",flex:1}}>{children}</div>
      </div>
    </div>
  );
}
function Field({label,children,required}) {
  return <div style={{marginBottom:12}}><label style={{display:"block",fontSize:11,fontWeight:500,color:C.textMd,marginBottom:5,letterSpacing:0.4,textTransform:"uppercase"}}>{label}{required&&<span style={{color:C.red,marginLeft:3}}>*</span>}</label>{children}</div>;
}
function Divider() { return <div style={{height:1,background:C.borderL,margin:"12px 0"}}/>; }
function StatCard({label,value,color}) {
  return <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:"14px 16px",flex:"1 1 100px",minWidth:95}}><div style={{fontSize:22,fontWeight:700,color,letterSpacing:-0.5}}>{value}</div><div style={{fontSize:11,color:C.textSm,marginTop:2,fontWeight:500}}>{label}</div></div>;
}

function OrderSearchField({orders,onSelect}) {
  const [q,setQ]=useState(""); const inputRef=useRef(null);
  const results=useMemo(()=>{ if(!q) return []; const s=q.toLowerCase(); return orders.filter(o=>o.numero.includes(s)||o.comprador.toLowerCase().includes(s)||o.email.toLowerCase().includes(s)).slice(0,10); },[q,orders]);
  useEffect(()=>{ if(inputRef.current) inputRef.current.focus(); },[]);
  return (
    <div>
      <div style={{position:"relative"}}>
        <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",color:C.textSm,fontSize:13}}>🔍</span>
        <input ref={inputRef} style={{...iSt,paddingLeft:30}} placeholder="Nro de pedido, nombre o email..." value={q} onChange={e=>setQ(e.target.value)}/>
      </div>
      {q.length>0&&results.length>0&&(
        <div style={{marginTop:4,background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,maxHeight:260,overflow:"auto"}}>
          {results.map((o,i)=>(
            <div key={o.numero} onClick={()=>onSelect(o.numero)} style={{padding:"9px 12px",cursor:"pointer",borderTop:i>0?`1px solid ${C.borderL}`:"none"}} onMouseEnter={e=>e.currentTarget.style.background=C.surface} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              <div style={{display:"flex",justifyContent:"space-between"}}><span style={{fontWeight:600,color:C.accent,fontSize:13}}>#{o.numero}</span><span style={{color:C.text,fontSize:13}}>{o.comprador}</span><span style={{fontSize:11,color:C.textSm}}>{fmtDate(o.fecha)}</span></div>
              <div style={{fontSize:11,color:C.textSm,marginTop:2}}>{o.productos.map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'')).join(', ')}</div>
            </div>
          ))}
        </div>
      )}
      {q.length>0&&results.length===0&&<div style={{marginTop:4,padding:12,textAlign:"center",color:C.textSm,fontSize:13,border:`1px solid ${C.border}`,borderRadius:8}}>Sin resultados para "{q}"</div>}
    </div>
  );
}

// ═══════════════════════════════════════════════
// ── APP RECLAMOS ──
// ═══════════════════════════════════════════════
function AppReclamos({orders,ordersStatus,fetchOrders,fbStatus,onHome}) {
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
  const TABS=[{id:"pedidos",label:"Pedidos",icon:"📦"},{id:"reclamos",label:"Reclamos",icon:"📋"}];

  return (
    <div style={{fontFamily:"'Inter',system-ui,sans-serif",background:C.bg,minHeight:"100vh",color:C.text}}>
      {/* Topbar */}
      <div style={{borderBottom:`1px solid ${C.border}`,background:C.surface,padding:"0 24px",position:"sticky",top:0,zIndex:100}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",height:52,gap:16,maxWidth:1200,margin:"0 auto"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <button onClick={onHome} style={{...btnSecondary,padding:"4px 8px",fontSize:12}}>← Inicio</button>
            <span style={{color:C.textSm,fontSize:13}}>/</span>
            <span style={{fontWeight:600,fontSize:14,color:C.text}}>📋 Reclamos</span>
            <div style={{display:"flex",alignItems:"center",gap:4,background:C.bg,border:`1px solid ${C.border}`,borderRadius:20,padding:"2px 8px"}}>
              <span style={{width:6,height:6,borderRadius:"50%",background:{connecting:C.yellow,ok:C.green,error:C.red}[fbStatus],boxShadow:`0 0 4px ${{connecting:C.yellow,ok:C.green,error:C.red}[fbStatus]}`}}/>
              <span style={{fontSize:10,color:C.textSm}}>{fbStatus==="ok"?"en vivo":fbStatus==="error"?"sin conexión":"conectando"}</span>
            </div>
          </div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>setReclamoForm(emptyForm())} style={{...btnDanger,padding:"5px 12px",fontSize:12}}>+ Nuevo Reclamo</button>
            <button onClick={fetchOrders} disabled={ordersStatus==="loading"} style={{...btnSecondary,fontSize:12,opacity:ordersStatus==="loading"?0.6:1}}>
              {ordersStatus==="loading"?"⟳ Sincronizando...":"⟳ Sincronizar"}
            </button>
          </div>
        </div>
      </div>

      <div style={{maxWidth:1200,margin:"0 auto",padding:"0 24px"}}>
        {/* Stats */}
        <div style={{display:"flex",gap:8,flexWrap:"wrap",padding:"16px 0 0"}}>
          <StatCard label="Pedidos" value={orders.length} color={C.accent}/>
          <StatCard label="Reclamos" value={stats.total} color={C.textMd}/>
          <StatCard label="Pendientes" value={stats.pendientes} color={C.accent}/>
          <StatCard label="En proceso" value={stats.enProceso} color={C.yellow}/>
          <StatCard label="Resueltos" value={stats.resueltos} color={C.green}/>
          <StatCard label="Rechazados" value={stats.rechazados} color={C.red}/>
        </div>

        {/* Tabs */}
        <div style={{display:"flex",borderBottom:`1px solid ${C.border}`,marginTop:16}}>
          {TABS.map(t=>(
            <button key={t.id} onClick={()=>{setTab(t.id);setSearch("");setFilterEnvio("");setFilterReclamo("");}}
              style={{padding:"10px 18px",fontSize:13,fontWeight:tab===t.id?600:400,color:tab===t.id?C.text:C.textMd,background:"none",border:"none",borderBottom:tab===t.id?`2px solid ${C.accent}`:"2px solid transparent",cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",display:"flex",alignItems:"center",gap:6,marginBottom:-1}}>
              {t.icon} {t.label}
              {t.id==="reclamos"&&stats.pendientes>0&&<span style={{background:C.accent,color:"#000",fontSize:10,fontWeight:700,borderRadius:10,padding:"1px 6px"}}>{stats.pendientes}</span>}
            </button>
          ))}
        </div>

        {/* Filters */}
        <div style={{padding:"10px 0 6px",display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
          <div style={{position:"relative",flex:"1 1 240px",minWidth:200}}>
            <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",color:C.textSm,fontSize:12}}>🔍</span>
            <input placeholder="Buscar..." value={search} onChange={e=>setSearch(e.target.value)} style={{...iSt,paddingLeft:30,fontSize:12}} onFocus={e=>e.target.style.borderColor=C.accent} onBlur={e=>e.target.style.borderColor=C.border}/>
          </div>
          {tab==="pedidos"&&<select value={filterEnvio} onChange={e=>setFilterEnvio(e.target.value)} style={{...selSt,width:"auto",flex:"0 1 170px",fontSize:12,color:filterEnvio?C.accent:C.textMd}}><option value="">Estado envío</option>{Object.keys(ESTADO_ENVIO_C).map(e=><option key={e}>{e}</option>)}</select>}
          {tab==="reclamos"&&<select value={filterReclamo} onChange={e=>setFilterReclamo(e.target.value)} style={{...selSt,width:"auto",flex:"0 1 150px",fontSize:12,color:filterReclamo?C.accent:C.textMd}}><option value="">Estado</option>{ESTADOS_R.map(e=><option key={e}>{e}</option>)}</select>}
          <span style={{fontSize:11,color:C.textSm,marginLeft:"auto"}}>{tab==="pedidos"?`${filteredOrders.length} pedidos`:`${filteredReclamos.length} reclamos`}</span>
        </div>

        {/* Pedidos Table */}
        {tab==="pedidos"&&(
          <div style={{paddingBottom:40}}>
            {orders.length===0?(
              <div style={{textAlign:"center",padding:"60px 20px",color:C.textSm}}>
                <div style={{fontSize:32,marginBottom:12}}>{ordersStatus==="loading"?"⟳":"📦"}</div>
                <div style={{fontSize:14,color:C.textMd}}>{ordersStatus==="loading"?"Cargando pedidos...":ordersStatus==="error"?"Error al cargar":"Sin pedidos"}</div>
              </div>
            ):(
              <>
                <div style={{display:"grid",gridTemplateColumns:"80px 1fr 1fr 160px 110px 70px",gap:8,padding:"6px 12px",fontSize:11,color:C.textSm,fontWeight:500,textTransform:"uppercase",letterSpacing:0.5,borderBottom:`1px solid ${C.borderL}`}}>
                  <span>Pedido</span><span>Cliente</span><span>Productos</span><span>Estado</span><span>Total</span><span>Fecha</span>
                </div>
                {filteredOrders.map(o=>{
                  const hasR=reclamos.some(r=>r.orderNum===o.numero);
                  const ec=ESTADO_ENVIO_C[o.estadoEnvio]||{bg:C.borderL,text:C.textSm,dot:C.textSm};
                  return (
                    <div key={o.numero} onClick={()=>setSelectedOrder(o.numero)} style={{display:"grid",gridTemplateColumns:"80px 1fr 1fr 160px 110px 70px",gap:8,padding:"10px 12px",borderBottom:`1px solid ${C.borderL}`,cursor:"pointer",transition:"background 0.1s",alignItems:"center"}} onMouseEnter={e=>e.currentTarget.style.background=C.surface} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                      <div style={{display:"flex",alignItems:"center",gap:5}}>
                        <span style={{fontWeight:600,color:C.accent,fontSize:13}}>#{o.numero}</span>
                        {hasR&&<span style={{color:C.red,fontSize:10}} title="Tiene reclamo">⚠</span>}
                      </div>
                      <div><div style={{fontSize:13,fontWeight:500}}>{o.comprador}</div><div style={{fontSize:11,color:C.textSm}}>{o.email}</div></div>
                      <div style={{display:"flex",alignItems:"center",gap:5}}><LensDots productos={o.productos}/><span style={{fontSize:11,color:C.textSm,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{o.productos.map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'')).join(', ')}</span></div>
                      <Badge colors={ec}>{o.estadoEnvio}</Badge>
                      <span style={{fontSize:13,fontWeight:600}}>{fmtMoney(o.total)}</span>
                      <span style={{fontSize:11,color:C.textSm}}>{fmtDate(o.fecha).split('/').slice(0,2).join('/')}</span>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}

        {/* Reclamos Table */}
        {tab==="reclamos"&&(
          <div style={{paddingBottom:40}}>
            {filteredReclamos.length===0?(
              <div style={{textAlign:"center",padding:"60px 20px",color:C.textSm}}>
                <div style={{fontSize:32,marginBottom:10}}>📋</div>
                <div style={{fontSize:14,color:C.textMd}}>{reclamos.length===0?"Sin reclamos todavía":"Sin resultados"}</div>
              </div>
            ):(
              <>
                <div style={{display:"grid",gridTemplateColumns:"80px 1fr 1fr 120px 110px 80px",gap:8,padding:"6px 12px",fontSize:11,color:C.textSm,fontWeight:500,textTransform:"uppercase",letterSpacing:0.5,borderBottom:`1px solid ${C.borderL}`}}>
                  <span>Pedido</span><span>Cliente</span><span>Motivo</span><span>Estado</span><span>Tipo</span><span>Fecha</span>
                </div>
                {filteredReclamos.map(r=>{
                  const o=orders.find(o=>o.numero===r.orderNum);
                  const sc=ESTADO_R_C[r.estado]||{bg:C.borderL,text:C.textSm,dot:C.textSm};
                  return (
                    <div key={r._docId} onClick={()=>setReclamoDetail(r._docId)} style={{display:"grid",gridTemplateColumns:"80px 1fr 1fr 120px 110px 80px",gap:8,padding:"10px 12px",borderBottom:`1px solid ${C.borderL}`,cursor:"pointer",transition:"background 0.1s",alignItems:"center",borderLeft:`3px solid ${sc.dot}`}} onMouseEnter={e=>e.currentTarget.style.background=C.surface} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                      <span style={{fontWeight:600,color:C.accent,fontSize:13}}>#{r.orderNum}</span>
                      <div><div style={{fontSize:13,fontWeight:500}}>{o?.comprador||"—"}</div><div style={{fontSize:11,color:C.textSm}}>{o?.email||""}</div></div>
                      <span style={{fontSize:12,color:C.textMd}}>{r.motivo}</span>
                      <Badge colors={sc}>{r.estado}</Badge>
                      <Badge colors={TIPO_R_C[r.tipo]||{bg:C.borderL,text:C.textSm,dot:C.textSm}}>{r.tipo}</Badge>
                      <span style={{fontSize:11,color:C.textSm}}>{fmtTs(r.createdAt)}</span>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}
      </div>

      {/* Order Detail Modal */}
      <Modal open={!!selOrder} onClose={()=>setSelectedOrder(null)} title={selOrder?`Pedido #${selOrder.numero}`:""} width={600}>
        {selOrder&&(
          <div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:14}}>
              <button onClick={()=>{setSelectedOrder(null);setReclamoForm(emptyForm(selOrder.numero));}} style={{...btnDanger,fontSize:12}}>📋 Crear Reclamo</button>
              <button onClick={()=>setActionModal({type:"direccion",order:selOrder})} style={{...btnSecondary,fontSize:12}}>📍 Dirección</button>
              <button onClick={()=>setActionModal({type:"etiqueta",order:selOrder})} style={{...btnSecondary,fontSize:12,color:C.accent}}>🏷️ Andreani</button>
              {selOrder.linkOrden&&<a href={selOrder.linkOrden} target="_blank" rel="noopener noreferrer" style={{...btnSecondary,fontSize:12,textDecoration:"none",color:C.purple}}>🔗 Tienda Nube</a>}
            </div>
            <Divider/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"5px 24px",fontSize:13,marginBottom:12}}>
              {[["Cliente",selOrder.comprador],["Email",selOrder.email],["Teléfono",selOrder.telefono],["DNI/CUIT",selOrder.dni],["Fecha",fmtDate(selOrder.fecha)],["Pago",selOrder.medioPago],["Estado pago",selOrder.estadoPago],["Estado envío",selOrder.estadoEnvio],["Tracking",selOrder.tracking||"—"]].map(([l,v])=>v?(
                <div key={l} style={{display:"flex",gap:8,padding:"3px 0",borderBottom:`1px solid ${C.borderL}`}}>
                  <span style={{color:C.textSm,minWidth:85,flexShrink:0,fontSize:12}}>{l}</span>
                  <span style={{color:C.text,fontSize:12,fontWeight:500}}>{v}</span>
                </div>
              ):null)}
            </div>
            <Divider/>
            <div style={{fontSize:11,textTransform:"uppercase",color:C.textSm,fontWeight:500,letterSpacing:0.5,marginBottom:8}}>Productos</div>
            {selOrder.productos.map((p,i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:i<selOrder.productos.length-1?`1px solid ${C.borderL}`:"none"}}>
                <div><div style={{fontSize:13}}>{p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'')}</div><div style={{fontSize:11,color:C.textSm}}>SKU: {p.sku} · x{p.cantidad}</div></div>
                <span style={{fontSize:13,fontWeight:600}}>{fmtMoney(p.precio)}</span>
              </div>
            ))}
            <div style={{display:"flex",justifyContent:"flex-end",marginTop:8,paddingTop:8,borderTop:`1px solid ${C.border}`}}>
              <span style={{fontSize:15,fontWeight:700}}>{fmtMoney(selOrder.total)}</span>
            </div>
            {reclamos.filter(r=>r.orderNum===selOrder.numero).length>0&&(
              <>
                <Divider/>
                <div style={{fontSize:11,textTransform:"uppercase",color:C.red,fontWeight:500,letterSpacing:0.5,marginBottom:8}}>Reclamos asociados</div>
                {reclamos.filter(r=>r.orderNum===selOrder.numero).map(r=>(
                  <div key={r._docId} onClick={()=>{setSelectedOrder(null);setReclamoDetail(r._docId);setTab("reclamos");}} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",cursor:"pointer",borderBottom:`1px solid ${C.borderL}`}}>
                    <div style={{display:"flex",gap:6,alignItems:"center"}}><Badge colors={ESTADO_R_C[r.estado]||{}} small>{r.estado}</Badge><span style={{fontSize:12,color:C.textMd}}>{r.tipo} — {r.motivo}</span></div>
                    <span style={{color:C.accent,fontSize:11}}>→</span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </Modal>

      {/* Direccion Modal */}
      <Modal open={actionModal?.type==="direccion"} onClose={()=>setActionModal(null)} title="Dirección de Envío">
        {actionModal?.order&&(
          <div>
            <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:20,marginBottom:14}}>
              <div style={{fontSize:16,fontWeight:600,marginBottom:12}}>{actionModal.order.nombreEnvio}</div>
              <div style={{fontSize:14,lineHeight:2,color:C.textMd}}>
                <div>{actionModal.order.direccion} {actionModal.order.dirNumero}{actionModal.order.piso?`, Piso ${actionModal.order.piso}`:''}</div>
                <div>{actionModal.order.localidad}{actionModal.order.ciudad?`, ${actionModal.order.ciudad}`:''}</div>
                <div style={{color:C.text,fontWeight:500}}>CP {actionModal.order.cp} — {actionModal.order.provincia}</div>
                <div style={{marginTop:4}}>📞 {actionModal.order.telEnvio||actionModal.order.telefono}</div>
              </div>
            </div>
            <button onClick={()=>navigator.clipboard.writeText(fullAddress(actionModal.order))} style={{...btnSecondary,width:"100%",justifyContent:"center"}}>📋 Copiar dirección</button>
          </div>
        )}
      </Modal>

      {/* Etiqueta Modal */}
      <Modal open={actionModal?.type==="etiqueta"} onClose={()=>setActionModal(null)} title="Etiqueta Andreani" width={460}>
        {actionModal?.order&&(
          <div>
            <div style={{border:`1px dashed ${C.accent}`,borderRadius:8,padding:20,background:C.bg,marginBottom:14}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:14}}>
                <div><div style={{fontSize:10,textTransform:"uppercase",color:C.accent,fontWeight:600,letterSpacing:1}}>Remitente</div><div style={{fontSize:14,fontWeight:600,marginTop:4}}>Soluna Biolight</div></div>
                <div style={{fontSize:11,color:C.textSm,fontFamily:"monospace"}}>#{actionModal.order.numero}</div>
              </div>
              <div style={{borderTop:`1px solid ${C.border}`,paddingTop:14}}>
                <div style={{fontSize:10,textTransform:"uppercase",color:C.accent,fontWeight:600,letterSpacing:1,marginBottom:8}}>Destinatario</div>
                <div style={{fontSize:16,fontWeight:700,marginBottom:8}}>{actionModal.order.nombreEnvio}</div>
                <div style={{fontSize:13,lineHeight:1.8,color:C.textMd}}>
                  <div>{actionModal.order.direccion} {actionModal.order.dirNumero}{actionModal.order.piso?`, Piso ${actionModal.order.piso}`:''}</div>
                  <div>{actionModal.order.localidad}{actionModal.order.ciudad?` — ${actionModal.order.ciudad}`:''}</div>
                  <div style={{color:C.text,fontWeight:500}}>CP {actionModal.order.cp} — {actionModal.order.provincia}</div>
                  <div style={{marginTop:4}}>Tel: {actionModal.order.telEnvio||actionModal.order.telefono}</div>
                </div>
              </div>
              {actionModal.order.tracking&&<div style={{marginTop:14,paddingTop:12,borderTop:`1px solid ${C.border}`}}><div style={{fontSize:10,color:C.accent,fontWeight:600,textTransform:"uppercase",letterSpacing:1}}>Tracking</div><div style={{fontSize:15,fontWeight:700,fontFamily:"monospace",marginTop:4}}>{actionModal.order.tracking}</div></div>}
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>{ const t=`DESTINATARIO: ${actionModal.order.nombreEnvio}\n${actionModal.order.direccion} ${actionModal.order.dirNumero}${actionModal.order.piso?', Piso '+actionModal.order.piso:''}\n${actionModal.order.localidad}${actionModal.order.ciudad?' — '+actionModal.order.ciudad:''}\nCP ${actionModal.order.cp} — ${actionModal.order.provincia}\nTel: ${actionModal.order.telEnvio||actionModal.order.telefono}\nPedido #${actionModal.order.numero}`; navigator.clipboard.writeText(t); }} style={{...btnSecondary,flex:1,justifyContent:"center"}}>📋 Copiar</button>
              <button onClick={()=>window.print()} style={{...btnSecondary,flex:1,justifyContent:"center"}}>🖨️ Imprimir</button>
            </div>
          </div>
        )}
      </Modal>

      {/* Reclamo Form Modal */}
      <Modal open={!!reclamoForm} onClose={()=>setReclamoForm(null)} title={reclamoForm?._docId?"Editar Reclamo":reclamoForm?.orderNum?`Nuevo Reclamo — #${reclamoForm.orderNum}`:"Nuevo Reclamo"}>
        {reclamoForm&&(
          <div>
            {!reclamoForm._docId&&!reclamoForm.orderNum&&<Field label="Pedido" required><OrderSearchField orders={orders} onSelect={num=>setReclamoForm(f=>({...f,orderNum:num}))}/></Field>}
            {(()=>{const o=orders.find(o=>o.numero===reclamoForm.orderNum);return o?(
              <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:6,padding:"9px 12px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div><span style={{fontWeight:600,fontSize:13}}>#{o.numero} — {o.comprador}</span><div style={{color:C.textSm,fontSize:11,marginTop:2}}>{o.productos.map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'')).join(', ')}</div></div>
                {!reclamoForm._docId&&<button onClick={()=>setReclamoForm(f=>({...f,orderNum:""}))} style={{...btnDanger,padding:"3px 8px",fontSize:11}}>Cambiar</button>}
              </div>
            ):null;})()}
            {reclamoForm.orderNum&&(
              <>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 12px"}}>
                  <Field label="Tipo"><select style={selSt} value={reclamoForm.tipo} onChange={e=>setReclamoForm(f=>({...f,tipo:e.target.value}))}>{TIPOS_R.map(t=><option key={t}>{t}</option>)}</select></Field>
                  <Field label="Motivo" required><select style={selSt} value={reclamoForm.motivo} onChange={e=>setReclamoForm(f=>({...f,motivo:e.target.value}))}><option value="">Seleccionar...</option>{MOTIVOS_R.map(m=><option key={m}>{m}</option>)}</select></Field>
                </div>
                {reclamoForm.tipo==="Cambio"&&(
                  <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:14,marginBottom:12}}>
                    <div style={{fontSize:11,textTransform:"uppercase",color:C.purple,fontWeight:600,letterSpacing:0.5,marginBottom:10}}>🔄 Detalle del cambio</div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 16px"}}>
                      {["Recibe","Envía"].map((label,side)=>{
                        const key=side===0?"productosRecibe":"productosEnvia";
                        const items=reclamoForm[key]||[];
                        return (
                          <div key={label}>
                            <div style={{fontSize:11,color:C.textSm,fontWeight:500,marginBottom:6,textTransform:"uppercase"}}>{side===0?"Nos devuelve":"Le enviamos"}</div>
                            {items.map((item,i)=>(
                              <div key={i} style={{display:"flex",gap:4,marginBottom:6,alignItems:"center"}}>
                                <select style={{...selSt,flex:1,fontSize:11,padding:"5px 7px"}} value={item.producto} onChange={e=>{const arr=[...items];arr[i]={...arr[i],producto:e.target.value};setReclamoForm(f=>({...f,[key]:arr}));}}><option value="">Producto...</option>{PRODUCTOS.map(p=><option key={p}>{p}</option>)}</select>
                                <input type="number" min={1} value={item.cantidad} onChange={e=>{const arr=[...items];arr[i]={...arr[i],cantidad:parseInt(e.target.value)||1};setReclamoForm(f=>({...f,[key]:arr}));}} style={{...iSt,width:44,textAlign:"center",fontSize:11,padding:"5px 3px",flexShrink:0}}/>
                                {items.length>1&&<button onClick={()=>setReclamoForm(f=>({...f,[key]:f[key].filter((_,j)=>j!==i)}))} style={{...btnDanger,padding:"3px 6px",fontSize:11,flexShrink:0}}>✕</button>}
                              </div>
                            ))}
                            <button onClick={()=>setReclamoForm(f=>({...f,[key]:[...(f[key]||[]),{producto:"",cantidad:1}]}))} style={{...btnSecondary,width:"100%",justifyContent:"center",fontSize:11,padding:"4px"}}>+ Agregar</button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                <Field label="Descripción"><textarea style={{...iSt,minHeight:60,resize:"vertical"}} value={reclamoForm.descripcion} onChange={e=>setReclamoForm(f=>({...f,descripcion:e.target.value}))} placeholder="Detalle del reclamo..."/></Field>
                {reclamoForm._docId&&(
                  <Field label="Estado">
                    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                      {ESTADOS_R.map(e=>{const c=ESTADO_R_C[e];const sel=reclamoForm.estado===e;return <button key={e} onClick={()=>setReclamoForm(f=>({...f,estado:e}))} style={{...btnBase,padding:"6px 12px",fontSize:12,background:sel?c.bg:C.surface,color:sel?c.text:C.textMd,border:`1px solid ${sel?c.dot:C.border}`,fontWeight:sel?600:400}}><span style={{width:7,height:7,borderRadius:"50%",background:sel?c.dot:C.textSm}}/>{e}</button>;})}
                    </div>
                  </Field>
                )}
                {reclamoForm._docId&&<Field label="Resolución"><textarea style={{...iSt,minHeight:50,resize:"vertical"}} value={reclamoForm.resolucion} onChange={e=>setReclamoForm(f=>({...f,resolucion:e.target.value}))} placeholder="Qué se hizo..."/></Field>}
                <Field label="Notas internas"><textarea style={{...iSt,minHeight:44,resize:"vertical"}} value={reclamoForm.notas} onChange={e=>setReclamoForm(f=>({...f,notas:e.target.value}))} placeholder="Notas para el equipo..."/></Field>
                <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:8}}>
                  <button onClick={()=>setReclamoForm(null)} style={btnSecondary}>Cancelar</button>
                  <button onClick={saveReclamo} disabled={saving||!reclamoForm.motivo} style={{...btnPrimary,opacity:saving||!reclamoForm.motivo?0.5:1}}>{saving?"Guardando...":(reclamoForm._docId?"Guardar":"Crear Reclamo")}</button>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>

      {/* Reclamo Detail Modal */}
      <Modal open={!!detailR} onClose={()=>setReclamoDetail(null)} title={detailR?`Reclamo — Pedido #${detailR.orderNum}`:""}>
        {detailR&&(()=>{
          const r=detailR;const o=orders.find(o=>o.numero===r.orderNum);
          const sc=ESTADO_R_C[r.estado]||{};const tc=TIPO_R_C[r.tipo]||{};
          return (
            <div>
              <div style={{background:sc.bg,border:`1px solid ${sc.dot||sc.text}44`,borderRadius:8,padding:"12px 16px",marginBottom:14,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}><span style={{width:10,height:10,borderRadius:"50%",background:sc.dot,boxShadow:`0 0 6px ${sc.dot}`}}/><span style={{fontSize:15,fontWeight:600,color:sc.text}}>{r.estado}</span></div>
                <span style={{background:tc.bg,color:tc.text,padding:"3px 10px",borderRadius:20,fontSize:11,fontWeight:500}}>{r.tipo}</span>
              </div>
              {o&&<div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 14px",marginBottom:12}}><div style={{fontWeight:600,fontSize:13}}>#{o.numero} — {o.comprador}</div><div style={{fontSize:11,color:C.textSm,marginTop:3}}>{o.email} · {o.telefono}</div><div style={{fontSize:11,color:C.textSm,marginTop:1}}>{o.productos.map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'')).join(', ')}</div></div>}
              <div style={{fontSize:13,marginBottom:10}}><span style={{color:C.textSm}}>Motivo: </span><span style={{fontWeight:500}}>{r.motivo}</span></div>
              {r.tipo==="Cambio"&&((r.productosRecibe?.length>0)||(r.productosEnvia?.length>0))&&(
                <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:14,marginBottom:10}}>
                  <div style={{fontSize:10,textTransform:"uppercase",color:C.purple,fontWeight:600,letterSpacing:0.5,marginBottom:10}}>🔄 Detalle del cambio</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr auto 1fr",gap:10,alignItems:"start"}}>
                    <div><div style={{fontSize:10,color:C.textSm,fontWeight:500,textTransform:"uppercase",marginBottom:5}}>Nos devuelve</div>{(r.productosRecibe||[]).map((item,i)=><div key={i} style={{fontSize:13,fontWeight:500,color:C.red,marginBottom:2}}>{item.cantidad>1&&<span style={{color:C.textSm,fontSize:11}}>{item.cantidad}× </span>}{item.producto||"—"}</div>)}</div>
                    <div style={{color:C.textSm,paddingTop:18,fontSize:16}}>→</div>
                    <div><div style={{fontSize:10,color:C.textSm,fontWeight:500,textTransform:"uppercase",marginBottom:5}}>Le enviamos</div>{(r.productosEnvia||[]).map((item,i)=><div key={i} style={{fontSize:13,fontWeight:500,color:C.green,marginBottom:2}}>{item.cantidad>1&&<span style={{color:C.textSm,fontSize:11}}>{item.cantidad}× </span>}{item.producto||"—"}</div>)}</div>
                  </div>
                </div>
              )}
              {r.descripcion&&<div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:12,marginBottom:8,fontSize:13,color:C.textMd,lineHeight:1.5}}>{r.descripcion}</div>}
              {r.resolucion&&<div style={{background:C.greenBg,border:`1px solid ${C.green}33`,borderRadius:8,padding:12,marginBottom:8}}><div style={{fontSize:10,textTransform:"uppercase",color:C.green,fontWeight:600,marginBottom:4}}>Resolución</div><div style={{fontSize:13,lineHeight:1.5}}>{r.resolucion}</div></div>}
              {r.notas&&<div style={{background:C.yellowBg,border:`1px solid ${C.yellow}33`,borderRadius:8,padding:12,marginBottom:8}}><div style={{fontSize:10,textTransform:"uppercase",color:C.yellow,fontWeight:600,marginBottom:4}}>Notas internas</div><div style={{fontSize:13,lineHeight:1.5}}>{r.notas}</div></div>}
              <div style={{fontSize:11,color:C.textSm,marginTop:10}}>Creado: {fmtTs(r.createdAt)}{r.resolvedAt?.seconds?` · Resuelto: ${fmtTs(r.resolvedAt)}`:''}</div>
              <Divider/>
              <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
                {deleteConfirm===r._docId?(
                  <div style={{display:"flex",gap:6,alignItems:"center"}}><span style={{fontSize:12,color:C.red}}>¿Eliminar?</span><button onClick={()=>deleteReclamo(r._docId)} style={{...btnDanger,padding:"5px 12px",fontSize:12}}>Sí</button><button onClick={()=>setDeleteConfirm(null)} style={{...btnSecondary,padding:"5px 12px",fontSize:12}}>No</button></div>
                ):(
                  <><button onClick={()=>setDeleteConfirm(r._docId)} style={{...btnDanger,padding:"6px 12px",fontSize:12}}>Eliminar</button><button onClick={()=>{setReclamoDetail(null);setReclamoForm({...r});}} style={{...btnSecondary,padding:"6px 12px",fontSize:12}}>Editar</button></>
                )}
              </div>
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}

// ═══════════════════════════════════════════════
// ── APP CANJES ──
// ═══════════════════════════════════════════════
function AppCanjes({fbStatus,onHome}) {
  const [canjes,setCanjes]=useState([]);
  const [form,setForm]=useState(null);
  const [detail,setDetail]=useState(null);
  const [search,setSearch]=useState("");
  const [filterEstado,setFilterEstado]=useState("");
  const [filterRed,setFilterRed]=useState("");
  const [deleteConfirm,setDeleteConfirm]=useState(null);
  const [saving,setSaving]=useState(false);

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
        await updateDoc(doc(db,"canjes",form._docId),{...p,updatedAt:serverTimestamp(),...(form.estado==="Finalizado"&&canjes.find(c=>c._docId===form._docId)?.estado!=="Finalizado"?{finalizadoAt:serverTimestamp()}:{})});
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

  const stats={
    total:canjes.length,
    pendientes:canjes.filter(c=>c.estado==="Pendiente envío").length,
    enviados:canjes.filter(c=>c.estado==="Enviado").length,
    contenidoPendiente:canjes.filter(c=>c.estado==="Contenido pendiente").length,
    publicados:canjes.filter(c=>c.estado==="Contenido publicado").length,
    finalizados:canjes.filter(c=>c.estado==="Finalizado").length,
  };

  const detailC=canjes.find(c=>c._docId===detail);

  return (
    <div style={{fontFamily:"'Inter',system-ui,sans-serif",background:C.bg,minHeight:"100vh",color:C.text}}>
      {/* Topbar */}
      <div style={{borderBottom:`1px solid ${C.border}`,background:C.surface,padding:"0 24px",position:"sticky",top:0,zIndex:100}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",height:52,gap:16,maxWidth:1200,margin:"0 auto"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <button onClick={onHome} style={{...btnSecondary,padding:"4px 8px",fontSize:12}}>← Inicio</button>
            <span style={{color:C.textSm,fontSize:13}}>/</span>
            <span style={{fontWeight:600,fontSize:14,color:C.text}}>🤝 Canjes</span>
            <div style={{display:"flex",alignItems:"center",gap:4,background:C.bg,border:`1px solid ${C.border}`,borderRadius:20,padding:"2px 8px"}}>
              <span style={{width:6,height:6,borderRadius:"50%",background:{connecting:C.yellow,ok:C.green,error:C.red}[fbStatus],boxShadow:`0 0 4px ${{connecting:C.yellow,ok:C.green,error:C.red}[fbStatus]}`}}/>
              <span style={{fontSize:10,color:C.textSm}}>{fbStatus==="ok"?"en vivo":"conectando"}</span>
            </div>
          </div>
          <button onClick={()=>setForm(emptyForm())} style={{...btnPurple,padding:"5px 12px",fontSize:12}}>+ Nuevo Canje</button>
        </div>
      </div>

      <div style={{maxWidth:1200,margin:"0 auto",padding:"0 24px"}}>
        {/* Stats */}
        <div style={{display:"flex",gap:8,flexWrap:"wrap",padding:"16px 0 0"}}>
          <StatCard label="Total canjes" value={stats.total} color={C.textMd}/>
          <StatCard label="Pend. envío" value={stats.pendientes} color={C.yellow}/>
          <StatCard label="Enviados" value={stats.enviados} color={C.accent}/>
          <StatCard label="Cont. pendiente" value={stats.contenidoPendiente} color={C.orange}/>
          <StatCard label="Publicados" value={stats.publicados} color={C.purple}/>
          <StatCard label="Finalizados" value={stats.finalizados} color={C.green}/>
        </div>

        {/* Filters */}
        <div style={{padding:"14px 0 6px",display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
          <div style={{position:"relative",flex:"1 1 240px",minWidth:200}}>
            <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",color:C.textSm,fontSize:12}}>🔍</span>
            <input placeholder="Buscar influencer, usuario, email..." value={search} onChange={e=>setSearch(e.target.value)} style={{...iSt,paddingLeft:30,fontSize:12}} onFocus={e=>e.target.style.borderColor=C.accent} onBlur={e=>e.target.style.borderColor=C.border}/>
          </div>
          <select value={filterEstado} onChange={e=>setFilterEstado(e.target.value)} style={{...selSt,width:"auto",flex:"0 1 170px",fontSize:12,color:filterEstado?C.accent:C.textMd}}><option value="">Estado</option>{ESTADOS_C.map(e=><option key={e}>{e}</option>)}</select>
          <select value={filterRed} onChange={e=>setFilterRed(e.target.value)} style={{...selSt,width:"auto",flex:"0 1 130px",fontSize:12,color:filterRed?C.accent:C.textMd}}><option value="">Red social</option>{REDES.map(r=><option key={r}>{r}</option>)}</select>
          <span style={{fontSize:11,color:C.textSm,marginLeft:"auto"}}>{filtered.length} canjes</span>
        </div>

        {/* Canjes Table */}
        <div style={{paddingBottom:40}}>
          {filtered.length===0?(
            <div style={{textAlign:"center",padding:"60px 20px",color:C.textSm}}>
              <div style={{fontSize:32,marginBottom:10}}>🤝</div>
              <div style={{fontSize:14,color:C.textMd}}>{canjes.length===0?"Sin canjes todavía — agregá el primero":"Sin resultados"}</div>
            </div>
          ):(
            <>
              <div style={{display:"grid",gridTemplateColumns:"1fr 90px 130px 160px 1fr 80px",gap:8,padding:"6px 12px",fontSize:11,color:C.textSm,fontWeight:500,textTransform:"uppercase",letterSpacing:0.5,borderBottom:`1px solid ${C.borderL}`}}>
                <span>Influencer</span><span>Red</span><span>Producto</span><span>Estado</span><span>Actividades</span><span>Fecha</span>
              </div>
              {filtered.map(c=>{
                const sc=ESTADO_C_C[c.estado]||{bg:C.borderL,text:C.textSm,dot:C.textSm};
                return (
                  <div key={c._docId} onClick={()=>setDetail(c._docId)} style={{display:"grid",gridTemplateColumns:"1fr 90px 130px 160px 1fr 80px",gap:8,padding:"10px 12px",borderBottom:`1px solid ${C.borderL}`,cursor:"pointer",transition:"background 0.1s",alignItems:"center",borderLeft:`3px solid ${sc.dot}`}} onMouseEnter={e=>e.currentTarget.style.background=C.surface} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                    <div>
                      <div style={{fontSize:13,fontWeight:500}}>{c.influencer}</div>
                      <div style={{fontSize:11,color:C.accent}}>@{c.usuario}</div>
                      {c.seguidores&&<div style={{fontSize:11,color:C.textSm}}>{Number(c.seguidores).toLocaleString()} seguidores</div>}
                    </div>
                    <span style={{fontSize:12,color:C.textMd}}>{c.red}</span>
                    <span style={{fontSize:12,color:C.textMd,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.producto||"—"}</span>
                    <Badge colors={sc}>{c.estado}</Badge>
                    <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                      {(c.actividades||[]).map((a,i)=><span key={i} style={{fontSize:10,background:C.purpleBg,color:C.purple,border:`1px solid ${C.purple}33`,borderRadius:4,padding:"1px 6px"}}>{a}</span>)}
                    </div>
                    <span style={{fontSize:11,color:C.textSm}}>{fmtTs(c.createdAt)}</span>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>

      {/* Canje Form Modal */}
      <Modal open={!!form} onClose={()=>setForm(null)} title={form?._docId?"Editar Canje":"Nuevo Canje"} width={560}>
        {form&&(
          <div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 12px"}}>
              <Field label="Nombre" required><input style={iSt} value={form.influencer} onChange={e=>setForm(f=>({...f,influencer:e.target.value}))} placeholder="Nombre del influencer"/></Field>
              <Field label="Usuario (@)"><input style={iSt} value={form.usuario} onChange={e=>setForm(f=>({...f,usuario:e.target.value}))} placeholder="@usuario"/></Field>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"0 12px"}}>
              <Field label="Red social"><select style={selSt} value={form.red} onChange={e=>setForm(f=>({...f,red:e.target.value}))}>{REDES.map(r=><option key={r}>{r}</option>)}</select></Field>
              <Field label="Seguidores"><input style={iSt} type="number" value={form.seguidores} onChange={e=>setForm(f=>({...f,seguidores:e.target.value}))} placeholder="50000"/></Field>
              <Field label="Producto enviado"><select style={selSt} value={form.producto} onChange={e=>setForm(f=>({...f,producto:e.target.value}))}><option value="">Seleccionar...</option>{PRODUCTOS_CANJE.map(p=><option key={p}>{p}</option>)}</select></Field>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 12px"}}>
              <Field label="Email"><input style={iSt} type="email" value={form.email} onChange={e=>setForm(f=>({...f,email:e.target.value}))} placeholder="email@ejemplo.com"/></Field>
              <Field label="Teléfono"><input style={iSt} value={form.telefono} onChange={e=>setForm(f=>({...f,telefono:e.target.value}))} placeholder="+54 11..."/></Field>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 12px"}}>
              <Field label="Fecha de envío"><input style={iSt} type="date" value={form.fechaEnvio} onChange={e=>setForm(f=>({...f,fechaEnvio:e.target.value}))}/></Field>
              <Field label="Tracking"><input style={iSt} value={form.tracking} onChange={e=>setForm(f=>({...f,tracking:e.target.value}))} placeholder="Código de seguimiento"/></Field>
            </div>
            <Field label="Actividades comprometidas">
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {ACTIVIDADES.map(a=>{
                  const sel=(form.actividades||[]).includes(a);
                  return <button key={a} onClick={()=>setForm(f=>({...f,actividades:sel?f.actividades.filter(x=>x!==a):[...(f.actividades||[]),a]}))} style={{...btnBase,padding:"5px 10px",fontSize:11,background:sel?C.purpleBg:C.surface,color:sel?C.purple:C.textMd,border:`1px solid ${sel?C.purple:C.border}`,fontWeight:sel?600:400}}>{a}</button>;
                })}
              </div>
            </Field>
            {form._docId&&(
              <>
                <Field label="Estado">
                  <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                    {ESTADOS_C.map(e=>{const c=ESTADO_C_C[e];const sel=form.estado===e;return <button key={e} onClick={()=>setForm(f=>({...f,estado:e}))} style={{...btnBase,padding:"5px 10px",fontSize:11,background:sel?c.bg:C.surface,color:sel?c.text:C.textMd,border:`1px solid ${sel?c.dot:C.border}`,fontWeight:sel?600:400}}><span style={{width:6,height:6,borderRadius:"50%",background:sel?c.dot:C.textSm}}/>{e}</button>;})}
                  </div>
                </Field>
                <Field label="Link del contenido"><input style={iSt} value={form.linkContenido} onChange={e=>setForm(f=>({...f,linkContenido:e.target.value}))} placeholder="https://instagram.com/p/..."/></Field>
                <Field label="Fecha de publicación"><input style={iSt} type="date" value={form.fechaPublicacion} onChange={e=>setForm(f=>({...f,fechaPublicacion:e.target.value}))}/></Field>
              </>
            )}
            <Field label="Notas"><textarea style={{...iSt,minHeight:55,resize:"vertical"}} value={form.notas} onChange={e=>setForm(f=>({...f,notas:e.target.value}))} placeholder="Notas sobre el canje..."/></Field>
            <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:8}}>
              <button onClick={()=>setForm(null)} style={btnSecondary}>Cancelar</button>
              <button onClick={saveCanje} disabled={saving||!form.influencer} style={{...btnPrimary,opacity:saving||!form.influencer?0.5:1}}>{saving?"Guardando...":(form._docId?"Guardar":"Crear Canje")}</button>
            </div>
          </div>
        )}
      </Modal>

      {/* Canje Detail Modal */}
      <Modal open={!!detailC} onClose={()=>setDetail(null)} title={detailC?`Canje — ${detailC.influencer}`:""} width={520}>
        {detailC&&(()=>{
          const c=detailC;const sc=ESTADO_C_C[c.estado]||{};
          return (
            <div>
              <div style={{background:sc.bg,border:`1px solid ${sc.dot||sc.text}44`,borderRadius:8,padding:"12px 16px",marginBottom:14,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}><span style={{width:10,height:10,borderRadius:"50%",background:sc.dot,boxShadow:`0 0 6px ${sc.dot}`}}/><span style={{fontSize:15,fontWeight:600,color:sc.text}}>{c.estado}</span></div>
                <span style={{fontSize:12,color:C.textMd}}>{c.red}</span>
              </div>
              <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"12px 14px",marginBottom:12}}>
                <div style={{fontSize:16,fontWeight:700}}>{c.influencer}</div>
                <div style={{fontSize:13,color:C.accent,marginTop:2}}>@{c.usuario}</div>
                {c.seguidores&&<div style={{fontSize:12,color:C.textSm,marginTop:2}}>{Number(c.seguidores).toLocaleString()} seguidores</div>}
                {c.email&&<div style={{fontSize:12,color:C.textSm,marginTop:2}}>{c.email}</div>}
                {c.telefono&&<div style={{fontSize:12,color:C.textSm,marginTop:1}}>{c.telefono}</div>}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"5px 20px",fontSize:13,marginBottom:12}}>
                {[["Producto",c.producto],["Tracking",c.tracking],["Fecha envío",c.fechaEnvio],["Fecha publicación",c.fechaPublicacion]].map(([l,v])=>v?(
                  <div key={l} style={{display:"flex",gap:8,padding:"4px 0",borderBottom:`1px solid ${C.borderL}`}}>
                    <span style={{color:C.textSm,minWidth:90,flexShrink:0,fontSize:12}}>{l}</span>
                    <span style={{fontSize:12,fontWeight:500}}>{v}</span>
                  </div>
                ):null)}
              </div>
              {c.actividades?.length>0&&(
                <div style={{marginBottom:12}}>
                  <div style={{fontSize:11,textTransform:"uppercase",color:C.textSm,fontWeight:500,letterSpacing:0.5,marginBottom:6}}>Actividades comprometidas</div>
                  <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>{c.actividades.map((a,i)=><span key={i} style={{fontSize:11,background:C.purpleBg,color:C.purple,border:`1px solid ${C.purple}33`,borderRadius:4,padding:"2px 8px"}}>{a}</span>)}</div>
                </div>
              )}
              {c.linkContenido&&<div style={{marginBottom:10}}><div style={{fontSize:11,textTransform:"uppercase",color:C.textSm,fontWeight:500,letterSpacing:0.5,marginBottom:4}}>Link del contenido</div><a href={c.linkContenido} target="_blank" rel="noopener noreferrer" style={{color:C.accent,fontSize:13,wordBreak:"break-all"}}>{c.linkContenido}</a></div>}
              {c.notas&&<div style={{background:C.yellowBg,border:`1px solid ${C.yellow}33`,borderRadius:8,padding:12,marginBottom:8}}><div style={{fontSize:10,textTransform:"uppercase",color:C.yellow,fontWeight:600,marginBottom:4}}>Notas</div><div style={{fontSize:13,lineHeight:1.5}}>{c.notas}</div></div>}
              <div style={{fontSize:11,color:C.textSm,marginTop:10}}>Creado: {fmtTs(c.createdAt)}{c.finalizadoAt?.seconds?` · Finalizado: ${fmtTs(c.finalizadoAt)}`:''}</div>
              <Divider/>
              <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
                {deleteConfirm===c._docId?(
                  <div style={{display:"flex",gap:6,alignItems:"center"}}><span style={{fontSize:12,color:C.red}}>¿Eliminar?</span><button onClick={()=>deleteCanje(c._docId)} style={{...btnDanger,padding:"5px 12px",fontSize:12}}>Sí</button><button onClick={()=>setDeleteConfirm(null)} style={{...btnSecondary,padding:"5px 12px",fontSize:12}}>No</button></div>
                ):(
                  <><button onClick={()=>setDeleteConfirm(c._docId)} style={{...btnDanger,padding:"6px 12px",fontSize:12}}>Eliminar</button><button onClick={()=>{setDetail(null);setForm({...c});}} style={{...btnSecondary,padding:"6px 12px",fontSize:12}}>Editar</button></>
                )}
              </div>
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}

// ═══════════════════════════════════════════════
// ── HOME SCREEN ──
// ═══════════════════════════════════════════════
function HomeScreen({onNavigate,fbStatus,ordersCount,reclamosCount,canjesCount}) {
  return (
    <div style={{fontFamily:"'Inter',system-ui,sans-serif",background:C.bg,minHeight:"100vh",color:C.text,display:"flex",flexDirection:"column"}}>
      {/* Header */}
      <div style={{borderBottom:`1px solid ${C.border}`,background:C.surface,padding:"0 24px"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",height:56,maxWidth:900,margin:"0 auto"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:32,height:32,borderRadius:8,background:"linear-gradient(135deg,#58a6ff,#bc8cff)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>🌙</div>
            <div>
              <div style={{fontWeight:700,fontSize:15,color:C.text}}>Soluna Biolight</div>
              <div style={{fontSize:11,color:C.textSm}}>Panel de Gestión</div>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:6,background:C.bg,border:`1px solid ${C.border}`,borderRadius:20,padding:"4px 10px"}}>
            <span style={{width:7,height:7,borderRadius:"50%",background:{connecting:C.yellow,ok:C.green,error:C.red}[fbStatus],boxShadow:`0 0 5px ${{connecting:C.yellow,ok:C.green,error:C.red}[fbStatus]}`}}/>
            <span style={{fontSize:11,color:C.textSm}}>{fbStatus==="ok"?"Firebase en vivo":fbStatus==="error"?"Sin conexión":"Conectando..."}</span>
          </div>
        </div>
      </div>

      {/* Main */}
      <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"40px 24px"}}>
        <div style={{textAlign:"center",marginBottom:48,maxWidth:480}}>
          <h1 style={{fontSize:28,fontWeight:700,margin:"0 0 10px",letterSpacing:-0.5}}>Bienvenida 👋</h1>
          <p style={{fontSize:15,color:C.textMd,margin:0,lineHeight:1.6}}>Seleccioná una sección para comenzar a gestionar tu negocio.</p>
        </div>

        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20,width:"100%",maxWidth:700}}>
          {/* Reclamos Card */}
          <button onClick={()=>onNavigate("reclamos")} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:28,textAlign:"left",cursor:"pointer",transition:"all 0.2s",fontFamily:"'Inter',system-ui,sans-serif",color:C.text}} onMouseEnter={e=>{e.currentTarget.style.borderColor=C.red;e.currentTarget.style.transform="translateY(-2px)";e.currentTarget.style.boxShadow=`0 8px 24px rgba(0,0,0,0.3)`;}} onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.transform="none";e.currentTarget.style.boxShadow="none";}}>
            <div style={{width:44,height:44,borderRadius:10,background:C.redBg,border:`1px solid ${C.red}33`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,marginBottom:16}}>📋</div>
            <div style={{fontSize:17,fontWeight:700,marginBottom:6}}>Gestión de Reclamos</div>
            <div style={{fontSize:13,color:C.textMd,lineHeight:1.5,marginBottom:16}}>Administrá cambios y devoluciones de productos. Vinculado a tus pedidos de Tienda Nube.</div>
            <div style={{display:"flex",gap:12}}>
              <div style={{textAlign:"center"}}><div style={{fontSize:20,fontWeight:700,color:C.accent}}>{ordersCount}</div><div style={{fontSize:11,color:C.textSm}}>pedidos</div></div>
              <div style={{width:1,background:C.borderL}}/>
              <div style={{textAlign:"center"}}><div style={{fontSize:20,fontWeight:700,color:C.red}}>{reclamosCount}</div><div style={{fontSize:11,color:C.textSm}}>reclamos</div></div>
            </div>
          </button>

          {/* Canjes Card */}
          <button onClick={()=>onNavigate("canjes")} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:28,textAlign:"left",cursor:"pointer",transition:"all 0.2s",fontFamily:"'Inter',system-ui,sans-serif",color:C.text}} onMouseEnter={e=>{e.currentTarget.style.borderColor=C.purple;e.currentTarget.style.transform="translateY(-2px)";e.currentTarget.style.boxShadow=`0 8px 24px rgba(0,0,0,0.3)`;}} onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.transform="none";e.currentTarget.style.boxShadow="none";}}>
            <div style={{width:44,height:44,borderRadius:10,background:C.purpleBg,border:`1px solid ${C.purple}33`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,marginBottom:16}}>🤝</div>
            <div style={{fontSize:17,fontWeight:700,marginBottom:6}}>Gestión de Canjes</div>
            <div style={{fontSize:13,color:C.textMd,lineHeight:1.5,marginBottom:16}}>Seguimiento de influencers, productos enviados, actividades comprometidas y contenido publicado.</div>
            <div style={{display:"flex",gap:12}}>
              <div style={{textAlign:"center"}}><div style={{fontSize:20,fontWeight:700,color:C.purple}}>{canjesCount}</div><div style={{fontSize:11,color:C.textSm}}>canjes</div></div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// ── ROOT APP ──
// ═══════════════════════════════════════════════
export default function App() {
  const [page,setPage]=useState("home"); // home | reclamos | canjes
  const [orders,setOrders]=useState([]);
  const [ordersStatus,setOrdersStatus]=useState("idle");
  const [fbStatus,setFbStatus]=useState("connecting");
  const [reclamosCount,setReclamosCount]=useState(0);
  const [canjesCount,setCanjesCount]=useState(0);

  useEffect(()=>{
    const l=document.createElement("link");
    l.href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap";
    l.rel="stylesheet";
    document.head.appendChild(l);
    document.body.style.margin="0";
    document.body.style.background=C.bg;
  },[]);

  async function fetchOrders() {
    setOrdersStatus("loading");
    try {
      const res=await fetch('/api/orders');
      const data=await res.json();
      const built=buildOrdersFromAPI(data);
      setOrders(built);
      setOrdersStatus("ok");
      localStorage.setItem("soluna_orders_v3",JSON.stringify(built));
    } catch(e){setOrdersStatus("error");}
  }

  useEffect(()=>{
    try{const s=localStorage.getItem("soluna_orders_v3");if(s)setOrders(JSON.parse(s));}catch(e){}
    fetchOrders();
  },[]);

  // Firebase status via reclamos listener
  useEffect(()=>{
    const u1=onSnapshot(collection(db,"reclamos"),snap=>{setReclamosCount(snap.size);setFbStatus("ok");},()=>setFbStatus("error"));
    const u2=onSnapshot(collection(db,"canjes"),snap=>setCanjesCount(snap.size),()=>{});
    return ()=>{u1();u2();};
  },[]);

  if(page==="reclamos") return <AppReclamos orders={orders} ordersStatus={ordersStatus} fetchOrders={fetchOrders} fbStatus={fbStatus} onHome={()=>setPage("home")}/>;
  if(page==="canjes") return <AppCanjes fbStatus={fbStatus} onHome={()=>setPage("home")}/>;
  return <HomeScreen onNavigate={setPage} fbStatus={fbStatus} ordersCount={orders.length} reclamosCount={reclamosCount} canjesCount={canjesCount}/>;
}
