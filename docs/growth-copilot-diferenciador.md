# Growth Copilot — Capa diferenciadora (Track C, después de P10)

> El sistema deja de ser "un panel" y pasa a ser un **asistente de decisiones**: le dice a cada
> empresa **qué hacer para vender más y ganar más**. Ver ADR-0006.
> **Regla de costo:** reglas + jobs programados que *precalculan* (Firestore), IA (Haiku) solo
> para redactar/explicar. Sin cálculo en tiempo real costoso. Sin envíos automáticos al inicio.

Todas las "tablas" del spec → **colecciones Firestore** bajo `tenants/{tenantId}/...`.

---

## Mapa de fases (Track C)

| Fase | Módulo | Qué entrega |
|------|--------|-------------|
| **P11** | Tracking propio (sin Meta) | Campos `source/utm*/couponCode/campaignId` en pedidos, conversaciones, clientes, storeViews + links/QR/cupones por campaña. Medir campañas sin Meta. |
| **P12** | Score de clientes | `customerScore` + estados (Nuevo/Caliente/Comprador/Recurrente/Premium/Dormido/Perdido) por **job + reglas**. |
| **P13** | Centro de Decisiones / Growth Copilot + "Acciones de hoy" | Colección `insights` (recomendaciones accionables) + sección "Acciones de hoy" en el dashboard. |
| **P14** | Follow-ups inteligentes | Colección `followUpTasks` + detección por job + mensajes sugeridos (NO se envían solos). |
| **P15** | Modo Ganancia del agente | Campos de producto (margen/prioridad/descuento) + reglas del agente (margen/stock-aware; conservador/equilibrado/agresivo). |
| **P16** | Auditoría del agente | Colección `agentAudits` (dónde el bot falló, FAQs faltantes, productos sin info, etc.). |
| **P17** | Simulador del agente | Colección `agentTestCases` (escenarios guardados) + correrlos antes de publicar cambios. |
| **P18** | Biblioteca de respuestas ganadoras | Colección `winningReplies` por categoría (objeción precio/envío, cierre, etc.). |
| **P19** | Onboarding rápido + plantillas por rubro | Wizard de alta + plantillas (perfumería, ropa, cosmética, restaurante, accesorios, servicios). |

---

## Detalle por módulo (adaptado a Firestore)

### P13 · Centro de Decisiones / Growth Copilot + Acciones de hoy (módulos 1 y 7)
Colección `tenants/{t}/insights/{id}`:
`type, title, description, priority, status (pending|accepted|dismissed|resolved),
relatedEntityType, relatedEntityId, estimatedImpact, recommendedAction, createdAt, resolvedAt`.
Generados por **job** con reglas: alto stock + buen margen → promo; bajo stock → reponer; muchas
vistas/pocas ventas → descuento; campañas que gastan y no venden; conversaciones donde el bot no
entendió; etc. "Acciones de hoy" = vista del dashboard que lista los `insights` y `followUpTasks`
de mayor prioridad. IA solo redacta el texto de la recomendación.

### P15 · Modo Ganancia del agente (módulo 2)
Campos opcionales en producto: `priorityScore, targetMargin, allowDiscount,
maxDiscountPercentage, aiPriorityNotes`. Reglas del agente: no recomendar sin stock; priorizar
buen margen + buen stock; no descontar bajo el margen mínimo; sugerir alternativas si no hay stock;
modo de venta **conservador / equilibrado / agresivo** configurable por el dueño. (Se integra al
`engine`/`catalog.search` ya existentes.)

### P14 · Follow-ups inteligentes (módulo 3)
Colección `tenants/{t}/followUpTasks/{id}`:
`customerId, conversationId, sellerId, type, title, suggestedMessage, priority,
status (pending|in_progress|completed|dismissed), dueAt, createdAt, completedAt`.
Job detecta: preguntó precio y no compró; pidió datos de pago sin comprobante; preguntó envío y
abandonó; compró hace tiempo (recompra); conversaciones abiertas sin respuesta; pedidos pendientes
de pago. **Solo crea tareas + mensaje sugerido — no envía nada solo.**

### P16 · Auditoría del agente (módulo 4)
Colección `tenants/{t}/agentAudits/{id}`:
`conversationId, issueType, severity, summary, recommendedFix, status, createdAt, resolvedAt`.
Detecta: bot no entendió, conversación sin venta, FAQ faltante, producto sin info suficiente,
producto recomendado sin stock, debió pasar a vendedor, objeciones frecuentes.

### P17 · Simulador del agente (módulo 5)
Colección `tenants/{t}/agentTestCases/{id}`:
`name, scenario, userMessage, expectedBehavior, lastResult, status, createdAt, updatedAt`.
Escenarios: pide descuento, producto sin stock, busca regalo, quiere barato/premium, cliente
molesto, pregunta envío, pregunta transferencia. Permite probar cambios antes de producción.

### P6-tracking · Tracking propio sin Meta (módulo 6 → fase P11)
Campos en pedidos/conversaciones/clientes/storeViews: `source, campaignId, utmSource, utmMedium,
utmCampaign, couponCode`. Links de campaña + UTM + cupones + QR. Objetivo: medir campañas aunque
Meta Ads API no esté conectada. **Preparar estos campos desde P3/P5** para acumular datos.

### P12 · Score de clientes (módulo 8)
Campo `customerScore` + `customerStatus` (Nuevo/Caliente/Comprador/Recurrente/Premium/Dormido/
Perdido). Job con reglas simples sobre: cantidad de pedidos, total gastado, última interacción,
última compra, conversaciones recientes, productos de interés. **Sin modelos complejos.**

### P18 · Biblioteca de respuestas ganadoras (módulo 9)
Colección `tenants/{t}/winningReplies/{id}` por categoría: objeción precio, objeción envío,
cliente indeciso, cierre, seguimiento, postventa, reclamo. Sirve para entrenar vendedores y
mejorar el agente.

### P19 · Onboarding rápido + plantillas por rubro (módulo 10)
Wizard de alta de empresa (datos, logo, productos, pagos, envíos, horarios, tono, FAQ, chat de
prueba, activar bot). Plantillas por rubro (perfumería, ropa, cosmética, restaurante, accesorios,
servicios), cada una con config inicial del agente + FAQ + promos sugeridas + reglas básicas.

---

## Patrón técnico (para todo el Track C)

```
Cloud Scheduler (cron) → Cloud Function (job)
   → lee Firestore (pedidos, productos, conversaciones, ...)
   → aplica REGLAS simples en JS (sin IA)
   → escribe docs en insights / followUpTasks / agentAudits / scores
La UI del panel solo LEE esos docs (barato).
IA (Haiku) opcional: redactar/explicar el texto de una recomendación ya calculada.
```
