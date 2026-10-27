// api/_mail.js — Política de mails de Growith (27/oct/2026). No lo expone Vercel (empieza con _).
//
// Por qué: la cuota diaria de Resend se superaba todos los días. Todos los envíos de la plataforma
// pasan por resendEnviar(), que MIDE y REPARTE la cuota (no apaga nada por defecto):
//   · Cuenta lo enviado y lo frenado por día y por origen en system/mail_cuota/dias/{AAAA-MM-DD}
//     {enviados, suprimidos, porOrigen.{origen}.{enviados|suprimidos}} → Admin → Configuración → Mails
//     muestra qué tipo de mail está llenando la cuota.
//   · Tope diario (system/mail_config.topeDia, 90 por defecto): pasado el 70 %, los de prioridad BAJA
//     (facturas al comprador, avisos de envíos al comprador, calendario) se frenan para que lleguen los
//     importantes (pagos, plan, saldo, invitaciones, depósito); pasado el 100 % solo sale lo interno.
//   · system/mail_config.apagados.{origen} = true apaga un tipo puntual desde Admin.
//   · Nunca se frenan: mails a Growith / Soluna / el fundador / internos (tipo "interno", ejecutiva de
//     Andreani, depósito) y los que alguien manda A MANO (tipo "accion": invitar un miembro, reenviar
//     una factura, recordatorio manual, mail de prueba).
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { FOUNDERS } from "./_auth.js";

const INTERNOS_FIJOS = ["contacto.growith@gmail.com", "soluna.biolight@gmail.com"];
// Se frenan primero cuando el día pasa el 70 % del tope.
export const PRIORIDAD_BAJA = ["facturas", "seguimientos", "calendario"];
let _cfg = null, _cfgAt = 0;
const diaAR = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const lower = s => String(s || "").trim().toLowerCase();

async function mailCfg(db) {
  if (_cfg && Date.now() - _cfgAt < 60000) return _cfg;
  let c = {}, fund = [];
  try { const s = await db.doc("system/mail_config").get(); c = s.exists ? s.data() : {}; } catch (_) {}
  try { for (const uid of FOUNDERS) { const f = await db.collection("users").doc(uid).get(); if (f.exists && f.data().email) fund.push(lower(f.data().email)); } } catch (_) {}
  _cfg = {
    apagados: (c.apagados && typeof c.apagados === "object") ? c.apagados : {},
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
  const c = db ? await mailCfg(db) : { apagados: {}, topeDia: 90, internos: INTERNOS_FIJOS };
  const aInterno = tos.every(t => c.internos.includes(t));
  const libre = aInterno || tipo === "interno" || tipo === "accion";
  const frenar = (motivo, error) => {
    if (db) contar(db, "suprimidos", origen || tipo);
    console.log(`[mail] frenado (${origen || tipo}, ${motivo}): "${String(payload.subject || "").slice(0, 80)}"`);
    return { ok: false, suprimido: true, motivo, error };
  };
  if (!libre && c.apagados[origen]) return frenar("apagado", "Este tipo de mail está apagado desde Admin");
  if (db && !libre) {
    try {
      const s = await db.collection("system").doc("mail_cuota").collection("dias").doc(diaAR()).get();
      const n = Number(s.data()?.enviados) || 0;
      if (n >= c.topeDia) return frenar("tope", "Se alcanzó el tope diario de mails");
      if (PRIORIDAD_BAJA.includes(origen) && n >= Math.floor(c.topeDia * 0.7)) return frenar("reserva", "Cupo del día reservado para mails importantes");
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
  return { apagados: c.apagados, topeDia: c.topeDia, prioridadBaja: PRIORIDAD_BAJA, dias: s.docs.map(d => ({ dia: d.id, ...d.data() })) };
}
