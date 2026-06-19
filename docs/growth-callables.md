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

## 5C-C2 — Repartidores + respuestas ganadoras + casos del simulador

### `deliveryPersonUpsert`
- **Payload:** `{ tenantId?, id?, data: { name(req. create), whatsappPhone(req. create), status(enum DRIVER_STATUS: AVAILABLE/BUSY/OFFLINE), isActive(bool), area } }`. *(descarta `currentLocation`/`stats`/`activeDeliveryIds` — server/driver-app; en create se inicializan en server.)*
- **Respuesta:** `{ ok, id, created }`. **Gates:** rol manager+ · **cuota `maxDeliveryPersons`** en CREATE (cuenta **solo `isActive==true`**: los desactivados liberan cupo) · audit `deliveryPerson.created/updated`.

### `deliveryPersonDelete` (SOFT, con bloqueo)
- **Payload:** `{ tenantId?, id }`. **Regla:** si tiene `activeDeliveryIds` → `failed-precondition` (reasignar entregas primero). Si no → `isActive=false` + `status='OFFLINE'`. **Nunca hard-delete.**
- **Respuesta:** `{ ok, id, deactivated: true }`. **Gates:** rol manager+ · audit `deliveryPerson.deactivated`.

### `winningReplyUpsert` (solo manual)
- **Payload:** `{ tenantId?, id?, data: { text(req. create), category, status(enum REPLY_STATUS: ACTIVE/ARCHIVED) } }`. Server fuerza `source:'manual'` + `conversions:0` en create; **descarta `source`/`conversions`** del cliente. **Editar una reply `source:'auto'` (minada) → `failed-precondition`.**
- **Respuesta:** `{ ok, id, created }`. **Gates:** rol manager+ · audit `winningReply.created/updated`.

### `winningReplyDelete` (SOFT)
- **Payload:** `{ tenantId?, id }`. **Efecto:** `status='ARCHIVED'`. **Respuesta:** `{ ok, id, archived: true }`. Audit `winningReply.archived`.

### `agentTestCaseUpsert` (definición)
- **Payload:** `{ tenantId?, id?, data: { name(req. create), scenario, userMessage, expectedBehavior, status(enum AGENTTEST_STATUS: UNTESTED/OK/NEEDS_WORK) } }`. *(descarta `lastResult`/`lastRunAt` — los setea el run, fuera de esta fase; `status` es el estado manual del caso.)*
- **Respuesta:** `{ ok, id, created }`. **Gates:** rol manager+ · audit `agentTestCase.created/updated`.

### `agentTestCaseDelete` (HARD)
- **Payload:** `{ tenantId?, id }`. **Efecto:** hard-delete (dato efímero del simulador). **Respuesta:** `{ ok, id, deleted: true }`. Audit `agentTestCase.deleted`.

## Migración de frontend (fase posterior, la hace el owner)

Reemplazar en `apps/web/src/lib/{promotions,tracking,replies,simulator}.ts` (y el panel de delivery
futuro) los `setDoc`/`updateDoc`/`deleteDoc` por los `httpsCallable` de arriba con `{ tenantId, id?, data }`,
manejando `HttpsError` (`resource-exhausted` cuota, `permission-denied`, `failed-precondition`,
`invalid-argument`). Los `delete` pasan a ser **soft** (FINISHED / active=false / ARCHIVED / isActive=false),
salvo `agentTestCaseDelete` (hard). Una vez migrado cada módulo, se cierran sus rules a `write:false`.

> El `updateDoc` que guarda `lastResult`/`lastRunAt` tras **correr** un caso del simulador NO está cubierto
> (es server-set); su callable de "run + guardar resultado" queda para una fase posterior.

## Pendiente

5C-D (opcional): marcar resuelto/completado de `insights`/`followUpTasks`/`agentAudits` (updates ya
limitados por rules a `status`/`resolvedAt`/`completedAt`).
