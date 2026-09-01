// api/tareas.js — Gestión de tareas y colaboradores externos
// Autenticación dual:
//  - dueño de la cuenta: ID token de Firebase atado al uid (guardUid)
//  - colaborador externo: token de portal, con alcance a lo suyo (acciones public*)
//  - administración de la plataforma: requireAdmin, que sale del TOKEN (nunca
//    de un uid mandado por el cliente, que era el agujero anterior)

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { guardUid, requireAdmin, guardCron, verifyAuth, clearTeamCache } from "./_auth.js";
import { acreditarComisionReferido, descontarCreditoAplicado } from "./referidos.js";

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
// Precios REALES de venta (deben coincidir con los de AppPlanes en el frontend;
// antes el MRR del panel se calculaba con valores viejos y salía ~63% bajo).
const PLAN_PRICE_USDT = { plus: 79 };
const PLAN_PRICE_ARS  = { plus: 79000 };
const CONFIG_DOC = "growith_app_config";
function addMonths(date, n) { const d = new Date(date); d.setMonth(d.getMonth() + Number(n)); return d; }
// ─── fin Admin constants ──────────────────────────────────────────────────

function randomToken(len = 24) {
  // PRNG criptográfico (webcrypto global): estos tokens son credenciales bearer
  // del portal colaborador/tablero — con Math.random() eran predecibles.
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let t = "";
  for (let i = 0; i < len; i++) t += chars[bytes[i] % chars.length];
  return t;
}

function colabPortalLink(origin, token) {
  // Siempre el dominio de marca: si el admin navega desde el dominio técnico
  // de Vercel, el colaborador NO tiene que recibir un link con ese nombre.
  const o = String(origin || "");
  const base = /localhost|127\.0\.0\.1/.test(o) ? o.replace(/\/$/, "") : "https://www.growithapp.com";
  return `${base}/#/colaborador/${token}`;
}

// delayMs opcional → usa Resend scheduled_at (permite cancelar antes de enviar)
async function sendEmail({ to, subject, html, delayMs, attachments }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.error("[email] RESEND_API_KEY no configurada"); return { error: "RESEND_API_KEY_FALTANTE" }; }
  if (!to)  { console.error("[email] destinatario vacío"); return { error: "Sin destinatario" }; }
  const from = process.env.RESEND_FROM || "Growith <onboarding@resend.dev>";
  const usingSandbox = from.includes("onboarding@resend.dev");
  if (usingSandbox) {
    console.warn(`[email] SANDBOX: onboarding@resend.dev — solo entrega al dueño de la cuenta. Intentando enviar a ${to} de todas formas...`);
  }
  try {
    const body = { from, to: [to], subject, html };
    if (Array.isArray(attachments) && attachments.length) body.attachments = attachments;
    if (delayMs) {
      body.scheduled_at = new Date(Date.now() + delayMs).toISOString();
      console.log(`[email] programado en ${delayMs/1000}s → "${subject}"`);
    } else {
      console.log(`[email] enviando desde "${from}" a "${to}" subject="${subject}"`);
    }
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) { console.error("[email] Resend error:", JSON.stringify(data)); return { error: data?.message || "Error Resend", detail: data }; }
    console.log(`[email] OK id=${data.id}${delayMs?" (programado)":""}`);
    return { ok: true, id: data.id };
  } catch(e) {
    console.error("[email] fetch error:", e.message);
    return { error: e.message };
  }
}

// Cancela un email programado en Resend (solo funciona si todavía no se envió)
async function cancelEmail(emailId) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !emailId) return;
  try {
    await fetch(`https://api.resend.com/emails/${emailId}/cancel`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}` },
    });
    console.log(`[email] cancelado id=${emailId}`);
  } catch(e) {
    console.warn(`[email] no se pudo cancelar ${emailId}:`, e.message);
  }
}

async function getNotifEmails(db, uid) {
  if (!uid) return [];
  try {
    const snap = await db.collection("users").doc(uid).get();
    return snap.exists ? (snap.data().notifEmails || []) : [];
  } catch(e) { return []; }
}
async function notifyManagers(db, uid, managerEmail, subject, html) {
  // Usamos el email ACTUAL del usuario (userDoc.email, editable en Config) — así
  // si lo cambiás, las notificaciones van al nuevo, no al que quedó guardado en la
  // tarea. Fallback al managerEmail de la tarea si no hay userDoc.email.
  let ownerEmail = managerEmail, extras = [];
  try {
    const s = await db.collection("users").doc(uid).get();
    if (s.exists) { const d = s.data(); extras = d.notifEmails || []; if (d.email) ownerEmail = d.email; }
  } catch(_) {}
  const recipients = [...new Set([ownerEmail, ...extras])].filter(Boolean);
  await Promise.all(recipients.map(to => sendEmail({ to, subject, html })));
}

function emailTareaAsignada({ colab, tarea, link }) {
  const deadlineStr = tarea.deadline ? new Date(tarea.deadline).toLocaleDateString("es-AR") : null;
  return `<div style="font-family:Inter,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="background:linear-gradient(135deg,#6366f1,#a78bfa);padding:24px;border-radius:12px;text-align:center;margin-bottom:24px">
    <div style="font-size:20px;font-weight:700;color:#fff">Nueva tarea asignada</div>
  </div>
  <p style="font-size:15px;color:#374151">Hola <strong>${colab.nombre.split(" ")[0]}</strong>,</p>
  <p style="font-size:14px;color:#6b7280">Te asignaron una nueva tarea:</p>
  <div style="background:#f9fafb;border-radius:10px;padding:16px 20px;margin:16px 0;border-left:4px solid #6366f1">
    <div style="font-size:16px;font-weight:700;color:#111827;margin-bottom:6px">${tarea.titulo}</div>
    ${tarea.descripcion ? `<div style="font-size:13px;color:#6b7280">${tarea.descripcion}</div>` : ""}
    ${deadlineStr ? `<div style="font-size:12px;color:#6b7280;margin-top:6px">Fecha límite: ${deadlineStr}</div>` : ""}
    ${tarea.prioridad === "urgente" ? `<div style="font-size:12px;color:#ef4444;font-weight:700;margin-top:4px">URGENTE</div>` : ""}
  </div>
  <a href="${link}" style="display:block;text-align:center;background:#6366f1;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;margin:20px 0">Ver mi tarea →</a>
  <p style="font-size:12px;color:#9ca3af;text-align:center">Growith — Sistema de gestión</p>
</div>`;
}

// Invitación a miembro con cuenta: el botón lleva a la app; al registrarse
// con este mismo email, el claim de la invitación es automático (action=workspace).
function emailInvitacionMiembro({ nombre, ownerNombre, secciones, link }) {
  const LABELS = { tareas:"Tareas", canjes:"Canjes", envios:"Envíos", reclamos:"Reclamos", stock:"Stock", meta:"Meta Ads", ml:"Mercado Libre", margenes:"Dashboard", arca:"Facturador", copilot:"Copilot" };
  const secs = Object.keys(secciones || {}).filter(k => secciones[k] === true).map(k => LABELS[k] || k);
  const primerNombre = String(nombre || "").split(" ")[0];
  return `<div style="font-family:Inter,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="background:linear-gradient(135deg,#6366f1,#a78bfa);padding:24px;border-radius:12px;text-align:center;margin-bottom:24px">
    <div style="font-size:20px;font-weight:700;color:#fff">Te invitaron a Growith</div>
  </div>
  <p style="font-size:15px;color:#374151">Hola${primerNombre ? ` <strong>${primerNombre}</strong>` : ""},</p>
  <p style="font-size:14px;color:#6b7280"><strong>${ownerNombre || "Un equipo"}</strong> te invitó a su espacio de trabajo en Growith para que gestiones estas secciones:</p>
  ${secs.length ? `<div style="background:#f9fafb;border-radius:10px;padding:16px 20px;margin:16px 0;border-left:4px solid #6366f1">
    ${secs.map(s => `<div style="font-size:14px;font-weight:600;color:#111827;padding:3px 0">${s}</div>`).join("")}
  </div>` : ""}
  <p style="font-size:14px;color:#6b7280">Para entrar, creá tu cuenta usando <strong>este mismo email</strong> (podés hacerlo con Google o con contraseña). Al entrar, tu acceso se activa solo.</p>
  <a href="${link}" style="display:block;text-align:center;background:#6366f1;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;margin:20px 0">Crear mi cuenta →</a>
  <p style="font-size:12px;color:#9ca3af;text-align:center">Si no esperabas esta invitación, podés ignorar este mail.</p>
  <p style="font-size:12px;color:#9ca3af;text-align:center">Growith — Sistema de gestión</p>
</div>`;
}

function emailEntregaRecibida({ colab, tarea, entrega, link }) {
  return `<div style="font-family:Inter,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="background:linear-gradient(135deg,#f97316,#fb923c);padding:24px;border-radius:12px;text-align:center;margin-bottom:24px">
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

function emailEntregaActualizada({ colab, tarea, entrega, link }) {
  return `<div style="font-family:Inter,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="background:linear-gradient(135deg,#6366f1,#818cf8);padding:24px;border-radius:12px;text-align:center;margin-bottom:24px">
    <div style="font-size:20px;font-weight:700;color:#fff">Entrega actualizada</div>
  </div>
  <p style="font-size:15px;color:#374151"><strong>${colab.nombre}</strong> agregó un documento a su entrega:</p>
  <div style="background:#f9fafb;border-radius:10px;padding:16px 20px;margin:16px 0;border-left:4px solid #6366f1">
    <div style="font-size:15px;font-weight:700;color:#111827;margin-bottom:6px">${tarea.titulo}</div>
    ${entrega.label ? `<div style="font-size:12px;color:#6b7280">${entrega.label}</div>` : ""}
    ${entrega.nota ? `<div style="font-size:13px;color:#374151;margin-top:6px">${entrega.nota}</div>` : ""}
    <a href="${entrega.link}" style="display:inline-block;margin-top:10px;font-size:13px;color:#6366f1;font-weight:600">Ver documento →</a>
  </div>
  <a href="${link}" style="display:block;text-align:center;background:#6366f1;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;margin:20px 0">Ver entrega completa →</a>
  <p style="font-size:12px;color:#9ca3af;text-align:center">Growith — Sistema de gestión</p>
</div>`;
}

function emailTareaAprobada({ colab, tarea, link }) {
  return `<div style="font-family:Inter,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="background:linear-gradient(135deg,#22c55e,#4ade80);padding:24px;border-radius:12px;text-align:center;margin-bottom:24px">
    <div style="font-size:20px;font-weight:700;color:#fff">¡Tu entrega fue aprobada!</div>
  </div>
  <p style="font-size:15px;color:#374151">Hola <strong>${colab.nombre.split(" ")[0]}</strong>,</p>
  <p style="font-size:14px;color:#6b7280">El equipo revisó y aprobó tu trabajo. ¡Excelente labor!</p>
  <div style="background:#f0fdf4;border-radius:10px;padding:16px 20px;margin:16px 0;border-left:4px solid #22c55e">
    <div style="font-size:16px;font-weight:700;color:#111827">${tarea.titulo}</div>
  </div>
  <a href="${link}" style="display:block;text-align:center;background:#22c55e;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;margin:20px 0">Ver tarea →</a>
  <p style="font-size:12px;color:#9ca3af;text-align:center">Growith — Sistema de gestión</p>
</div>`;
}

function emailNuevoComentario({ colab, tarea, comentario, link }) {
  return `<div style="font-family:Inter,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="background:linear-gradient(135deg,#6366f1,#818cf8);padding:24px;border-radius:12px;text-align:center;margin-bottom:24px">
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
    <div style="font-size:20px;font-weight:700;color:#fff">Recordatorio de tarea</div>
    <div style="font-size:13px;color:rgba(255,255,255,0.85);margin-top:6px">Growith</div>
  </div>
  <p style="font-size:15px;color:#374151">Hola <strong>${colab.nombre.split(" ")[0]}</strong>,</p>
  <p style="font-size:14px;color:#6b7280">Te mandamos un recordatorio sobre esta tarea:</p>
  <div style="background:#fffbeb;border-radius:10px;padding:16px 20px;margin:16px 0;border-left:4px solid #f59e0b">
    ${codigo ? `<div style="font-size:10px;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px">${codigo}</div>` : ""}
    <div style="font-size:16px;font-weight:700;color:#111827;margin-bottom:6px">${titulo}</div>
    <div style="font-size:12px;color:#92400e;font-weight:600">Estado: ${estadoLabel}</div>
    ${deadlineStr ? `<div style="font-size:12px;color:#dc2626;font-weight:700;margin-top:4px">Vence: ${deadlineStr}</div>` : ""}
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
  { const _o=String(req.headers.origin||""); res.setHeader("Access-Control-Allow-Origin", (["https://www.growithapp.com","https://growithapp.com","https://soluna-gestion.vercel.app"].includes(_o)||_o.endsWith("-soluna1.vercel.app")||_o.startsWith("http://localhost"))?_o:"https://www.growithapp.com"); } // allowlist CORS
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

    // ── CRON diario (vercel.json): recordatorios de deadline + resumen semanal ──
    // (a) 24-36h antes del vencimiento → email al colaborador asignado.
    // (b) Venció sin aprobar → email al colaborador + UN aviso a los admins.
    // (c) Lunes → resumen semanal SOLO a administradores (users/{uid}.email +
    //     notifEmails); los colaboradores/editores nunca lo reciben.
    // Idempotente: remPreAt / remVencidaAt en la tarea, tareasWeeklyAt en el user.
    if (action === "cron_deadlines") {
      if (!guardCron(req, res)) return;
      const ahora = new Date();
      const en36h = new Date(ahora.getTime() + 36 * 3600000);
      const desde = new Date(ahora.getTime() - 14 * 86400000);
      const hasta = new Date(ahora.getTime() + 8 * 86400000);
      const snapT = await db.collection("tareas").where("deadline", ">=", desde).where("deadline", "<=", hasta).get();
      const dlOf = t => t.deadline?.toDate ? t.deadline.toDate() : new Date(t.deadline?._seconds ? t.deadline._seconds * 1000 : t.deadline);
      const pendTareas = snapT.docs.map(d => ({ _id: d.id, _ref: d.ref, ...d.data() })).filter(t => t.estado !== "aprobado" && t.deadline);
      const uids = [...new Set(pendTareas.map(t => t.uid).filter(Boolean))];
      const colabsByUid = {};
      for (const u of uids) {
        const cs = await db.collection("colaboradores").where("uid", "==", u).get();
        colabsByUid[u] = {};
        cs.docs.forEach(d => { const c = d.data(); if (c.email) colabsByUid[u][c.email.toLowerCase()] = c; });
      }
      const fmtDL = d => d.toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long", timeZone: "America/Argentina/Buenos_Aires" });
      const mailColab = async (t, esPre) => {
        const dl = dlOf(t);
        for (const em of (t.asignadosEmails || [t.asignadoEmail]).filter(Boolean)) {
          const colab = (colabsByUid[t.uid] || {})[em.toLowerCase()];
          const link = colab?.token ? colabPortalLink("", colab.token) : "";
          const html = `<div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="background:linear-gradient(135deg,${esPre ? "#f59e0b,#f97316" : "#ef4444,#f97316"});padding:22px;border-radius:12px;text-align:center;margin-bottom:22px">
    <div style="font-size:18px;font-weight:700;color:#fff">${esPre ? "Tu tarea vence mañana" : "Tu tarea está vencida"}</div>
    <div style="font-size:13px;color:rgba(255,255,255,0.85);margin-top:4px">${t.titulo}</div>
  </div>
  <p style="font-size:14px;color:#374151">${esPre ? `La tarea <strong>${t.titulo}</strong> vence el <strong>${fmtDL(dl)}</strong>. Si ya la tenés lista, subí la entrega desde tu portal.` : `La tarea <strong>${t.titulo}</strong> venció el <strong>${fmtDL(dl)}</strong> y todavía no está aprobada. Subí la entrega o avisá si estás trabado/a.`}</p>
  ${link ? `<div style="text-align:center;margin:18px 0"><a href="${link}" style="background:#6366f1;color:#fff;padding:11px 26px;border-radius:9px;text-decoration:none;font-size:14px;font-weight:700">Abrir mi portal</a></div>` : ""}
  <p style="font-size:12px;color:#9ca3af;text-align:center">Growith — Tareas</p>
</div>`;
          await sendEmail({ to: em, subject: esPre ? `Vence mañana: ${t.titulo}` : `Tarea vencida: ${t.titulo}`, html });
        }
      };
      let pre = 0, venc = 0;
      const vencidasPorUid = {};
      for (const t of pendTareas) {
        const dl = dlOf(t);
        // Enviar PRIMERO y marcar DESPUÉS: al revés, si la función se cortaba a
        // mitad del loop (timeout), las tareas quedaban marcadas como "ya
        // notificadas" sin que el mail hubiera salido, y el recordatorio se
        // perdía para siempre. Peor un mail repetido que uno que nunca llega.
        if (dl > ahora && dl <= en36h && !t.remPreAt) {
          await mailColab(t, true); pre++;
          await t._ref.set({ remPreAt: now }, { merge: true });
        } else if (dl < ahora && !t.remVencidaAt) {
          await mailColab(t, false); venc++;
          await t._ref.set({ remVencidaAt: now }, { merge: true });
          (vencidasPorUid[t.uid] = vencidasPorUid[t.uid] || []).push(t);
        }
      }
      // Aviso a admins: solo las que ACABAN de vencer, agrupadas en un solo mail
      for (const [u, ts] of Object.entries(vencidasPorUid)) {
        const lista = ts.map(t => `<li style="margin-bottom:6px"><strong>${t.titulo}</strong> — ${t.asignadoNombre || t.asignadoEmail || ""} · venció el ${fmtDL(dlOf(t))}</li>`).join("");
        const html = `<div style="font-family:Inter,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="background:linear-gradient(135deg,#ef4444,#f97316);padding:22px;border-radius:12px;text-align:center;margin-bottom:22px">
    <div style="font-size:18px;font-weight:700;color:#fff">Tareas vencidas sin entregar</div>
  </div>
  <ul style="font-size:13px;color:#374151;padding-left:18px;line-height:1.6">${lista}</ul>
  <p style="font-size:12px;color:#9ca3af;text-align:center;margin-top:18px">Growith — Tareas</p>
</div>`;
        await notifyManagers(db, u, ts[0]?.managerEmail || "", `${ts.length} tarea${ts.length !== 1 ? "s" : ""} vencida${ts.length !== 1 ? "s" : ""} sin entregar`, html);
      }
      // Resumen semanal — lunes en Argentina, una vez por día, solo admins
      const diaAR = new Intl.DateTimeFormat("en-US", { timeZone: "America/Argentina/Buenos_Aires", weekday: "short" }).format(ahora);
      let weekly = 0;
      if (diaAR === "Mon") {
        const hoyISO = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(ahora);
        for (const u of uids) {
          const uref = db.collection("users").doc(u);
          const usnap = await uref.get();
          if ((usnap.data() || {}).tareasWeeklyAt === hoyISO) continue;
          const tsU = pendTareas.filter(t => t.uid === u);
          const vencidas = tsU.filter(t => dlOf(t) < ahora);
          const proximas = tsU.filter(t => { const d = dlOf(t); return d >= ahora && d <= new Date(ahora.getTime() + 7 * 86400000); });
          const entregadasSnap = await db.collection("tareas").where("uid", "==", u).where("estado", "==", "entregado").get();
          if (!vencidas.length && !proximas.length && !entregadasSnap.size) continue;
          const li = t => `<li style="margin-bottom:5px"><strong>${t.titulo}</strong> — ${t.asignadoNombre || t.asignadoEmail || ""} · ${fmtDL(dlOf(t))}</li>`;
          const html = `<div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="background:linear-gradient(135deg,#6366f1,#a78bfa);padding:22px;border-radius:12px;text-align:center;margin-bottom:22px">
    <div style="font-size:18px;font-weight:700;color:#fff">Resumen semanal del equipo</div>
  </div>
  ${entregadasSnap.size ? `<p style="font-size:14px;color:#374151"><strong>${entregadasSnap.size}</strong> entrega${entregadasSnap.size !== 1 ? "s" : ""} esperando tu revisión.</p>` : ""}
  ${vencidas.length ? `<div style="font-size:13px;color:#dc2626;font-weight:700;margin-top:14px">Vencidas sin aprobar (${vencidas.length})</div><ul style="font-size:13px;color:#374151;padding-left:18px;line-height:1.6">${vencidas.map(li).join("")}</ul>` : ""}
  ${proximas.length ? `<div style="font-size:13px;color:#d97706;font-weight:700;margin-top:14px">Vencen esta semana (${proximas.length})</div><ul style="font-size:13px;color:#374151;padding-left:18px;line-height:1.6">${proximas.map(li).join("")}</ul>` : ""}
  <p style="font-size:12px;color:#9ca3af;text-align:center;margin-top:20px">Growith — Tareas</p>
</div>`;
          await uref.set({ tareasWeeklyAt: hoyISO }, { merge: true });
          await notifyManagers(db, u, "", `Resumen semanal: ${vencidas.length} vencidas · ${proximas.length} vencen esta semana`, html);
          weekly++;
        }
      }
      return res.json({ ok: true, enVentana: pendTareas.length, preAvisos: pre, vencidas: venc, resumenes: weekly });
    }

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
      const detalle = estado==="bloqueada" && motivo ? `Bloqueado: ${motivo}` : `Progreso: ${label}`;
      const act = { tipo:"progreso", autor:colab.nombre, fecha:now, detalle };
      const upd = { estado, progresoLabel: progresoLabel||"", updatedAt: now, activity: [...(t.data().activity||[]), act] };
      const prevEstado = t.data().estado;
      const prevProgresoLabel = t.data().progresoLabel || "";
      const managerEmailPub = t.data().managerEmail;
      const tareaLink = `${origin||"https://www.growithapp.com"}/#/tareas`;

      if (estado==="bloqueada" && motivo) {
        // Add motivo as a comment so admin sees it
        const comment = { texto: `Bloqueado: ${motivo}`, autor:colab.nombre, fecha:now, tipo:"bloqueo" };
        upd.comments = [...(t.data().comments||[]), comment];
        // Notify manager(s)
        notifyManagers(db, t.data().uid, managerEmailPub,
          `${colab.nombre} está bloqueado — ${t.data().titulo}`,
          emailConsultaRecibida({ colab, tarea:t.data(), texto:`Bloqueado: ${motivo}`, link:tareaLink }));
      }

      // Retoma el trabajo tras bloqueo → notificar al manager (inmediato, es urgente resolverlo)
      if (estado==="en_proceso" && prevEstado==="bloqueada") {
        notifyManagers(db, t.data().uid, managerEmailPub,
          `${colab.nombre} retomó el trabajo — ${t.data().titulo}`,
          emailRetomaTrabajo({ colab, tarea:t.data(), link:tareaLink }));
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
      notifyManagers(db, t.data().uid, t.data().managerEmail,
        `Actualización de ${colab.nombre} — ${t.data().titulo}`,
        emailNuevoComentario({ colab, tarea:t.data(), comentario:texto.trim(), link:`${origin||"https://www.growithapp.com"}/#/tareas` }));
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
      notifyManagers(db, t.data().uid, t.data().managerEmail,
        `Consulta de ${colab.nombre} — ${t.data().titulo}`,
        emailConsultaRecibida({ colab, tarea:t.data(), texto:texto.trim(), link:`${origin||"https://www.growithapp.com"}/#/tareas` }));
      return res.json({ ok:true, comment });
    }

    if (action === "publicAddEntrega") {
      const { tareaId, link, nota, label, esFinal=true } = body;
      if (!token || !tareaId || !link) return res.status(400).json({ error: "Link de entrega requerido" });
      const snap = await db.collection("colaboradores").where("token","==",token).limit(1).get();
      if (snap.empty) return res.status(403).json({ error: "Token inválido" });
      const colab = snap.docs[0].data();
      const ref = db.collection("tareas").doc(tareaId);
      const t = await ref.get();
      if (!t.exists) return res.status(404).json({ error: "Tarea no encontrada" });
      const emailsAssign = t.data().asignadosEmails?.length ? t.data().asignadosEmails : [t.data().asignadoEmail].filter(Boolean);
      if (!emailsAssign.includes(colab.email)) return res.status(403).json({ error: "No autorizado" });
      const prevDels = t.data().deliverables || [];
      const version = prevDels.length + 1;
      const hasFinalDelivery = prevDels.some(d => !d.parcial);
      const entrega = { link, nota: nota||"", label: label||`v${version}`, version, fecha: now, parcial: false };
      const act = { tipo:"entrega", autor:colab.nombre, fecha:now, detalle: hasFinalDelivery ? `Agregó documento a entrega: ${entrega.label}` : `Entrega final` };
      const upd = {
        deliverables:[...prevDels, entrega],
        feedbackActual:null,
        updatedAt:now,
        activity:[...(t.data().activity||[]), act],
      };
      upd.estado = "entregado";
      await ref.update(upd);
      // Email al manager(s): "Entrega actualizada" si ya había entrega, "Nueva entrega" si es la primera
      notifyManagers(db, t.data().uid, t.data().managerEmail,
        hasFinalDelivery
          ? `Entrega actualizada — ${colab.nombre} agregó un documento en "${t.data().titulo}"`
          : `Entrega de ${colab.nombre} — ${t.data().titulo}`,
        hasFinalDelivery
          ? emailEntregaActualizada({ colab, tarea:t.data(), entrega, link:`${origin||"https://www.growithapp.com"}/#/tareas` })
          : emailEntregaRecibida({ colab, tarea:t.data(), entrega, link:`${origin||"https://www.growithapp.com"}/#/tareas` }));
      return res.json({ ok: true, entrega });
    }

    if (action === "publicProponerTarea") {
      const { titulo, descripcion="", link="", linkLabel="" } = body;
      if (!token || !titulo?.trim()) return res.status(400).json({ error: "Título requerido" });
      const snap = await db.collection("colaboradores").where("token","==",token).limit(1).get();
      if (snap.empty) return res.status(403).json({ error: "Token inválido" });
      const colab = snap.docs[0].data();
      const ref = db.collection("tareas").doc();
      const deliverables = [];
      if (link?.trim()) {
        deliverables.push({ link: link.trim(), label: linkLabel?.trim()||"Entrega inicial", nota:"", version:1, fecha: now });
      }
      const tarea = {
        titulo: titulo.trim(),
        descripcion: descripcion?.trim()||"",
        brief: "",
        links: [],
        estado: deliverables.length > 0 ? "entregado" : "pendiente",
        prioridad: "normal",
        asignadoEmail: colab.email,
        asignadoNombre: colab.nombre,
        uid: colab.uid,
        managerEmail: colab.managerEmail || "",
        propuestaPor: colab.nombre,
        deliverables,
        activity: [{ tipo:"creacion", autor:colab.nombre, fecha:now, detalle:"Propuso esta tarea" }],
        checklist: [],
        historial: [],
        createdAt: now,
        updatedAt: now,
      };
      await ref.set(tarea);
      const created = { ...tarea, _id: ref.id };
      return res.json({ ok: true, tarea: created });
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

    // ── COLABORADOR PÚBLICO: editar su última entrega ──────────────────────────
    if (action === "publicUpdateLastDeliverable") {
      const { tareaId, link, label, nota } = body;
      if (!token || !tareaId) return res.status(400).json({ error:"Faltan parámetros" });
      const cSnap2 = await db.collection("colaboradores").where("token","==",token).limit(1).get();
      if (cSnap2.empty) return res.status(403).json({ error:"Token inválido" });
      const colab2 = cSnap2.docs[0].data();
      const ref2 = db.collection("tareas").doc(tareaId);
      const t2 = await ref2.get();
      if (!t2.exists) return res.status(404).json({ error:"Tarea no encontrada" });
      const nrmMail2 = (s) => String(s||"").trim().toLowerCase();
      const emails2 = (t2.data().asignadosEmails?.length ? t2.data().asignadosEmails : [t2.data().asignadoEmail]).filter(Boolean).map(nrmMail2);
      if (!emails2.includes(nrmMail2(colab2.email))) return res.status(403).json({ error:"No autorizado" });
      if (t2.data().estado === "aprobado") return res.status(400).json({ error:"La tarea ya fue aprobada" });
      const prevDels2 = t2.data().deliverables || [];
      if (prevDels2.length === 0) return res.status(400).json({ error:"No hay entregas para editar" });
      const lastIdx2 = prevDels2.length - 1;
      const newDels2 = prevDels2.map((d,i) => i===lastIdx2 ? { ...d, ...(link!==undefined&&{link:link.trim()}), ...(label!==undefined&&{label:label.trim()}), ...(nota!==undefined&&{nota:nota.trim()}), editedAt:now } : d);
      const act2 = { tipo:"progreso", autor:colab2.nombre, fecha:now, detalle:`Editó entrega: ${newDels2[lastIdx2].label||`v${lastIdx2+1}`}` };
      await ref2.update({ deliverables:newDels2, updatedAt:now, activity:[...(t2.data().activity||[]), act2] });
      return res.json({ ok:true, deliverables:newDels2 });
    }

    // ── COLABORADOR PÚBLICO: eliminar su última entrega ────────────────────────
    if (action === "publicDeleteLastDeliverable") {
      const { tareaId } = body;
      if (!token || !tareaId) return res.status(400).json({ error:"Faltan parámetros" });
      const cSnap3 = await db.collection("colaboradores").where("token","==",token).limit(1).get();
      if (cSnap3.empty) return res.status(403).json({ error:"Token inválido" });
      const colab3 = cSnap3.docs[0].data();
      const ref3 = db.collection("tareas").doc(tareaId);
      const t3 = await ref3.get();
      if (!t3.exists) return res.status(404).json({ error:"Tarea no encontrada" });
      // Emails normalizados: una mayúscula o espacio de más no puede bloquear
      // a la dueña de la entrega.
      const nrmMail3 = (s) => String(s||"").trim().toLowerCase();
      const emails3 = (t3.data().asignadosEmails?.length ? t3.data().asignadosEmails : [t3.data().asignadoEmail]).filter(Boolean).map(nrmMail3);
      if (!emails3.includes(nrmMail3(colab3.email))) return res.status(403).json({ error:"No autorizado" });
      if (t3.data().estado === "aprobado") return res.status(400).json({ error:"La tarea ya fue aprobada. Pedile al equipo que revierta el estado." });
      const prevDels3 = t3.data().deliverables || [];
      if (prevDels3.length === 0) return res.status(400).json({ error:"No hay entregas para eliminar" });
      // index opcional: permite borrar CUALQUIER entrega (ej. un video subido
      // a la tarea equivocada que quedó abajo de otras). Default: la última.
      const idxRaw3 = Number(body.index);
      const idx3 = Number.isInteger(idxRaw3) && idxRaw3 >= 0 && idxRaw3 < prevDels3.length ? idxRaw3 : prevDels3.length - 1;
      const deleted3 = prevDels3[idx3];
      const newDels3 = prevDels3.filter((_, i) => i !== idx3);
      const upd3 = { deliverables:newDels3, updatedAt:now };
      const act3 = { tipo:"progreso", autor:colab3.nombre, fecha:now, detalle:`Eliminó entrega: ${deleted3.label||`v${idx3+1}`}` };
      upd3.activity = [...(t3.data().activity||[]), act3];
      if (["entregado","revision"].includes(t3.data().estado)) {
        upd3.estado = newDels3.some(d => !d.parcial) ? "entregado" : "en_proceso";
        upd3.feedbackActual = null;
        upd3.progresoLabel = "";
      }
      await ref3.update(upd3);
      return res.json({ ok:true, deliverables:newDels3, estado:upd3.estado||t3.data().estado });
    }

    // ── getColabByToken: acción pública para portal unificado ─────────────────
    if (action === "getColabByToken") {
      const { token: colabToken } = body;
      if (!colabToken) return res.status(400).json({ error:"Token requerido" });
      const snap = await db.collection("colaboradores").where("token","==",colabToken).limit(1).get();
      if (snap.empty) return res.status(404).json({ error:"Token inválido" });
      const colab = snap.docs[0].data();
      return res.json({ email:colab.email, nombre:colab.nombre, token:colabToken, uid:colab.uid, permisos:colab.permisos||{}, rol:colab.rol||"" });
    }

    // Referencias compartidas para el portal del colaborador (público, vía token)
    if (action === "getGeneralByToken") {
      if (!token) return res.status(400).json({ error:"Token requerido" });
      const colSnap = await db.collection("colaboradores").where("token","==",token).limit(1).get();
      if (colSnap.empty) return res.status(404).json({ error:"Token inválido" });
      const colabUid = colSnap.docs[0].data().uid;
      const gSnap = await db.collection("general").doc(colabUid).get();
      if (!gSnap.exists) return res.json({ posts:[], referencias:[], materiales:[] });
      const gd = gSnap.data();
      return res.json({ posts:gd.posts||[], referencias:gd.referencias||[], materiales:gd.materiales||[] });
    }

    // ── workspace: ¿este login es miembro del espacio de otra cuenta? ─────
    // Se autentica SOLO por token (todavía no hay uid destino). También hace
    // el "claim": al primer login del invitado, la invitación por email se
    // convierte en membresía real (teamMembers + teamUids del dueño).
    if (action === "workspace") {
      const authUser = await verifyAuth(req);
      if (!authUser) return res.status(401).json({ error: "Sesión inválida" });
      // Contexto del dueño que el modo miembro necesita para las puertas del
      // front (plan/trial y tiendas conectadas): el miembro NO puede leer el
      // doc del dueño con el SDK cliente (reglas), así que viaja por acá.
      const ownerCtx = (d) => {
        const iso = (v) => { try { const x = v?.toDate ? v.toDate() : (v instanceof Date ? v : null); return x ? x.toISOString() : null; } catch (_) { return null; } };
        // Dueño admin de Growith: sus miembros nunca chocan con paywall/trial
        // (el doc del admin puede tener plan "free" con trial viejo).
        const esAdmin = d.isAdmin === true || d.uid === "WJH3ArqDPQcNLha9lOinvkVi9uJ2";
        if (esAdmin) return { plan: "full", planExpiry: null, trialEnd: null, stores: {
          tn: !!(d.stores || []).find(s => s.type === "tiendanube"),
          shopify: !!(d.stores || []).find(s => s.type === "shopify"),
          ml: !!(d.stores || []).find(s => s.type === "mercadolibre" || s.type === "meli"),
          meta: (d.metaAccounts || []).length > 0,
        } };
        return {
          plan: d.plan || "free", planExpiry: iso(d.planExpiry), trialEnd: iso(d.trialEnd),
          stores: {
            tn: !!(d.stores || []).find(s => s.type === "tiendanube"),
            shopify: !!(d.stores || []).find(s => s.type === "shopify"),
            ml: !!(d.stores || []).find(s => s.type === "mercadolibre" || s.type === "meli"),
            meta: (d.metaAccounts || []).length > 0,
          },
        };
      };
      const myUid = authUser.uid;
      const myEmail = String(authUser.email || "").toLowerCase().trim();
      let q = await db.collection("users").where("teamUids", "array-contains", myUid).limit(1).get();
      if (!q.empty) {
        const d = q.docs[0].data() || {};
        const m = (d.teamMembers || {})[myUid];
        return res.json({ ok: true, ownerId: q.docs[0].id, secciones: m ? (m.secciones || {}) : null, ownerNombre: d.nombre || d.email || "", miembroNombre: m?.nombre || "", ownerCtx: ownerCtx(d) });
      }
      if (myEmail) {
        q = await db.collection("users").where("teamInviteEmails", "array-contains", myEmail).limit(1).get();
        if (!q.empty) {
          const ref = q.docs[0].ref;
          const out = await db.runTransaction(async tx => {
            const s = await tx.get(ref); const d = s.data() || {};
            const invites = Array.isArray(d.teamInvites) ? d.teamInvites : [];
            const inv = invites.find(i => String(i.email || "").toLowerCase() === myEmail);
            if (!inv) return null;
            tx.update(ref, {
              teamMembers: { ...(d.teamMembers || {}), [myUid]: { email: myEmail, nombre: inv.nombre || "", secciones: inv.secciones || {}, desde: Date.now() } },
              teamUids: FieldValue.arrayUnion(myUid),
              teamInvites: invites.filter(i => String(i.email || "").toLowerCase() !== myEmail),
              teamInviteEmails: FieldValue.arrayRemove(myEmail),
            });
            return { ownerId: ref.id, secciones: inv.secciones || {}, ownerNombre: d.nombre || d.email || "", miembroNombre: inv.nombre || "", ownerCtx: ownerCtx(d) };
          });
          if (out) { clearTeamCache(out.ownerId); return res.json({ ok: true, ...out }); }
        }
      }
      return res.json({ ok: true, ownerId: null });
    }

    // ── ACCIONES AUTENTICADAS (uid + token de Firebase atado a ese uid) ───────
    // Antes alcanzaba con mandar cualquier uid por el body: se podían leer y
    // escribir tareas, colaboradores y tokens de portal de cualquier cuenta.
    if (!uid) return res.status(403).json({ error: "No autorizado" });

    // Identidad alternativa: token de portal de colaborador. El portal no tiene
    // sesión de Firebase (se entra por link), así que el token del colaborador
    // vale como credencial — pero SOLO sobre la cuenta dueña de ese token y con
    // el alcance de sus permisos. Sin esto, el blindaje por token de Firebase
    // dejó a todo el portal recibiendo "Sesión inválida".
    let colabAuth = null;
    if (body.colabToken) {
      const cs = await db.collection("colaboradores").where("token", "==", String(body.colabToken)).limit(1).get();
      const c = cs.empty ? null : cs.docs[0].data();
      if (!c || c.uid !== uid) return res.status(403).json({ error: "No autorizado" });
      colabAuth = { permisos: c.permisos || {}, email: (c.email || "").toLowerCase(), nombre: c.nombre || "" };
      const esCM = !!colabAuth.permisos.verTareas;
      // CM (verTareas) gestiona tareas; el resto solo lee lo suyo. Nada de
      // acciones de equipo/tokens/emails de aviso por esta vía.
      const ACCIONES_CM = ["getData","getProduccion","createTarea","updateTarea","updateEstado","quickUpdateTareaEstado","revertEstado","duplicateTarea","deleteTarea","addComment","addSlotEntrega","updateDeliverable","deleteDeliverable","sendRecordatorio","logUsage"];
      const ACCIONES_LECTURA = ["getData","getProduccion","logUsage"];
      if (!(esCM ? ACCIONES_CM : ACCIONES_LECTURA).includes(action))
        return res.status(403).json({ error: "Tu permiso no alcanza para esta acción." });
    } else {
      // Miembros con permisos por sección: casi todo tareas.js es la sección
      // "tareas"; scheduleCanjeEmail nace de Canjes.
      const _seccion = action === "scheduleCanjeEmail" ? "canjes" : "tareas";
      const _g = await guardUid(req, res, uid, _seccion);
      if (!_g) return;
      var authViaTeam = !!_g.viaTeam;
      var authMember = _g.member || null;      // miembro con cuenta (nombre/email)
      var authEmail = (_g.user && _g.user.email) ? String(_g.user.email).toLowerCase() : "";
    }
    // Quién está operando, para atribuir acciones (ej: quién creó una tarea).
    const quienOpera = colabAuth
      ? { nombre: colabAuth.nombre || "", email: colabAuth.email || "", tipo: "colaborador" }
      : { nombre: (typeof authMember !== "undefined" && authMember && authMember.nombre) || "", email: (typeof authEmail !== "undefined" && authEmail) || "", tipo: (typeof authViaTeam !== "undefined" && authViaTeam) ? "miembro" : "dueño" };

    // ── Miembros con cuenta (permisos por sección) — SOLO el dueño ────────
    if (["miembrosListar", "miembroInvitar", "miembroActualizar", "miembroQuitar"].includes(action)) {
      if (typeof authViaTeam !== "undefined" && authViaTeam) return res.status(403).json({ error: "Solo el dueño de la cuenta administra los miembros." });
      if (colabAuth) return res.status(403).json({ error: "No autorizado" });
      const uRef = db.collection("users").doc(uid);
      if (action === "miembrosListar") {
        const s = await uRef.get(); const d = s.data() || {};
        const miembros = Object.entries(d.teamMembers || {}).map(([mu, m]) => ({ uid: mu, email: m.email || "", nombre: m.nombre || "", secciones: m.secciones || {} }));
        return res.json({ ok: true, miembros, invitaciones: (Array.isArray(d.teamInvites) ? d.teamInvites : []).map(i => ({ email: i.email, nombre: i.nombre || "", secciones: i.secciones || {} })) });
      }
      if (action === "miembroInvitar") {
        const email = String(body.email || "").toLowerCase().trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Email inválido" });
        const secciones = (body.secciones && typeof body.secciones === "object") ? body.secciones : {};
        const nombre = String(body.nombre || "").slice(0, 60);
        let ownerNombre = "";
        await db.runTransaction(async tx => {
          const s = await tx.get(uRef); const d = s.data() || {};
          ownerNombre = d.nombre || d.displayName || "";
          const yaMiembro = Object.values(d.teamMembers || {}).some(m => String(m.email || "").toLowerCase() === email);
          if (yaMiembro) throw new Error("Ese email ya es miembro.");
          const invites = (Array.isArray(d.teamInvites) ? d.teamInvites : []).filter(i => String(i.email || "").toLowerCase() !== email);
          invites.push({ email, nombre, secciones, ts: Date.now() });
          tx.set(uRef, { teamInvites: invites, teamInviteEmails: FieldValue.arrayUnion(email) }, { merge: true });
        }).catch(e => { throw e; });
        // Mail con botón para que la persona cree su cuenta con este mismo
        // email y no se equivoque de dirección. Si Resend falla, la invitación
        // igual queda activa (el claim es por email al primer login).
        const mailRes = await sendEmail({
          to: email,
          subject: `${ownerNombre ? ownerNombre + " te invitó" : "Te invitaron"} a Growith`,
          html: emailInvitacionMiembro({ nombre, ownerNombre, secciones, link: "https://www.growithapp.com" }),
        });
        return res.json({ ok: true, email, mail: mailRes && mailRes.ok ? "enviado" : "no_enviado" });
      }
      if (action === "miembroActualizar") {
        const memberUid = String(body.memberUid || "").trim();
        const secciones = (body.secciones && typeof body.secciones === "object") ? body.secciones : {};
        await db.runTransaction(async tx => {
          const s = await tx.get(uRef); const d = s.data() || {};
          const members = { ...(d.teamMembers || {}) };
          if (!members[memberUid]) throw new Error("Miembro no encontrado.");
          members[memberUid] = { ...members[memberUid], secciones };
          tx.update(uRef, { teamMembers: members });
        });
        clearTeamCache(uid);
        return res.json({ ok: true });
      }
      if (action === "miembroQuitar") {
        const memberUid = String(body.memberUid || "").trim();
        const email = String(body.email || "").toLowerCase().trim();
        await db.runTransaction(async tx => {
          const s = await tx.get(uRef); const d = s.data() || {};
          const members = { ...(d.teamMembers || {}) };
          if (memberUid) delete members[memberUid];
          const upd = { teamMembers: members };
          if (memberUid) upd.teamUids = FieldValue.arrayRemove(memberUid);
          if (email) {
            upd.teamInvites = (Array.isArray(d.teamInvites) ? d.teamInvites : []).filter(i => String(i.email || "").toLowerCase() !== email);
            upd.teamInviteEmails = FieldValue.arrayRemove(email);
          }
          tx.update(uRef, upd);
        });
        clearTeamCache(uid);
        return res.json({ ok: true });
      }
    }

    // Pertenencia por documento: las acciones que operan por id (tareaId /
    // colabId) tocaban cualquier documento con solo conocer el id, incluso de
    // otra cuenta. Se valida una sola vez acá para cubrir todas las ramas.
    // (Las acciones public*/board* devuelven antes de este punto: se validan
    // por su propio token.)
    if (body.tareaId) {
      const s = await db.collection("tareas").doc(String(body.tareaId)).get();
      if (!s.exists || s.data().uid !== uid) return res.status(403).json({ error: "No autorizado" });
    }
    const _colabId = body.colabId;
    if (_colabId) {
      const s = await db.collection("colaboradores").doc(String(_colabId)).get();
      if (!s.exists || s.data().uid !== uid) return res.status(403).json({ error: "No autorizado" });
    }

    // Comprobante de pago del cliente — vía backend con Admin SDK: las reglas
    // de Firestore no dejan a un usuario común escribir en `pagos` desde el
    // navegador (error "Missing or insufficient permissions" al suscribirse).
    if (action === "crearPago") {
      if (typeof authViaTeam !== "undefined" && authViaTeam) return res.status(403).json({ error: "Solo el dueño de la cuenta puede gestionar pagos." });
      const { plan, method, currency = "", amount, txHash = "", transferRef = "", nota = "", meses = 1, periodo = "mensual", email = "" } = body;
      if (!["facturador", "plus"].includes(plan)) return res.status(400).json({ error: "Plan inválido" });
      if (!Number(amount) || Number(amount) <= 0) return res.status(400).json({ error: "Monto inválido" });
      const metodo = method === "cripto" ? "cripto" : "transfer";
      if (metodo === "cripto" && !String(txHash).trim()) return res.status(400).json({ error: "Falta el hash de transacción (TxID)" });
      // Comprobante en imagen (captura/foto): validado y con tope de tamaño
      // (Firestore admite 1MB por doc; el front ya comprime a JPEG).
      let comprobanteB64 = String(body.comprobanteB64 || "");
      if (comprobanteB64 && (!/^data:image\/(jpeg|jpg|png|webp);base64,/.test(comprobanteB64) || comprobanteB64.length > 900000)) {
        return res.status(400).json({ error: "El comprobante debe ser una imagen (jpg/png) de menos de ~650KB — probá con una captura de pantalla" });
      }
      if (metodo === "transfer" && !comprobanteB64 && !String(transferRef).trim()) return res.status(400).json({ error: "Subí la captura del comprobante de la transferencia" });
      // Crédito de referidos aplicado a este pago: se valida contra el saldo
      // real y se descuenta recién cuando el pago se confirma.
      let refCreditAplicado = +(Number(body.refCreditAplicado) || 0).toFixed(2);
      if (refCreditAplicado > 0) {
        const uSnapCred = await db.collection("users").doc(uid).get();
        const credDisp = Number(uSnapCred.data()?.refCreditUsd) || 0;
        if (refCreditAplicado > credDisp + 0.01) return res.status(400).json({ error: "El crédito de referidos aplicado supera tu crédito disponible. Recargá la página." });
      } else refCreditAplicado = 0;
      const ref = await db.collection("pagos").add({
        refCreditAplicado,
        uid, email: String(email).slice(0, 120),
        plan, method: metodo,
        currency: String(currency).slice(0, 12),
        amount: Number(amount),
        txHash: String(txHash).trim().slice(0, 120),
        transferRef: String(transferRef).trim().slice(0, 120),
        // Transferencia en ARS: monto en pesos y dólar cripto mostrados al pagar
        arsMonto: Math.max(0, Number(body.arsMonto) || 0),
        dolarCripto: Math.max(0, Number(body.dolarCripto) || 0),
        nota: String(nota).slice(0, 500),
        meses: Math.min(12, Math.max(1, Number(meses) || 1)),
        periodo: periodo === "anual" ? "anual" : "mensual",
        estado: "pendiente",
        comprobanteB64,
        createdAt: now,
      });
      // Aviso inmediato al equipo: transferencias se confirman a mano, así que
      // el mail con el comprobante adjunto es lo que dispara la acción.
      if (metodo === "transfer") {
        try {
          const arsMonto = Math.max(0, Number(body.arsMonto) || 0);
          const dolarCripto = Math.max(0, Number(body.dolarCripto) || 0);
          await sendEmail({
            to: "contacto.growith@gmail.com",
            subject: `Transferencia por confirmar — ${email || uid} — ${plan === "facturador" ? "Facturador" : "Pro"}${periodo === "anual" ? " ANUAL" : ""}`,
            html: `<div style="font-family:Inter,system-ui,sans-serif;max-width:520px">
  <h2 style="font-size:18px">Nueva transferencia en pesos por confirmar</h2>
  <p style="font-size:14px;line-height:1.7">
    Cuenta: <strong>${String(email || uid).slice(0, 120)}</strong><br/>
    Plan: <strong>${plan === "facturador" ? "Facturador" : "Pro"}</strong> · ${periodo === "anual" ? "Anual (12 meses)" : "Mensual"}<br/>
    Monto esperado: <strong>${arsMonto ? `$${arsMonto.toLocaleString("es-AR")} ARS` : `USD ${Number(amount) || 0}`}</strong>${dolarCripto ? ` (dólar cripto $${Math.round(dolarCripto).toLocaleString("es-AR")})` : ""}<br/>
    ${String(transferRef).trim() ? `Referencia: <strong>${String(transferRef).trim().slice(0, 120)}</strong><br/>` : ""}
    ${String(nota).trim() ? `Nota: ${String(nota).trim().slice(0, 300)}<br/>` : ""}
  </p>
  ${comprobanteB64 ? `<p style="font-size:13px">El comprobante va adjunto en este mail.</p>` : ""}
  <p style="font-size:13px;color:#666">Confirmala desde Growith → Admin → Cobros (verificá que la plata haya entrado al CVU antes de confirmar).</p>
</div>`,
            attachments: comprobanteB64 ? [{ filename: "comprobante.jpg", content: comprobanteB64.split(",")[1] }] : undefined,
          });
        } catch (e) { console.error("[crearPago] aviso transferencia:", e.message); }
      }
      return res.json({ ok: true, id: ref.id });
    }

    // Registro de uso diario por usuario (contadores incrementales)
    if (action === "logUsage") {
      const { metric, n = 1, section = "envios" } = body;
      const ALLOWED = ["etiquetas", "skus", "seguimientos"];
      if (!ALLOWED.includes(metric)) return res.status(400).json({ error: "métrica inválida" });
      // Día calendario en hora Argentina (UTC-3)
      const day = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
      const inc = Math.max(1, Number(n) || 1);
      await db.collection("usage").doc(`${uid}_${day}`).set({
        uid, date: day, section,
        [metric]: FieldValue.increment(inc),
        updatedAt: now,
      }, { merge: true });
      return res.json({ ok: true });
    }

    if (action === "getData") {
      const [cs, ts, userSnap] = await Promise.all([
        db.collection("colaboradores").where("uid","==",uid).get(),
        db.collection("tareas").where("uid","==",uid).get(),
        db.collection("users").doc(uid).get(),
      ]);
      const todasTareas = ts.docs.map(d=>({_id:d.id,...d.data()})).sort((a,b)=>(b.createdAt?._seconds||0)-(a.createdAt?._seconds||0));
      // Vista de colaborador: sin tokens de portal ajenos, sin boardToken, sin
      // emails de aviso. Un no-CM recibe solo sus tareas; con verEquipo se suma
      // un resumen de solo lectura del estado de todos.
      if (colabAuth) {
        const esCM = !!colabAuth.permisos.verTareas;
        const colabsSinToken = cs.docs.map(d=>{ const { token:_t, ...rest } = d.data(); return { _id:d.id, ...rest }; })
          .sort((a,b)=>(a.nombre||"").localeCompare(b.nombre||"","es"));
        const tareasScoped = esCM ? todasTareas
          : todasTareas.filter(t => (t.asignadosEmails || [t.asignadoEmail]).map(e=>(e||"").toLowerCase()).includes(colabAuth.email));
        let equipoTareas = null;
        if (colabAuth.permisos.verEquipo) {
          const nombrePor = {}; colabsSinToken.forEach(c => { nombrePor[(c.email||"").toLowerCase()] = c.nombre || c.email; });
          const porColab = {};
          todasTareas.forEach(t => {
            const email = (t.asignadoEmail || "sin-asignar").toLowerCase();
            if (!porColab[email]) porColab[email] = { nombre: nombrePor[email] || t.asignadoNombre || email, email, tareas: [] };
            porColab[email].tareas.push({ _id:t._id, titulo:t.titulo, estado:t.estado, prioridad:t.prioridad||null, deadline:t.deadline||null, correcciones:t.correcciones||0 });
          });
          equipoTareas = Object.values(porColab).sort((a,b)=>a.nombre.localeCompare(b.nombre,"es"));
        }
        return res.json({ colaboradores: colabsSinToken, tareas: tareasScoped, equipoTareas, boardToken: null, notifEmails: [] });
      }
      return res.json({
        colaboradores: cs.docs.map(d=>({_id:d.id,...d.data()})).sort((a,b)=>a.nombre.localeCompare(b.nombre,"es")),
        tareas:        todasTareas,
        boardToken:    userSnap.exists ? (userSnap.data().boardToken || null) : null,
        notifEmails:   userSnap.exists ? (userSnap.data().notifEmails || []) : [],
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
      const colabDoc = await db.collection("colaboradores").doc(colabId).get();
      if (!colabDoc.exists || colabDoc.data().uid !== uid) return res.status(403).json({ error:"No autorizado" });
      const upd = { updatedAt:now };
      if (nombre!==undefined) upd.nombre = nombre;
      if (rol!==undefined) upd.rol = rol;
      if (telefono!==undefined) upd.telefono = telefono;
      if (email!==undefined) upd.email = email.toLowerCase().trim();
      // Si cambia el email, migrar TODO el historial al email nuevo: tareas con
      // asignada única, tareas con varias asignadas y el rol de manager.
      if (email!==undefined) {
        const oldEmail = colabDoc.data()?.email;
        const newEmail = email.toLowerCase().trim();
        if (oldEmail && oldEmail !== newEmail) {
          const [porAsignado, porLista, porManager] = await Promise.all([
            db.collection("tareas").where("uid","==",uid).where("asignadoEmail","==",oldEmail).get(),
            db.collection("tareas").where("uid","==",uid).where("asignadosEmails","array-contains",oldEmail).get(),
            db.collection("tareas").where("uid","==",uid).where("managerEmail","==",oldEmail).get(),
          ]);
          const cambios = new Map();
          porAsignado.docs.forEach(d => cambios.set(d.id, { ref:d.ref, upd:{ asignadoEmail:newEmail } }));
          porLista.docs.forEach(d => {
            const prev = cambios.get(d.id) || { ref:d.ref, upd:{} };
            prev.upd.asignadosEmails = (d.data().asignadosEmails||[]).map(e => (e||"").toLowerCase()===oldEmail ? newEmail : e);
            cambios.set(d.id, prev);
          });
          porManager.docs.forEach(d => {
            const prev = cambios.get(d.id) || { ref:d.ref, upd:{} };
            prev.upd.managerEmail = newEmail;
            cambios.set(d.id, prev);
          });
          // Firestore admite 500 ops por batch; de a 400 por las dudas.
          const entries = [...cambios.values()];
          for (let i = 0; i < entries.length; i += 400) {
            const batch = db.batch();
            entries.slice(i, i+400).forEach(c => batch.update(c.ref, { ...c.upd, updatedAt: now }));
            await batch.commit();
          }
        }
      }
      await db.collection("colaboradores").doc(colabId).update(upd);
      return res.json({ ok:true });
    }

    if (action === "regenerateToken") {
      const { colabId } = body;
      // Cross-tenant guard: el colaborador tiene que ser de ESTE tenant, si no
      // cualquiera podía rotar (y recibir) el token de portal de un colaborador
      // ajeno → toma de control del portal de otra cuenta.
      const colabDoc = await db.collection("colaboradores").doc(colabId).get();
      if (!colabDoc.exists || colabDoc.data().uid !== uid) return res.status(403).json({ error:"No autorizado" });
      const tok = randomToken(24);
      await db.collection("colaboradores").doc(colabId).update({ token:tok });
      return res.json({ ok:true, token:tok });
    }

    if (action === "deleteColaborador") {
      const colabDoc = await db.collection("colaboradores").doc(body.colabId).get();
      if (!colabDoc.exists || colabDoc.data().uid !== uid) return res.status(403).json({ error:"No autorizado" });
      await db.collection("colaboradores").doc(body.colabId).delete();
      return res.json({ ok:true });
    }

    if (action === "saveNotifEmails") {
      const { emails } = body;
      if (!Array.isArray(emails)) return res.status(400).json({ error:"emails debe ser array" });
      const clean = [...new Set(emails.map(e=>e.toLowerCase().trim()).filter(e=>e.includes("@")))];
      await db.collection("users").doc(uid).set({ notifEmails: clean }, { merge: true });
      return res.json({ ok:true, notifEmails: clean });
    }

    if (action === "createTarea") {
      const { titulo, descripcion="", asignadoEmail, asignadoNombre="", brief="", links=[], deadline, prioridad="normal", checklist=[], managerEmail="", asignadosEmails: asignadosEmailsRaw, esCampaña=false, slots=[] } = body;
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
        esCampaña: !!esCampaña,
        slots: Array.isArray(slots) ? slots : [],
        creadoPor: quienOpera,
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
          // Fallback acotado a ESTA cuenta. Sin el filtro por uid, un mismo email
          // (un freelancer que trabaja para varias marcas) resolvía al
          // colaborador de otro tenant y le mandaba la tarea y su link de portal.
          const byEmail = await db.collection("colaboradores")
            .where("uid","==",uid).where("email","==",email.toLowerCase()).limit(1).get();
          if (!byEmail.empty) { colab = byEmail.docs[0].data(); console.log(`[email] colab found by email-only: ${email}`); }
        }
        if (!colab) { console.warn(`[email] colaborador no encontrado para: ${email}`); emailResults.push({email,ok:false,error:"colab_not_found"}); continue; }
        const result = await sendEmail({
          to: email,
          subject: `Nueva tarea: ${titulo}`,
          html: emailTareaAsignada({ colab, tarea:{...data,deadline:deadline?new Date(deadline):null}, link:colabPortalLink(origin, colab.token) }),
        });
        console.log(`[email] resultado para ${email}:`, JSON.stringify(result));
        emailResults.push({email, ...result});
      }
      return res.json({ _id:ref.id, ...data, _emailResults:emailResults });
    }

    if (action === "addSlotEntrega") {
      const { tareaId, slotId, link, nota="", esFinal=true } = body;
      if (!tareaId||!slotId||!link) return res.status(400).json({ error:"Faltan parámetros" });
      const ref = db.collection("tareas").doc(tareaId);
      const snap = await ref.get();
      if (!snap.exists || snap.data().uid !== uid) return res.status(403).json({ error:"No autorizado" });
      const prevDels = snap.data().deliverables || [];
      const version = prevDels.filter(d=>d.slotId===slotId).length + 1;
      const entrega = { link, nota, label:`v${version}`, version, fecha:now, slotId, parcial:!esFinal };
      const act = { tipo:"entrega", autor:"colaborador", fecha:now, detalle:`Entregó slot ${slotId} v${version}` };
      const upd = { deliverables:[...prevDels,entrega], updatedAt:now, activity:[...(snap.data().activity||[]),act] };
      const slots = snap.data().slots || [];
      const allDone = slots.length>0 && slots.every(s => [...prevDels,entrega].some(d=>d.slotId===s.id&&!d.parcial));
      if (allDone) upd.estado = "entregado";
      await ref.update(upd);
      notifyManagers(db, uid, snap.data().managerEmail,
        `Nueva entrega en slot — ${snap.data().titulo}`,
        emailEntregaRecibida({ colab:{nombre:"Colaborador"}, tarea:snap.data(), entrega, link:`${origin||"https://growithapp.com"}/#/tareas` }));
      return res.json({ ok:true, entrega });
    }

    if (action === "updateTarea") {
      const { tareaId, titulo, descripcion, brief, links, deadline, estado, asignadoEmail, asignadoNombre, prioridad, checklist, asignadosEmails } = body;
      const ref = db.collection("tareas").doc(tareaId);
      const prevSnap = await ref.get();
      // Cross-tenant guard: la tarea tiene que ser de ESTE tenant (tareas es una
      // colección top-level → cualquier id ajeno resolvería sin este chequeo).
      if (!prevSnap.exists || prevSnap.data().uid !== uid) return res.status(403).json({ error:"No autorizado" });
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
        // Cancelar email de actualización anterior si todavía no se envió
        const prevUpdateEmailId = prevData.pendingUpdateEmailId;
        if (prevUpdateEmailId) cancelEmail(prevUpdateEmailId);
        const recipientEmails = (clean.asignadosEmails || prevData.asignadosEmails || [clean.asignadoEmail || prevData.asignadoEmail]).filter(Boolean);
        // Solo notificamos al primero para no duplicar (todos ven la misma tarea)
        const emailDest = recipientEmails[0];
        if (emailDest) {
          const colabSnap3 = await db.collection("colaboradores")
            .where("uid","==",uid).where("email","==",emailDest).limit(1).get();
          if (!colabSnap3.empty) {
            const c3 = colabSnap3.docs[0].data();
            const emailRes3 = await sendEmail({
              to: emailDest,
              subject: `Actualizaron tu tarea — ${clean.titulo || prevData.titulo}`,
              html: emailTareaActualizada({ colab:c3, tarea:{...prevData,...clean}, cambios, link:colabPortalLink(origin, c3.token) }),
              delayMs: 3 * 60 * 1000,
            });
            if (emailRes3.id) clean.pendingUpdateEmailId = emailRes3.id;
          }
        }
      }
      return res.json({ ok:true });
    }

    if (action === "updateEstado") {
      const { tareaId, estado, feedback } = body;
      const ref = db.collection("tareas").doc(tareaId);
      const snap = await ref.get();
      // Cross-tenant guard (tareas es top-level): la tarea tiene que ser de este tenant.
      if (!snap.exists || snap.data().uid !== uid) return res.status(403).json({ error:"No autorizado" });
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
            subject: `Se solicitaron cambios — ${snap.data().titulo}`,
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
              subject: `¡Aprobado! — ${snap.data().titulo}`,
              html: emailTareaAprobada({ colab:colabAp, tarea:snap.data(), link:colabPortalLink(origin, colabAp.token) }),
            });
          }
        }
      }
      await ref.update(upd);
      return res.json({ ok: true });
    }

    if (action === "deleteTarea") {
      if (!body.tareaId) return res.status(400).json({ error: "Falta tareaId" });
      const tRef = db.collection("tareas").doc(String(body.tareaId));
      const tSnap = await tRef.get();
      // Si el doc no existe, ya está borrado: ok idempotente (antes un id
      // inexistente "borraba" en silencio y el front creía que funcionó).
      if (!tSnap.exists) return res.json({ ok: true, yaNoExistia: true });
      if (tSnap.data().uid !== uid) return res.status(403).json({ error: "Esa tarea no es de esta cuenta" });
      await tRef.delete();
      return res.json({ ok: true });
    }

    if (action === "sendRecordatorio") {
      const { tareaId } = body;
      const tareaSnap = await db.collection("tareas").doc(tareaId).get();
      if (!tareaSnap.exists || tareaSnap.data().uid !== uid) return res.status(403).json({ error:"No autorizado" });
      const tarea = tareaSnap.data();
      const colabSnap = await db.collection("colaboradores")
        .where("uid","==",uid).where("email","==",tarea.asignadoEmail).limit(1).get();
      if (colabSnap.empty) return res.status(404).json({ error:"Colaborador no encontrado" });
      const colab = colabSnap.docs[0].data();
      const link = colabPortalLink(origin, colab.token);
      const html = `<div style="font-family:Inter,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="background:linear-gradient(135deg,#6366f1,#818cf8);padding:24px;border-radius:12px;text-align:center;margin-bottom:24px">
    <div style="font-size:20px;font-weight:700;color:#fff">Recordatorio de tarea</div>
  </div>
  <p style="font-size:15px;color:#374151">Hola <strong>${colab.nombre.split(" ")[0]}</strong>,</p>
  <p style="font-size:14px;color:#6b7280">Te mandamos este recordatorio sobre tu tarea pendiente:</p>
  <div style="background:#f0f0ff;border-radius:10px;padding:16px 20px;margin:16px 0;border-left:4px solid #6366f1">
    <div style="font-size:16px;font-weight:700;color:#1e1b4b">${tarea.titulo}</div>
    ${tarea.descripcion?`<div style="font-size:13px;color:#6b7280;margin-top:6px">${tarea.descripcion}</div>`:""}
    ${tarea.deadline?`<div style="font-size:13px;color:#d97706;margin-top:8px;font-weight:600">Fecha límite: ${new Date(tarea.deadline._seconds?tarea.deadline._seconds*1000:tarea.deadline).toLocaleDateString("es-AR",{day:"2-digit",month:"2-digit",year:"numeric"})}</div>`:""}
  </div>
  <a href="${link}" style="display:block;text-align:center;background:#6366f1;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;margin:20px 0">Ver mi tarea →</a>
  <p style="font-size:12px;color:#9ca3af;text-align:center">Growith — Sistema de gestión</p>
</div>`;
      const result = await sendEmail({ to: tarea.asignadoEmail, subject: `Recordatorio — ${tarea.titulo}`, html });
      if (result.error) return res.status(500).json({ error: result.error });
      return res.json({ ok: true });
    }

    // ── ADMIN: editar una entrega por índice ──────────────────────────────────
    if (action === "updateDeliverable") {
      const { tareaId, deliverableIndex, link, label, nota } = body;
      const ref = db.collection("tareas").doc(tareaId);
      const snap = await ref.get();
      if (!snap.exists || snap.data().uid !== uid) return res.status(403).json({ error:"No autorizado" });
      if (snap.data().estado === "aprobado") return res.status(400).json({ error:"No se puede editar una entrega aprobada" });
      const prevDels = snap.data().deliverables || [];
      const idx = Number(deliverableIndex);
      if (isNaN(idx) || idx < 0 || idx >= prevDels.length) return res.status(400).json({ error:"Índice inválido" });
      const newDels = prevDels.map((d,i) => i===idx ? { ...d, ...(link!==undefined&&{link:link.trim()}), ...(label!==undefined&&{label:label.trim()}), ...(nota!==undefined&&{nota:nota.trim()}), editedAt:now } : d);
      const act = { tipo:"admin", autor:"manager", fecha:now, detalle:`Entrega editada: ${newDels[idx].label||`v${idx+1}`}` };
      await ref.update({ deliverables:newDels, updatedAt:now, activity:[...(snap.data().activity||[]), act] });
      return res.json({ ok:true, deliverables:newDels });
    }


    // ── ADMIN: eliminar entrega por índice ─────────────────────────────────────
    if (action === "deleteDeliverable") {
      const { tareaId, deliverableIndex } = body;
      const ref = db.collection("tareas").doc(tareaId);
      const snap = await ref.get();
      if (!snap.exists || snap.data().uid !== uid) return res.status(403).json({ error:"No autorizado" });
      const prevDels = snap.data().deliverables || [];
      const idx = Number(deliverableIndex);
      if (isNaN(idx) || idx < 0 || idx >= prevDels.length) return res.status(400).json({ error:"Índice inválido" });
      const deleted = prevDels[idx];
      const newDels = prevDels.filter((_,i) => i !== idx);
      const wasLast = idx === prevDels.length - 1;
      const upd = { deliverables: newDels, updatedAt: now };
      const act = { tipo:"admin", autor:"manager", fecha:now, detalle:`Entrega eliminada: ${deleted.label||`v${idx+1}`}` };
      upd.activity = [...(snap.data().activity||[]), act];
      // Si era la última entrega y el estado era entregado/revision, revertir
      if (wasLast && ["entregado","revision","aprobado"].includes(snap.data().estado)) {
        upd.estado = newDels.length > 0 ? "entregado" : "en_proceso";
        upd.feedbackActual = null;
        upd.progresoLabel = "";
      }
      await ref.update(upd);
      return res.json({ ok:true, deliverables:newDels, estado:upd.estado||snap.data().estado });
    }

    // ── ADMIN: revertir estado al paso anterior ────────────────────────────────
    if (action === "revertEstado") {
      const { tareaId } = body;
      const ref = db.collection("tareas").doc(tareaId);
      const snap = await ref.get();
      if (!snap.exists || snap.data().uid !== uid) return res.status(403).json({ error:"No autorizado" });
      const cur = snap.data().estado;
      const prevMap = { aprobado:"entregado", revision:"en_proceso", entregado:"en_proceso", en_proceso:"pendiente", bloqueada:"en_proceso" };
      const newEstado = prevMap[cur];
      if (!newEstado) return res.status(400).json({ error:"No se puede revertir desde este estado" });
      const upd = { estado:newEstado, updatedAt:now, feedbackActual:null };
      if (!["entregado","aprobado"].includes(newEstado)) upd.progresoLabel = "";
      const act = { tipo:"admin", autor:"manager", fecha:now, detalle:`Estado revertido: ${cur} → ${newEstado}` };
      upd.activity = [...(snap.data().activity||[]), act];
      await ref.update(upd);
      return res.json({ ok:true, estado:newEstado });
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
        creadoPor: quienOpera,
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
          subject: `Nuevo comentario en "${tdata.titulo}"`,
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
          <div style="font-size:20px;font-weight:700;color:#fff">Email de prueba</div>
          <div style="font-size:13px;color:rgba(255,255,255,0.85);margin-top:6px">Growith — Sistema de Notificaciones</div>
        </div>
        <p style="font-size:15px;color:#374151">¡Todo funciona correctamente!</p>
        <p style="font-size:13px;color:#6b7280;line-height:1.6">Este email confirma que el sistema de notificaciones está configurado y funcionando. Los colaboradores van a recibir emails como este cuando se les asignen tareas, y vos vas a recibir notificaciones cuando entreguen trabajo.</p>
        <div style="margin:24px 0;padding:16px;background:#f0fdf4;border-radius:10px;border:1px solid #86efac">
          <div style="font-size:13px;font-weight:700;color:#16a34a;margin-bottom:8px">Emails activos en tu cuenta:</div>
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
      const result = await sendEmail({ to, subject:"Email de prueba — Growith funciona correctamente", html });
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
      const result = await sendEmail({ to, subject:`Recordatorio: ${titulo} — Growith`, html });
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
      // Cuenta nueva sin doc de producción: arranca VACÍA — antes venía con
      // editores de ejemplo hardcodeados que aparecían como miembros del equipo.
      if (!snap.exists) return res.json({ editores:[], tandas:[], creativos:[], ideas:[] });
      const d = snap.data();
      delete d.updatedAt;
      // Colaborador por token: los creativos solo con permiso, y los tokens de
      // los editores nunca viajan por esta vía.
      if (colabAuth) {
        if (!colabAuth.permisos.verCreativos && !colabAuth.permisos.verTareas)
          return res.json({ editores:[], tandas:[], creativos:[], ideas:[] });
        delete d.editorTokens;
      }
      return res.json(d);
    }

    if (action === "saveProduccion") {
      const { data: prodData } = body;
      if (!prodData || typeof prodData !== "object") return res.status(400).json({ error:"Data requerida" });
      await db.collection("produccion").doc(uid).set({ ...prodData, updatedAt: now });
      return res.json({ ok: true });
    }

    // ── TABLÓN + REFERENCIAS ──────────────────────────────────────────────────

    if (action === "getGeneral") {
      const snap = await db.collection("general").doc(uid).get();
      if (!snap.exists) return res.json({ posts: [], referencias: [], materiales: [] });
      const d = snap.data();
      return res.json({ posts: d.posts||[], referencias: d.referencias||[], materiales: d.materiales||[] });
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

    if (action === "saveReferencias") {
      const { referencias } = body;
      if (!Array.isArray(referencias)) return res.status(400).json({ error:"referencias debe ser un array" });
      const ref = db.collection("general").doc(uid);
      const snap = await ref.get();
      if (!snap.exists) {
        await ref.set({ posts:[], referencias });
      } else {
        await ref.update({ referencias });
      }
      return res.json({ ok:true });
    }

    if (action === "saveMateriales") {
      const { materiales } = body;
      if (!Array.isArray(materiales)) return res.status(400).json({ error:"materiales debe ser un array" });
      const ref = db.collection("general").doc(uid);
      const snap = await ref.get();
      if (!snap.exists) {
        await ref.set({ posts:[], referencias:[], materiales });
      } else {
        await ref.update({ materiales });
      }
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
    const adminActions = ["setSectionsConfig","adminGetData","adminGetUsage","activarPlan","desactivarPlan","confirmarPago","rechazarPago","addNote","extenderPlan","gestionarPlan","activarPrueba","ajustarDias","toggleAdmin","adminBuscarCuenta"];
    if (adminActions.includes(action)) {
      // La identidad del admin sale del TOKEN verificado, no del uid del body.
      // Antes bastaba con mandar el uid del dueño (que estaba publicado en el
      // bundle del front) para activarse el plan, hacerse admin o bajarse la
      // base entera de usuarios y pagos.
      const adm = await requireAdmin(req);
      if (!adm.ok) return res.status(adm.code).json({ error: adm.error });
      const adminNow = new Date();

      if (action === "setSectionsConfig") {
        const { adminOnlySections } = body;
        if (!Array.isArray(adminOnlySections)) return res.status(400).json({ error: "adminOnlySections debe ser un array" });
        await db.collection("config").doc(CONFIG_DOC).set({ adminOnlySections, updatedAt: adminNow, updatedBy: uid }, { merge: true });
        return res.json({ ok: true, adminOnlySections });
      }

      // Diagnóstico de "no me aparece en la lista": busca el email DIRECTO en
      // Firebase Auth. Si la cuenta existe pero no tiene doc en `users` (nunca
      // completó el primer login que lo crea), lo crea mínimo para que aparezca
      // en el listado y se le pueda gestionar el plan.
      if (action === "adminBuscarCuenta") {
        const email = String(body.email || "").trim().toLowerCase();
        if (!email || !email.includes("@")) return res.status(400).json({ error: "email requerido" });
        let au = null, authErr = "";
        try { au = await getAuth().getUserByEmail(email); }
        catch (e) { authErr = String(e.code || e.message || ""); }
        if (!au) {
          return res.json({ ok: true, encontrado: false, motivo: /not.?found/i.test(authErr) ? "No existe ninguna cuenta registrada con ese email (revisá mayúsculas/typos, o se registró con otro mail)." : `No se pudo consultar Firebase Auth: ${authErr}` });
        }
        const uRef = db.collection("users").doc(au.uid);
        const uSnap = await uRef.get();
        let creoDoc = false;
        if (!uSnap.exists) {
          const trialEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
          await uRef.set({ uid: au.uid, email: au.email || email, nombre: au.displayName || email.split("@")[0], createdAt: FieldValue.serverTimestamp(), plan: "free", trialEnd, stores: [] }, { merge: true });
          creoDoc = true;
        }
        return res.json({
          ok: true, encontrado: true, uid: au.uid,
          providers: (au.providerData || []).map(p => p.providerId),
          creado: au.metadata?.creationTime || null,
          ultimoLogin: au.metadata?.lastSignInTime || null,
          tieneDoc: uSnap.exists, creoDoc,
          plan: uSnap.exists ? (uSnap.data().plan || "free") : "free",
        });
      }

      if (action === "adminGetData") {
        // Topes: sin límite, con cientos de cuentas y miles de pagos esto se
        // vuelve una respuesta de varios MB que tarda y traba el navegador.
        // Los pagos van por fecha descendente, así que el corte deja afuera los
        // más viejos (los pendientes, que son los accionables, siempre entran).
        const [pagSnap, usSnap] = await Promise.all([
          db.collection("pagos").orderBy("createdAt", "desc").limit(1000).get(),
          db.collection("users").limit(2000).get(),
        ]);
        // El comprobante (imagen base64) NO viaja en el listado — inflaría la
        // respuesta varios MB. Se pide por pago con action=pagoComprobante.
        const pagos = pagSnap.docs.map(d => { const { comprobanteB64, ...rest } = d.data(); return { _id: d.id, ...rest, tieneComprobante: !!comprobanteB64 }; });
        const usuarios = usSnap.docs.map(d => ({ _id: d.id, ...d.data() }));
        // Fuente de verdad de "quién se registró" = Firebase Auth. Cuentas que se
        // crearon antes de que existiera el auto-doc (o que nunca dispararon su
        // creación) no tienen doc en `users` y no aparecían acá. Traemos todos los
        // usuarios de Auth y agregamos los que falten como registros mínimos, para
        // que el panel muestre TODAS las cuentas. Best-effort: si Auth falla, se
        // sigue con solo los docs de Firestore.
        try {
          const yaCargados = new Set(usuarios.map(u => u._id));
          const authUsers = [];
          let pageToken = undefined;
          for (let i = 0; i < 5; i++) { // hasta 5000 cuentas (1000 por página)
            const page = await getAuth().listUsers(1000, pageToken);
            authUsers.push(...page.users);
            if (!page.pageToken) break;
            pageToken = page.pageToken;
          }
          // El email de LOGIN real vive en Auth: si el doc quedó con un mail
          // viejo (cambio de email confirmado por link, fuera de la app), el
          // listado muestra el de Auth — es el que el cliente dice usar.
          const authByUid = new Map(authUsers.map(a => [a.uid, a]));
          for (const u of usuarios) {
            const au = authByUid.get(u._id);
            if (au?.email && String(u.email || "").toLowerCase() !== au.email.toLowerCase()) {
              if (u.email) u.emailDoc = u.email;
              u.email = au.email;
            }
          }
          for (const au of authUsers) {
            if (yaCargados.has(au.uid)) continue;
            usuarios.push({
              _id: au.uid,
              uid: au.uid,
              email: au.email || "",
              nombre: au.displayName || (au.email ? au.email.split("@")[0] : au.uid),
              plan: "free",
              createdAt: au.metadata?.creationTime ? { _seconds: Math.floor(new Date(au.metadata.creationTime).getTime() / 1000) } : null,
              _sinDoc: true, // no tiene doc en Firestore (nunca completó registro/onboarding)
            });
          }
        } catch (e) { console.warn("[admin] listUsers:", e.message); }
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
          usuariosFact: usuarios.filter(u => u.plan==="facturador" && !u.isTrial).length,
          usuariosFact_trial: usuarios.filter(u => u.plan==="facturador" && u.isTrial).length,
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

      if (action === "adminGetUsage") {
        const { targetUid, days = 30 } = body;
        if (!targetUid) return res.status(400).json({ error: "targetUid requerido" });
        const snap = await db.collection("usage").where("uid", "==", targetUid).get();
        const rows = snap.docs.map(d => d.data())
          .sort((a, b) => (a.date < b.date ? 1 : -1))
          .slice(0, Number(days) || 30);
        const totales = rows.reduce((acc, r) => ({
          etiquetas:    acc.etiquetas    + (r.etiquetas    || 0),
          skus:         acc.skus         + (r.skus         || 0),
          seguimientos: acc.seguimientos + (r.seguimientos || 0),
        }), { etiquetas: 0, skus: 0, seguimientos: 0 });
        return res.json({ usage: rows, totales });
      }

      // Helper transaccional: dos clicks del admin ya no suman meses dos veces
      // (lee planExpiry y escribe la extensión de forma atómica).
      const extenderTx = async (targetUid, updates, calcExpiry) => {
        const ref = db.collection("users").doc(targetUid);
        return db.runTransaction(async tx => {
          const snap = await tx.get(ref);
          const userData = snap.data() || {};
          let base = adminNow;
          if (userData.planExpiry) {
            const cur = userData.planExpiry?._seconds ? new Date(userData.planExpiry._seconds*1000) : userData.planExpiry?.toDate?.() || adminNow;
            if (cur > adminNow) base = cur;
          }
          const expiry = calcExpiry(base, userData);
          tx.update(ref, { ...updates, planExpiry: expiry });
          return expiry;
        });
      };

      if (action === "activarPlan") {
        const { targetUid, plan, meses = 1 } = body;
        const expiry = await extenderTx(targetUid, { plan, planActivadoBy: uid, planActivadoAt: adminNow }, base => addMonths(base, meses));
        return res.json({ ok: true, expiry });
      }

      if (action === "desactivarPlan") {
        const { targetUid } = body;
        await db.collection("users").doc(targetUid).update({ plan: "free", planExpiry: null, planDesactivadoBy: uid, planDesactivadoAt: adminNow });
        return res.json({ ok: true });
      }

      // Comprobante de un pago puntual (imagen base64) — fuera del listado
      // para no inflar adminGetData.
      if (action === "pagoComprobante") {
        const snap = await db.collection("pagos").doc(String(body.pagoId || "")).get();
        if (!snap.exists) return res.status(404).json({ error: "No se encontró el pago." });
        return res.json({ comprobanteB64: snap.data().comprobanteB64 || "" });
      }

      if (action === "confirmarPago") {
        const { pagoId, targetUid, plan, meses = 1 } = body;
        // Idempotente: dos clicks (o dos pestañas) sobre el mismo pago sumaban
        // los meses dos veces. La transacción marca el pago como confirmado y
        // falla si otro ya lo confirmó.
        const pagoRef = db.collection("pagos").doc(pagoId);
        let expiry, pagoData = null;
        try {
          expiry = await db.runTransaction(async tx => {
            const [pagoSnap, userSnap] = await Promise.all([tx.get(pagoRef), tx.get(db.collection("users").doc(targetUid))]);
            if (!pagoSnap.exists) throw new Error("PAGO_INEXISTENTE");
            if ((pagoSnap.data().estado || "") !== "pendiente") throw new Error("PAGO_YA_PROCESADO");
            pagoData = pagoSnap.data();
            const userData = userSnap.data() || {};
            let base = adminNow;
            if (userData.planExpiry) {
              const cur = userData.planExpiry?._seconds ? new Date(userData.planExpiry._seconds*1000) : userData.planExpiry?.toDate?.() || adminNow;
              if (cur > adminNow) base = cur;
            }
            const exp = addMonths(base, meses);
            tx.update(db.collection("users").doc(targetUid), { plan, planExpiry: exp, isTrial: false, cancelAtPeriodEnd: false, planActivadoBy: uid, planActivadoAt: adminNow });
            tx.update(pagoRef, { estado: "confirmado", mesesConfirmados: Number(meses), confirmadoBy: uid, confirmadoAt: adminNow });
            return exp;
          });
        } catch (e) {
          if (e.message === "PAGO_YA_PROCESADO") return res.status(409).json({ error: "Ese pago ya fue procesado." });
          if (e.message === "PAGO_INEXISTENTE") return res.status(404).json({ error: "No se encontró el pago." });
          throw e;
        }
        // Programa de referidos (best-effort, idempotente): descuenta el crédito
        // que el pagador aplicó y acredita el 15% a su referente.
        if (pagoData) {
          const pd = { ...pagoData, mesesConfirmados: Number(meses) };
          await descontarCreditoAplicado(db, pagoId, pd);
          await acreditarComisionReferido(db, pagoId, pd);
        }
        // Comprobante de activación al cliente (best-effort: si el mail falla,
        // el plan igual quedó activado).
        try {
          const uSnap = await db.collection("users").doc(targetUid).get();
          const email = (uSnap.data() || {}).email;
          if (email) {
            const hasta = expiry.toLocaleDateString("es-AR", { day: "2-digit", month: "long", year: "numeric" });
            const planNombre = plan === "facturador" ? "Facturador" : "Pro";
            await sendEmail({
              to: email,
              subject: `Tu plan ${planNombre} está activo`,
              html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6;color:#111">
                <p>¡Listo! Confirmamos tu pago y tu plan <strong>${planNombre}</strong> ya está activo.</p>
                <p>Tenés acceso hasta el <strong>${hasta}</strong>. Te vamos a avisar unos días antes del vencimiento.</p>
                <p>Gracias por usar Growith.</p>
              </div>`,
            });
          }
        } catch (e) { console.error("[confirmarPago] email:", e.message); }
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
        const expiry = await extenderTx(targetUid, { planExtendidoBy: uid, planExtendidoAt: adminNow }, base => addMonths(base, meses));
        return res.json({ ok: true, expiry });
      }

      if (action === "gestionarPlan") {
        const { targetUid, plan, cantidad, unidad = "meses", isTrial = false } = body;
        const expiry = await extenderTx(targetUid, { plan, isTrial: !!isTrial, planActivadoBy: uid, planActivadoAt: adminNow }, base => {
          if (unidad === "dias") { const d = new Date(base); d.setDate(d.getDate() + Number(cantidad)); return d; }
          return addMonths(base, Number(cantidad));
        });
        if (isTrial) {
          await db.collection("pagos").add({ uid: targetUid, plan, method: "prueba", currency: "—", amount: 0, isTrial: true, cantidad: Number(cantidad), unidad, estado: "confirmado", confirmadoBy: uid, confirmadoAt: adminNow, createdAt: adminNow, nota: `Prueba: ${cantidad} ${unidad} de ${plan}` });
        }
        return res.json({ ok: true, expiry });
      }

      if (action === "activarPrueba") {
        const { targetUid, plan, meses = 1 } = body;
        const expiry = await extenderTx(targetUid, { plan, isTrial: true, planActivadoBy: uid, planActivadoAt: adminNow }, base => addMonths(base, meses));
        await db.collection("pagos").add({ uid: targetUid, plan, method: "prueba", currency: "—", amount: 0, isTrial: true, mesesConfirmados: Number(meses), estado: "confirmado", confirmadoBy: uid, confirmadoAt: adminNow, createdAt: adminNow, nota: `Plan de prueba (${meses}m) activado por admin` });
        return res.json({ ok: true, expiry });
      }

      if (action === "ajustarDias") {
        const { targetUid, dias } = body;
        if (!targetUid || dias === undefined) return res.status(400).json({ error: "Faltan parámetros" });
        // Ajuste sobre el vencimiento ACTUAL (aunque esté en el pasado), atómico
        const ref = db.collection("users").doc(targetUid);
        const expiry = await db.runTransaction(async tx => {
          const snap = await tx.get(ref);
          const userData = snap.data() || {};
          const base = userData.planExpiry?._seconds ? new Date(userData.planExpiry._seconds*1000) : userData.planExpiry?.toDate?.() || adminNow;
          const d = new Date(base); d.setDate(d.getDate() + Number(dias));
          tx.update(ref, { planExpiry: d, planAjustadoBy: uid, planAjustadoAt: adminNow, planAjusteDias: Number(dias) });
          return d;
        });
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

    // ── Programar email recordatorio de canje ─────────────────────────────────
    if (action === "scheduleCanjeEmail") {
      const { influencer, producto, tracking, fechaEnvioProgr, delayMs } = body;
      if (!uid || !influencer || !fechaEnvioProgr) return res.status(400).json({ error:"Faltan parámetros" });
      // Buscar el email del owner para notificarle
      const userSnap = await db.collection("users").doc(uid).get();
      const ownerEmail = userSnap.data()?.email;
      if (!ownerEmail) return res.status(400).json({ error:"No se encontró email del usuario" });
      const fechaFmt = new Date(fechaEnvioProgr + "T12:00:00").toLocaleDateString("es-AR", {weekday:"long",day:"numeric",month:"long"});
      const trackingHtml = tracking ? `<div style="margin:12px 0;padding:10px 14px;background:#f0fdf4;border-radius:8px;border-left:3px solid #22c55e;font-size:13px;color:#374151">Tracking Andreani: <strong>${tracking}</strong><br/><a href="https://www.andreani.com/envio/${tracking}" style="color:#6366f1;font-size:12px">Ver seguimiento →</a></div>` : "";
      const html = `<div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="background:linear-gradient(135deg,#6366f1,#a78bfa);padding:22px;border-radius:12px;text-align:center;margin-bottom:22px">
    <div style="font-size:18px;font-weight:700;color:#fff">Hoy toca enviar un canje</div>
    <div style="font-size:13px;color:rgba(255,255,255,0.85);margin-top:4px">${fechaFmt}</div>
  </div>
  <p style="font-size:14px;color:#374151">Acordate de enviar el canje de <strong>${influencer}</strong>${producto?` — <strong>${producto}</strong>`:""} hoy.</p>
  ${trackingHtml}
  <div style="background:#f9fafb;border-radius:8px;padding:14px 16px;font-size:13px;color:#374151;line-height:1.6;margin:16px 0">
    <strong>No te olvides de:</strong><br/>
    • Mandarle el número de tracking por WhatsApp<br/>
    • Recordarle los acuerdos de contenido<br/>
    • Si es envío a sucursal HOP, avisarle que ya puede ir a buscarlo
  </div>
  <p style="font-size:12px;color:#9ca3af;text-align:center">Growith — Gestión de canjes</p>
</div>`;
      const result = await sendEmail({
        to: ownerEmail,
        subject: `Hoy toca enviar el canje de ${influencer}`,
        html,
        delayMs: delayMs && Number(delayMs) > 60000 ? Number(delayMs) : undefined,
      });
      return res.json({ ok: true, emailId: result.id });
    }

    // ── TABLERO COMPARTIDO ──────────────────────────────────────────────────

    if (action === "generateBoardToken") {
      const userRef = db.collection("users").doc(uid);
      const userSnap = await userRef.get();
      if (!userSnap.exists) return res.status(404).json({ error:"Usuario no encontrado" });
      const existing = userSnap.data().boardToken;
      if (existing) return res.json({ token: existing });
      const token = randomToken(32);
      await userRef.update({ boardToken: token });
      return res.json({ token });
    }

    if (action === "getBoardData") {
      const { boardToken } = body;
      if (!boardToken) return res.status(400).json({ error:"boardToken requerido" });
      const usersSnap = await db.collection("users").where("boardToken","==",boardToken).limit(1).get();
      if (usersSnap.empty) return res.status(404).json({ error:"Tablero no encontrado" });
      const boardUid = usersSnap.docs[0].id;
      const userData = usersSnap.docs[0].data();
      const [tareasSnap, colabsSnap, generalSnap] = await Promise.all([
        db.collection("tareas").where("uid","==",boardUid).get(),
        db.collection("colaboradores").where("uid","==",boardUid).get(),
        db.collection("general").doc(boardUid).get(),
      ]);
      const tareas = tareasSnap.docs.map(d => ({ _id:d.id, ...d.data() }))
        .sort((a,b) => (b.createdAt?._seconds||0) - (a.createdAt?._seconds||0));
      const colaboradores = colabsSnap.docs.map(d => ({ _id:d.id, ...d.data() }))
        .sort((a,b) => a.nombre.localeCompare(b.nombre,"es"));
      const general = generalSnap.exists ? generalSnap.data() : { posts:[], referencias:[] };
      return res.json({
        workspace: { nombre: userData.nombre || userData.displayName || "Equipo" },
        tareas,
        // Sin `token`: el tablero compartido es un link para pasarle a cualquiera,
        // y devolvía el token de portal PERSONAL de cada colaborador (con el que
        // se puede operar como esa persona). Se manda solo lo que el board pinta.
        colaboradores: colaboradores.map(c=>({ _id:c._id, nombre:c.nombre, email:c.email, rol:c.rol||"" })),
        posts: general.posts || [],
        referencias: general.referencias || [],
        materiales: general.materiales || [],
      });
    }

    if (action === "boardAddComment") {
      const { boardToken, colabEmail, tareaId, texto } = body;
      if (!boardToken || !colabEmail || !tareaId || !texto?.trim()) return res.status(400).json({ error:"Faltan parámetros" });
      const usersSnap = await db.collection("users").where("boardToken","==",boardToken).limit(1).get();
      if (usersSnap.empty) return res.status(404).json({ error:"Tablero no encontrado" });
      const boardUid = usersSnap.docs[0].id;
      const colabSnap = await db.collection("colaboradores").where("uid","==",boardUid).where("email","==",colabEmail).limit(1).get();
      if (colabSnap.empty) return res.status(403).json({ error:"No autorizado" });
      const colabData = colabSnap.docs[0].data();
      const tareaRef = db.collection("tareas").doc(tareaId);
      const tareaSnap = await tareaRef.get();
      if (!tareaSnap.exists || tareaSnap.data().uid !== boardUid) return res.status(403).json({ error:"No autorizado" });
      const comment = { texto:texto.trim(), autor:colabData.nombre, autorEmail:colabEmail, fecha:now, tipo:"mensaje" };
      await tareaRef.update({ comments:[...(tareaSnap.data().comments||[]), comment] });
      return res.json({ ok:true, comment });
    }

    if (action === "boardUpdateStatus") {
      const { boardToken, colabEmail, tareaId, estado, progresoLabel="" } = body;
      if (!boardToken || !colabEmail || !tareaId || !estado) return res.status(400).json({ error:"Faltan parámetros" });
      const usersSnap = await db.collection("users").where("boardToken","==",boardToken).limit(1).get();
      if (usersSnap.empty) return res.status(404).json({ error:"Tablero no encontrado" });
      const boardUid = usersSnap.docs[0].id;
      const colabSnap = await db.collection("colaboradores").where("uid","==",boardUid).where("email","==",colabEmail).limit(1).get();
      if (colabSnap.empty) return res.status(403).json({ error:"No autorizado" });
      const tareaRef = db.collection("tareas").doc(tareaId);
      const tareaSnap = await tareaRef.get();
      if (!tareaSnap.exists || tareaSnap.data().uid !== boardUid) return res.status(403).json({ error:"No autorizado" });
      const tData = tareaSnap.data();
      const asignados = [tData.asignadoEmail, ...(tData.asignadosEmails||[])].filter(Boolean);
      if (!asignados.includes(colabEmail)) return res.status(403).json({ error:"Solo podés actualizar tus propias tareas" });
      const act = { tipo:"estado", autor:colabSnap.docs[0].data().nombre, fecha:now, detalle:`→ ${estado}${progresoLabel?` (${progresoLabel})`:""}`};
      await tareaRef.update({ estado, progresoLabel:progresoLabel||"", updatedAt:now, activity:[...(tData.activity||[]),act] });
      return res.json({ ok:true });
    }

    if (action === "boardAddEntrega") {
      const { boardToken, colabEmail, tareaId, link, label="", nota="" } = body;
      if (!boardToken || !colabEmail || !tareaId || !link) return res.status(400).json({ error:"Faltan parámetros" });
      const usersSnap = await db.collection("users").where("boardToken","==",boardToken).limit(1).get();
      if (usersSnap.empty) return res.status(404).json({ error:"Tablero no encontrado" });
      const boardUid = usersSnap.docs[0].id;
      const userData = usersSnap.docs[0].data();
      const colabSnap = await db.collection("colaboradores").where("uid","==",boardUid).where("email","==",colabEmail).limit(1).get();
      if (colabSnap.empty) return res.status(403).json({ error:"No autorizado" });
      const colabData = colabSnap.docs[0].data();
      const tareaRef = db.collection("tareas").doc(tareaId);
      const tareaSnap = await tareaRef.get();
      if (!tareaSnap.exists || tareaSnap.data().uid !== boardUid) return res.status(403).json({ error:"No autorizado" });
      const tData = tareaSnap.data();
      const asignados = [tData.asignadoEmail, ...(tData.asignadosEmails||[])].filter(Boolean);
      if (!asignados.includes(colabEmail)) return res.status(403).json({ error:"Solo podés entregar en tus propias tareas" });
      const entrega = { link:link.trim(), label:(label.trim()||`v${(tData.deliverables||[]).length+1}`), nota:nota.trim(), fecha:now, entregadoPor:colabEmail };
      await tareaRef.update({ deliverables:[...(tData.deliverables||[]),entrega], estado:"entregado", updatedAt:now });
      const boardNotifRecipients = [...new Set([userData.email, ...(userData.notifEmails||[])])].filter(Boolean);
      boardNotifRecipients.forEach(to => sendEmail({ to, subject:`Nueva entrega en "${tData.titulo}"`, html:emailEntregaRecibida({ colab:colabData, tarea:tData, entrega, link:origin }) }));
      return res.json({ ok:true, entrega });
    }

    return res.status(400).json({ error:"Acción desconocida" });

  } catch(e) {
    console.error("[tareas]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
