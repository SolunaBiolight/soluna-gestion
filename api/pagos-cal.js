// api/pagos-cal.js — Calendario de Pagos: obligaciones del negocio (alquiler,
// préstamos, cuotas, tarjetas, proveedores, impuestos, sueldos, servicios).
//
//   POST {action, uid, ...}   — token obligatorio, atado al uid (o miembro con
//                               la sección "calendario" habilitada).
//   list                      → todos los pagos de users/{uid}/pagos_cal. Las
//                               series mensuales se extienden solas 12 meses.
//   resumen                   → {vencidos, hoy, manana} para el badge del sidebar.
//   save {pago}               → alta/edición. Alta de "cuotas" genera N docs y
//                               "mensual" genera 12; todos comparten `grupo`.
//   pagar {id, pagado, fechaPago}
//   delete {id, serie:bool}   → uno solo, o toda la serie pendiente del grupo.
//
// Vía Admin SDK (las reglas del cliente no cubren subcolecciones nuevas).

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { guardUid } from "./_auth.js";

const CATEGORIAS = ["alquiler", "prestamo", "tarjeta", "proveedor", "impuestos", "servicios", "sueldos", "otro"];
const MAX_CUOTAS = 120;

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
  })});
  return getFirestore();
}
const hoyAR = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
const esFecha = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
// Suma meses a YYYY-MM-DD conservando el día (31/ene + 1 → 28/feb, no 3/mar).
function sumarMeses(fecha, n) {
  const [y, m, d] = fecha.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const ult = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(d, ult)).padStart(2, "0")}`;
}
const sumarDias = (fecha, n) => new Date(Date.parse(fecha + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);

function limpiar(p, base = {}) {
  const out = { ...base };
  if (p.titulo !== undefined) out.titulo = String(p.titulo || "").trim().slice(0, 120);
  if (p.categoria !== undefined) out.categoria = CATEGORIAS.includes(p.categoria) ? p.categoria : "otro";
  if (p.monto !== undefined) out.monto = Math.max(0, Math.round((Number(p.monto) || 0) * 100) / 100);
  if (p.moneda !== undefined) out.moneda = p.moneda === "USD" ? "USD" : "ARS";
  if (p.vence !== undefined && esFecha(p.vence)) out.vence = p.vence;
  if (p.notas !== undefined) out.notas = String(p.notas || "").slice(0, 1000);
  if (p.tipo !== undefined) out.tipo = ["unico", "mensual", "cuotas"].includes(p.tipo) ? p.tipo : "unico";
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://www.growithapp.com");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST" });

  let body = {};
  if (req.body && typeof req.body === "object") body = req.body;
  else {
    const raw = await new Promise(resolve => { const c = []; req.on("data", x => c.push(x)); req.on("end", () => resolve(Buffer.concat(c).toString())); req.on("error", () => resolve("")); });
    try { body = raw ? JSON.parse(raw) : {}; } catch { return res.status(400).json({ error: "Body JSON inválido" }); }
  }
  const { action, uid } = body;
  if (!uid) return res.status(401).json({ error: "Falta uid" });
  if (!(await guardUid(req, res, uid, "calendario"))) return;

  const db = initAdmin();
  const col = db.collection("users").doc(uid).collection("pagos_cal");
  const now = new Date();

  try {
    if (action === "list" || action === "resumen") {
      const snap = await col.get();
      let items = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      // Series mensuales: si a la última ocurrencia le quedan menos de 60 días,
      // se generan 12 meses más (misma plantilla que la última).
      if (action === "list") {
        const hoy = hoyAR(); const limite = sumarDias(hoy, 60);
        const porGrupo = {};
        for (const it of items) if (it.tipo === "mensual" && it.grupo) (porGrupo[it.grupo] ||= []).push(it);
        const nuevos = [];
        for (const [grupo, arr] of Object.entries(porGrupo)) {
          arr.sort((a, b) => a.vence.localeCompare(b.vence));
          const ult = arr[arr.length - 1];
          if (ult.serieCerrada || ult.vence > limite) continue;
          const batch = db.batch();
          for (let i = 1; i <= 12; i++) {
            const ref = col.doc();
            const doc = { titulo: ult.titulo, categoria: ult.categoria, monto: ult.monto, moneda: ult.moneda, notas: ult.notas || "", tipo: "mensual", grupo, vence: sumarMeses(ult.vence, i), pagado: false, creado: now, updatedAt: now };
            batch.set(ref, doc); nuevos.push({ id: ref.id, ...doc });
          }
          await batch.commit();
        }
        items = items.concat(nuevos);
      }
      items.sort((a, b) => String(a.vence).localeCompare(String(b.vence)));
      if (action === "resumen") {
        const hoy = hoyAR(), man = sumarDias(hoy, 1);
        const pend = items.filter(i => !i.pagado);
        return res.json({ vencidos: pend.filter(i => i.vence < hoy).length, hoy: pend.filter(i => i.vence === hoy).length, manana: pend.filter(i => i.vence === man).length });
      }
      return res.json({ items: items.map(i => ({ ...i, creado: i.creado?.toDate?.()?.toISOString?.() || null, updatedAt: i.updatedAt?.toDate?.()?.toISOString?.() || null, pagadoAt: i.pagadoAt?.toDate?.()?.toISOString?.() || i.pagadoAt || null })) });
    }

    if (action === "save") {
      const p = body.pago || {};
      if (p.id) {
        const ref = col.doc(String(p.id));
        const cur = await ref.get();
        if (!cur.exists) return res.status(404).json({ error: "El pago no existe" });
        const patch = limpiar(p);
        delete patch.tipo;
        if (!patch.titulo && p.titulo !== undefined) return res.status(400).json({ error: "Falta el concepto" });
        await ref.set({ ...patch, updatedAt: now }, { merge: true });
        // Propagar cambios de monto/título/categoría al resto de la serie pendiente
        if (body.aplicarSerie && cur.data().grupo) {
          const q = await col.where("grupo", "==", cur.data().grupo).get();
          const batch = db.batch();
          q.docs.forEach(d => { if (d.id !== ref.id && !d.data().pagado) batch.set(d.ref, { titulo: patch.titulo ?? d.data().titulo, categoria: patch.categoria ?? d.data().categoria, monto: patch.monto ?? d.data().monto, moneda: patch.moneda ?? d.data().moneda, notas: patch.notas ?? d.data().notas, updatedAt: now }, { merge: true }); });
          await batch.commit();
        }
        return res.json({ ok: true, id: ref.id });
      }
      const base = limpiar(p, { titulo: "", categoria: "otro", monto: 0, moneda: "ARS", notas: "", tipo: "unico" });
      if (!base.titulo) return res.status(400).json({ error: "Falta el concepto (a quién o qué se paga)" });
      if (!base.vence) return res.status(400).json({ error: "Falta la fecha de vencimiento" });
      if (!(base.monto > 0)) return res.status(400).json({ error: "El monto tiene que ser mayor a cero" });
      const batch = db.batch(); const ids = [];
      if (base.tipo === "cuotas") {
        const total = Math.min(MAX_CUOTAS, Math.max(2, parseInt(p.cuotasTotal) || 2));
        const desde = Math.min(total, Math.max(1, parseInt(p.cuotaDesde) || 1));
        const grupo = col.doc().id;
        for (let n = desde; n <= total; n++) {
          const ref = col.doc(); ids.push(ref.id);
          batch.set(ref, { ...base, grupo, cuotaN: n, cuotaTotal: total, vence: sumarMeses(base.vence, n - desde), pagado: false, creado: now, updatedAt: now });
        }
      } else if (base.tipo === "mensual") {
        const grupo = col.doc().id;
        for (let i = 0; i < 12; i++) {
          const ref = col.doc(); ids.push(ref.id);
          batch.set(ref, { ...base, grupo, vence: sumarMeses(base.vence, i), pagado: false, creado: now, updatedAt: now });
        }
      } else {
        const ref = col.doc(); ids.push(ref.id);
        batch.set(ref, { ...base, pagado: false, creado: now, updatedAt: now });
      }
      await batch.commit();
      return res.json({ ok: true, ids });
    }

    if (action === "pagar") {
      const ref = col.doc(String(body.id || ""));
      if (!(await ref.get()).exists) return res.status(404).json({ error: "El pago no existe" });
      const pagado = !!body.pagado;
      await ref.set({ pagado, pagadoAt: pagado ? (esFecha(body.fechaPago) ? body.fechaPago : hoyAR()) : FieldValue.delete(), updatedAt: now }, { merge: true });
      return res.json({ ok: true });
    }

    if (action === "delete") {
      const ref = col.doc(String(body.id || ""));
      const snap = await ref.get();
      if (!snap.exists) return res.json({ ok: true, borrados: 0 });
      const grupo = snap.data().grupo;
      if (body.serie && grupo) {
        const q = await col.where("grupo", "==", grupo).get();
        const batch = db.batch(); let n = 0;
        q.docs.forEach(d => { if (!d.data().pagado) { batch.delete(d.ref); n++; } });
        await batch.commit();
        return res.json({ ok: true, borrados: n });
      }
      // Borrar una sola ocurrencia de una serie mensual: marcar la serie como
      // cerrada si era la última, para que no se regenere sola.
      await ref.delete();
      return res.json({ ok: true, borrados: 1 });
    }

    if (action === "cerrar_serie") {
      const grupo = String(body.grupo || "");
      if (!grupo) return res.status(400).json({ error: "Falta grupo" });
      const q = await col.where("grupo", "==", grupo).get();
      const hoy = hoyAR();
      const batch = db.batch(); let n = 0;
      q.docs.forEach(d => { const x = d.data(); if (!x.pagado && x.vence > hoy) { batch.delete(d.ref); n++; } else batch.set(d.ref, { serieCerrada: true }, { merge: true }); });
      await batch.commit();
      return res.json({ ok: true, borrados: n });
    }

    return res.status(400).json({ error: "Acción desconocida" });
  } catch (e) {
    console.error("[pagos-cal]", action, e.message);
    return res.status(500).json({ error: e.message });
  }
}
