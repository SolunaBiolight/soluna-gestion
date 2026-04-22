import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function initAdmin() {
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST');

  const { uid, orderId, tracking } = req.query;

  if (!uid || !orderId || !tracking) {
    return res.status(400).json({ error: "Faltan parámetros: uid, orderId, tracking" });
  }

  try {
    // Get user's TN credentials from Firestore
    const db = initAdmin();
    const userSnap = await db.collection("users").doc(uid).get();

    if (!userSnap.exists) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    const userData = userSnap.data();
    const tnStore = (userData.stores || []).find(s => s.type === "tiendanube");

    if (!tnStore?.accessToken || !tnStore?.storeId) {
      return res.status(400).json({ error: "Tienda Nube no conectada" });
    }

    const { accessToken, storeId } = tnStore;

    // Update order in Tienda Nube with tracking number
    const tnRes = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders/${orderId}`, {
      method: "PUT",
      headers: {
        "Authentication": `bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "Growith/1.0 (growithapp.com)",
      },
      body: JSON.stringify({
        shipping_tracking_number: tracking,
        shipping_status: "shipped",
      }),
    });

    if (!tnRes.ok) {
      const errText = await tnRes.text();
      console.error("TN update error:", errText);
      return res.status(500).json({ error: "Error al actualizar en Tienda Nube", detail: errText });
    }

    const updated = await tnRes.json();
    return res.status(200).json({ success: true, order: updated.number, tracking });

  } catch (e) {
    console.error("update-shipping error:", e);
    return res.status(500).json({ error: e.message });
  }
}
