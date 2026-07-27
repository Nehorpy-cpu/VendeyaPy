# ADR-0013 — Las escrituras al Meta Catalog pasan por un outbox persistido

**Fecha:** 2026-07-27
**Estado:** Aceptada e implementada (programa META-CATALOG-OUTBOX-1) — **en repo, NO desplegada**
**Decisores:** Owner del proyecto

---

## Contexto

Hasta `da538f8`, `catalogSyncApply` hacía todo dentro de la invocación que atendía al panel:
planificaba, enviaba el lote a `items_batch`, consultaba el estado del batch, releía el
catálogo y escribía el estado de cada producto. Terminaba devolviendo `status: 'applied'`.

Cuatro cosas estaban mal, y ninguna es cosmética:

1. **`items_batch` es asíncrono.** Meta devuelve un *handle* de aceptación, no un resultado.
   Llamar "aplicado" a eso es afirmar algo que Meta todavía no dijo.
2. **Un crash a mitad no dejaba rastro.** Si la función moría después del POST, no quedaba
   registro de qué había salido. La corrida siguiente replanificaba desde cero y podía volver
   a enviar —o no enviar— sin que nadie pudiera saber cuál de las dos cosas pasó.
3. **Un error de red no se distinguía de un rechazo.** Ambos terminaban en `failed`. Pero un
   timeout después de que Meta aceptó significa que **el cambio PUDO haberse aplicado**:
   reintentarlo a ciegas, con `allow_upsert:false`, hace fallar el CREATE por id duplicado y
   deja marcado como roto un artículo que en realidad se creó bien.
4. **El trabajo no se podía acotar.** El límite de Meta es de 100 llamadas por hora y por
   catálogo; una invocación de panel no puede sostener un catálogo grande sin timeout.

## Decisión

### 1. Confirmar el plan ENCOLA; no aplica

`runCatalogSync(mode:'apply')` conserva intacto todo lo read-only (config fail-closed, gate de
`mode:'live'`, lectura de Meta, plan, preview obligatorio) y, en lugar de enviar, crea un **job
persistido por acción** en `tenants/{tenantId}/metaCatalogOutboxJobs/{jobId}`. Devuelve
`status: 'queued'` con `queuedCount` / `deduplicatedCount` / `blockedCount`. **`appliedCount` y
`lastSuccessfulSyncAt` dejaron de escribirse al encolar**: encolar no es aplicar.

El panel dice "Cambios encolados hacia Meta" y cada producto muestra *En cola → Procesando →
Confirmado / Requiere revisión / Error*. **`Confirmado` significa confirmado contra Meta**, no
"lo mandamos".

### 2. La identidad del job es determinística e inyectiva

`jobId = sha256(len:tenantId · len:catalogId · len:retailerId · len:action · len:contentHash)`.

- Dos confirmaciones idénticas producen **un solo job** (la segunda choca contra `create()` y
  se cuenta como duplicada, sin tocar el job existente ni siquiera si es terminal).
- Un cambio posterior cambia el `intendedContentHash` y por lo tanto el job.
- **Cada componente va con su largo adelante.** Concatenar con un separador —el error clásico—
  haría que `('a|b','c')` y `('a','b|c')` produjeran el mismo documento: dos confirmaciones
  distintas pisándose.

### 3. El patch viaja CONGELADO

El job guarda `intendedPatch` (el `data` del contrato de escritura, ya validado) y
`productSnapshotHash` (hash de la vista pública del producto en el momento del preview). El
worker envía **el patch congelado**, nunca una re-serialización del producto en vuelo. Si el
producto cambió desde el preview, el job queda **`stale`** y exige una confirmación nueva: el
vendedor aprobó *ese* cambio, no el que haya ahora.

### 4. Claim transaccional, lease y fencing

Patrón heredado de la saga de cotización de envío (SHIPPING-CHAT-3C/HARDEN-4), ya probado en
producción:

- **Claim** en transacción: `queued → processing`, con todas las lecturas antes de la primera
  escritura, y **los gates revalidados adentro** (config, tenant, catálogo, opt-in, snapshot).
- **Lease** de 120 s. Vencido, el job pasa a `needs_reconciliation`, nunca a "reintentar".
- **Fencing**: `attempts` es la generación inmutable del claim. Todo settlement exige
  presentarla junto con el estado `processing` (`settleIfOwner`). Un worker zombi —cuyo lease
  venció y el sweep ya normalizó— **no escribe nada**.
- **Re-chequeo de ownership inmediato antes del POST**: si el worker perdió el claim, no se
  envía nada. Cero segundo envío físico.

`settleIfOwner` se extrajo a `lib/outboxFencing.ts`. La saga de cotización conserva su copia:
está desplegada y verificada, y migrarla es un refactor con riesgo propio ajeno a este programa.

### 5. Aceptación ≠ éxito

El handle se persiste (`status: 'submitted'`) **antes de cualquier seguimiento**. Ahí termina
el envío. La confirmación es una fase aparte que relee el catálogo.

### 6. Verificación honesta de TRES estados

Cada campo gestionado devuelve `confirmed_equal` | `confirmed_different` | **`unverifiable`**.

La tercera es la que faltaba. Si mandamos `link` y Meta no devuelve `url`, el resultado es
**`unverifiable`, jamás `equal`**: el artículo podía no haberse escrito nunca. Un job solo
queda `succeeded` cuando **todos** los campos de su patch están `confirmed_equal` — y solo se
verifican los campos que el patch mandó: un UPDATE de solo precio se confirma con el precio y
no queda atascado por campos que este sistema no administra.

`condition` se agregó a los campos que se leen de Meta: un CREATE lo manda, así que sin leerlo
un CREATE nunca podría confirmarse del todo.

### 7. La ambigüedad se mira, no se reintenta

| Error del envío | Significado | Qué hace el outbox |
|---|---|---|
| 4xx funcional | Meta rechazó: **nada** se escribió | `failed` (`contract_violation`) |
| 429 agotado | Tampoco se escribió, pero hay que esperar | vuelve a `queued` **sin consumir intentos** |
| 5xx / red / timeout | **Pudo haberse aplicado** | `needs_reconciliation` |
| excepción desconocida | Ambigua por definición | `needs_reconciliation` |

Un `needs_reconciliation` se resuelve **mirando el catálogo real**: si ya coincide ⇒
`succeeded`; si difiere de forma confirmada ⇒ el reintento es seguro y vuelve a `queued`; si no
se puede determinar ⇒ queda para una persona. **Jamás un reintento a ciegas.**

### 8. Aislamiento de tenant como primera verificación

El gate compara `job.tenantId` contra el tenant que procesa **antes que nada**: procesar un job
ajeno significaría haber leído la config y el producto del tenant equivocado, así que ninguna
otra verificación valdría. La colección está cerrada al cliente en `firestore.rules`
(`allow read, write: if false`): un job es una orden de escritura con su generación de fencing;
tocarlo desde el navegador permitiría reenviar, revivir terminales o saltear los gates.

### 9. Entitlements revalidados fuera del callable

El drenaje corre en un scheduler, fuera de la invocación que lo originó. Se revalida
`marketingAutomation` por tenant: si no, un tenant degradado seguiría escribiendo en Meta por
la cola vieja.

### 10. Lotes acotados por cantidad Y por tamaño

100 jobs por lote y 900 KB serializados. Un job que por sí solo excede el tope viaja **solo**:
descartarlo lo dejaría atascado para siempre y meterlo con otros haría fallar un lote entero
por culpa de uno.

### 11. Sweep como red de seguridad

Cada 5 minutos, por tenant: `processing` con lease vencido ⇒ `needs_reconciliation`;
`needs_reconciliation` de más de una hora ⇒ `needs_action` (ya no converge solo). Reejecutable:
cada transición se re-verifica dentro de su propia transacción.

Cadencia: cada corrida gasta como mucho 3 llamadas a Meta (submit + estado + relectura) contra
un límite de 100/hora por catálogo. Un tenant sin cola no gasta ninguna: el gate de config y la
query de `queued` cortan antes de tocar la red.

### 12. El fake modela el ciclo asíncrono real

`FakeMetaCatalogClient` relee su fixture en cada llamada (antes lo congelaba en el constructor,
lo que hacía imposible mutar el estado remoto entre el envío y la relectura), distingue
`failWith.when: 'before_accept' | 'after_accept'` —los dos momentos de falla con consecuencias
opuestas—, puede aplicar el batch sobre el catálogo simulado **normalizando la URL igual que
Meta**, y reporta estado y errores por handle.

### 13. Correcciones que salieron del review adversarial

Cuatro revisores independientes (idempotencia, ambigüedad, aislamiento, privacidad) atacaron la
implementación. Lo que cambió por sus hallazgos:

- **El transporte ya no reintenta el POST.** `HttpMetaCatalogClient` reintentaba `items_batch`
  hasta 3 veces ante 5xx o timeout — un reintento a ciegas **por debajo** de toda la disciplina
  de ambigüedad, y sin dejar rastro. Ahora solo los GET se reintentan; el POST devuelve el error
  ambiguo y decide el outbox. (También cerraba un caso feo: timeout en el intento 1 y 429 en el
  2 se clasificaba como `rate_limited` y se reenviaba.)
- **Un job cerrado sin éxito se REABRE con una confirmación nueva.** Como el id es
  determinístico por contenido, un `failed`/`cancelled`/`stale` dejaba al producto sin ninguna
  forma de reintentar: la confirmación siguiente caía en el mismo job muerto y se contaba como
  duplicada. Ahora una confirmación explícita del dueño reabre ese job (y solo ese: `succeeded`
  con contenido idéntico sigue siendo un duplicado sin trabajo).
- **`held` dejó de ser un estado sin salida**: el drenaje también toma los retenidos, y el
  claim los re-evalúa con la config fresca.
- **Se acabó el livelock de la reconciliación**: reescribía `updatedAt` en cada pasada, así que
  un ambiguo sin evidencia rejuvenecía para siempre y nunca escalaba a revisión humana.
- **Los errores por item se indexan por `handle|retailer_id`**, no solo por artículo: dos lotes
  distintos pueden incluir el mismo producto y se le atribuía a un job la falla de otro.
- **La confirmación exige el MISMO catálogo**: si `catalogId` cambió, lo que se está leyendo no
  es el catálogo al que el job se envió y no puede confirmar ni desmentir nada.
- **El precio compara la moneda declarada**: "250000 PYG" y "250000 USD" tienen los mismos
  dígitos.
- **El `disable` mínimo de un producto con bloqueos lleva el snapshot público completo**: con
  un snapshot reducido nunca coincidía con el que recalcula el gate y el apagado quedaba
  `stale` para siempre — el artículo no se ocultaba nunca en Meta.
- **Anti-inanición**: la cola se ordena por `updatedAt` ascendente. Ordenando por id, los jobs
  que vuelven a la cola ocupaban siempre los mismos lugares del lote.
- **Un fallo de infraestructura al encolar ya no se cuenta como duplicado** (reportaba "ya
  estaba encolado" para trabajo inexistente).
- **Un job rechazado por el gate refresca el estado visible del producto**: antes quedaba "En
  cola" para siempre aunque el job estuviera cancelado.

Segunda tanda, tras la verificación adversarial de los hallazgos:

- **CRÍTICO — la deduplicación es sobre trabajo PENDIENTE, no sobre historia.** El id es
  content-addressed y no tiene época, así que un `succeeded` viejo bloqueaba para siempre una
  confirmación nueva con el mismo contenido. El ciclo más común del negocio lo disparaba:
  bajar el precio por promo → subirlo al terminar → **volver a bajarlo** produce exactamente
  el mismo patch que la primera vez, y esa segunda promo no llegaba nunca a Meta mientras el
  panel informaba "ya estaba encolado". Idéntico con agotar stock, reponer y volver a agotar:
  el artículo quedaba vendible en Meta sin stock. Ahora **cualquier** job terminal se reabre —
  el plan se calcula contra una relectura fresca de Meta, así que una entrada accionable ES la
  prueba de que el catálogo remoto hoy no tiene ese contenido.
- **La confirmación tiene ventana de gracia (60 s).** `items_batch` es asíncrono; verificar a
  los dos segundos leía el estado viejo y lo llamaba "divergencia confirmada", mandando a
  revisión humana envíos perfectamente normales.
- **Un CREATE cuyo artículo ya existe no se reencola.** Con `allow_upsert:false`, repetirlo lo
  rechaza por id duplicado y dejaba `failed` un artículo que se había creado bien.
- **Devolver a la cola sin enviar devuelve también el intento.** Cinco caídas de token
  agotaban el tope de reintentos y mandaban a revisión humana una cola que jamás tocó Meta.
- **Kill-switch inmediato pre-POST**: la config se re-lee justo antes de enviar. Entre el claim
  y el POST alguien pudo apagar la sync, y hasta ahora solo se revalidaba la propiedad del claim.
- **El scheduler solo recorre tenants ACTIVE y no borrados**, y consulta el plan **sin
  auditar**: `assertFeatureEnabled` dejaba un registro de bloqueo cada 5 minutos en cada
  empresa que no usa el catálogo — incluida la que tiene que quedar intocada.

## Semántica de entrega

**At-least-once acotado con verificación.** No es at-most-once: un job puede reintentarse, pero
solo después de comprobar contra Meta que el envío anterior no llegó. `update` y `disable` son
idempotentes por `retailer_id`; el `create` está protegido porque un reintento solo se autoriza
cuando la relectura muestra que el artículo no está.

## Consecuencias

- **Cero escrituras reales en Meta.** El camino sigue sin ejecutarse en producción:
  `catalogSync` en `dry_run`, ningún producto con `syncToMeta:true`, cero `items_batch`.
- El vendedor deja de ver "aplicado" cuando lo único que pasó fue "encolado".
- Un crash del worker ya no pierde información: el job persiste con su estado y su handle.
- Aparecen estados que antes no existían y que **requieren a una persona**
  (`needs_action`, `needs_reconciliation`). Es el costo de no mentir: antes esos casos
  terminaban en un `failed` o en un `synced` igualmente falsos.
- `META_SYNC_STATUS` sumó `queued`, `processing` y `needs_review`.
- Índice nuevo: `metaCatalogOutboxJobs (status, updatedAt)` — **hay que crearlo antes de
  desplegar el scheduler**, o el sweep falla.

## Pendiente (fuera de este programa)

- **Alertas de calidad por producto** (requisito obligatorio de G1/G2/G3): observaciones
  persistentes por producto, contador en Catálogo/Dashboard, notificación agregada e
  idempotente, CTA para corregir, cierre automático tras revalidación, reglas universales sin
  hardcodear perfumería.
- Editor completo de productos vinculados y el importador genérico de catálogos.
- La **primera escritura real** (Odyssey: precio ₲130.000 → ₲250.000) sigue siendo un programa
  separado y controlado.

## Relación con otros ADR

- **ADR-0012** — contrato de escritura: el outbox transporta exactamente ese contrato; nada de
  lo que aquel decidió cambió acá.
- **ADR-0011** — costo de envío desde la revisión de cobertura: de ahí sale el patrón de saga
  (claim/lease/fencing/settlement) que este outbox reutiliza.
- **ADR-0009** — arquitectura de integración con Meta: este ADR reemplaza su descripción del
  camino de escritura como una operación síncrona.
