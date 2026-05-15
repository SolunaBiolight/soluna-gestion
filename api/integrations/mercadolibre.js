// api/integrations/mercadolibre.js
// STUB — diseño en api/integrations/README.md
//
// Endpoint base: https://api.mercadolibre.com
// Auth: OAuth 2.0. Tokens expiran cada 6 hs — implementar refresh automático.
// Scope: read (incluye orders + buyers)
//
// Variables de entorno necesarias:
// - ML_CLIENT_ID
// - ML_CLIENT_SECRET
// - ML_REDIRECT_URI = https://growithapp.com/api/integrations/mercadolibre?action=callback
//
// Notas:
// - El comprador de ML a veces no tiene CUIT — caer a "Consumidor Final" con DNI cuando aplique
// - Listar órdenes: /orders/search?seller={user_id}&order.status=paid&order.date_created.from=...
// - Importante: filtrar reclamos/mediaciones (no facturar) — ya tenemos la heurística en parsearXlsxML

export default async function handler(req, res) {
  return res.status(501).json({
    error: "Integración Mercado Libre no implementada todavía",
    design: "Ver api/integrations/README.md",
  });
}
