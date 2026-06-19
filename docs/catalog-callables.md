# Callables de catálogo — contrato (Fase 5C-B)

Migración de los writes directos del panel a `products`, `productFinancials` y `categories` hacia
callables con gate de backend. **Rol manager+** (`resolvePanelAuth`: TENANT_MANAGER / TENANT_OWNER /
PLATFORM_ADMIN). Seller/viewer → 403. Validación estricta **patch-style** (whitelist; solo campos
presentes; descarta `id`/`tenantId`/`createdAt`/`updatedAt` y los de sync Meta
`syncToMeta`/`metaSyncStatus`/`metaProductItemId`/… y cualquier campo no permitido). Auditoría sin
loguear el `costPrice`.

> **Convivencia (5C-B):** conviven con los writes directos actuales — `firestore.rules` **NO** se
> cerró. El cierre a `write:false` (en especial `productFinancials`, máxima sensibilidad) es un paso
> posterior, por módulo, **después** de que el frontend migre a estos callables. No se tocó `apps/web`.

Errores: `unauthenticated`, `permission-denied` (rol), `invalid-argument` (payload/tenantId),
`failed-precondition` (regla de negocio), `not-found`. Vía `HttpsError`.

---

## `productUpsert`

Crea/edita un producto y —opcional— su costo **privado** en el mismo batch.

- **Payload:** `{ tenantId?, id?, data: ProductInput, financials?: ProductFinancialsInput }`
  - `ProductInput` (whitelist): `name`(req. en create), `description`, `aiNotes`, `categoryId`,
    `emoji`, `currency`(enum `CURRENCY`), `status`(enum `PRODUCT_STATUS`), `price`(≥0),
    `compareAtPrice`(≥0|null, ≥ `price`), `position`, `featured`(bool), `images`(string[], máx 12),
    `inventory{trackStock,stock≥0,lowStockThreshold≥0,sku}`, `externalIds{facebook,instagram,tiktok}`,
    `perfume{brand,gender(enum),olfactiveFamily,styleTags[],notes{top,heart,base[]},priceRange(enum),sizeMl|null,isNew}` o `null`.
  - `ProductFinancialsInput` (privado): `costPrice`(≥0|null), `priorityScore`(0–10|null),
    `targetMargin`(num|null), `allowDiscount`(bool|null), `maxDiscountPercentage`(0–100|null).
- **Respuesta:** `{ ok, id, created }`.
- **Gates:** rol manager+ · **cuota `maxProducts`** en CREATE · audit `product.created/updated` (sin `costPrice`).

## `productDelete`

**Soft-archive** (no hard-delete): no rompe carritos/sesiones/pedidos abiertos.

- **Payload:** `{ tenantId?, id }`.
- **Efecto:** `products/{id}.status = 'ARCHIVED'` + `updatedAt`. **NO** borra `productFinancials`
  (preserva trazabilidad de costos). Producto inexistente → `not-found`.
- **Respuesta:** `{ ok, id, archived: true }`.
- **Gates:** rol manager+ · audit `product.archived`.
- **Pedidos históricos:** intactos (los `orderFinancials`/items guardan el costo congelado).
- **Meta Catalog:** el item se desactiva en el job de sync posterior. *(Hard-delete real podría ser una
  acción admin/platform en una fase posterior.)*

## `categoryUpsert`

- **Payload:** `{ tenantId?, id?, data: { name(req. create), description, emoji, position, isActive } }`.
- **Respuesta:** `{ ok, id, created }`. **Gates:** rol manager+ · audit `category.created/updated`.

## `categoryDelete`

- **Payload:** `{ tenantId?, id }`.
- **Regla:** **bloquea** si hay productos con ese `categoryId` → `failed-precondition` (no deja
  productos huérfanos). Si no, borra la categoría.
- **Respuesta:** `{ ok, id, deleted: true }`. **Gates:** rol manager+ · audit `category.deleted`.

---

## Migración de frontend (fase posterior, la hace el owner)

Reemplazar en `apps/web/src/lib/catalog.ts` / `templates.ts` los `setDoc`/`deleteDoc` a
`products`/`productFinancials`/`categories` por `httpsCallable('productUpsert' | 'productDelete' |
'categoryUpsert' | 'categoryDelete')` con el payload de arriba (`{ tenantId, id?, data, financials? }`),
manejando `HttpsError` (`resource-exhausted` cuota, `permission-denied`, `invalid-argument`,
`failed-precondition`).

## Cierre de rules — estado (F5C, paso B)

Catálogo del panel migrado a callables (commit `e11d6b0`). Cierre de `firestore.rules` por colección,
un commit por cierre, verificado con `verify-rules-catalog.mjs` (write directo → 403; callable OK;
lecturas por rol intactas):
- ✅ **`productFinancials`** → `allow write: if false` (cierre 1). El costo se escribe **solo** vía
  `productUpsert`/`productDelete` (Admin SDK); la lectura sigue manager+ (seller no lee).
- ✅ **`products`** → `allow write: if false` (cierre 2). Alta/edición/baja **solo** vía
  `productUpsert`/`productDelete`; la lectura sigue viewer/seller+ intacta.
- ✅ **`categories`** → `allow write: if false` (cierre 3). Alta/edición **solo** vía `categoryUpsert`;
  baja vía `categoryDelete` (bloquea con `failed-precondition` si hay productos asociados, no deja
  huérfanos). La lectura sigue back-office (viewer+: owner/manager/viewer) intacta — el seller nunca
  leyó categorías.

**Catálogo completo blindado:** `productFinancials`, `products` y `categories` están en `write:false`;
el panel escribe el catálogo **solo** vía callables (`productUpsert`/`productDelete`/`categoryUpsert`/
`categoryDelete`, Admin SDK).

## Riesgos / notas

- **Productos archivados consumen cuota** (`maxProducts` cuenta por `count()` todos los docs). Si se
  necesita liberar cuota, el hard-delete admin posterior lo resolverá.
