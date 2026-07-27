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
          <div style="font-size:22px;font-weight:800;color:#111;margin-bottom:12px;">${urgente?"🚨":"⏰"} ${titulo}</div>
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

  const usersSnap = await db.collection("users").get();
  const results = { sent: 0, skipped: 0, errors: 0 };

  await Promise.all(usersSnap.docs.map(async (doc) => {
    const u = doc.data();
    const email = u.email;
    if (!email) { results.skipped++; return; }

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

    if (diasRestantes === null) { results.skipped++; return; }

    // No mandar más de una advertencia por día para el mismo vencimiento
    const expiryKey = (isTrial ? trialEnd : planExpiry)?.toDateString();
    const lastWarn = u.lastExpiryWarnAt?.toDate?.();
    if (lastWarn && lastWarn.toDateString() === now.toDateString()) {
      results.skipped++; return;
    }

    const subject = isTrial
      ? (diasRestantes <= 1 ? "¡Hoy vence tu prueba gratuita de Growith!" : `Tu prueba gratuita vence en ${diasRestantes} días`)
      : (diasRestantes <= 1 ? "¡Hoy vence tu plan Growith!" : `Tu plan Growith vence en ${diasRestantes} días`);

    const html = emailHtml({ nombre: u.nombre || u.displayName || "", diasRestantes, isTrial, planesPlanesUrl: planesUrl });
    const result = await sendEmail({ to: email, subject, html });

    if (result.ok) {
      await doc.ref.update({ lastExpiryWarnAt: FieldValue.serverTimestamp() });
      results.sent++;
      console.log(`[check-expiring] ✓ email a ${email} (${diasRestantes}d, ${isTrial?"trial":"plan"})`);
    } else {
      results.errors++;
      console.error(`[check-expiring] ✗ ${email}:`, result.error);
    }
  }));

  console.log("[check-expiring] resultado:", results);
  return res.json({ ok: true, ...results });
}
