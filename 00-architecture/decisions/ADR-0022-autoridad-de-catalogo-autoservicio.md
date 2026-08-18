# ADR-0022 — Autoridad de catálogo autoservicio (quién administra el catálogo)

- **Estado:** Aceptado — EN REPO, NO DESPLEGADO
- **Fecha:** 2026-08-18
- **Relacionados:** ADR-0012 (contrato de escritura), ADR-0013 (outbox), ADR-0014 (importación
  y calidad), **ADR-0015 (propiedad por campos — la base desplegada de esta decisión)**,
  ADR-0019 (catálogo local como única autoridad para visión), ADR-0020 (onboarding conexión).

## Contexto

ADR-0015 ya modela QUIÉN ESCRIBE cada campo (`catalogSync.ownership`: `model ∈
vendeyapy_managed|external_managed|hybrid`, `ownedFields`, declaración externa, normalización
fail-closed nivel 2 con techo de modo) y está desplegado con arfagi en `external_managed`.
Lo que NO existe (auditoría 2026-08-18, con evidencia):

1. El eje **relación con Meta** como intención declarada: un tenant local-sin-Meta (credipower)
   es indistinguible de uno mal configurado — ambos caen en el silencio de nivel 1.
2. Un **camino de escritura** para la autoridad utilizable por el owner: el único write real es
   `catalogSync.ownership` vía la migración (no cableada en el panel); `enabled/mode/catalogId`
   solo se siembran a mano en scripts. `sourceOfTruth` es un literal legacy muerto.
3. **Gating por autoridad en las acciones**: import/reconcile/maintenance solo exigen
   `catalogId`; un tenant `external_managed` puede importarlos sin gate; `runTenantJob`
   autoriza `catalogSyncApply` a MANAGER en el backend (la UI lo esconde — asimetría real).

## Decisión

### 1. Contrato canónico (mapea sobre la convención existente; nada se renombra)

Eje nuevo **declarado**: `catalogSync.relationship: 'none' | 'mirror' | 'managed'`.
Eje existente **conservado**: `catalogSync.ownership` (ADR-0015) expresa la autoridad.

Contrato derivado tipado (sin strings libres), `deriveCatalogAuthority(raw)` en shared:

```
{ authority: 'vendeyapy' | 'meta' | 'external',
  relationship: 'none' | 'mirror' | 'managed',
  declared: boolean,            // relationship explícito vs derivado legacy
  reasons: AuthorityReason[],   // por qué se degradó, si se degradó
  botCatalog: 'local_mirror' }  // INVARIANTE: el bot solo consume Firestore
```

- `authority = 'vendeyapy'` ⟺ `ownership.model = 'vendeyapy_managed'` (o `hybrid`, avanzado).
- `authority = 'meta'` ⟺ `external_managed` con `external.kind = 'commerce_manager'`.
- `authority = 'external'` ⟺ `external_managed` con `kind = 'meta_feed' | 'other_api'`.

**Derivación legacy determinística (pura, cero escrituras, cero backfills):**
sin `catalogSync` ⇒ `vendeyapy + none` (local-sin-Meta de facto — el bot ya funciona así);
`external_managed` ⇒ `mirror` (+ `meta`/`external` según `kind`) — **arfagi ⇒ external+mirror**;
`vendeyapy_managed`/`hybrid` con `enabled && catalogId && writable>0` ⇒ `managed`; si falta
algo ⇒ `none` con reason. `relationship` declarado incoherente con `ownership` ⇒ fail-closed
al derivado + reason (jamás se «cree» la declaración por sobre la normalización nivel 2).
credipower: sin config ⇒ `vendeyapy+none`, cero mutaciones. meta-review: según sus datos
sembrados reales.

### 2. Combinaciones válidas (únicas cuatro simples + hybrid avanzado)

| | authority | relationship | Requiere | El bot |
|---|---|---|---|---|
| A | vendeyapy | none | nada de Meta | vende del catálogo local activo/elegible |
| B | vendeyapy | managed | conexión + catalogId + ownership escribible + gates vigentes | ídem local; publica vía preview→apply/outbox existentes |
| C | meta | mirror | conexión + catalogId | ídem local; Meta alimenta el espejo (import/reconcile), cero escritura a Meta |
| D | external | mirror | fuente externa reconocida vía Meta (modelo arfagi) | ídem local; deriva comercial sigue fail-closed |

`external + managed` es **inválido** (una fuente externa gobierna los mismos campos ⇒ conflicto
de ownership, ya bloqueado por nivel 2). El conector directo de URL CSV/JSON para páginas
externas queda para el programa siguiente: acá solo se soportan fuentes ya reconocidas mediante
Meta, y el panel NO muestra una opción engañosa de URL.

### 3. Transición de modo: preview→apply reutilizando el patrón real del repo

Dos callables OWNER/PLATFORM_ADMIN (tenant derivado del token vía la autenticación existente):

- `metaCatalogAuthorityPreview({ target: {authority, relationship} })` — relee config, conexión,
  catálogo, ownership, locks, fuentes detectadas, import state, runs y outbox; calcula efectos
  SIN escribir; devuelve `{resumen, bloqueos[], advertencias[], planHash, expiresAt, estadoEsperado}`.
  Sin tokens, URLs firmadas, query strings ni PII. Run persistido en
  `tenants/{t}/metaCatalogAuthorityRuns/{runId}` (Admin-SDK-only).
- `metaCatalogAuthorityApply({ runId, planHash })` — mismo contrato de evidencia que
  `meta/catalog.ts` (TTL 10 min, uso único con `consumedAt` transaccional, mismo actor, motivos
  `preview_required|not_found|mismatch|expired|consumed|actor_mismatch`); precondición fresca
  sobre el doc de config (cambio concurrente ⇒ `failed-precondition`); **update mask estricto**:
  escribe SOLO `catalogSync.relationship` y — si la transición cambia de modelo —
  `catalogSync.ownership` con la MISMA normalización/propuesta del módulo de migración ADR-0015.

**Lo que apply JAMÁS hace:** borrar productos/mappings/locks/jobs/auditorías, desconectar Meta,
tocar feed/`catalogId`/`enabled`/`mode`, activar live, habilitar `syncToMeta`, crear jobs de
envío. El modo anterior queda auditado (`meta.catalog_authority_changed`: antes, después, actor,
plan consumido); volver atrás = nuevo preview→apply (cero restauraciones ciegas).

**Bloqueos del preview (fail-closed):** conflicto fuente-externa-vs-campos-propios; outbox con
jobs NO terminales (`queued|processing|submitted|held|needs_action|needs_reconciliation`);
import run o sync run en vuelo (claim/lease activo); conexión o `catalogId` faltante cuando el
destino lo exige (B/C); ownership incompatible (reasons nivel 2); mapping/lock cross-tenant o
ambiguo; rol insuficiente.

### 4. Gating de acciones por relación (server manda; la UI espeja)

- `none`: NINGUNA acción Meta (import/reconcile/maintenance/verification/outbox/setSyncEnabled/
  catalogSync\* rechazan con `authority_relationship_blocked`). El bot y el CRUD local intactos.
- `mirror`: importar/reconciliar/verificar/mantener permitidos; TODA escritura hacia Meta
  bloqueada (outbox/apply/`setSyncEnabled` — este último ya bloquea por `writable=0`, se suma el
  gate explícito). Los campos públicos gobernados se muestran read-only-con-explicación en el
  panel; los internos (costo, margen, notas, clasificación) siguen locales y editables.
  **Se conserva la semántica ADR-0015 de edición local consciente** (caso Odyssey: registrar la
  intención comercial local está permitido con advertencia explícita — la deriva sigue
  bloqueando la venta fail-closed; jamás se guarda en silencio).
- `managed`: exactamente los rails vigentes (preview→apply ligado, dry-run/live por
  `effectiveMode`, opt-in por producto, outbox). Nada se activa automáticamente.
- Asimetría corregida: `catalogSyncApply` pasa a OWNER/PLATFORM_ADMIN también en el backend
  (`runTenantJob`), alineado con `metaCatalogSetSyncEnabled`.
- Schedulers: ya resuelven config POR TENANT (cron de verificación y outbox); se suma el gate de
  relación por tenant y se conserva que el error de un tenant no detiene el barrido.

### 5. Frescura y honestidad

Para autoridad remota (`mirror`), el panel muestra la última verificación/sincronización real
(`metaVerifiedAt` / `lastSourceCheckAt` / último import) y su antigüedad, con advertencia si el
espejo está viejo. Nada se declara «verificado» sin evidencia. Una caída de Meta no vacía el
espejo local (el catálogo vive en Firestore). Productos con deriva comercial siguen fail-closed.

### 6. Matriz de roles

| Acción | VIEWER | SELLER | MANAGER | OWNER | PLATFORM_ADMIN |
|---|---|---|---|---|---|
| Ver estado de autoridad (tarjeta/selector) | ✗ | operativo mínimo | ✓ (solo lectura) | ✓ | ✓ |
| Preview/apply de cambio de autoridad | ✗ | ✗ | ✗ | ✓ | ✓ |
| Acciones Meta según relación (import/reconcile/…) | ✗ | ✗ | lecturas de estado | ✓ | ✓ |
| `catalogSyncApply` (publicar a Meta) | ✗ | ✗ | ✗ (antes: ✓ backend — corregido) | ✓ | ✓ |

## Endurecimientos de la review adversarial (todos aplicados)

- **Outbox bajo `mirror`/`none` (ALTO)**: el scheduler gatea por relación SOLO el drain (el único
  paso que escribe a Meta); el sweep (escala `processing` con lease vencida a revisión humana) y
  el reconcile de `submitted` corren SIEMPRE, y `metaCatalogOutboxDiscard` funciona con cualquier
  relación (cancelación local). Sin esto, un job no-terminal de un tenant legacy derivado a
  mirror quedaba zombi irrecuperable y bloqueaba el regreso a `managed` (deadlock).
- **Carrera de encolado (MEDIO)**: `enqueueCatalogPlan` re-deriva la relación DENTRO de su
  transacción (además de la re-validación de ownership ADR-0015 §7) y el apply de autoridad
  re-chequea el preview de sync vigente — un `catalogSyncApply` en vuelo ya no puede encolar
  jobs después de que la autoridad cambió.
- El opt-out de verificación solo se honra sin fuente externa declarada; el apply re-chequea la
  conexión cuando el destino la exige; `catalogSync` (dry-run read-only) se permite bajo
  `mirror` (diagnóstico legacy de arfagi) mientras `catalogSyncApply` sigue `managed`-only; la
  detección de campos gobernados en el panel incluye `status` (disponibilidad publicada) y avisa
  genérico si el ownership no cargó; el `mode` no participa de la derivación de relación
  (`enabled:true + mode:'off'` = `managed` con envío apagado, no un tenant sin relación).

## Consecuencias y deudas

- `catalogId` sigue sin selector (se siembra a mano): elegir catálogo de Meta queda como deuda
  explícita para el programa del conector/selección — el preview lo reporta como bloqueo
  honesto (`catalog_id_missing`) al intentar B/C.
- El conector directo de URL externa (CSV/JSON) queda para el programa siguiente; el selector
  lo dice sin botón falso.
- La verificación para `vendeyapy+managed` sigue la elegibilidad ADR-0015 (sin gobierno externo
  no refresca `metaVerifiedAt`); documentado, sin cambio de comportamiento.
- Tenants legacy NO se migran: la derivación es pura y en memoria; fixtures/emulador pueden
  probar la clasificación. Producción congelada (App Review en curso).
