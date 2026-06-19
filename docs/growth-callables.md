# Callables de growth tools — contrato (Fase 5C-C)

Migración de los writes directos del panel (growth tools) a callables con gate de backend. **Rol
manager+** (`resolvePanelAuth`: TENANT_MANAGER / TENANT_OWNER / PLATFORM_ADMIN). Seller/viewer → 403.
Validación estricta **patch-style** (whitelist; descarta `id`/`tenantId`/`createdAt`/`updatedAt` y los
**server-only** como `attribution`/rollups). Auditoría (sin loguear códigos completos). Sin feature
gate (edición básica).

> **Convivencia:** conviven con los writes directos actuales — `firestore.rules` **NO** se cerró. El
> cierre a `write:false` es posterior, por módulo, tras la migración del frontend. No se tocó `apps/web`.

Errores: `unauthenticated`, `permission-denied`, `invalid-argument`, `not-found`. Vía `HttpsError`.

---

## 5C-C1 — Promociones + tracking propio

### `promotionUpsert`
- **Payload:** `{ tenantId?, id?, data: { name(req. create), type(enum PROMOTION_TYPE, req. create),
  description, objective, discountValue(≥0), productIds[], categoryIds[], startDate, endDate, status(enum PROMOTION_STATUS) } }`.
  - `startDate`/`endDate`: epoch ms | ISO string | `null` → se guardan como `Timestamp`.
- **Respuesta:** `{ ok, id, created }`. **Gates:** rol manager+ · audit `promotion.created/updated`.

### `promotionDelete` (SOFT)
- **Payload:** `{ tenantId?, id }`. **Efecto:** `status='FINISHED'` + `updatedAt` (conserva historial; no hard-delete).
- **Respuesta:** `{ ok, id, finished: true }`. **Gates:** rol manager+ · audit `promotion.finished`. Inexistente → `not-found`.

### `trackingSourceUpsert`
- **Payload:** `{ tenantId?, id?, data: { name(req. create), code(req. create), type(enum TRACKING_TYPE, req. create), active(bool) } }`.
  - Descarta `attribution` (rollup que calcula el job).
- **Respuesta:** `{ ok, id, created }`. **Gates:** rol manager+ · audit `trackingSource.created/updated`.

### `trackingSourceDelete` (SOFT)
- **Payload:** `{ tenantId?, id }`. **Efecto:** `active=false` + `updatedAt` (conserva el rollup de atribución).
- **Respuesta:** `{ ok, id, deactivated: true }`. **Gates:** rol manager+ · audit `trackingSource.deactivated`.

---

## Migración de frontend (fase posterior, la hace el owner)

Reemplazar en `apps/web/src/lib/promotions.ts` / `tracking.ts` los `setDoc`/`deleteDoc` por
`httpsCallable('promotionUpsert' | 'promotionDelete' | 'trackingSourceUpsert' | 'trackingSourceDelete')`
con `{ tenantId, id?, data }`, manejando `HttpsError`. El `deleteDoc` pasa a ser **soft** (FINISHED /
active=false). Una vez migrado, se cierran las rules de `promotions`/`trackingSources` a `write:false`.

## Pendiente (5C-C2)

`deliveryPersonUpsert`/`Delete` (con cuota `maxDeliveryPersons`), `winningReplyUpsert`/`Delete`,
`agentTestCaseUpsert`/`Delete`. (5C-D: marcar resuelto/completado de `insights`/`followUpTasks`/`agentAudits`.)
