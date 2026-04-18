import { useState, useEffect, useMemo, useRef } from "react";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from "firebase/firestore";

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

// ─── Design Tokens ───
const C = {
  bg:       "#0d1117",
  surface:  "#161b22",
  border:   "#30363d",
  borderL:  "#21262d",
  text:     "#e6edf3",
  textMd:   "#8b949e",
  textSm:   "#6e7681",
  accent:   "#58a6ff",
  accentBg: "#388bfd1a",
  green:    "#3fb950",
  greenBg:  "#3fb9501a",
  yellow:   "#d29922",
  yellowBg: "#d299221a",
  red:      "#f85149",
  redBg:    "#f851491a",
  purple:   "#bc8cff",
  purpleBg: "#bc8cff1a",
  orange:   "#f0883e",
  orangeBg: "#f0883e1a",
};

// ─── Constants ───
const MOTIVOS = ["Producto dañado","Color incorrecto","No cumple expectativas","Problema con el lente","Error en el pedido","Armazón roto","Otro"];
const ESTADOS_RECLAMO = ["Pendiente","En proceso","Resuelto","Rechazado"];
const TIPOS_RECLAMO = ["Cambio","Devolución"];
const PRODUCTOS = ["Amarillo - Marco Negro","Amarillo - M. Transparente","Naranja - Marco Negro","Naranja - M. Transparente","Rojo - Marco Negro","Rojo - M. Transparente","Clip-On","Líquido Limpia Cristales"];
const SKU_LENTE = { "AMARILLO-NN":"Amarillo","AMARILLO-TT":"Amarillo","NARAN-NN":"Naranja","NARAN-TT":"Naranja","ROJ-NN":"Rojo","ROJ-TT":"Rojo","N-N":"Negro","N-R":"Negro/Rojo","R-R":"Rojo/Rojo","CLIP-ON":"Clip-On","LIQ":"Líquido" };
const LENTE_DOT = { Amarillo:"#d29922", Naranja:"#f0883e", Rojo:"#f85149", Negro:"#6e7681", "Clip-On":"#bc8cff", Líquido:"#58a6ff" };

const ESTADO_ENVIO_C = {
  "No está empaquetado": { bg:C.yellowBg, text:C.yellow,  dot:C.yellow  },
  "Listo para enviar":   { bg:C.accentBg, text:C.accent,  dot:C.accent  },
  "Enviado":             { bg:C.purpleBg, text:C.purple,  dot:C.purple  },
  "Entregado":           { bg:C.greenBg,  text:C.green,   dot:C.green   },
};
const ESTADO_RECLAMO_C = {
  Pendiente:    { bg:C.accentBg,  text:C.accent,  dot:C.accent  },
  "En proceso": { bg:C.yellowBg, text:C.yellow,  dot:C.yellow  },
  Resuelto:     { bg:C.greenBg,  text:C.green,   dot:C.green   },
  Rechazado:    { bg:C.redBg,    text:C.red,     dot:C.red     },
};
const TIPO_C = {
  Cambio:     { bg:C.purpleBg, text:C.purple },
  Devolución: { bg:C.orangeBg, text:C.orange },
};

// ─── CSV Parser ───
function parseCSV(text) {
  const rows = []; let i = 0; const len = text.length;
  function parseField() {
    if (i >= len || text[i] === '\n' || text[i] === '\r') return '';
    if (text[i] === '"') {
      i++; let val = '';
      while (i < len) {
        if (text[i] === '"') { if (i+1 < len && text[i+1] === '"') { val+='"'; i+=2; } else { i++; break; } }
        else { val+=text[i]; i++; }
      }
      return val.trim();
    }
    let val = '';
    while (i < len && text[i] !== ';' && text[i] !== '\n' && text[i] !== '\r') { val+=text[i]; i++; }
    return val.trim();
  }
  while (i < len) {
    const row = [];
    while (i < len && text[i] !== '\n') { row.push(parseField()); if (i < len && text[i] === ';') i++; }
    if (text[i] === '\n') i++; if (text[i] === '\r') i++;
    if (row.length > 1) rows.push(row);
  }
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map(r => { const obj = {}; headers.forEach((h,idx) => { obj[h] = r[idx]||''; }); return obj; });
}

function buildOrders(csvRows) {
  const map = {};
  for (const row of csvRows) {
    const num = row['Número de orden']; if (!num) continue;
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
function fmtDate(d) { if (!d) return '—'; const p = d.split(' ')[0].split('/'); if (p.length===3) return `${p[0]}/${p[1]}/${p[2]}`; return d; }
function fmtTs(ts) { if (!ts?.seconds) return '—'; return new Date(ts.seconds*1000).toLocaleDateString('es-AR'); }
function fullAddress(o) { let a=o.direccion||''; if(o.dirNumero) a+=' '+o.dirNumero; if(o.piso) a+=', Piso '+o.piso; return [a,o.localidad,o.ciudad,o.cp?`CP ${o.cp}`:'',o.provincia].filter(Boolean).join(', '); }

// ─── Shared Styles ───
const iSt = {
  width:"100%", padding:"7px 11px", borderRadius:6,
  border:`1px solid ${C.border}`, fontSize:13,
  fontFamily:"'Inter',system-ui,sans-serif",
  outline:"none", boxSizing:"border-box",
  background:C.surface, color:C.text,
  transition:"border-color 0.15s",
};
const selSt = { ...iSt, cursor:"pointer" };
const btnBase = {
  border:"none", borderRadius:6, padding:"6px 14px", fontSize:13,
  fontWeight:500, cursor:"pointer", fontFamily:"'Inter',system-ui,sans-serif",
  transition:"all 0.15s", display:"inline-flex", alignItems:"center", gap:6,
};
const btnPrimary = { ...btnBase, background:"#238636", color:"#fff", border:"1px solid #2ea043" };
const btnSecondary = { ...btnBase, background:C.surface, color:C.text, border:`1px solid ${C.border}` };
const btnDanger = { ...btnBase, background:C.redBg, color:C.red, border:`1px solid ${C.red}44` };

// ─── UI Components ───
function Badge({ colors, children, small }) {
  return (
    <span style={{
      display:"inline-flex", alignItems:"center", gap:5,
      padding: small ? "1px 6px" : "2px 8px",
      borderRadius:20, fontSize: small ? 10 : 11, fontWeight:500,
      background:colors.bg, color:colors.text,
      border:`1px solid ${colors.dot}33`,
      whiteSpace:"nowrap", letterSpacing:0.3,
    }}>
      <span style={{ width:6, height:6, borderRadius:"50%", background:colors.dot, flexShrink:0 }}/>
      {children}
    </span>
  );
}

function LensDots({ productos }) {
  const colors = getLensColors(productos);
  return (
    <span style={{ display:"inline-flex", gap:3, alignItems:"center" }}>
      {colors.map((c,i) => <span key={i} style={{ width:9, height:9, borderRadius:"50%", background:LENTE_DOT[c]||C.textSm, border:`1px solid ${C.border}` }} title={c}/>)}
    </span>
  );
}

function Modal({ open, onClose, title, width, children }) {
  if (!open) return null;
  return (
    <div onClick={onClose} style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",backdropFilter:"blur(2px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:16 }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:C.surface,borderRadius:12,width:"100%",maxWidth:width||520,maxHeight:"92vh",overflow:"visible",boxShadow:`0 16px 48px rgba(0,0,0,0.5)`,border:`1px solid ${C.border}`,display:"flex",flexDirection:"column" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"16px 20px 12px",borderBottom:`1px solid ${C.borderL}`,flexShrink:0 }}>
          <h2 style={{ margin:0,fontSize:15,fontWeight:600,color:C.text }}>{title}</h2>
          <button onClick={onClose} style={{ ...btnSecondary,padding:"4px 8px",fontSize:16,lineHeight:1 }}>✕</button>
        </div>
        <div style={{ padding:"16px 20px 20px",overflow:"auto",flex:1 }}>{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children, required }) {
  return (
    <div style={{ marginBottom:12 }}>
      <label style={{ display:"block",fontSize:11,fontWeight:500,color:C.textMd,marginBottom:5,letterSpacing:0.4,textTransform:"uppercase" }}>
        {label}{required&&<span style={{ color:C.red,marginLeft:3 }}>*</span>}
      </label>
      {children}
    </div>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div style={{ background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:"14px 16px",flex:"1 1 100px",minWidth:95 }}>
      <div style={{ fontSize:22,fontWeight:700,color,fontFamily:"'Inter',system-ui,sans-serif",letterSpacing:-0.5 }}>{value}</div>
      <div style={{ fontSize:11,color:C.textSm,marginTop:2,fontWeight:500,letterSpacing:0.3 }}>{label}</div>
    </div>
  );
}

function Divider() {
  return <div style={{ height:1,background:C.borderL,margin:"12px 0" }}/>;
}

function OrderSearchField({ orders, onSelect }) {
  const [q, setQ] = useState("");
  const inputRef = useRef(null);
  const results = useMemo(() => {
    if (!q) return [];
    const s = q.toLowerCase();
    return orders.filter(o=>o.numero.includes(s)||o.comprador.toLowerCase().includes(s)||o.email.toLowerCase().includes(s)).slice(0,10);
  }, [q, orders]);
  useEffect(()=>{ if(inputRef.current) inputRef.current.focus(); },[]);
  return (
    <div>
      <div style={{ position:"relative" }}>
        <span style={{ position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",color:C.textSm,fontSize:13 }}>🔍</span>
        <input ref={inputRef} style={{ ...iSt,paddingLeft:30 }} placeholder="Nro de pedido, nombre o email..." value={q} onChange={e=>setQ(e.target.value)} />
      </div>
      {q.length>0 && results.length>0 && (
        <div style={{ marginTop:4,background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,maxHeight:260,overflow:"auto" }}>
          {results.map((o,i)=>(
            <div key={o.numero} onClick={()=>onSelect(o.numero)}
              style={{ padding:"9px 12px",cursor:"pointer",borderTop:i>0?`1px solid ${C.borderL}`:"none",transition:"background 0.1s" }}
              onMouseEnter={e=>e.currentTarget.style.background=C.surface}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
                <div style={{ display:"flex",gap:8,alignItems:"center" }}>
                  <span style={{ fontWeight:600,color:C.accent,fontSize:13 }}>#{o.numero}</span>
                  <span style={{ color:C.text,fontSize:13 }}>{o.comprador}</span>
                </div>
                <span style={{ fontSize:11,color:C.textSm }}>{fmtDate(o.fecha)}</span>
              </div>
              <div style={{ fontSize:11,color:C.textSm,marginTop:2 }}>{o.productos.map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'')).join(', ')}</div>
            </div>
          ))}
        </div>
      )}
      {q.length>0 && results.length===0 && (
        <div style={{ marginTop:4,padding:12,textAlign:"center",color:C.textSm,fontSize:13,border:`1px solid ${C.border}`,borderRadius:8 }}>Sin resultados para "{q}"</div>
      )}
    </div>
  );
}

const TABS = [
  { id:"pedidos",  label:"Pedidos",  icon:"📦" },
  { id:"reclamos", label:"Reclamos", icon:"📋" },
];

// ─── Main App ───
export default function SolunaGestion() {
  const [orders,        setOrders]        = useState([]);
  const [reclamos,      setReclamos]      = useState([]);
  const [fbStatus,      setFbStatus]      = useState("connecting");
  const [tab,           setTab]           = useState("pedidos");
  const [search,        setSearch]        = useState("");
  const [filterEnvio,   setFilterEnvio]   = useState("");
  const [filterReclamo, setFilterReclamo] = useState("");
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [actionModal,   setActionModal]   = useState(null);
  const [reclamoForm,   setReclamoForm]   = useState(null);
  const [reclamoDetail, setReclamoDetail] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [saving,        setSaving]        = useState(false);
  const fileRef = useRef(null);

  // Font
  useEffect(()=>{
    const l = document.createElement("link");
    l.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap";
    l.rel = "stylesheet";
    document.head.appendChild(l);
    document.body.style.margin = "0";
    document.body.style.background = C.bg;
  },[]);

  // Orders cache
  useEffect(()=>{ try { const s=localStorage.getItem("soluna_orders_v3"); if(s) setOrders(JSON.parse(s)); } catch(e){} },[]);
  useEffect(()=>{ if(orders.length) localStorage.setItem("soluna_orders_v3",JSON.stringify(orders)); },[orders]);

  // Firebase listener
  useEffect(()=>{
    const unsub = onSnapshot(collection(db,"reclamos"), snap=>{
      const data = snap.docs.map(d=>({...d.data(),_docId:d.id}));
      data.sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
      setReclamos(data);
      setFbStatus("ok");
    }, ()=>setFbStatus("error"));
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
    } catch(e) { alert("Error al guardar."); }
    setSaving(false);
  }

  async function deleteReclamo(docId) {
    try { await deleteDoc(doc(db,"reclamos",docId)); } catch(e) {}
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

  const stats = {
    totalPedidos: orders.length,
    reclamosTotal: reclamos.length,
    pendientes: reclamos.filter(r=>r.estado==="Pendiente").length,
    enProceso: reclamos.filter(r=>r.estado==="En proceso").length,
    resueltos: reclamos.filter(r=>r.estado==="Resuelto").length,
    rechazados: reclamos.filter(r=>r.estado==="Rechazado").length,
  };

  const selOrder = orders.find(o=>o.numero===selectedOrder);
  const detailReclamo = reclamos.find(r=>r._docId===reclamoDetail);
  const fbDotColor = { connecting:C.yellow, ok:C.green, error:C.red }[fbStatus];

  return (
    <div style={{ fontFamily:"'Inter',system-ui,sans-serif", background:C.bg, minHeight:"100vh", color:C.text }}>

      {/* ── Topbar ── */}
      <div style={{ borderBottom:`1px solid ${C.border}`, background:C.surface, padding:"0 24px", position:"sticky", top:0, zIndex:100 }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", height:56, gap:16, maxWidth:1200, margin:"0 auto" }}>
          <div style={{ display:"flex", alignItems:"center", gap:12 }}>
            <div style={{ display:"flex",alignItems:"center",gap:6 }}>
              <div style={{ width:28,height:28,borderRadius:6,background:"linear-gradient(135deg,#58a6ff,#bc8cff)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14 }}>🌙</div>
              <span style={{ fontWeight:600,fontSize:15,color:C.text }}>Soluna</span>
              <span style={{ color:C.textSm,fontSize:15 }}>/</span>
              <span style={{ fontWeight:600,fontSize:15,color:C.text }}>Gestión</span>
            </div>
            <div style={{ display:"flex",alignItems:"center",gap:4,background:C.bg,border:`1px solid ${C.border}`,borderRadius:20,padding:"3px 8px" }}>
              <span style={{ width:6,height:6,borderRadius:"50%",background:fbDotColor,boxShadow:`0 0 4px ${fbDotColor}` }}/>
              <span style={{ fontSize:10,color:C.textSm,fontWeight:500 }}>{fbStatus==="ok"?"en vivo":fbStatus==="error"?"sin conexión":"conectando"}</span>
            </div>
          </div>
          <div style={{ display:"flex",gap:8,alignItems:"center" }}>
            {orders.length>0 && (
              <button onClick={()=>setReclamoForm(emptyForm())} style={{ ...btnDanger, padding:"6px 12px",fontSize:12 }}>
                + Nuevo Reclamo
              </button>
            )}
            <button onClick={()=>fileRef.current?.click()} style={{ ...btnSecondary, fontSize:12 }}>
              📁 {orders.length?"Actualizar CSV":"Importar CSV"}
            </button>
            <input ref={fileRef} type="file" accept=".csv" onChange={handleFile} style={{ display:"none" }}/>
          </div>
        </div>
      </div>

      <div style={{ maxWidth:1200, margin:"0 auto", padding:"0 24px" }}>

        {/* ── No data ── */}
        {orders.length===0 && (
          <div style={{ textAlign:"center",padding:"100px 20px" }}>
            <div style={{ width:64,height:64,borderRadius:12,background:C.surface,border:`1px solid ${C.border}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,margin:"0 auto 20px" }}>📁</div>
            <div style={{ fontSize:20,fontWeight:600,color:C.text,marginBottom:8 }}>Importá tus pedidos</div>
            <div style={{ fontSize:14,color:C.textMd,maxWidth:360,margin:"0 auto 24px",lineHeight:1.6 }}>Exportá tus ventas desde Tienda Nube (Ventas → Exportar) y subí el archivo CSV.</div>
            <button onClick={()=>fileRef.current?.click()} style={{ ...btnPrimary,padding:"10px 24px",fontSize:14 }}>📁 Seleccionar CSV</button>
          </div>
        )}

        {orders.length>0 && (
          <>
            {/* ── Stats ── */}
            <div style={{ padding:"20px 0 0" }}>
              <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>
                <StatCard label="Pedidos"    value={stats.totalPedidos}  color={C.accent}  />
                <StatCard label="Reclamos"   value={stats.reclamosTotal} color={C.textMd}  />
                <StatCard label="Pendientes" value={stats.pendientes}    color={C.accent}  />
                <StatCard label="En proceso" value={stats.enProceso}     color={C.yellow}  />
                <StatCard label="Resueltos"  value={stats.resueltos}     color={C.green}   />
                <StatCard label="Rechazados" value={stats.rechazados}    color={C.red}     />
              </div>
            </div>

            {/* ── Tabs ── */}
            <div style={{ display:"flex",gap:0,borderBottom:`1px solid ${C.border}`,marginTop:20 }}>
              {TABS.map(t=>(
                <button key={t.id} onClick={()=>{ setTab(t.id); setSearch(""); setFilterEnvio(""); setFilterReclamo(""); }}
                  style={{ padding:"10px 18px",fontSize:13,fontWeight:tab===t.id?600:400,color:tab===t.id?C.text:C.textMd,background:"none",border:"none",borderBottom:tab===t.id?`2px solid ${C.accent}`:"2px solid transparent",cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",display:"flex",alignItems:"center",gap:6,marginBottom:-1,transition:"color 0.15s" }}>
                  {t.icon} {t.label}
                  {t.id==="reclamos"&&stats.pendientes>0&&<span style={{ background:C.accent,color:"#000",fontSize:10,fontWeight:700,borderRadius:10,padding:"1px 6px",marginLeft:2 }}>{stats.pendientes}</span>}
                </button>
              ))}
            </div>

            {/* ── Filters ── */}
            <div style={{ padding:"12px 0 8px",display:"flex",gap:8,flexWrap:"wrap",alignItems:"center" }}>
              <div style={{ position:"relative",flex:"1 1 240px",minWidth:200 }}>
                <span style={{ position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",color:C.textSm,fontSize:12 }}>🔍</span>
                <input placeholder={tab==="pedidos"?"Buscar pedido, cliente...":"Buscar reclamo, cliente..."} value={search} onChange={e=>setSearch(e.target.value)}
                  style={{ ...iSt,paddingLeft:30,fontSize:12 }}
                  onFocus={e=>e.target.style.borderColor=C.accent}
                  onBlur={e=>e.target.style.borderColor=C.border} />
              </div>
              {tab==="pedidos" && (
                <select value={filterEnvio} onChange={e=>setFilterEnvio(e.target.value)}
                  style={{ ...selSt,width:"auto",flex:"0 1 170px",fontSize:12,color:filterEnvio?C.accent:C.textMd }}>
                  <option value="">Estado envío</option>
                  {Object.keys(ESTADO_ENVIO_C).map(e=><option key={e}>{e}</option>)}
                </select>
              )}
              {tab==="reclamos" && (
                <select value={filterReclamo} onChange={e=>setFilterReclamo(e.target.value)}
                  style={{ ...selSt,width:"auto",flex:"0 1 150px",fontSize:12,color:filterReclamo?C.accent:C.textMd }}>
                  <option value="">Estado reclamo</option>
                  {ESTADOS_RECLAMO.map(e=><option key={e}>{e}</option>)}
                </select>
              )}
              <span style={{ fontSize:11,color:C.textSm,marginLeft:"auto" }}>
                {tab==="pedidos"?`${filteredOrders.length} pedidos`:`${filteredReclamos.length} reclamos`}
              </span>
            </div>

            {/* ── Pedidos ── */}
            {tab==="pedidos" && (
              <div style={{ paddingBottom:40 }}>
                {/* Table header */}
                <div style={{ display:"grid",gridTemplateColumns:"80px 1fr 1fr 160px 120px 80px",gap:8,padding:"6px 12px",fontSize:11,color:C.textSm,fontWeight:500,textTransform:"uppercase",letterSpacing:0.5,borderBottom:`1px solid ${C.borderL}` }}>
                  <span>Pedido</span><span>Cliente</span><span>Productos</span><span>Estado</span><span>Total</span><span>Fecha</span>
                </div>
                <div>
                  {filteredOrders.map(o=>{
                    const hasReclamo = reclamos.some(r=>r.orderNum===o.numero);
                    const envioC = ESTADO_ENVIO_C[o.estadoEnvio]||{bg:C.borderL,text:C.textSm,dot:C.textSm};
                    return (
                      <div key={o.numero} onClick={()=>setSelectedOrder(o.numero)}
                        style={{ display:"grid",gridTemplateColumns:"80px 1fr 1fr 160px 120px 80px",gap:8,padding:"10px 12px",borderBottom:`1px solid ${C.borderL}`,cursor:"pointer",transition:"background 0.1s",alignItems:"center" }}
                        onMouseEnter={e=>e.currentTarget.style.background=C.surface}
                        onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                        <div style={{ display:"flex",alignItems:"center",gap:6 }}>
                          <span style={{ fontWeight:600,color:C.accent,fontSize:13 }}>#{o.numero}</span>
                          {hasReclamo&&<span style={{ color:C.red,fontSize:10 }}>⚠</span>}
                        </div>
                        <div>
                          <div style={{ fontSize:13,fontWeight:500,color:C.text }}>{o.comprador}</div>
                          <div style={{ fontSize:11,color:C.textSm }}>{o.email}</div>
                        </div>
                        <div style={{ display:"flex",alignItems:"center",gap:6 }}>
                          <LensDots productos={o.productos}/>
                          <span style={{ fontSize:11,color:C.textSm,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>
                            {o.productos.map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'')).join(', ')}
                          </span>
                        </div>
                        <div><Badge colors={envioC}>{o.estadoEnvio}</Badge></div>
                        <div style={{ fontSize:13,fontWeight:600,color:C.text }}>{fmtMoney(o.total)}</div>
                        <div style={{ fontSize:11,color:C.textSm }}>{fmtDate(o.fecha).split('/').slice(0,2).join('/')}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── Reclamos ── */}
            {tab==="reclamos" && (
              <div style={{ paddingBottom:40 }}>
                {filteredReclamos.length===0 ? (
                  <div style={{ textAlign:"center",padding:"60px 20px",color:C.textSm }}>
                    <div style={{ fontSize:36,marginBottom:12 }}>📋</div>
                    <div style={{ fontSize:15,fontWeight:500,color:C.textMd }}>{reclamos.length===0?"Sin reclamos todavía":"Sin resultados"}</div>
                  </div>
                ) : (
                  <>
                    <div style={{ display:"grid",gridTemplateColumns:"80px 1fr 1fr 120px 110px 80px",gap:8,padding:"6px 12px",fontSize:11,color:C.textSm,fontWeight:500,textTransform:"uppercase",letterSpacing:0.5,borderBottom:`1px solid ${C.borderL}` }}>
                      <span>Pedido</span><span>Cliente</span><span>Motivo</span><span>Estado</span><span>Tipo</span><span>Fecha</span>
                    </div>
                    {filteredReclamos.map(r=>{
                      const o = orders.find(o=>o.numero===r.orderNum);
                      const sc = ESTADO_RECLAMO_C[r.estado]||{bg:C.borderL,text:C.textSm,dot:C.textSm};
                      const tc = TIPO_C[r.tipo]||{bg:C.borderL,text:C.textSm};
                      return (
                        <div key={r._docId} onClick={()=>setReclamoDetail(r._docId)}
                          style={{ display:"grid",gridTemplateColumns:"80px 1fr 1fr 120px 110px 80px",gap:8,padding:"10px 12px",borderBottom:`1px solid ${C.borderL}`,cursor:"pointer",transition:"background 0.1s",alignItems:"center",borderLeft:`3px solid ${sc.dot}` }}
                          onMouseEnter={e=>e.currentTarget.style.background=C.surface}
                          onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                          <span style={{ fontWeight:600,color:C.accent,fontSize:13 }}>#{r.orderNum}</span>
                          <div>
                            <div style={{ fontSize:13,fontWeight:500,color:C.text }}>{o?.comprador||"—"}</div>
                            <div style={{ fontSize:11,color:C.textSm }}>{o?.email||""}</div>
                          </div>
                          <div style={{ fontSize:12,color:C.textMd }}>{r.motivo}</div>
                          <Badge colors={sc}>{r.estado}</Badge>
                          <Badge colors={tc}>{r.tipo}</Badge>
                          <div style={{ fontSize:11,color:C.textSm }}>{fmtTs(r.createdAt)}</div>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Order Detail Modal ── */}
      <Modal open={!!selOrder} onClose={()=>setSelectedOrder(null)} title={selOrder?`Pedido #${selOrder.numero}`:""} width={600}>
        {selOrder&&(
          <div>
            <div style={{ display:"flex",gap:6,flexWrap:"wrap",marginBottom:16 }}>
              <button onClick={()=>{ setSelectedOrder(null); setReclamoForm(emptyForm(selOrder.numero)); }} style={{ ...btnDanger,fontSize:12 }}>📋 Crear Reclamo</button>
              <button onClick={()=>setActionModal({type:"direccion",order:selOrder})} style={{ ...btnSecondary,fontSize:12 }}>📍 Dirección</button>
              <button onClick={()=>setActionModal({type:"etiqueta",order:selOrder})} style={{ ...btnSecondary,fontSize:12,color:C.accent }}>🏷️ Andreani</button>
              {selOrder.linkOrden&&<a href={selOrder.linkOrden} target="_blank" rel="noopener noreferrer" style={{ ...btnSecondary,fontSize:12,textDecoration:"none",color:C.purple }}>🔗 Tienda Nube</a>}
            </div>
            <Divider/>
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:"6px 24px",fontSize:13,marginBottom:12 }}>
              {[["Cliente",selOrder.comprador],["Email",selOrder.email],["Teléfono",selOrder.telefono],["DNI/CUIT",selOrder.dni],["Fecha",fmtDate(selOrder.fecha)],["Canal",selOrder.canal],["Pago",selOrder.medioPago],["Estado pago",selOrder.estadoPago],["Envío",selOrder.medioEnvio],["Estado envío",selOrder.estadoEnvio],["Tracking",selOrder.tracking||"—"]].map(([l,v])=>v?(
                <div key={l} style={{ display:"flex",gap:8,padding:"4px 0",borderBottom:`1px solid ${C.borderL}` }}>
                  <span style={{ color:C.textSm,minWidth:90,flexShrink:0,fontSize:12 }}>{l}</span>
                  <span style={{ color:C.text,fontSize:12,fontWeight:500 }}>{v}</span>
                </div>
              ):null)}
            </div>
            <Divider/>
            <div style={{ fontSize:11,textTransform:"uppercase",color:C.textSm,fontWeight:500,letterSpacing:0.5,marginBottom:8 }}>Productos</div>
            {selOrder.productos.map((p,i)=>(
              <div key={i} style={{ display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:i<selOrder.productos.length-1?`1px solid ${C.borderL}`:"none" }}>
                <div>
                  <div style={{ fontSize:13,color:C.text }}>{p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'')}</div>
                  <div style={{ fontSize:11,color:C.textSm }}>SKU: {p.sku} · x{p.cantidad}</div>
                </div>
                <div style={{ fontSize:13,fontWeight:600,color:C.text }}>{fmtMoney(p.precio)}</div>
              </div>
            ))}
            <div style={{ display:"flex",justifyContent:"flex-end",marginTop:8,paddingTop:8,borderTop:`1px solid ${C.border}` }}>
              <span style={{ fontSize:15,fontWeight:700,color:C.text }}>{fmtMoney(selOrder.total)}</span>
            </div>
            {getOrderReclamos(selOrder.numero).length>0&&(
              <>
                <Divider/>
                <div style={{ fontSize:11,textTransform:"uppercase",color:C.red,fontWeight:500,letterSpacing:0.5,marginBottom:8 }}>Reclamos asociados</div>
                {getOrderReclamos(selOrder.numero).map(r=>(
                  <div key={r._docId} onClick={()=>{ setSelectedOrder(null); setReclamoDetail(r._docId); setTab("reclamos"); }}
                    style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",cursor:"pointer",borderBottom:`1px solid ${C.borderL}` }}>
                    <div style={{ display:"flex",gap:6,alignItems:"center" }}>
                      <Badge colors={ESTADO_RECLAMO_C[r.estado]||{}} small>{r.estado}</Badge>
                      <span style={{ fontSize:12,color:C.textMd }}>{r.tipo} — {r.motivo}</span>
                    </div>
                    <span style={{ fontSize:11,color:C.accent }}>→</span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </Modal>

      {/* ── Direccion Modal ── */}
      <Modal open={actionModal?.type==="direccion"} onClose={()=>setActionModal(null)} title="Dirección de Envío">
        {actionModal?.order&&(
          <div>
            <div style={{ background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:20,marginBottom:16 }}>
              <div style={{ fontSize:16,fontWeight:600,color:C.text,marginBottom:12 }}>{actionModal.order.nombreEnvio}</div>
              <div style={{ fontSize:14,lineHeight:2,color:C.textMd }}>
                <div>{actionModal.order.direccion} {actionModal.order.dirNumero}{actionModal.order.piso?`, Piso ${actionModal.order.piso}`:''}</div>
                <div>{actionModal.order.localidad}{actionModal.order.ciudad?`, ${actionModal.order.ciudad}`:''}</div>
                <div style={{ color:C.text,fontWeight:500 }}>CP {actionModal.order.cp} — {actionModal.order.provincia}</div>
                <div style={{ marginTop:4 }}>📞 {actionModal.order.telEnvio||actionModal.order.telefono}</div>
              </div>
            </div>
            <button onClick={()=>navigator.clipboard.writeText(fullAddress(actionModal.order))} style={{ ...btnSecondary,width:"100%",justifyContent:"center" }}>📋 Copiar dirección</button>
          </div>
        )}
      </Modal>

      {/* ── Etiqueta Modal ── */}
      <Modal open={actionModal?.type==="etiqueta"} onClose={()=>setActionModal(null)} title="Etiqueta Andreani" width={480}>
        {actionModal?.order&&(
          <div>
            <div style={{ border:`1px dashed ${C.accent}`,borderRadius:8,padding:20,background:C.bg,marginBottom:16 }}>
              <div style={{ display:"flex",justifyContent:"space-between",marginBottom:16 }}>
                <div>
                  <div style={{ fontSize:10,textTransform:"uppercase",color:C.accent,fontWeight:600,letterSpacing:1 }}>Remitente</div>
                  <div style={{ fontSize:14,fontWeight:600,color:C.text,marginTop:4 }}>Soluna Biolight</div>
                </div>
                <div style={{ fontSize:11,color:C.textSm,fontFamily:"monospace" }}>#{actionModal.order.numero}</div>
              </div>
              <div style={{ borderTop:`1px solid ${C.border}`,paddingTop:16 }}>
                <div style={{ fontSize:10,textTransform:"uppercase",color:C.accent,fontWeight:600,letterSpacing:1,marginBottom:8 }}>Destinatario</div>
                <div style={{ fontSize:16,fontWeight:700,color:C.text,marginBottom:8 }}>{actionModal.order.nombreEnvio}</div>
                <div style={{ fontSize:13,lineHeight:1.8,color:C.textMd }}>
                  <div>{actionModal.order.direccion} {actionModal.order.dirNumero}{actionModal.order.piso?`, Piso ${actionModal.order.piso}`:''}</div>
                  <div>{actionModal.order.localidad}{actionModal.order.ciudad?` — ${actionModal.order.ciudad}`:''}</div>
                  <div style={{ color:C.text,fontWeight:500 }}>CP {actionModal.order.cp} — {actionModal.order.provincia}</div>
                  <div style={{ marginTop:4 }}>Tel: {actionModal.order.telEnvio||actionModal.order.telefono}</div>
                </div>
              </div>
              {actionModal.order.tracking&&(
                <div style={{ marginTop:16,paddingTop:12,borderTop:`1px solid ${C.border}` }}>
                  <div style={{ fontSize:10,color:C.accent,fontWeight:600,textTransform:"uppercase",letterSpacing:1 }}>Tracking</div>
                  <div style={{ fontSize:15,fontWeight:700,fontFamily:"monospace",color:C.text,marginTop:4 }}>{actionModal.order.tracking}</div>
                </div>
              )}
            </div>
            <div style={{ display:"flex",gap:8 }}>
              <button onClick={()=>{ const t=`DESTINATARIO: ${actionModal.order.nombreEnvio}\n${actionModal.order.direccion} ${actionModal.order.dirNumero}${actionModal.order.piso?', Piso '+actionModal.order.piso:''}\n${actionModal.order.localidad}${actionModal.order.ciudad?' — '+actionModal.order.ciudad:''}\nCP ${actionModal.order.cp} — ${actionModal.order.provincia}\nTel: ${actionModal.order.telEnvio||actionModal.order.telefono}\nPedido #${actionModal.order.numero}`; navigator.clipboard.writeText(t); }} style={{ ...btnSecondary,flex:1,justifyContent:"center" }}>📋 Copiar</button>
              <button onClick={()=>window.print()} style={{ ...btnSecondary,flex:1,justifyContent:"center" }}>🖨️ Imprimir</button>
            </div>
          </div>
        )}
      </Modal>

      {/* ── Reclamo Form Modal ── */}
      <Modal open={!!reclamoForm} onClose={()=>setReclamoForm(null)} title={reclamoForm?._docId?"Editar Reclamo":reclamoForm?.orderNum?`Nuevo Reclamo — #${reclamoForm.orderNum}`:"Nuevo Reclamo"}>
        {reclamoForm&&(
          <div>
            {!reclamoForm._docId&&!reclamoForm.orderNum&&(
              <Field label="Pedido" required><OrderSearchField orders={orders} onSelect={num=>setReclamoForm(f=>({...f,orderNum:num}))}/></Field>
            )}
            {(()=>{ const o=orders.find(o=>o.numero===reclamoForm.orderNum); return o?(
              <div style={{ background:C.bg,border:`1px solid ${C.border}`,borderRadius:6,padding:"10px 12px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center" }}>
                <div>
                  <span style={{ fontWeight:600,color:C.text,fontSize:13 }}>#{o.numero} — {o.comprador}</span>
                  <div style={{ color:C.textSm,fontSize:11,marginTop:2 }}>{o.productos.map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'')).join(', ')}</div>
                </div>
                {!reclamoForm._docId&&<button onClick={()=>setReclamoForm(f=>({...f,orderNum:""}))} style={{ ...btnDanger,padding:"3px 8px",fontSize:11 }}>Cambiar</button>}
              </div>
            ):null; })()}
            {reclamoForm.orderNum&&(
              <>
                <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 12px" }}>
                  <Field label="Tipo"><select style={selSt} value={reclamoForm.tipo} onChange={e=>setReclamoForm(f=>({...f,tipo:e.target.value}))}>{TIPOS_RECLAMO.map(t=><option key={t}>{t}</option>)}</select></Field>
                  <Field label="Motivo" required><select style={selSt} value={reclamoForm.motivo} onChange={e=>setReclamoForm(f=>({...f,motivo:e.target.value}))}><option value="">Seleccionar...</option>{MOTIVOS.map(m=><option key={m}>{m}</option>)}</select></Field>
                </div>

                {reclamoForm.tipo==="Cambio"&&(
                  <div style={{ background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:14,marginBottom:12 }}>
                    <div style={{ fontSize:11,textTransform:"uppercase",color:C.purple,fontWeight:600,letterSpacing:0.5,marginBottom:10 }}>🔄 Detalle del cambio</div>
                    <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 16px" }}>
                      <div>
                        <div style={{ fontSize:11,color:C.textSm,fontWeight:500,marginBottom:6,textTransform:"uppercase",letterSpacing:0.3 }}>Nos devuelve</div>
                        {(reclamoForm.productosRecibe||[]).map((item,i)=>(
                          <div key={i} style={{ display:"flex",gap:4,marginBottom:6,alignItems:"center" }}>
                            <select style={{ ...selSt,flex:1,fontSize:11,padding:"5px 7px" }} value={item.producto} onChange={e=>{ const arr=[...reclamoForm.productosRecibe]; arr[i]={...arr[i],producto:e.target.value}; setReclamoForm(f=>({...f,productosRecibe:arr})); }}><option value="">Producto...</option>{PRODUCTOS.map(p=><option key={p}>{p}</option>)}</select>
                            <input type="number" min={1} value={item.cantidad} onChange={e=>{ const arr=[...reclamoForm.productosRecibe]; arr[i]={...arr[i],cantidad:parseInt(e.target.value)||1}; setReclamoForm(f=>({...f,productosRecibe:arr})); }} style={{ ...iSt,width:44,textAlign:"center",fontSize:11,padding:"5px 3px",flexShrink:0 }}/>
                            {reclamoForm.productosRecibe.length>1&&<button onClick={()=>setReclamoForm(f=>({...f,productosRecibe:f.productosRecibe.filter((_,j)=>j!==i)}))} style={{ ...btnDanger,padding:"3px 6px",fontSize:12,flexShrink:0 }}>✕</button>}
                          </div>
                        ))}
                        <button onClick={()=>setReclamoForm(f=>({...f,productosRecibe:[...f.productosRecibe,{producto:"",cantidad:1}]}))} style={{ ...btnSecondary,width:"100%",justifyContent:"center",fontSize:11,padding:"5px" }}>+ Agregar</button>
                      </div>
                      <div>
                        <div style={{ fontSize:11,color:C.textSm,fontWeight:500,marginBottom:6,textTransform:"uppercase",letterSpacing:0.3 }}>Le enviamos</div>
                        {(reclamoForm.productosEnvia||[]).map((item,i)=>(
                          <div key={i} style={{ display:"flex",gap:4,marginBottom:6,alignItems:"center" }}>
                            <select style={{ ...selSt,flex:1,fontSize:11,padding:"5px 7px" }} value={item.producto} onChange={e=>{ const arr=[...reclamoForm.productosEnvia]; arr[i]={...arr[i],producto:e.target.value}; setReclamoForm(f=>({...f,productosEnvia:arr})); }}><option value="">Producto...</option>{PRODUCTOS.map(p=><option key={p}>{p}</option>)}</select>
                            <input type="number" min={1} value={item.cantidad} onChange={e=>{ const arr=[...reclamoForm.productosEnvia]; arr[i]={...arr[i],cantidad:parseInt(e.target.value)||1}; setReclamoForm(f=>({...f,productosEnvia:arr})); }} style={{ ...iSt,width:44,textAlign:"center",fontSize:11,padding:"5px 3px",flexShrink:0 }}/>
                            {reclamoForm.productosEnvia.length>1&&<button onClick={()=>setReclamoForm(f=>({...f,productosEnvia:f.productosEnvia.filter((_,j)=>j!==i)}))} style={{ ...btnDanger,padding:"3px 6px",fontSize:12,flexShrink:0 }}>✕</button>}
                          </div>
                        ))}
                        <button onClick={()=>setReclamoForm(f=>({...f,productosEnvia:[...f.productosEnvia,{producto:"",cantidad:1}]}))} style={{ ...btnSecondary,width:"100%",justifyContent:"center",fontSize:11,padding:"5px" }}>+ Agregar</button>
                      </div>
                    </div>
                  </div>
                )}

                <Field label="Descripción"><textarea style={{ ...iSt,minHeight:60,resize:"vertical" }} value={reclamoForm.descripcion} onChange={e=>setReclamoForm(f=>({...f,descripcion:e.target.value}))} placeholder="Detalle del reclamo..."/></Field>

                {reclamoForm._docId&&(
                  <Field label="Estado">
                    <div style={{ display:"flex",gap:6,flexWrap:"wrap" }}>
                      {ESTADOS_RECLAMO.map(e=>{ const c=ESTADO_RECLAMO_C[e]; const sel=reclamoForm.estado===e; return (
                        <button key={e} onClick={()=>setReclamoForm(f=>({...f,estado:e}))} style={{ ...btnBase,padding:"6px 12px",fontSize:12,background:sel?c.bg:C.surface,color:sel?c.text:C.textMd,border:`1px solid ${sel?c.dot:C.border}`,fontWeight:sel?600:400 }}>
                          <span style={{ width:7,height:7,borderRadius:"50%",background:sel?c.dot:C.textSm }}/>{e}
                        </button>
                      ); })}
                    </div>
                  </Field>
                )}

                {reclamoForm._docId&&<Field label="Resolución"><textarea style={{ ...iSt,minHeight:50,resize:"vertical" }} value={reclamoForm.resolucion} onChange={e=>setReclamoForm(f=>({...f,resolucion:e.target.value}))} placeholder="Qué se hizo..."/></Field>}
                <Field label="Notas internas"><textarea style={{ ...iSt,minHeight:44,resize:"vertical" }} value={reclamoForm.notas} onChange={e=>setReclamoForm(f=>({...f,notas:e.target.value}))} placeholder="Notas para el equipo..."/></Field>

                <div style={{ display:"flex",gap:8,justifyContent:"flex-end",marginTop:8 }}>
                  <button onClick={()=>setReclamoForm(null)} style={btnSecondary}>Cancelar</button>
                  <button onClick={saveReclamo} disabled={saving||!reclamoForm.motivo} style={{ ...btnPrimary,opacity:saving||!reclamoForm.motivo?0.5:1 }}>
                    {saving?"Guardando...":(reclamoForm._docId?"Guardar cambios":"Crear Reclamo")}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>

      {/* ── Reclamo Detail Modal ── */}
      <Modal open={!!detailReclamo} onClose={()=>setReclamoDetail(null)} title={detailReclamo?`Reclamo — Pedido #${detailReclamo.orderNum}`:""}>
        {detailReclamo&&(()=>{
          const r=detailReclamo; const o=orders.find(o=>o.numero===r.orderNum);
          const sc=ESTADO_RECLAMO_C[r.estado]||{}; const tc=TIPO_C[r.tipo]||{};
          return (
            <div>
              {/* Status bar */}
              <div style={{ background:sc.bg,border:`1px solid ${sc.dot}44`,borderRadius:8,padding:"12px 16px",marginBottom:14,display:"flex",justifyContent:"space-between",alignItems:"center" }}>
                <div style={{ display:"flex",alignItems:"center",gap:8 }}>
                  <span style={{ width:10,height:10,borderRadius:"50%",background:sc.dot,boxShadow:`0 0 6px ${sc.dot}` }}/>
                  <span style={{ fontSize:15,fontWeight:600,color:sc.text }}>{r.estado}</span>
                </div>
                <span style={{ background:tc.bg,color:tc.text,padding:"3px 10px",borderRadius:20,fontSize:11,fontWeight:500,border:`1px solid ${tc.text}33` }}>{r.tipo}</span>
              </div>

              {o&&(
                <div style={{ background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 14px",marginBottom:12 }}>
                  <div style={{ fontWeight:600,color:C.text,fontSize:13 }}>#{o.numero} — {o.comprador}</div>
                  <div style={{ fontSize:11,color:C.textSm,marginTop:3 }}>{o.email} · {o.telefono}</div>
                  <div style={{ fontSize:11,color:C.textSm,marginTop:1 }}>{o.productos.map(p=>p.nombre.replace(/ANTEOJOS SOLUNA - BLUE LIGHT BLOCKER /,'').replace(/[()]/g,'')).join(', ')}</div>
                </div>
              )}

              <div style={{ fontSize:13,marginBottom:10,color:C.textMd }}>
                <span style={{ color:C.textSm }}>Motivo: </span>
                <span style={{ fontWeight:500,color:C.text }}>{r.motivo}</span>
              </div>

              {r.tipo==="Cambio"&&((r.productosRecibe?.length>0)||(r.productosEnvia?.length>0))&&(
                <div style={{ background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:14,marginBottom:10 }}>
                  <div style={{ fontSize:10,textTransform:"uppercase",color:C.purple,fontWeight:600,letterSpacing:0.5,marginBottom:10 }}>🔄 Detalle del cambio</div>
                  <div style={{ display:"grid",gridTemplateColumns:"1fr auto 1fr",gap:10,alignItems:"start" }}>
                    <div>
                      <div style={{ fontSize:10,color:C.textSm,fontWeight:500,textTransform:"uppercase",marginBottom:5 }}>Nos devuelve</div>
                      {(r.productosRecibe||[]).map((item,i)=><div key={i} style={{ fontSize:13,fontWeight:500,color:C.red,marginBottom:2 }}>{item.cantidad>1&&<span style={{ color:C.textSm,fontSize:11 }}>{item.cantidad}× </span>}{item.producto||"—"}</div>)}
                    </div>
                    <div style={{ color:C.textSm,paddingTop:18,fontSize:16 }}>→</div>
                    <div>
                      <div style={{ fontSize:10,color:C.textSm,fontWeight:500,textTransform:"uppercase",marginBottom:5 }}>Le enviamos</div>
                      {(r.productosEnvia||[]).map((item,i)=><div key={i} style={{ fontSize:13,fontWeight:500,color:C.green,marginBottom:2 }}>{item.cantidad>1&&<span style={{ color:C.textSm,fontSize:11 }}>{item.cantidad}× </span>}{item.producto||"—"}</div>)}
                    </div>
                  </div>
                </div>
              )}

              {r.descripcion&&<div style={{ background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:12,marginBottom:8,fontSize:13,color:C.textMd,lineHeight:1.5 }}>{r.descripcion}</div>}
              {r.resolucion&&(
                <div style={{ background:C.greenBg,border:`1px solid ${C.green}33`,borderRadius:8,padding:12,marginBottom:8 }}>
                  <div style={{ fontSize:10,textTransform:"uppercase",color:C.green,fontWeight:600,marginBottom:4,letterSpacing:0.5 }}>Resolución</div>
                  <div style={{ fontSize:13,color:C.text,lineHeight:1.5 }}>{r.resolucion}</div>
                </div>
              )}
              {r.notas&&(
                <div style={{ background:C.yellowBg,border:`1px solid ${C.yellow}33`,borderRadius:8,padding:12,marginBottom:8 }}>
                  <div style={{ fontSize:10,textTransform:"uppercase",color:C.yellow,fontWeight:600,marginBottom:4,letterSpacing:0.5 }}>Notas internas</div>
                  <div style={{ fontSize:13,color:C.text,lineHeight:1.5 }}>{r.notas}</div>
                </div>
              )}

              <div style={{ fontSize:11,color:C.textSm,marginTop:10 }}>
                Creado: {fmtTs(r.createdAt)}{r.resolvedAt?.seconds?` · Resuelto: ${fmtTs(r.resolvedAt)}`:''}
              </div>

              <Divider/>
              <div style={{ display:"flex",gap:8,justifyContent:"flex-end" }}>
                {deleteConfirm===r._docId?(
                  <div style={{ display:"flex",gap:6,alignItems:"center" }}>
                    <span style={{ fontSize:12,color:C.red }}>¿Eliminar?</span>
                    <button onClick={()=>deleteReclamo(r._docId)} style={{ ...btnDanger,padding:"5px 12px",fontSize:12 }}>Sí</button>
                    <button onClick={()=>setDeleteConfirm(null)} style={{ ...btnSecondary,padding:"5px 12px",fontSize:12 }}>No</button>
                  </div>
                ):(
                  <>
                    <button onClick={()=>setDeleteConfirm(r._docId)} style={{ ...btnDanger,padding:"6px 12px",fontSize:12 }}>Eliminar</button>
                    <button onClick={()=>{ setReclamoDetail(null); setReclamoForm({...r}); }} style={{ ...btnSecondary,padding:"6px 12px",fontSize:12 }}>Editar</button>
                  </>
                )}
              </div>
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}
