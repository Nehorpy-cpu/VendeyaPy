# ADR-0017 — Coexistence: incorporar el número real sin apagar lo que ya vende

- **Estado**: aceptado (fundación en implementación; el onboarding del número real es un acto humano posterior).
  **Migración dual de `automationMode` EJECUTADA el 2026-08-15** (`WHATSAPP-AUTOMATIONMODE-DUAL-MIGRATION-AND-VISION-RECANARY-1`):
  los DOS números que rutean inbound (arfagi `…7904` y meta-review `…5686`) quedaron en `live` crudo en el ASSET
  vía `migrarModoAutomatizacion` (dry-run→apply, `written` ambos, índice `no_declara` sin tocar, conexiones intactas).
  El rollback documentado (`--mode inactive --apply`) es funcionalmente equivalente al estado inicial fail-closed
  pero NO byte-idéntico (el campo estaba AUSENTE al inicio). Precondición de la Fase 2 del release de IA: CUMPLIDA.
- **Fecha**: 2026-08-03
- **Contexto previo**: ADR-0003 (WhatsApp Cloud API), ADR-0009 (integración Meta), ADR-0010 (go-live), ADR-0016 (adjuntos)
- **Programa**: `EMERGENCY-WHATSAPP-COEXISTENCE-SAFE-CUTOVER-1`, precedido por la auditoría read-only `…-CUTOVER-AUDIT-1`

## El problema

La perfumería atiende a sus clientes desde un número real, en la app WhatsApp Business, con conversaciones y
ventas en curso. Ese número tiene que entrar a VendeYaPy **sin apagar nada**: ni la app del vendedor, ni el
número que hoy ya está conectado, ni los pedidos, pagos, catálogo, Coverage o adjuntos.

La auditoría previa devolvió **BLOQUEADO** y encontró la razón de fondo: el sistema fue construido para **un**
número por tenant. No es que le falten features de Coexistence — es que **no tiene el concepto de "este número
todavía no manda"**. Todo lo que existe hoy es binario y por tenant: un número está conectado o no lo está, y
si lo está, el bot contesta.

## Las decisiones

> §1–§4 son la decisión original. §5 y §6 se agregaron el **2026-08-04** al contrastar el diseño contra el
> contrato oficial vigente de Meta: corrigen supuestos del §4 que el contrato desmiente.

### 1. La salud de la conexión y el permiso para automatizar son cosas distintas

Hoy `status: 'active'` significa dos cosas a la vez: «la credencial sirve» y «el bot puede contestar». Esa
confusión es la que hace peligroso dar de alta un número: `multiNumber.ts` lo escribe `active` y desde ese
instante `process.ts` lo rutea al motor.

Se separan en dos ejes ortogonales:

- **`status`** — sigue significando lo de siempre: la conexión es válida. **No autoriza nada.**
- **`automationMode: 'inactive' | 'shadow' | 'live'`** — qué se le permite hacer al sistema con ese número.

| modo | qué pasa con un inbound |
|---|---|
| `inactive` | ACK seguro y nada más: sin motor, IA, reglas, carrito, pedido, Coverage, metering ni outbound |
| `shadow` | se registra en una **superficie de observación propia** (`metaWebhookShadow`, cerrada y con TTL) para poder mirarlo, y nada más: cero respuesta automática, cero efecto comercial y **cero escritura en la conversación del cliente** |
| `live` | automatización normal, siempre que no haya takeover de esa conversación en ese número |

**`shadow` NO escribe en `messages`**, y es el mismo razonamiento del §4 sobre el historial —«escribir en
`messages` mezclaría el historial importado con el del número que ya vende»— aplicado a un mensaje que
llega EN VIVO. `messages` y el resumen del cliente son **por cliente, no por canal** (§2), así que escribir
ahí tenía tres efectos sobre el número que está vendiendo AHORA, los tres confirmados:

1. dejaba `conversation.receivedVia` con el PNID en observación, y el mensaje MANUAL del panel lee ese campo
   para elegir por qué número sale: el vendedor escribía creyendo que contestaba por el número de siempre y
   salía por el que debe estar callado, a un cliente vivo;
2. `listRecentMessages` arma el prompt del modelo sin filtrar por canal, así que lo del número en observación
   entraba al contexto de la IA del número que sí vende;
3. publicaba la conversación en la bandeja del panel, y tomarla ahí silencia al bot en el número que vende.

La observación va a una colección propia por las mismas dos razones del historial: `metaWebhookInbox` **es**
el disparador del motor (`onWebhookInbox` dispara sobre todo documento) y además la lee `isPlatformAdmin()`.
Es `read, write: if false` y su TTL es el mismo del evento que la origina — es una vista legible de algo que
la bandeja ya retiene, no un archivo nuevo.

**Cuándo se promueve a la conversación**: nunca desde `shadow`. El material que el vendedor necesita ver de
verdad entra el día que el número pasa a `live`, que es una decisión humana (ver más abajo).

**Fail-closed, con el mismo criterio que ADR-0016 §10**: un PNID nuevo, o sin el campo, o con un valor que no
sea exactamente uno de los tres, es `inactive`. Ante inconsistencia entre asset, índice y conexión gana **el
estado más restrictivo**. Un lector puro y compartido decide — no se reimplementa en cada borde, porque dos
lecturas del mismo flag terminan divergiendo y la laxa es la que enciende.

**Pero «no pude averiguarlo» no es «no tiene permiso».** Si la lectura del permiso misma falla, el ENVÍO
falla cerrado igual (no se automatiza nada en ese turno) pero el **evento no es terminal**: vuelve a la cola
(`processingStatus: 'received'`, que es lo que el guard de la bandeja ya reconoce como tomable) y se loguea
como **error**. Cerrarlo como `ignored` tiraba para siempre el mensaje de un cliente de un número `live` por
un hipo de Firestore, en silencio. Las otras razones de `inactive` —sin PNID, sin declarar, declarado
inactivo— sí son terminales: ahí el sistema sabe la respuesta.

**El gate se aplica antes que cualquier consumidor de negocio.** En `meta/process.ts`, entre derivar el
`customerId` y el gate de empresa: por encima quedan solo la resolución del tenant y la identidad; por debajo
queda todo lo que cuesta plata o muta algo — metering, ingesta de adjuntos, motor, Coverage.

### 2. El cliente es uno; la conversación es por canal

Fragmentar el `Customer` por número sería un error: es la misma persona, con los mismos pedidos y el mismo
historial de compras. El `Customer` sigue siendo único por `(tenantId, wa_id)`.

Lo que **sí** se separa por número receptor, porque son estado de una conversación y no del cliente:

| compartido (por cliente) | por canal (`sessionKey` derivada del PNID) |
|---|---|
| identidad, pedidos, pagos, adjuntos, financieros | sesión conversacional y estado del motor |
| historial de compras | `humanTakeover` y quién atiende |
| | `pendingCartConfirmation`, `pendingOrderId`, puntero de Coverage |
| | destino del outbound (`receivedVia`) |

Sin esto, un cliente que le escribe a los dos números comparte carrito y takeover entre ambos: el bot podría
tomar el pedido empezado en un número y contestarlo por el otro.

**Compatibilidad**: las conversaciones que ya existen viven en `sessions/active`. Esa clave se conserva como
la del canal legacy; no se migra nada.

**Corrección del correctivo (2026-08-04): el canal es por PLATAFORMA, no solo por PNID.** Instagram y
Messenger compartían el canal mutable `active` entre sí y con WhatsApp legacy (`CANAL_SIN_GATE` congelaba
`sessionKey: 'active'`): un cliente escribiendo por Instagram compartía carrito y takeover con el número de
WhatsApp que vende. Ahora cada plataforma sin PNID tiene clave propia (`ig` / `msgr`, de
`sessionKeyDePlataforma` en `@vpw/shared`; una plataforma desconocida deriva `ch_<saneado>`, jamás `active`
ni `wa_*`), y el panel resuelve el canal mirando **primero la plataforma** (`conversation.channel`) y recién
después el número receptor. Dato usado y verificado: producción tiene una sola entrada de ruteo (whatsapp),
así que no existían sesiones IG/Messenger reales que abandonar.

**La condición de las Consecuencias («migrar los ~25 lugares es condición para `live`») quedó CUMPLIDA** y
la garantía es estructural: `paths.session` exige la clave (la vigila el compilador) y el aislamiento de dos
PNID con el mismo cliente está demostrado en ejecución por `verify-coexistence-dual.mjs`, que promueve a
`live` con la herramienta real. El gate transicional `SESIONES_POR_CANAL_MIGRADAS` fue retirado por eso —
no por decreto.

### 3. Un echo es lo que el vendedor dijo, no lo que el cliente pidió

`smb_message_echoes` es el evento que hace posible Coexistence: avisa que el vendedor contestó desde su
teléfono. Sin consumirlo, el sistema no se entera y el bot le habla encima al vendedor delante del cliente.

Dos hechos de la [referencia oficial](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes)
(consultada 2026-08-03) gobiernan el diseño:

- el array es `value.message_echoes`, **no** `value.messages`;
- cada item trae **`from` Y `to`**, y **`from` es el número del NEGOCIO**; `to` es el del cliente.

De ahí la regla dura: **el `from` de un echo no se transporta jamás en la forma normalizada de un inbound.**
Si se hiciera, `customerId` sería el wa_id de la propia perfumería, el sistema abriría una conversación
consigo mismo y el bot se respondería a sí mismo, sobre el número real y consumiendo cuota. El cliente se
resuelve por `to`; el canal, por `metadata.phone_number_id`.

Un echo se persiste como **outbound humano** con origen `whatsapp_business_app`, es idempotente por su wamid,
**nunca se reenvía** por Cloud API, y **activa o extiende el control humano** de esa conversación en ese
número — reusando la semántica canónica de silencio de HANDOFF-2, sin inventar una segunda.

El **gate por PNID le aplica igual que a un inbound**, con un matiz por modo:

- `inactive` — el echo no toca nada. Un número sin permiso no puede mover la conversación de nadie.
- `shadow` — el echo **se observa** (ver el trabajo del vendedor es exactamente el punto del modo) pero **no
  toca la conversación ni el control humano**: en `shadow` el gate ya deja al bot mudo para ese número, así
  que un takeover no agregaría ni un gramo de silencio y sí escribiría estado de alcance ajeno —el resumen
  del cliente no está particionado por canal—.
- `live` — el camino completo: silencio primero (`executeHandoff` sobre la sesión de ESE canal, creándola si
  no existe: sin sesión el handoff sería un no-op y el bot seguiría hablando encima), burbuja después.

Y un echo **jamás** dispara metering, motor, IA, adjuntos, Coverage ni outbound.

**Corrección del contrato oficial (2026-08-04)**: un echo activa el control humano pero **no abre ni
extiende la ventana de servicio de Cloud API**. Meta lo dice sin ambigüedad: los mensajes mandados desde la
app «no están sujetos a la ventana de atención al cliente y no crean, extienden ni afectan las ventanas de
conversación ni la facturación de Cloud API». Consecuencia práctica que hay que respetar en `live`: que el
vendedor haya contestado desde su teléfono **no habilita** al bot a mandar texto libre después. Si la ventana
está cerrada —caso típico: el cliente escribió justo *antes* del onboarding—, la única salida por Cloud API
es una plantilla. Tratar el echo como si abriera la ventana produciría envíos rechazados por Meta que el
sistema leería como fallas propias.

Y una consecuencia que había que arreglar antes — **CERRADA en `4af6607`**: `releaseToBot` escribía
`state: 'IDLE'` incondicionalmente y destruía el `AWAITING_PAYMENT` del checkout. Hoy la liberación preserva
`AWAITING_PAYMENT`/`SELECTING_PAYMENT` (`conversation/handoff.release.test.ts`): tomar y liberar puede ser el
ritmo normal del vendedor sin romper el pago en curso.

### 4. El historial es un archivo, no una bandeja de entrada

`history` trae hasta 180 días de conversaciones. Se persiste **en una superficie propia**, nunca mezclado con
los mensajes vivos, y marcado `historical: true`, `automationEligible: false`, `unread: false`.

Tres razones por las que no puede ir a `messages`:

1. `listRecentMessages` alimenta el prompt de la IA: el historial entraría al contexto del modelo.
2. Los contadores de no-leídos y las campanas se dispararían por conversaciones de hace meses.
3. **Escribir en `messages` mezclaría el historial importado con el del número que ya vende.**

Y una razón de aislamiento que decide el destino: `metaWebhookInbox` es legible por `isPlatformAdmin()`.
Mandar ahí 180 días de chats privados del tenant convertiría esa regla en acceso de plataforma al historial
completo de sus clientes. El historial va a una colección **cerrada al cliente** (`read: if false`), con TTL
corto, y su payload se anula al cerrar el evento — el mismo patrón que ya se usa con la ubicación exacta.

Además, `onWebhookInbox` dispara sobre **todo** documento de `metaWebhookInbox`: esa colección **es** el
disparador del motor. Por eso `history` y `smb_app_state_sync` ni siquiera pasan por ahí. La defensa es doble
a propósito — un gate por tipo de evento *y* un destino separado —, porque un `if` se puede borrar en un
refactor y una colección distinta no.

**La decisión de compartir o no el historial es humana**, en el onboarding. Meta da **24 horas** para
sincronizarlo; pasado ese plazo hay que desconectar el número y rehacer todo el flujo. Por eso: **si el
ingestor no está probado el día del cutover, se elige "no compartir historial"**. Es la única opción que no
apuesta la ventana de 24 h sobre un número con clientes vivos.

`smb_app_state_sync` trae la agenda del vendedor — incluidas personas que nunca le escribieron. **No crea
`Customer`s**: sería fabricar clientes sin relación comercial y llenar el panel de conversaciones falsas.

### 5. El historial no llega solo: hay que pedirlo, y se pide una sola vez

Corrección al §4, del contrato oficial consultado el **2026-08-04**. El §4 daba por sentado que los webhooks
de `history` y `smb_app_state_sync` llegarían por el hecho de estar suscritos. **No es así.** Hay que
dispararlos explícitamente con `POST /<PHONE_NUMBER_ID>/smb_app_data`, primero con
`sync_type: "smb_app_state_sync"` y después con `sync_type: "history"`.

Y la cita que gobierna todo el diseño del coordinador: **«Esto se puede hacer una sola vez. Si hace falta
repetirlo, el cliente tiene que offboardear primero y volver a completar el Embedded Signup.»**

**Generaciones (correctivo 2026-08-04).** La única recuperación real que este contrato admite —offboardear y
rehacer el Embedded Signup— necesitaba existir en el código, no solo en el texto de los rechazos: la decisión
y el disparo eran terminales PARA SIEMPRE, y una reconexión legítima quedaba bloqueada por la generación
anterior. El ciclo ahora es explícito: un `ACCOUNT_OFFBOARDED` **cierra la generación vigente de forma
honesta** (`failed` con el motivo; una terminal queda intacta; el consentimiento no se toca), y **solo un
onboarding autorizado** —el claim transaccional de un `code` nuevo, que por construcción existe a lo sumo una
vez por signup real— **abre la siguiente**: sin decisión heredada, contadores a cero, ventana de 24 h nueva.
La generación anterior se archiva íntegra en `{pnid}_gen{N}` (auditoría: jamás se borra ni se reescribe), un
replay del mismo claim devuelve lo mismo sin abrir nada, y un claim de una generación ya archivada no puede
resetear la vigente. Decidir no fabrica generaciones: la generación la mueve exclusivamente el onboarding.

De ahí tres consecuencias que no son opcionales:

- **No hay reintento.** Un disparo perdido no se recupera con un botón: se recupera desconectando el número
  real del negocio y rehaciendo el flujo entero, sobre un número con clientes vivos. Por eso el coordinador
  es durable y persistido (`requested | receiving | completed | declined | expired | failed`), no una
  variable en memoria de una invocación.
- **La ventana de 24 h corre desde el onboarding**, no desde el disparo. Un coordinador que no persista el
  deadline no puede distinguir «sigue llegando» de «se venció».
- **«No compartió» es un desenlace explícito, no un silencio.** Llega como `history[0].errors[0].code =
  2593109`. Sin leer `chunk.errors` el sistema se queda esperando y quema la ventana.

Dos agujeros del parser que este contrato exponía, ambos **CERRADOS por el programa de cierre** (los cubre
`parseWebhook.coexistenciaContrato.test.ts`):

1. `waHistoryChange` leía únicamente `value.history[]` y descartaba el webhook con los **IDs de los adjuntos
   del historial** (llega con `field: "history"` pero `value.messages[]`; esos IDs solo viven 14 días). Hoy
   se parsean como `historyMedia` y el coordinador los cuenta.
2. El payload del caso «no compartió» **no trae el envelope `object`/`entry`/`changes`**; el parser lo acepta
   sin envelope y el código `2593109` llega al coordinador como el desenlace `declined` que es.

### 6. Meta desconecta el número solo, y hay que enterarse

El repo no tiene hoy ninguna referencia a `account_update`, `PARTNER_REMOVED`, `ACCOUNT_OFFBOARDED` ni
`ACCOUNT_RECONNECTED`. Meta desconecta un número en coexistencia por inactividad del dispositivo primario
(~14 días), del companion (~30 días), por cambio de número, re-registro, reinstalación o downgrade de la app
— y lo avisa por `account_update`.

Sin consumir ese evento, un número en `live` seguiría intentando automatizar contra una conexión muerta:
cada inbound gastaría trabajo y cada respuesta fallaría, sin que nada explique por qué. **Un
`ACCOUNT_OFFBOARDED` tiene que degradar ese PNID a `inactive`** — que es exactamente para lo que existe el
eje de la decisión 1.

Y la Deregister API está **prohibida** para números en coexistencia: desconectar es un acto del cliente
desde su app, nunca nuestro.

Nota operativa relacionada: el error **131060** en el webhook de mensajes no soportados es **esperado** tras
el onboarding (primer mensaje de un usuario, o un companion no soportado). Tratarlo como falla llenaría la
auditoría de ruido y escondería las fallas reales.

## Lo que este ADR NO decide, y por qué

- **El onboarding es un acto humano.** El owner completa el flujo y el QR/OTP desde su teléfono. Nadie más lo
  ve ni lo pide.
- **`live` no se alcanza por deploy.** El número nace `inactive`, pasa a `shadow` por decisión explícita, y a
  `live` solo tras un smoke humano y una aprobación aparte.

## Consecuencias

- Aparece un eje de estado nuevo que hay que mantener coherente en tres lugares (asset, índice, conexión), con
  la regla del más restrictivo como desempate.
- La sesión deja de ser una sola por cliente. Hay ~25 lugares que hoy asumen `sessions/active`; **migrarlos es
  condición para pasar a `live`**, no para desplegar la fundación: mientras el número esté en `inactive` o
  `shadow`, el gate impide que esos caminos se ejerciten.
- `writeDiscoveredAssets` borra los assets y el índice del tenant. Con este ADR eso deja de ser solo «se
  pierde el ruteo local»: el número que vende perdería su `automationMode` y quedaría mudo. **Preservar esos
  campos es requisito de despliegue.**
- **Coexistence tiene superficie propia de punta a punta, y la estándar la rechaza.** El onboarding
  del número real no es un `mode` de `connectMeta`: ese callable corre `runMetaConnect`, que guarda
  el token en el secreto del TENANT —pisando el de `main`— y reescribe los assets con
  `connectionId: 'main'`, cuya limpieza borra el asset del número que vende y su entrada de índice.
  El panel llama a `coexistenceStart`/`coexistenceConnect`, y `connectMeta`/`startMetaConnect`
  rechazan `mode: 'coexistence'` antes de consumir el nonce. Aceptarlo no agregaba capacidad alguna
  y dejaba alcanzable el desenlace (a) que este ADR existe para impedir.
- **La recuperación tiene que deshacer todo lo que escribió la degradación.** `account_update` (§6)
  degrada en el asset **y** en el índice; como el desempate es por el más restrictivo, una migración
  que solo tocara el asset dejaba el número mudo tras una reconexión, reportando éxito. La migración
  corrige el índice **cuando el índice declara** algo distinto (la ausencia sigue sin votar, así que
  el camino normal sigue siendo de un solo documento), y la auditoría de release bloquea si el
  índice declara algo que no es `live`. Apagar (`--mode inactive`) no lee el índice: el `inactive`
  del asset ya gana, y el rollback no puede fallar por un documento que no manda.
- El orden importa: **la migración del PNID actual a `live` corre ANTES de desplegar el gate.** Al revés, el
  número que vende leería el campo ausente, resolvería `inactive` y se quedaría callado hasta que alguien
  corriera la migración. El código desplegado hoy ignora el campo, así que hacerlo en ese orden no tiene
  ventana de interrupción.
- El vendedor pierde en su app las **listas de difusión** (quedan de solo lectura), los **mensajes temporales**,
  **"ver una vez"** y la **ubicación en vivo**. **Conserva** catálogo, pedidos, Status, perfil, etiquetas,
  grupos y llamadas: siguen funcionando en la app, solo que no son visibles vía Cloud API. Los dispositivos
  vinculados se desvinculan durante el onboarding y se vuelven a vincular después.
- Throughput fijo de 20 mensajes/segundo mientras el número esté en coexistencia.
