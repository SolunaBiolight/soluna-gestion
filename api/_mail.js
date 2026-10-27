// api/_mail.js — Política de mails de Growith (27/oct/2026). No lo expone Vercel (empieza con _).
//
// Por qué: la cuota diaria de Resend se superaba todos los días. Todos los envíos de la
// plataforma pasan por resendEnviar(), que decide:
//   · tipo "interno": mails a Growith / Soluna / la ejecutiva de Andreani / el depósito → salen.
//   · tipo "accion": los que el usuario manda A MANO en ese momento (invitar a un miembro,
//     reenviar una factura, recordatorio manual, mail de prueba) → salen.
//   · tipo "cliente" (por defecto): todo lo automático a los clientes de Growith y a sus
//     compradores (bienvenida, avisos de prueba, facturas al comprador, avisos de envío,
//     tareas, calendario, saldo bajo, Stripe…) → APAGADO salvo que
//     system/mail_config.clientes === true (Admin → Configuración → Mails).
// Además, un destinatario que es el fundador o un mail interno siempre sale, sin importar el tipo,
// y hay un tope diario (system/mail_config.topeDia, 90 por defecto) para lo que no es interno.
// Lo que se frena se cuenta en system/mail_cuota/dias/{AAAA-MM-DD} {enviados, suprimidos, porOrigen}.
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { FOUNDERS } from "./_auth.js";

const INTERNOS_FIJOS = ["contacto.growith@gmail.com", "soluna.biolight@gmail.com"];
let _cfg = null, _cfgAt = 0;
const diaAR = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const lower = s => String(s || "").trim().toLowerCase();

async function mailCfg(db) {
  if (_cfg && Date.now() - _cfgAt < 60000) return _cfg;
  let c = {}, fund = [];
  try { const s = await db.doc("system/mail_config").get(); c = s.exists ? s.data() : {}; } catch (_) {}
  try { for (const uid of FOUNDERS) { const f = await db.collection("users").doc(uid).get(); if (f.exists && f.data().email) fund.push(lower(f.data().email)); } } catch (_) {}
  _cfg = {
    clientes: c.clientes === true,
    topeDia: Number(c.topeDia) > 0 ? Number(c.topeDia) : 90,
    internos: [...new Set([...INTERNOS_FIJOS, ...fund, ...(Array.isArray(c.internos) ? c.internos.map(lower) : [])])],
  };
  _cfgAt = Date.now();
  return _cfg;
}
export function mailCfgReset() { _cfg = null; }

function contar(db, campo, origen) {
  const ref = db.collection("system").doc("mail_cuota").collection("dias").doc(diaAR());
  return ref.set({ [campo]: FieldValue.increment(1), [`porOrigen.${String(origen || "otro").replace(/[^\w-]/g, "_")}.${campo}`]: FieldValue.increment(1), dia: diaAR() }, { merge: true }).catch(() => {});
}

// payload = cuerpo de Resend ({ from?, to, subject, html, attachments?, reply_to?, scheduled_at? }).
// Devuelve { ok, id } | { ok:false, suprimido:true, error } | { error }.
export async function resendEnviar(payload, { tipo = "cliente", origen = "" } = {}) {
  const key = process.env.RESEND_API_KEY;
  const tos = [].concat(payload?.to || []).map(lower).filter(Boolean);
  if (!key || !tos.length) return { error: "missing" };
  let db = null;
  try { db = getFirestore(); } catch (_) {}
  const c = db ? await mailCfg(db) : { clientes: false, topeDia: 90, internos: INTERNOS_FIJOS };
  const aInterno = tos.every(t => c.internos.includes(t));
  const permitido = aInterno || tipo === "interno" || tipo === "accion" || c.clientes;
  if (!permitido) {
    if (db) contar(db, "suprimidos", origen);
    console.log(`[mail] suprimido (${origen || tipo}): "${String(payload.subject || "").slice(0, 80)}"`);
    return { ok: false, suprimido: true, error: "Los mails automáticos a clientes están apagados" };
  }
  if (db && !aInterno) {
    try {
      const s = await db.collection("system").doc("mail_cuota").collection("dias").doc(diaAR()).get();
      if ((Number(s.data()?.enviados) || 0) >= c.topeDia) {
        contar(db, "suprimidos", (origen || tipo) + "_tope");
        console.warn(`[mail] tope diario (${c.topeDia}) alcanzado: no se manda "${String(payload.subject || "").slice(0, 80)}"`);
        return { ok: false, suprimido: true, error: "Se alcanzó el tope diario de mails" };
      }
    } catch (_) {}
  }
  try {
    const body = { from: process.env.RESEND_FROM || "Growith <onboarding@resend.dev>", ...payload, to: tos };
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { console.error(`[mail] Resend error (${origen || tipo}):`, data?.message || r.status); return { error: data?.message || `HTTP ${r.status}` }; }
    if (db) contar(db, "enviados", origen);
    return { ok: true, id: data.id };
  } catch (e) {
    console.error(`[mail] fetch error (${origen || tipo}):`, e.message);
    return { error: e.message };
  }
}

// Resumen para Admin: config + últimos 7 días.
export async function mailResumen(db) {
  const c = await mailCfg(db);
  const s = await db.collection("system").doc("mail_cuota").collection("dias").orderBy("dia", "desc").limit(7).get().catch(() => ({ docs: [] }));
  return { clientes: c.clientes, topeDia: c.topeDia, dias: s.docs.map(d => ({ dia: d.id, ...d.data() })) };
}
