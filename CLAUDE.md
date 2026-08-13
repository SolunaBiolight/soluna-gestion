# Growith — Contexto para Claude Code

## Qué es este proyecto
Growith es una SaaS de gestión para e-commerce argentino, construida en React (JSX en un solo archivo).
Actualmente en uso real por Soluna Biolight (anteojos blue light blocker).

## Stack
- **Frontend:** React JSX (`src/App.jsx`) — todo en un solo archivo (~13.500 líneas)
- **Backend:** Serverless functions en `/api/` (Vercel)
- **DB:** Firebase Firestore + Auth
- **Deploy:** Vercel (proyecto "growith")
- **Repo:** `https://github.com/SolunaBiolight/soluna-gestion`
- **Prod:** `https://soluna-gestion.vercel.app`

## Estructura del proyecto
```
/
├── src/
│   └── App.jsx          ← TODO el frontend vive acá
├── api/
│   ├── stock.js         ← Stock analytics (TN + Shopify + ML)
│   ├── orders.js        ← Órdenes TN
│   ├── arca.js          ← Facturación AFIP
│   ├── meta.js          ← Meta Ads (auth: verifyAuth + cron con CRON_SECRET)
│   ├── copilot.js       ← Copilot IA (Gemini + snapshot determinista de Firestore)
│   ├── _auth.js         ← verifyAuth (Firebase ID token) — no expuesto por Vercel
│   ├── integrations.js  ← OAuth TN + Shopify
│   ├── tn-callback.js   ← Callback OAuth TN
│   ├── meta-callback.js ← Callback OAuth Meta
│   ├── google-ads.js    ← Google Ads (oauth_start/status/disconnect; gasto en orders.js)
│   ├── google-ads-callback.js ← Callback OAuth Google Ads
│   ├── andreani.js      ← API oficial Andreani: etiquetas prepagas (billetera, markup, sucursales exactas)
│   ├── update-shipping.js
│   ├── process-sku.js
│   ├── coupons.js
│   └── inventory.js
├── public/
│   └── andreani_template.xlsx
├── CLAUDE.md            ← este archivo
└── package.json
```

## Variables de entorno (Vercel — nunca en código)
```
FIREBASE_PROJECT_ID
FIREBASE_CLIENT_EMAIL
FIREBASE_PRIVATE_KEY
GOOGLE_AI_KEY
CRON_SECRET               ← auth de los crons (Vercel lo manda como Bearer)
META_APP_ID=905872205806657
META_APP_SECRET
NEXT_PUBLIC_META_APP_ID=905872205806657
GOOGLE_ADS_CLIENT_ID          ← OAuth de Google Cloud (Google Ads API habilitada) — PENDIENTE de crear
GOOGLE_ADS_CLIENT_SECRET      ← ídem — PENDIENTE
GOOGLE_ADS_DEVELOPER_TOKEN    ← centro de API de la cuenta admin de Google Ads — PENDIENTE
GOOGLE_ADS_LOGIN_CUSTOMER_ID  ← opcional, id del MCC sin guiones
ANDREANI_USER / ANDREANI_PASS ← cuenta revendedora de la plataforma (Soluna)
ANDREANI_CLIENTE / ANDREANI_CTA
ANDREANI_CONTRATO_ESTANDAR / ANDREANI_CONTRATO_SUCURSAL  ← contratos de envío (cambio/retiro pendientes)
```

## Secciones de la app (componentes principales en App.jsx)
| Componente | Sección | Descripción |
|---|---|---|
| `HomeScreen` | Inicio | Dashboard con KPIs, alertas y acciones rápidas |
| `AppCopilot` | Copilot | Chat IA sobre datos reales (solo lectura, no inventa cifras) |
| `AppEnvios` | Envíos | Pedidos TN, etiquetas Andreani, seguimientos |
| `AppReclamos` | Reclamos | Pipeline kanban de reclamos y cambios |
| `AppCanjes` | Canjes | Gestión de influencers y canjes |
| `AppStock` | Stock | Analytics conectado a TN/Shopify/ML |
| `AppMetaAds` | Meta Ads | Campañas Facebook/Instagram |
| `AppArca` | ARCA | Facturación electrónica AFIP |
| `ConfigScreen` | Config | Integraciones, tokens, configuración |
| `AppPlanes` | Planes | Gestión de suscripción |
| `AppAdmin` | Admin | Panel de administración (solo admins) |

## Navegación
- Hash routing sin librería: `window.location.hash` → `#/stock`, `#/envios`, etc.
- Estado en `page` con `setPage()`
- **Sidebar permanente** (desktop) con todos los links
- **Bottom nav** (mobile) con las 5 secciones principales
- **Command Palette** con `Ctrl+K` / `Cmd+K`

## Design System (DS)
Tokens centralizados definidos en `const DS`:
```js
DS.sp    // spacing: xs(4) sm(8) md(12) lg(16) xl(20) 2xl(24) 3xl(32) 4xl(48)
DS.r     // border-radius: sm(6) md(8) lg(10) xl(14) 2xl(16) full(9999)
DS.font  // font-size: xs(10) sm(11) md(12) base(13) lg(14) xl(16) 2xl(20) 3xl(26) 4xl(34)
DS.w     // font-weight: regular(400) medium(500) semibold(600) bold(700) black(800)
DS.shadow // sm md lg xl
DS.ease  // cubic-bezier(0.4, 0, 0.2, 1)
```

Temas: `const DARK` y `const LIGHT` — el usuario elige, se guarda en localStorage.
El tema activo se pasa como prop `T` a todos los componentes.

Componentes base reusables (usar siempre en código nuevo):
- `<Card T={T} padding="lg" hoverable onClick={fn}>` — contenedor estándar
- `<KPI T={T} label="" value="" sub="" icon="" color="" onClick={fn}>` — métrica
- `<Btn T={T} variant="primary|secondary|ghost|danger|success" size="sm|md|lg">` — botón React
- `<DSBadge T={T} color={T.red} size="sm|md">` — badge/chip
- `<DSEmpty T={T} icon="" title="" subtitle="" action={<Btn/>}>` — estado vacío
- `<DSToggle T={T} active={bool} onToggle={fn}>` — switch toggle
- `<ModalCloseBtn T={T} onClick={fn} disabled={bool}>` — botón ✕ estándar de modales

### Sistema de botones — dos formas equivalentes
Ambas producen el mismo resultado visual. Usá la que más te convenga en cada contexto:
```js
// Forma React (para código nuevo o cuando ya usás JSX):
<Btn T={T} variant="primary">Acción</Btn>
<Btn T={T} variant="secondary">Cancelar</Btn>
<Btn T={T} variant="danger">Eliminar</Btn>

// Forma style-object (legacy, sigue funcionando igual):
<button style={{...BtnPrimary(T)}}>Acción</button>
<button style={{...BtnSecondary(T)}}>Cancelar</button>
<button style={{...BtnDanger(T)}}>Eliminar</button>
```
**No mezclar estilos de un sistema con el otro** (ej: no hacer `<Btn style={{...BtnPrimary(T)}}>`).

## Integraciones externas
| Plataforma | Estado | Cómo se guarda |
|---|---|---|
| Tienda Nube | ✅ Activo | Firestore `users/{uid}.stores[]` type="tiendanube" |
| Shopify | ✅ OAuth listo | Firestore `users/{uid}.stores[]` type="shopify" |
| Mercado Libre | ✅ Activo | Firestore `users/{uid}.stores[]` type="mercadolibre" |
| Meta Ads | ⚠️ Token vencido | Firestore `users/{uid}.metaAccounts[]` |
| ARCA (AFIP) | ✅ Activo | Firestore `users/{uid}.cuits[]` |

## Reglas de trabajo — MUY IMPORTANTE

### Antes de cualquier cambio
1. Leer los archivos relevantes completos antes de tocar nada
2. Verificar sintaxis JSX con `npx babel --presets @babel/preset-react` o similar
3. Nunca romper funcionalidad existente que ya anda

### Al escribir código
- **No inline styles inventados** — usar el sistema `T.xxx` para colores y `DS.xxx` para spacing
- **No duplicar funciones** — verificar que no exista ya algo similar antes de crear
- **Siempre** usar los componentes base (`Card`, `Btn`, `KPI`, `DSBadge`, `DSEmpty`)
- Fuente: `'Inter',system-ui,sans-serif` en todos lados
- `fontFamily` siempre explícito en botones y inputs

### localStorage keys (no inventar nuevas sin documentar)
```
growith_theme              → "dark" | "light"
growith_sidebar            → "0" | "1" (colapsado)
growith_onb_done           → "1" (onboarding completado)
growith_onb_done_{uid}     → "1" (por usuario)
growith_alert_config_{uid} → JSON config alertas por producto
growith_alert_global_{uid} → número (días umbral global)
growith_lead_time_{uid}    → JSON lead times por producto
growith_stockouts_{uid}    → JSON[] historial de agotados
growith_envios_cache_{uid} → JSON cache SWR de Envíos: {ts, tabs:{empaquetar,enviar}, counts}
growith_exportCfg          → JSON config de paquete Andreani: {peso,alto,ancho,prof,valor}
growith_andreani_fmt       → "a4" | "termica" (formato de descarga de etiquetas Andreani, sin uid: preferencia de impresora)
(sessionStorage) growith_saldo_bajo_dismiss → "1" banner de saldo bajo de Envíos cerrado en esta sesión
growith_exportHistory      → JSON[] historial local de exportaciones (fallback del historial en Firestore users/{uid}/envios)
growith_locOverrides / growith_sucOverrides → JSON overrides de localidad/sucursal pendientes de export
growith_skuCfg             → JSON posición/tamaño del estampado de SKU en rótulos
growith_margenes_vis_{uid} → JSON visibilidad del dashboard Márgenes: {main,sec,costos,tienda,ml,canales,productos,secKpis,secKpisOrder}
growith_margenes_fullnums  → "1" (números completos en Márgenes, sin K/M)
growith_margenes_usd       → "1" (dashboard Márgenes en USD)
growith_costos_alert_{uid} → número de productos vendidos sin costo cargado (badge "Configuraciones" del Dashboard en el sidebar; lo publica AppRendimiento + evento "gh-costos-alert")
growith_reproc_{uid}       → timestamp del último reprocesamiento de 60 días
growith_pnl_{uid}_{YYYY-MM} → JSON cache del P&L mensual: {ts, totals} (meses cerrados: permanente; mes actual: TTL 1h)
growith_accounts           → JSON[] cuentas recordadas en login (email, nombre, provider)
growith_switch_to          → JSON {email,provider} temporal al cambiar de cuenta (se borra al usarse)
growith_compaid_{uid}      → JSON comisiones de cupones marcadas como pagadas
growith_comisionOverrides  → JSON overrides de % comisión por cupón
growith_mpComision         → número, % comisión MP default en Canjes (12)
growith_canjes_alertcfg_{uid} → JSON umbrales (días) del motor de alertas de Canjes: {despachar,demora,contAviso,contUrgente,contCritico,sinrespuesta}
growith_meta_roas_be       → número, ROAS break-even del análisis Meta (2)
growith_meta_cols          → JSON[] columnas visibles de la tabla de análisis Meta
growith_meta_lasteval_{accId} → timestamp última evaluación de reglas Meta
growith_auto_publish_{uid} → "1" auto-publicar creativos Meta
growith_alertNotif_{uid}   → JSON config notificaciones de alertas: {email,whatsapp,enabled}
growith_stock_autosync_{uid} → timestamp del último autosync de stock
growith_conceptos_{uid}    → JSON conceptos frecuentes del facturador ARCA
growith_colab_banner_{token} / growith_pwa_banner_{token} → "1" banners cerrados en portal colaborador
growith_expiry_dismiss_{uid}_{fecha} → "1" banner de vencimiento de plan/trial cerrado ese día
growith_home_start_{uid}   → "1" checklist "Empecemos" del Home cerrado manualmente
(sessionStorage) growith_copilot_conv → JSON {id,msgs} conversación activa del Copilot (cache; la verdad vive en users/{uid}/copilot_convs)
(sessionStorage) growith_copilot_pending → prompt pendiente al abrir Copilot desde otra sección (ej. configuración guiada del Home)
(sessionStorage) growith_colab_token / growith_board_id_{token} → sesión de portal colaborador / identidad de tablero compartido
growith_orders_{uid} / growith_orders_v3 → LEGACY, solo se borran (purga de cache viejo de órdenes)
growith_stock_cache_{uid}_{periodo}  → SWR {ts,data} snapshot de Stock (pintado instantáneo)
growith_arca_pend_{uid}_{cuit}_{periodo} → SWR pendientes del facturador
growith_rend_cache_{uid}_{periodo}   → SWR snapshot del Dashboard (daily_metrics)
growith_ml_items_{uid}_{status}      → SWR publicaciones de la sección ML
growith_meta_ins_{acc}_{nivel}_{rango}_{drill} → SWR insights de Meta (TTL 30 min)
```
Patrón SWR: helpers globales `ghSwrGet(key,maxAge)` / `ghSwrSet(key,data)` — pintar cache al instante, refrescar de fondo, y si el refresco falla con cache pintada no romper la vista.

### Flujo de git
```bash
git add .
git commit -m "tipo: descripción corta en español"
git push origin main
```
Vercel hace deploy automático al pushear a main.

### Tipos de commit
- `feat:` — nueva funcionalidad
- `fix:` — corrección de bug
- `refactor:` — mejora de código sin cambio funcional
- `style:` — cambios de UI/UX

## Contexto de negocio (Soluna Biolight)
- **Productos:** Anteojos blue light blocker (Rojo, Naranja, Amarillo) en marcos Negro y Transparente + Clip-On + Líquido limpia cristales
- **SKUs:** AMARILLO-NN, AMARILLO-TT, NARAN-NN, NARAN-TT, ROJ-NN, ROJ-TT, CLIP-ON, LIQ
- **Plataformas:** Tienda Nube (principal), Mercado Libre
- **Logística:** Andreani (envíos a domicilio y sucursal HOP)
- **Facturación:** ARCA AFIP — Monotributo, CUIT 20-42827239-1, Punto de venta 3
- **Fundadores:** Soluna (ops, marketing, CS) + Nicolás

## Admin UIDs
```
WJH3ArqDPQcNLha9lOinvkVi9uJ2   ← Soluna (owner)
ADMIN_UID_2                      ← completar cuando haya segundo admin
```

## Qué NO hacer nunca
- ❌ Poner variables de entorno en el código
- ❌ Crear archivos `.env` y commitearlos
- ❌ Cambiar el color de fondo (`T.bg`) — es intocable
- ❌ Romper el sistema de hash routing sin migrar todas las páginas
- ❌ Agregar dependencias npm sin consultarlo primero
- ❌ Modificar `api/arca.js` sin entender el flujo completo de AFIP primero
- ❌ Hacer `git push --force`
