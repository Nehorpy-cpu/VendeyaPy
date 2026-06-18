# Operación y observabilidad — AI_AFG (Fase 5)

## Health check
`GET /healthCheck` → `{ status, version, env, emulator, checks: { firestore } }`. Devuelve 200 si
Firestore responde, 503 si no. Conectalo a un uptime monitor (UptimeRobot, Cloud Monitoring uptime check).

## Audit logs (bitácora)
Acciones sensibles quedan en `tenants/{tenantId}/auditLogs/{id}` (las leen manager+; las escribe solo
Cloud Functions). Se registran:

| Acción | Dónde se origina | Actor |
|---|---|---|
| `tenant.provisioned` | callable provisionTenant | admin |
| `tenant.suspended` / `tenant.reactivated` | billing / lifecycle | sistema |
| `user.invited` / `user.role_changed` / `user.activated` / `user.deactivated` | callables de usuarios | owner/admin |
| `payment.confirmed` | confirmPayment (webhook/dev) | sistema |
| `chat.takeover` / `chat.released` | callables de handoff | vendedor/owner |
| `meta.connected` / `meta.disconnected` | conexión Meta | usuario |
| `product.created` / `product.updated` / `product.deleted` | trigger onProductWriteAudit | sistema |

Cada entrada: `{ action, actorUid, actorRole, targetType, targetId, summary, metadata, at }`.

## Errores de webhooks / alertas
Los webhooks (`metaWebhook`, `stripeWebhook`, `platformBillingWebhook`) loguean con `logger.error`
(severidad ERROR → Google Cloud Logging). Configurar una **alert policy** en Cloud Monitoring sobre
`severity=ERROR` con filtro por función para recibir avisos (email/Slack). Las firmas inválidas se
loguean como `warn` y responden 401 sin procesar.

## Métricas de uso (plan)
`tenant.usage.messagesThisMonth` se incrementa por cada inbound procesado; el gate
(`checkTenantInboundGate`) frena el bot si la empresa está suspendida o pasó el límite del plan.

## Producción ≠ demo
Los endpoints `dev*` están protegidos (Fase 2): fuera del emulador y sin `ENABLE_DEV_ENDPOINTS` +
`x-internal-secret`, responden **404**. Producción nunca usa emuladores (los hosts `*_EMULATOR_HOST`
no se setean en prod).
