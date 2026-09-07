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
import { guardUid, guardCron } from "./_auth.js";

async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return { error: "missing" };
  const from = process.env.RESEND_FROM || "Growith <onboarding@resend.dev>";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html }), signal: AbortSignal.timeout(10000),
    });
    return r.ok ? { ok: true } : { error: (await r.json().catch(() => ({})))?.message };
  } catch (e) { return { error: e.message }; }
}
const fmtARS = n => "$" + Math.round(Number(n) || 0).toLocaleString("es-AR");
const fmtMonto = (m, mon) => mon === "USD" ? "USD " + Math.round(Number(m) || 0).toLocaleString("es-AR") : fmtARS(m);

const CATEGORIAS = ["alquiler", "prestamo", "tarjeta", "proveedor", "producto", "envio", "impuestos", "servicios", "sueldos", "otro"];
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
// Misma YYYY-MM de `fecha` con el día `dia` (acotado al último día del mes).
function mismoMesDia(fecha, dia) {
  const [y, m] = fecha.split("-").map(Number);
  const ult = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(Math.min(Math.max(1, parseInt(dia) || 1), ult)).padStart(2, "0")}`;
}
const sumarDias = (fecha, n) => new Date(Date.parse(fecha + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);

// Índice para el cron de avisos: fechas (YYYY-MM-DD) con pagos pendientes en
// los próximos 45 días, guardadas en users/{uid}.pagosCalDias. El cron busca
// con array-contains (sin índice compuesto) y solo lee a quien tiene algo mañana.
async function actualizarIndiceAvisos(db, uid, col) {
  try {
    const hoy = hoyAR(), lim = sumarDias(hoy, 45);
    const snap = await col.where("pagado", "==", false).get();
    const dias = new Set();
    snap.forEach(d => { const v = d.data().vence; if (v && v >= hoy && v <= lim) dias.add(v); });
    await db.collection("users").doc(uid).set({ pagosCalDias: [...dias].sort() }, { merge: true });
  } catch (e) { console.warn("[pagos-cal] indice avisos:", e.message); }
}
// Sistema francés: cuota fija; interés sobre saldo, capital = cuota − interés.
// tna en % anual. Sin tasa: cuota = capital / n, sin interés.
function cuadroAmortizacion(capital, n, tna, cuotaFija) {
  const i = (Number(tna) || 0) / 100 / 12;
  let cuota = Number(cuotaFija) || 0;
  if (!cuota) cuota = i > 0 ? capital * i / (1 - Math.pow(1 + i, -n)) : capital / n;
  const filas = []; let saldo = capital;
  for (let k = 1; k <= n; k++) {
    const interes = i > 0 ? saldo * i : Math.max(0, (cuota * n - capital) / n);
    const cap = Math.min(saldo, cuota - interes);
    saldo = Math.max(0, saldo - cap);
    filas.push({ cuota: Math.round(cuota * 100) / 100, interes: Math.round(interes * 100) / 100, capital: Math.round(cap * 100) / 100, saldo: Math.round(saldo * 100) / 100 });
  }
  return filas;
}

function limpiar(p, base = {}) {
  const out = { ...base };
  if (p.titulo !== undefined) out.titulo = String(p.titulo || "").trim().slice(0, 120);
  if (p.categoria !== undefined) out.categoria = CATEGORIAS.includes(p.categoria) ? p.categoria : "otro";
  if (p.monto !== undefined) out.monto = Math.max(0, Math.round((Number(p.monto) || 0) * 100) / 100);
  if (p.moneda !== undefined) out.moneda = p.moneda === "USD" ? "USD" : "ARS";
  if (p.vence !== undefined && esFecha(p.vence)) out.vence = p.vence;
  if (p.notas !== undefined) out.notas = String(p.notas || "").slice(0, 1000);
  if (p.tipo !== undefined) out.tipo = ["unico", "mensual", "cuotas", "pedido"].includes(p.tipo) ? p.tipo : "unico";
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://www.growithapp.com");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── Cron diario: aviso por mail el día ANTERIOR al vencimiento ──────────
  if (req.query.action === "cron_avisos") {
    if (!guardCron(req, res)) return;
    const db = initAdmin();
    const manana = sumarDias(hoyAR(), 1);
    const out = { usuarios: 0, mails: 0, errores: 0 };
    try {
      const us = await db.collection("users").where("pagosCalDias", "array-contains", manana).limit(500).get();
      for (const u of us.docs) {
        const col = db.collection("users").doc(u.id).collection("pagos_cal");
        const snap = await col.where("vence", "==", manana).where("pagado", "==", false).get();
        const items = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => !p.avisoAt);
        if (!items.length) continue;
        const email = u.data().email;
        if (!email) continue;
        out.usuarios++;
        const totalARS = items.filter(p => p.moneda !== "USD").reduce((s, p) => s + (Number(p.monto) || 0), 0);
        const totalUSD = items.filter(p => p.moneda === "USD").reduce((s, p) => s + (Number(p.monto) || 0), 0);
        const filas = items.map(p => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${String(p.titulo || "").replace(/</g, "&lt;")}${p.cuotaN ? ` <span style="color:#888">cuota ${p.cuotaN}/${p.cuotaTotal}</span>` : ""}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:600">${fmtMonto(p.monto, p.moneda)}</td></tr>`).join("");
        const tot = [totalARS ? fmtARS(totalARS) : "", totalUSD ? "USD " + Math.round(totalUSD).toLocaleString("es-AR") : ""].filter(Boolean).join(" + ");
        const [y, m, d] = manana.split("-");
        const r = await sendEmail({
          to: email,
          subject: `Mañana vence${items.length === 1 ? "" : "n"} ${items.length} pago${items.length === 1 ? "" : "s"} por ${tot}`,
          html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6;color:#111;max-width:520px">
            <p>Te recordamos lo que vence <strong>mañana ${d}/${m}/${y}</strong> según tu Calendario de Pagos:</p>
            <table style="border-collapse:collapse;width:100%;font-size:14px">${filas}</table>
            <p style="margin-top:12px"><strong>Total: ${tot}</strong></p>
            <p style="font-size:13px;color:#666">Cuando lo pagues, marcalo como pagado en Growith → Calendario de Pagos y dejás de recibir avisos por ese vencimiento.</p>
          </div>`,
        });
        if (r.ok) { out.mails++; const b = db.batch(); items.forEach(p => b.set(col.doc(p.id), { avisoAt: new Date() }, { merge: true })); await b.commit(); }
        else out.errores++;
      }
    } catch (e) { console.error("[pagos-cal cron]", e.message); out.error = e.message; }
    console.log("[pagos-cal cron_avisos]", JSON.stringify(out));
    return res.json({ ok: true, ...out });
  }

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
        // Serie dividida en partes del mes (sueldo 50/50): cada parte se extiende por su lado.
        // Grupos ya divididos: los docs sin parteMes son los pagados de antes de
        // dividir (no forman serie) o duplicados generados por la extensión —
        // los pendientes sin parte se borran, y ese subgrupo no se extiende.
        const divididos = new Set(items.filter(it => it.parteMes).map(it => it.grupo));
        const espurios = items.filter(it => it.tipo === "mensual" && it.grupo && divididos.has(it.grupo) && !it.parteMes && !it.pagado);
        if (espurios.length) { const b = db.batch(); espurios.forEach(it => b.delete(col.doc(it.id))); await b.commit(); items = items.filter(it => !espurios.includes(it)); }
        // Pagados del mes en curso que quedaron enteros al dividir: se parten
        // (primera parte pagada) y se crea la segunda parte pendiente.
        const mesAct = hoy.slice(0, 7);
        const huerfanos = items.filter(it => it.tipo === "mensual" && it.grupo && divididos.has(it.grupo) && !it.parteMes && it.pagado && String(it.vence).slice(0, 7) >= mesAct);
        if (huerfanos.length) {
          const b = db.batch(); const extra = [];
          for (const it of huerfanos) {
            const p1 = items.find(x => x.grupo === it.grupo && x.parteMes === 1), p2 = items.find(x => x.grupo === it.grupo && x.parteMes === 2);
            if (!p1 || !p2) continue;
            const pct = Number(p1.pct) || 50, dia = Number(String(p2.vence).slice(8, 10)) || 15;
            const m1 = Math.round(Number(it.monto) * pct) / 100, m2 = Math.round((Number(it.monto) - m1) * 100) / 100;
            const base = String(it.titulo || "").replace(/ · (1ª|2ª) parte$/, "");
            b.set(col.doc(it.id), { monto: m1, titulo: `${base} · 1ª parte`, parteMes: 1, pct, updatedAt: now }, { merge: true });
            const r2 = col.doc();
            const d2 = { titulo: `${base} · 2ª parte`, categoria: it.categoria, monto: m2, moneda: it.moneda, notas: it.notas || "", tipo: "mensual", grupo: it.grupo, parteMes: 2, pct: 100 - pct, vence: mismoMesDia(it.vence, dia), pagado: false, creado: now, updatedAt: now };
            b.set(r2, d2); extra.push({ id: r2.id, ...d2 });
            it.monto = m1; it.titulo = `${base} · 1ª parte`; it.parteMes = 1; it.pct = pct;
          }
          await b.commit(); items = items.concat(extra);
        }
        for (const it of items) if (it.tipo === "mensual" && it.grupo && !(divididos.has(it.grupo) && !it.parteMes)) (porGrupo[it.grupo + "|" + (it.parteMes || 0)] ||= []).push(it);
        const nuevos = [];
        for (const [grupo, arr] of Object.entries(porGrupo)) {
          arr.sort((a, b) => a.vence.localeCompare(b.vence));
          const ult = arr[arr.length - 1];
          if (ult.serieCerrada || ult.vence > limite) continue;
          const batch = db.batch();
          for (let i = 1; i <= 12; i++) {
            const ref = col.doc();
            const doc = { titulo: ult.titulo, categoria: ult.categoria, monto: ult.monto, moneda: ult.moneda, notas: ult.notas || "", tipo: "mensual", grupo: ult.grupo, ...(ult.parteMes ? { parteMes: ult.parteMes } : {}), vence: sumarMeses(ult.vence, i), pagado: false, creado: now, updatedAt: now };
            batch.set(ref, doc); nuevos.push({ id: ref.id, ...doc });
          }
          await batch.commit();
        }
        items = items.concat(nuevos);
        if (nuevos.length) await actualizarIndiceAvisos(db, uid, col);
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
          const cambioDia = patch.vence && patch.vence !== cur.data().vence ? Number(patch.vence.slice(8, 10)) : null;
          const miParte = cur.data().parteMes || 0;
          q.docs.forEach(d => { const x = d.data(); if (d.id !== ref.id && !x.pagado && (x.parteMes || 0) === miParte) batch.set(d.ref, { titulo: patch.titulo ?? x.titulo, categoria: patch.categoria ?? x.categoria, monto: patch.monto ?? x.monto, moneda: patch.moneda ?? x.moneda, notas: patch.notas ?? x.notas, ...(cambioDia ? { vence: mismoMesDia(x.vence, cambioDia) } : {}), updatedAt: now }, { merge: true }); });
          await batch.commit();
        }
        await actualizarIndiceAvisos(db, uid, col);
        return res.json({ ok: true, id: ref.id });
      }
      // ── Pedido de mercadería: N partes (%, fecha) + detalle de ítems ──
      if (body.pedido && typeof body.pedido === "object") {
        const pd = body.pedido;
        const nombre = String(pd.nombre || "").trim().slice(0, 120);
        const moneda = pd.moneda === "USD" ? "USD" : "ARS";
        const items = (Array.isArray(pd.items) ? pd.items : []).slice(0, 80).map(it => ({
          key: String(it.key || "").slice(0, 80), nombre: String(it.nombre || "").slice(0, 120), variante: String(it.variante || "").slice(0, 80), sku: String(it.sku || "").slice(0, 60),
          cantidad: Math.max(0, parseInt(it.cantidad) || 0), costo: Math.max(0, Math.round((Number(it.costo) || 0) * 100) / 100),
        })).filter(it => it.nombre && it.cantidad > 0);
        const total = Math.round(items.reduce((s, it) => s + it.cantidad * it.costo, 0) * 100) / 100;
        const partes = (Array.isArray(pd.partes) ? pd.partes : []).slice(0, 12).map(x => ({ label: String(x.label || "").trim().slice(0, 60), pct: Math.max(0, Number(x.pct) || 0), fecha: esFecha(x.fecha) ? x.fecha : null }));
        if (!nombre) return res.status(400).json({ error: "Falta el nombre del pedido" });
        if (!items.length || !(total > 0)) return res.status(400).json({ error: "El pedido necesita al menos un ítem con cantidad y costo" });
        if (!partes.length || partes.some(x => !x.fecha || !x.label)) return res.status(400).json({ error: "Cada parte necesita nombre y fecha" });
        const sumPct = partes.reduce((s, x) => s + x.pct, 0);
        if (Math.abs(sumPct - 100) > 0.01) return res.status(400).json({ error: "Los porcentajes tienen que sumar 100%" });
        const grupo = col.doc().id;
        const unidades = items.reduce((s, it) => s + it.cantidad, 0);
        const pedido = { nombre, moneda, items, total, unidades, partes: partes.length };
        const batch = db.batch(); const ids = [];
        let acum = 0;
        partes.forEach((x, i) => {
          const ref = col.doc(); ids.push(ref.id);
          // La última parte absorbe el redondeo para que las partes sumen el total exacto.
          const monto = i === partes.length - 1 ? Math.round((total - acum) * 100) / 100 : Math.round(total * x.pct) / 100;
          acum += monto;
          batch.set(ref, { titulo: `${nombre} · ${x.label} ${x.pct}%`, categoria: "producto", monto, moneda, notas: String(p.notas || "").slice(0, 1000), tipo: "pedido",
            grupo, parteN: i + 1, partes: partes.length, parteLabel: x.label, pct: x.pct, pedido, vence: x.fecha, pagado: false, creado: now, updatedAt: now });
        });
        await batch.commit();
        await actualizarIndiceAvisos(db, uid, col);
        return res.json({ ok: true, ids, grupo });
      }

      const base = limpiar(p, { titulo: "", categoria: "otro", monto: 0, moneda: "ARS", notas: "", tipo: "unico" });
      if (!base.titulo) return res.status(400).json({ error: "Falta el concepto (a quién o qué se paga)" });
      if (!base.vence) return res.status(400).json({ error: "Falta la fecha de vencimiento" });
      if (!(base.monto > 0) && !(base.tipo === "cuotas" && Number(p.capital) > 0)) return res.status(400).json({ error: "El monto tiene que ser mayor a cero" });
      const batch = db.batch(); const ids = [];
      if (base.tipo === "cuotas") {
        const total = Math.min(MAX_CUOTAS, Math.max(2, parseInt(p.cuotasTotal) || 2));
        const desde = Math.min(total, Math.max(1, parseInt(p.cuotaDesde) || 1));
        const grupo = col.doc().id;
        // Préstamo: capital + TNA (o cuota conocida) → cuadro de amortización.
        // Cada cuota guarda su parte de capital e interés y el saldo restante.
        const capital = Math.max(0, Number(p.capital) || 0);
        const tna = Math.max(0, Number(p.tna) || 0);
        const cuadro = capital > 0 ? cuadroAmortizacion(capital, total, tna, base.monto) : null;
        const prestamo = capital > 0 ? { capital, tna, cuotaCalculada: cuadro[0].cuota, interesTotal: Math.round(cuadro.reduce((s, f) => s + f.interes, 0) * 100) / 100 } : null;
        for (let n = desde; n <= total; n++) {
          const ref = col.doc(); ids.push(ref.id);
          const f = cuadro ? cuadro[n - 1] : null;
          batch.set(ref, { ...base, ...(f ? { monto: f.cuota, capitalCuota: f.capital, interesCuota: f.interes, saldoDespues: f.saldo } : {}), ...(prestamo ? { prestamo } : {}),
            grupo, cuotaN: n, cuotaTotal: total, vence: sumarMeses(base.vence, n - desde), pagado: false, creado: now, updatedAt: now });
        }
      } else if (base.tipo === "mensual") {
        const grupo = col.doc().id;
        // Dividido desde el alta (sueldo 50/50): dos pagos por mes.
        const dv = p.dividir && typeof p.dividir === "object" ? { pct: Math.min(99, Math.max(1, Number(p.dividir.pct) || 50)), dia: Math.min(31, Math.max(1, parseInt(p.dividir.dia) || 15)) } : null;
        for (let i = 0; i < 12; i++) {
          const vence = sumarMeses(base.vence, i);
          if (dv) {
            const m1 = Math.round(base.monto * dv.pct) / 100, m2 = Math.round((base.monto - m1) * 100) / 100;
            const r1 = col.doc(), r2 = col.doc(); ids.push(r1.id, r2.id);
            batch.set(r1, { ...base, titulo: `${base.titulo} · 1ª parte`, monto: m1, grupo, parteMes: 1, pct: dv.pct, vence, pagado: false, creado: now, updatedAt: now });
            batch.set(r2, { ...base, titulo: `${base.titulo} · 2ª parte`, monto: m2, grupo, parteMes: 2, pct: 100 - dv.pct, vence: mismoMesDia(vence, dv.dia), pagado: false, creado: now, updatedAt: now });
          } else {
            const ref = col.doc(); ids.push(ref.id);
            batch.set(ref, { ...base, grupo, vence, pagado: false, creado: now, updatedAt: now });
          }
        }
      } else {
        const ref = col.doc(); ids.push(ref.id);
        batch.set(ref, { ...base, pagado: false, creado: now, updatedAt: now });
      }
      await batch.commit();
      await actualizarIndiceAvisos(db, uid, col);
      return res.json({ ok: true, ids });
    }

    if (action === "pagar") {
      const ref = col.doc(String(body.id || ""));
      if (!(await ref.get()).exists) return res.status(404).json({ error: "El pago no existe" });
      const pagado = !!body.pagado;
      await ref.set({ pagado, pagadoAt: pagado ? (esFecha(body.fechaPago) ? body.fechaPago : hoyAR()) : FieldValue.delete(), updatedAt: now }, { merge: true });
      await actualizarIndiceAvisos(db, uid, col);
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
        await actualizarIndiceAvisos(db, uid, col);
        return res.json({ ok: true, borrados: n });
      }
      // Borrar una sola ocurrencia de una serie mensual: marcar la serie como
      // cerrada si era la última, para que no se regenere sola.
      await ref.delete();
      await actualizarIndiceAvisos(db, uid, col);
      return res.json({ ok: true, borrados: 1 });
    }

    // Dividir una serie mensual en dos pagos por mes (ej. sueldo 50% los
    // primeros días y 50% a mitad de mes). Solo toca los pendientes.
    if (action === "dividir_serie") {
      const grupo = String(body.grupo || "");
      const pct = Math.min(99, Math.max(1, Number(body.pct) || 50));
      const dia = Math.min(31, Math.max(1, parseInt(body.dia) || 15));
      const l1 = String(body.label1 || "1ª parte").trim().slice(0, 30), l2 = String(body.label2 || "2ª parte").trim().slice(0, 30);
      if (!grupo) return res.status(400).json({ error: "Falta grupo" });
      const q = await col.where("grupo", "==", grupo).get();
      if (q.docs.some(d => d.data().parteMes)) return res.status(400).json({ error: "Esta serie ya está dividida" });
      const batch = db.batch(); let n = 0;
      const mesActual = hoyAR().slice(0, 7);
      q.docs.forEach(d => {
        const x = d.data();
        // Pagado de meses anteriores: se deja como está. Pagado del mes en
        // curso: se asume que se pagó la primera parte y se crea la segunda.
        if (x.pagado && String(x.vence).slice(0, 7) < mesActual) return;
        const m1 = Math.round(Number(x.monto) * pct) / 100, m2 = Math.round((Number(x.monto) - m1) * 100) / 100;
        const base = String(x.titulo || "").replace(/ · (1ª|2ª) parte$/, "");
        batch.set(d.ref, { monto: m1, titulo: `${base} · ${l1}`, parteMes: 1, pct, updatedAt: now }, { merge: true });
        const ref2 = col.doc();
        batch.set(ref2, { titulo: `${base} · ${l2}`, categoria: x.categoria, monto: m2, moneda: x.moneda, notas: x.notas || "", tipo: x.tipo || "mensual", grupo, parteMes: 2, pct: 100 - pct, vence: mismoMesDia(x.vence, dia), pagado: false, creado: now, updatedAt: now });
        n++;
      });
      await batch.commit();
      await actualizarIndiceAvisos(db, uid, col);
      return res.json({ ok: true, meses: n });
    }

    if (action === "cerrar_serie") {
      const grupo = String(body.grupo || "");
      if (!grupo) return res.status(400).json({ error: "Falta grupo" });
      const q = await col.where("grupo", "==", grupo).get();
      const hoy = hoyAR();
      const batch = db.batch(); let n = 0;
      q.docs.forEach(d => { const x = d.data(); if (!x.pagado && x.vence > hoy) { batch.delete(d.ref); n++; } else batch.set(d.ref, { serieCerrada: true }, { merge: true }); });
      await batch.commit();
      await actualizarIndiceAvisos(db, uid, col);
      return res.json({ ok: true, borrados: n });
    }

    return res.status(400).json({ error: "Acción desconocida" });
  } catch (e) {
    console.error("[pagos-cal]", action, e.message);
    return res.status(500).json({ error: e.message });
  }
}
