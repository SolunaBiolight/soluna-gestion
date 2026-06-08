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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── action=tracking: proxy Andreani para evitar CORS ─────────────────
  if (req.query.action === 'tracking') {
    const { tracking } = req.query;
    if (!tracking) return res.status(400).json({ error: 'tracking requerido' });

    const browserHeaders = {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'es-AR,es;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Origin': 'https://www.andreani.com',
      'Referer': 'https://www.andreani.com/',
    };

    // Normalizamos el número (Andreani acepta formatos variados)
    const nro = tracking.trim().replace(/\s+/g, '');

    // Función para extraer estado de cualquier respuesta de Andreani
    function extractEstado(d) {
      if (!d || typeof d !== 'object') return null;
      // Respuesta v2 API oficial: array de eventos
      if (Array.isArray(d.eventos) && d.eventos.length > 0) {
        const ev = d.eventos[d.eventos.length - 1];
        return ev.estado || ev.descripcion || ev.accion || null;
      }
      if (Array.isArray(d) && d.length > 0) {
        const ev = d[d.length - 1];
        return ev.estado || ev.descripcion || ev.accion || null;
      }
      // Respuesta plana con campo de estado
      return d.estado || d.estadoActual || d.estadoEnvio ||
             d.ultimoEvento?.estado || d.ultimoEvento?.descripcion ||
             d.evento || d.descripcion || null;
    }

    // Función para extraer eventos completos
    function extractEventos(d) {
      if (Array.isArray(d.eventos)) return d.eventos;
      if (Array.isArray(d)) return d;
      if (Array.isArray(d.historial)) return d.historial;
      if (Array.isArray(d.events)) return d.events;
      return [];
    }

    // Intentamos múltiples endpoints en orden
    const endpoints = [
      // 1. API pública con codigoAndreani (parámetro correcto)
      `https://tracking.andreani.com/api/v1/seguimiento?codigoAndreani=${encodeURIComponent(nro)}`,
      // 2. API alternativa con numero
      `https://tracking.andreani.com/api/v1/seguimiento?numero=${encodeURIComponent(nro)}`,
      // 3. API clientes (suele funcionar sin auth para consultas públicas)
      `https://clientes.andreani.com/api/v2/ordenes/${encodeURIComponent(nro)}`,
      // 4. API v2 oficial
      `https://api.andreani.com/v2/envios/${encodeURIComponent(nro)}/eventos`,
      // 5. Fallback con otro formato
      `https://api.andreani.com/v2/ordenes/${encodeURIComponent(nro)}/eventos`,
    ];

    for (const url of endpoints) {
      try {
        const r = await fetch(url, { headers: browserHeaders });
        const text = await r.text();
        // Ignorar respuestas HTML (páginas de error)
        if (text.startsWith('<') || text.startsWith('<!')) continue;
        let d;
        try { d = JSON.parse(text); } catch { continue; }
        const estado = extractEstado(d);
        if (estado) {
          const eventos = extractEventos(d);
          console.log(`[andreani] tracking=${nro} endpoint=${url} estado="${estado}"`);
          return res.status(200).json({
            estado,
            estadoActual: estado,
            ultimoEvento: { estado },
            eventos,
            raw: d,
            source: url,
          });
        }
      } catch(e) {
        console.log(`[andreani] endpoint falló: ${url} — ${e.message}`);
      }
    }

    // Si no pudimos obtener estado, devolver estructura vacía (no error)
    // para que el frontend pueda mostrar "no disponible" en vez de romper
    console.log(`[andreani] no se pudo obtener estado para tracking=${nro}`);
    return res.status(200).json({
      estado: null,
      estadoActual: null,
      ultimoEvento: null,
      eventos: [],
      error: 'No se pudo consultar el estado. Verificá el número de tracking.',
      trackingUrl: `https://www.andreani.com/#!/informacionEnvio/${nro}`,
    });
  }

  const { uid, orderId, tracking } = req.query;
  if (!uid) return res.status(401).json({ error: "uid requerido" });
  if (!orderId || !tracking) return res.status(400).json({ error: "Faltan orderId o tracking" });

  let storeId, accessToken;
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
    console.error("Firebase error:", e.message);
    return res.status(500).json({ error: "Error al obtener credenciales" });
  }
  if (!storeId || !accessToken) return res.status(403).json({ error: "Tienda no conectada" });

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
    if (!searchRes.ok) throw new Error(`TN search error ${searchRes.status}`);
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
