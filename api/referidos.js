// api/referidos.js — Programa de referidos de Growith.
//
// Cada cuenta tiene un código único (users/{uid}.refCode). Un usuario nuevo que
// se registra con ese código queda vinculado (users/{uid}.refBy = uid del
// referente). Cada vez que un pago de PLAN del referido se confirma (cron
// auto-tron o admin), el referente gana el 15% en crédito (refCreditUsd),
// que se descuenta automáticamente de sus propias renovaciones.
//
// La comisión se calcula sobre el precio de lista USD del plan (no sobre el
// monto crudo del pago, que puede venir en ARS): determinista y sin sorpresas.
// Idempotencia: un doc por pago en users/{referente}/ref_ledger/pago_{pagoId} —
// si existe, no se acredita dos veces aunque el confirm se reintente.
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { randomBytes } from "crypto";
import { requireUid } from "./_auth.js";

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
  })});
  return getFirestore();
}

// Precio de lista USD por mes según plan y período (mismo cuadro que AppPlanes).
const PRECIOS = {
  facturador: { mensual: 19, anual: 16 },
  plus:       { mensual: 69, anual: 57 },
};
export const REF_PCT = 0.15;

function precioTotalUsd(plan, periodo, meses) {
  const porMes = PRECIOS[plan]?.[periodo === "anual" ? "anual" : "mensual"];
  if (!porMes) return 0;
  return +(porMes * Math.max(1, Number(meses) || 1)).toFixed(2);
}

/** Comisión USD que genera un pago de plan confirmado (0 si no aplica). */
export function comisionDePago(pago) {
  if (!pago || pago.isTrial) return 0;
  if (["prueba", "credito"].includes(String(pago.method || ""))) return 0;
  const meses = Number(pago.mesesConfirmados || pago.meses) || 1;
  const total = precioTotalUsd(pago.plan, pago.periodo, meses);
  return +(total * REF_PCT).toFixed(2);
}

/**
 * Acredita la comisión del referente por un pago confirmado. Best-effort e
 * idempotente: se puede llamar más de una vez con el mismo pagoId sin duplicar.
 */
export async function acreditarComisionReferido(db, pagoId, pago) {
  try {
    if (!pagoId || !pago?.uid) return;
    const com = comisionDePago(pago);
    if (com <= 0) return;
    const uSnap = await db.collection("users").doc(pago.uid).get();
    const refBy = uSnap.exists ? String(uSnap.data().refBy || "") : "";
    if (!refBy || refBy === pago.uid) return;
    const refDoc = db.collection("users").doc(refBy);
    const ledgerRef = refDoc.collection("ref_ledger").doc(`pago_${pagoId}`);
    await db.runTransaction(async tx => {
      const [ls, rs] = await Promise.all([tx.get(ledgerRef), tx.get(refDoc)]);
      if (ls.exists || !rs.exists) throw new Error("SKIP");
      const d = rs.data() || {};
      tx.set(ledgerRef, {
        tipo: "comision", fromUid: pago.uid, fromEmail: String(pago.email || ""),
        plan: pago.plan || "", periodo: pago.periodo || "mensual",
        meses: Number(pago.mesesConfirmados || pago.meses) || 1,
        comisionUsd: com, ts: FieldValue.serverTimestamp(),
      });
      tx.update(refDoc, {
        refCreditUsd: +((Number(d.refCreditUsd) || 0) + com).toFixed(2),
        refGanadoUsd: +((Number(d.refGanadoUsd) || 0) + com).toFixed(2),
      });
    });
    console.log(`[referidos] ✓ comisión $${com} para ${refBy} por pago ${pagoId}`);
  } catch (e) { if (e.message !== "SKIP") console.error("[referidos] acreditar:", e.message); }
}

/**
 * Descuenta del pagador el crédito que aplicó a este pago (refCreditAplicado),
 * al momento de confirmarse. Idempotente vía doc uso_{pagoId} en su ledger.
 */
export async function descontarCreditoAplicado(db, pagoId, pago) {
  try {
    const usado = +(Number(pago?.refCreditAplicado) || 0).toFixed(2);
    if (!pagoId || !pago?.uid || usado <= 0) return;
    const uDoc = db.collection("users").doc(pago.uid);
    const ledgerRef = uDoc.collection("ref_ledger").doc(`uso_${pagoId}`);
    await db.runTransaction(async tx => {
      const [ls, us] = await Promise.all([tx.get(ledgerRef), tx.get(uDoc)]);
      if (ls.exists || !us.exists) throw new Error("SKIP");
      const cur = Number(us.data().refCreditUsd) || 0;
      tx.set(ledgerRef, { tipo: "uso", comisionUsd: -usado, plan: pago.plan || "", ts: FieldValue.serverTimestamp() });
      tx.update(uDoc, { refCreditUsd: +Math.max(0, cur - usado).toFixed(2) });
    });
  } catch (e) { if (e.message !== "SKIP") console.error("[referidos] descontar:", e.message); }
}

function addMonths(date, n) { const d = new Date(date); d.setMonth(d.getMonth() + Number(n)); return d; }
const genCode = () => Array.from(randomBytes(8)).map(b => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[b % 31]).join("");

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://www.growithapp.com");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });
  const db = initAdmin();
  const body = req.body || {};
  const action = String(body.action || "");
  const uid = String(body.uid || "").trim();

  // Referidos es del DUEÑO de la cuenta: ni miembros ni colaboradores.
  const auth = await requireUid(req, uid);
  if (!auth.ok) return res.status(auth.code).json({ error: auth.error });
  if (auth.viaTeam) return res.status(403).json({ error: "Solo el dueño de la cuenta maneja sus referidos." });

  const uDoc = db.collection("users").doc(uid);

  try {
    // ── Datos del panel (y alta del código si todavía no existe) ──
    if (action === "me") {
      let snap = await uDoc.get();
      let d = snap.exists ? snap.data() : {};
      if (!d.refCode) {
        // Código único: probamos hasta que no choque con otro (colisión rarísima)
        for (let i = 0; i < 5; i++) {
          const code = genCode();
          const clash = await db.collection("users").where("refCode", "==", code).limit(1).get();
          if (clash.empty) { await uDoc.set({ refCode: code }, { merge: true }); d.refCode = code; break; }
        }
        if (!d.refCode) return res.status(500).json({ error: "No se pudo generar el código, reintentá." });
      }
      const [refsSnap, ledgerSnap] = await Promise.all([
        db.collection("users").where("refBy", "==", uid).limit(200).get(),
        uDoc.collection("ref_ledger").orderBy("ts", "desc").limit(30).get(),
      ]);
      const ahora = Date.now();
      const referidos = refsSnap.docs.map(r => {
        const u = r.data() || {};
        const exp = u.planExpiry?.toDate?.() || (u.planExpiry?._seconds ? new Date(u.planExpiry._seconds * 1000) : null);
        const activo = !!(u.plan && u.plan !== "free" && exp && exp.getTime() > ahora);
        return {
          email: String(u.email || ""), nombre: String(u.nombre || u.displayName || ""),
          plan: activo ? (u.plan === "facturador" ? "Facturador" : "Pro") : (u.isTrial ? "En prueba" : "Sin plan"),
          activo, desde: u.refByAt?.toMillis?.() || null,
        };
      }).sort((a, b) => (b.desde || 0) - (a.desde || 0));
      const ledger = ledgerSnap.docs.map(l => { const x = l.data(); return { tipo: x.tipo || "comision", fromEmail: x.fromEmail || "", plan: x.plan || "", comisionUsd: Number(x.comisionUsd) || 0, ts: x.ts?.toMillis?.() || null }; });
      return res.json({
        ok: true, code: d.refCode, pct: Math.round(REF_PCT * 100),
        creditUsd: +(Number(d.refCreditUsd) || 0).toFixed(2),
        ganadoUsd: +(Number(d.refGanadoUsd) || 0).toFixed(2),
        referidos, activos: referidos.filter(r => r.activo).length, ledger,
      });
    }

    // ── Vincular un usuario nuevo a su referente (claim del ?ref=CODIGO) ──
    if (action === "claim") {
      const code = String(body.code || "").trim().toUpperCase();
      if (!/^[A-Z0-9]{6,12}$/.test(code)) return res.status(400).json({ error: "codigo_invalido" });
      const snap = await uDoc.get();
      const d = snap.exists ? snap.data() : {};
      if (d.refBy) return res.json({ ok: true, ya: true });
      if (String(d.refCode || "").toUpperCase() === code) return res.status(400).json({ error: "codigo_propio" });
      // Solo cuentas nuevas: si ya tiene (o tuvo) un plan pago, no vale el vínculo.
      const pagos = await db.collection("pagos").where("uid", "==", uid).limit(5).get();
      if (pagos.docs.some(p => p.data().estado === "confirmado" && !p.data().isTrial)) return res.status(400).json({ error: "cuenta_no_nueva" });
      const owner = await db.collection("users").where("refCode", "==", code).limit(1).get();
      if (owner.empty) return res.status(404).json({ error: "codigo_inexistente" });
      const refUid = owner.docs[0].id;
      if (refUid === uid) return res.status(400).json({ error: "codigo_propio" });
      await uDoc.set({ refBy: refUid, refByAt: FieldValue.serverTimestamp() }, { merge: true });
      return res.json({ ok: true });
    }

    // ── Canje total: renovar el plan pagando 100% con crédito acumulado ──
    if (action === "canjearCredito") {
      const plan = body.plan === "facturador" ? "facturador" : "plus";
      const periodo = body.periodo === "anual" ? "anual" : "mensual";
      const meses = periodo === "anual" ? 12 : 1;
      const total = precioTotalUsd(plan, periodo, meses);
      let expiry;
      try {
        expiry = await db.runTransaction(async tx => {
          const us = await tx.get(uDoc);
          if (!us.exists) throw new Error("NO_USER");
          const d = us.data() || {};
          const cred = Number(d.refCreditUsd) || 0;
          if (cred < total) throw new Error("CREDITO_INSUFICIENTE");
          const now = new Date();
          let base = now;
          const cur = d.planExpiry?.toDate?.() || (d.planExpiry?._seconds ? new Date(d.planExpiry._seconds * 1000) : null);
          if (cur && cur > now) base = cur;
          const exp = addMonths(base, meses);
          tx.update(uDoc, { plan, planExpiry: exp, isTrial: false, cancelAtPeriodEnd: false, planActivadoBy: "credito-referidos", planActivadoAt: now, refCreditUsd: +(cred - total).toFixed(2) });
          tx.set(uDoc.collection("ref_ledger").doc(), { tipo: "canje", comisionUsd: -total, plan, ts: FieldValue.serverTimestamp() });
          return exp;
        });
      } catch (e) {
        if (e.message === "CREDITO_INSUFICIENTE") return res.status(400).json({ error: "Tu crédito no alcanza para ese plan todavía." });
        throw e;
      }
      // Registro en pagos para el historial del Admin (ya confirmado, sin plata)
      await db.collection("pagos").add({
        uid, email: String(body.email || ""), plan, method: "credito", currency: "USD", amount: total,
        meses, periodo, estado: "confirmado", mesesConfirmados: meses,
        confirmadoBy: "credito-referidos", confirmadoAt: new Date(), createdAt: new Date(),
        nota: `Renovación pagada 100% con crédito de referidos (USD ${total})`,
      }).catch(() => {});
      return res.json({ ok: true, expiry });
    }

    return res.status(400).json({ error: "Acción inválida" });
  } catch (e) {
    console.error("[referidos]", e);
    return res.status(500).json({ error: "Error interno" });
  }
}
