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
- `tenants/{t}/metaCatalogImportState/current`: puntero del run ACTIVO — **por TENANT** (un solo run por
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
para no migrar arfagi); la ficha `perfume` deja de fabricarse para verticales ajenas.

**Default multi-vertical REAL (HARDEN-1):** la ausencia de `config/catalog.profile` — o un
perfil inválido/corrupto — significa **vertical `generic`**: sin ficha `perfume` fabricada,
marca solo en `Product.brand`, y stopwords de perfumería FUERA del análisis. La plantilla
`perfumeria` existe como vertical reutilizable pero se activa SOLO por configuración
explícita (`profile.vertical = 'perfumeria'`), que conserva el comportamiento vigente de
arfagi. La política efectiva del tenant (vertical + stopwords + requisitos) se propaga por
TODO el pipeline — análisis remoto (`analyzeRemoteItems`), matching, clasificación del
import y evaluador de calidad — no solo por `quality.ts`. Jamás se hardcodea un `tenantId`
en el backend. **Gate del release:** ANTES de desplegar estas Functions, arfagi necesita su
perfil `perfumeria` explícito en producción — mutación futura aprobada, acotada a
`config/catalog.profile`, sin reemplazar el resto del documento de config.

### 4b. Fencing del run de importación (HARDEN-1)

El lease de 120 s solo NO alcanza: una callable puede vivir 300 s y seguir escribiendo
después de que otro worker reclamó. Cada claim lleva una **generación inmutable**
(`generation`, patrón del outbox/saga de Shipping Chat) y TODA escritura posterior al claim
— crear producto+lock, marcar deriva remota, renovar lease (heartbeat verificado, jamás
ciego), guardar cursor/contadores, cerrar `completed`/`failed` y liberar el puntero —
demuestra ownership transaccionalmente (`generation` vigente) antes de aplicar. Un worker
vencido no escribe NADA de eso; cursor y contadores jamás retroceden. **La campana agregada
es explícitamente BEST-EFFORT (last-writer-wins)**: se recomputa siempre desde el estado
vivo con un count fuertemente consistente y se auto-corrige en el próximo refresh — no está
fenceada (tampoco en los refresh de `productUpsert` ni del mantenimiento) y no es un
invariante: es un aviso. Un worker que YA SABE que perdió el claim (`claim_lost`) no la
refresca. **El perfil de catálogo se fija al run en el claim** (igual que
`defaultCategoryId`): todas las páginas de un run se procesan con la MISMA política aunque
la config cambie a mitad.

### 4c. Operación de mantenimiento: locks y quality de productos existentes (HARDEN-1)

Los productos anteriores a este programa no tienen `quality` y los importados del flujo
curado no tienen su `metaRetailerLock`. Una operación de mantenimiento explícita —
**preview/dry-run por defecto, apply solo con confirmación explícita** — recorre los
productos del tenant paginada, reanudable e idempotente: crea los locks faltantes SIN pisar
existentes, detecta dos productos reclamando el mismo `retailerId` (conflicto ⇒ NUNCA elige
ganador: se reporta para resolución humana y no se toca nada ambiguo), y calcula `quality`
para los que no la tienen usando el perfil efectivo — sin modificar nombre, precio, costo,
stock, status, mapping ni `syncToMeta`; la campana agregada se recalcula al final y un
catálogo parcialmente evaluado jamás se presenta como completo. El camino legacy
(`metaCatalogImportItems` / confirmación de mappings) adquiere el MISMO lock que la
importación paginada y escribe la `quality` al nacer (mismo invariante que el run paginado).
El backfill de `quality` SALTEA los productos `ARCHIVED` (evaluarlos generaría bloqueos
permanentes e inaccionables; el chequeo de locks sí los incluye — la identidad remota
importa aunque el producto esté archivado). El run de mantenimiento no lleva lease
generacional completa (operación manual, owner-only, idempotente), pero su `saveProgress` es
transaccional con dos guards: jamás escribe `running` sobre un run ya `completed` y jamás
deja retroceder `pagesDone`/contadores; los errores de transacción del backfill se cuentan
(`erroresQuality`) y sellan `lastError` — un run con errores JAMÁS se presenta limpio. El
resumen de calidad expone además la COBERTURA (`sinEvaluar`): un catálogo con productos aún
sin evaluar nunca se muestra como "completo". **Esta operación NO se ejecuta en producción
durante el desarrollo: queda como paso del release auditado.**

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

Una ÚNICA notificación de campana por tenant, deduplicada por el **ID determinístico del
documento** (`catalog-quality-{tenantId}` — no existe un campo `sourceId` persistido),
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
