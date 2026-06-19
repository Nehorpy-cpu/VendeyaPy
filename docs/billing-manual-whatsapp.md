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

## Estado — MB-2 (callables, hecho)

`functions/billing/manualActivationCallables.ts` (re-export en `index.ts`):
- **`requestManualPlanActivation`** (`resolveOwnerAdminAuth`: owner/admin; seller/manager/viewer → 403;
  owner ignora `tenantId` ajeno): valida `planId` (existe, ≠ `free`) y `method`; rechaza si ya hay una
  `pending` del tenant; crea la solicitud `pending`; **no toca** `subscription`; devuelve `requestId`,
  `status`, `whatsappText` y `whatsappData` para que el front arme el `wa.me`. audit `billing.activation_requested`.
- **`manualBillingActivate`** (**solo `PLATFORM_ADMIN`, check literal**; owner → 403): `tenantId`
  obligatorio + **verifica que el tenant existe** (no docs fantasma); soporta `requestId` (runTransaction
  `pending→approved`, idempotente) o `planId` directo; activa vía `applySubscriptionUpdate(..., {allowOverrideManual:true})`
  (`provider:'manual_whatsapp'`, `status:'active'`, `pastDueSinceMs:null`, `providerMetadata` con `source`/
  `activatedBy`/`paymentReference`/`previousProvider`). audit `billing.activation_approved`.
- **`manualBillingCancelRequest`**: admin cancela cualquiera; owner solo su propia `pending`
  (`requestedByUid===uid`); **no toca el plan**. audit `billing.activation_cancelled`.
- E2E `verify-billing-manual.mjs`: **20/20** (MB-1 guarda 6 + MB-2 callables 14).

## Pendiente

- **MB-3 (frontend, owner):** des-mockear `entitlements.ts` (leer doc tenant), UI "Solicitar por WhatsApp",
  bandeja admin (collectionGroup), `NEXT_PUBLIC_SUPPORT_WHATSAPP`.

NO se toca el código de PayPal/Stripe/Bancard (solo la guarda central en `applySubscriptionUpdate`),
OpenAI/Claude, Meta Connect ni registro/login/onboarding.
