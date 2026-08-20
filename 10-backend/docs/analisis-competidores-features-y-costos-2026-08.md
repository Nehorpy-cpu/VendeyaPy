# Análisis de competidores, features faltantes y costos — VendeYaPy

> Fecha: 2026-08-20. Investigación de 5 ángulos (Cliengo, Kommo, ManyChat, pack LATAM
> Callbell/Whaticket/Leadsales/Simla/Chatwoot, taxonomía de features, ingeniería de costos),
> **verificada contra el código real**. Complementa `informe-mercado-y-plan-2026-08.md`.
> **Restricción del owner: todo lo propuesto es ADITIVO — nada de lo existente se rompe.**

---

## 0. TL;DR

1. **Tres campos del panel no hacen nada** (hallazgo nuevo, no estaba en la auditoría):
   `fallbackMessage`, `handoffMessage` y `farewellMessage` se configuran, se guardan, se validan
   — y el motor **nunca los lee**.
2. **Horarios de atención: no existe nada.** Es la única feature que los **5** competidores LATAM
   tienen sin excepción, y la que más barato sale construir.
3. **El bot es solo texto.** `sendImage` existe pero solo lo usa el vendedor desde el panel; el
   bot nunca manda la foto del producto que recomienda. Tampoco hay botones ni listas.
4. **Firestore está en `nam5` (multi-región) = 2x el costo permanente**, y la ubicación **no se
   puede cambiar** después de creada. A 1 tenant son centavos; a 100 es el doble del rubro que
   más crece. La ventana para decidir es ahora.
5. **Sin `maxInstances` en ninguna function** ⇒ no hay techo duro de gasto de cómputo.
6. **Sin prompt caching** ⇒ se está pagando de más entre 50% y 65% del input de Claude.

---

## 1. Lo que YA tiene VendeYaPy (verificado en código — no reconstruir)

| Capacidad | Dónde | Estado |
|---|---|---|
| Nombre del bot, negocio, tono, idioma | `conversation/agentConfig.ts` | ✅ usado |
| **Mensaje de saludo** (`greetingMessage`) | `engine.ts:1300,1442,1475,1517` | ✅ usado |
| Reglas de venta (`salesRules`) + **FAQ** | `ai/prompts.ts:13` | ✅ van al prompt |
| Encender/apagar el bot (`botEnabled`) | | ✅ |
| **Respuestas determinísticas sin IA** | `engine.ts` | ✅ navegar, elegir por número/nombre, carrito, pagar, cobertura — **cero costo de IA** |
| Enviar imagen / documento | `messaging/whatsappClient.ts:307,311` | ✅ existe (lo usa el panel) |
| Pedir ubicación al cliente | `whatsappClient.ts:316` | ✅ (flujo de envíos) |
| Handoff a humano + bandeja | ADR-0021 | ✅ en repo |

## 2. Los tres hallazgos nuevos

### 2.1 🔴 Configuración muerta (patrón "reacciona pero no acciona")

`apps/web/src/app/(panel)/agent/page.tsx` expone tres campos editables:

| Etiqueta en el panel | Campo | Línea | ¿El motor lo lee? |
|---|---|---|---|
| "Cuando no entiende" | `fallbackMessage` | :148 | ❌ **nunca** |
| "Al derivar a vendedor" | `handoffMessage` | :149 | ❌ **nunca** |
| "Despedida" | `farewellMessage` | :150 | ❌ **nunca** |

Únicas apariciones fuera del panel: la lista de validación de `config/validate.ts:40`. El dueño
escribe su mensaje, lo guarda, y el bot lo ignora para siempre. **No estaba en la auditoría.**

### 2.2 🔴 Horarios de atención: cero implementación

Ni horarios, ni días de envío, ni ventana de pedidos, ni feriados, ni zona horaria de atención.
Es la única feature presente en los **5** competidores del pack LATAM sin excepción — y en
Callbell es una queja explícita por estar mal hecha (*"the system forces use of predetermined
time windows, preventing configuration of exact hours"*).

### 2.3 🟡 El bot es solo texto

`sendImage` se usa **únicamente** en `conversation/sendAttachment.ts:559` (el vendedor mandando
adjuntos desde el panel, ADR-0021). El bot recomienda perfumes **sin mandar la foto**. Tampoco
usa botones de respuesta ni listas: el único `type:'interactive'` del cliente es el pedido de
ubicación. Sin typing indicator ni marcar como leído.

---

## 3. Respuestas a las tres preguntas concretas del owner

### 3.1 ¿Qué tan necesario es que el bot mande imágenes, videos, ubicación y links?

La Cloud API soporta mucho más de lo que se usa. Priorizado por impacto real en una venta:

| Tipo | ¿Vale la pena? | Por qué |
|---|---|---|
| **Imagen del producto** | 🟢 **SÍ, lo más importante** | Vender perfume por texto es vender a ciegas. `sendImage` **ya existe** — falta que el motor lo use al recomendar. |
| **`preview_url` en links** | 🟢 **SÍ, gratis** | WhatsApp renderiza solo la tarjeta del primer link (título, imagen, descripción). Es un flag en el mensaje de texto. Costo cero. |
| **Botones de respuesta (hasta 3)** | 🟢 **SÍ** | "Ver más / Agregar al carrito / Hablar con alguien". Sube conversión y **baja costo de IA**: la respuesta llega estructurada, no hay que interpretarla. |
| **Listas (hasta 10 filas)** | 🟢 **SÍ** | Reemplaza "elegí por número" con un selector nativo. Menos errores, menos turnos, menos tokens. |
| **Carrusel de media** (GA feb-2026) | 🟡 Evaluar | 2-10 tarjetas con foto scrolleables y **no requiere catálogo de Meta**. Ideal para "te muestro 5 opciones". Es lo más cercano a una vidriera dentro del chat. |
| **Ubicación saliente** | 🟡 Sí, si hay local | Mapa tocable para retiro en tienda. Barato. Hoy solo existe *pedir* la ubicación del cliente. |
| **Typing indicator + marcar leído** | 🟡 Barato y se nota | Percepción de calidad. Un endpoint. |
| **Video** | 🔴 **No** | 16 MB máx. Para perfumería no mueve la aguja y suma peso de Storage y egress. |
| **Audio saliente / sticker / contacto** | 🔴 No | Ruido. |
| **Transcripción de audio ENTRANTE** | 🟡 Importante a futuro | Distinto del audio saliente: en LATAM el cliente manda notas de voz. Kommo lo esconde en su plan más caro. |

**Conclusión:** lo que falta no es "más tipos de archivo" — es **foto del producto + botones +
listas**. Los tres suben conversión y dos de los tres **bajan** el costo de IA.

### 3.2 ¿Qué mensajes automáticos conviene implementar?

Set estándar del mercado, cruzado con lo que ya tenés:

| Mensaje | Competidores | Estado en VendeYaPy | Recomendación |
|---|---|---|---|
| **Bienvenida / saludo** | Todos | ✅ funciona | — |
| **Cuando no entiende** | Todos | ⚠️ campo muerto | 🥇 **Conectar** — trabajo a medias |
| **Al derivar a vendedor** | Todos | ⚠️ campo muerto | 🥇 **Conectar** |
| **Despedida** | Todos | ⚠️ campo muerto | 🥇 **Conectar** |
| **Fuera de horario** | Los 5 del pack LATAM | ❌ no existe | 🥈 **Construir** (requiere §3.3) |
| **Mensaje de espera** ("ya te atendemos") | Gallabox, en **todos** sus planes | ❌ no existe | 🥈 Construir: se dispara cuando el chat está tomado por un humano y nadie contesta en N minutos |
| **Confirmación de pedido** | Todos | ✅ existe | — |
| **Aviso de pago confirmado** | Todos | ⚠️ **se arma y nadie lo manda** (H-06 de la auditoría) | 🥇 Cerrar con el lote de dinero |
| Encuesta CSAT | Whaticket, Chatwoot | ❌ | 🔴 **No** — ningún usuario de los 5 la menciona en reviews |
| Cumpleaños / recompra | Simla | ❌ | 🟡 Después, junto con recuperación de carrito |

**Orden recomendado:** (1) conectar los tres muertos, (2) aviso de pago confirmado, (3) fuera de
horario, (4) mensaje de espera.

### 3.3 Diseño de horarios de atención, envíos y pedidos

**Principio rector: `ausente = comportamiento de hoy`.** Un tenant sin horarios configurados
atiende 24/7 exactamente como ahora. Ni una línea del flujo actual cambia de resultado. Es el
mismo fail-safe que ya usan `automationMode` y los flags de cobertura.

**Estructura propuesta** (documento nuevo, no toca ninguno existente):

```
tenants/{tenantId}/config/businessHours
{
  enabled: false,                    // ← ausente o false ⇒ 24/7, como hoy
  timezone: 'America/Asuncion',
  atencion:  { lun: [{desde:'08:00', hasta:'18:00'}], mar: [...], ... },
  pedidos:   { ... },                // ventana en la que se toman pedidos
  envios:    { dias: ['lun','mie','vie'], horaCorte: '15:00' },
  excepciones: [{ fecha:'2026-12-25', cerrado:true, motivo:'Navidad' }],
  mensajes:  { fueraDeHorario: '...', anunciarProximaApertura: true }
}
```

**Comportamiento — y acá está la decisión importante:**

> **El bot NO se apaga fuera de horario.** Apagarlo mata ventas: el cliente escribe a las 23 h
> justamente porque no puede durante el día. Lo que cambia es que el bot **avisa** en vez de
> prometer lo que no puede cumplir.

- Sigue vendiendo, recomendando y armando el carrito **siempre**.
- Fuera de horario **agrega una advertencia honesta**: *"Te confirmamos el pedido mañana a las 8"*.
- Fuera del día de envío: *"El despacho sale el lunes"* — antes de cerrar, no después.
- El handoff a humano fuera de horario **avisa la demora** en lugar de prometer atención ya.

**Costo: cero de IA.** Es un guard determinístico *antes* del motor, exactamente como el guard de
cobertura que ya existe. Y según la investigación, fuera de horario **reduce** el costo operativo.

---

## 4. Inventario de features faltantes, por necesidad

### 🥇 Imprescindibles (los 5 competidores LATAM las tienen; la pyme las usa todos los días)

| Feature | Esfuerzo | Costo de correr | Nota |
|---|---|---|---|
| **Horarios + fuera de horario** | bajo | **negativo** (ahorra) | §3.3 |
| **Etiquetas de conversación + filtros** | bajo | ~cero | Única feature en los 5 sin excepción. "Para la pyme LATAM las etiquetas SON el CRM" |
| **Notas internas** en la conversación | bajo | ~cero | Complemento obligatorio del handoff: sin esto el contexto se pierde al cambiar de turno |
| **Respuestas rápidas** (`/atajo`) para el vendedor | bajo | **cero, y ahorra** | Extiende al humano el principio de "respuestas sin costo de IA" que ya adoptaste |
| **Estado de entrega** (enviado/entregado/leído/fallido) | bajo | bajo | ✅ **ya construido en ADR-0021**, falta desplegarlo |
| **Asignación de conversaciones** + round-robin | medio | bajo | La feature #1 más votada del feedback público de Callbell (45 votos) |
| **Roles y permisos** (admin vs vendedor) | medio | bajo | Sin esto la vendedora ve facturación y límites de tokens |
| **Búsqueda de conversaciones e historial paginado** | medio | medio | Queja literal y repetida de Callbell |

### 🥈 Importantes

Alerta de chat sin responder (SLA) · reportes operativos precomputados (3 números, no un BI) ·
plantillas HSM aprobadas por Meta (reabrir la ventana de 24 h) · base de conocimiento por PDF/URL ·
transcripción de notas de voz entrantes · ficha del cliente con historial de pedidos · campos
personalizados + import/export CSV · **app móvil (PWA)** — los 5 competidores la tienen sin
excepción, y la dueña de una perfumería atiende desde el celular · recuperación de carrito
abandonado · **vista de pedidos por estado** (la traducción honesta del "kanban" al caso de
VendeYaPy) · conversiones offline a Meta (CAPI) al cerrar la venta · cancelación autoservicio.

### 🔴 NO construir (ruido que infla el costo de mantenimiento)

| Feature | Por qué no |
|---|---|
| **Constructor visual de flujos no-code** | La pieza más impresionante de Kommo **y su mayor fuente de quejas**. Alto esfuerzo, altísimo mantenimiento. Ya tenés config del bot + reglas |
| **Multicanal** (Instagram, Messenger, Telegram, TikTok) | Cada canal es webhook nuevo, modelo nuevo, ciclo de tokens nuevo. Rompe la premisa WhatsApp-first |
| **Embudo kanban arrastrable de leads** | Existe porque **el bot de ellos no cierra la venta**. El tuyo sí. Sería importar un problema ajeno |
| **Catálogo nativo de Meta + carrito de WhatsApp** | Sería un **downgrade**: perdés el guard de deriva y el checkout conversacional |
| **Lead scoring / agendamiento de citas** | Features de embudo largo (inmobiliarias, salud). En perfumería no hay a quién llamar primero |
| **Marketplace de integraciones (HubSpot, Salesforce, SAP)** | Un webhook saliente genérico cubre todo por una fracción del costo |
| **Créditos de IA como moneda + packs de recarga** | El sistema de Kommo hace que los agentes **dejen de responder** al agotarse. Vos ya lo resolvés mejor |
| **Voz / telefonía / grabación** | Producto distinto: SIP, WebRTC, costo por minuto, compliance |
| **Chat interno entre agentes** | Una perfumería de 1-3 personas ya tiene chat interno: se llama WhatsApp |
| **SLA policies, SSO/SAML, permisos por campo** | Compra corporativa, no pyme |
| **Copilot que sugiere respuestas al vendedor** | Gasta tokens y el operador ya sabe qué contestar |
| **Modo oscuro** | Cuesta poco y no mueve ninguna aguja |

---

## 5. Costos — las palancas verificadas en tu proyecto

| # | Palanca | Verificado | Impacto |
|---|---|---|---|
| 1 | **Firestore en `nam5`** | ✅ `locationId: nam5` leído de prod | **2x permanente** en lecturas ($0.06 vs $0.03/100k), escrituras ($0.18 vs $0.09) y storage. **La ubicación NO se puede cambiar**: exigiría base nueva + migración |
| 2 | **`maxInstances` ausente** | ✅ cero coincidencias en el repo | Es el **único techo duro** de gasto de cómputo. Los presupuestos de GCP son alertas, no topes. Un trigger en loop escala sin límite |
| 3 | **Prompt caching ausente** | ✅ cero `cache_control` | **50-65% de ahorro** en el input de Claude, que es el rubro más caro. El prefijo estable (tools + system + config) se re-factura en cada llamada |
| 4 | **`pricing.ts` no cuenta cache tokens** | ✅ solo `inputTokens`/`outputTokens` | En cuanto se active caching, los números de costo dejan de reflejar lo facturado |
| 5 | **Sin cota de historial** | consistente con A3-1 de la auditoría | El costo por turno crece con la conversación; en loops de tools el crecimiento es cuadrático. La auditoría midió 48 ejecuciones de tool en un turno |
| 6 | **Artifact Registry sin cleanup policy** | — | Cada deploy de cada una de las 118 functions guarda una imagen. Se acumulan y se facturan |

**Lectura honesta:** con 1 tenant real, la factura hoy es chica y ninguna de estas es una
emergencia. Pero (1) y (2) son decisiones **estructurales** que se vuelven caras de revertir:
la región de Firestore no se cambia, y sin `maxInstances` un incidente puede facturar sin techo.
Conviene resolverlas **antes** de abrir el registro a otras empresas, no después.

---

## 6. Plan aditivo propuesto (nada de lo existente cambia de comportamiento)

**Lote A — cerrar lo que está a medias** (esfuerzo bajo, cero features nuevas)
1. Conectar `fallbackMessage`, `handoffMessage`, `farewellMessage` al motor.
2. `maxInstances` explícito en toda function expuesta (config, no lógica).
3. Cleanup policy de Artifact Registry.

**Lote B — horarios** (§3.3, con `ausente = 24/7`)
4. Documento `businessHours` + guard determinístico + mensaje fuera de horario + aviso de día de
   envío.

**Lote C — el bot deja de ser solo texto**
5. Foto del producto al recomendar (`sendImage` ya existe).
6. `preview_url` en links (un flag).
7. Botones de respuesta y listas para la selección (suben conversión y **bajan** tokens).

**Lote D — bandeja al nivel del mercado**
8. Etiquetas + filtros · notas internas · respuestas rápidas con `/atajo`.

**Lote E — costos de IA**
9. Prompt caching + contabilizar cache tokens + cota de historial.

**Decisión aparte, no un lote:** qué hacer con `nam5`. Requiere decisión del owner sobre migrar
o aceptar el 2x.

---

## 7. Fuentes

Investigación web 2026: docs y pricing oficiales de Cliengo, Kommo, ManyChat, Callbell,
Whaticket, Leadsales, Simla, Chatwoot, Wati, Gallabox, respond.io, AiSensy, Interakt;
documentación de WhatsApp Cloud API (tipos de mensaje, interactive, carousels, Flows);
reviews de G2, Capterra y Trustpilot; feedback board público de Callbell; precios oficiales de
GCP/Firebase y de Anthropic. Verificaciones contra el código y contra producción marcadas como
tales.
