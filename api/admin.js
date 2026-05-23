// api/admin.js — Admin panel data (uses Firebase Admin SDK, bypasses security rules)

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const ADMIN_UIDS = ["WJH3ArqDPQcNLha9lOinvkVi9uJ2"];

const PLAN_PRICE_USDT = { plus: 29, full: 79 };
const PLAN_PRICE_ARS  = { plus: 35000, full: 95000 };

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
  })});
  return getFirestore();
}

function addMonths(date, n) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + Number(n));
  return d;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const body = req.method === "GET" ? req.query : req.body;
  const { action, uid } = body;

  if (!uid || !ADMIN_UIDS.includes(uid)) {
    return res.status(403).json({ error: "No autorizado" });
  }

  const db = initAdmin();
  const now = new Date();

  try {

    // ── getData ───────────────────────────────────────────────────────────────
    if (action === "getData") {
      const [pagSnap, usSnap] = await Promise.all([
        db.collection("pagos").orderBy("createdAt", "desc").get(),
        db.collection("users").get(),
      ]);
      const pagos    = pagSnap.docs.map(d => ({ _id: d.id, ...d.data() }));
      const usuarios = usSnap.docs.map(d => ({ _id: d.id, ...d.data() }));

      // Stats calculadas server-side
      const activos  = usuarios.filter(u => u.plan && u.plan !== "free");
      const mrrUsdt  = activos.reduce((s, u) => s + (PLAN_PRICE_USDT[u.plan] || 0), 0);
      const mrrArs   = activos.reduce((s, u) => s + (PLAN_PRICE_ARS[u.plan]  || 0), 0);

      const en7dias  = new Date(now); en7dias.setDate(en7dias.getDate() + 7);
      const vencenPronto = activos.filter(u => {
        const exp = u.planExpiry?._seconds
          ? new Date(u.planExpiry._seconds * 1000)
          : u.planExpiry?.toDate?.();
        return exp && exp >= now && exp <= en7dias;
      });

      const stats = {
        totalUsuarios: usuarios.length,
        usuariosPlus:  usuarios.filter(u => u.plan === "plus").length,
        usuariosFull:  usuarios.filter(u => u.plan === "full").length,
        pagosPendientes: pagos.filter(p => p.estado === "pendiente").length,
        mrrUsdt,
        mrrArs,
        vencenPronto: vencenPronto.length,
      };

      return res.json({ pagos, usuarios, stats });
    }

    // ── activarPlan ───────────────────────────────────────────────────────────
    if (action === "activarPlan") {
      const { targetUid, plan, meses = 1 } = body;
      // Si el usuario ya tiene un plan activo que no venció, extendemos desde su expiry actual
      const userDoc = await db.collection("users").doc(targetUid).get();
      const userData = userDoc.data() || {};
      let base = now;
      if (userData.planExpiry) {
        const currentExpiry = userData.planExpiry?._seconds
          ? new Date(userData.planExpiry._seconds * 1000)
          : userData.planExpiry?.toDate?.() || now;
        if (currentExpiry > now) base = currentExpiry;
      }
      const expiry = addMonths(base, meses);
      await db.collection("users").doc(targetUid).update({
        plan,
        planExpiry: expiry,
        planActivadoBy: uid,
        planActivadoAt: now,
      });
      return res.json({ ok: true, expiry });
    }

    // ── desactivarPlan ────────────────────────────────────────────────────────
    if (action === "desactivarPlan") {
      const { targetUid } = body;
      await db.collection("users").doc(targetUid).update({
        plan: "free",
        planExpiry: null,
        planDesactivadoBy: uid,
        planDesactivadoAt: now,
      });
      return res.json({ ok: true });
    }

    // ── confirmarPago ─────────────────────────────────────────────────────────
    if (action === "confirmarPago") {
      const { pagoId, targetUid, plan, meses = 1 } = body;
      // Mismo lógica de extensión: si ya tiene plan vigente, suma desde el expiry
      const userDoc = await db.collection("users").doc(targetUid).get();
      const userData = userDoc.data() || {};
      let base = now;
      if (userData.planExpiry) {
        const currentExpiry = userData.planExpiry?._seconds
          ? new Date(userData.planExpiry._seconds * 1000)
          : userData.planExpiry?.toDate?.() || now;
        if (currentExpiry > now) base = currentExpiry;
      }
      const expiry = addMonths(base, meses);
      await Promise.all([
        db.collection("users").doc(targetUid).update({
          plan,
          planExpiry: expiry,
          planActivadoBy: uid,
          planActivadoAt: now,
        }),
        db.collection("pagos").doc(pagoId).update({
          estado: "confirmado",
          mesesConfirmados: Number(meses),
          confirmadoBy: uid,
          confirmadoAt: now,
        }),
      ]);
      return res.json({ ok: true, expiry });
    }

    // ── rechazarPago ──────────────────────────────────────────────────────────
    if (action === "rechazarPago") {
      const { pagoId, motivo = "" } = body;
      await db.collection("pagos").doc(pagoId).update({
        estado: "rechazado",
        rechazadoBy: uid,
        rechazadoAt: now,
        motivoRechazo: motivo,
      });
      return res.json({ ok: true });
    }

    // ── addNote ───────────────────────────────────────────────────────────────
    if (action === "addNote") {
      const { targetUid, note } = body;
      await db.collection("users").doc(targetUid).update({
        adminNote: note,
        adminNoteAt: now,
        adminNoteBy: uid,
      });
      return res.json({ ok: true });
    }

    // ── extenderPlan ──────────────────────────────────────────────────────────
    // Extiende desde el expiry actual (no cambia de plan)
    if (action === "extenderPlan") {
      const { targetUid, meses = 1 } = body;
      const userDoc = await db.collection("users").doc(targetUid).get();
      const userData = userDoc.data() || {};
      let base = now;
      if (userData.planExpiry) {
        const currentExpiry = userData.planExpiry?._seconds
          ? new Date(userData.planExpiry._seconds * 1000)
          : userData.planExpiry?.toDate?.() || now;
        if (currentExpiry > now) base = currentExpiry;
      }
      const expiry = addMonths(base, meses);
      await db.collection("users").doc(targetUid).update({
        planExpiry: expiry,
        planExtendidoBy: uid,
        planExtendidoAt: now,
      });
      return res.json({ ok: true, expiry });
    }

    return res.status(400).json({ error: "Acción desconocida" });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
