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

function randomToken(len = 24) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let t = "";
  for (let i = 0; i < len; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const body = req.method === "GET" ? req.query : req.body;
  const { action, uid, token } = body;

  try {
    const db = initAdmin();
    const now = new Date();

    // ── ACCIONES PÚBLICAS (solo token, sin uid) ───────────────────────────────

    if (action === "getPublicData") {
      if (!token) return res.status(400).json({ error: "Token requerido" });
      const snap = await db.collection("colaboradores").where("token","==",token).limit(1).get();
      if (snap.empty) return res.status(404).json({ error: "Link inválido o expirado" });
      const colab = { _id: snap.docs[0].id, ...snap.docs[0].data() };
      // Sin orderBy para evitar índice compuesto — ordenamos en JS
      const tarSnap = await db.collection("tareas")
        .where("asignadoEmail","==",colab.email)
        .where("uid","==",colab.uid).get();
      const tareas = tarSnap.docs
        .map(d=>({_id:d.id,...d.data()}))
        .sort((a,b)=>(b.createdAt?._seconds||0)-(a.createdAt?._seconds||0));
      return res.json({ colab, tareas });
    }

    if (action === "publicUpdateEstado") {
      const { tareaId, estado } = body;
      if (!token || !tareaId) return res.status(400).json({ error: "Faltan parámetros" });
      const snap = await db.collection("colaboradores").where("token","==",token).limit(1).get();
      if (snap.empty) return res.status(403).json({ error: "Token inválido" });
      const colab = snap.docs[0].data();
      const ref = db.collection("tareas").doc(tareaId);
      const t = await ref.get();
      if (!t.exists || t.data().asignadoEmail !== colab.email) return res.status(403).json({ error: "No autorizado" });
      await ref.update({ estado, updatedAt: now });
      return res.json({ ok: true });
    }

    if (action === "publicAddEntrega") {
      const { tareaId, link, nota } = body;
      if (!token || !tareaId || !link) return res.status(400).json({ error: "Link de entrega requerido" });
      const snap = await db.collection("colaboradores").where("token","==",token).limit(1).get();
      if (snap.empty) return res.status(403).json({ error: "Token inválido" });
      const colab = snap.docs[0].data();
      const ref = db.collection("tareas").doc(tareaId);
      const t = await ref.get();
      if (!t.exists || t.data().asignadoEmail !== colab.email) return res.status(403).json({ error: "No autorizado" });
      const entrega = { link, nota: nota||"", fecha: now };
      const prev = t.data().deliverables || [];
      await ref.update({ deliverables:[...prev, entrega], estado:"entregado", updatedAt:now });
      return res.json({ ok: true, entrega });
    }

    // ── ACCIONES AUTENTICADAS (uid requerido) ─────────────────────────────────

    if (!uid) return res.status(403).json({ error: "No autorizado" });

    if (action === "getData") {
      // Sin orderBy para evitar índices compuestos — ordenamos en JS (válido para multicuenta)
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
      const { nombre, email, rol="" } = body;
      if (!nombre||!email) return res.status(400).json({ error:"Nombre y email requeridos" });
      const ex = await db.collection("colaboradores").where("uid","==",uid).where("email","==",email.toLowerCase()).limit(1).get();
      if (!ex.empty) return res.json({ _id:ex.docs[0].id, ...ex.docs[0].data() });
      const tok = randomToken(24);
      const data = { uid, nombre, email:email.toLowerCase(), rol, token:tok, createdAt:now };
      const ref = await db.collection("colaboradores").add(data);
      return res.json({ _id:ref.id, ...data });
    }

    if (action === "updateColaborador") {
      const { colabId, nombre, rol } = body;
      const upd = { updatedAt:now };
      if (nombre!==undefined) upd.nombre = nombre;
      if (rol!==undefined) upd.rol = rol;
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
      const { titulo, descripcion="", asignadoEmail, asignadoNombre="", brief="", links=[], deadline } = body;
      if (!titulo||!asignadoEmail) return res.status(400).json({ error:"Título y asignado requeridos" });
      const linksArr = Array.isArray(links) ? links : String(links).split("\n").map(l=>l.trim()).filter(Boolean);
      const data = {
        uid, titulo, descripcion, asignadoEmail, asignadoNombre,
        brief, links: linksArr,
        deadline: deadline ? new Date(deadline) : null,
        estado:"pendiente", deliverables:[], createdAt:now, updatedAt:now,
      };
      const ref = await db.collection("tareas").add(data);
      return res.json({ _id:ref.id, ...data });
    }

    if (action === "updateTarea") {
      const { tareaId, titulo, descripcion, brief, links, deadline, estado, asignadoEmail, asignadoNombre } = body;
      const clean = { updatedAt:now };
      if (titulo!==undefined) clean.titulo = titulo;
      if (descripcion!==undefined) clean.descripcion = descripcion;
      if (brief!==undefined) clean.brief = brief;
      if (links!==undefined) clean.links = Array.isArray(links) ? links : String(links).split("\n").map(l=>l.trim()).filter(Boolean);
      if (deadline!==undefined) clean.deadline = deadline ? new Date(deadline) : null;
      if (estado!==undefined) clean.estado = estado;
      if (asignadoEmail!==undefined) clean.asignadoEmail = asignadoEmail;
      if (asignadoNombre!==undefined) clean.asignadoNombre = asignadoNombre;
      await db.collection("tareas").doc(tareaId).update(clean);
      return res.json({ ok:true });
    }

    if (action === "updateEstado") {
      const { tareaId, estado } = body;
      await db.collection("tareas").doc(tareaId).update({ estado, updatedAt:now });
      return res.json({ ok:true });
    }

    if (action === "deleteTarea") {
      await db.collection("tareas").doc(body.tareaId).delete();
      return res.json({ ok:true });
    }

    return res.status(400).json({ error:"Acción desconocida" });

  } catch(e) {
    console.error("[tareas]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
