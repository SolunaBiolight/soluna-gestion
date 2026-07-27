// api/copilot.js
// Copilot de Growith — agente conversacional sobre los datos REALES del negocio.
//
// Principio de diseño (anti-alucinación): la IA nunca genera números. Todos los
// datos salen de cálculos deterministas ya hechos por la app (caché de Márgenes,
// historial de Envíos, cuentas conectadas) y se le pasan como JSON. El modelo
// solo interpreta y redacta; el system prompt le prohíbe inventar cifras y le
// exige decir "no tengo ese dato" cuando falta.
//
// Sin acciones de escritura en v1 — el Copilot lee y explica, no toca nada.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { guardUid } from "./_auth.js";

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
    }),
  });
  return getFirestore();
}

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_MODEL = "gemini-2.5-flash";

// ─── Snapshot determinista de datos ──────────────────────────────────────
// Todo sale de Firestore (rápido, sin llamadas a APIs externas). Si algo
// falta, el campo queda en null y el prompt le dice al modelo qué significa.

const n2 = (v) => (typeof v === "number" && isFinite(v)) ? +v.toFixed(2) : 0;

// Los errores de fetch pueden arrastrar la URL llamada, y la URL de Gemini lleva
// la GOOGLE_AI_KEY como query param. Nunca mandamos el mensaje crudo al cliente.
function safeErr(msg) {
  const k = process.env.GOOGLE_AI_KEY;
  let s = String(msg || "Error inesperado");
  if (k) s = s.split(k).join("***");
  return s.replace(/([?&]key=)[^&\s]+/gi, "$1***");
}

function resumenDeRows(rows, desdeIdx) {
  // rows del caché de Márgenes: keys tipo "Fecha", "Revenue", "Ad Spend", "Profit"
  const slice = desdeIdx != null ? rows.slice(desdeIdx) : rows;
  const acc = { dias: slice.length, ordenes: 0, facturacion: 0, pauta: 0, ganancia: 0 };
  for (const r of slice) {
    acc.ordenes += r["Ordenes > $0"] || r.orders || 0;
    acc.facturacion += r.Revenue || r.revenue || 0;
    acc.pauta += r["Ad Spend"] || r.adSpend || 0;
    acc.ganancia += r.Profit ?? r.profit ?? 0;
  }
  acc.facturacion = n2(acc.facturacion); acc.pauta = n2(acc.pauta); acc.ganancia = n2(acc.ganancia);
  acc.margen_pct = acc.facturacion > 0 ? n2(acc.ganancia / acc.facturacion * 100) : 0;
  return acc;
}

async function snapshotMargenes(db, uid) {
  try {
    const snap = await db.collection("users").doc(uid).collection("margenes_cache").doc("d30").get();
    if (!snap.exists) return null;
    const doc = snap.data();
    const m = JSON.parse(doc.body || "{}");
    const rows = Array.isArray(m.rows) ? m.rows : [];
    const hoyIso = new Date().toISOString().slice(0, 10);
    const idxHoy = rows.findIndex(r => (r.Fecha || r.fecha) === hoyIso);
    const t = m.totals || {};
    return {
      datos_al: doc.cachedAt || null,
      periodo: { desde: m.since, hasta: m.until },
      ultimos_30_dias: {
        facturacion: n2(t.revenue), ordenes: t.orders || 0,
        pauta_total: n2(t.adSpend), pauta_meta: n2(t.adSpendMeta), pauta_ml: n2(t.adSpendMl),
        ganancia_neta: n2(t.profit), margen_pct: n2((t.profitMargin || 0) * 100),
        roas: n2(t.roas), true_roas: n2(t.trueRoas), cpa: n2(t.cpa),
        roas_break_even: n2(t.breakEvenRoas),
      },
      ultimos_7_dias: resumenDeRows(rows, Math.max(0, rows.length - 7)),
      ayer: (() => {
        // "ayer" = anteúltima fila si la última es hoy; si no, la última.
        const r = rows[rows.length - (idxHoy >= 0 ? 2 : 1)];
        if (!r) return null;
        return { fecha: r.Fecha || r.fecha, facturacion: n2(r.Revenue || 0), pauta: n2(r["Ad Spend"] || 0), ganancia: n2(r.Profit ?? 0), ordenes: r["Ordenes > $0"] || 0 };
      })(),
      por_canal: m.byChannel || null,
      top_productos: (m.byProduct || []).slice(0, 12).map(p => ({
        producto: p.nombre || p.name || p.key, canal: p.canal || null,
        facturacion: n2(p.revenue), ganancia: n2(p.profit),
        margen_pct: n2((p.margin || 0) * 100), unidades: p.units || 0,
        sin_costo_configurado: !!p.sinCogs,
      })),
      clientes: m.clientes || null,
      cashflow_mercadopago: m.cashflow || null,
      dolar: m.dolarActual || null,
      calidad_del_dato: m.quality || null,
      metas_configuradas: null, // se llena desde el user doc
    };
  } catch (e) {
    console.warn("[copilot] snapshotMargenes:", e.message);
    return null;
  }
}

async function snapshotEnvios(db, uid) {
  try {
    const desde = new Date(Date.now() - 60 * 86400000).toISOString();
    const snap = await db.collection("users").doc(uid).collection("envios")
      .where("creado", ">=", desde).get();
    const envios = snap.docs.map(d => d.data());
    if (envios.length === 0) return { total_60d: 0 };
    const activos = envios.filter(e => e.activo);
    const porCat = {};
    for (const e of envios) porCat[e.categoria || "sin_categoria"] = (porCat[e.categoria || "sin_categoria"] || 0) + 1;
    const dias = iso => iso ? Math.floor((Date.now() - Date.parse(iso)) / 86400000) : null;
    const alertas = [];
    for (const e of activos) {
      if (e.categoria === "en_sucursal" && dias(e.enSucursalDesde) >= 3)
        alertas.push(`#${e.numero} en sucursal hace ${dias(e.enSucursalDesde)} días sin retirar`);
      if (e.categoria === "visita_fallida") alertas.push(`#${e.numero} con visita fallida`);
      if (e.categoria === "devolucion") alertas.push(`#${e.numero} volviendo (devolución)`);
      const dEst = dias(e.estadoDesde || e.despachadoAt);
      if ((e.categoria === "en_camino" || e.categoria === "desconocido") && dEst >= 7)
        alertas.push(`#${e.numero} sin movimiento hace ${dEst} días`);
    }
    const entregados30 = envios.filter(e => e.entregadoAt && dias(e.entregadoAt) <= 30);
    const tiempos = entregados30.filter(e => e.despachadoAt)
      .map(e => (Date.parse(e.entregadoAt) - Date.parse(e.despachadoAt)) / 86400000)
      .filter(d => d >= 0 && d < 40);
    return {
      total_60d: envios.length,
      activos_en_seguimiento: activos.length,
      por_categoria: porCat,
      alertas: alertas.slice(0, 10),
      entregados_ultimos_30d: entregados30.length,
      dias_promedio_despacho_a_entrega: tiempos.length ? n2(tiempos.reduce((a, b) => a + b, 0) / tiempos.length) : null,
    };
  } catch (e) {
    console.warn("[copilot] snapshotEnvios:", e.message);
    return null;
  }
}

async function snapshotStock(db, uid) {
  try {
    const [itemsSnap, userSnap, cacheSnap] = await Promise.all([
      db.collection("users").doc(uid).collection("inventory_items").get(),
      db.collection("users").doc(uid).get(),
      db.collection("users").doc(uid).collection("stock_cache").doc("d7").get(),
    ]);
    const settings = userSnap.data()?.inventory_settings || {};
    const umbral = settings.alert_global || 14;
    const items = itemsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const cache = cacheSnap.exists ? cacheSnap.data().data : null;
    const variantes = [];
    if (cache?.products) {
      for (const p of cache.products) for (const v of (p.variants || [])) {
        const rate = (v.units_sold || 0) / 7;
        variantes.push({
          producto: p.nombre, variante: v.nombre, sku: v.sku || null,
          stock_tienda: v.stock, vendidos_7d: v.units_sold || 0,
          dias_restantes: rate > 0 ? Math.round(v.stock / rate) : null,
        });
      }
      variantes.sort((a, b) => (a.dias_restantes ?? 9999) - (b.dias_restantes ?? 9999));
    }
    if (items.length === 0 && variantes.length === 0) return null;
    return {
      umbral_alerta_dias: umbral,
      stock_cruzado_modo: settings.sync_mode || "off",
      // Inventario central de Growith (item_id sirve para la acción ajustar_stock)
      inventario_central: items.slice(0, 40).map(i => ({
        item_id: i.id, nombre: i.nombre, sku: i.sku || null,
        stock: Math.max(0, i.stock_total || 0), canales: i.canales || [],
      })),
      // Stock y velocidad por variante según la tienda (últimos 7 días)
      por_variante_7d: variantes.slice(0, 40),
      alertas: variantes.filter(v => v.stock_tienda === 0 || (v.dias_restantes != null && v.dias_restantes <= umbral)).slice(0, 15),
    };
  } catch (e) {
    console.warn("[copilot] snapshotStock:", e.message);
    return null;
  }
}

async function snapshotCuentas(db, uid) {
  try {
    const [userSnap, metaSnap] = await Promise.all([
      db.collection("users").doc(uid).get(),
      db.collection("users").doc(uid).collection("meta_accounts").get(),
    ]);
    const u = userSnap.data() || {};
    return {
      tiendas: (u.stores || []).map(s => ({ tipo: s.type, nombre: s.name || s.store_name || null })),
      cuits_arca: (u.cuits || []).length,
      meta_ads: metaSnap.docs.map(d => {
        const a = d.data();
        return { acc_id: d.id, nombre: a.user_name, cuenta_publicitaria: a.ad_account_name || null, token_vencido: !!a.token_invalid, tiene_token: !!a.access_token };
      }),
      // Campañas de Meta (para que el Copilot pueda proponer pausar/activar con
      // ids REALES — nunca inventados). Primera cuenta con token, máx 25.
      campanas_meta: await (async () => {
        try {
          const accDoc = metaSnap.docs.find(d => d.data().access_token && d.data().ad_account_id);
          if (!accDoc) return null;
          const a = accDoc.data();
          const r = await fetch(`https://graph.facebook.com/v23.0/${a.ad_account_id}/campaigns?fields=id,name,status,daily_budget&limit=25&access_token=${encodeURIComponent(a.access_token)}`, { signal: AbortSignal.timeout(10000) });
          if (!r.ok) return null;
          const j = await r.json();
          return (j.data || []).map(c => ({ acc_id: accDoc.id, id: c.id, nombre: c.name, estado: c.status, presupuesto_diario: c.daily_budget ? +(c.daily_budget/100).toFixed(0) : null }));
        } catch (_) { return null; }
      })(),
      metas_margenes: u.margenesMetas || null,
      // Colaboradores del equipo (para la acción crear_tarea — emails REALES)
      colaboradores: await (async () => {
        try {
          const cs = await db.collection("colaboradores").where("uid", "==", uid).limit(20).get();
          return cs.docs.map(d => ({ nombre: d.data().nombre || "", email: d.data().email || "" })).filter(c => c.email);
        } catch (_) { return []; }
      })(),
    };
  } catch (e) {
    console.warn("[copilot] snapshotCuentas:", e.message);
    return null;
  }
}

// ─── Guía de uso de la app (para preguntas de "cómo hago X") ─────────────

const GUIA_APP = `## Mapa de Growith (secciones y para qué sirve cada una)
- **Inicio** (#/): dashboard con KPIs del día, alertas y accesos rápidos.
- **Envíos** (#/envios): pedidos de Tienda Nube listos para empaquetar/enviar. Flujo de etiquetas Andreani: 1) tab "Enviar" → seleccionar pedidos → "Exportar Excel" (genera el Excel para el portal de Andreani), 2) cargar ese Excel en el portal Andreani y descargar el PDF de rótulos, 3) tab "SKU en Rótulos" → subir el PDF UNA vez: estampa los SKU en cada rótulo Y detecta los seguimientos, 4) desde ahí mismo (o en el tab "Seguimientos") enviar los trackings a Tienda Nube — el cliente recibe el aviso. El tab Seguimientos también muestra el estado real de cada envío (se actualiza solo cada 30 min) con alertas de paquetes demorados o sin retirar. Botón ✓ en cada pedido = marcar empaquetado en TN. "Picking List" imprime el resumen de armado por SKU.
- **Reclamos** (#/reclamos): pipeline kanban de reclamos y cambios.
- **Canjes** (#/canjes): influencers y canjes.
- **Stock** (#/stock): unidades disponibles y ventas por SKU conectado a TN/Shopify/ML, alertas de quiebre, lead times.
- **Márgenes** (#/margenes): rentabilidad real. Config de costos: tab "Costos" (COGS por producto, impuestos, comisiones, envío, costos fijos). Vistas Global / Tienda Nube / ML. Tab "P&L" = resultado mensual. Las metas de ROAS/margen se configuran con el engranaje.
- **Meta Ads** (#/metaads): análisis de campañas, biblioteca de anuncios con análisis IA, reglas automáticas (pausar/subir/bajar presupuesto), publicación de creativos. Requiere cuenta de Meta conectada (tab Cuenta o Config).
- **ARCA** (#/arca): facturación electrónica AFIP.
- **Config** (#/config): conectar Tienda Nube, Shopify, Mercado Libre, Meta; tokens y equipo.
- Ctrl+K abre el buscador de comandos.`;

const SYSTEM_PROMPT = `Sos el **Copilot de Growith**, el asistente del dueño de un ecommerce argentino que usa Growith (app de gestión: envíos, márgenes, stock, Meta Ads, facturación).

ALCANCE: sos un asistente COMPLETO. Además de los datos del negocio, podés responder
CUALQUIER pregunta general (marketing, e-commerce, publicidad, redacción de textos,
ideas de campañas, dudas de cualquier tema) con tu conocimiento, como un asistente
de IA normal. La única frontera dura son las CIFRAS del negocio del usuario:

REGLAS INQUEBRANTABLES SOBRE DATOS DEL NEGOCIO:
1. Los ÚNICOS números DEL NEGOCIO DEL USUARIO que podés mencionar son los que aparecen en el bloque DATOS de este prompt. Está PROHIBIDO inventar, estimar, extrapolar o "recordar" cifras de SU negocio. (Datos generales del mundo — benchmarks públicos, definiciones, ejemplos hipotéticos marcados como tales — sí podés darlos.)
2. Si te preguntan por un dato del negocio que NO está en DATOS, decí claramente que no lo tenés a mano y indicá en qué sección de la app pueden verlo (usá la guía).
3. Podés hacer aritmética simple sobre los números de DATOS (sumas, restas, porcentajes) pero mostrá de dónde sale ("$X de facturación menos $Y de pauta...").
4. "datos_al" indica cuándo se calcularon los datos de Márgenes — si te preguntan por lo más reciente, aclaralo ("con datos actualizados a las HH:MM").
5. No des consejos financieros de inversión. Sí podés interpretar métricas del negocio (ROAS vs break-even, margen, productos que pierden plata) y sugerir acciones DENTRO de la app.

ESTILO:
- Español rioplatense con voseo (vos/tenés/podés). Nunca tú/tienes.
- Directo y concreto. Respuestas cortas (2-6 oraciones) salvo que pidan detalle.
- Montos en pesos: $1.234.567 (punto como separador de miles). Porcentajes con 1 decimal.
- Podés usar **negrita** para el dato clave. Sin emojis en exceso (máximo 1-2).
- Si detectás algo preocupante en los datos (producto con margen negativo, envío demorado, token vencido), mencionalo aunque no lo hayan preguntado — sos un copiloto, no un buscador.

ACCIONES EN LA APP:
Podés ejecutar UNA acción por respuesta agregando al FINAL, en su propia línea, una
etiqueta EXACTA con este formato (sin nada más en esa línea):
[[ACCION:navegar:<pagina>]]
donde <pagina> es una de: home, margenes, envios, reclamos, canjes, stock, meta, ml, arca, tareas, config, planes, copilot.
Usala cuando el usuario pida ir/abrir/ver una sección, o cuando tu respuesta invite a
hacer algo en una sección concreta ("cargá el costo en..." → navegar a margenes).

[[ACCION:meta_estado:<acc_id>:<campaign_id>:<ACTIVE|PAUSED>:<nombre de la campaña>]]
Para pausar (PAUSED) o activar (ACTIVE) una campaña de Meta cuando el usuario lo pida.
REGLAS: usá SOLO acc_id e ids de campañas que estén en DATOS.cuentas_conectadas.campanas_meta
(si no está la campaña, decilo y sugerí abrir Meta Ads — no inventes ids). Si el pedido es
ambiguo ("pausá la campaña"), primero listá las campañas y preguntá cuál.

[[ACCION:meta_presupuesto:<acc_id>:<campaign_id>:<monto_diario_en_pesos>:<nombre de la campaña>]]
Para cambiar el presupuesto DIARIO de una campaña de Meta (monto entero en pesos, sin
símbolos). Mismas reglas de ids que meta_estado. Si la campaña no tiene presupuesto_diario
en DATOS (presupuesto a nivel ad set), decilo y sugerí hacerlo desde Meta Ads.

[[ACCION:crear_tarea:<email_asignado>|<título>|<descripción>]]
Para crear una tarea a un colaborador del equipo (separador: barra vertical |).
REGLAS: el email TIENE que estar en DATOS.cuentas_conectadas.colaboradores. Si no hay
colaboradores o el pedido no dice a quién, listá los disponibles y preguntá.

[[ACCION:ajustar_stock:<item_id>|<nuevo_stock>|<nombre del item>]]
Para setear el stock de un item del inventario central (número entero ≥ 0).
REGLAS: usá SOLO item_id que estén en DATOS.stock.inventario_central. Si el stock cruzado
está activado, aclarale que el cambio se propaga a sus tiendas.

RESUMEN DIARIO: si el usuario pide "resumen diario" (o similar), armá un resumen ejecutivo
breve: cómo cerró ayer (facturación, ganancia, órdenes), tendencia de los últimos 7 días,
alertas de stock y de envíos si las hay, y UNA recomendación concreta. Terminá sin acción
salvo que algo urgente amerite una.

La app convierte cada etiqueta en un botón/tarjeta de CONFIRMACIÓN que el usuario toca —
nada se ejecuta solo. Máximo una acción por respuesta. No inventes otros tipos de acción.

ARCHIVOS ADJUNTOS: si el mensaje incluye una imagen o un archivo de texto/CSV adjunto,
analizalo con el mismo rigor: podés leer sus números y citarlos (son datos que el usuario
te dio), pero no los mezcles con los de DATOS sin aclarar la fuente.

${GUIA_APP}`;

// ─── Handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Solo POST" });

  const { uid } = req.query;
  if (!uid) return res.status(401).json({ error: "Falta uid" });

  // El snapshot que se le arma al modelo es TODO el negocio del uid pedido
  // (facturación, envíos, campañas, colaboradores). Con verifyAuth a secas
  // bastaba estar logueado en cualquier cuenta para pedir el snapshot ajeno:
  // guardUid exige que el token pertenezca a ese tenant (o a su equipo/admin).
  if (!(await guardUid(req, res, uid))) return;

  const apiKey = process.env.GOOGLE_AI_KEY;
  if (!apiKey) return res.status(500).json({ error: "Falta GOOGLE_AI_KEY en Vercel" });

  const rawMsgs = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const messages = rawMsgs.slice(-16).map(m => ({
    role: m.role === "assistant" || m.role === "model" ? "model" : "user",
    text: String(m.text || "").slice(0, 4000),
  })).filter(m => m.text.trim());
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    return res.status(400).json({ error: "Falta el mensaje del usuario" });
  }

  const db = initAdmin();

  // Snapshot determinista (paralelo, best-effort por bloque)
  const [margenes, envios, cuentas, stock] = await Promise.all([
    snapshotMargenes(db, uid),
    snapshotEnvios(db, uid),
    snapshotCuentas(db, uid),
    snapshotStock(db, uid),
  ]);
  if (margenes && cuentas?.metas_margenes) margenes.metas_configuradas = cuentas.metas_margenes;

  const datos = {
    fecha_hora_actual: new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }),
    margenes: margenes || "SIN DATOS — el usuario todavía no abrió la sección Márgenes (el caché se genera al abrirla). Sugerile entrar a Márgenes para que se calculen.",
    envios: envios || "SIN DATOS de envíos registrados.",
    stock: stock || "SIN DATOS de stock — sugerile abrir la sección Stock (el snapshot se genera al usarla).",
    cuentas_conectadas: cuentas || "SIN DATOS",
  };

  // Adjuntos: imagen (inlineData de Gemini) o texto/CSV (se inyecta en el mensaje)
  const adjunto = req.body?.adjunto; // { mime, data_b64 } — solo imágenes
  const adjuntoTexto = req.body?.adjunto_texto; // { nombre, texto }
  const lastParts = [];
  let lastText = `## DATOS (única fuente de verdad — calculados por Growith, no por vos):\n${JSON.stringify(datos)}\n\n`;
  if (adjuntoTexto?.texto) {
    lastText += `## Archivo adjunto "${String(adjuntoTexto.nombre || "archivo").slice(0, 80)}" (provisto por el usuario):\n${String(adjuntoTexto.texto).slice(0, 60000)}\n\n`;
  }
  lastText += `## Pregunta del usuario:\n${messages[messages.length - 1].text}`;
  lastParts.push({ text: lastText });
  if (adjunto?.data_b64 && /^image\//.test(String(adjunto.mime || ""))) {
    if (adjunto.data_b64.length > 5_500_000) return res.status(400).json({ error: "La imagen es muy pesada (máx ~4MB)." });
    lastParts.push({ inlineData: { mimeType: String(adjunto.mime), data: String(adjunto.data_b64) } });
  }

  const contents = [
    ...messages.slice(0, -1).map(m => ({ role: m.role, parts: [{ text: m.text }] })),
    { role: "user", parts: lastParts },
  ];

  const geminiBody = JSON.stringify({
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: { temperature: 0.3, top_p: 0.9, max_output_tokens: 2000 },
  });

  // ── Modo STREAMING (SSE): la respuesta se ve escribir en vivo ──
  if (req.query.stream === "1") {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    try {
      const r = await fetch(`${GEMINI_BASE}/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${apiKey}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: geminiBody,
        signal: AbortSignal.timeout(55000),
      });
      if (!r.ok || !r.body) {
        res.write(`data: ${JSON.stringify({ error: `Gemini HTTP ${r.status}` })}\n\n`);
        return res.end();
      }
      const decoder = new TextDecoder();
      let buffer = "", total = "";
      for await (const chunk of r.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop(); // línea incompleta queda para el próximo chunk
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const j = JSON.parse(line.slice(6));
            const t = j.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
            if (t) { total += t; res.write(`data: ${JSON.stringify({ t })}\n\n`); }
          } catch (_) {}
        }
      }
      if (!total.trim()) res.write(`data: ${JSON.stringify({ error: "El modelo no devolvió respuesta. Probá de nuevo." })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true, datos_al: margenes?.datos_al || null })}\n\n`);
      return res.end();
    } catch (e) {
      console.error("[copilot stream]", e.message);
      try { res.write(`data: ${JSON.stringify({ error: safeErr(e.message) })}\n\n`); } catch (_) {}
      return res.end();
    }
  }

  // ── Modo clásico (fallback sin streaming) ──
  try {
    const r = await fetch(`${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: geminiBody,
      signal: AbortSignal.timeout(45000),
    });
    const data = await r.json();
    const reply = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    if (!reply.trim()) {
      const block = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || "sin respuesta";
      return res.status(502).json({ error: `El modelo no devolvió respuesta (${block}). Probá de nuevo.` });
    }
    return res.json({
      reply: reply.trim(),
      datos_al: margenes?.datos_al || null,
    });
  } catch (e) {
    console.error("[copilot]", e.message);
    return res.status(500).json({ error: safeErr(e.message) });
  }
}
