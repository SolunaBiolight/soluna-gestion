import { useState, useEffect, useMemo, useRef } from "react";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ─── Firebase ───
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

// ─── Constants ───
const MOTIVOS = ["Producto dañado","Color incorrecto","No cumple expectativas","Problema con el lente","Error en el pedido","Armazón roto","Otro"];
const ESTADOS_RECLAMO = ["Pendiente","En proceso","Resuelto","Rechazado"];
const TIPOS_RECLAMO = ["Cambio","Devolución"];
const PRODUCTOS = ["Amarillo - Marco Negro","Amarillo - M. Transparente","Naranja - Marco Negro","Naranja - M. Transparente","Rojo - Marco Negro","Rojo - M. Transparente","Clip-On","Líquido Limpia Cristales"];
const SKU_LENTE = { "AMARILLO-NN":"Amarillo","AMARILLO-TT":"Amarillo","NARAN-NN":"Naranja","NARAN-TT":"Naranja","ROJ-NN":"Rojo","ROJ-TT":"Rojo","N-N":"Negro","N-R":"Negro/Rojo","R-R":"Rojo/Rojo","CLIP-ON":"Clip-On","LIQ":"Líquido" };
const LENTE_DOT = { Amarillo:"#eab308", Naranja:"#f97316", Rojo:"#ef4444", Negro:"#333", "Negro/Rojo":"#666", "Rojo/Rojo":"#dc2626", "Clip-On":"#8b5cf6", Líquido:"#06b6d4" };
const ESTADO_ENVIO_COLORS = {
  "No está empaquetado":{ bg:"#fef3c7",text:"#854d0e",dot:"#f59e0b" },
  "Listo para enviar":{ bg:"#dbeafe",text:"#1d4ed8",dot:"#3b82f6" },
  "Enviado":{ bg:"#ede9fe",text:"#6d28d9",dot:"#8b5cf6" },
  "Entregado":{ bg:"#d1fae5",text:"#047857",dot:"#10b981" },
};
const ESTADO_RECLAMO_COLORS = {
  Pendiente:{ bg:"#dbeafe",text:"#1e40af",dot:"#3b82f6" },
  "En proceso":{ bg:"#fef3c7",text:"#92400e",dot:"#f59e0b" },
  Resuelto:{ bg:"#d1fae5",text:"#065f46",dot:"#10b981" },
  Rechazado:{ bg:"#fce4ec",text:"#880e4f",dot:"#e91e63" },
};
const TIPO_COLORS = { Cambio:{ bg:"#e0e7ff",text:"#3730a3" }, Devolución:{ bg:"#fce7f3",text:"#9d174d" } };

// ─── CSV Parser ───
function parseCSV(text) {
  const rows = [];
  let i = 0;
  const len = text.length;
  function parseField() {
    if (i >= len || text[i] === '\n' || text[i] === '\r') return '';
    if (text[i] === '"') {
      i++;
      let val = '';
      while (i < len) {
        if (text[i] === '"') {
          if (i + 1 < len && text[i+1] === '"') { val += '"'; i += 2; }
          else { i++; break; }
        } else { val += text[i]; i++; }
      }
      return val.trim();
    }
    let val = '';
    while (i < len && text[i] !== ';' && text[i] !== '\n' && text[i] !== '\r') { val += text[i]; i++; }
    return val.trim();
  }
  while (i < len) {
    const row = [];
    while (i < len && text[i] !== '\n') {
      row.push(parseField());
      if (i < len && text[i] === ';') i++;
    }
    if (text[i] === '\n') i++;
    if (text[i] === '\r') i++;
    if (row.length > 1) rows.push(row);
  }
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map(r => { const obj = {}; headers.forEach((h,idx) => { obj[h] = r[idx]||''; }); return obj; });
}

function buildOrders(csvRows) {
  const map = {};
  for (const row of csvRows) {
    const num = row['Número de orden'];
    if (!num) continue;
    if (!map[num]) {
      map[num] = {
        numero:num, fecha:row['Fecha']||'', comprador:row['Nombre del comprador']||'',
        email:row['Email']||'', telefono:row['Teléfono']||'', dni:row['DNI / CUIT']||'',
        estadoOrden:row['Estado de la orden']||'', estadoPago:row['Estado del pago']||'',
        estadoEnvio:row['Estado del envío']||'', total:row['Total']||'',
        subtotal:row['Subtotal de productos']||'', descuento:row['Descuento']||'',
        costoEnvio:row['Costo de envío']||'', nombreEnvio:row['Nombre para el envío']||'',
        telEnvio:row['Teléfono para el envío']||'', direccion:row['Dirección']||'',
        dirNumero:row['Número']||'', piso:row['Piso']||'', localidad:row['Localidad']||'',
        ciudad:row['Ciudad']||'', cp:row['Código postal']||'', provincia:row['Provincia o estado']||'',
        medioEnvio:row['Medio de envío']||'', medioPago:row['Medio de pago']||'',
        canal:row['Canal']||'', tracking:(row['Código de tracking del envío']||'').replace(/^="?"?/,'').replace(/"$/,''),
        linkOrden:row['Enlace a la orden']||'', fechaPago:row['Fecha de pago']||'',
        fechaEnvio:row['Fecha de envío']||'', productos:[],
      };
    }
    const prod = row['Nombre del producto'];
    if (prod) map[num].productos.push({ nombre:prod, precio:row['Precio del producto']||'', cantidad:row['Cantidad del producto']||'', sku:row['SKU']||'' });
  }
  return Object.values(map).sort((a,b) => parseInt(b.numero)-parseInt(a.numero));
}

function getLensColors(productos) {
  const colors = new Set();
  for (const p of productos) { const c = SKU_LENTE[p.sku]; if (c) colors.add(c); }
  return [...colors];
}
function fmtMoney(v) { const n = parseFloat(v); if (isNaN(n)) return '—'; return '$'+n.toLocaleString('es-AR',{minimumFractionDigits:0,maximumFractionDigits:0}); }
function fmtDate(d) { if (!d) return '—'; const parts = d.split(' ')[0].split('/'); if (parts.length===3) return `${parts[0]}/${parts[1]}/${parts[2]}`; return d; }
function fullAddress(o) { let addr = o.direccion||''; if (o.dirNumero) addr+=' '+o.dirNumero; if (o.piso) addr+=', Piso '+o.piso; return [addr,o.localidad,o.ciudad,o.cp?`CP ${o.cp}`:'',o.provincia].filter(Boolean).join(', '); }
function fmtTs(ts) { if (!ts?.seconds) return '—'; return new Date(ts.seconds*1000).toLocaleDateString('es-AR'); }

// ─── UI Components ───
function Badge({ colors, children, small }) {
  return <span style={{ display:"inline-flex",alignItems:"center",gap:4,padding:small?"2px 7px":"3px 10px",borderRadius:20,fontSize:small?10:12,fontWeight:600,background:colors.bg,color:colors.text,letterSpacing:0.2,whiteSpace:"nowrap" }}>{colors.dot&&<span style={{ width:6,height:6,borderRadius:"50%",background:colors.dot,flexShrink:0 }}/>}{children}</span>;
}
function LensDots({ productos }) {
  const colors = getLensColors(productos);
  return <span style={{ display:"inline-flex",gap:3,alignItems:"center" }}>{colors.map((c,i)=><span key={i} style={{ width:10,height:10,borderRadius:"50%",background:LENTE_DOT[c]||"#999",border:"1.5px solid rgba(0,0,0,0.1)" }} title={c}/>)}</span>;
}
function Modal({ open, onClose, title, width, children }) {
  if (!open) return null;
  return (
    <div onClick={onClose} style={{ position:"fixed",inset:0,background:"rgba(15,15,30,0.5)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:16 }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:"#fff",borderRadius:18,width:"100%",maxWidth:width||560,maxHeight:"92vh",overflow:"visible",boxShadow:"0 25px 60px rgba(0,0,0,0.2)",display:"flex",flexDirection:"column" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"18px 22px 12px",borderBottom:"1px solid #f0f0f4",background:"#fff",borderRadius:"18px 18px 0 0",flexShrink:0 }}>
          <h2 style={{ margin:0,fontSize:17,fontWeight:700,color:"#1a1a2e" }}>{title}</h2>
          <button onClick={onClose} style={{ background:"#f5f5f8",border:"none",borderRadius:8,width:30,height:30,fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",color:"#888" }}>✕</button>
        </div>
        <div style={{ padding:"14px 22px 22px",overflow:"auto",flex:1 }}>{children}</div>
      </div>
    </div>
  );
}
function Field({ label, children }) {
  return <div style={{ marginBottom:12 }}><label style={{ display:"block",fontSize:11,fontWeight:600,color:"#666",marginBottom:4,letterSpacing:0.3,textTransform:"uppercase" }}>{label}</label>{children}</div>;
}
const iSt = { width:"100%",padding:"9px 11px",borderRadius:9,border:"1.5px solid #e0e0e8",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",boxSizing:"border-box",background:"#fafafe" };
const selSt = { ...iSt,cursor:"pointer",appearance:"auto" };
const btnP = { background:"linear-gradient(135deg,#1a1a2e,#16213e)",color:"#fff",border:"none",borderRadius:10,padding:"10px 20px",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"'DM Sans',sans-serif" };

function OrderSearchField({ orders, onSelect }) {
  const [q, setQ] = useState("");
  const inputRef = useRef(null);
  const results = useMemo(() => {
    if (!q) return [];
    const s = q.toLowerCase();
    return orders.filter(o=>o.numero.includes(s)||o.comprador.toLowerCase().includes(s)||o.email.toLowerCase().includes(s)).slice(0,10);
  }, [q, orders]);
  useEffect(()=>{ if (inputRef.current) inputRef.current.focus(); },[]);
  return (
    <div>
      <div style={{ position:"relative" }}>
        <span style={{ position:"absolute",left:11,top:"50%",transform:"translateY(-50%)",fontSize:13,opacity:0.35 }}>🔍</span>
        <input ref={inputRef} style={{ ...iSt,background:"#fff",paddingLeft:32 }} placeholder="Nro de pedido, nombre o email..." value={q} onChange={e=>setQ(e.target.value)} />
      </div>
      {q.length>0 && results.length>0 && (
        <div style={{ marginTop:6,background:"#fafafe",border:"1.5px solid #e4e4ec",borderRadius:10,maxHeight:280,overflow:"auto" }}>
          {results.map((o,i)=>(
            <div key={o.numero} onClick={()=>onSelect(o.numero)} style={{ padding:"10px 12px",cursor:"pointer",borderTop:i>0?"1px solid #eeeff2":"none",fontSize:13 }} onMouseEnter={e=>e.currentTarget.style.background="#eef0ff"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
                <div><span style={{ fontWeight:700,color:"#1a1a2e" }}>#{o.numero}</span><span style={{ marginLeft:8,color:"#444" }}>{o.comprador}</span></div>
                <span style={{ fontSize:11,color:"#aaa" }}>{fmtDate(o.fecha)}</span>
              </div>
              <div style={{ fontSize:11,color:"#999",marginTop:2 }}>{o.productos.map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'')).join(', ')}</div>
            </div>
          ))}
        </div>
      )}
      {q.length>0 && results.length===0 && <div style={{ marginTop:6,padding:14,textAlign:"center",color:"#aaa",fontSize:13 }}>No se encontró "{q}"</div>}
    </div>
  );
}

const TABS = [{ id:"pedidos",label:"Pedidos",icon:"📦" },{ id:"reclamos",label:"Reclamos",icon:"📋" }];

export default function SolunaGestion() {
  const [orders, setOrders] = useState([]);
  const [reclamos, setReclamos] = useState([]);
  const [fbStatus, setFbStatus] = useState("connecting");
  const [tab, setTab] = useState("pedidos");
  const [search, setSearch] = useState("");
  const [filterEnvio, setFilterEnvio] = useState("");
  const [filterReclamo, setFilterReclamo] = useState("");
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [actionModal, setActionModal] = useState(null);
  const [reclamoForm, setReclamoForm] = useState(null);
  const [reclamoDetail, setReclamoDetail] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);

  useEffect(()=>{ const l=document.createElement("link"); l.href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=Outfit:wght@600;700;800&display=swap"; l.rel="stylesheet"; document.head.appendChild(l); },[]);

  useEffect(()=>{ try { const s=window.localStorage.getItem("soluna_orders_cache"); if(s) setOrders(JSON.parse(s)); } catch(e){} },[]);
  useEffect(()=>{ if(orders.length) window.localStorage.setItem("soluna_orders_cache",JSON.stringify(orders)); },[orders]);

  useEffect(()=>{
    const unsub = onSnapshot(collection(db,"reclamos"), snap=>{
      const data = snap.docs.map(d=>({...d.data(),_docId:d.id}));
      data.sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
      setReclamos(data);
      setFbStatus("ok");
    }, err=>{ console.error(err); setFbStatus("error"); });
    return ()=>unsub();
  },[]);

  function handleFile(e) {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev=>{ setOrders(buildOrders(parseCSV(ev.target.result))); };
    reader.readAsText(file,'ISO-8859-1');
    e.target.value='';
  }

  function getOrderReclamos(num) { return reclamos.filter(r=>r.orderNum===num); }

  const emptyForm = (orderNum="") => ({ _docId:null, orderNum, tipo:"Cambio", motivo:"", descripcion:"", estado:"Pendiente", resolucion:"", notas:"", productosRecibe:[{producto:"",cantidad:1}], productosEnvia:[{producto:"",cantidad:1}] });
  function openNewReclamo(order) { setReclamoForm(emptyForm(order.numero)); }
  function openNewReclamoStandalone() { setReclamoForm(emptyForm()); }

  async function saveReclamo() {
    if (!reclamoForm?.motivo || !reclamoForm?.orderNum) return;
    setSaving(true);
    try {
      const payload = { orderNum:reclamoForm.orderNum, tipo:reclamoForm.tipo, motivo:reclamoForm.motivo, descripcion:reclamoForm.descripcion||"", estado:reclamoForm.estado, resolucion:reclamoForm.resolucion||"", notas:reclamoForm.notas||"", productosRecibe:reclamoForm.productosRecibe||[], productosEnvia:reclamoForm.productosEnvia||[] };
      if (reclamoForm._docId) {
        const prev = reclamos.find(r=>r._docId===reclamoForm._docId);
        await updateDoc(doc(db,"reclamos",reclamoForm._docId), { ...payload, updatedAt:serverTimestamp(), ...(reclamoForm.estado==="Resuelto"&&prev?.estado!=="Resuelto"?{resolvedAt:serverTimestamp()}:{}) });
      } else {
        await addDoc(collection(db,"reclamos"), { ...payload, createdAt:serverTimestamp(), updatedAt:serverTimestamp(), resolvedAt:null });
      }
      setReclamoForm(null);
    } catch(e) { console.error(e); alert("Error al guardar. Revisá la conexión."); }
    setSaving(false);
  }

  async function deleteReclamo(docId) {
    try { await deleteDoc(doc(db,"reclamos",docId)); } catch(e) { console.error(e); }
    setDeleteConfirm(null); setReclamoDetail(null);
  }

  const filteredOrders = useMemo(()=>orders.filter(o=>{
    if (filterEnvio && o.estadoEnvio!==filterEnvio) return false;
    if (search) { const s=search.toLowerCase(); return o.numero.includes(s)||o.comprador.toLowerCase().includes(s)||o.email.toLowerCase().includes(s)||o.productos.some(p=>p.nombre.toLowerCase().includes(s)||p.sku.toLowerCase().includes(s)); }
    return true;
  }),[orders,search,filterEnvio]);

  const filteredReclamos = useMemo(()=>reclamos.filter(r=>{
    if (filterReclamo && r.estado!==filterReclamo) return false;
    if (search) { const s=search.toLowerCase(); const o=orders.find(o=>o.numero===r.orderNum); return r.orderNum.includes(s)||(o&&o.comprador.toLowerCase().includes(s)); }
    return true;
  }),[reclamos,search,filterReclamo,orders]);

  const stats = { totalPedidos:orders.length, reclamosTotal:reclamos.length, reclamosPendientes:reclamos.filter(r=>r.estado==="Pendiente").length, reclamosEnProceso:reclamos.filter(r=>r.estado==="En proceso").length, reclamosResueltos:reclamos.filter(r=>r.estado==="Resuelto").length, reclamosRechazados:reclamos.filter(r=>r.estado==="Rechazado").length };
  const selOrder = orders.find(o=>o.numero===selectedOrder);
  const detailReclamo = reclamos.find(r=>r._docId===reclamoDetail);

  const fbDot = { connecting:"#f59e0b", ok:"#10b981", error:"#ef4444" }[fbStatus];

  return (
    <div style={{ fontFamily:"'DM Sans',sans-serif",background:"linear-gradient(170deg,#f8f7fc 0%,#f0eff8 40%,#eef3f9 100%)",minHeight:"100vh",color:"#1a1a2e" }}>

      {/* ── Header ── */}
      <div style={{ background:"linear-gradient(135deg,#1a1a2e 0%,#16213e 60%,#0f3460 100%)",padding:"24px 24px 18px",color:"#fff" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:10 }}>
          <div>
            <div style={{ fontSize:10,textTransform:"uppercase",letterSpacing:2.5,opacity:0.45,marginBottom:3,fontWeight:600 }}>Soluna Biolight</div>
            <h1 style={{ margin:0,fontSize:26,fontFamily:"'Outfit',sans-serif",fontWeight:800,letterSpacing:-0.8 }}>Centro de Gestión</h1>
            <div style={{ display:"flex",alignItems:"center",gap:6,marginTop:4 }}>
              <span style={{ fontSize:12,opacity:0.5 }}>Pedidos · Reclamos · Envíos</span>
              <span style={{ width:7,height:7,borderRadius:"50%",background:fbDot,boxShadow:`0 0 6px ${fbDot}88`,flexShrink:0 }} title={fbStatus==="ok"?"Firebase OK":fbStatus==="error"?"Sin conexión":"Conectando..."} />
              <span style={{ fontSize:10,opacity:0.4 }}>{fbStatus==="ok"?"sincronizado":fbStatus==="error"?"sin conexión":"conectando..."}</span>
            </div>
          </div>
          <div style={{ display:"flex",gap:8,alignItems:"center",flexWrap:"wrap" }}>
            {orders.length>0 && <button onClick={openNewReclamoStandalone} style={{ background:"linear-gradient(135deg,#dc2626,#b91c1c)",color:"#fff",border:"none",borderRadius:10,padding:"9px 18px",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",display:"flex",alignItems:"center",gap:5,boxShadow:"0 2px 8px rgba(220,38,38,0.3)" }}>📋 Agregar Reclamo</button>}
            <button onClick={()=>fileRef.current?.click()} style={{ background:"rgba(255,255,255,0.12)",color:"#fff",border:"1.5px solid rgba(255,255,255,0.25)",borderRadius:10,padding:"9px 16px",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",backdropFilter:"blur(8px)",display:"flex",alignItems:"center",gap:5 }}>
              📁 {orders.length?"Actualizar CSV":"Importar CSV"}
            </button>
            <input ref={fileRef} type="file" accept=".csv" onChange={handleFile} style={{ display:"none" }} />
          </div>
        </div>
        {orders.length>0 && (
          <div style={{ display:"flex",gap:8,marginTop:16,flexWrap:"wrap" }}>
            {[{l:"Pedidos",v:stats.totalPedidos,a:"#6366f1"},{l:"Reclamos",v:stats.reclamosTotal,a:"#64748b"},{l:"Pendientes",v:stats.reclamosPendientes,a:"#3b82f6"},{l:"En proceso",v:stats.reclamosEnProceso,a:"#f59e0b"},{l:"Resueltos",v:stats.reclamosResueltos,a:"#10b981"},{l:"Rechazados",v:stats.reclamosRechazados,a:"#e91e63"}].map(s=>(
              <div key={s.l} style={{ background:"#fff",borderRadius:12,padding:"14px 16px",border:"1px solid #e8e8ec",flex:"1 1 100px",minWidth:100 }}>
                <div style={{ fontSize:24,fontWeight:800,color:s.a,fontFamily:"'DM Sans',sans-serif" }}>{s.v}</div>
                <div style={{ fontSize:11,color:"#8a8a9a",marginTop:1,fontWeight:500 }}>{s.l}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* No data */}
      {orders.length===0 && (
        <div style={{ textAlign:"center",padding:"80px 20px",color:"#b0b0c0" }}>
          <div style={{ fontSize:56,marginBottom:16 }}>📁</div>
          <div style={{ fontSize:20,fontWeight:700,color:"#555",marginBottom:8 }}>Importá tus pedidos de Tienda Nube</div>
          <div style={{ fontSize:14,maxWidth:400,margin:"0 auto",lineHeight:1.6,marginBottom:20 }}>Exportá tus ventas desde Tienda Nube (Ventas → Exportar) y subí el archivo CSV.</div>
          <button onClick={()=>fileRef.current?.click()} style={{ ...btnP,padding:"14px 32px",fontSize:15 }}>📁 Seleccionar archivo CSV</button>
        </div>
      )}

      {orders.length>0 && (
        <>
          {/* Tabs */}
          <div style={{ display:"flex",padding:"12px 24px 0",borderBottom:"1.5px solid #e8e8f0" }}>
            {TABS.map(t=>(
              <button key={t.id} onClick={()=>{ setTab(t.id); setSearch(""); setFilterEnvio(""); setFilterReclamo(""); }}
                style={{ padding:"10px 20px",fontSize:13,fontWeight:tab===t.id?700:500,color:tab===t.id?"#1a1a2e":"#888",background:"none",border:"none",borderBottom:tab===t.id?"2.5px solid #1a1a2e":"2.5px solid transparent",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",display:"flex",alignItems:"center",gap:6,marginBottom:-1.5 }}>
                {t.icon} {t.label}
                {t.id==="reclamos"&&stats.reclamosPendientes>0&&<span style={{ background:"#3b82f6",color:"#fff",fontSize:10,fontWeight:700,borderRadius:10,padding:"1px 6px" }}>{stats.reclamosPendientes}</span>}
              </button>
            ))}
          </div>

          {/* Filters */}
          <div style={{ padding:"12px 24px 6px",display:"flex",gap:8,flexWrap:"wrap",alignItems:"center" }}>
            <div style={{ position:"relative",flex:"1 1 220px",minWidth:180 }}>
              <span style={{ position:"absolute",left:11,top:"50%",transform:"translateY(-50%)",fontSize:13,opacity:0.35 }}>🔍</span>
              <input placeholder={tab==="pedidos"?"Buscar pedido, cliente, producto...":"Buscar pedido, cliente..."} value={search} onChange={e=>setSearch(e.target.value)} style={{ ...iSt,paddingLeft:32,background:"#fff",border:"1.5px solid #e4e4ec",fontSize:13 }} />
            </div>
            {tab==="pedidos" && <select value={filterEnvio} onChange={e=>setFilterEnvio(e.target.value)} style={{ ...selSt,width:"auto",flex:"0 1 170px",fontSize:12,background:filterEnvio?"#eef0ff":"#fff",borderColor:filterEnvio?"#a5b4fc":"#e4e4ec",color:filterEnvio?"#3730a3":"#666" }}><option value="">Estado envío</option>{Object.keys(ESTADO_ENVIO_COLORS).map(e=><option key={e}>{e}</option>)}</select>}
            {tab==="reclamos" && <select value={filterReclamo} onChange={e=>setFilterReclamo(e.target.value)} style={{ ...selSt,width:"auto",flex:"0 1 150px",fontSize:12,background:filterReclamo?"#eef0ff":"#fff",borderColor:filterReclamo?"#a5b4fc":"#e4e4ec",color:filterReclamo?"#3730a3":"#666" }}><option value="">Estado reclamo</option>{ESTADOS_RECLAMO.map(e=><option key={e}>{e}</option>)}</select>}
          </div>

          {/* ── Pedidos ── */}
          {tab==="pedidos" && (
            <div style={{ padding:"6px 24px 24px" }}>
              <div style={{ fontSize:12,color:"#999",marginBottom:8 }}>{filteredOrders.length} pedidos</div>
              <div style={{ display:"flex",flexDirection:"column",gap:6 }}>
                {filteredOrders.map(o=>{
                  const hasReclamo = reclamos.some(r=>r.orderNum===o.numero);
                  return (
                    <div key={o.numero} onClick={()=>setSelectedOrder(o.numero)} style={{ background:"#fff",borderRadius:13,padding:"14px 18px",border:hasReclamo?"1.5px solid #fca5a5":"1px solid #ebebf0",cursor:"pointer",transition:"all 0.12s",position:"relative" }} onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-1px)";e.currentTarget.style.boxShadow="0 4px 12px rgba(0,0,0,0.06)";}} onMouseLeave={e=>{e.currentTarget.style.transform="none";e.currentTarget.style.boxShadow="none";}}>
                      {hasReclamo&&<span style={{ position:"absolute",top:8,right:12,fontSize:11,color:"#ef4444",fontWeight:700 }}>⚠ Reclamo</span>}
                      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8,flexWrap:"wrap" }}>
                        <div style={{ flex:1,minWidth:150 }}>
                          <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:4 }}>
                            <span style={{ fontWeight:700,fontSize:14 }}>#{o.numero}</span>
                            <span style={{ fontWeight:600,fontSize:14,color:"#444" }}>{o.comprador}</span>
                            <LensDots productos={o.productos} />
                          </div>
                          <div style={{ fontSize:12,color:"#888",marginBottom:5 }}>{o.productos.map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'')).join(' + ')}</div>
                          <div style={{ display:"flex",gap:5,flexWrap:"wrap",alignItems:"center" }}>
                            <Badge colors={ESTADO_ENVIO_COLORS[o.estadoEnvio]||{bg:"#f3f4f6",text:"#666",dot:"#999"}}>{o.estadoEnvio}</Badge>
                            <span style={{ fontSize:12,fontWeight:700,color:"#1a1a2e" }}>{fmtMoney(o.total)}</span>
                            <span style={{ fontSize:11,color:"#bbb" }}>{o.medioPago}</span>
                          </div>
                        </div>
                        <div style={{ fontSize:11,color:"#aaa",whiteSpace:"nowrap" }}>{fmtDate(o.fecha)}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Reclamos ── */}
          {tab==="reclamos" && (
            <div style={{ padding:"6px 24px 24px" }}>
              <div style={{ fontSize:12,color:"#999",marginBottom:8 }}>{filteredReclamos.length} reclamos</div>
              {filteredReclamos.length===0 ? (
                <div style={{ textAlign:"center",padding:"50px 20px",color:"#bbb" }}>
                  <div style={{ fontSize:44,marginBottom:10 }}>📋</div>
                  <div style={{ fontSize:15,fontWeight:600,color:"#888" }}>{reclamos.length===0?"Sin reclamos todavía":"Sin resultados"}</div>
                </div>
              ) : (
                <div style={{ display:"flex",flexDirection:"column",gap:6 }}>
                  {filteredReclamos.map(r=>{
                    const o = orders.find(o=>o.numero===r.orderNum);
                    const sc = ESTADO_RECLAMO_COLORS[r.estado]||{bg:"#eee",text:"#666",dot:"#999"};
                    return (
                      <div key={r._docId} onClick={()=>setReclamoDetail(r._docId)} style={{ background:"#fff",borderRadius:13,padding:"14px 18px",borderLeft:`4px solid ${sc.dot}`,border:`1px solid #ebebf0`,borderLeftWidth:4,borderLeftColor:sc.dot,cursor:"pointer",transition:"all 0.12s" }} onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-1px)";e.currentTarget.style.boxShadow="0 4px 12px rgba(0,0,0,0.06)";}} onMouseLeave={e=>{e.currentTarget.style.transform="none";e.currentTarget.style.boxShadow="none";}}>
                        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:6 }}>
                          <div>
                            <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:4 }}>
                              <span style={{ fontWeight:700,fontSize:14 }}>Pedido #{r.orderNum}</span>
                            </div>
                            <div style={{ fontSize:13,color:"#555",marginBottom:5 }}>{o?.comprador||"—"} — {r.motivo}</div>
                            <div style={{ display:"flex",gap:5,flexWrap:"wrap" }}>
                              <Badge colors={sc}>{r.estado}</Badge>
                              <Badge colors={TIPO_COLORS[r.tipo]||{bg:"#eee",text:"#666"}}>{r.tipo}</Badge>
                            </div>
                          </div>
                          <div style={{ fontSize:11,color:"#aaa" }}>{fmtTs(r.createdAt)}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ── Order Detail Modal ── */}
      <Modal open={!!selOrder} onClose={()=>setSelectedOrder(null)} title={selOrder?`Pedido #${selOrder.numero}`:""} width={620}>
        {selOrder&&(
          <div>
            <div style={{ display:"flex",gap:6,flexWrap:"wrap",marginBottom:16 }}>
              <button onClick={()=>openNewReclamo(selOrder)} style={{ ...btnP,padding:"8px 14px",fontSize:12,display:"flex",alignItems:"center",gap:4,background:"linear-gradient(135deg,#dc2626,#b91c1c)" }}>📋 Crear Reclamo</button>
              <button onClick={()=>setActionModal({type:"direccion",order:selOrder})} style={{ ...btnP,padding:"8px 14px",fontSize:12 }}>📍 Ver Dirección</button>
              <button onClick={()=>setActionModal({type:"etiqueta",order:selOrder})} style={{ ...btnP,padding:"8px 14px",fontSize:12,background:"linear-gradient(135deg,#0891b2,#0e7490)" }}>🏷️ Etiqueta Andreani</button>
              {selOrder.linkOrden&&<a href={selOrder.linkOrden} target="_blank" rel="noopener noreferrer" style={{ ...btnP,padding:"8px 14px",fontSize:12,textDecoration:"none",display:"flex",alignItems:"center",gap:4,background:"linear-gradient(135deg,#7c3aed,#6d28d9)" }}>🔗 Tienda Nube</a>}
            </div>
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:"6px 20px",fontSize:13,marginBottom:14 }}>
              {[["Cliente",selOrder.comprador],["Email",selOrder.email],["Teléfono",selOrder.telefono],["DNI/CUIT",selOrder.dni],["Fecha",fmtDate(selOrder.fecha)],["Canal",selOrder.canal],["Pago",selOrder.medioPago],["Estado pago",selOrder.estadoPago],["Envío",selOrder.medioEnvio],["Estado envío",selOrder.estadoEnvio],["Tracking",selOrder.tracking||"—"]].map(([l,v])=>v?(
                <div key={l} style={{ display:"flex",gap:6,padding:"4px 0",borderBottom:"1px solid #f5f5f8" }}>
                  <span style={{ color:"#999",fontWeight:500,minWidth:90,flexShrink:0,fontSize:12 }}>{l}</span>
                  <span style={{ fontWeight:600,fontSize:12,wordBreak:"break-all" }}>{v}</span>
                </div>
              ):null)}
            </div>
            <div style={{ background:"#f8f8fc",borderRadius:10,padding:14,marginBottom:14 }}>
              <div style={{ fontSize:11,textTransform:"uppercase",color:"#aaa",fontWeight:700,marginBottom:8,letterSpacing:0.8 }}>Productos</div>
              {selOrder.productos.map((p,i)=>(
                <div key={i} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:i<selOrder.productos.length-1?"1px solid #eee":"none" }}>
                  <div><div style={{ fontSize:13,fontWeight:600 }}>{p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'')}</div><div style={{ fontSize:11,color:"#aaa" }}>SKU: {p.sku} · Cant: {p.cantidad}</div></div>
                  <div style={{ fontWeight:700,fontSize:13 }}>{fmtMoney(p.precio)}</div>
                </div>
              ))}
              <div style={{ display:"flex",justifyContent:"space-between",marginTop:10,paddingTop:8,borderTop:"1.5px solid #e0e0e8" }}>
                <div style={{ fontSize:12,color:"#888" }}>{selOrder.descuento&&parseFloat(selOrder.descuento)>0&&<span>Desc: -{fmtMoney(selOrder.descuento)} · </span>}{selOrder.costoEnvio&&parseFloat(selOrder.costoEnvio)>0&&<span>Envío: {fmtMoney(selOrder.costoEnvio)}</span>}</div>
                <div style={{ fontWeight:800,fontSize:15 }}>{fmtMoney(selOrder.total)}</div>
              </div>
            </div>
            {getOrderReclamos(selOrder.numero).length>0&&(
              <div style={{ background:"#fef2f2",borderRadius:10,padding:14 }}>
                <div style={{ fontSize:11,textTransform:"uppercase",color:"#dc2626",fontWeight:700,marginBottom:8,letterSpacing:0.8 }}>Reclamos asociados</div>
                {getOrderReclamos(selOrder.numero).map(r=>(
                  <div key={r._docId} onClick={()=>{ setSelectedOrder(null); setReclamoDetail(r._docId); setTab("reclamos"); }} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",cursor:"pointer",borderBottom:"1px solid #fecaca" }}>
                    <div style={{ display:"flex",gap:6,alignItems:"center" }}>
                      <Badge colors={ESTADO_RECLAMO_COLORS[r.estado]||{}} small>{r.estado}</Badge>
                      <span style={{ fontSize:12,fontWeight:600 }}>{r.tipo} — {r.motivo}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* ── Direccion Modal ── */}
      <Modal open={actionModal?.type==="direccion"} onClose={()=>setActionModal(null)} title="📍 Dirección de Envío">
        {actionModal?.order&&(
          <div>
            <div style={{ background:"#f0fdf4",borderRadius:12,padding:20,marginBottom:16,border:"1px solid #bbf7d0" }}>
              <div style={{ fontSize:18,fontWeight:700,marginBottom:12,color:"#166534" }}>{actionModal.order.nombreEnvio}</div>
              <div style={{ fontSize:15,lineHeight:1.8,color:"#333" }}>
                <div>{actionModal.order.direccion} {actionModal.order.dirNumero}{actionModal.order.piso?`, Piso ${actionModal.order.piso}`:''}</div>
                <div>{actionModal.order.localidad}{actionModal.order.ciudad?`, ${actionModal.order.ciudad}`:''}</div>
                <div>CP {actionModal.order.cp} — {actionModal.order.provincia}</div>
                <div style={{ marginTop:8,fontSize:14,color:"#666" }}>📞 {actionModal.order.telEnvio||actionModal.order.telefono}</div>
              </div>
            </div>
            <button onClick={()=>navigator.clipboard.writeText(fullAddress(actionModal.order))} style={{ ...btnP,width:"100%",textAlign:"center" }}>📋 Copiar dirección completa</button>
          </div>
        )}
      </Modal>

      {/* ── Etiqueta Modal ── */}
      <Modal open={actionModal?.type==="etiqueta"} onClose={()=>setActionModal(null)} title="🏷️ Etiqueta Andreani" width={500}>
        {actionModal?.order&&(
          <div>
            <div style={{ border:"2px dashed #0891b2",borderRadius:14,padding:24,background:"#f0fdfa" }}>
              <div style={{ display:"flex",justifyContent:"space-between",marginBottom:16 }}>
                <div><div style={{ fontSize:11,textTransform:"uppercase",color:"#0891b2",fontWeight:700,letterSpacing:1 }}>Remitente</div><div style={{ fontSize:14,fontWeight:700,marginTop:4 }}>Soluna Biolight</div></div>
                <div style={{ fontSize:12,color:"#888",fontFamily:"monospace" }}>Pedido #{actionModal.order.numero}</div>
              </div>
              <div style={{ borderTop:"1.5px solid #99f6e4",paddingTop:16 }}>
                <div style={{ fontSize:11,textTransform:"uppercase",color:"#0891b2",fontWeight:700,letterSpacing:1,marginBottom:6 }}>Destinatario</div>
                <div style={{ fontSize:16,fontWeight:800,marginBottom:8 }}>{actionModal.order.nombreEnvio}</div>
                <div style={{ fontSize:14,lineHeight:1.7 }}>
                  <div>{actionModal.order.direccion} {actionModal.order.dirNumero}{actionModal.order.piso?`, Piso ${actionModal.order.piso}`:''}</div>
                  <div>{actionModal.order.localidad}{actionModal.order.ciudad?` — ${actionModal.order.ciudad}`:''}</div>
                  <div style={{ fontWeight:700 }}>CP {actionModal.order.cp} — {actionModal.order.provincia}</div>
                  <div style={{ marginTop:6,color:"#555" }}>Tel: {actionModal.order.telEnvio||actionModal.order.telefono}</div>
                </div>
              </div>
              {actionModal.order.tracking&&<div style={{ marginTop:16,paddingTop:12,borderTop:"1.5px solid #99f6e4" }}><div style={{ fontSize:11,color:"#0891b2",fontWeight:700 }}>TRACKING</div><div style={{ fontSize:16,fontWeight:800,fontFamily:"monospace",marginTop:4 }}>{actionModal.order.tracking}</div></div>}
            </div>
            <div style={{ display:"flex",gap:8,marginTop:16 }}>
              <button onClick={()=>{ const t=`DESTINATARIO: ${actionModal.order.nombreEnvio}\n${actionModal.order.direccion} ${actionModal.order.dirNumero}${actionModal.order.piso?', Piso '+actionModal.order.piso:''}\n${actionModal.order.localidad}${actionModal.order.ciudad?' — '+actionModal.order.ciudad:''}\nCP ${actionModal.order.cp} — ${actionModal.order.provincia}\nTel: ${actionModal.order.telEnvio||actionModal.order.telefono}\nPedido #${actionModal.order.numero}`; navigator.clipboard.writeText(t); }} style={{ ...btnP,flex:1,textAlign:"center",background:"linear-gradient(135deg,#0891b2,#0e7490)" }}>📋 Copiar datos</button>
              <button onClick={()=>window.print()} style={{ ...btnP,flex:1,textAlign:"center",background:"#374151" }}>🖨️ Imprimir</button>
            </div>
          </div>
        )}
      </Modal>

      {/* ── Reclamo Form Modal ── */}
      <Modal open={!!reclamoForm} onClose={()=>setReclamoForm(null)} title={reclamoForm?._docId?"Editar Reclamo":reclamoForm?.orderNum?`Nuevo Reclamo — Pedido #${reclamoForm.orderNum}`:"Nuevo Reclamo"}>
        {reclamoForm&&(
          <div>
            {!reclamoForm._docId&&!reclamoForm.orderNum&&<Field label="Buscar pedido *"><OrderSearchField orders={orders} onSelect={num=>setReclamoForm(f=>({...f,orderNum:num}))} /></Field>}
            {(()=>{ const o=orders.find(o=>o.numero===reclamoForm.orderNum); return o?(
              <div style={{ background:"#f8f8fc",borderRadius:10,padding:12,marginBottom:14,fontSize:12,display:"flex",justifyContent:"space-between",alignItems:"center" }}>
                <div><span style={{ fontWeight:700 }}>#{o.numero} — {o.comprador}</span><div style={{ color:"#888",marginTop:2 }}>{o.productos.map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'')).join(', ')}</div></div>
                {!reclamoForm._docId&&<button onClick={()=>setReclamoForm(f=>({...f,orderNum:""}))} style={{ background:"#fee2e2",color:"#991b1b",border:"none",borderRadius:6,padding:"4px 8px",fontSize:11,fontWeight:600,cursor:"pointer" }}>Cambiar</button>}
              </div>
            ):null; })()}
            {reclamoForm.orderNum&&(
              <>
                <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 12px" }}>
                  <Field label="Tipo"><select style={selSt} value={reclamoForm.tipo} onChange={e=>setReclamoForm(f=>({...f,tipo:e.target.value}))}>{TIPOS_RECLAMO.map(t=><option key={t}>{t}</option>)}</select></Field>
                  <Field label="Motivo *"><select style={selSt} value={reclamoForm.motivo} onChange={e=>setReclamoForm(f=>({...f,motivo:e.target.value}))}><option value="">Seleccionar...</option>{MOTIVOS.map(m=><option key={m}>{m}</option>)}</select></Field>
                </div>
                {reclamoForm.tipo==="Cambio"&&(
                  <div style={{ background:"#f0f4ff",borderRadius:10,padding:14,marginBottom:12,border:"1px solid #c7d2fe" }}>
                    <div style={{ fontSize:11,textTransform:"uppercase",letterSpacing:1,color:"#4338ca",fontWeight:700,marginBottom:12 }}>🔄 Detalle del cambio</div>
                    <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 16px" }}>
                      <div>
                        <div style={{ fontSize:11,fontWeight:600,color:"#888",textTransform:"uppercase",marginBottom:6 }}>Nos devuelve</div>
                        {(reclamoForm.productosRecibe||[]).map((item,i)=>(
                          <div key={i} style={{ display:"flex",gap:6,marginBottom:6,alignItems:"center" }}>
                            <select style={{ ...selSt,flex:1,fontSize:12,padding:"7px 8px" }} value={item.producto} onChange={e=>{ const arr=[...reclamoForm.productosRecibe]; arr[i]={...arr[i],producto:e.target.value}; setReclamoForm(f=>({...f,productosRecibe:arr})); }}><option value="">Producto...</option>{PRODUCTOS.map(p=><option key={p}>{p}</option>)}</select>
                            <input type="number" min={1} value={item.cantidad} onChange={e=>{ const arr=[...reclamoForm.productosRecibe]; arr[i]={...arr[i],cantidad:parseInt(e.target.value)||1}; setReclamoForm(f=>({...f,productosRecibe:arr})); }} style={{ ...iSt,width:48,textAlign:"center",fontSize:12,padding:"7px 4px",flexShrink:0 }} />
                            {reclamoForm.productosRecibe.length>1&&<button onClick={()=>{ const arr=reclamoForm.productosRecibe.filter((_,j)=>j!==i); setReclamoForm(f=>({...f,productosRecibe:arr})); }} style={{ background:"#fee2e2",color:"#dc2626",border:"none",borderRadius:6,width:26,height:26,fontSize:14,cursor:"pointer",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center" }}>✕</button>}
                          </div>
                        ))}
                        <button onClick={()=>setReclamoForm(f=>({...f,productosRecibe:[...(f.productosRecibe||[]),{producto:"",cantidad:1}]}))} style={{ background:"none",border:"1.5px dashed #a5b4fc",borderRadius:8,padding:"5px 10px",fontSize:12,color:"#4338ca",fontWeight:600,cursor:"pointer",width:"100%",marginTop:2 }}>+ Agregar</button>
                      </div>
                      <div>
                        <div style={{ fontSize:11,fontWeight:600,color:"#888",textTransform:"uppercase",marginBottom:6 }}>Le enviamos</div>
                        {(reclamoForm.productosEnvia||[]).map((item,i)=>(
                          <div key={i} style={{ display:"flex",gap:6,marginBottom:6,alignItems:"center" }}>
                            <select style={{ ...selSt,flex:1,fontSize:12,padding:"7px 8px" }} value={item.producto} onChange={e=>{ const arr=[...reclamoForm.productosEnvia]; arr[i]={...arr[i],producto:e.target.value}; setReclamoForm(f=>({...f,productosEnvia:arr})); }}><option value="">Producto...</option>{PRODUCTOS.map(p=><option key={p}>{p}</option>)}</select>
                            <input type="number" min={1} value={item.cantidad} onChange={e=>{ const arr=[...reclamoForm.productosEnvia]; arr[i]={...arr[i],cantidad:parseInt(e.target.value)||1}; setReclamoForm(f=>({...f,productosEnvia:arr})); }} style={{ ...iSt,width:48,textAlign:"center",fontSize:12,padding:"7px 4px",flexShrink:0 }} />
                            {reclamoForm.productosEnvia.length>1&&<button onClick={()=>{ const arr=reclamoForm.productosEnvia.filter((_,j)=>j!==i); setReclamoForm(f=>({...f,productosEnvia:arr})); }} style={{ background:"#fee2e2",color:"#dc2626",border:"none",borderRadius:6,width:26,height:26,fontSize:14,cursor:"pointer",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center" }}>✕</button>}
                          </div>
                        ))}
                        <button onClick={()=>setReclamoForm(f=>({...f,productosEnvia:[...(f.productosEnvia||[]),{producto:"",cantidad:1}]}))} style={{ background:"none",border:"1.5px dashed #a5b4fc",borderRadius:8,padding:"5px 10px",fontSize:12,color:"#4338ca",fontWeight:600,cursor:"pointer",width:"100%",marginTop:2 }}>+ Agregar</button>
                      </div>
                    </div>
                  </div>
                )}
                <Field label="Descripción"><textarea style={{ ...iSt,minHeight:65,resize:"vertical" }} value={reclamoForm.descripcion} onChange={e=>setReclamoForm(f=>({...f,descripcion:e.target.value}))} placeholder="Detalle del reclamo..." /></Field>
                {reclamoForm._docId&&(
                  <Field label="Estado">
                    <div style={{ display:"flex",gap:6,flexWrap:"wrap" }}>
                      {ESTADOS_RECLAMO.map(e=>{ const c=ESTADO_RECLAMO_COLORS[e]; const sel=reclamoForm.estado===e; return <button key={e} onClick={()=>setReclamoForm(f=>({...f,estado:e}))} style={{ display:"flex",alignItems:"center",gap:6,padding:"8px 14px",borderRadius:10,fontSize:13,fontWeight:sel?700:500,background:sel?c.bg:"#f8f8fc",color:sel?c.text:"#999",border:sel?`2px solid ${c.dot}`:"2px solid #e8e8f0",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",transition:"all 0.15s",boxShadow:sel?`0 2px 8px ${c.dot}30`:"none" }}><span style={{ width:9,height:9,borderRadius:"50%",background:sel?c.dot:"#ccc" }}/>{e}</button>; })}
                    </div>
                  </Field>
                )}
                {reclamoForm._docId&&<Field label="Resolución"><textarea style={{ ...iSt,minHeight:55,resize:"vertical" }} value={reclamoForm.resolucion} onChange={e=>setReclamoForm(f=>({...f,resolucion:e.target.value}))} placeholder="Qué se hizo..." /></Field>}
                <Field label="Notas internas"><textarea style={{ ...iSt,minHeight:45,resize:"vertical" }} value={reclamoForm.notas} onChange={e=>setReclamoForm(f=>({...f,notas:e.target.value}))} placeholder="Notas para el equipo..." /></Field>
                <div style={{ display:"flex",gap:8,justifyContent:"flex-end",marginTop:6 }}>
                  <button onClick={()=>setReclamoForm(null)} style={{ ...btnP,background:"#f0f0f5",color:"#666" }}>Cancelar</button>
                  <button onClick={saveReclamo} disabled={saving||!reclamoForm.motivo||!reclamoForm.orderNum} style={{ ...btnP,opacity:saving||!reclamoForm.motivo||!reclamoForm.orderNum?0.4:1 }}>{saving?"Guardando...":(reclamoForm._docId?"Guardar":"Crear Reclamo")}</button>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>

      {/* ── Reclamo Detail Modal ── */}
      <Modal open={!!detailReclamo} onClose={()=>setReclamoDetail(null)} title={detailReclamo?`Reclamo — Pedido #${detailReclamo.orderNum}`:""}>
        {detailReclamo&&(()=>{ const r=detailReclamo; const o=orders.find(o=>o.numero===r.orderNum); const sc=ESTADO_RECLAMO_COLORS[r.estado]||{}; const tc=TIPO_COLORS[r.tipo]||{}; return (
          <div>
            <div style={{ background:sc.bg,borderRadius:12,padding:"14px 16px",marginBottom:14,display:"flex",justifyContent:"space-between",alignItems:"center",border:`1.5px solid ${sc.dot}22` }}>
              <div style={{ display:"flex",alignItems:"center",gap:10 }}>
                <span style={{ width:12,height:12,borderRadius:"50%",background:sc.dot,boxShadow:`0 0 8px ${sc.dot}66`,flexShrink:0 }}/>
                <span style={{ fontSize:16,fontWeight:800,color:sc.text,letterSpacing:0.3 }}>{r.estado}</span>
              </div>
              <span style={{ background:tc.bg,color:tc.text,padding:"4px 12px",borderRadius:20,fontSize:12,fontWeight:700 }}>{r.tipo}</span>
            </div>
            {o&&<div style={{ background:"#f8f8fc",borderRadius:10,padding:12,marginBottom:12,fontSize:13 }}><div style={{ fontWeight:700 }}>Pedido #{o.numero} — {o.comprador}</div><div style={{ fontSize:12,color:"#888",marginTop:2 }}>{o.email} · {o.telefono}</div><div style={{ fontSize:12,color:"#888",marginTop:1 }}>{o.productos.map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'')).join(', ')}</div></div>}
            <div style={{ fontSize:13,marginBottom:8 }}><span style={{ color:"#999",fontWeight:500 }}>Motivo: </span><span style={{ fontWeight:600 }}>{r.motivo}</span></div>
            {r.tipo==="Cambio"&&((r.productosRecibe?.length>0)||(r.productosEnvia?.length>0))&&(
              <div style={{ background:"#f0f4ff",borderRadius:10,padding:14,marginBottom:8,border:"1px solid #c7d2fe" }}>
                <div style={{ fontSize:10,textTransform:"uppercase",color:"#4338ca",fontWeight:700,marginBottom:10,letterSpacing:0.8 }}>🔄 Detalle del cambio</div>
                <div style={{ display:"grid",gridTemplateColumns:"1fr auto 1fr",gap:10,alignItems:"start" }}>
                  <div><div style={{ fontSize:10,color:"#888",fontWeight:600,textTransform:"uppercase",marginBottom:4 }}>Nos devuelve</div>{(r.productosRecibe||[]).map((item,i)=><div key={i} style={{ fontSize:13,fontWeight:600,color:"#dc2626",marginBottom:2 }}>{item.cantidad>1&&<span style={{ color:"#888",fontSize:11 }}>{item.cantidad}x </span>}{item.producto||"—"}</div>)}</div>
                  <div style={{ fontSize:20,color:"#a5b4fc",paddingTop:16 }}>→</div>
                  <div><div style={{ fontSize:10,color:"#888",fontWeight:600,textTransform:"uppercase",marginBottom:4 }}>Le enviamos</div>{(r.productosEnvia||[]).map((item,i)=><div key={i} style={{ fontSize:13,fontWeight:600,color:"#16a34a",marginBottom:2 }}>{item.cantidad>1&&<span style={{ color:"#888",fontSize:11 }}>{item.cantidad}x </span>}{item.producto||"—"}</div>)}</div>
                </div>
              </div>
            )}
            {r.descripcion&&<div style={{ background:"#f8f8fc",borderRadius:10,padding:12,marginBottom:8,fontSize:13,lineHeight:1.5 }}>{r.descripcion}</div>}
            {r.resolucion&&<div style={{ background:"#f0fdf4",borderRadius:10,padding:12,marginBottom:8 }}><div style={{ fontSize:10,textTransform:"uppercase",color:"#16a34a",fontWeight:700,marginBottom:3 }}>Resolución</div><div style={{ fontSize:13,lineHeight:1.5,color:"#166534" }}>{r.resolucion}</div></div>}
            {r.notas&&<div style={{ background:"#fffbeb",borderRadius:10,padding:12,marginBottom:8 }}><div style={{ fontSize:10,textTransform:"uppercase",color:"#b45309",fontWeight:700,marginBottom:3 }}>Notas</div><div style={{ fontSize:13,lineHeight:1.5,color:"#92400e" }}>{r.notas}</div></div>}
            <div style={{ fontSize:11,color:"#aaa",marginTop:8 }}>Creado: {fmtTs(r.createdAt)}{r.resolvedAt?.seconds?` · Resuelto: ${fmtTs(r.resolvedAt)}`:''}</div>
            <div style={{ display:"flex",gap:8,justifyContent:"flex-end",marginTop:16,borderTop:"1px solid #f0f0f4",paddingTop:12 }}>
              {deleteConfirm===r._docId?(
                <div style={{ display:"flex",gap:6,alignItems:"center" }}>
                  <span style={{ fontSize:12,color:"#dc2626",fontWeight:500 }}>¿Eliminar?</span>
                  <button onClick={()=>deleteReclamo(r._docId)} style={{ ...btnP,background:"#dc2626",padding:"7px 14px",fontSize:12 }}>Sí</button>
                  <button onClick={()=>setDeleteConfirm(null)} style={{ ...btnP,background:"#f0f0f5",color:"#666",padding:"7px 14px",fontSize:12 }}>No</button>
                </div>
              ):(
                <>
                  <button onClick={()=>setDeleteConfirm(r._docId)} style={{ ...btnP,background:"#fee2e2",color:"#991b1b",padding:"8px 14px",fontSize:12 }}>Eliminar</button>
                  <button onClick={()=>{ setReclamoDetail(null); setReclamoForm({...r}); }} style={{ ...btnP,padding:"8px 16px",fontSize:12 }}>Editar</button>
                </>
              )}
            </div>
          </div>
        ); })()}
      </Modal>
    </div>
  );
}
