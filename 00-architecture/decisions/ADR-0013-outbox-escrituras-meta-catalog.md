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
4. **El trabajo no se podía acotar.** Una invocación de panel no puede sostener un catálogo
   grande sin timeout, y el consumo de llamadas a Meta crecía con la cola, sin techo.

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

### 2. La INTENCIÓN se deduplica; el JOB es historia inmutable

Son dos identidades distintas y confundirlas fue el defecto más caro de este programa.

**`intentKey`** = `sha256(len:tenantId · len:catalogId · len:retailerId · len:action ·
len:contentHash)`. Identifica *"este cambio exacto, sobre este artículo, en este catálogo"*.
Cada componente va con su largo adelante: concatenar con un separador —el error clásico— haría
que `('a|b','c')` y `('a','b|c')` colisionaran.

**`jobId`** = `${intentKey}_c000001` — **una ejecución** de esa intención. El mismo cambio puede
tener que ejecutarse muchas veces a lo largo del tiempo, y cada vez es un **ciclo** con su
propio documento. Un job **nunca se reescribe una vez terminal**: es la evidencia de qué se
envió y qué respondió Meta. El relleno de ceros hace que el orden lexicográfico —el que usa
Firestore— coincida con el cronológico.

La deduplicación vive en un **puntero transaccional** por intención
(`metaCatalogOutboxIntents/{intentKey}`) que guarda `activeJobId` y `cycle`. Es lo único que se
reescribe:

- Dos confirmaciones concurrentes del mismo trabajo **pendiente** ⇒ un solo job (el puntero ya
  apunta a un job no terminal).
- El ciclo anterior ya terminó ⇒ la confirmación nueva crea un **job nuevo**, sin tocar el
  anterior.
- Los sync logs se identifican por `jobId`, así que también son únicos por ciclo.

La versión anterior deduplicaba contra la HISTORIA y reabría el job terminal con `tx.set`. Eso
rompía dos cosas a la vez: borraba la evidencia del ciclo anterior, y —cuando el estado terminal
era `succeeded`— hacía que el ciclo más común del negocio no llegara nunca a Meta (bajar el
precio por promo, subirlo al terminar y **volver a bajarlo** produce el mismo contenido).

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

Cadencia: cada corrida está acotada por el presupuesto de llamadas (§17), no por una suposición
sobre los límites de Meta. Un tenant sin cola no gasta ninguna llamada: el gate de config y la
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

### 14. Fencing del estado visible del producto

Los jobs terminan en cualquier orden. El producto guarda `metaSyncCurrentJobId`: la generación
del estado visible. **Toda** proyección (`queued` / `processing` / `synced` / `failed` /
`needs_review`) se escribe en una transacción que primero verifica que ese job sigue siendo el
vigente. Un job viejo conserva el derecho a cerrar **su propia** historia —su documento y su
log— pero no puede tocar el estado, el error, el `metaProductItemId` ni el `metaLastSyncAt` del
ciclo actual. Sin esto, una reconciliación tardía reemplazaba el resultado de un ciclo
posterior ya confirmado.

### 15. Revalidación transaccional inmediatamente antes del POST

No alcanza con re-chequear la propiedad del claim. Justo antes de armar el lote, cada job pasa
por una transacción que revalida **todo**: ownership y generación, estado del job, tenant,
catálogo, existencia del producto, `syncToMeta`, `stockPendingReview` y el snapshot público. Lo
que ya no corresponde se **excluye individualmente** con su motivo; el resto del lote sale
igual. Un producto editado, borrado, desoptado o puesto en revisión después del claim no llega
a Meta.

**Límite inevitable y documentado:** entre ese commit y el POST externo hay una ventana de
milisegundos. Un cambio hecho exactamente ahí puede llegar a Meta igual — es irreducible sin
transacciones distribuidas con un sistema ajeno. Lo que se detecte después lo corrige el ciclo
siguiente, y nada puede declararse confirmado sin evidencia.

### 16. Recuperación humana de lo que el sistema no puede resolver

`needs_action` necesitaba una salida real. Tres callables para TENANT_OWNER / PLATFORM_ADMIN,
aislados por tenant, con la colección siempre cerrada al cliente por Rules:

- **`metaCatalogOutboxIncidents`** — lista saneada: producto, acción, motivo en castellano y los
  **nombres** de los campos que se intentaron cambiar. Nunca el contenido enviado, ni el lease,
  ni nada que permita reconstruir credenciales.
- **`metaCatalogOutboxReconcile`** — **mira Meta primero, siempre**. Igualdad confirmada ⇒
  `succeeded`. Diferencia confirmada ⇒ encola un **ciclo nuevo** (el anterior queda registrado).
  Sin evidencia ⇒ sigue en `needs_action`.
- **`metaCatalogOutboxDiscard`** — cierra con un motivo obligatorio y auditado.

**No existe un "reenviar"**: reenviar sin saber si el envío anterior llegó es exactamente lo que
este outbox evita. En el panel, la tarjeta "Revisar sincronización" solo aparece cuando hay algo
que revisar.

### 17. Presupuesto de llamadas y procesamiento justo

El cliente de Meta expone `callsMade`: cuenta **cada request**, incluidas las páginas de
`listItems` y los reintentos internos de los GET. La confirmación tiene un techo de consultas
de estado por corrida (`MAX_BATCH_STATUS_PER_RUN`, aplicado sobre los **intentos**, no sobre
las respuestas) y consulta los batches en el orden de la cola —los más viejos primero—. Al
agotarse el tope, los jobs cuyo handle no se consultó quedan **intactos**: sin marca de error,
sin consumo de intentos, para la corrida siguiente. Un `submitted` que no logra confirmarse en
una hora —API caída, handle que nunca responde— lo escala el **sweep** (que no necesita a
Meta) a revisión humana: la evidencia inaccesible no congela jobs para siempre.

El techo de consultas de estado es un contador **propio y absoluto**, no un resto del consumo
total: derivarlo de las llamadas ya hechas significaba que un catálogo grande —cuyo `listItems`
paginado consume todo el presupuesto— dejaba a los envíos sin confirmar **nunca**. La relectura
del catálogo se paga siempre (es la evidencia; sin ella no se confirma nada) y solo se ejecuta
si hay algo que evaluar: si todos los pendientes están dentro de su ventana de gracia, la
corrida no gasta ni una llamada.

El techo es una decisión **nuestra** de costo y previsibilidad. No se apoya en ningún límite
publicado: los límites de rate de la Graph API cambian con el tiempo y con el tipo de asset, así
que el sistema se acota solo en vez de asumir un número.

### 18. Lo que salió del review adversarial de este endurecimiento

Seis lentes (historia, carreras, fencing, aislamiento, presupuesto, recuperación) produjeron 54
hallazgos; 22 sobrevivieron a la verificación. Lo que cambió por ellos, además de lo anterior:

- **CRÍTICO — la confirmación asentaba el job sin precondición.** Entre la query y la escritura
  el dueño podía descartar el job desde el panel; el `update` ciego lo resucitaba, borraba el
  motivo auditado del descarte y —en la rama de reintento seguro— **reenviaba a Meta un cambio
  que una persona acababa de descartar**. Ahora toda transición de la confirmación relee el job
  en una transacción y aborta si su estado cambió.
- La recuperación manual **no tocaba jobs en vuelo ni recién enviados**: cancelar un claim vivo
  podía producir un segundo envío, y "revisar" a los dos segundos leía el estado viejo de Meta
  como si fuera evidencia. Ambos casos ahora responden que hay que esperar.
- **Descartar dice la verdad**: si el lote ya salió, el mensaje y el registro aclaran que el
  cambio pudo haberse aplicado en Meta y que descartar solo deja de seguirlo.
- Un job **terminal** ya no se reescribe ni siquiera para anotar que fue reemplazado: se marca
  como *revisado* (`reviewedAt`), que saca la incidencia de la lista sin tocar la evidencia.
  Eso también resolvió que `failed` y `stale` saturaran la lista de incidencias.
- El **token de vigencia** se publica en la misma transacción que crea el job (antes había una
  ventana donde el worker ya podía reclamarlo y el producto todavía no lo reconocía, así que
  toda proyección se descartaba y el producto quedaba "En cola" para siempre).
- El **log de cada ciclo** se escribe junto con su transición, no al final del bucle: una
  corrida cortada perdía la historia de todo lo que ya había resuelto.
- La cola de confirmación se ordena por **antigüedad**, no por id (que es un hash): había
  inanición real con más de 50 pendientes.
- La **convergencia local** de `runCatalogSync` respeta el fencing: no toca productos que tienen
  un job vigente.
- `proyectarEstado` dejó de reescribir `metaCatalogId` (revertía el catálogo vigente del
  producto si la empresa lo había cambiado).
- Un fallo de infraestructura en la revalidación pre-POST **devuelve el job a la cola con su
  intento intacto** en vez de dejarlo varado hasta que el sweep lo declarara ambiguo.
- El scheduler y el endpoint dev comparten el mismo fail-closed por tenant; la reconciliación
  manual exige el mismo plan que el mantenimiento; y el encolado distingue "ya está en camino"
  de "está esperando tu revisión" en vez de reportar todo como duplicado.

**Caveat de la infraestructura de test**: el doble de Meta vive en un documento global y no
distingue `catalogId`, así que el E2E prueba el aislamiento entre tenants a nivel Firestore y de
gates, no a nivel del catálogo remoto.

### 19. Cierre de release (META-CATALOG-OUTBOX-HARDEN-2)

El último follow-up antes del release candidate cerró las carreras que quedaban y la
observabilidad:

- **CAS en TODAS las acciones humanas.** `metaCatalogOutboxReconcile` y
  `metaCatalogOutboxDiscard` decidían con la lectura inicial y escribían con `update` directo.
  Ahora cada rama relee el job DENTRO de una transacción con precondición de estado: el cierre
  por `confirmed_equal` usa el mismo `cerrarTerminalConLog` que el mantenimiento; la rama del
  CREATE ya existente y el descarte también son transaccionales. Quien pierde la carrera relee
  el resultado vigente y responde `nothing_to_do` — jamás afirma una transición que no hizo,
  jamás resucita un descartado, y un descarte jamás convierte en `cancelled` un job que otro
  worker cerró como `succeeded`/`failed` (el resultado se preserva y solo se agrega la metadata
  de revisión).
- **Cierre terminal + sync log ATÓMICOS.** `cerrarTerminalConLog` escribe la transición
  `succeeded`/`failed` y crea el log del ciclo en la MISMA transacción, con `tx.create` para no
  sobrescribir un log existente (un replay conserva el original). Nunca más un terminal
  `succeeded`/`failed` sin su historia. **Qué estados generan log**: `succeeded` y `failed`
  (automáticos o manuales). `cancelled` y `stale` NO llevan log — son cierres administrativos
  sin resultado de Meta, y así queda documentado.
- **Contadores honestos.** `succeeded`/`failed`/`requeued`/`unresolved` se incrementan
  DESPUÉS de que la transición se aplicó; una corrida que pierde el CAS no cuenta ni audita el
  resultado de otra.
- **Tope de consultas por INTENTOS.** `handlesIntentados` se consume ANTES de llamar; una API
  de estado caída ya no permite intentar la cola entera. Un intento fallido no habilita a
  evaluar sus jobs ("sin datos" ≠ "sin errores"). El reporte separa `handlesAttempted`,
  `handlesAnswered`, `deferredHandles` y `metaCalls` (requests HTTP reales, incluidos los
  reintentos internos de los GET y las páginas de `listItems`). Máximo teórico por corrida:
  `páginas_de_listItems × reintentos + tope_de_intentos × reintentos`.
- **Bandeja sin ocultamiento.** `attentionRequired` es un campo PERSISTIDO que toda transición
  recalcula (`attentionRequiredFor`); la bandeja consulta
  `where('attentionRequired','==',true).orderBy('updatedAt','desc').limit(N+1)` — los revisados
  ya no ocupan el cupo y `truncated` se calcula con evidencia, no adivinando. El panel muestra
  un aviso accesible cuando hay más incidencias que las listadas. Índice nuevo:
  `metaCatalogOutboxJobs (attentionRequired ASC, updatedAt DESC)`.
- **Fencing también en los errores de validación.** Un intento que ni siquiera se encoló
  (request inválido, fallo de infraestructura) ya no pisa `metaSyncStatus` de un producto con
  ciclo vigente: el error se reporta en el run.
- El estado visible del producto se escribe en la MISMA transacción que crea su job (ya no hay
  commit diferido que pueda fallar en silencio).

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
