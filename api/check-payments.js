// api/check-payments.js — Cron cada 10 min: matchea pagos USDT TRC20 pendientes
// contra las transferencias entrantes reales de la wallet (TronGrid) y los
// confirma solos: activa el plan, marca el pago y manda el mail de comprobante.
// Llamado desde vercel.json crons y protegido con CRON_SECRET.
//
// Cómo matchea (en orden de confianza):
//   1. Por TxID: el hash que pegó el cliente coincide con una transferencia real
//      a nuestra wallet (y el monto no difiere en más de 0.5 USDT).
//   2. Por monto exacto: cada pago pide centavos identificatorios únicos
//      (ej: 19.37) — si hay UNA sola transferencia con ese monto exacto posterior
//      al pedido, y ningún otro pago pendiente pide el mismo monto, es match.
// Cada transferencia se usa una sola vez (txMatch en el doc del pago).
// Lo que no matchea queda pendiente para confirmación manual en el panel Admin.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { guardCron } from "./_auth.js";
import { mpReconciliarCargas } from "./andreani.js";
import { acreditarComisionReferido, descontarCreditoAplicado } from "./referidos.js";

const WALLET = "TXGtDab6Lf3jtSRgq7uB2WbRfqdRA3PTCD"; // misma USDT_ADDRESS que muestra AppPlanes
const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"; // contrato oficial USDT en Tron

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
  })});
  return getFirestore();
}

function addMonths(date, n) { const d = new Date(date); d.setMonth(d.getMonth() + Number(n)); return d; }

async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return { error: "missing" };
  const from = process.env.RESEND_FROM || "Growith <onboarding@resend.dev>";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json();
    if (!r.ok) return { error: data?.message };
    return { ok: true };
  } catch (e) { return { error: e.message }; }
}

// Transferencias TRC20 entrantes confirmadas desde minTs (ms). Devuelve
// [{txid, from, monto, ts}] o null si TronGrid falló (para no "des-matchear").
async function fetchTransfers(minTs) {
  let url = `https://api.trongrid.io/v1/accounts/${WALLET}/transactions/trc20?only_confirmed=true&only_to=true&limit=100&contract_address=${USDT_CONTRACT}&min_timestamp=${minTs}`;
  const headers = { "Content-Type": "application/json" };
  if (process.env.TRONGRID_API_KEY) headers["TRON-PRO-API-KEY"] = process.env.TRONGRID_API_KEY;
  const out = [];
  try {
    // Hasta 3 páginas (300 transferencias) alcanza de sobra para una ventana de días
    for (let i = 0; i < 3 && url; i++) {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
      if (!r.ok) { console.error("[check-payments] TronGrid", r.status); return i === 0 ? null : out; }
      const j = await r.json();
      for (const t of (j.data || [])) {
        if ((t.to || "") !== WALLET) continue;
        const decimals = Number(t.token_info?.decimals ?? 6);
        const monto = Number(t.value || 0) / Math.pow(10, decimals);
        if (!monto) continue;
        out.push({ txid: String(t.transaction_id || ""), from: t.from || "", monto, ts: Number(t.block_timestamp || 0) });
      }
      url = j.meta?.links?.next || null;
    }
    return out;
  } catch (e) { console.error("[check-payments] TronGrid:", e.message); return out.length ? out : null; }
}

function comprobanteHtml(planNombre, hasta) {
  return `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6;color:#111">
    <p>¡Listo! Detectamos tu pago en la blockchain y tu plan <strong>${planNombre}</strong> ya está activo.</p>
    <p>Tenés acceso hasta el <strong>${hasta}</strong>. Te vamos a avisar unos días antes del vencimiento.</p>
    <p>Gracias por usar Growith.</p>
  </div>`;
}

export default async function handler(req, res) {
  if (!guardCron(req, res)) return;
  const db = initAdmin();
  const now = new Date();
  const results = { pendientes: 0, confirmados: 0, sinMatch: 0, ambiguos: 0, errores: 0 };

  // Backstop de Mercado Pago (saldo de envíos): si un webhook se perdió, acá
  // se reconcilian las cargas pendientes contra la API de MP y se acreditan.
  try {
    const mp = await mpReconciliarCargas(db);
    if (mp.acreditadas || mp.revision) console.log("[check-payments] mp_reconciliar:", JSON.stringify(mp));
    results.mp = mp;
  } catch (e) { console.error("[check-payments] mp_reconciliar:", e.message); }

  // Pagos cripto pendientes de los últimos 14 días (después de eso, manual)
  const snap = await db.collection("pagos")
    .where("estado", "==", "pendiente")
    .where("method", "==", "cripto")
    .limit(50).get();
  const toDate = (v) => v?.toDate?.() || (v?._seconds ? new Date(v._seconds * 1000) : null);
  const pendientes = snap.docs
    .map(d => ({ ref: d.ref, id: d.id, ...d.data() }))
    .filter(p => { const c = toDate(p.createdAt); return c && (now - c) < 14 * 86400000 && Number(p.amount) > 0; });
  results.pendientes = pendientes.length;
  if (!pendientes.length) return res.json({ ok: true, ...results });

  // Ventana de blockchain: desde el pedido más viejo, con 30 min de changüí
  const minTs = Math.min(...pendientes.map(p => toDate(p.createdAt).getTime())) - 30 * 60000;
  const transfers = await fetchTransfers(minTs);
  if (transfers === null) return res.status(200).json({ ok: false, error: "trongrid", ...results });

  // Extrae el hash real de lo que sea que pegó el cliente (URL de tronscan,
  // hash con 0x, espacios, mayúsculas). Si no hay 64 hex, devuelve "".
  const normHash = (h) => (String(h || "").toLowerCase().match(/[0-9a-f]{64}/) || [""])[0];

  // ¿Esta transferencia ya acreditó otro pago? (txMatch es único por diseño)
  const txUsada = async (txid) => {
    const q = await db.collection("pagos").where("txMatch", "==", txid).limit(1).get();
    return !q.empty;
  };

  for (const p of pendientes) {
    try {
      const amount = Number(p.amount);
      const creado = toDate(p.createdAt).getTime();
      let match = null;

      // 1) por TxID pegado por el cliente
      if (p.txHash) {
        const t = transfers.find(t => normHash(t.txid) === normHash(p.txHash));
        if (t && Math.abs(t.monto - amount) <= 0.5) match = t;
      }
      // 2) por monto exacto (centavos identificatorios). La transferencia puede
      // ser ANTERIOR al comprobante (hasta 7 días): el caso real es "pagué,
      // el envío del comprobante falló, lo reintenté al día siguiente".
      const VENTANA = 7 * 86400000;
      let ambiguo = false;
      if (!match) {
        const mismosCentavos = pendientes.filter(x => Math.abs(Number(x.amount) - amount) < 0.001);
        if (mismosCentavos.length === 1) {
          const cand = transfers.filter(t => Math.abs(t.monto - amount) < 0.001 && t.ts >= creado - VENTANA);
          if (cand.length === 1) match = cand[0];
          else if (cand.length > 1) ambiguo = true;
        } else ambiguo = true;
      }
      // 3) último recurso: monto aproximado (±0.6 USDT — gente que redondea,
      // p.ej. mandó 19.50 cuando el pedido era 19.44), único de ambos lados.
      if (!match && !ambiguo) {
        const parecidosPend = pendientes.filter(x => Math.abs(Number(x.amount) - amount) <= 1.2);
        const cand = transfers.filter(t => Math.abs(t.monto - amount) <= 0.6 && t.ts >= creado - VENTANA);
        if (parecidosPend.length === 1 && cand.length === 1) match = cand[0];
        else if (cand.length > 1) ambiguo = true;
      }
      if (match && await txUsada(match.txid)) match = null;
      if (!match) {
        if (ambiguo) results.ambiguos++; else results.sinMatch++;
        // Anotar el motivo en el pago (solo si cambió) para que el Admin vea
        // POR QUÉ el bot no lo acreditó, en vez de un pendiente mudo.
        const motivo = ambiguo ? "ambiguo" : (p.txHash ? "txid_no_encontrado" : "sin_match");
        if (p.autoCheckMotivo !== motivo) await p.ref.set({ autoCheckMotivo: motivo, autoCheckAt: now }, { merge: true }).catch(() => {});
        continue;
      }

      // Confirmación transaccional (misma semántica que confirmarPago del admin)
      const meses = Number(p.meses) || 1;
      const plan = p.plan === "facturador" ? "facturador" : "plus";
      const userRef = db.collection("users").doc(p.uid);
      const expiry = await db.runTransaction(async tx => {
        const [pagoSnap, userSnap] = await Promise.all([tx.get(p.ref), tx.get(userRef)]);
        if (!pagoSnap.exists || (pagoSnap.data().estado || "") !== "pendiente") throw new Error("YA_PROCESADO");
        const u = userSnap.data() || {};
        // Si un admin ya activó el plan A MANO después de creado este pago,
        // no volver a acreditar (sería un mes doble) — queda para revisión.
        const actAt = toDate(u.planActivadoAt);
        if (actAt && actAt > toDate(p.createdAt) && u.planActivadoBy && u.planActivadoBy !== "auto-tron") throw new Error("ACTIVADO_MANUAL");
        let base = now;
        const cur = toDate(u.planExpiry);
        if (cur && cur > now) base = cur;
        const exp = addMonths(base, meses);
        tx.update(userRef, { plan, planExpiry: exp, isTrial: false, cancelAtPeriodEnd: false, planActivadoBy: "auto-tron", planActivadoAt: now });
        tx.update(p.ref, { estado: "confirmado", mesesConfirmados: meses, confirmadoBy: "auto-tron", confirmadoAt: now, txMatch: match.txid, txFrom: match.from, autoCheckMotivo: FieldValue.delete() });
        return exp;
      });
      results.confirmados++;
      console.log(`[check-payments] ✓ ${p.id} → ${plan} x${meses}m (tx ${match.txid.slice(0, 12)}…)`);

      // Programa de referidos (best-effort, idempotente)
      const pd = { ...p, plan, mesesConfirmados: meses };
      await descontarCreditoAplicado(db, p.id, pd);
      await acreditarComisionReferido(db, p.id, pd);

      // Mail de comprobante (best-effort)
      const planNombre = plan === "facturador" ? "Facturador" : "Pro";
      const hasta = expiry.toLocaleDateString("es-AR", { day: "2-digit", month: "long", year: "numeric" });
      const email = p.email || (await userRef.get()).data()?.email;
      if (email) await sendEmail({ to: email, subject: `Tu plan ${planNombre} está activo`, html: comprobanteHtml(planNombre, hasta) });
    } catch (e) {
      if (e.message === "ACTIVADO_MANUAL") {
        results.sinMatch++;
        if (p.autoCheckMotivo !== "ya_activado_manualmente") await p.ref.set({ autoCheckMotivo: "ya_activado_manualmente", autoCheckAt: now }, { merge: true }).catch(() => {});
      } else if (e.message !== "YA_PROCESADO") { results.errores++; console.error(`[check-payments] ✗ ${p.id}:`, e.message); }
    }
  }

  // Heartbeat: prueba de vida del cron consultable desde Firestore
  await db.doc("system/pagos_check").set({ at: now, ...results }, { merge: false }).catch(() => {});

  // Alerta a soporte: pagos que llevan >30 min pendientes sin que el bot pueda
  // acreditarlos — para que un humano los mire HOY y el cliente no quede colgado.
  try {
    const colgados = pendientes.filter(p => !p.alertaAdminAt && (now - toDate(p.createdAt)) > 30 * 60000);
    if (colgados.length) {
      const filas = colgados.map(p => `<li>${p.email || p.uid} — $${p.amount} ${p.currency || ""} (${p.method}) — motivo bot: ${p.autoCheckMotivo || "sin revisar"}</li>`).join("");
      const r = await sendEmail({
        to: "contacto.growith@gmail.com",
        subject: `${colgados.length} pago(s) pendiente(s) sin acreditar — revisar en Admin`,
        html: `<div style="font-family:system-ui,sans-serif;font-size:14px"><p>El bot no pudo acreditar estos pagos solos:</p><ul>${filas}</ul><p>Confirmalos o rechazalos desde Admin → Cobros.</p></div>`,
      });
      if (r.ok) await Promise.all(colgados.map(p => p.ref.set({ alertaAdminAt: now }, { merge: true }).catch(() => {})));
    }
  } catch (e) { console.warn("[check-payments] alerta admin:", e.message); }

  console.log("[check-payments] resultado:", results);
  return res.json({ ok: true, ...results });
}
