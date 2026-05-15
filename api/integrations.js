// api/integrations.js
// STUB único para Shopify, Tienda Nube y Mercado Libre.
// Diseño completo: api/integrations/README.md
//
// Por qué un solo endpoint: Vercel Hobby tiene límite de 12 serverless functions.
// Mantenemos las 3 plataformas detrás de un dispatcher por ?platform=.
//
// Routing futuro:
//   GET  /api/integrations?platform=shopify&action=connect&uid=...&cuit=...
//   GET  /api/integrations?platform=tiendanube&action=callback&code=...
//   GET  /api/integrations?platform=mercadolibre&action=orders&uid=...&cuit=...
//   POST /api/integrations?platform=shopify&action=mark_billed
//
// Cada `platform` se implementa como una función handlePlatform(action, req, res)
// que normaliza al schema interno definido en api/integrations/_shared.js
// y reusa el endpoint `emit` de api/arca.js para la facturación.

const PLATFORMS = ["shopify", "tiendanube", "mercadolibre"];

export default async function handler(req, res) {
  const { platform, action } = req.query;

  if (!platform || !PLATFORMS.includes(platform)) {
    return res.status(400).json({
      error: "platform requerido. Valores: " + PLATFORMS.join(", "),
      design: "Ver api/integrations/README.md",
    });
  }

  return res.status(501).json({
    error: `Integración ${platform} no implementada todavía (action=${action || "—"})`,
    design: "Ver api/integrations/README.md",
    platform,
  });
}
