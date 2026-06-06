// api/tareas.js — Gestión de tareas y colaboradores externos
// Autenticación dual: uid (manager) o token (colaborador público)

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
  })});
  return getFirestore();
}

// ─── Admin constants (antiguo admin.js) ──────────────────────────────────
const ADMIN_UIDS = ["WJH3ArqDPQcNLha9lOinvkVi9uJ2"];
const PLAN_PRICE_USDT = { plus: 29, full: 79 };
const PLAN_PRICE_ARS  = { plus: 35000, full: 95000 };
const CONFIG_DOC = "growith_app_config";
function addMonths(date, n) { const d = new Date(date); d.setMonth(d.getMonth() + Number(n)); return d; }
// ─── fin Admin constants ──────────────────────────────────────────────────

function randomToken(len = 24) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let t = "";
  for (let i = 0; i < len; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}

function colabPortalLink(origin, token) {
  const base = (origin || "https://growithapp.com").replace(/\/$/, "");
  return `${base}/#/colaborador/${token}`;
}

async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.error("[email] RESEND_API_KEY no configurada"); return { error: "RESEND_API_KEY_FALTANTE" }; }
  if (!to)  { console.error("[email] destinatario vacío"); return { error: "Sin destinatario" }; }
  const from = process.env.RESEND_FROM || "Growith <onboarding@resend.dev>";
  const usingSandbox = from.includes("onboarding@resend.dev");
  if (usingSandbox) {
    console.warn(`[email] SANDBOX: onboarding@resend.dev — solo entrega al dueño de la cuenta. Intentando enviar a ${to} de todas formas...`);
  }
  try {
    console.log(`[email] enviando desde "${from}" a "${to}" subject="${subject}"`);
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    const data = await r.json();
    if (!r.ok) { console.error("[email] Resend error:", JSON.stringify(data)); return { error: data?.message || "Error Resend", detail: data }; }
    console.log(`[email] OK id=${data.id}`);
    return { ok: true, id: data.id };
  } catch(e) {
    console.error("[email] fetch error:", e.message);
    return { error: e.message };
  }
}

function emailTareaAsignada({ colab, tarea, link }) {
  const deadlineStr = tarea.deadline ? new Date(tarea.deadline).toLocaleDateString("es-AR") : null;
  return `<div style="font-family:Inter,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="background:linear-gradient(135deg,#6366f1,#a78bfa);padding:24px;border-radius:12px;text-align:center;margin-bottom:24px">
    <div style="font-size:28px;margin-bottom:8px">📋</div>
    <div style="font-size:20px;font-weight:700;color:#fff">Nueva tarea asignada</div>
  </div>
  <p style="font-size:15px;color:#374151">Hola <strong>${colab.nombre.split(" ")[0]}</strong>,</p>
  <p style="font-size:14px;color:#6b7280">Te asignaron una nueva tarea:</p>
  <div style="background:#f9fafb;border-radius:10px;padding:16px 20px;margin:16px 0;border-left:4px solid #6366f1">
    <div style="font-size:16px;font-weight:700;color:#111827;margin-bottom:6px">${tarea.titulo}</div>
    ${tarea.descripcion ? `<div style="font-size:13px;color:#6b7280">${tarea.descripcion}</div>` : ""}
    ${deadlineStr ? `<div style="font-size:12px;color:#6b7280;margin-top:6px">📅 Fecha límite: ${deadlineStr}</div>` : ""}
    ${tarea.prioridad === "urgente" ? `<div style="font-size:12px;color:#ef4444;font-weight:700;margin-top:4px">🔴 URGENTE</div>` : ""}
  </div>
  <a href="${link}" style="display:block;text-align:center;background:#6366f1;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;margin:20px 0">Ver mi tarea →</a>
  <p style="font-size:12px;color:#9ca3af;text-align:center">Growith — Sistema de gestión</p>
</div>`;
}

function emailEntregaRecibida({ colab, tarea, entrega, link }) {
  return `<div style="font-family:Inter,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="background:linear-gradient(135deg,#f97316,#fb923c);padding:24px;border-radius:12px;text-align:center;margin-bottom:24px">
    <div style="font-size:28px;margin-bottom:8px">📦</div>
    <div style="font-size:20px;font-weight:700;color:#fff">Nueva entrega recibida</div>
  </div>
  <p style="font-size:15px;color:#374151"><strong>${colab.nombre}</strong> entregó trabajo para revisar:</p>
  <div style="background:#f9fafb;border-radius:10px;padding:16px 20px;margin:16px 0;border-left:4px solid #f97316">
    <div style="font-size:15px;font-weight:700;color:#111827;margin-bottom:6px">${tarea.titulo}</div>
    ${entrega.label ? `<div style="font-size:12px;color:#6b7280">Versión: ${entrega.label}</div>` : ""}
    ${entrega.nota ? `<div style="font-size:13px;color:#374151;margin-top:6px">${entrega.nota}</div>` : ""}
    <a href="${entrega.link}" style="display:inline-block;margin-top:10px;font-size:13px;color:#6366f1;font-weight:600">Ver entrega →</a>
  </div>
  <a href="${link}" style="display:block;text-align:center;background:#f97316;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;margin:20px 0">Revisar ahora →</a>
  <p style="font-size:12px;color:#9ca3af;text-align:center">Growith — Sistema de gestión</p>
</div>`;
}

function emailTareaAprobada({ colab, tarea, link }) {
  return `<div style="font-family:Inter,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="background:linear-gradient(135deg,#22c55e,#4ade80);padding:24px;border-radius:12px;text-align:center;margin-bottom:24px">
    <div style="font-size:28px;margin-bottom:8px">🎉</div>
    <div style="font-size:20px;font-weight:700;color:#fff">¡Tu entrega fue aprobada!</div>
  </div>
  <p style="font-size:15px;color:#374151">Hola <strong>${colab.nombre.split(" ")[0]}</strong>,</p>
  <p style="font-size:14px;color:#6b7280">El equipo revisó y aprobó tu trabajo. ¡Excelente labor!</p>
  <div style="background:#f0fdf4;border-radius:10px;padding:16px 20px;margin:16px 0;border-left:4px solid #22c55e">
    <div style="font-size:16px;font-weight:700;color:#111827">✅ ${tarea.titulo}</div>
  </div>
  <a href="${link}" style="display:block;text-align:center;background:#22c55e;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;margin:20px 0">Ver tarea →</a>
  <p style="font-size:12px;color:#9ca3af;text-align:center">Growith — Sistema de gestión</p>
</div>`;
}

function emailNuevoComentario({ colab, tarea, comentario, link }) {
  return `<div style="font-family:Inter,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="background:linear-gradient(135deg,#6366f1,#818cf8);padding:24px;border-radius:12px;text-align:center;margin-bottom:24px">
    <div style="font-size:28px;margin-bottom:8px">💬</div>
    <div style="font-size:20px;font-weight:700;color:#fff">Nuevo comentario en tu tarea</div>
  </div>
  <p style="font-size:15px;color:#374151">Hola <strong>${colab.nombre.split(" ")[0]}</strong>,</p>
  <p style="font-size:14px;color:#6b7280">El equipo dejó un comentario en <strong>${tarea.titulo}</strong>:</p>
  <div style="background:#f8fafc;border-radius:10px;padding:16px 20px;margin:16px 0;border-left:4px solid #6366f1;font-size:14px;color:#374151;line-height:1.6;font-style:italic">"${comentario}"</div>
  <a href="${link}" style="display:block;text-align:center;background:#6366f1;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;margin:20px 0">Ver tarea y responder →</a>
  <p style="font-size:12px;color:#9ca3af;text-align:center">Growith — Sistema de gestión</p>
</div>`;
}

function emailCambiosSolicitados({ colab, tarea, feedback, link }) {
  return `<div style="font-family:Inter,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="background:#ef4444;padding:24px;border-radius:12px;text-align:center;margin-bottom:24px">
    <div style="font-size:28px;margin-bottom:8px">🔁</div>
    <div style="font-size:20px;font-weight:700;color:#fff">Se solicitaron cambios</div>
  </div>
  <p style="font-size:15px;color:#374151">Hola <strong>${colab.nombre.split(" ")[0]}</strong>,</p>
  <p style="font-size:14px;color:#6b7280">El equipo revisó tu entrega para <strong>${tarea.titulo}</strong> y solicitó cambios:</p>
  ${feedback ? `<div style="background:#fef2f2;border-radius:10px;padding:16px 20px;margin:16px 0;border-left:4px solid #ef4444;font-size:14px;color:#374151;line-height:1.6">${feedback}</div>` : "<p style='color:#6b7280;font-size:13px'>Revisá los detalles en tu portal de tareas.</p>"}
  <a href="${link}" style="display:block;text-align:center;background:#ef4444;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;margin:20px 0">Ver tarea y enviar nueva versión →</a>
  <p style="font-size:12px;color:#9ca3af;text-align:center">Growith — Sistema de gestión</p>
</div>`;
}

function emailConsultaRecibida({ colab, tarea, texto, link }) {
  return `<div style="font-family:Inter,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="background:linear-gradient(135deg,#3b82f6,#60a5fa);padding:24px;border-radius:12px;text-align:center;margin-bottom:24px">
    <div style="font-size:28px;margin-bottom:8px">❓</div>
    <div style="font-size:20px;font-weight:700;color:#fff">Nueva consulta de colaborador</div>
  </div>
  <p style="font-size:15px;color:#374151"><strong>${colab.nombre}</strong> tiene una consulta sobre <strong>${tarea.titulo}</strong>:</p>
  <div style="background:#eff6ff;border-radius:10px;padding:16px 20px;margin:16px 0;border-left:4px solid #3b82f6;font-size:14px;color:#374151;line-height:1.6">${texto}</div>
  <a href="${link}" style="display:block;text-align:center;background:#3b82f6;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;margin:20px 0">Responder en Growith →</a>
  <p style="font-size:12px;color:#9ca3af;text-align:center">Growith — Sistema de gestión</p>
</div>`;
}

function emailRecordatorio({ colab, titulo, codigo, estado, deadline, link, nota }) {
  const deadlineStr = deadline ? new Date(deadline).toLocaleDateString("es-AR",{weekday:"long",day:"numeric",month:"long"}) : null;
  const estadoLabel = {idea:"Idea",  "brief-enviado":"Brief enviado", "en-produccion":"En producción", entregado:"Entregado", publicado:"Publicado", pendiente:"Pendiente", en_proceso:"En proceso"}[estado] || estado;
  return `<div style="font-family:Inter,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="background:linear-gradient(135deg,#f59e0b,#fbbf24);padding:24px;border-radius:12px;text-align:center;margin-bottom:24px">
    <div style="font-size:28px;margin-bottom:8px">⏰</div>
    <div style="font-size:20px;font-weight:700;color:#fff">Recordatorio de tarea</div>
    <div style="font-size:13px;color:rgba(255,255,255,0.85);margin-top:6px">Growith</div>
  </div>
  <p style="font-size:15px;color:#374151">Hola <strong>${colab.nombre.split(" ")[0]}</strong>,</p>
  <p style="font-size:14px;color:#6b7280">Te mandamos un recordatorio sobre esta tarea:</p>
  <div style="background:#fffbeb;border-radius:10px;padding:16px 20px;margin:16px 0;border-left:4px solid #f59e0b">
    ${codigo ? `<div style="font-size:10px;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px">${codigo}</div>` : ""}
    <div style="font-size:16px;font-weight:700;color:#111827;margin-bottom:6px">${titulo}</div>
    <div style="font-size:12px;color:#92400e;font-weight:600">Estado: ${estadoLabel}</div>
    ${deadlineStr ? `<div style="font-size:12px;color:#dc2626;font-weight:700;margin-top:4px">📅 Vence: ${deadlineStr}</div>` : ""}
    ${nota ? `<div style="font-size:13px;color:#374151;margin-top:8px;padding-top:8px;border-top:1px solid #fde68a">${nota}</div>` : ""}
  </div>
  <a href="${link}" style="display:block;text-align:center;background:#f59e0b;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;margin:20px 0">Ver mi tarea →</a>
  <p style="font-size:12px;color:#9ca3af;text-align:center">Growith — Sistema de gestión</p>
</div>`;
}

// ── NUEVO: Colab listo para entregar → manager
function emailListoParaEntregar({ colab, tarea, link }) {
  return `<div style="font-family:Inter,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="background:linear-gradient(135deg,#8b5cf6,#a78bfa);padding:24px;border-radius:12px;text-align:center;margin-bottom:24px">
    <div style="font-size:28px;margin-bottom:8px">✋</div>
    <div style="font-size:20px;font-weight:700;color:#fff">Listo para entregar</div>
  </div>
  <p style="font-size:15px;color:#374151"><strong>${colab.nombre}</strong> dice que terminó y está listo para entregar:</p>
  <div style="background:#f5f3ff;border-radius:10px;padding:16px 20px;margin:16px 0;border-left:4px solid #8b5cf6">
    <div style="font-size:15px;font-weight:700;color:#111827">${tarea.titulo}</div>
    <div style="font-size:12px;color:#7c3aed;margin-top:4px">Esperando tu revisión</div>
  </div>
  <a href="${link}" style="display:block;text-align:center;background:#8b5cf6;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;margin:20px 0">Ver en Growith →</a>
  <p style="font-size:12px;color:#9ca3af;text-align:center">Growith — Sistema de gestión</p>
</div>`;
}

// ── NUEVO: Colab retoma trabajo tras bloqueo → manager
function emailRetomaTrabajo({ colab, tarea, link }) {
  return `<div style="font-family:Inter,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="background:linear-gradient(135deg,#22c55e,#4ade80);padding:24px;border-radius:12px;text-align:center;margin-bottom:24px">
    <div style="font-size:28px;margin-bottom:8px">🔄</div>
    <div style="font-size:20px;font-weight:700;color:#fff">Bloqueo resuelto</div>
  </div>
  <p style="font-size:15px;color:#374151"><strong>${colab.nombre}</strong> retomó el trabajo en:</p>
  <div style="background:#f0fdf4;border-radius:10px;padding:16px 20px;margin:16px 0;border-left:4px solid #22c55e">
    <div style="font-size:15px;font-weight:700;color:#111827">${tarea.titulo}</div>
    <div style="font-size:12px;color:#16a34a;margin-top:4px">Ya no está bloqueado</div>
  </div>
  <a href="${link}" style="display:block;text-align:center;background:#22c55e;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;margin:20px 0">Ver tarea →</a>
  <p style="font-size:12px;color:#9ca3af;text-align:center">Growith — Sistema de gestión</p>
</div>`;
}

// ── NUEVO: Admin editó brief o deadline → colaborador
function emailTareaActualizada({ colab, tarea, cambios, link }) {
  const cambiosHtml = cambios.map(c => `<li style="margin-bottom:4px">${c}</li>`).join("");
  return `<div style="font-family:Inter,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="background:linear-gradient(135deg,#f59e0b,#fbbf24);padding:24px;border-radius:12px;text-align:center;margin-bottom:24px">
    <div style="font-size:28px;margin-bottom:8px">✏️</div>
    <div style="font-size:20px;font-weight:700;color:#fff">Tarea actualizada</div>
  </div>
  <p style="font-size:15px;color:#374151">Hola <strong>${colab.nombre.split(" ")[0]}</strong>,</p>
  <p style="font-size:14px;color:#6b7280">Actualizaron tu tarea <strong>${tarea.titulo}</strong>:</p>
  <div style="background:#fffbeb;border-radius:10px;padding:16px 20px;margin:16px 0;border-left:4px solid #f59e0b">
    <ul style="margin:0;padding-left:18px;font-size:14px;color:#374151;line-height:1.8">${cambiosHtml}</ul>
  </div>
  <a href="${link}" style="display:block;text-align:center;background:#f59e0b;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;margin:20px 0">Ver mi tarea →</a>
  <p style="font-size:12px;color:#9ca3af;text-align:center">Growith — Sistema de gestión</p>
</div>`;
}

function normalizeLinks(links) {
  const arr = Array.isArray(links) ? links : String(links||"").split("\n").map(l=>l.trim()).filter(Boolean);
  return arr.map(l => typeof l === "string" ? { name: "", url: l } : l).filter(l=>l.url);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const db = initAdmin();

    let body;
    if (req.method === "GET") {
      body = req.query;
    } else if (req.body && typeof req.body === "object") {
      body = req.body;
    } else {
      const raw = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", c => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString()));
        req.on("error", reject);
      });
      body = raw ? JSON.parse(raw) : {};
    }

    const { action, uid, token } = body;
    const origin = req.headers.origin || req.headers.referer || "";
    const now = new Date();

    // ── ACCIONES PÚBLICAS (solo token, sin uid) ───────────────────────────────

    if (action === "getPublicData") {
      if (!token) return res.status(400).json({ error: "Token requerido" });
      const snap = await db.collection("colaboradores").where("token","==",token).limit(1).get();
      if (snap.empty) return res.status(404).json({ error: "Link inválido o expirado" });
      const colab = { _id: snap.docs[0].id, ...snap.docs[0].data() };
      const tarSnap = await db.collection("tareas")
        .where("asignadoEmail","==",colab.email)
        .where("uid","==",colab.uid).get();
      const tareas = tarSnap.docs
        .map(d=>({_id:d.id,...d.data()}))
        .sort((a,b)=>(b.createdAt?._seconds||0)-(a.createdAt?._seconds||0));
      let creativos = null, tandas = null;
      if (colab.permisos?.verCreativos) {
        try {
          const prodSnap = await db.collection("produccion").doc(colab.uid).get();
          if (prodSnap.exists) {
            const prod = prodSnap.data();
            creativos = prod.creativos || [];
            tandas = prod.tandas || [];
          }
        } catch(e) { console.error("[getPublicData creativos]", e.message); }
      }
      // Fetch admin WA phone for collab portal notifications
      let adminWaPhone = null;
      try {
        const userSnap = await db.collection("users").doc(colab.uid).get();
        if (userSnap.exists) adminWaPhone = userSnap.data()?.adminWaPhone || null;
      } catch(e) { /* non-critical */ }

      // Vista de equipo — solo si tiene permiso verEquipo
      let equipoTareas = null;
      if (colab.permisos?.verEquipo) {
        try {
          const [todasSnap, colabsSnap] = await Promise.all([
            db.collection("tareas").where("uid","==",colab.uid).get(),
            db.collection("colaboradores").where("uid","==",colab.uid).get(),
          ]);
          const colabsMap = {};
          colabsSnap.docs.forEach(d => { colabsMap[d.data().email] = d.data().nombre || d.data().email; });
          const todasTareas = todasSnap.docs.map(d=>({_id:d.id,...d.data()}));
          const byColab = {};
          todasTareas.forEach(t => {
            const email = t.asignadoEmail || "sin-asignar";
            const nombre = colabsMap[email] || t.asignadoNombre || email;
            if (!byColab[email]) byColab[email] = { nombre, email, tareas:[] };
            byColab[email].tareas.push({
              _id: t._id, titulo: t.titulo, estado: t.estado,
              prioridad: t.prioridad, deadline: t.deadline || null,
              progresoLabel: t.progresoLabel || "", correcciones: t.correcciones || 0,
            });
          });
          equipoTareas = Object.values(byColab).sort((a,b)=>a.nombre.localeCompare(b.nombre));
        } catch(e) { console.error("[getPublicData equipo]", e.message); }
      }

      // Vista trabajo completo — permiso verTareas (CM ve todo el kanban)
      let todasLasTareas = null;
      if (colab.permisos?.verTareas) {
        try {
          const snap2 = await db.collection("tareas").where("uid","==",colab.uid).get();
          todasLasTareas = snap2.docs.map(d=>({
            _id:d.id, titulo:d.data().titulo, estado:d.data().estado,
            prioridad:d.data().prioridad, deadline:d.data().deadline||null,
            asignadoNombre:d.data().asignadoNombre||"", asignadoEmail:d.data().asignadoEmail||"",
            correcciones:d.data().correcciones||0,
          })).sort((a,b)=>(b.createdAt?._seconds||0)-(a.createdAt?._seconds||0));
        } catch(e) { console.error("[getPublicData verTareas]", e.message); }
      }

      return res.json({ colab, tareas, creativos, tandas, adminWaPhone, equipoTareas, todasLasTareas });
    }

    if (action === "publicUpdateEstado") {
      const { tareaId, estado, progresoLabel="", motivo="" } = body;
      if (!token || !tareaId) return res.status(400).json({ error: "Faltan parámetros" });
      const snap = await db.collection("colaboradores").where("token","==",token).limit(1).get();
      if (snap.empty) return res.status(403).json({ error: "Token inválido" });
      const colab = snap.docs[0].data();
      const ref = db.collection("tareas").doc(tareaId);
      const t = await ref.get();
      if (!t.exists || t.data().asignadoEmail !== colab.email) return res.status(403).json({ error: "No autorizado" });
      // Only allow self-service states (not entregado/aprobado/revision - those go through proper flows)
      const allowed = ["pendiente","en_proceso","bloqueada"];
      if (!allowed.includes(estado)) return res.status(400).json({ error:"Estado no permitido" });
      const label = progresoLabel || estado;
      const detalle = estado==="bloqueada" && motivo ? `🚫 Bloqueado: ${motivo}` : `Progreso: ${label}`;
      const act = { tipo:"progreso", autor:colab.nombre, fecha:now, detalle };
      const upd = { estado, progresoLabel: progresoLabel||"", updatedAt: now, activity: [...(t.data().activity||[]), act] };
      const prevEstado = t.data().estado;
      const prevProgresoLabel = t.data().progresoLabel || "";
      const managerEmailPub = t.data().managerEmail;
      const tareaLink = `${origin||"https://soluna-gestion.vercel.app"}/#/tareas`;

      if (estado==="bloqueada" && motivo) {
        // Add motivo as a comment so admin sees it
        const comment = { texto: `🚫 Bloqueado: ${motivo}`, autor:colab.nombre, fecha:now, tipo:"bloqueo" };
        upd.comments = [...(t.data().comments||[]), comment];
        // Notify manager
        if (managerEmailPub) {
          sendEmail({
            to: managerEmailPub,
            subject: `🚫 ${colab.nombre} está bloqueado — ${t.data().titulo}`,
            html: emailConsultaRecibida({ colab, tarea:t.data(), texto:`🚫 Bloqueado: ${motivo}`, link:tareaLink }),
          });
        }
      }

      // Listo para entregar → notificar al manager
      if (estado==="en_proceso" && progresoLabel==="Listo para entregar"
          && prevProgresoLabel!=="Listo para entregar" && managerEmailPub) {
        sendEmail({
          to: managerEmailPub,
          subject: `✋ ${colab.nombre} está listo para entregar — ${t.data().titulo}`,
          html: emailListoParaEntregar({ colab, tarea:t.data(), link:tareaLink }),
        });
      }

      // Retoma el trabajo tras bloqueo → notificar al manager
      if (estado==="en_proceso" && prevEstado==="bloqueada" && managerEmailPub) {
        sendEmail({
          to: managerEmailPub,
          subject: `🔄 ${colab.nombre} retomó el trabajo — ${t.data().titulo}`,
          html: emailRetomaTrabajo({ colab, tarea:t.data(), link:tareaLink }),
        });
      }

      await ref.update(upd);
      return res.json({ ok: true });
    }

    if (action === "publicMarcarLeido") {
      const { tareaId } = body;
      if (!token || !tareaId) return res.status(400).json({ error: "Faltan parámetros" });
      const snap = await db.collection("colaboradores").where("token","==",token).limit(1).get();
      if (snap.empty) return res.status(403).json({ error: "Token inválido" });
      const colab = snap.docs[0].data();
      const ref = db.collection("tareas").doc(tareaId);
      const t = await ref.get();
      if (!t.exists || t.data().asignadoEmail !== colab.email) return res.status(403).json({ error: "No autorizado" });
      const act = { tipo:"leido", autor:colab.nombre, fecha:now, detalle:"Brief marcado como leído" };
      await ref.update({ leidoAt: now, activity: [...(t.data().activity||[]), act] });
      return res.json({ ok: true });
    }

    if (action === "publicSetEstimacion") {
      const { tareaId, estimacion } = body;
      if (!token || !tareaId || !estimacion) return res.status(400).json({ error: "Faltan parámetros" });
      const snap = await db.collection("colaboradores").where("token","==",token).limit(1).get();
      if (snap.empty) return res.status(403).json({ error: "Token inválido" });
      const colab = snap.docs[0].data();
      const ref = db.collection("tareas").doc(tareaId);
      const t = await ref.get();
      if (!t.exists || t.data().asignadoEmail !== colab.email) return res.status(403).json({ error: "No autorizado" });
      const act = { tipo:"estimacion", autor:colab.nombre, fecha:now, detalle:`Estimación: ${estimacion}` };
      await ref.update({ estimacion, activity: [...(t.data().activity||[]), act] });
      return res.json({ ok: true });
    }

    if (action === "publicToggleChecklist") {
      const { tareaId, itemId } = body;
      if (!token || !tareaId || !itemId) return res.status(400).json({ error: "Faltan parámetros" });
      const snap = await db.collection("colaboradores").where("token","==",token).limit(1).get();
      if (snap.empty) return res.status(403).json({ error: "Token inválido" });
      const colab = snap.docs[0].data();
      const ref = db.collection("tareas").doc(tareaId);
      const t = await ref.get();
      if (!t.exists || t.data().asignadoEmail !== colab.email) return res.status(403).json({ error: "No autorizado" });
      const checklist = (t.data().checklist||[]).map(item =>
        item.id === itemId ? { ...item, done: !item.done } : item
      );
      await ref.update({ checklist });
      return res.json({ ok: true, checklist });
    }

    if (action === "publicAddComment") {
      const { tareaId, texto } = body;
      if (!token || !tareaId || !texto?.trim()) return res.status(400).json({ error:"Faltan parámetros" });
      const snap = await db.collection("colaboradores").where("token","==",token).limit(1).get();
      if (snap.empty) return res.status(403).json({ error:"Token inválido" });
      const colab = snap.docs[0].data();
      const ref = db.collection("tareas").doc(tareaId);
      const t = await ref.get();
      if (!t.exists || t.data().asignadoEmail !== colab.email) return res.status(403).json({ error:"No autorizado" });
      const comment = { texto: texto.trim(), autor: colab.nombre, fecha:now, tipo:"mensaje" };
      await ref.update({ comments:[...(t.data().comments||[]), comment] });
      return res.json({ ok:true, comment });
    }

    if (action === "publicAddProgress") {
      const { tareaId, texto } = body;
      if (!token || !tareaId || !texto?.trim()) return res.status(400).json({ error:"Faltan parámetros" });
      const snap = await db.collection("colaboradores").where("token","==",token).limit(1).get();
      if (snap.empty) return res.status(403).json({ error:"Token inválido" });
      const colab = snap.docs[0].data();
      const ref = db.collection("tareas").doc(tareaId);
      const t = await ref.get();
      if (!t.exists || t.data().asignadoEmail !== colab.email) return res.status(403).json({ error:"No autorizado" });
      const comment = { texto: texto.trim(), autor: colab.nombre, fecha:now, tipo:"progreso" };
      const act = { tipo:"progreso", autor:colab.nombre, fecha:now, detalle:`Actualización: ${texto.trim().slice(0,80)}` };
      await ref.update({
        comments:[...(t.data().comments||[]), comment],
        activity:[...(t.data().activity||[]), act],
      });
      // Notificar al manager por email
      const managerEmail = t.data().managerEmail;
      if (managerEmail) {
        sendEmail({
          to: managerEmail,
          subject: `💬 Actualización de ${colab.nombre} — ${t.data().titulo}`,
          html: emailNuevoComentario({ colab, tarea:t.data(), comentario:texto.trim(), link:`${origin||"https://soluna-gestion.vercel.app"}/#/tareas` }),
        });
      }
      return res.json({ ok:true, comment });
    }

    if (action === "publicAddConsulta") {
      const { tareaId, texto } = body;
      if (!token || !tareaId || !texto?.trim()) return res.status(400).json({ error:"Faltan parámetros" });
      const snap = await db.collection("colaboradores").where("token","==",token).limit(1).get();
      if (snap.empty) return res.status(403).json({ error:"Token inválido" });
      const colab = snap.docs[0].data();
      const ref = db.collection("tareas").doc(tareaId);
      const t = await ref.get();
      if (!t.exists || t.data().asignadoEmail !== colab.email) return res.status(403).json({ error:"No autorizado" });
      const comment = { texto: texto.trim(), autor: colab.nombre, fecha:now, tipo:"consulta" };
      await ref.update({ comments:[...(t.data().comments||[]), comment] });
      // Notificar al manager por email
      const managerEmail = t.data().managerEmail;
      if (managerEmail) {
        sendEmail({
          to: managerEmail,
          subject: `❓ Consulta de ${colab.nombre} — ${t.data().titulo}`,
          html: emailConsultaRecibida({ colab, tarea:t.data(), texto:texto.trim(), link:`${origin||"https://soluna-gestion.vercel.app"}/#/tareas` }),
        });
      }
      return res.json({ ok:true, comment });
    }

    if (action === "publicAddEntrega") {
      const { tareaId, link, nota, label } = body;
      if (!token || !tareaId || !link) return res.status(400).json({ error: "Link de entrega requerido" });
      const snap = await db.collection("colaboradores").where("token","==",token).limit(1).get();
      if (snap.empty) return res.status(403).json({ error: "Token inválido" });
      const colab = snap.docs[0].data();
      const ref = db.collection("tareas").doc(tareaId);
      const t = await ref.get();
      if (!t.exists || t.data().asignadoEmail !== colab.email) return res.status(403).json({ error: "No autorizado" });
      const prevDels = t.data().deliverables || [];
      const version = prevDels.length + 1;
      const entrega = { link, nota: nota||"", label: label||`v${version}`, version, fecha: now };
      const act = { tipo:"entrega", autor:colab.nombre, fecha:now, detalle:`Entregó versión ${version}` };
      await ref.update({
        deliverables:[...prevDels, entrega],
        estado:"entregado",
        feedbackActual:null,
        updatedAt:now,
        activity:[...(t.data().activity||[]), act],
      });
      // Email al manager
      const managerEmail = t.data().managerEmail;
      if (managerEmail) {
        sendEmail({
          to: managerEmail,
          subject: `📦 Nueva entrega de ${colab.nombre} — ${t.data().titulo}`,
          html: emailEntregaRecibida({ colab, tarea:t.data(), entrega, link:`${origin||"https://soluna-gestion.vercel.app"}/#/tareas` }),
        });
      }
      return res.json({ ok: true, entrega });
    }

    // ── ACCIONES PÚBLICAS EDITOR PRODUCCIÓN ──────────────────────────────────

    if (action === "getEditorProduccion") {
      const { token: edToken } = body;
      if (!edToken) return res.status(400).json({ error:"Token requerido" });
      const tokenSnap = await db.collection("produccionTokens").doc(edToken).get();
      if (!tokenSnap.exists) return res.status(404).json({ error:"Link inválido o expirado" });
      const { uid: tUid, editorNombre } = tokenSnap.data();
      const prodSnap = await db.collection("produccion").doc(tUid).get();
      if (!prodSnap.exists) return res.json({ editorNombre, tandas:[], creativos:[] });
      const prod = prodSnap.data();
      return res.json({
        editorNombre,
        tandas: prod.tandas || [],
        creativos: (prod.creativos || []).filter(c => c.editor === editorNombre),
      });
    }

    if (action === "publicUpdateEditorCEstado") {
      const { editorToken, creativoId, estado } = body;
      if (!editorToken || !creativoId || !estado) return res.status(400).json({ error:"Faltan parámetros" });
      const tokenSnap = await db.collection("produccionTokens").doc(editorToken).get();
      if (!tokenSnap.exists) return res.status(403).json({ error:"Token inválido" });
      const { uid: tUid, editorNombre } = tokenSnap.data();
      const prodRef = db.collection("produccion").doc(tUid);
      const prodSnap = await prodRef.get();
      if (!prodSnap.exists) return res.status(404).json({ error:"Sin data" });
      const prod = prodSnap.data();
      const creativo = (prod.creativos || []).find(c => c.id === creativoId);
      if (!creativo || creativo.editor !== editorNombre) return res.status(403).json({ error:"No autorizado" });
      const newCreativos = prod.creativos.map(c => c.id === creativoId ? { ...c, estado } : c);
      await prodRef.update({ creativos: newCreativos, updatedAt: now });
      return res.json({ ok: true });
    }

    // ── ACCIONES AUTENTICADAS (uid requerido) ─────────────────────────────────

    if (!uid) return res.status(403).json({ error: "No autorizado" });

    if (action === "getData") {
      const [cs, ts] = await Promise.all([
        db.collection("colaboradores").where("uid","==",uid).get(),
        db.collection("tareas").where("uid","==",uid).get(),
      ]);
      return res.json({
        colaboradores: cs.docs.map(d=>({_id:d.id,...d.data()})).sort((a,b)=>a.nombre.localeCompare(b.nombre,"es")),
        tareas:        ts.docs.map(d=>({_id:d.id,...d.data()})).sort((a,b)=>(b.createdAt?._seconds||0)-(a.createdAt?._seconds||0)),
      });
    }

    if (action === "createColaborador") {
      const { nombre, email, rol="", telefono="" } = body;
      if (!nombre||!email) return res.status(400).json({ error:"Nombre y email requeridos" });
      const ex = await db.collection("colaboradores").where("uid","==",uid).where("email","==",email.toLowerCase()).limit(1).get();
      if (!ex.empty) {
        // Actualizar nombre/rol/tel por si el doc viejo tiene datos incompletos
        await db.collection("colaboradores").doc(ex.docs[0].id).update({ nombre, rol, telefono: telefono.trim(), updatedAt: now });
        return res.json({ _id:ex.docs[0].id, ...ex.docs[0].data(), nombre, rol, telefono: telefono.trim() });
      }
      const tok = randomToken(24);
      const data = { uid, nombre, email:email.toLowerCase(), rol, telefono:telefono.trim(), token:tok, createdAt:now };
      const ref = await db.collection("colaboradores").add(data);
      return res.json({ _id:ref.id, ...data });
    }

    if (action === "updateColaborador") {
      const { colabId, nombre, rol, telefono, email } = body;
      const upd = { updatedAt:now };
      if (nombre!==undefined) upd.nombre = nombre;
      if (rol!==undefined) upd.rol = rol;
      if (telefono!==undefined) upd.telefono = telefono;
      if (email!==undefined) upd.email = email.toLowerCase().trim();
      // Si cambia el email, reasignar todas las tareas que usaban el email viejo
      if (email!==undefined) {
        const colabDoc = await db.collection("colaboradores").doc(colabId).get();
        const oldEmail = colabDoc.data()?.email;
        const newEmail = email.toLowerCase().trim();
        if (oldEmail && oldEmail !== newEmail) {
          const tareasSnap = await db.collection("tareas").where("uid","==",uid).where("asignadoEmail","==",oldEmail).get();
          const batch = db.batch();
          tareasSnap.docs.forEach(doc => batch.update(doc.ref, { asignadoEmail: newEmail, updatedAt: now }));
          await batch.commit();
        }
      }
      await db.collection("colaboradores").doc(colabId).update(upd);
      return res.json({ ok:true });
    }

    if (action === "regenerateToken") {
      const { colabId } = body;
      const tok = randomToken(24);
      await db.collection("colaboradores").doc(colabId).update({ token:tok });
      return res.json({ ok:true, token:tok });
    }

    if (action === "deleteColaborador") {
      await db.collection("colaboradores").doc(body.colabId).delete();
      return res.json({ ok:true });
    }

    if (action === "createTarea") {
      const { titulo, descripcion="", asignadoEmail, asignadoNombre="", brief="", links=[], deadline, prioridad="normal", checklist=[], managerEmail="", asignadosEmails: asignadosEmailsRaw } = body;
      if (!titulo||!asignadoEmail) return res.status(400).json({ error:"Título y asignado requeridos" });
      // Normalizar lista de asignados: usar lo que manda el frontend, o al menos el primario
      const todosEmails = Array.isArray(asignadosEmailsRaw) && asignadosEmailsRaw.length
        ? [...new Set(asignadosEmailsRaw.map(e=>e.toLowerCase()))]
        : [asignadoEmail.toLowerCase()];
      const linksArr = normalizeLinks(links);
      const checklistArr = Array.isArray(checklist) ? checklist : [];
      // Número secuencial de tarea via transacción
      const userRef = db.collection("users").doc(uid);
      let tareaNum = 1;
      await db.runTransaction(async tx => {
        const userDoc = await tx.get(userRef);
        const prev = userDoc.data()?.tareasCount || 0;
        tareaNum = prev + 1;
        tx.set(userRef, { tareasCount: tareaNum }, { merge: true });
      });
      const tareaNumStr = String(tareaNum).padStart(3, "0");
      const activity = [{ tipo:"creado", autor:"manager", fecha:now, detalle:"Tarea creada" }];
      const data = {
        uid, titulo, descripcion, asignadoEmail, asignadoNombre,
        asignadosEmails: todosEmails,
        brief, links: linksArr, prioridad, checklist: checklistArr,
        tareaNum, tareaNumStr,
        deadline: deadline ? new Date(deadline) : null,
        estado:"pendiente", deliverables:[], correcciones:0, feedbackActual:null, comments:[],
        activity, leidoAt:null, estimacion:null, managerEmail,
        createdAt:now, updatedAt:now,
      };
      const ref = await db.collection("tareas").add(data);
      // Cargar todos los colaboradores de este uid
      const colabsSnap = await db.collection("colaboradores").where("uid","==",uid).get();
      const colabsByEmail = {};
      colabsSnap.docs.forEach(d => { const em=d.data().email; if(em) colabsByEmail[em.toLowerCase()] = d.data(); });
      const emailResults = [];
      for (const email of todosEmails) {
        let colab = colabsByEmail[email.toLowerCase()];
        if (!colab) {
          // Fallback: buscar por email sin filtro de uid (datos inconsistentes de tests anteriores)
          const byEmail = await db.collection("colaboradores").where("email","==",email.toLowerCase()).limit(1).get();
          if (!byEmail.empty) { colab = byEmail.docs[0].data(); console.log(`[email] colab found by email-only: ${email}`); }
        }
        if (!colab) { console.warn(`[email] colaborador no encontrado para: ${email}`); emailResults.push({email,ok:false,error:"colab_not_found"}); continue; }
        const result = await sendEmail({
          to: email,
          subject: `📋 Nueva tarea: ${titulo}`,
          html: emailTareaAsignada({ colab, tarea:{...data,deadline:deadline?new Date(deadline):null}, link:colabPortalLink(origin, colab.token) }),
        });
        console.log(`[email] resultado para ${email}:`, JSON.stringify(result));
        emailResults.push({email, ...result});
      }
      return res.json({ _id:ref.id, ...data, _emailResults:emailResults });
    }

    if (action === "updateTarea") {
      const { tareaId, titulo, descripcion, brief, links, deadline, estado, asignadoEmail, asignadoNombre, prioridad, checklist, asignadosEmails } = body;
      const ref = db.collection("tareas").doc(tareaId);
      const prevSnap = await ref.get();
      const prevData = prevSnap.data() || {};
      const clean = { updatedAt:now };
      if (titulo!==undefined) clean.titulo = titulo;
      if (descripcion!==undefined) clean.descripcion = descripcion;
      if (brief!==undefined) clean.brief = brief;
      if (links!==undefined) clean.links = normalizeLinks(links);
      if (deadline!==undefined) clean.deadline = deadline ? new Date(deadline) : null;
      if (estado!==undefined) clean.estado = estado;
      if (asignadoEmail!==undefined) clean.asignadoEmail = asignadoEmail;
      if (asignadoNombre!==undefined) clean.asignadoNombre = asignadoNombre;
      if (asignadosEmails!==undefined) clean.asignadosEmails = asignadosEmails;
      if (prioridad!==undefined) clean.prioridad = prioridad;
      if (checklist!==undefined) clean.checklist = checklist;
      await ref.update(clean);
      // Notificar al colab si cambió brief o deadline
      const cambios = [];
      if (brief!==undefined && brief !== prevData.brief) cambios.push("Se actualizó el brief de la tarea");
      if (deadline!==undefined) {
        const prevDL = prevData.deadline ? new Date(prevData.deadline).toLocaleDateString("es-AR") : null;
        const newDL = deadline ? new Date(deadline).toLocaleDateString("es-AR") : null;
        if (prevDL !== newDL) {
          cambios.push(newDL ? `Nueva fecha límite: <strong>${newDL}</strong>` : "Se eliminó la fecha límite");
        }
      }
      if (cambios.length > 0) {
        const recipientEmails = (clean.asignadosEmails || prevData.asignadosEmails || [clean.asignadoEmail || prevData.asignadoEmail]).filter(Boolean);
        for (const email of recipientEmails) {
          const colabSnap3 = await db.collection("colaboradores")
            .where("uid","==",uid).where("email","==",email).limit(1).get();
          if (!colabSnap3.empty) {
            const c3 = colabSnap3.docs[0].data();
            sendEmail({
              to: email,
              subject: `✏️ Actualizaron tu tarea — ${clean.titulo || prevData.titulo}`,
              html: emailTareaActualizada({ colab:c3, tarea:{...prevData,...clean}, cambios, link:colabPortalLink(origin, c3.token) }),
            });
          }
        }
      }
      return res.json({ ok:true });
    }

    if (action === "updateEstado") {
      const { tareaId, estado, feedback } = body;
      const ref = db.collection("tareas").doc(tareaId);
      const snap = await ref.get();
      const upd = { estado, updatedAt: now };
      const act = { tipo:"estado", autor:"manager", fecha:now, detalle:`Estado: ${estado}` };
      upd.activity = [...(snap.data()?.activity||[]), act];
      if (estado === "revision") {
        upd.correcciones = (snap.data()?.correcciones || 0) + 1;
        upd.feedbackActual = feedback || null;
        // Guardar feedback en la última entrega
        const prevDels = snap.data()?.deliverables || [];
        if (prevDels.length > 0) {
          const updDels = [...prevDels];
          updDels[updDels.length-1] = { ...updDels[updDels.length-1], feedbackRecibido: feedback || null };
          upd.deliverables = updDels;
        }
        // Email al colaborador
        const colabSnap = await db.collection("colaboradores")
          .where("uid","==",uid).where("email","==",snap.data().asignadoEmail).limit(1).get();
        if (!colabSnap.empty) {
          const colab = colabSnap.docs[0].data();
          sendEmail({
            to: snap.data().asignadoEmail,
            subject: `🔁 Se solicitaron cambios — ${snap.data().titulo}`,
            html: emailCambiosSolicitados({ colab, tarea:snap.data(), feedback:feedback||"", link:colabPortalLink(origin, colab.token) }),
          });
        }
      } else {
        upd.feedbackActual = null;
        // Email al colaborador cuando se aprueba
        if (estado === "aprobado") {
          const colabSnapAp = await db.collection("colaboradores")
            .where("uid","==",uid).where("email","==",snap.data().asignadoEmail).limit(1).get();
          if (!colabSnapAp.empty) {
            const colabAp = colabSnapAp.docs[0].data();
            sendEmail({
              to: snap.data().asignadoEmail,
              subject: `🎉 ¡Aprobado! — ${snap.data().titulo}`,
              html: emailTareaAprobada({ colab:colabAp, tarea:snap.data(), link:colabPortalLink(origin, colabAp.token) }),
            });
          }
        }
      }
      await ref.update(upd);
      return res.json({ ok: true });
    }

    if (action === "deleteTarea") {
      await db.collection("tareas").doc(body.tareaId).delete();
      return res.json({ ok:true });
    }

    if (action === "duplicateTarea") {
      const { tareaId } = body;
      const ref = db.collection("tareas").doc(tareaId);
      const snap = await ref.get();
      if (!snap.exists || snap.data().uid !== uid) return res.status(403).json({ error:"No autorizado" });
      const orig = snap.data();
      // Número secuencial
      const userRef = db.collection("users").doc(uid);
      let tareaNum = 1;
      await db.runTransaction(async tx => {
        const userDoc = await tx.get(userRef);
        const prev = userDoc.data()?.tareasCount || 0;
        tareaNum = prev + 1;
        tx.set(userRef, { tareasCount: tareaNum }, { merge: true });
      });
      const tareaNumStr = String(tareaNum).padStart(3, "0");
      const data = {
        ...orig,
        titulo: `Copia de ${orig.titulo}`,
        estado: "pendiente",
        deliverables: [],
        correcciones: 0,
        feedbackActual: null,
        comments: [],
        activity: [{ tipo:"creado", autor:"manager", fecha:now, detalle:`Duplicada de #${orig.tareaNumStr||tareaId.slice(0,6)}` }],
        leidoAt: null,
        estimacion: null,
        checklist: (orig.checklist||[]).map(i=>({...i, done:false})),
        tareaNum, tareaNumStr,
        createdAt: now, updatedAt: now,
      };
      const newRef = await db.collection("tareas").add(data);
      return res.json({ _id:newRef.id, ...data });
    }

    if (action === "addComment") {
      const { tareaId, texto } = body;
      if (!tareaId || !texto?.trim()) return res.status(400).json({ error:"Texto requerido" });
      const ref = db.collection("tareas").doc(tareaId);
      const snap = await ref.get();
      if (!snap.exists || snap.data().uid !== uid) return res.status(403).json({ error:"No autorizado" });
      const comment = { texto: texto.trim(), autor:"manager", fecha:now, tipo:"mensaje" };
      await ref.update({ comments:[...(snap.data().comments||[]), comment] });
      // Notificar al colaborador por email
      const tdata = snap.data();
      const colabSnap2 = await db.collection("colaboradores")
        .where("uid","==",uid).where("email","==",tdata.asignadoEmail).limit(1).get();
      if (!colabSnap2.empty) {
        const colab2 = colabSnap2.docs[0].data();
        sendEmail({
          to: tdata.asignadoEmail,
          subject: `💬 Nuevo comentario en "${tdata.titulo}"`,
          html: emailNuevoComentario({ colab:colab2, tarea:tdata, comentario:texto.trim(), link:colabPortalLink(origin, colab2.token) }),
        });
      }
      return res.json({ ok:true, comment });
    }

    if (action === "generateEditorToken") {
      const { editorNombre } = body;
      if (!editorNombre) return res.status(400).json({ error:"Editor requerido" });
      const token = randomToken(24);
      await db.collection("produccionTokens").doc(token).set({ uid, editorNombre, createdAt: now });
      await db.collection("produccion").doc(uid).set({ editorTokens: { [editorNombre]: token } }, { merge: true });
      return res.json({ ok: true, token });
    }

    if (action === "quickUpdateTareaEstado") {
      const { tareaId, estado } = body;
      if (!tareaId || !estado) return res.status(400).json({ error:"Faltan parámetros" });
      const ref = db.collection("tareas").doc(tareaId);
      const snap = await ref.get();
      if (!snap.exists || snap.data().uid !== uid) return res.status(403).json({ error:"No autorizado" });
      const act = { tipo:"estado", autor:"manager", fecha:now, detalle:`Estado: ${estado}` };
      await ref.update({ estado, updatedAt:now, activity:[...(snap.data().activity||[]), act] });
      return res.json({ ok:true });
    }

    if (action === "updateColaboradorPermisos") {
      const { colabId, permisos } = body;
      if (!colabId || !permisos) return res.status(400).json({ error:"Faltan parámetros" });
      const snap = await db.collection("colaboradores").doc(colabId).get();
      if (!snap.exists || snap.data().uid !== uid) return res.status(403).json({ error:"No autorizado" });
      await db.collection("colaboradores").doc(colabId).update({ permisos });
      return res.json({ ok:true });
    }

    if (action === "saveAdminWaPhone") {
      const { phone } = body;
      await db.collection("users").doc(uid).set({ adminWaPhone: phone||"" }, { merge:true });
      return res.json({ ok:true });
    }

    if (action === "sendTestEmail") {
      const { to } = body;
      if (!to) return res.status(400).json({ error:"Email requerido" });
      const html = `<div style="font-family:Inter,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#fff">
        <div style="background:linear-gradient(135deg,#6366f1,#a78bfa);padding:24px;border-radius:12px;text-align:center;margin-bottom:24px">
          <div style="font-size:32px;margin-bottom:8px">✅</div>
          <div style="font-size:20px;font-weight:700;color:#fff">Email de prueba</div>
          <div style="font-size:13px;color:rgba(255,255,255,0.85);margin-top:6px">Growith — Sistema de Notificaciones</div>
        </div>
        <p style="font-size:15px;color:#374151">¡Todo funciona correctamente!</p>
        <p style="font-size:13px;color:#6b7280;line-height:1.6">Este email confirma que el sistema de notificaciones está configurado y funcionando. Los colaboradores van a recibir emails como este cuando se les asignen tareas, y vos vas a recibir notificaciones cuando entreguen trabajo.</p>
        <div style="margin:24px 0;padding:16px;background:#f0fdf4;border-radius:10px;border:1px solid #86efac">
          <div style="font-size:13px;font-weight:700;color:#16a34a;margin-bottom:8px">📬 Emails activos en tu cuenta:</div>
          <ul style="font-size:12px;color:#374151;margin:0;padding-left:18px;line-height:2">
            <li>Tarea asignada → colaborador recibe email</li>
            <li>Entrega recibida → vos recibís email</li>
            <li>Consulta de colaborador → vos recibís email</li>
            <li>Admin comenta → colaborador recibe email</li>
            <li>Corrección solicitada → colaborador recibe email</li>
            <li>Tarea aprobada → colaborador recibe email</li>
          </ul>
        </div>
        <p style="font-size:11px;color:#9ca3af;text-align:center;margin-top:24px">Enviado desde Growith — notificaciones@growith.app</p>
      </div>`;
      const result = await sendEmail({ to, subject:"✅ Email de prueba — Growith funciona correctamente", html });
      if (result?.error) return res.status(500).json({ error: result.error, detail: result });
      return res.json({ ok:true, id: result?.id });
    }

    if (action === "sendRecordatorio") {
      // Manda un email de recordatorio a un colaborador sobre una tarea/creativo
      const { to, nombre, titulo, codigo, estado, deadline, nota } = body;
      if (!to || !titulo) return res.status(400).json({ error:"Faltan parámetros" });
      // Buscar token del colaborador para armar el link al portal
      const colSnap = await db.collection("colaboradores")
        .where("uid","==",uid).where("email","==",to).limit(1).get();
      const colData = colSnap.empty ? null : colSnap.docs[0].data();
      const token = colData?.token || null;
      const link = token ? colabPortalLink(origin, token) : (origin || "https://growithapp.com");
      const colab = { nombre: nombre || to };
      const html = emailRecordatorio({ colab, titulo, codigo: codigo||"", estado: estado||"", deadline: deadline||null, link, nota: nota||"" });
      const result = await sendEmail({ to, subject:`⏰ Recordatorio: ${titulo} — Growith`, html });
      if (result?.error) return res.status(500).json({ error: result.error, detail: result });
      return res.json({ ok:true, id: result?.id });
    }

    if (action === "addCreativoComment") {
      const { creativoId, texto } = body;
      if (!creativoId || !texto?.trim()) return res.status(400).json({ error:"Faltan parámetros" });
      const prodRef = db.collection("produccion").doc(uid);
      const snap = await prodRef.get();
      if (!snap.exists) return res.status(404).json({ error:"Sin data" });
      const prod = snap.data();
      const comment = { id:randomToken(8), texto:texto.trim(), autor:"manager", fecha:now };
      const newCreativos = (prod.creativos||[]).map(c=>c.id===creativoId?{...c,comentarios:[...(c.comentarios||[]),comment]}:c);
      await prodRef.update({ creativos:newCreativos, updatedAt:now });
      return res.json({ ok:true, comment });
    }

    if (action === "getProduccion") {
      const ref = db.collection("produccion").doc(uid);
      const snap = await ref.get();
      if (!snap.exists) return res.json({ editores:["Val","Editor IA","Editor Video","Hector"], tandas:[], creativos:[], ideas:[] });
      const d = snap.data();
      delete d.updatedAt;
      return res.json(d);
    }

    if (action === "saveProduccion") {
      const { data: prodData } = body;
      if (!prodData || typeof prodData !== "object") return res.status(400).json({ error:"Data requerida" });
      await db.collection("produccion").doc(uid).set({ ...prodData, updatedAt: now });
      return res.json({ ok: true });
    }

    // ── TABLÓN + REFERENCIAS ──────────────────────────────────────────────────

    if (action === "getGeneralByToken") {
      // Para el portal del colaborador — lookup por token → uid
      if (!token) return res.status(400).json({ error:"Token requerido" });
      const colSnap = await db.collection("colaboradores").where("token","==",token).limit(1).get();
      if (colSnap.empty) return res.status(404).json({ error:"Token inválido" });
      const colabUid = colSnap.docs[0].data().uid;
      const gSnap = await db.collection("general").doc(colabUid).get();
      if (!gSnap.exists) return res.json({ posts:[], referencias:[] });
      const gd = gSnap.data();
      return res.json({ posts:gd.posts||[], referencias:gd.referencias||[] });
    }

    if (action === "getGeneral") {
      const snap = await db.collection("general").doc(uid).get();
      if (!snap.exists) return res.json({ posts: [], referencias: [] });
      const d = snap.data();
      return res.json({ posts: d.posts||[], referencias: d.referencias||[] });
    }

    if (action === "addPost") {
      const { texto, tipo="aviso", pinned=false } = body;
      if (!texto?.trim()) return res.status(400).json({ error:"texto requerido" });
      const post = { id:randomToken(12), texto:texto.trim(), tipo, pinned:!!pinned, createdAt:now.toISOString() };
      const ref = db.collection("general").doc(uid);
      const snap = await ref.get();
      if (!snap.exists) {
        await ref.set({ posts:[post], referencias:[] });
      } else {
        const posts = [...(snap.data().posts||[]), post];
        await ref.update({ posts });
      }
      return res.json({ ok:true, post });
    }

    if (action === "deletePost") {
      const { postId } = body;
      if (!postId) return res.status(400).json({ error:"postId requerido" });
      const ref = db.collection("general").doc(uid);
      const snap = await ref.get();
      if (!snap.exists) return res.json({ ok:true });
      const posts = (snap.data().posts||[]).filter(p => p.id !== postId);
      await ref.update({ posts });
      return res.json({ ok:true });
    }

    if (action === "addReferencia") {
      const { nombre, web="", metaAds="", ig="" } = body;
      if (!nombre?.trim()) return res.status(400).json({ error:"nombre requerido" });
      const ref = db.collection("general").doc(uid);
      const snap = await ref.get();
      const nueva = { id:randomToken(12), nombre:nombre.trim(), web, metaAds, ig, createdAt:now.toISOString() };
      if (!snap.exists) {
        await ref.set({ posts:[], referencias:[nueva] });
      } else {
        const referencias = [...(snap.data().referencias||[]), nueva];
        await ref.update({ referencias });
      }
      return res.json({ ok:true, referencia:nueva });
    }

    if (action === "deleteReferencia") {
      const { referenciaId } = body;
      const ref = db.collection("general").doc(uid);
      const snap = await ref.get();
      if (!snap.exists) return res.json({ ok:true });
      const referencias = (snap.data().referencias||[]).filter(r => r.id !== referenciaId);
      await ref.update({ referencias });
      return res.json({ ok:true });
    }

    // ── ADMIN ACTIONS (antiguo /api/admin) ───────────────────────────────────

    // getSectionsConfig: público (no requiere ser admin)
    if (action === "getSectionsConfig") {
      try {
        const snap = await db.collection("config").doc(CONFIG_DOC).get();
        const d = snap.exists ? snap.data() : {};
        return res.json({ adminOnlySections: d.adminOnlySections || ["rendimiento"] });
      } catch(e) {
        return res.json({ adminOnlySections: ["rendimiento"] });
      }
    }

    // Acciones solo-admin
    const adminActions = ["setSectionsConfig","adminGetData","activarPlan","desactivarPlan","confirmarPago","rechazarPago","addNote","extenderPlan","gestionarPlan","activarPrueba","ajustarDias","toggleAdmin"];
    if (adminActions.includes(action)) {
      if (!ADMIN_UIDS.includes(uid)) {
        try {
          const adminSnap = await db.collection("users").doc(uid).get();
          if (!adminSnap.exists || !adminSnap.data()?.isAdmin) return res.status(403).json({ error: "No autorizado" });
        } catch(_) { return res.status(403).json({ error: "No autorizado" }); }
      }
      const adminNow = new Date();

      if (action === "setSectionsConfig") {
        const { adminOnlySections } = body;
        if (!Array.isArray(adminOnlySections)) return res.status(400).json({ error: "adminOnlySections debe ser un array" });
        await db.collection("config").doc(CONFIG_DOC).set({ adminOnlySections, updatedAt: adminNow, updatedBy: uid }, { merge: true });
        return res.json({ ok: true, adminOnlySections });
      }

      if (action === "adminGetData") {
        const [pagSnap, usSnap] = await Promise.all([
          db.collection("pagos").orderBy("createdAt", "desc").get(),
          db.collection("users").get(),
        ]);
        const pagos = pagSnap.docs.map(d => ({ _id: d.id, ...d.data() }));
        const usuarios = usSnap.docs.map(d => ({ _id: d.id, ...d.data() }));
        const activos = usuarios.filter(u => u.plan && u.plan !== "free");
        const activosPagos = activos.filter(u => !u.isTrial);
        const mrrUsdt = activosPagos.reduce((s, u) => s + (PLAN_PRICE_USDT[u.plan] || 0), 0);
        const mrrArs  = activosPagos.reduce((s, u) => s + (PLAN_PRICE_ARS[u.plan]  || 0), 0);
        const en7dias = new Date(adminNow); en7dias.setDate(en7dias.getDate() + 7);
        const vencenPronto = activos.filter(u => {
          const exp = u.planExpiry?._seconds ? new Date(u.planExpiry._seconds * 1000) : u.planExpiry?.toDate?.();
          return exp && exp >= adminNow && exp <= en7dias;
        });
        const pagosReales = pagos.filter(p => p.estado === "confirmado" && !p.isTrial && Number(p.amount) > 0);
        const totalUSDT = pagosReales.filter(p => p.currency === "USDT").reduce((s,p) => s + (Number(p.amount)||0), 0);
        const totalARS  = pagosReales.filter(p => p.currency === "ARS").reduce((s,p)  => s + (Number(p.amount)||0), 0);
        const stats = {
          totalUsuarios: usuarios.length,
          usuariosPlus: usuarios.filter(u => u.plan==="plus" && !u.isTrial).length,
          usuariosFull: usuarios.filter(u => u.plan==="full" && !u.isTrial).length,
          usuariosPlus_trial: usuarios.filter(u => u.plan==="plus" && u.isTrial).length,
          usuariosFull_trial: usuarios.filter(u => u.plan==="full" && u.isTrial).length,
          usuariosPrueba: usuarios.filter(u => u.isTrial).length,
          pagosPendientes: pagos.filter(p => p.estado === "pendiente").length,
          pagosRealesCount: pagosReales.length,
          countPruebas: pagos.filter(p => p.isTrial).length,
          mrrUsdt, mrrArs, totalUSDT, totalARS, vencenPronto: vencenPronto.length,
        };
        return res.json({ pagos, usuarios, stats });
      }

      if (action === "activarPlan") {
        const { targetUid, plan, meses = 1 } = body;
        const userDoc = await db.collection("users").doc(targetUid).get();
        const userData = userDoc.data() || {};
        let base = adminNow;
        if (userData.planExpiry) {
          const cur = userData.planExpiry?._seconds ? new Date(userData.planExpiry._seconds*1000) : userData.planExpiry?.toDate?.() || adminNow;
          if (cur > adminNow) base = cur;
        }
        const expiry = addMonths(base, meses);
        await db.collection("users").doc(targetUid).update({ plan, planExpiry: expiry, planActivadoBy: uid, planActivadoAt: adminNow });
        return res.json({ ok: true, expiry });
      }

      if (action === "desactivarPlan") {
        const { targetUid } = body;
        await db.collection("users").doc(targetUid).update({ plan: "free", planExpiry: null, planDesactivadoBy: uid, planDesactivadoAt: adminNow });
        return res.json({ ok: true });
      }

      if (action === "confirmarPago") {
        const { pagoId, targetUid, plan, meses = 1 } = body;
        const userDoc = await db.collection("users").doc(targetUid).get();
        const userData = userDoc.data() || {};
        let base = adminNow;
        if (userData.planExpiry) {
          const cur = userData.planExpiry?._seconds ? new Date(userData.planExpiry._seconds*1000) : userData.planExpiry?.toDate?.() || adminNow;
          if (cur > adminNow) base = cur;
        }
        const expiry = addMonths(base, meses);
        await Promise.all([
          db.collection("users").doc(targetUid).update({ plan, planExpiry: expiry, planActivadoBy: uid, planActivadoAt: adminNow }),
          db.collection("pagos").doc(pagoId).update({ estado: "confirmado", mesesConfirmados: Number(meses), confirmadoBy: uid, confirmadoAt: adminNow }),
        ]);
        return res.json({ ok: true, expiry });
      }

      if (action === "rechazarPago") {
        const { pagoId, motivo = "" } = body;
        await db.collection("pagos").doc(pagoId).update({ estado: "rechazado", rechazadoBy: uid, rechazadoAt: adminNow, motivoRechazo: motivo });
        return res.json({ ok: true });
      }

      if (action === "addNote") {
        const { targetUid, note } = body;
        await db.collection("users").doc(targetUid).update({ adminNote: note, adminNoteAt: adminNow, adminNoteBy: uid });
        return res.json({ ok: true });
      }

      if (action === "extenderPlan") {
        const { targetUid, meses = 1 } = body;
        const userDoc = await db.collection("users").doc(targetUid).get();
        const userData = userDoc.data() || {};
        let base = adminNow;
        if (userData.planExpiry) {
          const cur = userData.planExpiry?._seconds ? new Date(userData.planExpiry._seconds*1000) : userData.planExpiry?.toDate?.() || adminNow;
          if (cur > adminNow) base = cur;
        }
        const expiry = addMonths(base, meses);
        await db.collection("users").doc(targetUid).update({ planExpiry: expiry, planExtendidoBy: uid, planExtendidoAt: adminNow });
        return res.json({ ok: true, expiry });
      }

      if (action === "gestionarPlan") {
        const { targetUid, plan, cantidad, unidad = "meses", isTrial = false } = body;
        const userDoc = await db.collection("users").doc(targetUid).get();
        const userData = userDoc.data() || {};
        let base = adminNow;
        if (userData.planExpiry) {
          const cur = userData.planExpiry?._seconds ? new Date(userData.planExpiry._seconds*1000) : userData.planExpiry?.toDate?.() || adminNow;
          if (cur > adminNow) base = cur;
        }
        let expiry;
        if (unidad === "dias") { expiry = new Date(base); expiry.setDate(expiry.getDate() + Number(cantidad)); }
        else { expiry = addMonths(base, Number(cantidad)); }
        await db.collection("users").doc(targetUid).update({ plan, planExpiry: expiry, isTrial: !!isTrial, planActivadoBy: uid, planActivadoAt: adminNow });
        if (isTrial) {
          await db.collection("pagos").add({ uid: targetUid, plan, method: "prueba", currency: "—", amount: 0, isTrial: true, cantidad: Number(cantidad), unidad, estado: "confirmado", confirmadoBy: uid, confirmadoAt: adminNow, createdAt: adminNow, nota: `Prueba: ${cantidad} ${unidad} de ${plan}` });
        }
        return res.json({ ok: true, expiry });
      }

      if (action === "activarPrueba") {
        const { targetUid, plan, meses = 1 } = body;
        const userDoc = await db.collection("users").doc(targetUid).get();
        const userData = userDoc.data() || {};
        let base = adminNow;
        if (userData.planExpiry) {
          const cur = userData.planExpiry?._seconds ? new Date(userData.planExpiry._seconds*1000) : userData.planExpiry?.toDate?.() || adminNow;
          if (cur > adminNow) base = cur;
        }
        const expiry = addMonths(base, meses);
        await Promise.all([
          db.collection("users").doc(targetUid).update({ plan, planExpiry: expiry, isTrial: true, planActivadoBy: uid, planActivadoAt: adminNow }),
          db.collection("pagos").add({ uid: targetUid, plan, method: "prueba", currency: "—", amount: 0, isTrial: true, mesesConfirmados: Number(meses), estado: "confirmado", confirmadoBy: uid, confirmadoAt: adminNow, createdAt: adminNow, nota: `Plan de prueba (${meses}m) activado por admin` }),
        ]);
        return res.json({ ok: true, expiry });
      }

      if (action === "ajustarDias") {
        const { targetUid, dias } = body;
        if (!targetUid || dias === undefined) return res.status(400).json({ error: "Faltan parámetros" });
        const userDoc = await db.collection("users").doc(targetUid).get();
        const userData = userDoc.data() || {};
        let base = userData.planExpiry?._seconds ? new Date(userData.planExpiry._seconds*1000) : userData.planExpiry?.toDate?.() || adminNow;
        const expiry = new Date(base); expiry.setDate(expiry.getDate() + Number(dias));
        await db.collection("users").doc(targetUid).update({ planExpiry: expiry, planAjustadoBy: uid, planAjustadoAt: adminNow, planAjusteDias: Number(dias) });
        return res.json({ ok: true, expiry });
      }

      if (action === "toggleAdmin") {
        const { targetUid } = body;
        if (!targetUid) return res.status(400).json({ error: "Falta targetUid" });
        if (targetUid === uid) return res.status(400).json({ error: "No podés quitarte el admin a vos mismo" });
        const userDoc = await db.collection("users").doc(targetUid).get();
        const current = userDoc.data()?.isAdmin || false;
        await db.collection("users").doc(targetUid).set({ isAdmin: !current }, { merge: true });
        return res.json({ ok: true, isAdmin: !current });
      }
    }
    // ── fin Admin actions ────────────────────────────────────────────────────

    return res.status(400).json({ error:"Acción desconocida" });

  } catch(e) {
    console.error("[tareas]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
