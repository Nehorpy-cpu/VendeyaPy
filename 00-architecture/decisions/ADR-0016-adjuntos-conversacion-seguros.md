# ADR-0016 — Adjuntos de conversación seguros y clasificación separada del pago

- **Estado:** aceptado (EN REPO — NO DESPLEGADO)
- **Fecha:** 2026-07-31
- **Programa:** WHATSAPP-MEDIA-SAFE-FOUNDATION-1
- **Relacionados:** ADR-0003 (WhatsApp Cloud API), ADR-0005 (roles del panel), ADR-0008 (separación de datos financieros)

## Contexto

La auditoría WHATSAPP-MEDIA-1A-AUDIT-DESIGN-1 (2026-07-31) probó que el manejo de medios no era
genérico sino un caso especial construido para un único propósito, con tres defectos críticos:

1. **Toda imagen entrante se trataba como comprobante de pago.** `esImagen` era el único criterio y
   el mensaje nunca llegaba al bot: si el cliente tenía un pedido pendiente, la foto de un producto
   —o cualquier foto— lo pasaba a verificación, disparaba handoff y sacaba al bot del chat.
2. **Una imagen sin pedido pendiente nunca se descargaba.** Se respondía un texto y el binario se
   perdía para siempre: no había dónde guardarlo, porque la única ruta de Storage exigía un
   `orderId`.
3. **Los documentos PDF se descartaban en silencio**, sin persistir, sin responder y sin rastro. Las
   aplicaciones bancarias mandan los comprobantes como PDF: el cliente creía haber avisado y el
   vendedor no veía nada.

Además: el modelo `Message` no tenía campo de adjunto (la única evidencia era el texto libre
`📷 Imagen recibida`, falsificable escribiéndolo a mano), el MIME declarado por Graph se creía sin
verificar, el `pendingOrderId` de la sesión no se validaba contra el cliente que enviaba, una segunda
imagen quedaba huérfana, y no existía retención ni borrado de archivos de clientes.

## Decisión

### 1. El adjunto genérico existe ANTES que cualquier clasificación

Todo archivo admitido se persiste primero como **adjunto**, con identidad propia y ciclo de vida
propio, sin ninguna interpretación de negocio. Recién después —y solo si se cumplen condiciones
determinísticas— se le asigna un significado. La clasificación es un dato *sobre* el adjunto, nunca
un reemplazo del adjunto ni una condición para guardarlo.

Colección: `tenants/{tenantId}/attachments/{attachmentId}`, en la raíz del tenant y no como
subcolección del mensaje, para permitir consulta tenant-scoped (panel, purga, auditoría) sin
`collectionGroup`, admitir N adjuntos por mensaje y por pedido, y separar el ciclo de vida MUTABLE
del adjunto del historial de chat, que se lee como inmutable.

El `Message` recibe únicamente punteros: `attachmentIds: string[]` y `hasAttachments: boolean`. El
panel **jamás** infiere un adjunto desde el texto del mensaje.

### 2. La ingesta nunca cambia por sí sola el estado de un pedido

Recibir un archivo no puede marcar `PAID`, no puede confirmar un pago y no puede convertir el
archivo en comprobante oficial. La ingesta es un hecho técnico; el pago es una decisión humana.

### 3. Candidato ≠ comprobante confirmado

Se separan **dos ejes ortogonales**, y esa separación es el corazón de este ADR:

- **Ingesta:** `received → downloading → verifying → stored`, con `rejected` y `download_failed`
  como terminales. Un rechazo **nunca** bloquea la conversación: se responde al cliente y queda
  rastro visible en el chat.
- **Clasificación:** `unclassified → generic_media | payment_receipt_candidate →
  payment_receipt_linked`, más `rejected`. Lleva `confidence` y `source` (`rule` | `human`), y su
  historial no se borra.

`payment_receipt_candidate` es una **sugerencia visible** desde el pedido y desde la conversación.
No es un comprobante. El pedido **permanece en su estado de espera de pago** hasta que una persona
autorizada actúe.

### 4. El gate del candidato es determinístico y conjunto

Un adjunto solo puede proponerse como candidato si se cumplen **todas**: contexto explícito de
espera de comprobante en la sesión (declarado, no inferido del contenido) · existe exactamente un
pedido admisible **del mismo `customerId`** · el estado del pedido lo admite y no está `PAID` ·
el mensaje llega dentro de una ventana temporal configurable por tenant · el archivo está `stored` ·
el MIME verificado y el tamaño están permitidos · **cero ambigüedad** entre pedidos · idempotencia
por `(tenantId, attachmentId)` y por `(orderId, attachmentId)`.

Si alguna falla, el adjunto queda `generic_media`. **Una imagen fuera del contexto explícito de pago
queda como medio normal aunque visualmente parezca un comprobante**: el sistema no adivina.

El vínculo candidato es transaccional y multi-adjunto: un segundo envío **acumula**, no reemplaza.

### 5. El pago siempre es humano

`TENANT_OWNER`, `TENANT_MANAGER` y `SELLER` pueden marcar un candidato como comprobante. Esa acción,
transaccional, valida tenant, valida el `customerId` del pedido, valida estado admisible, comprueba
que no está `PAID`, vincula el adjunto, pasa el pedido a `PENDING_VERIFICATION`, registra auditoría
—y **no confirma el pago**. La confirmación sigue siendo el callable existente de ORDER-1.

Desmarcar exige que el pedido no esté `PAID`. Preserva el adjunto como medio normal y deja
auditoría. Lo que se protege es el ESTADO, no la clasificación: el pedido vuelve a
`PENDING_PAYMENT` únicamente cuando ese desmarcado vacía la lista de comprobantes vinculados que
lo sostiene. Si el `PENDING_VERIFICATION` lo produjo otra cosa —flujo legacy, corrección manual—
el desmarcado igual procede y el pedido queda donde está: revocar una decisión humana siempre
tiene que ser posible, porque si no la evidencia queda marcada para siempre. Solo se rechaza
cuando hay OTRO adjunto declarado como origen del estado vigente.

Proponer un candidato genera además una **señal operativa idempotente** en la campana del panel:
el mensaje al cliente compromete a una persona («un vendedor lo revisa»), así que esa promesa
tiene que existir del otro lado. La señal no mueve el pedido, no confirma nada y no hace handoff.

### 6. Almacenamiento privado, sin PII en el path

Ruta: `tenants/{tenantId}/attachments/{partition}/{attachmentId}`. El `tenantId` es siempre el
primer segmento y el `attachmentId` es **opaco**: nunca el mediaId crudo, nunca el teléfono, nunca
el nombre original del archivo. El cliente no lee ni escribe Storage directamente: los bytes salen
únicamente por un callable autorizado que firma una URL de vida corta, **nunca persistida**.

La identidad del adjunto es determinística sobre `(tenant, canal, providerMessageId, providerMediaId)`
y se escribe con `create()`: un reintento del webhook falla en vez de duplicar.

### 7. Compatibilidad aditiva con los comprobantes históricos

Los mensajes existentes quedan sin `attachmentIds` y siguen renderizando. Los comprobantes ya
guardados conservan su ruta `tenants/{t}/orders/{orderId}/comprobantes/…` y **siguen abriendo con el
visor**: el emisor de URLs acepta las dos familias de path con whitelist estricta. No se reescribe
historia, no hay backfill destructivo y no se borra ninguna evidencia de pago.

### 8. Multi-tenant y multi-vertical

Nada del contrato menciona un vertical. Los formatos admitidos, la ventana temporal del gate y la
retención son configuración por tenant, no ramas en el código.

Esa configuración vive en UN solo lugar por decisión: los formatos y el tope de bytes los declara
la ingesta (`config/attachments.ingest`) y el gate no tiene su propia versión de esa verdad — su
config aporta la ventana temporal y, si quiere, restricciones ADICIONALES, que se aplican por
intersección. El gate nunca puede ser más permisivo que lo que la ingesta llega a guardar.

### 9. Visión diferida

Este ADR **no** habilita reconocimiento visual de productos, OCR ni ninguna llamada a un modelo con
el archivo o su caption. El caption se sanea y se persiste, pero no se envía a la IA. El motivo es
de secuencia, no de capacidad: la base segura debe existir antes, y el costo por imagen (~1,3–1,6k
tokens, comparable a un turno de texto completo) exige cerrar antes las alertas de cupo.

### 10. Rollout en DOS niveles, ambos fail-closed y por tenant

Desplegar esta fundación cambia de golpe lo que pasa cuando un cliente manda una foto. Para poder
soltarla sin apostar todo a la vez, el encendido es **gradual y por tenant**, con dos interruptores
independientes que se leen de la config del tenant y **fallan cerrados**.

**Nivel A — `config/attachments.ingest.enabled`: ¿guardamos archivos?**

Solo el booleano exacto `true` habilita descargar y guardar. **Ausente, `false`, la cadena `"true"`,
el número `1` o cualquier otra forma significan OFF**: la coerción laxa es justamente cómo un flag
de seguridad termina encendido sin que nadie lo decida.

Con el nivel A en OFF: cero llamadas a Graph, cero escritura en Storage, cero documento de adjunto.
Pero el inbound **no desaparece** — queda un mensaje neutral estructurado en la conversación y una
respuesta honesta al cliente, sin caption a la IA, sin tocar pedidos, sin handoff y sin ninguna
mutación comercial. **No se restaura el camino legacy** de "toda imagen es un comprobante": ese
camino se eliminó porque era el defecto, y apagar el nivel A no lo revive.

**Nivel B — `config/receiptGate.enabled`: ¿proponemos comprobantes?**

Solo `true` habilita clasificar `payment_receipt_candidate`, emitir su señal operativa y crear
vínculos manuales nuevos. Ausente u OFF: un adjunto que se guardó queda `generic_media`, y
`attachmentMarkAsReceipt` **rechaza**.

Apagar el nivel B **no puede ocultar ni borrar nada** que ya exista: los archivos guardados siguen
visibles, los comprobantes ya vinculados siguen vinculados y la evidencia legacy sigue abriendo. Y
`attachmentUnmarkReceipt` **sigue disponible con el flag en OFF**: apagar una función no puede
dejar atrapada una decisión humana que alguien necesita revertir.

La purga conserva su propio flag independiente (`purgeEnabled`, OFF por defecto): borrar bytes es
una decisión distinta de guardar o de clasificar, y no se acopla a ninguna de las dos.

**El flag se relee DENTRO de la transacción** que crea el candidato o marca el comprobante. Una
lectura vieja no puede ganarle a un apagado ya commiteado: si alguien apaga el gate a mitad de una
corrida, lo que todavía no se escribió no se escribe.

**Secuencia de encendido que esto habilita**: (1) desplegar todo con los dos flags en OFF;
(2) encender solo la ingesta en arfagi y probar medios genéricos; (3) encender después el receipt
gate, también solo en arfagi; (4) credipower permanece apagado en todo momento.

**El paso (1) NO es «no cambió nada», y decirlo así sería mentira.** Los flags gobiernan *guardar
bytes* y *proponer comprobantes*; no pueden revertir la eliminación del camino legacy, que es
precisamente el defecto que este ADR vino a cerrar. Con los dos flags en OFF, el delta esperado
—y el criterio de aceptación real del paso (1)— es exactamente éste:

- una imagen de un cliente con pedido pendiente **ya no** mueve el pedido a `PENDING_VERIFICATION`,
  **ya no** activa `humanTakeover` y **ya no** abre handoff: produce un mensaje neutral en la
  conversación y una respuesta honesta. Ése es el cambio deseado, no una regresión;
- **no** se llama a Graph, **no** se escribe en Storage y **no** se crea documento de adjunto;
- **nada** de dinero se mueve: cero cambios de estado de pedido, cero `PAID`;
- cambian los recursos de `onWebhookInbox` (timeout y memoria) y se amplía la lectura en
  `firestore.rules`, dos efectos que tampoco dependen de los flags.

De ahí se sigue algo operativo: **con los flags en OFF el deploy no es inerte**, así que volver al
comportamiento de hoy exige redesplegar código, no apagar un flag. El rollback se documenta en
`docs/deploy.md` y su orden es el **inverso** del deploy.

### 11. La promesa al cliente y la señal al vendedor son un solo hecho

El mensaje que recibe el cliente cuando se propone un candidato compromete a una persona: «un
vendedor lo revisa». Esa promesa y la campana que la hace cierta **se confirman juntas** — en la
misma transacción, con id determinístico, o no se confirma ninguna.

Si la señal operativa falla, **no se promete revisión**: el archivo queda visible como medio
normal, el pedido no se toca y la respuesta es neutral. Un aviso best-effort que se pierde deja al
cliente esperando a alguien que nunca fue notificado, y eso es peor que no prometer nada.

Un reintento del mismo webhook produce **como máximo** un candidato y una campana.

**Limitación conocida, dicha de frente**: la campana se emite sin `targetUid`, así que la ven el
OWNER y el MANAGER del tenant, pero **no el rol SELLER** —que es justamente el que la frase al
cliente nombra—. No es un descuido: en el camino de un adjunto entrante no hay ningún vendedor
asignado a quien dirigir el aviso, y ampliar la regla de lectura a todos los sellers les abriría
las campanas de clientes que no son suyos. Se deja así, con el respaldo de OWNER+MANAGER, hasta
que exista asignación de conversación; entonces el aviso llevará el `targetUid` de esa asignación,
igual que ya hacen los avisos de handoff y de cobertura.

### 12. Ninguna respuesta automática del webhook sobrevive a un takeover

Entre que se decide una respuesta y que se envía hay una ventana en la que un vendedor puede tomar
el chat. El chequeo de silencio es **autoritativo e inmediatamente anterior al envío**, con la
semántica canónica de HANDOFF-2 —no una segunda versión de la misma regla— y una respuesta
suprimida **no se persiste**: un outbound en el historial que nunca salió le miente al vendedor
sobre lo que el cliente vio.

**Alcance exacto, porque enunciarlo como universal sería falso.** El guard cubre las respuestas
automáticas del **webhook entrante**: el motor, el acuse de adjuntos y el camino de ubicación
nativa. **No** cubre la entrega por outbox de la reanudación de cobertura
(`conversation/coverageResume.ts`), que tiene su propio chequeo de takeover pero no mira
`botEnabled`. Se deja fuera a conciencia y por dos razones: la dispara una **aprobación humana**
—alguien del equipo ya decidió que ese mensaje salga—, y es código preexistente que este ADR no
toca. Queda anotado como deuda explícita, no como cobertura que no existe.

Y el guard **no puede ser el último gate por sí solo**: donde ya había un interruptor de
emergencia —el kill-switch de cobertura— ese interruptor conserva el lugar final, pegado al POST.
Meterle lecturas en el medio ensancharía la ventana que existe para cerrarse rápido.

Queda una ventana física que ningún código puede cerrar: si el takeover ocurre después de que el
POST salió hacia Meta, el mensaje ya viajó. Se documenta en vez de fingir que no existe.

**Delta con el bot apagado.** Apagar el bot desde el panel silencia lo que el bot *dice*, no lo que
el sistema *registra*: una ubicación nativa sigue registrando la solicitud de cobertura, tomando el
chat y avisando al vendedor — lo único que desaparece es el acuse al cliente. Es preexistente, y se
escribe acá para que nadie lea «bot apagado» como «sistema inerte».

## Consecuencias

- Un archivo que hoy se perdía ahora se conserva y se ve desde el chat.
- Un pedido deja de cambiar de estado por el solo hecho de que llegue una foto.
- El vendedor gana una decisión explícita —y auditada— sobre qué es un comprobante.
- Aparece una superficie nueva que hay que cuidar: bytes de clientes en Storage, con retención
  configurable, purga apagada por defecto y prohibición de borrar evidencia vinculada a pedidos.
