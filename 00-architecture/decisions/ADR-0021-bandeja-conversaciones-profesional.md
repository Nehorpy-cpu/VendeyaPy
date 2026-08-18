# ADR-0021 — Bandeja de conversaciones profesional (estados de entrega, ciclo de vida, vínculo a cliente y media saliente)

- **Estado:** Aceptado — EN REPO, NO DESPLEGADO
- **Fecha:** 2026-08-17
- **Relacionados:** ADR-0016 (adjuntos seguros), ADR-0017 (Coexistence/canales), ADR-0018 (reserva de cuota IA)

## Contexto

La pantalla `/conversations` del panel es funcional pero mínima: una página única con lista y chat,
polling, un solo filtro («solo mis chats»), compositor de texto plano y acciones tomar/devolver.
Auditoría del código real (2026-08-17):

- Los recibos de entrega de Meta (`value.statuses`) se **descartan** (`meta/parseWebhook.ts:493-495`);
  `Message` no tiene campo de estado y la burbuja no muestra ticks.
- `WhatsAppClient` expone solo `sendText` y `sendLocationRequest` (`messaging/whatsappClient.ts:80-86`);
  no existe subida de media a Meta ni envío manual de imagen/archivo.
- No existe archivado, eliminación, asignación manual, marcado de leído por apertura, búsqueda ni
  vínculo conversación↔cliente. `profileName` del webhook no se parsea; `Customer.name/tags/notes`
  nunca se escriben desde el backend.
- El resumen de conversación vive en `customers/{c}.conversation` (no hay colección aparte);
  `receivedVia` se escribe (`conversation/messages.ts:151`) pero está fuera del tipo.

Se decide llevar la bandeja a un estándar profesional inspirado en WhatsApp Business (identidad
propia, sin activos de WhatsApp), **reutilizando las primitivas existentes** — sin sistema paralelo.

## Decisiones

### 1. Estados de mensaje reales (solo salientes, solo del proveedor)

- `Message` gana `deliveryStatus?: 'pending'|'sent'|'delivered'|'read'|'failed'`,
  `deliveryAt?: { sent?, delivered?, read?, failed? }` (timestamps del proveedor) y
  `deliveryError?: { code?: string; detail?: string }` (sanitizado, sin payload crudo).
- Escritura inicial: al persistir una burbuja saliente aceptada se marca `pending` («enviando»).
  Todo avance posterior proviene **exclusivamente** de `value.statuses` del webhook
  (sent/delivered/read/failed). **Nunca se infiere «leído»**: si el destinatario desactivó los
  recibos, el estado se queda honesto en `delivered`.
- Transición **monotónica e idempotente** por transacción: rango `pending=0 < sent=1 < delivered=2
  < read=3`; evento con rango ≤ actual ⇒ no-op (eventos repetidos o tardíos no retroceden).
  `failed` es terminal y solo aplica si el rango actual es < `delivered`.
- Correlación por `waMessageId` (wamid) dentro del cliente derivado de `recipient_id` (misma
  sanitización a dígitos de `meta/process.ts:468`); consulta `where('waMessageId','==',…)` sobre la
  subcolección (índice single-field automático — **sin índices nuevos**). Aplica a burbujas de bot,
  vendedor y ecos de Coexistence por igual (todas guardan wamid).
- Los mensajes entrantes no tienen estado de entrega. El desenlace del envío manual conserva la
  semántica vigente: rechazo confirmado ⇒ **no** se persiste burbuja y el compositor conserva el
  texto con error honesto y reintento; `deliveryStatus:'failed'` queda para fallas reportadas por el
  proveedor después de aceptar.

### 2. Perfil del cliente honesto

- Se parsea `value.contacts[].profile.name` del webhook y se persiste como `Customer.profileName`
  (separado de `name`, que es dato CRM confirmado). Se actualiza solo al procesar mensajes entrantes.
- **Foto:** la WhatsApp Cloud API no entrega la foto de perfil del consumidor ⇒ avatar de iniciales
  siempre, sin llamadas inventadas ni fuentes externas. Campos ausentes ⇒ «Información no disponible».
- Nombre a mostrar: `name (CRM) || profileName || teléfono`. En el panel de info el teléfono se
  muestra **enmascarado** (prefijo + últimos 3 dígitos); la descripción (`notes`) solo si existe.

### 3. Ciclo de vida: archivar y eliminación lógica

- Flags en `customers/{c}.conversation`: `archived?: boolean` (+`archivedAt/archivedBy`) y
  `softDeleted?: boolean` (+`softDeletedAt/softDeletedBy`). Ambos **reversibles**.
- **Nunca** se borran físicamente mensajes, auditorías, adjuntos, comprobantes ni evidencia
  financiera desde esta UI. No hay ningún delete físico en el diff.
- La lista excluye archivadas y eliminadas por defecto; filtros dedicados las muestran para
  restaurar. Un mensaje entrante nuevo **desarchiva** automáticamente (comportamiento WhatsApp) pero
  nunca revierte `softDeleted` en silencio.
- Toda acción queda auditada (actor, tenant, conversación, acción, timestamp) vía `audit`.

### 4. Vínculo conversación↔cliente

- La identidad actual es `customerId == número`. Se agrega `Customer.linkedClientId?: string` que
  apunta a **otro doc de `customers` del mismo tenant** actuando como ficha canónica (caso: dos
  números de la misma persona; ficha CRM creada a mano).
- Callables: vincular a existente, crear ficha desde datos confirmados (id `crm_<autoid>`, no
  derivado de teléfono) y vincular, cambiar y quitar vínculo con confirmación. Bloqueos: destino
  inexistente/soft-deleted, auto-vínculo, cadenas (destino que a su vez está vinculado),
  cross-tenant (imposible por construcción de ruta + `staffAuth`).
- Búsqueda de clientes server-side paginada y limitada (`limit ≤ 20`, cursor), por prefijo de
  nombre y teléfono (índices single-field automáticos). El `tenantId` jamás se toma del navegador
  sin validar membresía (`staffAuth` vigente).

### 5. Envío manual de imagen/archivo (saliente)

- Flujo: selección → validación → previsualización → subida → envío → estado → error recuperable.
- Transporte: **base64 dentro del callable** `conversationSendAttachment` (evita abrir escritura de
  Storage al navegador). Límites conservadores por el tope HTTP del runtime: imagen ≤ 5 MB,
  documento ≤ 7 MB.
- Allowlist estricta: `image/jpeg`, `image/png`, `image/webp`, `application/pdf`. Se rechazan SVG,
  HTML, ejecutables, archivos comprimidos y cualquier inconsistencia entre MIME declarado y **magic
  bytes verificados en el servidor** (se reutiliza el sniffing de ADR-0016). Nombre sanitizado,
  ruta de Storage opaca (mismo esquema `tenants/{t}/attachments/{id}`), URLs firmadas de corta
  duración vía `attachmentGetViewUrl` — nunca persistidas.
- Subida a Meta por `POST /{pnid}/media` (media id) — la URL de Storage nunca se expone a Meta.
  `WhatsAppClient` gana `sendImage`/`sendDocument`; el mock del emulador los implementa con la
  misma semántica `viaMock`.
- **Un solo camino de routing:** el guard de `conversation/manualMessage.ts` (cliente existe →
  dispatcher por canal fail-closed → sessionKey por `receivedVia` → takeover/override → gate de
  cotización → PNID exacto de `receivedVia`, origen `'humano'`) se extrae y lo comparten texto y
  media. Conversación de Instagram/Messenger ⇒ `channel_send_unsupported`, jamás desvío a WhatsApp.
- Idempotencia por `operationId` del cliente (reserva transaccional `create()` antes de tocar Meta;
  reintento del mismo op ⇒ resultado previo, sin doble envío). Timeout y errores sanitizados.
- El adjunto saliente **nunca** se clasifica como comprobante (`direction:'out'`, `origin:'panel'`;
  el receipt-gate solo considera entrantes). El caption vive en el doc de adjunto (contrato
  ADR-0016), **no** como texto de mensaje ⇒ no llega a módulos de IA.

### 6. Compatibilidad multi-canal y automatización

- Se respetan sin excepción: tenant binding, canal de origen, `phoneNumberId`/conexión, Coexistence,
  `automationMode`, handoff/takeover y asignación. Ambigüedad de canal o sesión ⇒ fail-closed sin
  enviar. Ninguna decisión de routing nueva: solo se reutiliza el dispatcher existente.

### 7. Matriz de permisos (servidor manda; la UI la espeja)

| Acción | VIEWER | SELLER | MANAGER | OWNER | PLATFORM_ADMIN |
|---|---|---|---|---|---|
| Ver módulo / leer conversaciones y mensajes | ✗ | ✓ | ✓ | ✓ | ✓ |
| Tomar / devolver al bot | ✗ | ✓ | ✓ | ✓ | ✓ |
| Enviar texto/media (takeover propio; override sin takeover) | ✗ | ✓ (con takeover) | ✓ | ✓ | ✓ |
| Marcar leído (apertura) | ✗ | ✓ | ✓ | ✓ | ✓ |
| Archivar / desarchivar | ✗ | ✓ | ✓ | ✓ | ✓ |
| Eliminar lógico / restaurar | ✗ | ✗ | ✓ | ✓ | ✓ |
| Asignar vendedor | ✗ | ✗ | ✓ | ✓ | ✓ |
| Vincular / crear / desvincular cliente | ✗ | ✗ | ✓ | ✓ | ✓ |

- Se corrige la inconsistencia real detectada: `TENANT_MANAGER` tenía permisos por rules y callables
  pero no veía el módulo en el sidebar (`apps/web/src/lib/roles.ts:45`).
- Rules de Firestore sin cambios de fondo: `messages`/`sessions` siguen `write: false` (solo Admin
  SDK); los flags nuevos viven en `customers` y se escriben por callable.
- `receivedVia` se formaliza en `CustomerConversationMeta` (hoy fuera de contrato).

## Contratos nuevos (callables)

`conversationArchive`, `conversationUnarchive`, `conversationSoftDelete`, `conversationRestore`,
`conversationAssign` (`sellerUid | null`), `conversationMarkRead`, `conversationLinkClient`,
`conversationUnlinkClient`, `conversationCreateClient`, `customerSearch`,
`conversationSendAttachment`. Todos `{tenantId, customerId, …}` bajo `staffAuth` + verificación de
rol según matriz, con auditoría.

## UX (resumen normativo)

Desktop: tres paneles (lista / conversación / info del cliente), header con avatar-iniciales,
nombre, canal, estado y acciones, compositor fijo. Mobile: pantallas apiladas con volver claro.
Lista: buscador, filtros (todas / no leídas / mías / bot / atención humana / archivadas /
eliminadas), preview, hora, contador de no leídos, canal, takeover. Historial: separadores
Hoy/Ayer/fecha, hora por mensaje, ticks ✓/✓✓/✓✓azul-accesible/error, media inline y tarjeta de
documento, paginación hacia atrás con scroll estable y botón «Ir al mensaje más reciente».
Compositor: multilínea, Enter envía / Shift+Enter salto, emojis Unicode (picker propio, sin
dependencias nuevas), adjuntar con preview y cancelación, progreso, reintento honesto, borrador
local por conversación, deshabilitado coherente con permisos/canal. Estados de carga/vacío/error/
éxito completos, `aria-live`, navegación por teclado, focus trap y Escape en modales, contraste AA.
Sin assets propietarios de WhatsApp; sin dependencias nuevas.

## Consecuencias y deudas aceptadas

- **Polling se conserva** (8 s lista / 4 s chat): pasar a `onSnapshot` es un cambio de arquitectura
  aparte; queda como mejora futura documentada.
- Filtros de lista se aplican client-side sobre la ventana de 100 conversaciones (patrón vigente,
  volumen fase 1); pasar filtros al server exigirá índices compuestos nuevos — diferido.
- Límite documento 7 MB por tope HTTP del callable (base64); subir vía Storage con rules dedicadas
  queda como evolución si el negocio pide archivos mayores.
- Respuesta a IG/Messenger sigue fail-closed (`channel_send_unsupported`) hasta tener cliente de
  envío propio de esos canales.
- Los `statuses` de números en modo Coexistence dependen de lo que Meta emita para ecos; si no
  llegan, la burbuja queda honesta en `pending`/`sent`.
- **Sin cadenas, en ambas direcciones** (endurecido por la review adversarial): además de rechazar
  un destino ya vinculado, se rechaza vincular un doc que ya es ficha canónica de otros
  (`client_is_canonical`), y ninguna operación de vínculo procede sobre una conversación
  `softDeleted`. La reserva de idempotencia de adjuntos tiene lease (una reserva `pending` más
  vieja que el lease se considera huérfana de un crash y es retomable) y el replay valida
  coherencia del request contra la reserva.
- **Deudas aceptadas y documentadas** (review adversarial, sin ALTO): (a) un lote de `statuses`
  grande genera un doc de inbox + un process por recibo — aceptable porque el webhook exige firma
  `X-Hub-Signature-256` (solo Meta o un secret filtrado pueden generarlo); (b) la compensación de
  un envío de adjunto fallido NO borra los bytes de Storage (coherente con «jamás delete físico»;
  el reintento reescribe el mismo path determinístico) — rechazos repetidos acumulan bytes hasta
  que exista una retención/GC de salientes fallidos; (c) riesgo social residual de `profileName`
  (un cliente puede llamarse «Soporte X»): mitigado con saneo técnico + prefijo `~` estilo
  WhatsApp Business cuando el nombre mostrado no es CRM confirmado.
