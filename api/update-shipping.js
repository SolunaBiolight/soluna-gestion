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
    // Primero buscar el ID interno de TN a partir del número de pedido
    const searchRes = await fetch(
      `https://api.tiendanube.com/v1/${storeId}/orders?q=${orderId}&per_page=5`,
      {
        headers: {
          'Authentication': `bearer ${accessToken}`,
          'User-Agent': 'GrowithApp (soluna.biolight@gmail.com)',
        }
      }
    );
    const orders = await searchRes.json();
    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(404).json({ error: `Pedido #${orderId} no encontrado en TN` });
    }

    // Buscar el pedido exacto por número
    const order = orders.find(o => String(o.number) === String(orderId));
    if (!order) {
      return res.status(404).json({ error: `Pedido #${orderId} no encontrado` });
    }

    const tnOrderId = order.id;

    // Log para debug
    console.log(`[update-shipping] pedido #${orderId} | tn_id=${tnOrderId} | shipping_status=${order.shipping_status} | tracking=${tracking}`);

    // Intento 1: /fulfill (funciona cuando shipping_status=ready_to_ship)
    let updateRes = await fetch(
      `https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}/fulfill`,
      {
        method: 'POST',
        headers: {
          'Authentication': `bearer ${accessToken}`,
          'User-Agent': 'GrowithApp (soluna.biolight@gmail.com)',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ shipping_tracking_number: tracking, notify_customer: true })
      }
    );
    let updateData = await updateRes.json();
    console.log(`[update-shipping] fulfill → ${updateRes.status}:`, JSON.stringify(updateData).slice(0,200));

    // Intento 2: PUT /orders/{id} — actualiza el campo tracking directamente
    if (!updateRes.ok) {
      console.log(`[update-shipping] fulfill falló (${updateRes.status}), intentando PUT...`);
      updateRes = await fetch(
        `https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}`,
        {
          method: 'PUT',
          headers: {
            'Authentication': `bearer ${accessToken}`,
            'User-Agent': 'GrowithApp (soluna.biolight@gmail.com)',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ shipping_tracking_number: tracking })
        }
      );
      updateData = await updateRes.json();
      console.log(`[update-shipping] PUT → ${updateRes.status}:`, JSON.stringify(updateData).slice(0,200));
    }

    // Intento 3: POST /fulfillments (API v2 style)
    if (!updateRes.ok) {
      console.log(`[update-shipping] PUT falló (${updateRes.status}), intentando fulfillments...`);
      updateRes = await fetch(
        `https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}/fulfillments`,
        {
          method: 'POST',
          headers: {
            'Authentication': `bearer ${accessToken}`,
            'User-Agent': 'GrowithApp (soluna.biolight@gmail.com)',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            notify_customer: true,
            fulfillment: {
              shipping_tracking_number: tracking,
              shipping_tracking_url: `https://www.andreani.com/#!/informacionEnvio/${tracking}`,
            }
          })
        }
      );
      updateData = await updateRes.json();
      console.log(`[update-shipping] fulfillments → ${updateRes.status}:`, JSON.stringify(updateData).slice(0,200));
    }

    if (!updateRes.ok) {
      return res.status(updateRes.status).json({
        error: updateData.message || updateData.description || `TN respondió ${updateRes.status}`,
        detail: updateData,
        shippingStatus: order.shipping_status,
        hint: order.shipping_status === 'shipped' ? 'El pedido ya fue enviado. Tracking ya cargado.' : 'Verificá que el pedido esté empaquetado en TN.'
      });
    }

    res.status(200).json({ ok: true, order: orderId, tracking, method: updateRes.url.includes('fulfillments') ? 'fulfillments' : updateRes.url.includes('fulfill') ? 'fulfill' : 'PUT' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
