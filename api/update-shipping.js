import { createCipheriv } from "crypto";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { guardUid, guardCron } from "./_auth.js";
import { trazasOficialAndreani, trazasDebugAndreani } from "./andreani.js";

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

// ── Consulta de tracking Andreani (endpoints públicos, sin API contratada) ──
// Factoreada para que la usen tanto el proxy (action=tracking) como el cron
// de seguimiento masivo (action=track_all).
const BROWSER_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'es-AR,es;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Origin': 'https://www.andreani.com',
  'Referer': 'https://www.andreani.com/',
};

// La API oficial v1 de trazas devuelve las claves Capitalizadas ("Estado",
// "Fecha", "Evento") y los endpoints públicos en minúscula — se aceptan ambas.
function estadoDeEvento(ev) {
  if (!ev || typeof ev !== 'object') return null;
  return ev.estado || ev.Estado || ev.evento || ev.Evento || ev.descripcion || ev.Descripcion || ev.accion || ev.Accion || ev.motivo || ev.Motivo || null;
}

function extractEstado(d) {
  if (!d || typeof d !== 'object') return null;
  const evs = extractEventos(d);
  if (evs.length > 0) {
    const est = estadoDeEvento(evs[evs.length - 1]);
    if (est) return est;
  }
  return d.estado || d.Estado || d.estadoActual || d.estadoEnvio ||
         d.ultimoEvento?.estado || d.ultimoEvento?.descripcion ||
         d.evento || d.Evento || d.descripcion || null;
}

function extractEventos(d) {
  if (!d || typeof d !== 'object') return [];
  if (Array.isArray(d.eventos)) return d.eventos;
  if (Array.isArray(d.Eventos)) return d.Eventos;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d.historial)) return d.historial;
  if (Array.isArray(d.events)) return d.events;
  return [];
}

// ── Tracking público NUEVO de andreani.com/envio/{n} ──────────────────────
// El sitio consulta tracking-api.andreani.com/api/v3/Tracking?payload=<AES>.
// El payload es AES-256-CBC del JSON {idReceptor,idSistema,userData,numeroAndreani}
// con clave e IV que el propio front publica en su __ENV.js (son públicos:
// el "cifrado" solo ofusca la query, no autentica). Es tracking público: anda
// con envíos de CUALQUIER cuenta, que es lo que necesitamos para los envíos
// viejos emitidos fuera del contrato corporativo.
const AND_PUB_KEY = Buffer.from("12345678901234567890123456789012", "utf8");
const AND_PUB_IV  = Buffer.from("1234567890123456", "utf8");
function andreaniPublicPayload(nro) {
  const body = JSON.stringify({ idReceptor: 1, idSistema: 1, userData: JSON.stringify({ mail: "" }), numeroAndreani: String(nro) });
  const c = createCipheriv("aes-256-cbc", AND_PUB_KEY, AND_PUB_IV);
  return Buffer.concat([c.update(body, "utf8"), c.final()]).toString("base64");
}
// Normaliza la respuesta v3 a {estado, eventos:[{estado,fecha,descripcion}]}.
// Estructura real: {timelines:[{orden,titulo,traducciones:[{traduccion,fechaEvento}]}]}
// — cada timeline es una etapa (Pendiente de ingreso / Ingresado / En camino /
// En sucursal / Entregado) y solo las alcanzadas traen `traducciones`.
// El estado actual = el evento de fecha máxima; su `titulo` es la etapa.
function parseTrackingV3(d) {
  if (!d || typeof d !== "object") return null;
  const tls = Array.isArray(d.timelines) ? d.timelines : (Array.isArray(d.Timelines) ? d.Timelines : []);
  const eventos = [];
  for (const t of tls) {
    const titulo = t.titulo || t.Titulo || "";
    const trads = Array.isArray(t.traducciones) ? t.traducciones : (Array.isArray(t.Traducciones) ? t.Traducciones : []);
    for (const tr of trads) {
      eventos.push({
        estado: titulo,
        descripcion: String(tr.traduccion || tr.Traduccion || "").replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim(),
        fecha: tr.fechaEvento || tr.FechaEvento || "",
        orden: Number(t.orden ?? t.Orden ?? 0),
      });
    }
  }
  if (eventos.length) {
    // Por fecha; si empatan o faltan, gana el de mayor `orden` (etapa más avanzada).
    let mejor = eventos[0], mejorT = -Infinity;
    for (const ev of eventos) {
      const t = ev.fecha ? Date.parse(ev.fecha) : NaN;
      const val = isFinite(t) ? t : -Infinity;
      if (val > mejorT || (val === mejorT && ev.orden >= (mejor.orden || 0))) { mejorT = val; mejor = ev; }
    }
    // "Etapa — detalle": clasificarEstado matchea la etapa (En camino/Entregado/…)
    return { estado: `${mejor.estado}${mejor.descripcion ? " — " + mejor.descripcion : ""}`.trim(), eventos };
  }
  const est = d.estado || d.Estado || d.fechaEstimadaDeEntrega || null;
  return est ? { estado: String(est).replace(/<[^>]+>/g, "").trim(), eventos: [] } : null;
}
async function trackAndreaniPublico(nroRaw) {
  const nro = String(nroRaw || "").trim().replace(/\s+/g, "");
  if (!nro) return null;
  try {
    const url = `https://tracking-api.andreani.com/api/v3/Tracking?payload=${encodeURIComponent(andreaniPublicPayload(nro))}`;
    const r = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const text = await r.text();
    if (text.startsWith("<") || text.startsWith("<!")) return null;
    let d; try { d = JSON.parse(text); } catch { return null; }
    const out = parseTrackingV3(d);
    return out ? { ...out, raw: d, source: "publico_v3" } : null;
  } catch (_) { return null; }
}

async function trackAndreani(nroRaw) {
  const nro = String(nroRaw || "").trim().replace(/\s+/g, '');
  if (!nro) return null;
  // Vía nueva primero (la que usa andreani.com hoy); los endpoints viejos
  // quedan como respaldo por si Andreani revive alguno.
  const pub = await trackAndreaniPublico(nro);
  if (pub) return pub;
  const endpoints = [
    `https://tracking.andreani.com/api/v1/seguimiento?codigoAndreani=${encodeURIComponent(nro)}`,
    `https://tracking.andreani.com/api/v1/seguimiento?numero=${encodeURIComponent(nro)}`,
    `https://clientes.andreani.com/api/v2/ordenes/${encodeURIComponent(nro)}`,
    `https://api.andreani.com/v2/envios/${encodeURIComponent(nro)}/eventos`,
    `https://api.andreani.com/v2/ordenes/${encodeURIComponent(nro)}/eventos`,
  ];
  for (const url of endpoints) {
    try {
      // Timeout duro por endpoint: los servidores de Andreani a veces dejan la
      // conexión colgada y sin esto un solo tracking podía comerse el budget
      // completo de la función (FUNCTION_INVOCATION_TIMEOUT en el cron).
      const r = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(6000) });
      const text = await r.text();
      if (text.startsWith('<') || text.startsWith('<!')) continue;
      let d;
      try { d = JSON.parse(text); } catch { continue; }
      const estado = extractEstado(d);
      if (estado) return { estado, eventos: extractEventos(d), raw: d, source: url };
    } catch (_) {}
  }
  return null;
}

// Estado más reciente de las trazas OFICIALES (/v1/envios/{n}/trazas).
// La API puede devolver los eventos en cualquier orden: si traen fecha se
// elige el de fecha máxima; si no, el heurístico de siempre (extractEstado).
function fechaDeEvento(ev) {
  const f = ev?.fecha || ev?.Fecha || ev?.fechaHora || ev?.FechaHora || ev?.fechaEvento || ev?.FechaEvento || ev?.timestamp || ev?.date || null;
  // La API oficial puede mandar la fecha como objeto {dia,hora} o similar
  const fStr = (f && typeof f === 'object') ? [f.dia || f.Dia || "", f.hora || f.Hora || ""].join("T") : f;
  const t = fStr ? Date.parse(fStr) : NaN;
  return isFinite(t) ? t : null;
}

function estadoOficial(trazas) {
  if (!trazas) return null;
  const eventos = extractEventos(trazas);
  if (eventos.length) {
    // El de fecha máxima entre los que traen fecha (antes se exigía que TODOS
    // tuvieran fecha y un solo evento sin fecha anulaba la traza completa).
    let mejor = null, mejorT = -Infinity;
    for (const ev of eventos) {
      const t = fechaDeEvento(ev);
      if (t != null && t >= mejorT) { mejorT = t; mejor = ev; }
    }
    const estado = estadoDeEvento(mejor);
    if (estado) return { estado, eventos };
  }
  const estado = extractEstado(trazas);
  return estado ? { estado, eventos } : null;
}

// Clasificación heurística del estado de Andreani → categoría interna.
// (Misma lógica conceptual que mapAndreaniEstado del frontend.)
function clasificarEstado(estadoStr) {
  const s = String(estadoStr || "").toLowerCase();
  if (!s) return "desconocido";
  // Antes de "en_camino": los estados que dicen explícitamente que TODAVÍA NO
  // entró a la red ("Envío no ingresado", "Pendiente de ingreso") matchearían
  // /ingresad/ y pintarían "En camino" falso.
  if (/no ingresad|pendiente de ingreso|sin movimientos/.test(s)) return "otro";
  if (/entregad|retirad/.test(s)) return "entregado";
  // Ojo: "en camino a la sucursal X" / "procesando en la sucursal X" contienen
  // la palabra "sucursal" pero el envío TODAVÍA no llegó — solo es "en_sucursal"
  // si el propio texto dice que ya está ahí o listo para retirar.
  if (!/camino a la sucursal|procesando (tu|el) env|hacia la sucursal/.test(s) &&
      /sucursal|disponible.*retiro|retiro.*disponible|para retirar/.test(s)) return "en_sucursal";
  if (/devoluci|devuelto|regres|rehusad|rechazad/.test(s)) return "devolucion";
  if (/visita|no se pudo|ausente|no.*entrega|reprogram/.test(s)) return "visita_fallida";
  if (/camino|reparto|distribuc|transito|tránsito|viaje|planta|procesamiento|admitid|ingresad|recibimos|despachad|retirado del cliente|colecta/.test(s)) return "en_camino";
  return "otro";
}

export default async function handler(req, res) {
  { const _o=String(req.headers.origin||""); res.setHeader("Access-Control-Allow-Origin", (["https://www.growithapp.com","https://growithapp.com","https://soluna-gestion.vercel.app"].includes(_o)||_o.endsWith("-soluna1.vercel.app")||_o.startsWith("http://localhost"))?_o:"https://www.growithapp.com"); } // allowlist CORS
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── action=tracking: proxy Andreani para evitar CORS (solo lectura) ──
  // SIN auth a propósito: se llama con `fetch` plano (sin Authorization) desde
  // Reclamos y desde el poller global de Andreani. Solo reenvía a los endpoints
  // públicos de tracking de Andreani con un número que ya trae el llamador: no
  // toca Firestore ni expone datos de la cuenta. Si algún día los llamadores
  // pasan a authFetch, acá va un verifyAuth.
  if (req.query.action === 'tracking') {
    const { tracking } = req.query;
    if (!tracking) return res.status(400).json({ error: 'tracking requerido' });
    const nro = tracking.trim().replace(/\s+/g, '');
    // Modo diagnóstico: status crudo del endpoint oficial (sin datos sensibles)
    if (req.query.debug === '1') {
      return res.status(200).json(await trazasDebugAndreani(initAdmin(), nro));
    }
    // PRIMERO la API oficial autenticada (envíos de la cuenta de la plataforma:
    // datos al instante y confiables); si no lo ve (envío ajeno) → scraping.
    let out = null;
    try {
      const of = estadoOficial(await trazasOficialAndreani(initAdmin(), nro));
      if (of) out = { ...of, source: "oficial" };
    } catch (_) { /* sin creds o error: scraping */ }
    if (!out) out = await trackAndreani(nro);
    if (out) {
      console.log(`[andreani] tracking=${nro} estado="${out.estado}" via=${out.source || "scraping"}`);
      return res.status(200).json({ estado: out.estado, estadoActual: out.estado, ultimoEvento: { estado: out.estado }, eventos: out.eventos, raw: out.raw, source: out.source });
    }
    console.log(`[andreani] no se pudo obtener estado para tracking=${nro}`);
    return res.status(200).json({
      estado: null, estadoActual: null, ultimoEvento: null, eventos: [],
      error: 'No se pudo consultar el estado. Verificá el número de tracking.',
      trackingUrl: `https://www.andreani.com/#!/informacionEnvio/${nro}`,
    });
  }

  // ── action=track_all: cron de seguimiento de TODOS los envíos activos ──
  // Cada 30 min: para los usuarios con actividad reciente en Envíos, consulta
  // el estado Andreani de sus envíos no finalizados y lo persiste en
  // users/{uid}/envios/{docId}. Las vistas leen Firestore: el tracking deja
  // de depender de que alguien tenga la pestaña abierta.
  // Solo el cron: recorre cuentas ajenas, escribe en Firestore y manda emails.
  if (req.query.action === 'track_all') {
    if (!guardCron(req, res)) return;
    try {
      const db = initAdmin();
      // Deadline global: si Andreani viene lento, cortamos antes del límite de
      // la función (60s) y lo que quedó pendiente lo agarra la próxima corrida.
      const deadline = Date.now() + 45000;
      const quedaTiempo = () => Date.now() < deadline;
      // Los envíos van primero y con muchas cuentas/pedidos se comían TODO el
      // presupuesto: los canjes de esa corrida no se revisaban nunca. Los
      // envíos ahora cortan a los 30s para que los canjes tengan sus ~15s.
      const deadlineEnvios = Date.now() + 30000;
      const quedaTiempoEnvios = () => Date.now() < deadlineEnvios;
      const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
      const ahora = new Date().toISOString();
      const staleCutoff = new Date(Date.now() - 25 * 60000).toISOString();

      // ── Rotación de cuentas por antigüedad del último chequeo ───────────
      // Antes: where(enviosTrackActivo > cutoff).limit(10). Con muchas cuentas
      // ese límite devuelve SIEMPRE las mismas 10 (el orden lo fija el índice)
      // y el resto no se trackea nunca. Ahora la cola se ordena por
      // `enviosTrackAt` — cuándo se revisó esa cuenta por última vez — y las que
      // hace más tiempo no se miran van primero; al procesarlas se reescribe la
      // marca y pasan al fondo. orderBy sobre UN solo campo usa el índice de
      // campo único que Firestore crea solo: NO hace falta índice compuesto.
      const CANDIDATOS   = 60; // cuentas que se miran por corrida
      const MAX_CUENTAS  = 20; // cuántas de esas se trackean de verdad
      const [rotSnap, actSnap] = await Promise.all([
        db.collection("users").orderBy("enviosTrackAt").limit(CANDIDATOS).get(),
        // Las cuentas que todavía NO tienen la marca (recién empezaron a usar
        // Envíos) no aparecen en el orderBy — sin esta segunda query nunca
        // entrarían a la rotación. Una sola desigualdad: tampoco pide índice.
        db.collection("users").where("enviosTrackActivo", ">", cutoff).limit(CANDIDATOS).get(),
      ]);
      const candidatos = [], vistos = new Set();
      for (const d of actSnap.docs) {           // primero las nuevas
        if (d.data().enviosTrackAt) continue;
        candidatos.push(d); vistos.add(d.id);
      }
      for (const d of rotSnap.docs) {           // después, por antigüedad
        if (candidatos.length >= CANDIDATOS) break;
        if (vistos.has(d.id)) continue;
        candidatos.push(d); vistos.add(d.id);
      }
      // Solo se trackean las cuentas con actividad reciente en Envíos; las
      // inactivas se marcan igual para que no tapen la cabeza de la cola.
      const activos = [], marcarUsers = [];
      for (const d of candidatos) {
        const act = d.data().enviosTrackActivo || "";
        if (!(act > cutoff)) { marcarUsers.push(d.ref); continue; }
        if (activos.length >= MAX_CUENTAS) break;
        activos.push(d);
      }

      let revisados = 0, actualizados = 0;
      for (const uDoc of activos) {
        if (!quedaTiempoEnvios()) break;
        // Envíos activos con tracking, no finalizados, sin chequear hace 25+ min.
        const envSnap = await uDoc.ref.collection("envios").where("activo", "==", true).limit(60).get();
        const pendientes = envSnap.docs
          // Con tracking (scraping) o emitidos por nuestra API oficial
          // (andreani.numeroDeEnvio) — estos últimos se trackean por API.
          .filter(d => { const e = d.data(); return (e.tracking || e.andreani?.numeroDeEnvio) && (!e.lastCheck || e.lastCheck < staleCutoff); })
          // Rotación también dentro de la cuenta: primero los que hace más
          // tiempo no se miran (antes el orden lo daba Firestore y con 60
          // envíos activos los últimos no se revisaban nunca).
          .sort((a, b) => String(a.data().lastCheck || "").localeCompare(String(b.data().lastCheck || "")))
          .slice(0, 30);
        for (let i = 0; i < pendientes.length; i += 5) {
          if (!quedaTiempoEnvios()) break;
          await Promise.all(pendientes.slice(i, i + 5).map(async d => {
            const e = d.data();
            revisados++;
            // Emitidos por nuestra API: PRIMERO la API oficial de trazas
            // (garantizado visible con las credenciales de la plataforma).
            // Si devuelve null o sin trazas → fallback al scraping de siempre.
            const numOficial = e.andreani?.numeroDeEnvio || null;
            let out = null, via = "scraping";
            if (numOficial) {
              const trazas = await trazasOficialAndreani(db, numOficial);
              const of = estadoOficial(trazas);
              if (of) { out = of; via = "oficial"; }
            }
            if (!out) out = await trackAndreani(e.tracking || numOficial);
            if (!out) { await d.ref.set({ lastCheck: ahora }, { merge: true }); return; }
            const cat = clasificarEstado(out.estado);
            const upd = { lastCheck: ahora, estadoAndreani: out.estado, categoria: cat, trackVia: via };
            if (out.estado !== e.estadoAndreani) upd.estadoDesde = ahora; // cambió: resetea el reloj de "demorado"
            if (cat === "en_sucursal" && e.categoria !== "en_sucursal") upd.enSucursalDesde = ahora;
            if (cat === "entregado") { upd.activo = false; upd.entregadoAt = ahora; }
            if (cat === "devolucion") { upd.activo = false; upd.devolucionAt = ahora; }
            await d.ref.set(upd, { merge: true });
            actualizados++;
          }));
        }
        marcarUsers.push(uDoc.ref);
      }
      // Marca de rotación de las cuentas consumidas (best-effort: si falla, la
      // próxima corrida vuelve a agarrar las mismas — no se pierde nada).
      try {
        const wb = db.batch();
        for (const ref of marcarUsers.slice(0, 450)) wb.set(ref, { enviosTrackAt: ahora }, { merge: true });
        if (marcarUsers.length) await wb.commit();
      } catch (e) { console.error("[track_all] marca de rotación:", e.message); }

      // ── Canjes con tracking activo (colección top-level "canjes") ──
      // trackDone=false lo setea el frontend al cargar o cambiar un tracking.
      // Acá se persiste el estado en el doc del canje y, cuando el paquete llega
      // a sucursal / se entrega / vuelve, se deja un aviso in-app (trackingAviso)
      // y se manda email al dueño.
      let canjesRevisados = 0, canjesActualizados = 0;
      try {
        // Rotación de canjes: mismo problema que con las cuentas — un limit(60)
        // fijo sobre la colección global devuelve siempre los mismos y, con
        // muchos tenants, la mayoría no se trackea nunca. Se ordena por
        // `trackingLastCheck` ascendente dentro de los que siguen abiertos.
        // ÍNDICE COMPUESTO NECESARIO en Firestore:
        //   colección `canjes` → trackDone ASC, trackingLastCheck ASC
        const CAND_CANJES = 60;
        // La query con orderBy necesita el índice compuesto (trackDone ASC +
        // trackingLastCheck ASC). Si falta o falla, NO puede tumbar el bloque
        // entero: se sigue con la query simple y se rota ordenando en memoria.
        const [rotC, nuevosC] = await Promise.all([
          db.collection("canjes").where("trackDone", "==", false).orderBy("trackingLastCheck").limit(CAND_CANJES).get()
            .catch(e => { console.error("[track_all canjes] query orderBy falló (¿falta el índice?):", e.message); return null; }),
          // Los canjes que nunca se chequearon no tienen el campo y quedan
          // fuera del orderBy: entran por acá, y primero (son los más nuevos).
          db.collection("canjes").where("trackDone", "==", false).limit(200).get(),
        ]);
        const candC = [], vistosC = new Set();
        for (const d of nuevosC.docs) {
          if (d.data().trackingLastCheck) continue;
          if (candC.length >= CAND_CANJES) break;
          candC.push(d); vistosC.add(d.id);
        }
        const rotDocs = rotC ? rotC.docs
          // Fallback sin índice: los mismos docs de la query simple, ordenados
          // en memoria por último chequeo (los más olvidados primero).
          : nuevosC.docs.slice().sort((a, b) => String(a.data().trackingLastCheck || "").localeCompare(String(b.data().trackingLastCheck || "")));
        for (const d of rotDocs) {
          if (candC.length >= CAND_CANJES) break;
          if (vistosC.has(d.id)) continue;
          candC.push(d); vistosC.add(d.id);
        }
        const pendCanjes = candC.filter(d => {
          const c = d.data();
          // Multi-tenant: `ownerId` es la cuenta dueña del canje. El front lista
          // canjes con where("ownerId","==",uid), así que un canje sin ownerId
          // no le pertenece a nadie: no hay a quién avisarle y no debe tocarse
          // (ni aparecer) desde otra cuenta. Se saltea.
          if (!c.ownerId) return false;
          return c.tracking && String(c.tracking).trim() && (!c.trackingLastCheck || c.trackingLastCheck < staleCutoff);
        }).slice(0, 30);
        const emailCache = {};
        const NOTABLES = {
          en_sucursal:    { titulo: "Listo para retirar en sucursal", asunto: inf => `El canje de ${inf} está en sucursal para retirar` },
          entregado:      { titulo: "Paquete entregado",              asunto: inf => `El canje de ${inf} fue entregado` },
          devolucion:     { titulo: "Devolución en camino",           asunto: inf => `El envío del canje de ${inf} está volviendo` },
          visita_fallida: { titulo: "Visita fallida",                 asunto: inf => `Visita fallida en el canje de ${inf}` },
        };
        for (let i = 0; i < pendCanjes.length; i += 5) {
          if (!quedaTiempo()) break;
          await Promise.all(pendCanjes.slice(i, i + 5).map(async d => {
            const c = d.data();
            canjesRevisados++;
            // Igual que los envíos: PRIMERO la API oficial (los canjes salen de
            // la cuenta Andreani de la plataforma), fallback al scraping.
            let out = null, via = "scraping";
            const ofC = estadoOficial(await trazasOficialAndreani(db, String(c.tracking).trim()));
            if (ofC) { out = ofC; via = "oficial"; }
            if (!out) out = await trackAndreani(c.tracking);
            if (!out) { await d.ref.set({ trackingLastCheck: ahora }, { merge: true }); return; }
            const cat = clasificarEstado(out.estado);
            const upd = { trackingLastCheck: ahora, trackingEstado: out.estado, trackingCat: cat, trackVia: via };
            if (cat === "entregado") {
              upd.trackDone = true; upd.trackEntregadoAt = ahora;
              // Deja el campo en null (no ausente) para que el recordatorio de
              // contenido pueda buscarlo por índice en vez de barrer la colección.
              if (c.contentReminderAt === undefined) upd.contentReminderAt = null;
              // Auto-avance del pipeline: al confirmarse la entrega, el canje pasa
              // solo a "Contenido pendiente" y arranca el reloj del contenido.
              if (["Por enviar", "Pendiente envío", "Enviado"].includes(c.estado)) upd.estado = "Contenido pendiente";
            }
            if (cat === "devolucion") upd.trackDone = true;
            if (cat !== c.trackingCat && NOTABLES[cat]) {
              upd.trackingAviso = { cat, estado: out.estado, at: ahora, visto: false };
              try {
                const ownerId = c.ownerId;
                if (ownerId && process.env.RESEND_API_KEY) {
                  if (!(ownerId in emailCache)) {
                    const uSnap = await db.collection("users").doc(ownerId).get();
                    emailCache[ownerId] = uSnap.data()?.email || null;
                  }
                  const to = emailCache[ownerId];
                  if (to) {
                    const n = NOTABLES[cat];
                    const inf = c.influencer || "influencer";
                    const nro = String(c.tracking).trim();
                    const html = `<div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="background:linear-gradient(135deg,#6366f1,#a78bfa);padding:22px;border-radius:12px;text-align:center;margin-bottom:22px">
    <div style="font-size:18px;font-weight:700;color:#fff">${n.titulo}</div>
    <div style="font-size:13px;color:rgba(255,255,255,0.85);margin-top:4px">Canje de ${inf}</div>
  </div>
  <p style="font-size:14px;color:#374151">Andreani informa: <strong>${out.estado}</strong></p>
  <div style="margin:12px 0;padding:10px 14px;background:#f0fdf4;border-radius:8px;border-left:3px solid #22c55e;font-size:13px;color:#374151">Tracking: <strong>${nro}</strong><br/><a href="https://www.andreani.com/#!/informacionEnvio/${nro}" style="color:#6366f1;font-size:12px">Ver seguimiento →</a></div>
  ${cat === "en_sucursal" ? '<p style="font-size:13px;color:#374151">Avisale que ya puede pasar a retirarlo — los envíos a sucursal tienen unos días de plazo antes de volver.</p>' : ""}
  <p style="font-size:12px;color:#9ca3af;text-align:center">Growith — Seguimiento de canjes</p>
</div>`;
                    await fetch("https://api.resend.com/emails", {
                      method: "POST",
                      headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
                      body: JSON.stringify({ from: process.env.RESEND_FROM || "Growith <onboarding@resend.dev>", to, subject: n.asunto(inf), html }),
                      signal: AbortSignal.timeout(8000), // un Resend lento no puede comerse el presupuesto del cron
                    });
                  }
                }
              } catch (e) { console.error("[track_all canje] email:", e.message); }
            }
            // El aviso in-app puede haber quedado desactualizado (ej: una
            // clasificación vieja lo marcó "en sucursal" y el envío en
            // realidad seguía en camino) — se compara contra el cat GUARDADO
            // EN EL AVISO, no contra trackingCat, para autocorregirse incluso
            // si trackingCat ya había avanzado sin limpiar el aviso.
            if (!upd.trackingAviso && c.trackingAviso && !c.trackingAviso.visto && c.trackingAviso.cat !== cat) {
              upd.trackingAviso = null;
            }
            await d.ref.set(upd, { merge: true });
            canjesActualizados++;
          }));
        }

        // ── Recordatorio de contenido: 5 días después de la entrega, si el
        // influencer todavía no completó el contenido acordado, un email al
        // dueño para que le escriba. Se manda UNA sola vez (contentReminderAt).
        const cutoffRem = new Date(Date.now() - 5 * 86400000).toISOString();
        // Candidatos = canjes en "Contenido pendiente" a los que todavía NO se
        // les mandó el recordatorio. Antes se traían los primeros 100 de la
        // colección global: los ya recordados (contentReminderAt seteado) se
        // quedaban para siempre ocupando la cabeza y, con muchos tenants, los
        // canjes nuevos no entraban nunca.
        // ÍNDICE COMPUESTO NECESARIO en Firestore:
        //   colección `canjes` → estado ASC, contentReminderAt ASC
        const CAND_REM = 60;
        const remDocs = [];
        try {
          const rs = await db.collection("canjes")
            .where("estado", "==", "Contenido pendiente")
            .where("contentReminderAt", "==", null)
            .limit(CAND_REM).get();
          remDocs.push(...rs.docs);
        } catch (e) { console.error("[canje-reminder] query indexada:", e.message); }
        if (remDocs.length < CAND_REM) {
          // Bootstrap / canjes viejos: los que no tienen el campo no matchean el
          // "== null". Se los completa acá y se les deja el campo en null para
          // que a partir de la próxima corrida entren por el índice.
          const vistos = new Set(remDocs.map(d => d.id));
          const legacy = await db.collection("canjes").where("estado", "==", "Contenido pendiente").limit(CAND_REM).get();
          const wb = db.batch(); let nSemilla = 0;
          for (const d of legacy.docs) {
            if (vistos.has(d.id) || d.data().contentReminderAt !== undefined) continue;
            wb.set(d.ref, { contentReminderAt: null }, { merge: true });
            nSemilla++;
            if (remDocs.length < CAND_REM) remDocs.push(d);
          }
          if (nSemilla) { try { await wb.commit(); } catch (_) {} }
        }
        // A quiénes hay que avisarles de verdad.
        const aRecordar = [];
        for (const d of remDocs) {
          const c = d.data();
          // Sin ownerId el canje no pertenece a ninguna cuenta: no hay destinatario.
          if (!c.ownerId) continue;
          if (!c.trackEntregadoAt || c.trackEntregadoAt > cutoffRem || c.contentReminderAt) continue;
          const cont = c.contenido || [];
          const acordados = cont.reduce((s, x) => s + (x.acordados || 0), 0);
          const entregados = cont.reduce((s, x) => s + (x.entregados || 0), 0);
          if (acordados > 0 && entregados >= acordados) continue;
          aRecordar.push({ d, c, acordados, entregados });
        }
        // Envío en lotes concurrentes de 5 (no uno por uno): con muchas cuentas
        // un `for` secuencial se comía el presupuesto de la función, y disparar
        // todos de golpe rompe el rate limit de Resend. allSettled = un email
        // fallado no tumba el resto.
        for (let i = 0; i < aRecordar.length; i += 5) {
          if (!quedaTiempo()) break;
          await Promise.allSettled(aRecordar.slice(i, i + 5).map(async ({ d, c, acordados, entregados }) => {
            await d.ref.set({ contentReminderAt: ahora }, { merge: true });
            if (!c.ownerId || !process.env.RESEND_API_KEY) return;
            if (!(c.ownerId in emailCache)) {
              const uSnap = await db.collection("users").doc(c.ownerId).get();
              emailCache[c.ownerId] = uSnap.data()?.email || null;
            }
            const to = emailCache[c.ownerId];
            if (!to) return;
            const inf = c.influencer || "influencer";
            const dias = Math.round((Date.now() - new Date(c.trackEntregadoAt).getTime()) / 86400000);
            const html = `<div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="background:linear-gradient(135deg,#f59e0b,#f97316);padding:22px;border-radius:12px;text-align:center;margin-bottom:22px">
    <div style="font-size:18px;font-weight:700;color:#fff">Contenido pendiente</div>
    <div style="font-size:13px;color:rgba(255,255,255,0.85);margin-top:4px">Canje de ${inf}</div>
  </div>
  <p style="font-size:14px;color:#374151">El paquete de <strong>${inf}</strong> se entregó hace <strong>${dias} días</strong> y todavía ${acordados > 0 ? `va ${entregados} de ${acordados} contenidos acordados` : "no marcaste contenido entregado"}.</p>
  <p style="font-size:13px;color:#374151">Buen momento para escribirle y preguntarle cómo viene.</p>
  <p style="font-size:12px;color:#9ca3af;text-align:center">Growith — Seguimiento de canjes</p>
</div>`;
            await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({ from: process.env.RESEND_FROM || "Growith <onboarding@resend.dev>", to, subject: `${inf} debe contenido — entregado hace ${dias} días`, html }),
              signal: AbortSignal.timeout(8000),
            });
          })).then(rs => rs.forEach(r => { if (r.status === "rejected") console.error("[canje-reminder]:", r.reason?.message || r.reason); }));
        }
      } catch (e) { console.error("[track_all canjes]:", e.message); }
      return res.json({ ok: true, usuarios: activos.length, revisados, actualizados, canjesRevisados, canjesActualizados });
    } catch (e) {
      console.error("track_all error:", e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Todo lo que sigue opera sobre los datos de UNA cuenta (historial de
  // envíos en Firestore, credenciales de Tienda Nube, fulfillment de pedidos):
  // exige token válido Y atado al uid pedido. Antes alcanzaba con estar
  // logueado con cualquier cuenta y mandar el uid ajeno por query.
  const { uid, orderId, tracking } = req.query;
  if (!uid) return res.status(401).json({ error: "uid requerido" });
  if (!(await guardUid(req, res, uid))) return;

  // ── Historial de envíos en Firestore (vía Admin SDK — no depende de las
  // reglas de seguridad del cliente, que no cubren subcolecciones nuevas) ──
  if (req.query.action === 'envios_list') {
    try {
      const db = initAdmin();
      // Marca de actividad para el cron de tracking
      await db.collection("users").doc(uid).set({ enviosTrackActivo: new Date().toISOString() }, { merge: true });
      const cutoff = new Date(Date.now() - 60 * 86400000).toISOString();
      const snap = await db.collection("users").doc(uid).collection("envios").where("creado", ">", cutoff).get();
      const envios = {};
      snap.forEach(d => { envios[d.id] = d.data(); });
      return res.json({ envios });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  if (req.query.action === 'envios_registrar' && req.method === 'POST') {
    try {
      const body = await new Promise(resolve => { let d = ""; req.on("data", c => d += c); req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch (_) { resolve({}); } }); });
      const items = Array.isArray(body.envios) ? body.envios.slice(0, 400) : [];
      const db = initAdmin();
      const ahora = new Date().toISOString();
      for (let i = 0; i < items.length; i += 20) {
        await Promise.all(items.slice(i, i + 20).map(e => {
          const numero = String(e.numero || "").trim();
          if (!numero) return null;
          const docData = {};
          for (const k of ["tnId","cliente","esSucursal","provincia","localidad","total","skus","estado","activo","tracking","fulfillOk","verificado"]) {
            if (e[k] !== undefined) docData[k] = e[k];
          }
          docData.numero = numero;
          if (e.estado === "despachado") docData.despachadoAt = ahora;
          if (e.verificado) docData.verificadoAt = ahora;
          return db.collection("users").doc(uid).collection("envios").doc(numero)
            .set({ creado: ahora, ...docData }, { merge: true })
            .then(async () => {
              // no pisar "creado" si ya existía: merge lo sobreescribió — restaurar
              // sería otra lectura por doc; aceptamos que "creado" refleje la
              // última actividad (ventana de 60 días del historial).
            });
        }));
      }
      return res.json({ ok: true, guardados: items.length });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── action=canjes_refresh: refresco EN VIVO del tracking de canjes al abrir
  // la sección — misma vía que el cron (API oficial → scraping) sin esperar
  // los 30 min. El onSnapshot del front pinta el cambio al instante.
  if (req.query.action === 'canjes_refresh' && req.method === 'POST') {
    try {
      const body = await new Promise(resolve => { let d = ""; req.on("data", c => d += c); req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch (_) { resolve({}); } }); });
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 15).map(String) : [];
      if (!ids.length) return res.json({ ok: true, actualizados: 0 });
      const db = initAdmin();
      const ahora = new Date().toISOString();
      let actualizados = 0;
      for (let i = 0; i < ids.length; i += 3) {
        await Promise.all(ids.slice(i, i + 3).map(async id => {
          try {
            const ref = db.collection("canjes").doc(id);
            const snap = await ref.get();
            if (!snap.exists) return;
            const c = snap.data();
            if (c.ownerId !== uid) return;
            // trackDone===true = ya finalizado; undefined (canje viejo sin
            // backfill) SÍ se trackea, era el caso que quedaba afuera.
            if (!c.tracking || !String(c.tracking).trim() || c.trackDone === true) return;
            let est = null, via = "scraping";
            const of = estadoOficial(await trazasOficialAndreani(db, String(c.tracking).trim()));
            if (of) { est = of; via = "oficial"; }
            if (!est) est = await trackAndreani(String(c.tracking).trim());
            if (!est) { await ref.set({ trackingLastCheck: ahora }, { merge: true }); return; }
            const cat = clasificarEstado(est.estado);
            const upd = { trackingLastCheck: ahora, trackingEstado: est.estado, trackingCat: cat, trackVia: via };
            if (cat === "entregado") {
              upd.trackDone = true; upd.trackEntregadoAt = ahora;
              if (c.contentReminderAt === undefined) upd.contentReminderAt = null;
              if (["Por enviar", "Pendiente envío", "Enviado"].includes(c.estado)) upd.estado = "Contenido pendiente";
            }
            if (cat === "devolucion") upd.trackDone = true;
            // Aviso in-app (el mail queda a cargo del cron; acá la dueña está EN la app viéndolo)
            if (cat !== c.trackingCat && ["en_sucursal", "entregado", "devolucion", "visita_fallida"].includes(cat)) {
              upd.trackingAviso = { cat, estado: est.estado, at: ahora, visto: false };
            }
            // Autocorrección: compara contra el cat guardado EN EL AVISO (no
            // trackingCat) para limpiar avisos ya obsoletos por una clasificación
            // vieja, incluso si trackingCat ya había avanzado sin limpiarlos.
            if (!upd.trackingAviso && c.trackingAviso && !c.trackingAviso.visto && c.trackingAviso.cat !== cat) {
              upd.trackingAviso = null;
            }
            await ref.set(upd, { merge: true });
            actualizados++;
          } catch (_) { /* un canje con error no frena el resto */ }
        }));
      }
      return res.json({ ok: true, actualizados });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  let storeId, accessToken, shStore = null;
  try {
    const db = initAdmin();
    const userSnap = await db.collection("users").doc(uid).get();
    if (userSnap.exists) {
      const stores = userSnap.data().stores || [];
      const tnStore = stores.find(s => s.type === "tiendanube");
      shStore = stores.find(s => s.type === "shopify" && s.accessToken && s.shop) || null;
      if (tnStore?.accessToken && tnStore?.storeId) {
        storeId = tnStore.storeId;
        accessToken = tnStore.accessToken;
      }
    }
  } catch(e) {
    console.error("Firebase error:", e.message);
    return res.status(500).json({ error: "Error al obtener credenciales" });
  }

  // ── Rama Shopify: misma prioridad que orders.js (Shopify manda si está
  // conectado). Sube el tracking creando un fulfillment con la API de
  // FulfillmentOrders — equivalente al PUT+fulfill de TN.
  if (shStore) {
    if (req.query.action === 'pack') {
      return res.status(400).json({ error: "Marcar empaquetado no aplica a Shopify (se hace desde el fulfillment)." });
    }
    if (!orderId || !tracking) return res.status(400).json({ error: "Faltan orderId o tracking" });
    const shHeaders = { 'X-Shopify-Access-Token': shStore.accessToken, 'Content-Type': 'application/json' };
    const shBase = `https://${shStore.shop}/admin/api/2024-10`;
    try {
      // 1. Buscar la orden por número visible (name = "#1001")
      const sr = await fetch(`${shBase}/orders.json?name=${encodeURIComponent('#' + orderId)}&status=any&fields=id,order_number,name,fulfillment_status`, { headers: shHeaders });
      if (!sr.ok) throw new Error(`Shopify search error ${sr.status}`);
      const sd = await sr.json();
      const order = (sd.orders || []).find(o => String(o.order_number) === String(orderId) || String(o.name || "").replace("#", "") === String(orderId));
      if (!order) return res.status(404).json({ error: `Pedido #${orderId} no encontrado en Shopify` });
      if ((order.fulfillment_status || "").toLowerCase() === 'fulfilled') {
        return res.status(400).json({ error: `El pedido #${orderId} ya fue enviado.` });
      }
      // 2. Fulfillment orders abiertos de la orden
      const fr = await fetch(`${shBase}/orders/${order.id}/fulfillment_orders.json`, { headers: shHeaders });
      if (!fr.ok) throw new Error(`Shopify fulfillment_orders error ${fr.status}`);
      const fd = await fr.json();
      const abiertos = (fd.fulfillment_orders || []).filter(fo => ["open", "in_progress", "scheduled"].includes((fo.status || "").toLowerCase()));
      if (!abiertos.length) return res.status(400).json({ error: `El pedido #${orderId} no tiene items pendientes de despacho en Shopify.` });
      // 3. Crear el fulfillment con tracking + aviso al cliente
      let fulfilled = false, fulfillError = null;
      const pr = await fetch(`${shBase}/fulfillments.json`, {
        method: 'POST', headers: shHeaders,
        body: JSON.stringify({ fulfillment: {
          line_items_by_fulfillment_order: abiertos.map(fo => ({ fulfillment_order_id: fo.id })),
          tracking_info: { number: tracking, url: `https://www.andreani.com/#!/informacionEnvio/${tracking}`, company: "Andreani" },
          notify_customer: true,
        } }),
      });
      if (pr.ok) fulfilled = true;
      else { const pd = await pr.json().catch(() => ({})); fulfillError = pd.errors ? JSON.stringify(pd.errors).slice(0, 200) : `Shopify ${pr.status}`; }
      if (!fulfilled) return res.status(502).json({ error: `No se pudo crear el fulfillment: ${fulfillError}` });
      return res.status(200).json({ ok: true, order: orderId, tracking, tnOrderId: String(order.id), fulfilled: true, fulfillError: null });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (!storeId || !accessToken) return res.status(403).json({ error: "Tienda no conectada" });

  const headers = {
    'Authentication': `bearer ${accessToken}`,
    'User-Agent': 'GrowithApp (contacto.growith@gmail.com)',
    'Content-Type': 'application/json',
  };

  // ── action=pack: marcar pedido como empaquetado en TN (sin salir de Growith) ──
  // Recibe el ID REAL de la orden de TN (no el número visible).
  if (req.query.action === 'pack') {
    if (!orderId) return res.status(400).json({ error: "Falta orderId" });
    try {
      const r = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders/${orderId}/pack`, { method: 'POST', headers });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        return res.status(r.status).json({ error: d.message || d.description || `Error TN ${r.status}` });
      }
      return res.status(200).json({ ok: true, order: orderId });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (!orderId || !tracking) return res.status(400).json({ error: "Faltan orderId o tracking" });

  try {
    // 1. Buscar el pedido por número. per_page=30 (antes 5): el q= de TN matchea
    // por substring y con 5 resultados la orden exacta podía quedar afuera
    // (ej: "123" matchea #1123, #1234...) → 404 falso en plena tanda.
    const searchRes = await fetch(
      `https://api.tiendanube.com/v1/${storeId}/orders?q=${orderId}&per_page=30`,
      { headers }
    );
    if (!searchRes.ok) throw new Error(`TN search error ${searchRes.status}`);
    const orders = await searchRes.json();
    if (!Array.isArray(orders) || orders.length === 0)
      return res.status(404).json({ error: `Pedido #${orderId} no encontrado` });

    const order = orders.find(o => String(o.number) === String(orderId));
    if (!order) return res.status(404).json({ error: `Pedido #${orderId} no encontrado` });

    const tnOrderId = order.id;
    const shippingStatus = order.shipping_status;

    // Solo bloquear si ya está enviado
    if (shippingStatus === 'fulfilled' || shippingStatus === 'shipped') {
      return res.status(400).json({ error: `El pedido #${orderId} ya fue enviado.` });
    }

    // 2. PUT para guardar el tracking (siempre funciona con write_orders)
    const putRes = await fetch(
      `https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          shipping_tracking_number: tracking,
          shipping_tracking_url: `https://www.andreani.com/#!/informacionEnvio/${tracking}`,
        })
      }
    );
    const putData = await putRes.json();

    if (!putRes.ok) {
      return res.status(putRes.status).json({
        error: putData.message || putData.description || `Error TN ${putRes.status}`,
      });
    }

    // 3. POST /fulfill para marcar como enviado y notificar al cliente.
    // Antes esto era un catch vacío: si TN lo rechazaba, la UI decía "✓ Ok"
    // pero el cliente NO recibía el mail y la orden no quedaba enviada.
    // Ahora el resultado se informa de verdad (fulfilled: true/false).
    let fulfilled = false, fulfillError = null;
    try {
      const fr = await fetch(
        `https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}/fulfill`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ shipping_tracking_number: tracking, notify_customer: true })
        }
      );
      fulfilled = fr.ok;
      if (!fr.ok) { const fd = await fr.json().catch(() => ({})); fulfillError = fd.message || fd.description || `TN ${fr.status}`; }
    } catch(e) { fulfillError = e.message; }

    res.status(200).json({ ok: true, order: orderId, tracking, tnOrderId: String(tnOrderId), fulfilled, fulfillError });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
