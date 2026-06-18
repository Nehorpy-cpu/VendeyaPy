# Integraciones reales — AI_AFG (Fase 3)

Las integraciones se construyen como **adapters con fallback a demo**: sin credenciales
(o en el emulador) usan un mock y la demo sigue intacta; con credenciales reales se
activan solas. Nada de esto rompe el flujo actual.

## 1. WhatsApp Cloud API (envío de respuestas)

El bot ya calcula la respuesta; ahora se **entrega** vía `messaging/whatsappClient.ts`.

- **Emulador / sin credenciales** → `MockWhatsAppClient` (sólo loguea, no llama a Meta).
- **Producción** → `CloudAPIClient` (POST a `graph.facebook.com/{phoneNumberId}/messages`).

Variables: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` (luego, por tenant vía SecretStore).

## 2. Pagos — Stripe (webhook firmado e idempotente)

`stripeWebhook` (`functions/payments/stripeWebhook.ts`):
1. Verifica `Stripe-Signature` sobre el **raw body** (`payments/stripeSignature.ts`, HMAC-SHA256 + tolerancia anti-replay).
2. **Idempotente**: `claimEventOnce` (create() atómico) descarta reintentos/duplicados por `event.id`.
3. Confirma la orden con `confirmPayment` (ya idempotente → registra el evento `Purchase`).

Para vincular el pago con la orden, al crear la sesión de pago de Stripe hay que setear
`metadata: { tenantId, orderId }` (lo lee el webhook). Eventos relevantes:
`checkout.session.completed`, `payment_intent.succeeded`.

Variables: `STRIPE_WEBHOOK_SECRET` (sin esto el webhook responde **401**, fail-closed),
`STRIPE_SECRET_KEY` (para crear sesiones de pago, cuando se implemente el link).

> Bancard se implementa después con el MISMO patrón (firma → idempotente → confirmPayment).
> `verifyBancardSignature` (en `middleware/webhookSignature.ts`) queda como TODO hasta tener specs.

## 3. Meta OAuth — token por referencia

`meta/oauth.ts` (`connectMetaReal`): intercambia el `code` del Embedded Signup por el token
y lo guarda con `SecretStore` → sólo la **referencia** (`secret://...`) va a `MetaConnection.tokenSecretRef`.
El token NUNCA se guarda en claro.

`lib/secretStore.ts` (`FirestoreSecretStore`): cifra con AES-256-GCM (`lib/crypto`) en la
colección global `secrets` (Admin SDK only). Punto de extensión a **Google Secret Manager**
bajo `USE_SECRET_MANAGER` sin tocar a los que llaman.

Variables: `META_APP_ID`, `META_APP_SECRET`, `META_OAUTH_REDIRECT_URI`. Requiere Meta
habilitado (App Review/verificación — ADR-0010). En demo se usa `connectMetaDemo`.

## Resumen de variables (Functions, staging/prod → Secret Manager)

| Variable | Integración |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` | WhatsApp Cloud API (envío) |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` | Webhook Meta (Fase 2) |
| `STRIPE_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY` | Pagos Stripe |
| `META_APP_ID`, `META_APP_SECRET`, `META_OAUTH_REDIRECT_URI` | Meta OAuth |
| `TENANT_SECRETS_ENCRYPTION_KEY` | Cifrado de SecretStore |

El `.env.example` consolidado y el cableado a Secret Manager se completan en la Fase 5 (deploy).
