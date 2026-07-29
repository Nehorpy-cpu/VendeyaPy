# ADR-0014 — Importación genérica paginada y calidad de catálogo

- **Estado:** aceptado (EN REPO — NO DESPLEGADO)
- **Fecha:** 2026-07-28
- **Programa:** META-CATALOG-GENERIC-ONBOARDING-QUALITY-1
- **Relacionados:** ADR-0002 (multi-tenant), ADR-0012 (contrato de escritura), ADR-0013 (outbox + preview binding)

## Contexto

La importación existente (META-CATALOG-RECONCILIATION-1) fue diseñada para el onboarding
curado de arfagi: exige `retailerIds` explícitos (máx. 100 por llamada), categoría
obligatoria, relee el catálogo remoto COMPLETO en memoria en cada callable (tope fail-closed
de 5.000 artículos del cliente) y escribe con un batch todo-o-nada. Para catálogos de
cualquier tamaño y cualquier vertical hacen falta: paginación real por cursor, reanudación,
idempotencia por ítem y un modelo de calidad que le diga al comerciante qué le falta a cada
producto antes de poder sincronizarlo — sin hardcodear perfumería.

## Decisión

### 1. Cliente paginado

`MetaCatalogClient.listItemsPage(catalogId, cursor?) → { items, nextCursor }`: UNA página por
llamada, mismo mapeo/retries/validación de host que `listItems`. `listItems` (completo,
fail-closed en 5.000) queda INTACTO para el planificador, el preview binding y la
verificación del outbox: un plan sobre un listado parcial mentiría (creates espurios,
disables omitidos). El levantamiento del tope para esos caminos queda explícitamente FUERA
de este ADR.

### 2. Run de importación persistente y reanudable

- `tenants/{t}/metaCatalogImportRuns/{runId}`: status `running|completed|failed|cancelled`,
  `cursor` (posición remota YA COMMITEADA), `pagesDone`, contadores por desenlace
  (`imported / alreadyLinked / alreadyImported / ambiguous / conflicted / skipped /
  unclassified`), `bloqueosPorRazon`, `cursorResets`, `leaseUntil`, `attempts`, `actorUid`,
  `lastError` saneado.
- `tenants/{t}/metaCatalogImportState/current`: puntero del run ACTIVO (un solo run por
  tenant+catálogo). Claim transaccional con lease (patrón del outbox): un segundo llamado
  concurrente recibe `already_running` con el estado — jamás dos imports pisándose.
- El callable `metaCatalogImportRun` procesa hasta N páginas por invocación y persiste
  cursor+contadores DESPUÉS de commitear cada página: un timeout/crash reanuda desde la
  última página confirmada. Reprocesar una página es seguro (idempotencia por ítem).
- Cursor inválido/expirado ⇒ el run reinicia `cursor=null` e incrementa `cursorResets`; el
  re-escaneo es seguro por idempotencia (los ya importados cuentan como `alreadyImported`).

### 3. Idempotencia e identidad

- Id determinístico del producto importado: `meta_<retailerIdLockKey(retailerId)>` (misma
  convención e inyectividad de ADR-0012). El `retailer_id` remoto se conserva EXACTO en
  `metaRetailerId`.
- **Cada ítem importado escribe producto + lock `metaRetailerLocks/{lockKey}` en la MISMA
  transacción** (cierra el hueco de doble vínculo: importar X y luego confirmar mapping de X
  sobre otro producto). `ALREADY_EXISTS` se cuenta como `alreadyImported` por ítem — jamás
  aborta la página (la semántica todo-o-nada del callable curado original se conserva solo
  en ese callable).
- Nada se vincula por nombre aproximado: un candidato fuerte de mapping con un producto
  local sin vínculo se cuenta `ambiguous` y NO se importa — lo resuelve una persona.

### 4. Arranque seguro y verticales

Todo importado nace `INACTIVE`, `syncToMeta=false`, invisible para el bot y el checkout,
sin costo financiero (desconocido ≠ 0), sin stock inventado (`stock 0` sin `trackStock`,
`stockPendingReview=true`). La categoría desconocida NO pierde el producto: se importa como
borrador **«sin clasificar»** (`categoryId ''`) con su observación de calidad. La marca pasa
a un campo NEUTRAL `Product.brand` (la lectura outbound hace fallback a `perfume.brand`
para no migrar arfagi); la ficha `perfume` deja de fabricarse para verticales ajenas. Los
STOPWORDS de perfumería del ranking dejan de ser universales (perfil de catálogo por tenant,
default conservador).

### 5. Modelo de calidad

`products/quality.ts` (puro): `evaluateProductQuality(product, ctx)` produce observaciones
estructuradas `{code, severity BLOCKING|WARNING, field, message, action, fingerprint
"code:field", firstSeenAt, lastSeenAt, resolvedAt, origin}` persistidas en
`product.quality` — calculado y escrito SOLO por servidor (la whitelist de
`validateProductPatch` no lo acepta del cliente; la autoridad de los gates es SIEMPRE el
recomputo server-side). Los BLOCKING derivan de los MISMOS `syncEnableBlockers`/
`createBlockers` de ADR-0012/0013 (una sola fuente de reglas; dos listas se desincronizan).
WARNINGs: nombre genérico, duplicado probable, incoherencia nombre/descripción, sin
clasificar, deriva remota. Reglas de vertical: configurables por perfil de tenant — nunca
`perfume`/`aiFicha` como requisito universal.

Enforcement: BLOCKING ⇒ no se puede habilitar `syncToMeta` (gate existente), no entra a un
apply (planner existente), y no puede activarse para la venta si el bloqueo afecta la venta
(gate nuevo en `productUpsert` para `status ACTIVE` con nombre/precio inválidos). Un
recompute que resuelve un fingerprint sella `resolvedAt` (histórico corto, poda a 30 días).

### 6. Alertas agregadas

Una ÚNICA notificación de campana por tenant con `sourceId` fijo (`catalog-quality:{t}`),
actualizada de forma idempotente con el resumen (X con bloqueos / Y con advertencias) y
auto-resuelta cuando ambos llegan a 0 — jamás una campana por producto. El panel muestra el
centro de calidad (contador, filtros, badges, campos pendientes) y el resultado del guardado
("se resolvieron N, quedan M").

### 7. Seguridad y privacidad

Tenant SIEMPRE desde los claims (jamás del payload), roles existentes (owner para importar y
habilitar; manager+ para leer resúmenes), colecciones nuevas cerradas al cliente por Rules,
default-deny, cero PII/token/payload completo en logs, contadores y razones — no contenidos —
en el run doc. `credipower` y `80-creditos.future/` intocados.

## Consecuencias

- El onboarding de un catálogo grande deja de estar limitado por memoria/timeout de una
  llamada; el costo a Meta se paga una vez por página, no una vez por callable.
- Dos fuentes de "calidad" conviven (flags remotos de `analyzeRemoteItems` para candidatos;
  `quality` local para productos) — comparten primitivas y códigos donde se superponen.
- El tope de 5.000 para el PLAN (no para la importación) sigue vigente y documentado como
  límite conocido; levantarlo requiere rediseñar el diff incremental (futuro ADR).
- Deploy pendiente (programa aparte): functions nuevas + updates, rules nuevas, índices si
  se agregaron, hosting.
