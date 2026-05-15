// api/integrations/shopify.js
// STUB — diseño en api/integrations/README.md
//
// Cuando se implemente:
// - GET ?action=connect&uid&cuit → devuelve URL OAuth de Shopify para redirect
// - GET ?action=callback&code&state → intercambia code por access_token, guarda en Firestore
// - GET ?action=orders&uid&cuit&since → lista órdenes pagas no facturadas todavía, normalizadas al schema interno
// - POST ?action=mark_billed&uid&cuit con {orderIds: []} → marca como facturadas
//
// Endpoint Shopify base: https://{shop}.myshopify.com/admin/api/2024-10
// Auth: OAuth 2.0 (authorization_code grant)
// Scopes mínimos: read_orders, read_customers
//
// Variables de entorno necesarias (a configurar en Vercel cuando se implemente):
// - SHOPIFY_CLIENT_ID
// - SHOPIFY_CLIENT_SECRET
// - SHOPIFY_REDIRECT_URI = https://growithapp.com/api/integrations/shopify?action=callback

export default async function handler(req, res) {
  return res.status(501).json({
    error: "Integración Shopify no implementada todavía",
    design: "Ver api/integrations/README.md",
  });
}
