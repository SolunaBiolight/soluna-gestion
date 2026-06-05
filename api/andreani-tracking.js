// api/andreani-tracking.js — Proxy server-side para evitar CORS en consultas Andreani

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { tracking } = req.query;
  if (!tracking) return res.status(400).json({ error: 'tracking requerido' });

  const headers = { 'Accept': 'application/json', 'User-Agent': 'GrowithApp (soluna.biolight@gmail.com)' };

  // Intento 1: API oficial Andreani v2
  try {
    const r1 = await fetch(`https://api.andreani.com/v2/ordenes/${encodeURIComponent(tracking)}`, { headers });
    if (r1.ok) {
      const d = await r1.json();
      return res.status(200).json(d);
    }
  } catch(_) {}

  // Intento 2: endpoint de seguimiento público
  try {
    const r2 = await fetch(`https://tracking.andreani.com/api/v1/seguimiento?tracking=${encodeURIComponent(tracking)}`, { headers });
    if (r2.ok) {
      const d = await r2.json();
      return res.status(200).json(d);
    }
  } catch(_) {}

  return res.status(404).json({ error: 'No se pudo obtener el estado del tracking' });
}
