# Billing manual por WhatsApp — contrato (MVP)

Activación manual de planes: el **TENANT_OWNER** elige un plan y solicita activación por WhatsApp
(mensaje prellenado), paga manual (transferencia/depósito/giro), y el **PLATFORM_ADMIN** activa el
plan tras confirmar el pago. El owner **NO** puede auto-activar. PayPal/Stripe/Bancard quedan intactos
como proveedores opcionales/futuros.

## Decisiones fijadas

1. **Vigencia: renovación 100% manual.** El plan manual queda `active` hasta que el admin lo cambie/cancele
   (sin job de vencimiento — MB-4 fuera de alcance).
2. **Guarda de precedencia** centralizada en `applySubscriptionUpdate` (`opts.allowOverrideManual`, default
   `false`): si la suscripción vigente es `manual_whatsapp`, los updates externos (webhooks Stripe/PayPal,
   `syncPayPalSubscription`) **se omiten**; solo el flujo admin manual (`true`) puede pisar.
3. **Número WhatsApp** desde `NEXT_PUBLIC_SUPPORT_WHATSAPP` (E.164; el front lo pasa a solo dígitos para `wa.me`).
4. **Cancelación**: el owner cancela solo su solicitud `pending`; el admin cancela cualquiera.

## Arquitectura (reuso, no reinvención)

- El billing del SaaS vive **embebido en `tenant.subscription`** (no hay colección de subscriptions del SaaS).
  El plan NO está en custom claims → tras activar (Admin SDK escribe el doc), el owner ve el plan sin re-login.
- **Único writer**: `applySubscriptionUpdate(tenantId, update, opts?)` (`billing/applySubscription.ts`). Manual
  lo reusa con `{ provider:'manual_whatsapp', status:'active', planId }` + `allowOverrideManual:true`.
- `effectivePlanId`/posture/limits son **derivados en lectura** (`entitlements.ts`/`decide.ts`).

## Estado — MB-1 (fundaciones, hecho)

- Enum `PaymentProvider`: agregado **`manual_whatsapp`** (distinto del legacy `manual`).
- Enums `MANUAL_ACTIVATION_STATUS` (`pending|approved|cancelled`) y `MANUAL_PAYMENT_METHOD`
  (`transferencia|deposito|giro`) + tipo `ManualActivationRequest` (`packages/shared`).
- AuditActions: `billing.activation_requested`, `billing.activation_approved`, `billing.activation_cancelled`.
- **Guarda de precedencia** en `applySubscriptionUpdate` (`opts.allowOverrideManual`; retorna
  `{ applied, skipped?:'manual_override' }`; registra `providerMetadata.previousProvider` al pisar otro
  proveedor). Aditiva: los callers existentes (webhooks/sync) no cambian y se auto-omiten ante `manual_whatsapp`.
- Rules: `tenants/{t}/manualActivationRequests/{id}` (read owner/admin, **write:false**) + match
  collectionGroup para la bandeja del Super Admin. Índice collectionGroup en `firestore.indexes.json`.
- E2E `verify-billing-manual.mjs` (guarda): 6/6.

## Pendiente

- **MB-2 (callables):** `requestManualPlanActivation` (owner/admin, crea `pending` + prefill WhatsApp),
  `manualBillingActivate` (**PLATFORM_ADMIN literal**, `runTransaction` `pending→approved` →
  `applySubscriptionUpdate(..., { allowOverrideManual:true })`, verifica que el tenant existe → no docs
  fantasma), `manualBillingCancelRequest` (owner su propia `pending` + admin cualquiera). + `verify-billing-manual.mjs` ampliado.
- **MB-3 (frontend, owner):** des-mockear `entitlements.ts` (leer doc tenant), UI "Solicitar por WhatsApp",
  bandeja admin (collectionGroup), `NEXT_PUBLIC_SUPPORT_WHATSAPP`.

NO se toca el código de PayPal/Stripe/Bancard (solo la guarda central en `applySubscriptionUpdate`),
OpenAI/Claude, Meta Connect ni registro/login/onboarding.
