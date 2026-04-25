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

const FALLBACK_STORE_ID = "6978415";
const FALLBACK_TOKEN = "71be8939bf409df5b98caa80e22d7227ad288f82";

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');

  const { uid, orderId, tracking } = req.query;
  if (!orderId || !tracking) return res.status(400).json({ error: "Faltan orderId o tracking" });

  let storeId = FALLBACK_STORE_ID;
  let accessToken = FALLBACK_TOKEN;

  if (uid) {
    try {
      const db = initAdmin();
      const userSnap = await db.collection("users").doc(uid).get();
      if (userSnap.exists) {
        const tnStore = (userSnap.data().stores || []).find(s => s.type === "tiendanube");
        if (tnStore?.accessToken && tnStore?.storeId) {
          storeId = tnStore.storeId;
          accessToken = tnStore.accessToken;
        }
      }
    } catch(e) { console.error("Firebase error:", e.message); }
  }

  const headers = {
    'Authentication': `bearer ${accessToken}`,
    'User-Agent': 'GrowithApp (soluna.biolight@gmail.com)',
    'Content-Type': 'application/json',
  };

  try {
    // 1. Buscar el pedido por número
    const searchRes = await fetch(
      `https://api.tiendanube.com/v1/${storeId}/orders?q=${orderId}&per_page=5`,
      { headers }
    );
    const orders = await searchRes.json();
    if (!Array.isArray(orders) || orders.length === 0)
      return res.status(404).json({ error: `Pedido #${orderId} no encontrado` });

    const order = orders.find(o => String(o.number) === String(orderId));
    if (!order) return res.status(404).json({ error: `Pedido #${orderId} no encontrado` });

    const tnOrderId = order.id;
    const shippingStatus = order.shipping_status;

    // Solo bloquear si ya está enviado
    if (shippingStatus === 'fulfilled' || shippingStatus === 'shipped') {
      return res.status(400).json({ error: `El pedido #${orderId} ya fue enviado.` });
    }

    // 2. PUT para guardar el tracking (siempre funciona con write_orders)
    const putRes = await fetch(
      `https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          shipping_tracking_number: tracking,
          shipping_tracking_url: `https://www.andreani.com/#!/informacionEnvio/${tracking}`,
        })
      }
    );
    const putData = await putRes.json();

    if (!putRes.ok) {
      return res.status(putRes.status).json({
        error: putData.message || putData.description || `Error TN ${putRes.status}`,
      });
    }

    // 3. POST /fulfill para marcar como enviado y notificar al cliente
    // Ahora que el token tiene write_orders esto debería funcionar
    try {
      await fetch(
        `https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}/fulfill`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ shipping_tracking_number: tracking, notify_customer: true })
        }
      );
    } catch(_) {}

    res.status(200).json({ ok: true, order: orderId, tracking });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
