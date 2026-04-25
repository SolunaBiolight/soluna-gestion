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

  try {
    const tnHeaders = {
      'Authentication': `bearer ${accessToken}`,
      'User-Agent': 'GrowithApp (soluna.biolight@gmail.com)',
      'Content-Type': 'application/json',
    };

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
    const shippingStatus = order.shipping_status; // unpacked | ready_to_ship | shipped | delivered

    // Permitir: Por empaquetar (unpacked/unshipped/null) y Por enviar (ready_to_ship)
    const estadosEnviar = ['ready_to_ship'];
    const estadosEmpaquetar = ['unpacked', 'unshipped', 'partially_shipped', null, ''];
    const estadoPermitido = estadosEnviar.includes(shippingStatus) || estadosEmpaquetar.includes(shippingStatus);
    if (!estadoPermitido) {
      return res.status(400).json({
        error: `El pedido #${orderId} está en estado "${shippingStatus}" y no acepta tracking. Solo pedidos Por empaquetar o Por enviar.`,
        shipping_status: shippingStatus,
      });
    }

    // 2. Estrategia según estado del pedido:
    // - ready_to_ship → /fulfill (marca como enviado + notifica cliente)
    // - unpacked/unshipped → PUT /orders/{id} (guarda tracking sin cambiar estado)
    let updateRes, updateData;

    if (estadosEnviar.includes(shippingStatus)) {
      // Pedido "Por enviar" → usar /fulfill que notifica al cliente
      updateRes = await fetch(
        `https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}/fulfill`,
        {
          method: 'POST',
          headers: tnHeaders,
          body: JSON.stringify({ shipping_tracking_number: tracking, notify_customer: true })
        }
      );
      updateData = await updateRes.json();

      // Si /fulfill falla, fallback a PUT directo
      if (!updateRes.ok) {
        updateRes = await fetch(
          `https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}`,
          {
            method: 'PUT',
            headers: tnHeaders,
            body: JSON.stringify({ shipping_tracking_number: tracking })
          }
        );
        updateData = await updateRes.json();
      }
    } else {
      // Pedido "Por empaquetar" → PUT directo, solo guarda el tracking sin cambiar estado
      updateRes = await fetch(
        `https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}`,
        {
          method: 'PUT',
          headers: tnHeaders,
          body: JSON.stringify({ shipping_tracking_number: tracking })
        }
      );
      updateData = await updateRes.json();
    }

    if (!updateRes.ok) {
      return res.status(updateRes.status).json({
        error: updateData.message || updateData.description || `TN respondió ${updateRes.status}`,
        shipping_status: shippingStatus,
      });
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
