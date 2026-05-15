# Integraciones de ventas — Diseño backend

Documento de diseño para cuando integremos Shopify, Tienda Nube y Mercado Libre vía OAuth. Hoy el cliente sube CSV/XLSX a mano; el objetivo es reemplazar esa fricción.

## Flujo end-to-end objetivo

1. Cliente entra a Growith → ARCA y ve botones: "Conectar Shopify", "Conectar Tienda Nube", "Conectar Mercado Libre".
2. Tocá el botón → redirige al OAuth de la plataforma → autoriza → vuelve a Growith.
3. Growith guarda el access token + tienda asociada al `uid + cuit` activo.
4. En la pantalla principal, en lugar del dropzone, ve una **tabla de órdenes pendientes de facturar** traídas en vivo de cada plataforma conectada.
5. Cliente selecciona con checkboxes cuáles facturar (o "todas") → tocá "Emitir N facturas en ARCA" → mismo flujo que ya tenemos.
6. Las facturas emitidas se marcan localmente como "facturadas" para no mostrarlas otra vez.

## Estructura propuesta

```
api/integrations/
├── README.md          ← este archivo
├── shopify.js         ← OAuth + REST API
├── tiendanube.js      ← OAuth + REST API
├── mercadolibre.js    ← OAuth + REST API
└── shared.js          ← utilidades comunes
```

## Endpoints API

Cada plataforma expone los mismos 4 endpoints:

- `GET /api/integrations/{platform}/connect?uid=X&cuit=Y` — devuelve URL de OAuth para redirect
- `GET /api/integrations/{platform}/callback?code=...&state=...` — recibe el code, intercambia por token, guarda en Firestore
- `GET /api/integrations/{platform}/orders?uid=X&cuit=Y&since=2026-05-01` — lista órdenes pendientes (con filtro por fecha)
- `POST /api/integrations/{platform}/mark_billed` — marca órdenes como ya facturadas

Cada plataforma normaliza su formato propio al schema interno que ya usa `parsearCSV`/`parsearXlsxML`:

```js
{
  [orderId]: {
    nombre, email, doc_tipo, doc_nro, dni,
    total, subtotal, descuento, envio,
    estado_pago, fecha, ciudad, provincia, metodo_pago,
    items: [{ nombre, nombre_original, cantidad, precio, descuento_item }],
  }
}
```

Así el endpoint `emit` actual sigue funcionando sin cambios.

## Persistencia en Firestore

```
users/{uid}/integrations/{platform}/
  ├── access_token (encrypted)
  ├── refresh_token (encrypted)
  ├── store_id / shop_domain
  ├── connected_at
  └── cuit_emisor (a qué CUIT de Growith está asociada esta tienda)

users/{uid}/integrations_orders/{platform}_{orderId}
  ├── synced_at
  ├── billed_at (null si todavía no se facturó)
  └── raw_data (snapshot de los datos al momento del sync)
```

## OAuth scopes mínimos

| Plataforma | Scopes necesarios |
|---|---|
| **Shopify** | `read_orders`, `read_customers` |
| **Tienda Nube** | `read_orders`, `read_customers` |
| **Mercado Libre** | `read` (incluye orders + buyers) |

## Notas implementación por plataforma

### Shopify
- OAuth 2.0 con `client_credentials` por app embedded o `authorization_code` para custom apps
- Endpoint: `https://{shop}.myshopify.com/admin/api/2024-10/orders.json?status=any&financial_status=paid&created_at_min=...`
- Importante: el `Billing Company` puede contener CUIT en ARG — ya tenemos esta heurística en `clasificarDoc`

### Tienda Nube
- OAuth 2.0 estándar
- API: `https://api.tiendanube.com/v1/{store_id}/orders?per_page=200&payment_status=paid&created_at_min=...`
- Devuelve JSON estructurado (no CSV) — el mapping al schema interno es más limpio
- DNI/CUIT viene en `customer.identification`

### Mercado Libre
- OAuth 2.0 con refresh tokens cortos (6 hs)
- API: `https://api.mercadolibre.com/orders/search?seller={user_id}&order.status=paid&order.date_created.from=...`
- Importante: el comprador de ML a veces NO tiene CUIT — caer a "Consumidor Final" + DNI si está

## Por qué no se hace ahora

Cada integración requiere registrar la app en cada plataforma, manejar refresh tokens, encriptar credenciales en Firestore, manejar errores de scope/expiración, y testear edge cases con datos reales de tiendas. Es un proyecto en sí mismo, no un detalle.

Cuando el cliente pida priorizarlo, este diseño es el punto de partida.

## Hooks ya preparados en el código actual

El endpoint `emit` de `api/arca.js` ya acepta cualquier objeto `ordenes` con el schema interno, sin importar la fuente. Cuando armemos las integraciones, solo tenemos que normalizar los datos de cada plataforma al schema y pasárselo a `emit` — el resto (firma WSAA, emisión WSFE, generación de PDF, guardado de dashboard stats) funciona igual.
