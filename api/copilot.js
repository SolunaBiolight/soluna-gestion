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
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { guardUid } from "./_auth.js";
import { snapshotMargenes, snapshotEnvios, snapshotStock, snapshotCuentas, estadoConfiguracion } from "./_snapshot.js";

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

// ─── Snapshot determinista de datos: vive en api/_snapshot.js ─────────────

// Los errores de fetch pueden arrastrar la URL llamada, y la URL de Gemini lleva
// la GOOGLE_AI_KEY como query param. Nunca mandamos el mensaje crudo al cliente.
function safeErr(msg) {
  const k = process.env.GOOGLE_AI_KEY;
  let s = String(msg || "Error inesperado");
  if (k) s = s.split(k).join("***");
  return s.replace(/([?&]key=)[^&\s]+/gi, "$1***");
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

CONFIGURACIÓN GUIADA: si el usuario pide configurar la app, hacer el setup, o dice
"configuración guiada" (o llegó desde el onboarding), mirá DATOS.estado_configuracion y
guialo como un onboarding conversacional:
1. Arrancá con un diagnóstico en 1-2 líneas: qué ya está listo (✓) y qué falta.
2. Después avanzá DE A UN PASO POR VEZ, en este orden de prioridad: tienda conectada
   (sin tienda no hay datos) → costos de productos en Márgenes (sin costos no hay
   ganancia real) → ARCA si factura → Meta Ads si hace pauta → stock → equipo.
   Saltá lo que ya está configurado y lo que el usuario diga que no usa.
3. En cada paso explicá EN CRIOLLO qué gana con eso, qué tiene que hacer exactamente,
   y cerrá con la acción navegar a la sección correspondiente para llevarlo ahí.
4. Cuando vuelva y te diga "listo" (o le preguntes si lo hizo), seguí con el paso
   siguiente. Si todo está configurado, felicitalo y sugerile pedir el resumen diario.

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

// Datos del negocio para la IA (Copilot y el conector de Claude en api/mcp.js):
// snapshot determinista de Firestore — la IA nunca inventa cifras.
export async function armarDatosNegocio(db, uid) {
  // Snapshot determinista (paralelo, best-effort por bloque)
  const [margenes, envios, cuentas, stock] = await Promise.all([
    snapshotMargenes(db, uid),
    snapshotEnvios(db, uid),
    snapshotCuentas(db, uid),
    snapshotStock(db, uid),
  ]);
  if (margenes && cuentas?.metas_margenes) margenes.metas_configuradas = cuentas.metas_margenes;

  // Estado de configuración de la cuenta — alimenta la "configuración guiada":
  // el modelo ve qué está listo y qué falta, y guía paso a paso sin inventar.
  const estadoConfig = estadoConfiguracion(margenes, cuentas, stock);

  return {
    fecha_hora_actual: new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }),
    estado_configuracion: estadoConfig,
    margenes: margenes || "SIN DATOS — el usuario todavía no abrió la sección Márgenes (el caché se genera al abrirla). Sugerile entrar a Márgenes para que se calculen.",
    envios: envios || "SIN DATOS de envíos registrados.",
    stock: stock || "SIN DATOS de stock — sugerile abrir la sección Stock (el snapshot se genera al usarla).",
    cuentas_conectadas: cuentas || "SIN DATOS",
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  { const _o=String(req.headers.origin||""); res.setHeader("Access-Control-Allow-Origin", (["https://www.growithapp.com","https://growithapp.com","https://soluna-gestion.vercel.app"].includes(_o)||_o.endsWith("-soluna1.vercel.app")||_o.startsWith("http://localhost"))?_o:"https://www.growithapp.com"); } // allowlist CORS
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

  // Límite de uso diario por cuenta: protege el presupuesto de la API de
  // Gemini de loops o abuso. 100 mensajes/día alcanza de sobra para uso real.
  try {
    const day = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
    const usageRef = db.collection("usage").doc(`${uid}_${day}`);
    const uSnap = await usageRef.get();
    const usados = Number(uSnap.data()?.copilot_msgs) || 0;
    if (usados >= 100) return res.status(429).json({ error: "Llegaste al límite de 100 mensajes por día del Copilot. Mañana se renueva solo." });
    usageRef.set({ uid, date: day, section: "copilot", copilot_msgs: FieldValue.increment(1), updatedAt: new Date() }, { merge: true }).catch(() => {});
  } catch (_) {}

  const datos = await armarDatosNegocio(db, uid);

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
