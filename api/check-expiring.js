// api/check-expiring.js — Cron diario: avisa por email cuando quedan ≤5 días de plan o trial
// Llamado desde vercel.json crons (0 10 * * *) y protegido con CRON_SECRET

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { guardCron } from "./_auth.js";

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
  })});
  return getFirestore();
}

async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return { error: "missing" };
  const from = process.env.RESEND_FROM || "Growith <onboarding@resend.dev>";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html }),
      // Sin timeout, un Resend colgado se come el presupuesto entero del cron.
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json();
    if (!r.ok) { console.error("[check-expiring] email error:", data?.message); return { error: data?.message }; }
    return { ok: true, id: data.id };
  } catch(e) {
    console.error("[check-expiring] fetch error:", e.message);
    return { error: e.message };
  }
}

function emailHtml({ nombre, diasRestantes, isTrial, planesPlanesUrl }) {
  const urgente = diasRestantes <= 1;
  const color   = urgente ? "#ef4444" : "#f97316";
  const titulo  = isTrial
    ? (urgente ? "¡Hoy vence tu prueba gratuita!" : `Tu prueba gratuita vence en ${diasRestantes} día${diasRestantes!==1?"s":""}`)
    : (urgente ? "¡Hoy vence tu plan Growith!" : `Tu plan Growith vence en ${diasRestantes} día${diasRestantes!==1?"s":""}`);
  const cta = isTrial ? "Ver planes disponibles" : "Renovar mi plan";

  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Inter',system-ui,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08);">
        <tr><td style="background:${color};padding:24px 32px;">
          <div style="font-size:28px;font-weight:900;color:#fff;letter-spacing:-0.5px;">Growith</div>
        </td></tr>
        <tr><td style="padding:32px;">
          <div style="font-size:22px;font-weight:800;color:#111;margin-bottom:12px;">${titulo}</div>
          <p style="font-size:15px;color:#444;line-height:1.6;margin:0 0 24px;">
            Hola${nombre ? ` ${nombre.split(" ")[0]}` : ""},<br><br>
            ${isTrial
              ? `Tu período de prueba gratuita${urgente ? " vence hoy" : ` vence en ${diasRestantes} día${diasRestantes!==1?"s":""}`}. Para seguir usando todas las funciones de Growith sin interrupciones, activá un plan.`
              : `Tu suscripción a Growith${urgente ? " vence hoy" : ` vence en ${diasRestantes} día${diasRestantes!==1?"s":""}`}. Renovalo para mantener el acceso a todas tus herramientas.`}
          </p>
          <table cellpadding="0" cellspacing="0"><tr><td>
            <a href="${planesPlanesUrl}" style="display:inline-block;padding:12px 28px;background:${color};color:#fff;text-decoration:none;border-radius:10px;font-size:15px;font-weight:700;">${cta} →</a>
          </td></tr></table>
          <p style="font-size:13px;color:#888;margin:28px 0 0;line-height:1.5;">
            Si tenés alguna consulta, respondé este email o escribinos a soporte.<br>
            El equipo de Growith
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// Presupuesto de la función: se declara en vercel.json ("functions" →
// api/check-expiring.js → maxDuration). Este cron pagina TODA la colección de
// usuarios y manda emails, así que no le alcanza el default de Vercel.

export default async function handler(req, res) {
  // Autorización del cron OBLIGATORIA. Antes era `if (cronSecret && ...)`: sin
  // la env var configurada el endpoint quedaba abierto a cualquiera (barrido de
  // toda la colección users + envío de emails).
  if (!guardCron(req, res)) return;

  const db = initAdmin();
  const now = new Date();
  const in5days = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);
  const APP_URL = process.env.APP_URL || "https://www.growithapp.com";
  const planesUrl = `${APP_URL}/#/planes`;

  const results = { sent: 0, skipped: 0, errors: 0, revisados: 0, truncado: false };

  // Deadline global: si Resend o Firestore vienen lentos cortamos antes de que
  // Vercel mate la función en seco. Lo que quedó afuera se manda mañana (el
  // aviso se dispara durante los 5 días previos al vencimiento, no un solo día).
  const deadline = Date.now() + 50000;
  const quedaTiempo = () => Date.now() < deadline;

  // Un solo `.get()` de toda la colección no escala: con muchas cuentas se
  // traen todos los documentos a memoria de una y se abren tantos envíos
  // concurrentes como usuarios haya (rate limit de Resend + timeout seguro).
  // Ahora: páginas de 200 por cursor de documento y emails de a 5 en paralelo.
  const PAGINA = 200, CONCURRENCIA = 5, MAX_USUARIOS = 5000;
  let cursor = null;

  // Decide si a un usuario hay que avisarle y arma el email. Devuelve null si no.
  const evaluar = (doc) => {
    const u = doc.data();
    const email = u.email;
    if (!email) return null;

    let diasRestantes = null;
    let isTrial = false;

    // Trial: free plan + trialEnd dentro de los próximos 5 días
    const trialEnd = u.trialEnd?.toDate?.();
    if (u.plan === "free" || !u.plan) {
      if (trialEnd && trialEnd > now && trialEnd <= in5days) {
        diasRestantes = Math.max(0, Math.ceil((trialEnd - now) / (1000*60*60*24)));
        isTrial = true;
      }
    }

    // Plan pago: planExpiry dentro de los próximos 5 días
    const planExpiry = u.planExpiry?.toDate?.();
    if (!isTrial && u.plan && u.plan !== "free" && planExpiry && planExpiry > now && planExpiry <= in5days) {
      diasRestantes = Math.max(0, Math.ceil((planExpiry - now) / (1000*60*60*24)));
      isTrial = false;
    }

    // ── Ciclo de vida (solo si no corresponde aviso de vencimiento) ──
    if (diasRestantes === null) {
      const createdAt = u.createdAt?.toDate?.();
      const diasCuenta = createdAt ? (now - createdAt) / 86400000 : null;
      const esFree = u.plan === "free" || !u.plan;
      const btn = (txt) => `<table cellpadding="0" cellspacing="0"><tr><td><a href="${planesPlanesUrl.replace("/#/planes","")}" style="display:inline-block;padding:12px 28px;background:#6366f1;color:#fff;text-decoration:none;border-radius:10px;font-size:15px;font-weight:700;">${txt} →</a></td></tr></table>`;
      const wrap = (titulo, cuerpo, cta) => `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6;color:#111;max-width:520px"><div style="font-size:20px;font-weight:800;margin-bottom:12px">${titulo}</div><p style="color:#444">${cuerpo}</p>${cta}<p style="font-size:13px;color:#888;margin-top:24px">El equipo de Growith</p></div>`;
      const nombre = (u.nombre || u.displayName || "").split(" ")[0];

      // 1) Bienvenida: cuenta creada hace <2 días, sin mail previo
      if (diasCuenta !== null && diasCuenta < 2 && !u.welcomeSentAt) {
        return { doc, email, flag: "welcomeSentAt", diasRestantes: 0, isTrial: true,
          subject: "Te damos la bienvenida a Growith",
          html: wrap(`¡Hola${nombre?` ${nombre}`:""}! Ya tenés 14 días con todo incluido`,
            "Para ver tus números reales hoy mismo: 1) conectá tu tienda (Tienda Nube, Shopify o Mercado Libre) desde Configuración → Integraciones, 2) cargá tu CUIT si querés facturar con ARCA, 3) mirá el Dashboard. En 5 minutos está andando.",
            btn("Entrar a Growith")) };
      }
      // 2) Empujón día 3: trial activo pero sin tienda conectada
      if (diasCuenta !== null && diasCuenta >= 3 && diasCuenta < 7 && esFree && trialEnd && trialEnd > now
          && !(Array.isArray(u.stores) && u.stores.length) && !u.connectNudgeSentAt) {
        return { doc, email, flag: "connectNudgeSentAt", diasRestantes: 0, isTrial: true,
          subject: "Tu cuenta de Growith está vacía — conectá tu tienda en 2 minutos",
          html: wrap("Todavía no conectaste tu tienda",
            "Growith trabaja con tus datos reales: hasta que no conectes Tienda Nube, Shopify o Mercado Libre, no hay nada para mostrarte. Es un click con OAuth (no te pedimos contraseñas) y al instante ves ventas, márgenes y stock.",
            btn("Conectar mi tienda")) };
      }
      // 3) Win-back: venció (trial o plan) hace 2-6 días
      const vencioEl = esFree ? trialEnd : planExpiry;
      const diasVencido = vencioEl && vencioEl < now ? (now - vencioEl) / 86400000 : null;
      if (diasVencido !== null && diasVencido >= 2 && diasVencido < 7 && !u.winbackSentAt) {
        return { doc, email, flag: "winbackSentAt", diasRestantes: 0, isTrial: esFree,
          subject: "Tus datos de Growith te están esperando",
          html: wrap(`${esFree ? "Tu prueba terminó" : "Tu plan venció"} hace unos días`,
            "Todo lo tuyo sigue guardado exactamente donde lo dejaste: órdenes, márgenes, facturas y configuración. Reactivá cuando quieras y seguís desde el mismo punto. Si algo no te cerró del producto, respondé este mail y contanos — lo leemos de verdad.",
            btn("Reactivar mi cuenta")) };
      }
      return null;
    }

    // No mandar más de una advertencia por día para el mismo vencimiento
    const lastWarn = u.lastExpiryWarnAt?.toDate?.();
    if (lastWarn && lastWarn.toDateString() === now.toDateString()) return null;

    const subject = isTrial
      ? (diasRestantes <= 1 ? "¡Hoy vence tu prueba gratuita de Growith!" : `Tu prueba gratuita vence en ${diasRestantes} días`)
      : (diasRestantes <= 1 ? "¡Hoy vence tu plan Growith!" : `Tu plan Growith vence en ${diasRestantes} días`);

    const html = emailHtml({ nombre: u.nombre || u.displayName || "", diasRestantes, isTrial, planesPlanesUrl: planesUrl });
    return { doc, email, subject, html, diasRestantes, isTrial };
  };

  // Manda un email y marca el aviso. Nunca lanza: un destinatario roto no puede
  // cortar la corrida del resto.
  const avisar = async (t) => {
    try {
      const result = await sendEmail({ to: t.email, subject: t.subject, html: t.html });
      if (result.ok) {
        await t.doc.ref.update({ [t.flag || "lastExpiryWarnAt"]: FieldValue.serverTimestamp() });
        results.sent++;
        console.log(`[check-expiring] ✓ email a ${t.email} (${t.diasRestantes}d, ${t.isTrial?"trial":"plan"})`);
      } else {
        results.errors++;
        console.error(`[check-expiring] ✗ ${t.email}:`, result.error);
      }
    } catch (e) {
      results.errors++;
      console.error(`[check-expiring] ✗ ${t.email}:`, e.message);
    }
  };

  while (results.revisados < MAX_USUARIOS) {
    if (!quedaTiempo()) { results.truncado = true; break; }
    let q = db.collection("users").orderBy("__name__").limit(PAGINA);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;
    cursor = snap.docs[snap.docs.length - 1];
    results.revisados += snap.docs.length;

    const objetivos = [];
    for (const doc of snap.docs) {
      const t = evaluar(doc);
      if (t) objetivos.push(t); else results.skipped++;
    }
    // Lotes concurrentes acotados: ni secuencial (se pasa del tiempo de la
    // función) ni todos de golpe (rate limit de Resend).
    for (let i = 0; i < objetivos.length; i += CONCURRENCIA) {
      if (!quedaTiempo()) { results.truncado = true; break; }
      await Promise.all(objetivos.slice(i, i + CONCURRENCIA).map(avisar));
    }
    if (snap.docs.length < PAGINA) break;
  }

  console.log("[check-expiring] resultado:", results);
  return res.json({ ok: true, ...results });
}
