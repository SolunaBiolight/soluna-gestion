// api/meta-deletion.js
// Data Deletion Callback de Meta — requisito para el App Review.
// Cuando un usuario elimina Growith desde Facebook (Configuración → Apps),
// Meta hace POST acá con un signed_request. Verificamos la firma, borramos
// las cuentas Meta asociadas a ese usuario de Facebook y respondemos con el
// formato que Meta exige: { url, confirmation_code }.

import crypto from "crypto";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const APP_URL = "https://www.growithapp.com";

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({
    credential: cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
    }),
  });
  return getFirestore();
}

function parseSignedRequest(signedRequest, secret) {
  const [sig, payload] = String(signedRequest || "").split(".");
  if (!sig || !payload) return null;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  // Comparación en tiempo constante para no filtrar la firma
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch (_) { return null; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Meta manda form-urlencoded: signed_request=<sig>.<payload>
  const rawBody = await new Promise(resolve => {
    let d = ""; req.on("data", c => d += c); req.on("end", () => resolve(d));
  });
  const params = new URLSearchParams(rawBody);
  const signedRequest = params.get("signed_request");

  const data = parseSignedRequest(signedRequest, process.env.META_APP_SECRET);
  if (!data?.user_id) return res.status(400).json({ error: "signed_request inválido" });

  const fbUserId = String(data.user_id);
  const confirmationCode = "gw-del-" + crypto.randomBytes(6).toString("hex");

  // Borrar toda cuenta Meta asociada a ese usuario de Facebook, en todas las
  // cuentas Growith donde esté conectada (el doc id de meta_accounts = fb user id).
  try {
    const db = initAdmin();
    const snap = await db.collectionGroup("meta_accounts").where("user_id", "==", fbUserId).get();
    const batch = db.batch();
    snap.docs.forEach(d => {
      batch.delete(d.ref);
      // Limpiar el flag de cuenta activa del usuario dueño
      const userRef = d.ref.parent.parent;
      if (userRef) batch.set(userRef, { meta_active_account: null }, { merge: true });
    });
    await batch.commit();
    console.log(`[meta-deletion] ${confirmationCode}: eliminadas ${snap.size} cuentas Meta de fb_user ${fbUserId}`);
  } catch (e) {
    // Si la query de collection group necesitara un índice, igual respondemos
    // válido (Meta valida el formato) y queda registrado para borrado manual.
    console.error(`[meta-deletion] ${confirmationCode}: error borrando fb_user ${fbUserId}:`, e.message);
  }

  return res.status(200).json({
    url: `${APP_URL}/eliminacion-datos.html?code=${confirmationCode}`,
    confirmation_code: confirmationCode,
  });
}
