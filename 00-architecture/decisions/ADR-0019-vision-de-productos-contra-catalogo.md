# ADR-0019 — Visión de productos contra el catálogo local, con gate seguro

- **Estado:** aceptado (2026-08-14) — **EN PROD INERTE desde 2026-08-15** (productor + worker +
  scheduler desplegados por `DEPLOY-AI-RESERVATION-VISION-INERT-1`; `productVision.enabled`
  AUSENTE en todos los tenants). Canary real 2026-08-15 (`AI-VISION-PROVIDER-CANARY-ARFAGI-1`):
  entrega bloqueada por el gate ADR-0017 (`automationMode` ausente) — hallazgo que motivó la
  migración dual. **RE-CANARY EXITOSO el mismo día** tras la migración
  (`WHATSAPP-AUTOMATIONMODE-DUAL-MIGRATION-AND-VISION-RECANARY-1`): ciclo completo de punta a
  punta con proveedor real — job único `succeeded` + `envio=enviado`, reserva liquidada (real
  2.507), espejo en 0, UNA llamada al proveedor, respuesta entregada por el canal correcto
  (`…7904`), cero efectos comerciales. Desenlace `sin_match` honesto: el matcher estricto no
  ancló los indicios de la imagen sintética contra el nombre largo del catálogo — **deuda de
  CALIBRACIÓN del extractor/matcher para el programa de activación** (no un defecto del ciclo).
  Flag restaurado a AUSENTE; la activación productiva sigue siendo un programa aparte.
- **Programa:** PRODUCT-IMAGE-UNDERSTANDING-SAFE-1 (segundo y último del bloque iniciado por ADR-0018)
- **Relacionados:** ADR-0016 (adjuntos seguros; su §9 diferió visión hasta tener control de gasto),
  ADR-0018 (reserva de cuota — `imagen_vision` ya declarada), ADR-0015 (deriva externa del catálogo)

## Contexto

Los clientes mandan fotos de productos ("¿tenés este?"). Hoy la imagen se guarda, se muestra
inline y recibe un acuse — pero nadie la mira. ADR-0016 §9 difirió la visión por secuencia: faltaba
la base de control de costo. ADR-0018 la cerró. Este ADR habilita el reconocimiento **sin romper
las tres fronteras** que la fundación ya fijó: el clasificador determinístico de comprobantes tiene
precedencia absoluta, el caption jamás entra al modelo, y el catálogo local es la única autoridad.

## Decisión

### 1. Elegibilidad: visión corre DESPUÉS y DEBAJO de todo lo existente

**v2 (AI-VISION-PRODUCER-DECOUPLE-1):** el productor ya NO vive en `meta/process.ts` — es el
trigger propio **`onAiVisionProducer`** (`onDocumentUpdated` sobre `metaWebhookInbox`) que observa
la transición durable a `processed`, la cual el process.ts productivo escribe con el `tenantId`
sellado y DESPUÉS de que el gate de comprobantes persistió la clasificación final. Así, liberar
visión NO exige actualizar `onWebhookInbox` (que arrastraría el gate de automatización de
ADR-0017 sobre números sin migrar). El productor exige clasificación **estrictamente
`generic_media`** (`unclassified` = el gate no decidió ⇒ fail-closed, sin job), resuelve la
sessionKey por el índice externo (`main` ⇒ canal heredado; `wa_*` ⇒ sesión propia) sin importar
process.ts, y usa un discriminador SIN timers para la carrera de visibilidad: al marcar
`processed`, process.ts anula `payload.attachment.mediaId` SOLO si el archivo quedó almacenado —
mediaId null + adjunto no visible ⇒ reintentar (redelivery); mediaId presente ⇒ jamás se
almacenó ⇒ cerrar sin job.
Un adjunto es elegible SOLO si (todas, fail-closed — cualquier duda ⇒ no hay visión):

- ingesta `stored`, no `duplicate`, `class === 'image'`, MIME **verificado** ∈ {jpeg, png, webp}
  (PDF y documentos: fuera de este programa);
- el gate NO lo propuso como pago (`!yaPropuestoComoPago`) y su clasificación es
  `generic_media`/`unclassified` — **la visión jamás decide si algo es un comprobante**: eso ya lo
  decidió (y con precedencia) la regla determinística de ADR-0016 §4;
- la sesión NO está en `humanTakeover` y el bot está activo — verificado DOS veces: al tomar el job y, autoritativamente, como ÚLTIMA operación antes del POST (`evaluarSilencioPreEnvio`, la regla canónica de silencio.ts — review);
- el flag `tenants/{t}/config/productVision.enabled === true` (booleano **literal**, mismo patrón
  fail-closed que el nivel A de ingesta) — **apagado por defecto**; encenderlo en producción será
  un programa aparte.

El acuse de recepción existente sale igual que hoy (comportamiento intacto con flag apagado; con
flag encendido el acuse es la primera respuesta y el resultado del análisis, la segunda y última).

### 2. Job persistido por adjunto: `tenants/{t}/aiVisionJobs/{attachmentId}`

**El id del job ES el id del adjunto** (`att_<24hex>`, ya determinístico por
tenant+canal+mensaje+media): un reintento del webhook re-deriva el mismo attachmentId ⇒ `create()`
choca ⇒ **cero jobs duplicados**; el mismo archivo re-enviado como mensaje nuevo produce otro
providerMessageId ⇒ otro attachmentId ⇒ **hecho nuevo válido**.

Estados: `queued → processing → succeeded | skipped | needs_clarification | failed`.
Campos: ids de correlación (tenant/customer/attachment/message/sessionKey/channel), `attempts`
(máx. 5), `leaseUntil` (5 min), `claimId` (fencing), `envio` (`pendiente|en_vuelo|enviado`),
`resultado` saneado mínimo (`matchType`, `productIds` del servidor, nombre elegido) y `motivo`.
**Jamás**: imagen, caption, prompt, respuesta cruda del modelo, rutas de Storage, URLs.

Patrones copiados de `coverageResume.ts` (no inventados):
- **claim transaccional**: reclamable si `queued` o `processing` con lease vencido; el claim
  incrementa `attempts` y escribe `claimId` nuevo;
- **lease**: 5 min — con margen sobre el peor caso real del worker (descarga 10 MB + proveedor con timeout 20 s × 3 intentos del SDK); 60 s producía claims solapados de workers vivos (review);
- **fencing**: todo settlement (y la transición a `envio:'en_vuelo'`) exige `job.claimId ===` el
  propio — un worker zombi que despierta después del lease **no puede aplicar su resultado**;
- **una sola respuesta física**: antes de enviar, transición fenced a `envio:'en_vuelo'`; después,
  settlement fenced a `enviado`. Un claim posterior que encuentre `en_vuelo` con lease vencido
  cierra `failed / envio_incierto` **sin re-enviar** — ante la duda, ningún mensaje doble; un
  veredicto `silenciado` del guard pre-envío cierra `skipped` limpio (nada se envió);
- **recuperación**: barrido dentro de `aiReservationMaintenance` (scheduler ya existente del
  ADR-0018): `processing` con lease vencido → re-encolado (si `envio` no quedó incierto) y
  el re-encolado RE-DISPARA el procesamiento directo (onDocumentCreated no ve updates — la
  lección de coverageMaintenance). Índice collection-group `(status, leaseUntil)`.
- Disparador: `onAiVisionJob` (`onDocumentCreated`, `retry:true`, secreto `ANTHROPIC_API_KEY`) —
  mismo patrón que `onCoverageResumeJob`.

### 3. Extracción estructurada: la IA describe, JAMÁS decide

El gateway gana el **mínimo** necesario: un bloque de imagen (`AiImageBlock` base64 → SDK) y
`toolChoice` forzado. `runVisionExtraction` hace UNA llamada sin loop de tools: imagen + prompt de
sistema fijo (sin caption — §9 de ADR-0016 sigue intacto), tool forzada `reportar_indicios` cuyo
input lo valida **zod** y lo sanea el servidor (caps de longitud, strings planos):

```
{ textoVisible?, marcaAparente?, nombreAparente?, categoriaSugerida?,
  rasgos?: string[], confianza: 'alta' | 'media' | 'baja' }
```

Indicios **universales** — nada de perfumería hardcodeada; sirve para cualquier vertical.
La IA no recibe: catálogo, costos, márgenes, pedidos, pagos, tenant ajeno, tools de escritura,
URLs. Los bytes los lee el **backend** del Storage privado (`storage.path` del doc del adjunto,
re-verificando MIME y tamaño); si el archivo fue purgado (`storage.path null` / `purgedAt`) ⇒
`skipped` fail-closed sin IA. La reserva `imagen_vision` (ADR-0018) se toma ANTES de contactar al
proveedor con clave POR INTENTO `vision-{attachmentId}-a{n}` (un error transitorio cierra su reserva y el reintento abre otra; el anti-duplicado concurrente lo dan claim+lease+fencing — review); denegada ⇒ `skipped` sin llamada y sin promesa rota
(el acuse ya reconoció la imagen; no se promete análisis). La reserva **no** es el mecanismo
anti-duplicados: eso lo garantizan claim+lease+fencing; la reserva solo controla el gasto.
El resultado del proveedor se liquida con el uso real (parcial en error incluido); `disabled` ⇒
liberar.

### 4. Resolución: el catálogo del tenant es la única autoridad

1. El servidor compone una consulta saneada con los indicios (texto plano, sin operadores).
2. Busca con **`searchCatalog(tenantId, …)`** y se queda SOLO con los matches reales de la
   consulta (`splitByQueryMatch.pinned`): el relleno de sugerencias del buscador es correcto para
   el sales agent y letal para visión (presentaría cualquier producto como identificación — review).
   Es el MISMO buscador del bot, con sus guards:
   `status ACTIVE`, stock trackStock-aware, deriva externa (`filtrarOfrecibles`), `profitMode`
   siempre false — más el filtro de calidad bloqueante. `stockPendingReview` nace `INACTIVE`
   (ADR-0015), así que el guard de status ya lo cubre.
3. Desenlaces (los textos SIEMPRE con nombre/precio/stock **de Firestore** — cualquier precio,
   nombre o dato que "recuerde" el modelo se descarta):
   - **una coincidencia fuerte** ⇒ ofrecer ese producto (nombre + precio del servidor);
   - **2–3 razonables** ⇒ listar y preguntar cuál;
   - **indicios insuficientes** (confianza baja / sin términos útiles) ⇒ pedir nombre/marca u
     otra foto (`needs_clarification`);
   - **cero vendibles** ⇒ decir honestamente que no se identificó. Sin inventar, sin crear
     productos, sin escribir en Meta.

Los indicios son **datos no confiables**: texto dentro de la imagen con "instrucciones" es un
string más que viaja a una búsqueda — nunca se interpreta ni ejecuta.

### 5. Panel: estado discreto, cero información sensible

El settlement proyecta al doc del adjunto `vision: { state, productName? }` con estados
`identificado | aclaracion | sin_match` (los `skipped` no proyectan chip; `no_analizado` queda
reservado para el programa de activación). El panel ya refresca los
adjuntos cada 10 s; se agrega el campo a la proyección `PanelAttachment` y un chip discreto junto
a los de comprobante. Sin confianza técnica cruda, sin prompts, sin rutas, sin URLs. La purga de
bytes no toca este campo (no contiene PII ni material de la imagen).

### 6. Autorización, Rules y aislamiento

`aiVisionJobs`: `allow read, write: if false` (superficie exclusiva del backend). El `tenantId`
de todo el ciclo nace del webhook ya resuelto server-side (índice externo → inbox → process), el
job lo transporta y el worker lo re-usa: no existe camino para cruzar tenants. El panel no gana
lecturas nuevas (el chip viaja en el doc del adjunto que ya lee).

## Consecuencias

- (+) "¿Tenés este?" con una foto por fin se responde — con datos del catálogo, no de la memoria
  del modelo, y en cualquier vertical.
- (+) Cero riesgo nuevo sobre pagos: el flujo ni lee ni escribe pedidos/pagos/auditorías, y un
  comprobante jamás llega a visión.
- (−) Una imagen elegible cuesta ~2.600 tokens estimados (reserva `imagen_vision`); el flag por
  tenant y las alertas de ADR-0018 contienen el gasto.
- (−) `send → settle` no es atómico: la ventana se cierra con `envio:'en_vuelo'` + fencing, al
  costo de que un crash exactamente ahí termine en `failed / envio_incierto` sin respuesta de
  visión (el acuse ya salió; preferible a un duplicado).
- Deuda explícita: PDF/documentos y OCR de comprobantes quedan fuera; el fixture del FakeAiClient
  simula la visión en el emulador (la calidad real del extractor se calibra recién con proveedor
  real, en el programa de activación).
