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
import { verifyAuth } from "./_auth.js";

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
- **Audio** (#/audio): text-to-speech para creativos.
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

La app convierte la etiqueta en un botón/tarjeta de CONFIRMACIÓN que el usuario toca —
nada se ejecuta solo. Máximo una acción por respuesta. No inventes otros tipos de acción.

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

  const authUser = await verifyAuth(req);
  if (!authUser) return res.status(401).json({ error: "Sesión inválida. Cerrá sesión y volvé a entrar." });

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
  const [margenes, envios, cuentas] = await Promise.all([
    snapshotMargenes(db, uid),
    snapshotEnvios(db, uid),
    snapshotCuentas(db, uid),
  ]);
  if (margenes && cuentas?.metas_margenes) margenes.metas_configuradas = cuentas.metas_margenes;

  const datos = {
    fecha_hora_actual: new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }),
    margenes: margenes || "SIN DATOS — el usuario todavía no abrió la sección Márgenes (el caché se genera al abrirla). Sugerile entrar a Márgenes para que se calculen.",
    envios: envios || "SIN DATOS de envíos registrados.",
    cuentas_conectadas: cuentas || "SIN DATOS",
  };

  const contents = [
    ...messages.slice(0, -1).map(m => ({ role: m.role, parts: [{ text: m.text }] })),
    {
      role: "user",
      parts: [{
        text: `## DATOS (única fuente de verdad — calculados por Growith, no por vos):\n${JSON.stringify(datos)}\n\n## Pregunta del usuario:\n${messages[messages.length - 1].text}`,
      }],
    },
  ];

  try {
    const r = await fetch(`${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: { temperature: 0.3, top_p: 0.9, max_output_tokens: 2000 },
      }),
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
    return res.status(500).json({ error: e.message });
  }
}
