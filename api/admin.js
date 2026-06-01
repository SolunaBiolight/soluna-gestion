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
      const activos     = usuarios.filter(u => u.plan && u.plan !== "free");
      // MRR: solo usuarios que pagaron (sin pruebas)
      const activosPagos = activos.filter(u => !u.isTrial);
      const mrrUsdt  = activosPagos.reduce((s, u) => s + (PLAN_PRICE_USDT[u.plan] || 0), 0);
      const mrrArs   = activosPagos.reduce((s, u) => s + (PLAN_PRICE_ARS[u.plan]  || 0), 0);

      const en7dias  = new Date(now); en7dias.setDate(en7dias.getDate() + 7);
      const vencenPronto = activos.filter(u => {
        const exp = u.planExpiry?._seconds
          ? new Date(u.planExpiry._seconds * 1000)
          : u.planExpiry?.toDate?.();
        return exp && exp >= now && exp <= en7dias;
      });

      // Revenue: solo pagos confirmados reales (no pruebas, no $0)
      const pagosReales = pagos.filter(p => p.estado === "confirmado" && !p.isTrial && Number(p.amount) > 0);
      const totalUSDT   = pagosReales.filter(p => p.currency === "USDT").reduce((s,p) => s + (Number(p.amount)||0), 0);
      const totalARS    = pagosReales.filter(p => p.currency === "ARS").reduce((s,p)  => s + (Number(p.amount)||0), 0);

      const stats = {
        totalUsuarios:    usuarios.length,
        // Pagaron (no trial)
        usuariosPlus:     usuarios.filter(u => u.plan === "plus" && !u.isTrial).length,
        usuariosFull:     usuarios.filter(u => u.plan === "full" && !u.isTrial).length,
        // Prueba (no cuentan en MRR)
        usuariosPlus_trial: usuarios.filter(u => u.plan === "plus" && u.isTrial).length,
        usuariosFull_trial: usuarios.filter(u => u.plan === "full" && u.isTrial).length,
        usuariosPrueba:   usuarios.filter(u => u.isTrial).length,
        pagosPendientes:  pagos.filter(p => p.estado === "pendiente").length,
        pagosRealesCount: pagosReales.length,
        countPruebas:     pagos.filter(p => p.isTrial).length,
        mrrUsdt,
        mrrArs,
        totalUSDT,
        totalARS,
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

    // ── gestionarPlan ─────────────────────────────────────────────────────────
    // Acción unificada: activa o extiende un plan por meses o días, real o prueba
    if (action === "gestionarPlan") {
      const { targetUid, plan, cantidad, unidad = "meses", isTrial = false } = body;
      const userDoc = await db.collection("users").doc(targetUid).get();
      const userData = userDoc.data() || {};
      let base = now;
      if (userData.planExpiry) {
        const cur = userData.planExpiry?._seconds
          ? new Date(userData.planExpiry._seconds * 1000)
          : userData.planExpiry?.toDate?.() || now;
        if (cur > now) base = cur;
      }
      let expiry;
      if (unidad === "dias") {
        expiry = new Date(base); expiry.setDate(expiry.getDate() + Number(cantidad));
      } else {
        expiry = addMonths(base, Number(cantidad));
      }
      await db.collection("users").doc(targetUid).update({
        plan, planExpiry: expiry, isTrial: !!isTrial,
        planActivadoBy: uid, planActivadoAt: now,
      });
      if (isTrial) {
        await db.collection("pagos").add({
          uid: targetUid, plan, method: "prueba", currency: "—", amount: 0,
          isTrial: true, cantidad: Number(cantidad), unidad,
          estado: "confirmado", confirmadoBy: uid, confirmadoAt: now, createdAt: now,
          nota: `Prueba: ${cantidad} ${unidad} de ${plan}`,
        });
      }
      return res.json({ ok: true, expiry });
    }

    // ── activarPrueba ─────────────────────────────────────────────────────────
    // Activa un plan sin cobro — crea registro con isTrial:true, no cuenta en revenue
    if (action === "activarPrueba") {
      const { targetUid, plan, meses = 1 } = body;
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
          plan, planExpiry: expiry, isTrial: true,
          planActivadoBy: uid, planActivadoAt: now,
        }),
        db.collection("pagos").add({
          uid: targetUid, plan, method: "prueba", currency: "—", amount: 0,
          isTrial: true, mesesConfirmados: Number(meses),
          estado: "confirmado", confirmadoBy: uid, confirmadoAt: now, createdAt: now,
          nota: `Plan de prueba (${meses}m) activado por admin`,
        }),
      ]);
      return res.json({ ok: true, expiry });
    }

    // ── ajustarDias ───────────────────────────────────────────────────────────
    // Suma o resta días al vencimiento actual (dias puede ser negativo)
    if (action === "ajustarDias") {
      const { targetUid, dias } = body;
      if (!targetUid || dias === undefined) return res.status(400).json({ error: "Faltan parámetros" });
      const userDoc = await db.collection("users").doc(targetUid).get();
      const userData = userDoc.data() || {};
      let base = userData.planExpiry?._seconds
        ? new Date(userData.planExpiry._seconds * 1000)
        : userData.planExpiry?.toDate?.() || now;
      const expiry = new Date(base);
      expiry.setDate(expiry.getDate() + Number(dias));
      await db.collection("users").doc(targetUid).update({
        planExpiry: expiry,
        planAjustadoBy: uid,
        planAjustadoAt: now,
        planAjusteDias: Number(dias),
      });
      return res.json({ ok: true, expiry });
    }

    // ── toggleAdmin — dar/quitar acceso admin a un usuario ──────────────
    if (action === "toggleAdmin") {
      const { targetUid } = body;
      if (!targetUid) return res.status(400).json({ error: "Falta targetUid" });
      // No se puede auto-quitar admin (seguridad mínima)
      if (targetUid === uid) return res.status(400).json({ error: "No podés quitarte el admin a vos mismo" });
      const userDoc = await db.collection("users").doc(targetUid).get();
      const current = userDoc.data()?.isAdmin || false;
      await db.collection("users").doc(targetUid).set({ isAdmin: !current }, { merge: true });
      return res.json({ ok: true, isAdmin: !current });
    }

    return res.status(400).json({ error: "Acción desconocida" });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
