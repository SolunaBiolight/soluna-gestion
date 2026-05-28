# Multi-org refactor — plan

**Goal**: cada cuenta de Growith (un user de Firebase Auth) puede tener **varias "organizaciones"** (tiendas / negocios), cada una con sus propias integraciones (TN, Shopify, ML, Meta Ads, ARCA). El usuario cambia de org desde un switcher abajo en el sidebar, y todo Growith se reconfigura a esa org sin login.

---

## Modelo de datos

Hoy todo está en `users/{uid}` como campos top-level + subcollections:
```
users/{uid}                          ← user doc (nombre, plan, etc)
users/{uid}.stores[]                 ← TN/Shopify/ML
users/{uid}.cuits[]                  ← ARCA
users/{uid}.meta_active_account      ← ad account ID activo
users/{uid}/meta_accounts/{accId}    ← subcollection: tokens Meta
users/{uid}/meta_rules/{ruleId}      ← reglas (ya filtran por acc_id)
users/{uid}/meta_rule_log/{logId}
users/{uid}/meta_ad_analyses/{adId}
users/{uid}/meta_products/{prodId}
users/{uid}/reclamos/{reclamoId}
... etc
```

**Propuesta**: agregar un array `orgs[]` y un puntero `active_org_id` al user doc. Cada org guarda **qué selección activa** tiene de cada integración. Las integraciones siguen viviendo donde viven (no se mueven), pero la "selección activa" deja de ser top-level y pasa a vivir dentro del org activo.

```js
users/{uid} = {
  // existentes
  email, displayName, plan, alertas, ...,

  // NUEVO
  orgs: [
    {
      id: "org_xxx",                  // UUID
      name: "Inditropic",             // display
      color: "#7c3aed",               // chip color
      created_at, updated_at,
      // selecciones activas para esta org:
      active_tn_store_id: "...",      // referencia a uno de stores[]
      active_shopify_store_id: null,
      active_ml_account_id: "...",
      active_meta_acc_id: "...",      // referencia a meta_accounts subcol
      active_arca_cuit: "20-...",     // referencia a cuits[]
    },
    ...
  ],
  active_org_id: "org_xxx",

  // estos siguen existiendo durante la transición pero
  // ahora reflejan la selección de la org activa (espejo)
  meta_active_account: "...",
}
```

**Por qué `orgs[]` array en user doc y no subcollection `users/{uid}/orgs/{id}`**:
- Pocos orgs por user (1-10). Caben holgadamente en un doc.
- Una sola lectura del user doc trae todas las orgs.
- Se evita un round-trip extra al cambiar de org.

**Ajuste 28/5/2026 — clarificación del usuario**: cada org debe tener **sus propias** integraciones (stores, ARCA cuits, Meta accounts, etc.), no apuntar a integraciones compartidas top-level. Es decir, dos orgs distintas pueden tener la misma tienda TN conectada dos veces (cada una en su propio espacio), o tener Meta accounts totalmente separadas.

Schema final:
```js
users/{uid}.orgs[i] = {
  id, name, color, created_at, updated_at,
  // datos propios de la org:
  stores: [...],                  // sus TN/Shopify/ML
  cuits: [...],                   // sus CUITs ARCA
  meta_active_account: "...",     // su ad account activa
  brand_context: "...",           // su contexto de marca
  alertas: {...},                 // su config de alertas
}
users/{uid}/orgs/{orgId}/meta_accounts/{accId}    ← subcol por org
users/{uid}/orgs/{orgId}/meta_rules/{ruleId}      ← subcol por org
users/{uid}/orgs/{orgId}/reclamos/{id}            ← cuando refactoreemos esa sección
... cada subcollection actual de users/{uid}/* se duplica como users/{uid}/orgs/{orgId}/*
```

**Por qué no se hace todo en una sesión**:
- Cada sección del front lee de `userDoc.stores`, `userDoc.meta_active_account`, etc. directamente. Reescribir cada lectura es ~50 sitios.
- Cada API serverless filtra por `users/{uid}/<colección>`. Cambiar a `users/{uid}/orgs/{orgId}/<colección>` toca todos los handlers.
- Migrar data existente sin pérdida requiere un script idempotente que corra una sola vez.

---

## Migración

En primer login post-deploy, si `userDoc.orgs` no existe:
1. Crear una org default con `id = "org_default"`, nombre `"Mi organización"`.
2. Mover las selecciones top-level (`meta_active_account`, `cuits[].activa`, store por defecto, etc.) a sus campos dentro de la org.
3. Setear `active_org_id = "org_default"`.

Se hace una vez por user, idempotente, sin perder data.

---

## UX

**Sidebar bottom** (donde hoy figura "Thiago Acuña / Total"):
- Card clickable con: chip de color de la org + nombre de org + flecha `▾`
- Click → popover con lista de orgs + "+ Nueva organización" + "Gestionar orgs"
- Click en una org → switch instantáneo (loading state breve mientras se refresca contexto)
- Si user tiene 1 sola org, el switcher se ve igual pero la lista del popover sólo muestra "+ Nueva organización"

**Modal "Nueva organización"**:
- Nombre + color
- Crea org vacía. El user después conecta integraciones desde Config como antes; cada conexión queda asociada a la org activa al momento.

**Config → Organizaciones** (nueva subsección):
- Lista de orgs con sus integraciones tildadas
- Permite renombrar, borrar (con confirmación), reasignar integración

**Sección por sección** (cómo cada una se entera del cambio de org):
- Cada sección sigue leyendo de `userDoc.active_*` top-level. Al cambiar de org, escribimos los `active_*` de la org en top-level → todas las secciones se rerenderean con la nueva selección. **Cero refactor en cada sección.** El trade-off: las queries van al user doc 2 veces (una para `orgs[]`, otra implícita por los espejos top-level).

---

## Fases

| Fase | Alcance | Tiempo estimado |
|------|---------|---|
| **1** | Modelo de datos + migración default org + sidebar switcher (UI shell) + switch básico | 2-3 hs |
| **2** | Modal "Nueva org" + sección Config → Organizaciones | 2 hs |
| **3** | Per-section integration: al conectar TN/Shopify/ML/Meta/ARCA, asociar a la org activa | 2-3 hs |
| **4** | Reglas Meta: dropdown de cuenta publicitaria en RuleEditor + ejecución filtrada | 1 hs |
| **5** | Stock cross-store dentro de la org (si tiene 2 TN + 1 Shopify, agregar todo) | 3-4 hs |
| **6** | Facturador: selector de tienda por factura (qué store dispara) | 1 hs |

**Esta sesión cubre Fase 1** (más los 5 fixes que quedaron locales).

---

## Riesgos

- **App rota durante el deploy de Fase 1** si la migración falla: la mitigación es feature-flag (`growith_orgs_enabled = true` por user en Firestore). Hasta que el flag esté activo, todo funciona como hoy.
- **Conflicto con Soluna pusheando en paralelo**: avisar por WhatsApp antes del deploy.
- **Reglas existentes**: las que ya están en Firestore tienen `acc_id` apuntando a un meta_account específico. La fase 1 no las toca. La fase 4 sólo agrega un selector visual; las reglas viejas siguen funcionando.
