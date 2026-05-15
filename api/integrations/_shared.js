// api/integrations/shared.js
// Utilidades compartidas entre integraciones (Shopify, TN, ML)
// Diseño: ver api/integrations/README.md

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
    }),
  });
  return getFirestore();
}

/**
 * Schema interno normalizado que esperan `parsearCSV` y `emit` en api/arca.js.
 * Cada integración debe transformar su payload nativo a este formato.
 */
export const ORDEN_SCHEMA = {
  // string — identificador único de la orden en la plataforma origen
  orderId: "string",
  // nombre del comprador
  nombre: "string",
  email: "string",
  // doc_tipo ∈ {CUIT, DNI, CF} — usar clasificarDoc() de api/arca.js
  doc_tipo: "string",
  doc_nro: "string",
  dni: "string",
  // totales (con IVA incluido)
  total: "number",
  subtotal: "number",
  descuento: "number",
  envio: "number",
  estado_pago: "string", // "paid" para facturar
  fecha: "string",
  ciudad: "string",
  provincia: "string",
  metodo_pago: "string",
  // items: array con { nombre, nombre_original, cantidad, precio (con IVA), descuento_item }
  items: "array",
};

/**
 * Guarda el access_token de una plataforma para un user+cuit.
 * TODO: encriptar con KMS antes de guardar (hoy se guardan en claro, no es seguro para producción).
 */
export async function saveIntegrationToken(db, uid, platform, data) {
  await db.collection("users").doc(uid).collection("integrations").doc(platform).set(data, { merge: true });
}

export async function loadIntegrationToken(db, uid, platform) {
  const snap = await db.collection("users").doc(uid).collection("integrations").doc(platform).get();
  return snap.exists ? snap.data() : null;
}

/**
 * Marca una orden como facturada para que no aparezca en la próxima sincronización.
 */
export async function markOrderBilled(db, uid, platform, orderId, comprobanteData) {
  await db.collection("users").doc(uid).collection("integrations_orders")
    .doc(`${platform}_${orderId}`).set({
      platform, orderId,
      billed_at: new Date().toISOString(),
      comprobante: comprobanteData,
    }, { merge: true });
}

export async function getBilledOrderIds(db, uid, platform) {
  const snap = await db.collection("users").doc(uid).collection("integrations_orders")
    .where("platform", "==", platform)
    .get();
  return new Set(snap.docs.map(d => d.data().orderId));
}

/**
 * Heredamos la heurística de clasificarDoc para mantener consistencia con el resto del código.
 * (Cuando implementemos las integraciones, importar desde api/arca.js o moverla acá).
 */
export function clasificarDoc(numStr) {
  const s = String(numStr || "").replace(/\D/g, "");
  if (s.length === 11) {
    const mult = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    const suma = mult.reduce((acc, m, i) => acc + parseInt(s[i]) * m, 0);
    const resto = suma % 11;
    const verificador = resto === 0 ? 0 : resto === 1 ? 9 : 11 - resto;
    if (verificador === parseInt(s[10])) return { doc_tipo: "CUIT", doc_nro: s };
  }
  if (s.length >= 7 && s.length <= 8) return { doc_tipo: "DNI", doc_nro: s };
  return { doc_tipo: "CF", doc_nro: "" };
}
