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

## Consecuencias

- Un archivo que hoy se perdía ahora se conserva y se ve desde el chat.
- Un pedido deja de cambiar de estado por el solo hecho de que llegue una foto.
- El vendedor gana una decisión explícita —y auditada— sobre qué es un comprobante.
- Aparece una superficie nueva que hay que cuidar: bytes de clientes en Storage, con retención
  configurable, purga apagada por defecto y prohibición de borrar evidencia vinculada a pedidos.
