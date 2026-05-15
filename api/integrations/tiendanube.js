// api/integrations/tiendanube.js
// STUB — diseño en api/integrations/README.md
//
// Endpoint base: https://api.tiendanube.com/v1/{store_id}
// Auth: OAuth 2.0 (authorization_code grant)
// Scopes mínimos: read_orders, read_customers
//
// Variables de entorno necesarias:
// - TIENDANUBE_CLIENT_ID
// - TIENDANUBE_CLIENT_SECRET
// - TIENDANUBE_REDIRECT_URI = https://growithapp.com/api/integrations/tiendanube?action=callback
//
// Notas:
// - El customer.identification trae el DNI/CUIT en formato string
// - Filtrar por payment_status=paid y fulfillment_status<>cancelled
// - Pagination: per_page=200 (max)

export default async function handler(req, res) {
  return res.status(501).json({
    error: "Integración Tienda Nube no implementada todavía",
    design: "Ver api/integrations/README.md",
  });
}
