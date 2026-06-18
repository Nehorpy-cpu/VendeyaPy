# Seguridad de endpoints — AI_AFG (Fase 2)

Clasificación de las Cloud Functions y cómo se protegen. Objetivo: que **ningún
endpoint de desarrollo quede expuesto en producción** y que el webhook de Meta
**verifique firma real**.

## Endpoints REALES (quedan en producción)

| Función | Tipo | Control de acceso |
|---|---|---|
| `healthCheck` | HTTP público | Sin datos sensibles; solo estado. |
| `metaWebhook` | Webhook Meta | GET: `hub.verify_token` = `WHATSAPP_WEBHOOK_VERIFY_TOKEN` (por entorno). POST: **firma `X-Hub-Signature-256` obligatoria** (HMAC-SHA256 con `WHATSAPP_APP_SECRET`). Fuera del emulador es *fail-closed*: sin secreto o firma inválida → 401. |
| `chatTakeover`, `chatRelease` | Callable (auth) | `assertStaff`: usuario autenticado + pertenece al tenant (o `PLATFORM_ADMIN`) + rol staff. |
| `onOrderWriteStats`, `onWebhookInbox` | Triggers Firestore | Sin superficie HTTP. |

## Endpoints DEV / simuladores (excluidos de producción)

Todos pasan por `guardDevEndpoint` (ver `src/middleware/devGuard.ts`):

- **Simuladores de flujos reales:** `devMessage`, `devConfirmPayment`, `devSubmitComprobante`,
  `devTakeoverChat`, `devReleaseChat`, `devMetaConnect`, `devMetaDisconnect`, `devSimulateInbound`.
- **Jobs internos (en prod serán Cloud Scheduler / triggers):** `devRecomputeStats`,
  `devRecomputeScores`, `devGenerateSuggestions`, `devGenerateInsights`, `devGenerateFollowups`,
  `devGenerateAudits`, `devGenerateWinningReplies`, `devSyncMetaAds`, `devSyncCatalogToMeta`,
  `devComputeAttribution`, `devProcessConversions`, `devComputeTracking`.

### Política del guard
1. **Emulador** (`FUNCTIONS_EMULATOR=true`): permitido siempre → la demo local, los seeds y
   los `verify-*.mjs` no cambian.
2. **No-emulador**: permitido sólo si `ENABLE_DEV_ENDPOINTS=true` **y** el header
   `x-internal-secret` coincide con `DEV_ENDPOINTS_SECRET` (uso controlado en staging/demo online).
3. **Producción** (sin lo anterior): **404**. No se revela ni la existencia del endpoint.

> Consecuencia: en una eventual demo online, las features del panel que hoy disparan jobs
> `dev*` necesitarán su disparador real (Cloud Scheduler / callables) — eso se aborda al
> conectar integraciones reales (Fase 3) y el deploy (Fase 5). En la demo por emulador todo
> sigue funcionando.

## Variables de entorno relevantes (Functions)

| Variable | Para qué | Dónde |
|---|---|---|
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Handshake GET del webhook Meta | staging/prod (Secret Manager) |
| `WHATSAPP_APP_SECRET` | Verificación de firma del webhook | staging/prod (Secret Manager) |
| `ENABLE_DEV_ENDPOINTS` | Habilita `dev*` fuera del emulador (solo staging/demo) | staging |
| `DEV_ENDPOINTS_SECRET` | Secreto del header `x-internal-secret` para `dev*` | staging |

El `.env.example` completo se arma en la Fase 5 (deploy/observabilidad). En el emulador no hace
falta setear nada de esto.
