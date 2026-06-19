# Billing multi-proveedor — Stripe + PayPal (Fase 5B)

La SUSCRIPCIÓN del SaaS se cobra a la cuenta de la **plataforma** (no del tenant). El **plan
efectivo nunca lo decide el frontend**: se actualiza por backend tras el webhook/verificación del
proveedor. Toda la capa de entitlements/gracia/`effectivePlanId` (Fase 5A/5B-i) es **agnóstica
del proveedor** y se reutiliza completa.

## Pipeline común (agnóstico del proveedor)

`SubscriptionUpdate` (normalizado) ← deriver por proveedor → **`applySubscriptionUpdate(tenantId, update)`**:
escribe `tenant.subscription` (refs genéricas `external*` + legacy `stripe*` si aplica),
`tenant.planId`, `tenant.limits` (caché denormalizada) e **invalida entitlements**. **No** suspende
la cuenta. Lo usan el webhook Stripe (5B-i) y el de PayPal (5B-ii).

### Modelo de `tenant.subscription`

- `paymentProvider: 'manual' | 'stripe' | 'paypal' | 'bancard'`.
- `externalCustomerId`, `externalSubscriptionId`, `externalPlanRef` (priceId/plan_id), `providerMetadata`.
- Legacy Stripe: `stripeCustomerId`, `stripeSubscriptionId` (se mantienen para datos Stripe).
- `status`, `currentPeriodEnd`, `pastDueSince` (gracia 7 días).

### Regla de proveedor para datos legacy (`resolvePaymentProvider`)

1. si existe `paymentProvider`, usarlo;
2. si no, y hay `stripeSubscriptionId`/`stripeCustomerId` → `'stripe'`;
3. si no hay billing externo → `'manual'`.

## PayPal Subscriptions (5B-ii)

Capa **inyectable** `PlatformBillingProvider` → `PayPalBillingProvider` (real) / `FakePayPalBillingProvider`
(emulador/tests, nunca llama a PayPal). `getPayPalProvider()` elige según `FUNCTIONS_EMULATOR`.

- **`createPayPalSubscriptionSession({ tenantId?, planId })`** (owner/admin): resuelve el PayPal
  plan id server-side (`PLAN_TO_PAYPAL_PLAN`), crea la suscripción (`custom_id = tenantId`) y
  devuelve **solo `{ approvalUrl }`**. Estado provisional `incomplete` (no activa el plan).
- **`syncPayPalSubscription({ tenantId? })`** (owner/admin): consulta PayPal y reconcilia.
- **`paypalBillingWebhook`**: verifica la firma con el **método oficial** de PayPal
  (`POST /v1/notifications/verify-webhook-signature` + `PAYPAL_WEBHOOK_ID`); idempotente por
  `event.id` (doc `paypal_{id}` en `platformBillingEvents`); enlaza la suscripción al tenant por
  `custom_id` y, si falta, por `externalSubscriptionId`; si no resuelve el tenant → **no aplica
  cambios** (warning seguro). Mapea el plan desde el `plan_id` confirmado por PayPal (`PAYPAL_PLAN_TO_PLAN`).

### Mapeo de estados PayPal → interno

| PayPal | Interno |
|---|---|
| `ACTIVE` / `PAYMENT.SALE.COMPLETED` / `ACTIVATED` | `active` |
| `APPROVAL_PENDING` / `APPROVED` / `CREATED` | `incomplete` |
| `SUSPENDED` / `PAYMENT.FAILED` | `past_due` (gracia 7 días) |
| `CANCELLED` / `EXPIRED` | `canceled` |

`canceled`/`past_due` vencido → premium suspendido, **datos y acceso básico preservados**, cuenta `ACTIVE`.

## Tarjetas

PayPal muestra **PayPal wallet + métodos elegibles** (incluida tarjeta) según **país / cuenta /
configuración**; **no asumir** que la tarjeta directa siempre está disponible. La integración
frontend futura usará **PayPal JS SDK / Buttons** (`createSubscription`/`onApprove`) o la **approval
URL** del flujo server-side (fuera de esta fase).

## Seguridad

- `PAYPAL_CLIENT_SECRET` solo en env/secret de Functions; **nunca** en Firestore ni en logs. Access
  token cacheado en memoria del provider, nunca logueado. No se loguean firma ni payloads sensibles.
- Webhook **verificado** (método oficial + `PAYPAL_WEBHOOK_ID`) + **idempotente**. Firma inválida → 401.
- Callables **owner/admin only** (`resolveOwnerAdminAuth`, compartido con Meta). Nunca SELLER/MANAGER/VIEWER.
- El plan efectivo **nunca** se activa desde el frontend (solo webhook/`sync` confirmado por PayPal).
- El dinero va a la cuenta **PayPal Business de la plataforma**; **no** se usan cuentas de tenants.

## Variables (Functions)

`PAYPAL_ENV` (sandbox/live), `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`,
`PAYPAL_RETURN_URL`, `PAYPAL_CANCEL_URL`, `PAYPAL_PLAN_TO_PLAN`, `PLAN_TO_PAYPAL_PLAN`.
(Stripe sigue con `STRIPE_PRICE_TO_PLAN` + `PLATFORM_BILLING_WEBHOOK_SECRET`/`STRIPE_WEBHOOK_SECRET`.)

> Los PayPal **products/plans** se asumen creados en el PayPal Dashboard y mapeados por env (no se
> crean automáticamente en esta fase).

## Fuera de 5B-ii

Frontend PayPal Buttons/JS SDK · Bancard · Stripe Checkout/Portal · dunning/emails · facturación
fiscal · cobro por uso medido · creación automatizada de PayPal products/plans.
