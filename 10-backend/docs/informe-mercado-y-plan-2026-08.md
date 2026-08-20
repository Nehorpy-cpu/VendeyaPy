# Informe de mercado + plan estratégico — VendeYaPy

> Fecha: 2026-08-19. Autor: sesión coordinadora (Claude). Basado en investigación web de 6 ángulos
> del mercado (líderes globales, LATAM, agentes IA, plataforma Meta, pricing, pagos) verificada
> contra el código real del repo. **No sustituye a `ESTADO.md`** — es análisis, no estado.

---

## 0. TL;DR

1. **El plan actual NO se desvía — se confirma.** La prioridad sigue siendo cerrar el ciclo
   single-tenant (prueba Fase 3 + feed) antes de sumar features. La investigación no cambia el
   orden; agrega *por qué* cada cosa importa y qué sigue después.
2. **Hay una amenaza con fecha:** Meta lanzó su propio *Business Agent* (bot IA nativo del
   catálogo) global en jun-2026. El bot básico "responde y recomienda del catálogo" se vuelve
   commodity. **Todo el valor de VendeYaPy que Meta NO copia hay que hacerlo explícito y
   profundizarlo** (ver §3).
3. **Hay un viento a favor con fecha:** desde ene-2026 Meta **prohíbe** los bots IA de propósito
   general en la Plataforma; solo permite agentes acotados a un proceso de negocio (ventas,
   soporte). El diseño de VendeYaPy es legal por construcción; los wrappers caseros de ChatGPT
   quedan fuera. Esto hay que documentarlo para el App Review en curso.
4. **El foso real de VendeYaPy en Paraguay es el pago local.** Ninguno de los ~14 competidores
   revisados verifica comprobantes de transferencia ni cobra con rieles paraguayos. La feature de
   comprobantes-por-foto (ya en producción) es exactamente el gap del mercado.
5. **La mayor deuda de producto no es una feature: es la confianza.** La queja transversal de
   todo el segmento (Wati, AiSensy, Zoko, Interakt, jugadores LATAM) es pricing opaco, markups
   ocultos, soporte lento y cancelación con dark patterns. Es una ventaja regalada.

---

## 1. Qué hace bien el mercado (y VendeYaPy debería adoptar)

| Práctica del mercado | Quién la hace | Estado en VendeYaPy |
|---|---|---|
| Onboarding self-service por Embedded Signup en minutos | Wati, todos | ✅ Construido, en App Review |
| Bot IA de ventas (no árbol de decisión) | Interakt, Yalo, Zoko | ✅ Es el core del producto |
| Verificación de pago dentro del chat | Casi nadie en LATAM | ✅ Comprobantes por foto, en prod |
| Handoff a humano con panel | Todos | ✅ Bandeja + takeover |
| **Handoff "inteligente"** (resumen IA + carrito + acción sugerida al vendedor) | Zowie (enterprise) | ⚠️ Handoff sí, resumen IA no |
| **Recuperación de carrito / pago pendiente** | Zoko, Interakt | ⚠️ Hay módulo `followups`, falta el disparo por abandono |
| **AI Supervisor** (qué preguntó el cliente que el bot no supo) | Nadie bien | ❌ Brecha del mercado, oportunidad |
| **Pago con link/QR local** (confirmación automática) | Interakt (UPI India) | ❌ No hay pasarela local en código |
| Pricing transparente "sin markup sobre Meta" | Zoko (lo usa de bandera) | ⚠️ Cobra tokens de IA; falta el claim |
| Analytics de ROI por conversación | Nadie bien | ❌ Oportunidad |
| Kanban de pipeline en la bandeja | Leadsales, Whaticket | ❌ La bandeja no tiene etapas visuales |
| Transcripción de notas de voz entrantes | Zapia (6M usuarios LATAM) | ❌ No hay audio-in |

## 2. Qué hace MAL el mercado (ventajas regaladas para VendeYaPy)

Estas son quejas verificadas en G2/Capterra/Trustpilot de los líderes. Cada una es un
diferenciador barato:

1. **Markups ocultos sobre las tarifas de Meta** (~20% Wati, ~12% AiSensy). Queja #1 transversal.
2. **Soporte lento** (1-3 días, loops de bots) — el talón de Aquiles de TODA la categoría.
3. **Cancelación con dark patterns** (soporte que deja de responder al pedir la baja).
4. **El bot se queda MUDO cuando se acaban los créditos de IA** (error de Gallabox). VendeYaPy ya
   lo resuelve bien: con cupo agotado deriva a humano con aviso (AI-FALLBACK-HONESTO-1).
5. **Analytics pobres** (Gallabox, AiSensy) — nadie le dice al dueño "esta conversación te costó X
   y generó Y".
6. **Chatbot builder como add-on caro y sorpresa** (AiSensy ₹2.500/mes aparte).

## 3. La amenaza Meta Business Agent — y por qué VendeYaPy sobrevive

Meta lanzó su bot IA nativo (global jun-2026). Un comerciante podría preguntar: *"¿para qué te
pago si WhatsApp ya trae IA gratis?"*. La respuesta —lo que Meta NO hace y VendeYaPy sí— hay que
tenerla escrita y profundizada:

- **Verificación de comprobantes de transferencia por foto** (el pago informal de LATAM).
- **Cotización de envíos** con reglas del negocio.
- **Panel de handoff multi-vendedor** con bandeja profesional.
- **Aislamiento multi-tenant** con conexión oficial por empresa.
- **Promociones y lógica de negocio** propias del tenant.
- **Grounding estricto anti-alucinación**: precio y stock SIEMPRE del catálogo, nunca inventados.

El bot básico "recomienda del catálogo" se vuelve commodity. El **cierre de la venta con pago
local verificado** no. Ahí está el producto.

## 4. Cómo se compara el pricing de VendeYaPy (verificado en `plans/plans.ts`)

VendeYaPy YA tiene 5 tiers definidos, en USD **y guaraníes**, con matriz de features:

| Plan | USD/mes | Gs/mes | Tokens IA/mes | Números WA | Features activas |
|---|---|---|---|---|---|
| FREE | 0 | 0 | 0 | 1 | trial 7 días |
| STARTER | 29 | 150.000 | 50.000 | 1 | aiAssistant |
| GROWTH | 79 | 350.000 | 250.000 | 3 | + marketingAutomation |
| PRO | 199 | 650.000 | 1.000.000 | 10 | + marketingAutomation |
| ENTERPRISE | a medida | — | ilimitado | ilimitado | todas |

**Lectura vs mercado:** el rango ($29-199) está **bien calibrado** para pyme LATAM (el piso
percibido es $16-50; los globales arrancan en $59-89). Ventajas ya presentes: precio en guaraníes
(el modelo AiSensy prueba que la moneda local gana en mercados sensibles), y tokens de IA como
límite (protege el margen contra el costo variable de Claude).

**Ajustes que sugiere la investigación (NO ahora — cuando se retome el multi-tenant):**
- Renombrar "tokens" de cara al cliente a "conversaciones con IA/mes" (la pyme no entiende tokens).
- Empaquetar por tier lo que la visión ya pide: pago integrado y conexión Meta Business Suite en
  tiers altos; comprobante+contraentrega en Starter.
- Bandera "sin markup sobre Meta" cuando se cobre mensajería.
- Trial con crédito de IA real para que el comerciante vea al bot cerrar UNA venta (mejor
  conversión posible).

## 5. Ideas priorizadas (de la investigación, filtradas por "no desviarse")

### Ahora (no son features nuevas — cierran lo que ya existe)
- **P0 — Prueba Fase 3 + feed.** Sin cambios respecto del plan vigente. Cierra el proyecto.
- **Documentar compliance con la política Meta ene-2026** para el App Review en curso (el bot es
  task-specific, no open-domain). Barato, y ayuda a la aprobación que estamos esperando.

### Próximo tramo (EN REPO, sin sumar deuda de deploy grande)
- **Handoff inteligente**: al escalar, generar un resumen IA (intención + carrito + acción
  sugerida) en el panel. Se construye sobre lo que existe; es el diferenciador más citado.
- **Recuperación de pago pendiente**: disparar `followups` cuando el cliente no manda el
  comprobante o abandona el carrito. El módulo `followups/generate.ts` ya existe; falta el gatillo.
- **AI Supervisor liviano**: listar las preguntas que el bot no pudo responder por tenant. Brecha
  real del mercado y alimenta la mejora del catálogo.

### Medио plazo (alineado con la visión multi-tenant declarada por el owner)
- **Pasarela de pago local por tenant** (uPay/arnipay/Bancard): el bot genera link/QR, el webhook
  confirma y libera el pedido sin humano. Es el foso competitivo regional. Credenciales por tenant,
  igual que el Embedded Signup. **No hay nada de esto en código hoy** — es un programa grande.
- **Conexión Meta Business Suite por tier** (anuncios + catálogo + números): la visión del owner.
  La fundación (guard de PNID/WABA, Embedded Signup, Coexistence) ya está construida y verificada.
- **Atribución Click-to-WhatsApp** (qué venta vino de qué anuncio): empezar por atribución, no por
  creación de campañas.

### Backlog / vigilar
- Transcripción de notas de voz (audio-in), kanban de pipeline en la bandeja, dashboard de ROI
  conversacional, catálogo legible por agentes compradores de terceros (Zapia/agentic commerce).

## 6. ¿Este plan choca con el que veníamos siguiendo?

**No.** Lo confirma y le agrega horizonte. El plan vigente (cerrar single-tenant: Fase 3 + feed +
Fase 5) sigue siendo P0 sin cambios. La investigación:
- **Valida** el orden actual (no sumar features hasta cerrar la operación real).
- **Valida** decisiones ya tomadas (grounding estricto, fallback honesto, precio en guaraníes,
  conexión oficial vs QR no oficial de Whaticket).
- **Pone fecha a dos fuerzas externas** (Business Agent jun-2026 como amenaza; prohibición de IA
  genérica ene-2026 como viento a favor) que antes no estaban en el radar.
- **Ordena el post-cierre**: primero profundizar los diferenciadores que Meta no copia (handoff
  inteligente, recuperación de pago, supervisor), después el pago local, después la visión
  multi-tenant completa.

El único matiz: la **visión multi-tenant del owner** (conectar Meta Business Suite por tier) es
correcta y la fundación ya está construida, pero **es post-cierre**. Abrir el registro a otras
empresas antes de probar el ciclo completo con un externo sería sumar tenants a un circuito no
validado. La investigación lo refuerza: el diferenciador no es "más empresas", es "el ciclo de
venta con pago local que nadie más cierra".

---

## 7. Fuentes

Investigación web 2025-2026: pricing y reviews de Wati, AiSensy, Interakt, Gallabox, Zoko
(G2/Capterra/Trustpilot); jugadores LATAM (Leadsales, Whaticket, Cliengo, Botmaker, Treble, Yalo,
SleekFlow, Callbell); agentes IA (Zowie, Sierra, Intercom Fin, Zapia); anuncios de plataforma Meta
(per-message jul-2025, Business Agent, prohibición IA genérica ene-2026, Flows, Coexistence);
pagos LATAM/Paraguay (uPay/Pagopar, arnipay, Bancard, QR interoperable, WhatsApp Pay Brasil).
Detalle completo con URLs en el journal del workflow de investigación.

---

# ADENDA (2026-08-20) — ¿Integrar Shopify? Decisión: NO. Evidencia.

> Pregunta del owner: *"¿para qué es Shopify, y conviene integrarlo o seguir como estamos?"*
> Investigación de 3 ángulos con fuentes primarias. Resultado: **no construir conector Shopify.**
> El conector genérico por URL de feed (ADR-0023, ya anunciado) queda **confirmado** como la
> decisión correcta, con una corrección de especificación importante (§4).

## 1. El bloqueante decisivo: Shopify PROHÍBE lo que hace VendeYaPy

Requisito de la Shopify App Store: *"Apps that bypass checkout or payment processing, or register
any transactions through the Shopify API in connection with such activity, are prohibited."*
Staff de Shopify en su foro de desarrolladores precisa que el problema concreto es **"the final
step when you mark the order as paid"**. Hay apps de contraentrega rechazadas en review por
"checkout bypass".

**Eso es exactamente el diferenciador de VendeYaPy**: checkout conversacional + verificación de
comprobante por foto que termina en pedido pagado. Bajo Shopify, ese cierre no se puede registrar.
El producto pasaría de **vender** a **notificar**. No es un problema de esfuerzo: es incompatible
por política.

## 2. El mercado no está — y el corte que importa es demoledor

| Métrica | Dato | Fuente |
|---|---|---|
| Tiendas Shopify vivas en **todo** Paraguay | **1.123** | Store Leads, 14-ago-2026 |
| WooCommerce en Paraguay | 1.576 | Store Leads |
| **Tiendas PY con Facebook SDK (las que pautan en Meta)** | **Custom Cart 64,5% · Woo 30,6% · Shopify 0,8% (1 de 124)** | Store Leads |
| MIPYMES paraguayas | ~300.000 registradas (+690.000 informales) | INE 2024 |
| MIPYMES que venden por FB/IG/WhatsApp | **93%** | Viceministerio de MIPYMES, Meta Day PY |
| Tiendas con plataforma identificable | ~2.800-4.000 (**~1%**) | Store Leads + CAPACE |

El corte de Facebook SDK es el que decide: entre los comercios paraguayos que **efectivamente
pautan en Meta** —o sea, la fuente de tráfico del flujo crítico de VendeYaPy— Shopify es **1 de
124**. El segmento dominante es el carrito a medida (64,5%), que es exactamente el perfil del
tenant actual (app Laravel propia) y **no lo cubre ningún conector de plataforma**.

**Corolario:** el catálogo LOCAL en Firestore no es un modo degradado — es el producto principal,
y cubre al ~99% del mercado direccionable en Paraguay.

## 3. Costos y timing en contra

- **Shopify Payments no opera en Paraguay** (39 países soportados; en LatAm solo México) ⇒ todo
  comercio paraguayo paga 2% extra a Shopify por pasarela de terceros **sobre** la comisión local
  (Pagopar 2,9-3% en crédito) ⇒ ~5% por venta, con ticket promedio de **G. 82.600 (~US$11)**.
- **Costo de ingeniería:** GraphQL Admin API obligatoria para apps públicas nuevas, OAuth, App
  Bridge, session tokens, Billing API, review de App Store. Estimación: 6-10 semanas + 2-4 de
  review. Y como toda app de WhatsApp necesita el **teléfono** del cliente, cae en **Protected
  Customer Data Nivel 2** (cifrado de backups, entornos separados, DLP, logs de acceso, política
  de incidentes) — en un equipo chico se mide en meses.
- **Meta ya lo comoditizó:** el Business Agent (global 3-jun-2026) conecta a Shopify nativamente y
  gratis. Construir hoy un conector propio es competir contra una feature nativa sin costo.

## 4. Lo que SÍ hay que hacer — corrección de spec para ADR-0023

El conector genérico queda confirmado, **pero no diseñar un esquema CSV/JSON propio.** Mapear
directamente la **spec de feed de Meta/Google Merchant Center**: `id`, `title`, `description`,
`availability`, `condition`, `price`, `sale_price`, `link`, `image_link`, `brand`, `item_group_id`;
aceptar CSV, TSV y XML/RSS.

**Razón:** cualquier comercio que pauta en Meta **ya tiene esa URL de feed generada y validada**,
porque es requisito duro de los anuncios de catálogo Advantage+. El onboarding pasa de *"exportá
y reformateá tu catálogo"* a *"pegá esta URL"*. Y un solo conector cubre de una vez Shopify,
WooCommerce, PrestaShop, Fenicio, Tiendanube **y los carritos a medida**.

Encaja sin fricción en lo ya construido: `EXTERNAL_SOURCE_KINDS = ['meta_feed', 'commerce_manager',
'other_api']` con `authority=external` + `relationship=mirror` (ADR-0022).

## 5. Orden de prioridad de conectores (por cobertura real en Paraguay)

1. **Conector genérico por URL de feed** — máxima prioridad, con la spec de §4.
2. **Sync read-only del catálogo de Meta** — ya construido, mantener.
3. **WooCommerce REST API** — 1.576 tiendas PY, solo si aparece demanda concreta. El feed URL ya
   lo cubre y cuesta 10x menos mantener.
4. **Shopify** — último. Si algún día hace falta, la salida barata es una **Custom app por tienda**
   (sin review de App Store y con acceso a protected data), no una app pública.
5. **Tiendanube** — **no construir**: no opera en Paraguay (solo AR/BR/MX/CO/CL). Reevaluar solo
   si se expande a Argentina (54.376 tiendas) o Brasil (122.220), donde sería el #1.
6. **Jumpseller / Empretienda** — descartar (cero en PY; Empretienda además en contracción).

## 6. La conclusión estratégica que va más allá del conector

**No sobreinvertir en conectores.** Con ~99% de las MIPYMES sin tienda online, lo que mueve la
aguja es el **onboarding del comercio SIN tienda**: sus productos hoy viven en fotos de Instagram
y una planilla. Carga masiva desde imágenes, importación desde planilla, alta rápida asistida.
El conector externo es la cuña para el 1-3% superior (y el seguro para que el tenant actual no se
rompa cuando su Laravel cambie precios), **no el motor de adquisición**.

Dato colateral que refuerza el roadmap: con **QR/transferencia en el 85% de los pagos online
locales** (CAPACE/Bancard, ago-2026), la verificación de comprobante por foto es **infraestructura
crítica del mercado paraguayo**, no un extra — merece la misma prioridad de ingeniería que el
checkout.

## 7. Precedente interno que confirma el patrón

`ADR-0004` se tituló *"WordPress/WooCommerce como fuente del catálogo"* y lleva una corrección de
2026-06-16: se asumió que `arfagi.com` era WooCommerce con REST API, y resultó ser una aplicación
PHP a medida sin API. **Ya se pagó una vez el costo de asumir que el comercio está en una
plataforma conocida.** El conector genérico por feed es precisamente la lección aprendida.

## 8. Advertencia sobre calidad de fuentes

Circula mucha cifra fabricada sobre ecommerce paraguayo. Ejemplo concreto detectado: una guía
afirma que en Paraguay *"las plataformas más usadas son Shopify (45%), Tiendanube (30%) y
WooCommerce (25%)"* — imposible, porque **Tiendanube no opera en Paraguay**, y la misma página
reporta ventas paraguayas en pesos colombianos. Sitios como cartdna.com, tiendli.com,
faststrat.ai, aurorainbox.com y chatsell.net son contenido SEO/IA sin metodología. Las cifras de
esta adenda provienen de fuentes primarias (help center de Shopify, KB de Pagopar, Store Leads,
CAPACE, INE, Viceministerio de MIPYMES) o están marcadas como no verificadas.
