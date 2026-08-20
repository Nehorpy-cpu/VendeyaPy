# Auditoría de sistema — seguridad, acciones y UI (2026-08-19)

> **Programa:** SYSTEM-AUDIT-SECURITY-ACTIONS-UI-1 · READ-ONLY sobre producción, emulador para
> reproducir · **CERO FIX APLICADO**: este documento es el catálogo, no el arreglo.
> Base: `main` @ `86724a8`. Seis auditorías con foco disjunto; cada hallazgo se intentó refutar
> antes de reportarse. Los IDs de cada agente van entre paréntesis para trazabilidad.

Categorías del programa: **A** = vulnerabilidad · **B** = error de acción (hace algo distinto de
lo que promete, o falla en silencio) · **C** = hueco de UI.

## 0. Resumen ejecutivo

**3 CRÍTICOS · 15 ALTOS · 17 MEDIOS · 17 BAJOS/INFO (56 hallazgos).**

Ninguno de los CRÍTICOS es explotable hoy **por un tercero**, porque hoy no hay terceros con
cuenta en el sistema: los tres se vuelven graves exactamente cuando entra el primer cliente
externo — que es lo que habilita el Tramo 1. El CRÍTICO H-01 **no necesita atacante**: ocurre
solo, ante un error transitorio de Firestore.

Lo que **aguantó** el ataque (verificado, no asumido): aislamiento de tenant en callables y
Rules; imposibilidad de que la IA fabrique precios/SKUs o mueva dinero; el contrato de que el
caption del cliente jamás llega al modelo (atacado por seis rutas); cero hard-delete de
pedidos/pagos/comprobantes/auditoría; URLs firmadas nunca persistidas; los 22 endpoints `dev*`
devuelven 404 real en prod; un owner NO puede auto-mejorarse el plan (deny-list completa).

## 1. Tabla de hallazgos

| id | cat | sev | archivo:línea | qué se rompe | reproducción | ¿bloquea Tramo 1? |
|---|---|---|---|---|---|---|
| **H-01** (A4-1) | B | 🚨 CRÍTICO | `functions/meta/webhookHttp.ts:575,579,659,662` | Si la escritura del inbox falla (error transitorio), el webhook responde 200 `ok:true` ⇒ Meta no reintenta ⇒ el mensaje del cliente desaparece: sin burbuja, sin no-leído, sin lead. El resumen `written:0` es idéntico al de un lote vacío y el log no lleva tenant ni número | vitest 4/4: 200 con cero escrituras; redelivery probada segura (id determinístico por wamid ⇒ `duplicates:1`) | **SÍ** |
| **H-02** (A1-1) | A | 🚨 CRÍTICO | `users/manage.ts:20-41` (+ `:15-18`) | Un TENANT_OWNER reescribe los claims de CUALQUIER usuario sabiendo su email: secuestra al owner de otro tenant y **degrada al PLATFORM_ADMIN**; `setUserActive` deshabilita su cuenta. `assertSameTenant` es fail-open y `inviteUser` ni la llama. Sin App Check en ninguna callable | vitest 5/5 | **SÍ** |
| **H-03** (A5-1) | C | 🚨 CRÍTICO | `app/(panel)/agent/page.tsx:46-56,80` · `app/(panel)/promotions/page.tsx:60-90,325` | "Guardar cambios" sin `onError`: si el backend rechaza (400), la UI queda **muda** y el trabajo se pierde. La config del agente es *cómo vende el bot*: el owner queda operando con una creencia falsa | en vivo: `agentConfigUpdate → 400` y `promotionUpsert → 400` sin feedback; al recargar, el texto vuelve al anterior | **SÍ** |
| **H-04** (A2-1) | B | ALTO | `orders/checkoutConfig.ts:19-48,57-65` · `tenants/provision.ts:132-135` | El bot manda **datos bancarios falsos** (`REEMPLAZAR-Nro-Cuenta`) a clientes reales: un tenant nuevo nace con bot encendido y sin `config/checkout`; borrar las cuentas desde el panel también cae al placeholder | test ✅ | **SÍ** |
| **H-05** (A2-3 + A4-3) | B | ALTO | `orders/confirmPayment.ts:46-51,66-76` · `functions/orders/orderCallables.ts:162,172-178` | `PAID` se escribe antes de writes que pueden fallar, sin compensación; el reintento corta en el short-circuit ⇒ **pago confirmado sin audit ni evento Purchase**, de forma permanente. Hallado por dos auditorías independientes | test ✅ (mock del NOT_FOUND real del SDK) | **SÍ** (auditabilidad del dinero) |
| **H-06** (A4-2 + A2-10) | B | ALTO | `orders/confirmPayment.ts:92-95` · `orderCallables.ts:172-178` · `payments/stripeWebhook.ts:69-71` | El "🎉 ¡Pago confirmado!" se construye y **nadie lo envía**: los dos llamadores descartan `res.message`. El bot ya prometió "te avisamos por acá" (`engine.ts:520`) | grafo de imports + descarte verificado | **SÍ** |
| **H-07** (A1-2) | A | ALTO | `meta/multiNumber.ts:265-290` (delete `:284`) | Borra la entrada del índice **global** de ruteo sin verificar de qué tenant es ⇒ un owner deja **mudo el WhatsApp de otra empresa**. El guard simétrico existe para el alta (`assertPnidLibre`), no para el borrado | vitest 2/2 | No, pero must-fix antes del 2º tenant con WhatsApp |
| **H-08** (A1-3) | A | ALTO | `firestore.rules:208-210` | `write` (create+update+**delete**) de `customers` para MANAGER, sin `hasOnly` ni validación de valores: **borrado físico** de la ficha del cliente y su conversación desde el navegador, sin auditoría; rompe el invariante "jamás un delete físico". El panel no usa esa escritura | rule + grep: cero escrituras directas a `customers` en `apps/web` | No (cierre de una línea) |
| **H-09** (A3-1) | A | ALTO | `ai/gateway.ts:120,129` · `ai/salesAgent.ts:25,120-126` · `entitlements/aiReservation.ts:13,56` | Fan-out de `tool_use` **sin tope** + 5 llamadas con contexto acumulado + `TOKENS_RESULTADO_TOOL=800` contra un techo real de ~5.850 ⇒ un turno rompe `settled+reserved ≤ límite`: reserva 9.582 vs consumo modelado 74k–717k tokens | 48 ejecuciones de tool en un turno, medido | **SÍ** |
| **H-10** (A3-2) | A | ALTO | `conversation/engine.ts:1400-1409,1186-1199` · `ai/prompts.ts:36-45` | **No hay validación de salida**: todos los guards anti-mentira son matchers de ENTRADA; reformulando, la respuesta del modelo sale verbatim al cliente (cobertura, estado, transferencia o precio inventados). El daño se confina a lo que el cliente lee | 5 payloads pasan los 4 guards | **SÍ** |
| **H-11** (A6-1) | A | ALTO | `firestore.indexes.json:336-337` + prod | `metaWebhookInbox` **sin TTL en producción**: 226 docs, **176 ya vencidos**, el más viejo del 2-jul, cada uno con teléfono completo y texto del mensaje. Sus tres colecciones hermanas sí tienen TTL ACTIVE | `ttlConfig=null` leído de prod | No |
| **H-12** (A6-2) | A | ALTO | despliegue prod | `functions:list --json` devuelve los 4 secretos **en claro** ⇒ un rol *viewer* del proyecto lee `TENANT_SECRETS_ENCRYPTION_KEY` (descifra todos los tokens de Meta). El `META_APP_SECRET` bindeado por Secret Manager a 4 funciones viaja igual como var plana en las 118 | medido: 118/118, cero segmentación | No (preexistente, agravado) |
| **H-13** (A2-2) | B | ALTO | `conversation/coverageResume.ts:845-855` | El pedido de cobertura nace **sin `sessionKey`** ⇒ `confirmPayment` cierra el checkout del canal equivocado (ADR-0017 §2 lo daba por cerrado) | test ✅ | Sí con más de un número |
| **H-14** (A5-3) | C | ALTO | `lib/entitlements.ts:494-503` · `components/billing/PlanComparison.tsx:33-38,93-129` | Los 4 CTA de cambio de plan y "Gestionar facturación" son **stubs** sin red; el aviso se pinta fuera de pantalla y expone jerga interna ("Fase 5B") | click → ninguna request | **SÍ** si el panel es cara comercial |
| **H-15** (A5-4) | C | ALTO | `decisions/page.tsx:51,60,70-71` · `agent/page.tsx:31,91` · `ads/page.tsx:18,65-66` | Estados vacíos que **mienten** cuando la lectura falla: "Sin acciones pendientes.", "✓ Sin hallazgos.", o página en blanco — sin rama `isError` | SELLER en /decisions, verificado en vivo | **SÍ** |
| **H-16** (A5-5) | C | ALTO | `app/(panel)/layout.tsx` · `lib/roles.ts:82-86` | Sin guard de ruta por rol: un SELLER navega a /catalog, /agent, /promotions… y ve la UI completa de acción; el backend rechaza con 403. No es agujero de seguridad: es trabajo ofrecido que no se puede hacer | 403 capturados en vivo | Parcial |
| **H-17** (A5-6) | C | ALTO | `lib/registration.ts:21-22` · `.env.production.example:63` vs `.env.vpw-prod-dd6ff:37` | "Probá gratis 7 días" → registro **abierto por default en el front** contra backend cerrado: se crea la cuenta Auth, se verifica el mail, se completa el form y recién al final falla | contraste de envs | **SÍ** si sale el sitio público |
| **H-18** (A5-2) | C | ALTO | `lib/simulator.ts:19,73-83` · `functions/growth/agentTestCaseCallables.ts:49` | "Cargar ejemplos" escribe 6 docs **sin `createdAt`**; la lista usa `orderBy('createdAt')` ⇒ nunca se ven, ni tras recargar, y no se pueden borrar desde el panel | 6× 200 OK + docs presentes + pantalla vacía | No |
| **H-19** (A4-4) | B | MEDIO | `meta/process.ts:283` · `conversation/messages.ts:101,108` · `conversation/deliveryStatus.ts:69-73` | Desenlace `unknown`: burbuja `pending` **sin `waMessageId`** ⇒ ningún recibo puede correlacionarla ⇒ el vendedor ve "🕓 Enviando…" para siempre; el recibo real se descarta como huérfano en log `info` | cadena leída línea por línea | No |
| **H-20** (A4-6) | B | MEDIO | `entitlements/aiReservation.ts:196-210,330-333` | Si `liquidar` falla, el barrido **devuelve** la capacidad sin liquidar el consumo real ⇒ `aiTokensThisMonth` desfasado para siempre; el contador no distingue "murió antes del proveedor" de "el proveedor ya cobró" | lectura de `vencerReserva` | No |
| **H-21** (A4-7) | B | MEDIO | `audit/audit.ts:152-169` · `functions/products/onProductWriteAudit.ts:12-29` | Toda la bitácora es best-effort: pago confirmado, cambio de autoridad de catálogo y **purga irreversible de bytes** pueden ejecutarse sin entrada. `onProductWriteAudit` no declara `retry` | lectura | No |
| **H-22** (A4-8) | B | MEDIO | `conversation/sendAttachment.ts:618-623,187-197` | `updateOperation(done)` fuera de try/catch: el archivo ya llegó al cliente, el vendedor ve error y a los 5 min el mismo `operationId` se **reclama y re-envía** (el cliente lo recibe dos veces) | lectura de `decidirReservaDeOperacion` | No |
| **H-23** (A4-5) | B | MEDIO | `meta/process.ts:998,170` | Eventos que caen a `failed`: **nadie lee ese estado nunca** (cero barridos, cero alertas, cero superficie de panel) | grep exhaustivo | No |
| **H-24** (A2-4) | B | MEDIO | `orders/createPendingOrder.ts:170-182` · `conversation/cart.ts:26-31` | El precio del carrito **nunca se revalida** contra el catálogo al crear el pedido; la sesión no expira de verdad | test ✅ | No |
| **H-25** (A2-5) | B | MEDIO | `functions/orders/orderCallables.ts:219-236` | `adminOrderCorrect` acepta cualquier estado del enum, sin transición válida ni coherencia con `payment.*` | estático | No |
| **H-26** (A2-6) | A | MEDIO (latente) | `functions/payments/stripeWebhook.ts:63-69` · `functions/billing/platformBillingWebhook.ts:30` | Confirma pago **sin validar monto, moneda ni pertenencia**, y comparte el env `STRIPE_WEBHOOK_SECRET` con el webhook de billing | estático | No (secreto no seteado en prod) |
| **H-27** (A2-7) | B | MEDIO (latente) | `payments/idempotency.ts:14-25` · `stripeWebhook.ts:58,72-76` | `claimEventOnce` **antes** de procesar + catch que responde 200 ⇒ at-most-once: un fallo transitorio pierde el evento de pago para siempre | estático | No |
| **H-28** (A2-8) | B | MEDIO | `orders/checkoutReuse.ts:69-93` · `conversation/engine.ts:477,577` | Dos "pagar" concurrentes ⇒ **dos pedidos** (read-then-write sin lock ni transacción) | estático | No |
| **H-29** (A3-3) | A | MEDIO | `entitlements/aiReservation.ts:58,101` · `config/validate.ts:10,56-61` | El techo de reserva (16k) no puede representar el costo real del loop: un system prompt de 312k chars es admitido por el validador ⇒ ≥521k tokens de entrada | medido | Recomendado |
| **H-30** (A3-4) | A | MEDIO | `meta/parseWebhook.ts:408,421,639` vs `attachmentSanitize.ts:46` | Saneo asimétrico: el caption (que nunca va al modelo) se limpia; el texto (que **sí** va) no — NUL, U+200B y U+202E sobreviven; 300k chars sin truncar | test ✅ | No |
| **H-31** (A3-5) | A | MEDIO | `conversation/engine.ts:362-379` · `orders/checkoutConfig.ts:57-65` | Cuenta bancaria, titular y CI/RUC del tenant **entran al prompt** por el historial, contra el contrato "el modelo nunca recibe datos privados" | verificado | No |
| **H-32** (A6-3) | A | MEDIO | `storage.rules:105` | `platform/**` es públicamente **enumerable** sin credenciales, no solo legible | `GET ?prefix=platform/` → 200; control → 403 | No (hoy vacío) |
| **H-33** (A6-4) | A | MEDIO | `firestore.indexes.json:415` | TTL de `metaOAuthStates` declarado en IaC **nunca aplicado**: nonces expirados el 12-ago seguían vivos 8 días después | prod | No (sale con el release) |
| **H-34** (A6-5) | A | MEDIO | `lib/firebase.ts:57-79` · `engine.ts:140` | El teléfono crudo es **segmento de path de Firestore** ⇒ aparece en Data Access logs, backups y exports; ningún enmascarado es posible ahí | 5 docs en prod | No |
| **H-35** (A4-9) | B | MEDIO/BAJO | `conversation/handoff.ts:276-282` · `humanRequest.ts:243,273` | `notifyHandoffRequested` devuelve `false` tanto por "ya existe" como por **fallo real**, y los 4 llamadores lo ignoran ⇒ el cliente oye "te paso con X" y la campana no suena | lectura | No |
| **H-36** (A5-8) | C | MEDIO | `functions/growth/agentTestCaseCallables.ts:83-86` | El simulador dice "no se envía ningún mensaje" pero crea **cliente y conversación permanentes** visibles en Clientes/Bandeja/Dashboard, sin forma de borrarlos desde el panel | verificado en vivo | No |
| **H-37** (A5-9) | C | MEDIO | `app/(panel)/integrations/page.tsx:342,476` | La card en estado error dice "Probá reconectar" y en ese estado **no hay botón Reconectar** | verificado en vivo | No |
| **H-38** (A5-10) | C | MEDIO | `decisions:63` · `followups:69` · `tracking:44` · `replies:52` · `ads:53-54` | Botones de job: `runTenantJob → 200 OK` y la pantalla **no dice nada** | 2× 200 verificados | No |
| **H-39** (A5-11) | C | MEDIO | `app/welcome/page.tsx:60-63` · `onboarding/page.tsx:21-27` | "Aplicar plantilla" sin `isError`: si falla, el botón vuelve a su estado y no pasa nada | happy path OK; rama de fallo sin UI | No |
| **H-40** (A4-10) | B | BAJO | `functions/scheduled/resetUsage.ts:18-20` | Único barrido sin try/catch por tenant: uno que lanza **aborta el reset mensual de los siguientes** (mitigado por el lazy-reset del gate) | contraste con los otros 7 | No |
| **H-41** (A1-4) | A | BAJO | `conversation/coverage.ts:541-542` · `firestore.rules:342-343` | La rule confía en `sellerUid` como server-controlled, pero se deriva de `assignedSellerId`, escribible por el MANAGER (H-08) ⇒ elige a qué SELLER entrega la ubicación del cliente | cadena leída | No |
| **H-42** (A1-5) | A | BAJO | `firestore.rules:293,302,310,334` | `hasOnly` limita campos, nunca **valores**: `status` es texto libre; un SELLER completa tareas de otros | lectura | No |
| **H-43** (A1-6) | A | BAJO | `functions/healthCheck.ts:9-28` | Público sin auth: expone `version`/`env`/`emulator` y hace una lectura a Firestore por request (amplificación de costo, oráculo de liveness) | lectura del handler | No |
| **H-44** (A1-7) | A | BAJO | `functions/orders/orderCallables.ts:62-67` | `loadOrder` no valida la forma de segmento del `orderId` (sí lo hace `attachmentCallables.ts:82`); no cruza tenant | comparación de validadores | No |
| **H-45** (A2-9) | A | BAJO | `orderCallables.ts:50-53` vs `attachmentCallables.ts:56-61` | `PLATFORM_ADMIN` **puede confirmar pagos** de cualquier tenant, mientras se le niega marcar comprobantes y decidir cobertura (incoherencia de criterio) | estático | No |
| **H-46** (A3-7) | A | BAJO | `ai/tools/salesTools.ts:33,45` | `genero` declara `enum` en el schema pero `execute` acepta cualquier string ⇒ falso "no tenemos" | test ✅ | No |
| **H-47** (A3-8) | A | BAJO | `ai/tools/sanitize.ts:118` | `styleTags` es el único campo de la whitelist sin tope de longitud ni de cantidad | inspección | No |
| **H-48** (A3-9) | B | BAJO | `conversation/engine.ts:216` | La marca `'lattafa'` hardcodeada como estilo "árabe" retiene en reglas mensajes que nunca llegan a la IA | 4 de 5 payloads bloqueados por esto | No |
| **H-49** (A6-6) | A | BAJO | `catalogClient.ts:520,537` · `catalogImport.ts:443` | Cursor de Graph persistido con solo chequeo de host, sin guard de query string | contingente a que Meta devuelva `access_token=` | No |
| **H-50** (A6-7) | A | BAJO | `ai/productVisionRuntime.ts:48-52` | `adjunto.storage.path` usado sin `isAttachmentStoragePath` (asimetría con `mediaUrlIssuer.ts:271`) | no explotable hoy | No |
| **H-51** (A6-8) | A | BAJO | `meta/process.ts:998` | `errorMessage: String(e)` — única persistencia de error crudo, a una colección sin TTL | 4 en prod, todos benignos | No |
| **H-52** (A6-9) | A | BAJO | `conversation/manualMessage.ts:41` | `auditLogs`: preview del texto + email del actor + teléfono completo en `targetId` | verificado | No |
| **H-53** (A6-10) | A | BAJO | `10-backend/.gitignore:32-35` | Enumera `.env.vpw-prod-dd6ff` literal, sin glob `.env.vpw-*`: un proyecto nuevo no quedaría ignorado | lectura | No |
| **H-54** (A5-12) | C | BAJO | `lib/roles.ts:39-70` | `TENANT_VIEWER` existe en claims/rules/labels pero ningún módulo lo incluye ⇒ sidebar vacío. `QUICK_LINKS` tampoco incluye MANAGER | código | No |
| **H-55** (A5-13) | C | BAJO | `components/marketing/PricingSection.tsx:44` vs `lib/entitlements.ts:231` | La landing vende "Tracking propio" como diferencial Pro; el producto no lo gatea | verificado con tenant Básico | No |
| **H-56** (A6-11) | A | INFO | `webhookHttp.ts:463-465` | El verify token viaja en query string (protocolo de Meta) y se compara con `===`, no `timingSafeEqual` | impacto real ~nulo | No |

## 2. Los CRÍTICOS y ALTOS, en detalle

### H-01 🚨 — El mensaje del cliente se destruye y a Meta se le dice "lo tengo"

`webhookHttp.ts:575-579` trata igual el fallo de un chunk de historial y el de un mensaje vivo;
`:659` responde `200 {ok:true}` igual, y `:662` responde `200 {ok:false}` ante cualquier
excepción de más arriba (tirando **el lote entero**: Meta batchea varios `changes` por POST).
Un 200 significa "lo tengo" ⇒ **no hay redelivery** ⇒ el inbound no existe en ningún lado.

La justificación escrita en el código (`:648`: "un no-200 haría redelivery de TODO el canal") se
refutó con evidencia: el `docId` es determinístico por wamid, así que el reintento del mismo
POST da `duplicates:1` y cero escrituras nuevas. Y no existen "otras formas de recuperarlo":
nada lee `processingStatus`, no hay barrido sobre `metaWebhookInbox` y su TTL ni siquiera está
aplicado (H-11). Es la puerta de entrada del flujo crítico de fase 1 (anuncio → WhatsApp →
venta) fallando en la única dirección que no deja rastro.

### H-02 🚨 — Un owner secuestra la autorización de cualquier usuario

`inviteUser` resuelve el uid por email (`getUserByEmail`) y hace `setCustomUserClaims` sobre un
usuario **preexistente de otra empresa**, sin llamar a `assertSameTenant` — que además es
fail-open: si `users/{uid}` no existe, deja pasar. El PLATFORM_ADMIN es alcanzable justamente
porque su bootstrap **no crea** ese documento (a propósito). Su uid está a la vista de cualquier
manager en `auditLogs` del propio tenant. No hay App Check: se invoca con un ID token y `curl`.

No hay auto-escalada de rol (`TENANT_ROLES` excluye PLATFORM_ADMIN): es secuestro y destrucción
de la autorización ajena. El patrón correcto ya existe en el repo —
`conversation/lifecycle.ts:183-196` valida el destino contra `users/{uid}` exigiendo tenant, rol
asignable y `status !== 'DISABLED'`, con error uniforme anti-enumeración.

**Atenuante:** exige ser ya owner de un tenant, y hoy los únicos owners son del dueño. Es
exactamente el privilegio que el Tramo 1 entrega al primer cliente.

### H-03 🚨 — Guardado silencioso que se pierde

Ni `/agent` ni las seis mutaciones de `/promotions` tienen `onError` ni renderizan `isError`.
Con >5000 caracteres en "Reglas de venta" (tope real del validador), el backend responde 400 y
la pantalla **no muestra nada**: ni éxito ni error. Al recargar, el texto vuelve al anterior.
Mismo patrón en `/simulator` (6 mutaciones, 0 estados de error), `/tracking`, `/replies`,
`/followups`, `/decisions`, `/welcome`, `/onboarding` y `NotificationBell`.

El contraste está en el mismo repo: `AttachmentCandidateActions`, `MetaReconciliation`,
`ManualActivationPanel` y `CatalogQualityCenter` tienen pending + error + confirmación. Son el
modelo a copiar.

### H-04 — Datos bancarios placeholder hacia clientes reales

`provisionTenantCore` siembra `config/agent` con `botEnabled: true` y **no** siembra
`config/checkout`; `getCheckoutConfig` cae a `DEFAULT_CONFIG` tanto si el doc falta como si
`bankAccounts` queda vacío. El cliente recibe "UENO Bank / Cuenta: REEMPLAZAR-Nro-Cuenta". El
equipo ya cerró esta clase de bug del lado de los vendedores (`humanRequest.ts:198-199`) y dejó
abierto el del dinero. Todo el repo es fail-closed; acá falla **abierto con datos falsos**.

### H-05 / H-06 — El pago confirmado: sin rastro y sin aviso

`confirmPayment` escribe `PAID` y después hace tres pasos no transaccionales; el `.update()` de
la sesión (`:67-76`, el único `update()` pelado sobre sesión en todo el backend) puede lanzar
NOT_FOUND y abortar el evento Purchase y el audit `payment.confirmed`. El reintento del panel
corta en el short-circuit `if (order.status === to) return {ok:true}` **antes** de los efectos
que nunca ocurrieron: la confirmación manual de un pago queda sin rastro de auditoría, y la
atribución de Meta nunca ve la venta. Encima, el mensaje de confirmación que el bot prometió
("te avisamos por acá") se construye y ningún llamador lo envía.

### H-09 / H-10 — Los dos huecos de la frontera de IA

El gateway ejecuta **todos** los bloques `tool_use` de cada ronda sin tope y hace 5 llamadas
reenviando el contexto acumulado, mientras la reserva modela 1 tool/ronda × 800 tokens contra un
techo real de ~5.850 por resultado. Un turno puede consumir el mes de un plan chico. Y no existe
ninguna validación de **salida**: los cuatro guards anti-mentira son matchers del texto de
entrada; reformulando, la respuesta del modelo llega verbatim al cliente. El daño se confina a
lo que el cliente lee (precios, SKUs y carrito se re-derivan server-side), que es exactamente la
clase de incidente que motivó F4, COVERAGE-GUARD-1 y HANDOFF-2.

### H-11 / H-12 — PII retenida y secretos legibles

`metaWebhookInbox` guarda teléfono completo y texto de cada mensaje, y su TTL nunca se aplicó:
176 de 226 documentos ya vencidos siguen vivos. Y los cuatro secretos productivos no solo son
env vars planas (deuda conocida): `functions:list --json` **devuelve sus valores**, así que un
viewer del proyecto obtiene la clave que descifra todos los tokens de Meta — lo que anula el
least-privilege que sí se implementó para `META_APP_SECRET`.

## 3. Ranking de fixes propuestos (no implementados)

Orden sugerido por (daño × probabilidad) / esfuerzo. **EN REPO** = se arregla y prueba sin
tocar producción; el deploy de todos ellos entra en el Tramo 1 (hoy bloqueado por App Review).

| # | Hallazgos | Fix propuesto | Esfuerzo | Riesgo del fix | Naturaleza |
|---|---|---|---|---|---|
| 1 | H-01 | Responder 503 cuando falla la escritura de un mensaje vivo (la redelivery ya es idempotente); contadores de pérdida en el resumen; log con tenant + pnid + wamid | S | Bajo (idempotencia ya probada) | EN REPO |
| 2 | H-02 | `inviteUser` valida el destino como `conversation/lifecycle.ts:183-196`; `assertSameTenant` fail-closed; mismo tratamiento en `setUserRole`/`setUserActive` | S | Bajo | EN REPO |
| 3 | H-03 + H-15 + H-38 + H-39 | Estado de error/éxito en todas las mutaciones y rama `isError` en las lecturas (patrón ya existente en el repo) | M | Bajo | EN REPO |
| 4 | H-04 | Gate server-side: sin `config/checkout` real, el checkout no ofrece transferencia (fail-closed, como el de vendedores) | S | Medio (toca el camino de venta) | EN REPO |
| 5 | H-05 + H-06 | Transacción/compensación en `confirmPayment`, audit antes del short-circuit, y enviar el mensaje al cliente | M | Medio (dinero) | EN REPO |
| 6 | H-08 | `customers` → `write: if false` en Rules (el panel no la usa) | XS | Muy bajo | EN REPO (deploy de Rules) |
| 7 | H-07 | Verificar `tenantId` de la entrada del índice antes del delete | S | Bajo | EN REPO |
| 8 | H-09 + H-29 | Tope de `tool_use` por ronda, `TOKENS_RESULTADO_TOOL` realista y tope de tamaño del system prompt | M | Medio (afecta la venta) | EN REPO |
| 9 | H-11 + H-33 | Aplicar los TTL faltantes (`metaWebhookInbox` por consola/IaC; `metaOAuthStates` ya sale con el release) | XS | Muy bajo | Producción (consola) |
| 10 | H-12 | Migrar los 4 secretos a Secret Manager con binding por función + rotación | L | Alto (toca todo el runtime) | Deploy |
| 11 | H-10 | Validación de salida del modelo (lista de afirmaciones prohibidas / verificación contra estado real) | L | Medio | EN REPO |
| 12 | H-13, H-19, H-22, H-24, H-28, H-35 | Correctivos puntuales de acción (canal del pedido, `unknown` reconciliado, idempotencia del adjunto, revalidación de precio, lock de checkout, notificación honesta) | M c/u | Bajo-medio | EN REPO |
| 13 | H-14 + H-17 + H-16 | Decisión de producto (¿el panel es cara comercial?) + guard de ruta por rol + coherencia del registro | M | Bajo | EN REPO |
| 14 | Resto (BAJOS/INFO) | Lote de higiene | S c/u | Muy bajo | EN REPO |

## 4. Qué NO se auditó (límites honestos de esta pasada)

- **Rules ejecutadas**: se auditaron como texto y contra sus consumidores server-side, sin correr
  `@firebase/rules-unit-testing` (el emulador estaba reservado para la auditoría de UI). H-08,
  H-41 y H-42 son los candidatos naturales a tests permanentes.
- **Comportamiento del modelo real**: no se hicieron llamadas a la API de Anthropic. H-09 prueba
  que el código no tiene tope y que la reserva subestima, no cuántas tools pide Haiku; H-10
  prueba que el control arquitectónico no existe, no que el modelo obedezca cada payload.
- **Producción solo se leyó.** Ninguna reproducción se ejecutó contra prod; todo lo mutante fue
  emulador o tests con dobles.
- **Fuera de alcance por contrato**: `credipower`, `meta-review` (App Review en curso), el feed
  de arfagi, `_archive/`, `80-creditos.future/`.
- **No auditado por foco**: rendimiento y costos de Firestore (más allá de la amplificación de
  H-09), accesibilidad del panel (cubierta en programas previos), calidad del prompt de ventas,
  dependencias de terceros (`npm audit`), y la superficie de Coexistence en profundidad (su
  programa está detenido fail-closed).
- **Los 4 programas EN REPO sin desplegar** se auditaron como código presente en `main`; sus
  defectos ya fueron cubiertos por sus propias reviews adversariales.
