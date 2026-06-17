# ADR-0006 — Capa diferenciadora "Growth Copilot" (insights por reglas + jobs, IA solo para redactar)

**Fecha:** 2026-06-16
**Estado:** Aceptada (planificación; se implementa después de P10)
**Decisores:** Owner del proyecto

---

## Contexto

El owner quiere que el sistema no sea "un panel más", sino un **asistente de decisiones**: que
cada empresa sepa **qué hacer para vender más y ganar más**. Pidió 10 módulos diferenciadores
(ver `docs/growth-copilot-diferenciador.md`). El spec vino en SQL (generado por ChatGPT), pero
**usamos Firebase/Firestore** (ADR-0001, ADR-0005).

## Decisión

1. **Adaptación SQL → Firestore:** todas las "tablas" del spec se implementan como **colecciones**
   bajo `tenants/{tenantId}/...` (multi-tenant, ADR-0005). Los campos nuevos van en los documentos
   existentes (productos, pedidos, clientes, conversaciones).
2. **Cálculo barato primero (NO IA en tiempo real):** insights, scores, follow-ups y auditorías
   se generan con **reglas simples + jobs programados** (Cloud Functions con Cloud Scheduler/Pub-Sub)
   que **precalculan** y escriben el resultado en colecciones. La UI **solo lee** lo precalculado
   (lecturas baratas). NUNCA se calcula todo en tiempo real ni con IA.
3. **La IA (Claude Haiku) solo para redactar/explicar/resumir** una recomendación ya calculada
   por reglas — no para decidir ni para hacer cuentas. Con prompt caching para abaratar.
4. **Sin mensajes automáticos al inicio:** los follow-ups generan **tareas + mensajes sugeridos**
   para el vendedor (no se envían solos), para evitar costos y problemas con WhatsApp.

## Por qué (en Firestore no hay SQL)

Firestore no hace joins ni agregaciones tipo SQL de forma barata. Por eso el patrón correcto es:
**job programado lee → calcula con reglas en JS → escribe docs `insights`/`scores`/etc.** La
pantalla lee esos docs ya listos. Esto mantiene el costo bajo (objetivo explícito del owner) y
escala bien multi-empresa.

## Implicancia: preparar durante P1–P10 (para no retrofitear)

Mientras construimos el panel base, dejar listos los **campos de origen/tracking y de rentabilidad**
para que los datos se acumulen y estos módulos los tengan cuando se construyan:
- Pedidos / conversaciones / clientes / store_views: `source`, `campaignId`, `utmSource`,
  `utmMedium`, `utmCampaign`, `couponCode` (módulo 6 — Tracking propio).
- Productos: `costPrice` (P2), y más adelante `priorityScore`, `targetMargin`, `allowDiscount`,
  `maxDiscountPercentage`, `aiPriorityNotes` (módulo 2 — Modo Ganancia).
- Conversaciones: guardar **historial de mensajes** (P5) — base para auditoría y follow-ups.

## Consecuencias

**Positivas:** convierte el SaaS en un copiloto de ventas (gran diferenciador comercial); costo
bajo; aprovecha datos que ya generamos. **Negativas:** más colecciones y jobs; requiere que P1–P10
ya estén generando datos; algunas recomendaciones serán básicas hasta tener volumen de datos.

## Alcance

Se implementa como **Track C (P11–P19)**, después de P10. Detalle en
`docs/growth-copilot-diferenciador.md`. Cada fase se desglosa en ~2 sub-fases al llegar.
