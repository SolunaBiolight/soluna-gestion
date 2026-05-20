// api/admin.js — Admin panel data (uses Firebase Admin SDK, bypasses security rules)

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const ADMIN_UIDS = ["WJH3ArqDPQcNLha9lOinvkVi9uJ2"];

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
  })});
  return getFirestore();
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { action, uid } = req.method === "GET" ? req.query : req.body;

  if (!uid || !ADMIN_UIDS.includes(uid)) {
    return res.status(403).json({ error: "No autorizado" });
  }

  const db = initAdmin();

  try {
    if (action === "getData") {
      const [pagSnap, usSnap] = await Promise.all([
        db.collection("pagos").orderBy("createdAt", "desc").get(),
        db.collection("users").get(),
      ]);
      const pagos   = pagSnap.docs.map(d => ({ _id: d.id, ...d.data() }));
      const usuarios = usSnap.docs.map(d => ({ _id: d.id, ...d.data() }));
      return res.json({ pagos, usuarios });
    }

    if (action === "activarPlan") {
      const { targetUid, plan, meses = 1 } = req.method === "GET" ? req.query : req.body;
      const expiry = new Date();
      expiry.setMonth(expiry.getMonth() + Number(meses));
      await db.collection("users").doc(targetUid).update({
        plan,
        planExpiry: expiry,
        planActivadoBy: uid,
        planActivadoAt: new Date(),
      });
      return res.json({ ok: true, expiry });
    }

    if (action === "desactivarPlan") {
      const { targetUid } = req.method === "GET" ? req.query : req.body;
      await db.collection("users").doc(targetUid).update({ plan: "free", planExpiry: null });
      return res.json({ ok: true });
    }

    if (action === "confirmarPago") {
      const { pagoId, targetUid, plan } = req.method === "GET" ? req.query : req.body;
      const expiry = new Date();
      expiry.setMonth(expiry.getMonth() + 1);
      await Promise.all([
        db.collection("users").doc(targetUid).update({
          plan,
          planExpiry: expiry,
          planActivadoBy: uid,
          planActivadoAt: new Date(),
        }),
        db.collection("pagos").doc(pagoId).update({
          estado: "confirmado",
          confirmadoBy: uid,
          confirmadoAt: new Date(),
        }),
      ]);
      return res.json({ ok: true, expiry });
    }

    if (action === "rechazarPago") {
      const { pagoId } = req.method === "GET" ? req.query : req.body;
      await db.collection("pagos").doc(pagoId).update({ estado: "rechazado" });
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: "Acción desconocida" });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
