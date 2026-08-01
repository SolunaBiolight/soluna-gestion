import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { guardUid, guardCron } from "./_auth.js";

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

function extractEstado(d) {
  if (!d || typeof d !== 'object') return null;
  if (Array.isArray(d.eventos) && d.eventos.length > 0) {
    const ev = d.eventos[d.eventos.length - 1];
    return ev.estado || ev.descripcion || ev.accion || null;
  }
  if (Array.isArray(d) && d.length > 0) {
    const ev = d[d.length - 1];
    return ev.estado || ev.descripcion || ev.accion || null;
  }
  return d.estado || d.estadoActual || d.estadoEnvio ||
         d.ultimoEvento?.estado || d.ultimoEvento?.descripcion ||
         d.evento || d.descripcion || null;
}

function extractEventos(d) {
  if (Array.isArray(d.eventos)) return d.eventos;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d.historial)) return d.historial;
  if (Array.isArray(d.events)) return d.events;
  return [];
}

async function trackAndreani(nroRaw) {
  const nro = String(nroRaw || "").trim().replace(/\s+/g, '');
  if (!nro) return null;
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

// Clasificación heurística del estado de Andreani → categoría interna.
// (Misma lógica conceptual que mapAndreaniEstado del frontend.)
function clasificarEstado(estadoStr) {
  const s = String(estadoStr || "").toLowerCase();
  if (!s) return "desconocido";
  if (/entregad|retirad/.test(s)) return "entregado";
  if (/sucursal|disponible.*retiro|retiro.*disponible|para retirar/.test(s)) return "en_sucursal";
  if (/devoluci|devuelto|regres|rehusad|rechazad/.test(s)) return "devolucion";
  if (/visita|no se pudo|ausente|no.*entrega|reprogram/.test(s)) return "visita_fallida";
  if (/camino|reparto|distribuc|transito|tránsito|viaje|planta|procesamiento|admitid|retirado del cliente|colecta/.test(s)) return "en_camino";
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
    const out = await trackAndreani(nro);
    if (out) {
      console.log(`[andreani] tracking=${nro} estado="${out.estado}"`);
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
        if (!quedaTiempo()) break;
        // Envíos activos con tracking, no finalizados, sin chequear hace 25+ min.
        const envSnap = await uDoc.ref.collection("envios").where("activo", "==", true).limit(60).get();
        const pendientes = envSnap.docs
          .filter(d => { const e = d.data(); return e.tracking && (!e.lastCheck || e.lastCheck < staleCutoff); })
          // Rotación también dentro de la cuenta: primero los que hace más
          // tiempo no se miran (antes el orden lo daba Firestore y con 60
          // envíos activos los últimos no se revisaban nunca).
          .sort((a, b) => String(a.data().lastCheck || "").localeCompare(String(b.data().lastCheck || "")))
          .slice(0, 30);
        for (let i = 0; i < pendientes.length; i += 5) {
          if (!quedaTiempo()) break;
          await Promise.all(pendientes.slice(i, i + 5).map(async d => {
            const e = d.data();
            revisados++;
            const out = await trackAndreani(e.tracking);
            if (!out) { await d.ref.set({ lastCheck: ahora }, { merge: true }); return; }
            const cat = clasificarEstado(out.estado);
            const upd = { lastCheck: ahora, estadoAndreani: out.estado, categoria: cat };
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
        const [rotC, nuevosC] = await Promise.all([
          db.collection("canjes").where("trackDone", "==", false).orderBy("trackingLastCheck").limit(CAND_CANJES).get(),
          // Los canjes que nunca se chequearon no tienen el campo y quedan
          // fuera del orderBy: entran por acá, y primero (son los más nuevos).
          db.collection("canjes").where("trackDone", "==", false).limit(CAND_CANJES).get(),
        ]);
        const candC = [], vistosC = new Set();
        for (const d of nuevosC.docs) {
          if (d.data().trackingLastCheck) continue;
          candC.push(d); vistosC.add(d.id);
        }
        for (const d of rotC.docs) {
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
            const out = await trackAndreani(c.tracking);
            if (!out) { await d.ref.set({ trackingLastCheck: ahora }, { merge: true }); return; }
            const cat = clasificarEstado(out.estado);
            const upd = { trackingLastCheck: ahora, trackingEstado: out.estado, trackingCat: cat };
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

  let storeId, accessToken;
  try {
    const db = initAdmin();
    const userSnap = await db.collection("users").doc(uid).get();
    if (userSnap.exists) {
      const tnStore = (userSnap.data().stores || []).find(s => s.type === "tiendanube");
      if (tnStore?.accessToken && tnStore?.storeId) {
        storeId = tnStore.storeId;
        accessToken = tnStore.accessToken;
      }
    }
  } catch(e) {
    console.error("Firebase error:", e.message);
    return res.status(500).json({ error: "Error al obtener credenciales" });
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
