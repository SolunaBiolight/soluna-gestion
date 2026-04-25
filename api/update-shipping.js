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

  if (!orderId || !tracking) {
    return res.status(400).json({ error: "Faltan orderId o tracking" });
  }

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
    } catch(e) {
      console.error("Error fetching user store:", e.message);
    }
  }

  const tnHeaders = {
    'Authentication': `bearer ${accessToken}`,
    'User-Agent': 'GrowithApp (soluna.biolight@gmail.com)',
    'Content-Type': 'application/json',
  };

  try {
    // 1. Buscar el pedido por número
    const searchRes = await fetch(
      `https://api.tiendanube.com/v1/${storeId}/orders?q=${orderId}&per_page=5`,
      { headers: tnHeaders }
    );
    const orders = await searchRes.json();
    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(404).json({ error: `Pedido #${orderId} no encontrado en TN` });
    }
    const order = orders.find(o => String(o.number) === String(orderId));
    if (!order) {
      return res.status(404).json({ error: `Pedido #${orderId} no encontrado` });
    }

    const tnOrderId = order.id;
    const shippingStatus = order.shipping_status;
    // Doc TN v1: shipping_status puede ser "unpacked", "fulfilled", "unfulfilled"
    // También aparece "unshipped", "ready_to_ship" en algunas versiones
    const estadosNoPermitidos = ['fulfilled'];
    if (estadosNoPermitidos.includes(shippingStatus)) {
      return res.status(400).json({
        error: `El pedido #${orderId} ya fue enviado (${shippingStatus}). No se puede actualizar el tracking.`,
        shipping_status: shippingStatus,
      });
    }

    // 2. PUT /orders/{id} — actualiza shipping_tracking_number directamente
    //    Solo requiere write_orders scope (que el token OAuth sí tiene).
    //    /fulfill da 403 porque requiere write_fulfillment_orders (scope adicional).
    const putRes = await fetch(
      `https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}`,
      {
        method: 'PUT',
        headers: tnHeaders,
        body: JSON.stringify({
          shipping_tracking_number: tracking,
          shipping_tracking_url: `https://www.andreani.com/#!/informacionEnvio/${tracking}`,
        })
      }
    );
    const putData = await putRes.json();

    if (!putRes.ok) {
      return res.status(putRes.status).json({
        error: putData.message || putData.description || `TN respondió ${putRes.status}`,
        detail: putData,
      });
    }

    // 3. Opcionalmente marcar como enviado via POST /pack + /fulfill si está en unshipped
    //    Solo si el PUT fue exitoso y el pedido no está ya en ready_to_ship
    //    Esto actualiza el estado visible en el admin de TN
    if (shippingStatus === 'ready_to_ship' || shippingStatus === 'unpacked') {
      try {
        await fetch(
          `https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}/fulfill`,
          {
            method: 'POST',
            headers: tnHeaders,
            body: JSON.stringify({
              shipping_tracking_number: tracking,
              notify_customer: true,
            })
          }
        );
        // Ignoramos el resultado — si falla no pasa nada, el tracking ya fue seteado
      } catch(_) {}
    }

    res.status(200).json({
      ok: true,
      order: orderId,
      tracking,
      shipping_status: shippingStatus,
    });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
