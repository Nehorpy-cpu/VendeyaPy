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
  - **`code` normalizado en backend (GB-A):** `trim` + `UPPERCASE`; valida formato `^[A-Z0-9_-]{2,32}$`
    (sin espacios internos, acentos ni símbolos) → `invalid-argument` si no cumple. El frontend ya no
    necesita normalizar. La normalización vive en `validateTrackingSourcePatch` (validador puro).
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
- **Payload:** `{ tenantId?, id?, data: { name(req. create), scenario, userMessage, expectedBehavior, status(enum AGENTTEST_STATUS: UNTESTED/OK/NEEDS_WORK) } }`. *(descarta `lastResult`/`lastRunAt` — son **server-only**, solo los escribe `agentTestCaseRun`; `status` es el estado manual del caso.)*
- **Respuesta:** `{ ok, id, created }`. **Gates:** rol manager+ · audit `agentTestCase.created/updated`.

### `agentTestCaseDelete` (HARD)
- **Payload:** `{ tenantId?, id }`. **Efecto:** hard-delete (dato efímero del simulador). **Respuesta:** `{ ok, id, deleted: true }`. Audit `agentTestCase.deleted`.

### `agentTestCaseRun` (GB-B — corre el bot, server-set)
- **Payload:** `{ tenantId?, id }`. Toma el `userMessage` **del doc** (server-side, no del cliente).
- **Efecto:** corre el **motor real** del bot (`handleMessage`) en dos turnos (saludo + `userMessage`) con un
  `from` sintético **reservado/efímero solo-dígitos** (prefijo `0000`, no colisiona con clientes reales) y
  persiste `lastResult`/`lastRunAt`/`updatedAt` por **Admin SDK**. **No** cambia `status`. Si el bot está en
  pausa (takeover / `botEnabled=false`) persiste `'(el bot está en pausa)'`. **No** consume cuota de mensajes/tokens.
- **Errores:** `not-found` (caso inexistente o de otro tenant), `failed-precondition` (`userMessage` vacío),
  `permission-denied` (no manager+), `invalid-argument` (falta `id`).
- **Respuesta:** `{ ok, id, lastResult, lastRunAt, handledByHuman }`. **Gates:** rol manager+ · audit `agentTestCase.run`.
- **Nota:** el simulador comparte el motor real → cada corrida crea una sesión/cliente sintético efímero
  (de ahí el `from` reservado). Cuando se enchufe el LLM dentro de `handleMessage`, el run lo hereda sin cambios.

## Migración de frontend (fase posterior, la hace el owner)

Reemplazar en `apps/web/src/lib/{promotions,tracking,replies,simulator}.ts` (y el panel de delivery
futuro) los `setDoc`/`updateDoc`/`deleteDoc` por los `httpsCallable` de arriba con `{ tenantId, id?, data }`,
manejando `HttpsError` (`resource-exhausted` cuota, `permission-denied`, `failed-precondition`,
`invalid-argument`). Los `delete` pasan a ser **soft** (FINISHED / active=false / ARCHIVED / isActive=false),
salvo `agentTestCaseDelete` (hard). Una vez migrado cada módulo, se cierran sus rules a `write:false`.

> El run del simulador (`lastResult`/`lastRunAt`) ya está cubierto por `agentTestCaseRun` (GB-B, server-set):
> el cliente ya no escribe el resultado ni pega al endpoint dev `devMessage`.

## Cierre de rules — estado (F5C, paso B)

Cierre de `firestore.rules` por colección, un commit por cierre, verificado con
`verify-rules-growth.mjs` (write directo → 403; callable OK; lecturas por rol intactas). Decisiones de
producto fijadas: los `delete` del panel migran a **SOFT** (no hard-delete); el resultado del run del
simulador pasará a un callable **server-set**.

- ✅ **`deliveryPersons`** → `allow write: if false` (G-0). El panel no escribe directo (CRUD 100% por
  `deliveryPersonUpsert`/`deliveryPersonDelete`, Admin SDK); cierre **sin migración de frontend**.
  `deliveryPersonDelete` es SOFT (`isActive=false`). Lectura viewer+ intacta.
- ✅ **`promotions`** → `allow write: if false` (G-2). Frontend ya migrado (GF-1: `promotionUpsert`/
  `promotionDelete`, "Borrar"→"Finalizar", `listPromotions` oculta `FINISHED`). `promotionDelete` es
  SOFT (`status='FINISHED'`). Lectura staff/viewer intacta.
- ✅ **`trackingSources`** → `allow write: if false` (G-3). Backend normaliza `code`
  (trim+UPPERCASE+formato `^[A-Z0-9_-]{2,32}$`, GB-A) y frontend ya migrado (GF-2:
  `trackingSourceUpsert`/`trackingSourceDelete`, "Borrar"→"Desactivar", `listTrackingSources` oculta
  inactivos, sin normalización en el front). `trackingSourceDelete` es SOFT (`active=false`). Lectura staff/viewer intacta.
- ⏳ **`winningReplies`** (G-4): migrar `lib/replies.ts` (solo soft-archive vía `winningReplyDelete`; se
  quita el botón hard-delete salvo herramienta admin futura); luego cerrar.
- ⏳ **`agentTestCases`** (G-5): callable server-set de run (`agentTestCaseRun`, corre el bot y persiste
  `lastResult`/`lastRunAt`) **ya construido (GB-B, hecho)**; `upsert`/`delete`/`status` ya cubiertos.
  Falta migrar `lib/simulator.ts` (run → `agentTestCaseRun`, status → `agentTestCaseUpsert`) y luego cerrar.

`config` (agent/checkout/channels) es un cierre aparte (wildcard `config/{doc}`, callables
`agentConfigUpdate`/`checkoutConfigUpdate`/`channelConfigUpdate`), tras migrar el frontend.

## Pendiente

5C-D (opcional): marcar resuelto/completado de `insights`/`followUpTasks`/`agentAudits` (updates ya
limitados por rules a `status`/`resolvedAt`/`completedAt`).
