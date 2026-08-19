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
