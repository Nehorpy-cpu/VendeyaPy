# Planes, límites y entitlements (Fase 5A)

La **fuente de verdad** de los límites efectivos es `plans/{planId}` + `tenant.limitOverrides`,
resuelta por `entitlements/resolveEntitlements(tenantId)`. `tenant.limits` queda como **caché
denormalizada** (lectura rápida/rules), no como fuente.

## Tres dimensiones ortogonales (cada acción sensible valida las 4 en backend)

| Dimensión | Fuente | Dónde |
|---|---|---|
| **Rol** (RBAC) | custom claims `{role, tenantId}` | `firestore.rules` + authz de callables |
| **Plan / entitlements** | `plan.limits/features` + `limitOverrides` | `entitlements/` |
| **Billing** | `tenant.subscription.status` → `billingPosture` | `entitlements/` |
| **Cuota / uso** | `tenant.usage.*` + `count()` | `entitlements/checkQuota` |

> **Regla:** el frontend solo muestra/oculta opciones; **nunca decide seguridad**. Toda escritura
> sensible valida en backend rol + plan + billing + cuota. Los campos de entitlements/billing del
> tenant (`planId`, `limits`, `limitOverrides`, `usage`, `subscription`, `status`, `isDemo`) **no
> son escribibles por el cliente** (solo Admin SDK) — ver `firestore.rules`.

## Roles

| Rol | Puede | NO puede |
|---|---|---|
| **SELLER** | chats, pedidos/clientes permitidos | billing, usuarios, integraciones, secretos, config crítica |
| **TENANT_MANAGER** | catálogo, campañas, promos, followups, conversaciones | billing, plan, secretos, conexión Meta/WhatsApp crítica |
| **TENANT_OWNER** | configura su empresa, usuarios, agente, integraciones y billing | exceder lo que permite su **plan** |
| **PLATFORM_ADMIN** | operar/soportar cualquier tenant, ver datos para soporte | — (toda acción sensible se **audita**) |

## Matriz de planes

| | Free/Demo | Starter ($29) | Growth ($79) | Pro ($199) | Enterprise |
|---|---|---|---|---|---|
| WhatsApp msgs/mes | 500 | 5.000 | 20.000 | 100.000 | ∞ / override |
| Productos | 20 | 200 | 1.000 | 10.000 | ∞ / override |
| Pedidos/mes | 50 | 500 | 2.000 | 20.000 | ∞ / override |
| Usuarios | 2 | 5 | 15 | 50 | ∞ / override |
| Números WhatsApp | 1 | 1 | 3 | 10 | ∞ / override |
| Repartidores | 2 | 10 | 50 | 200 | ∞ / override |
| Ad syncs/mes | 0 | 0 | 30 | 300 | ∞ / override |
| Tokens IA/mes | 0 | 50.000 | 250.000 | 1.000.000 | ∞ / override |
| Pasarelas (bancard/stripe/wallets) | ❌ | ✅ | ✅ | ✅ | ✅ |
| Multicanal (IG/Messenger) | ❌ | ✅ | ✅ | ✅ | ✅ |
| Facturación electrónica | ❌ | ❌ | ✅ | ✅ | ✅ |
| Marketing/automation | ❌ | ❌ | ✅ | ✅ | ✅ |
| Asistente IA (`aiAssistant`) | ❌ | ✅ | ✅ | ✅ | ✅ |
| Soporte prioritario | ❌ | ❌ | ❌ | ✅ | ✅ |

- **Demo:** `tenant.isDemo:true` (no facturable; no se suspende por billing).
- **Enterprise:** límites a medida vía `tenant.limitOverrides` (solo Admin SDK).
- `UNLIMITED = 1e9` (evita comparaciones con Infinity en Firestore).

## Modelo de entitlements (`entitlements/`)

- **`resolveEntitlements(tenantId)`** → `{ planId, tier, subscriptionStatus, isDemo, limits, features, posture }`
  (límites efectivos = plan + overrides; caché por tenant TTL 30s; `invalidateEntitlements`).
- **`checkQuota(tenantId, metric, delta)`** → `{ allowed, reason, used, limit }` (lazy-reset previo;
  `messages/orders/adSyncs/aiTokens` por contador mensual; `products/users` por `count()`).
- **`assertWithinLimit` / `assertFeatureEnabled` / `assertWhatsappNumbersEntitled`** → lanzan
  `HttpsError` (`resource-exhausted` / `failed-precondition`) y **auditan** el bloqueo
  (`entitlement.blocked`).
- **`meterUsage` / `meterAiUsage`** → incrementan contadores mensuales (con lazy-reset).
- **`billingPosture(status, isDemo, { nowMs, pastDueSinceMs })`** (5B): `active/trialing/none/demo`
  → opera + premium; `past_due` **dentro** de la gracia (7 días desde `pastDueSince`) → premium ✅;
  `past_due` **vencido** / `canceled` / `incomplete` → premium ❌; **siempre** `operational` (la
  cuenta nunca se suspende por billing — datos preservados). Sin `pastDueSince` (5A) → premium ❌.

### Plan seleccionado vs efectivo (5B)

- **`selectedPlanId`** (= `tenant.planId`): último plan elegido, para UX/renovación.
- **`effectivePlanId`**: `selectedPlanId` si el billing permite premium; **`free`** si no
  (`canceled`/`unpaid`/`past_due` vencido). `resolveEntitlements` deriva **límites y features del
  plan EFECTIVO** → un tenant `canceled` con `planId=growth` **NO** conserva cuotas/features premium
  (baja a free); conserva acceso básico y datos. `premiumSuspended` marca esta degradación (y da el
  mensaje de "pago pendiente" en los gates). Los `limitOverrides` (Enterprise) solo aplican con
  premium habilitado.

## Métricas de uso

| Métrica | Tipo | Límite |
|---|---|---|
| Mensajes WhatsApp | mensual (reset) | `maxWhatsappMessagesPerMonth` |
| Pedidos | mensual (reset) | `maxOrdersPerMonth` |
| Jobs | mensual (reset) | (metering; gate por feature) |
| Ad syncs | mensual (reset) | `maxAdSyncsPerMonth` + feature `marketingAutomation` |
| Tokens IA / costo | mensual (reset) | `maxAiTokensPerMonth` (scaffold, sin OpenAI) |
| Productos | point-in-time `count()` | `maxProducts` |
| Usuarios | point-in-time `count()` | `maxUsers` |
| Números WhatsApp | point-in-time | `maxWhatsappNumbers` |

**Reset:** `shouldResetUsage` (cambio de mes calendario UTC) + `maybeResetUsage` (lazy, en
transacción, lo invocan los gates/metering) + `resetUsageMonthly` (job programado, red de seguridad).

## Puntos de gate (backend)

| Entry point | Gate |
|---|---|
| Inbound WhatsApp (`meta/process.ts`) | suspensión + `checkQuota('messages')` + `meterUsage('messages')` |
| `runTenantJob` | feature premium (marketing) + `assertWithinLimit('adSyncs')` (metaAdsSync) + `meterUsage('jobs'/'adSyncs')` |
| `inviteUser` | `assertWithinLimit('users')` |
| `connectMeta` / `selectMetaPhoneNumber` | `assertWhatsappNumbersEntitled` |
| `productUpsert` (callable preparado) | `assertWithinLimit('products')` al crear |
| IA (futuro) | `assertAiBudget` + `recordAiUsage` (scaffold) |

## Billing: Stripe price→plan + gracia (Fase 5B-i)

El webhook `platformBillingWebhook` (firmado + idempotente, ya existente) ahora **sincroniza el
plan desde el Price ID** confirmado por Stripe (el frontend nunca decide el plan):
- **`STRIPE_PRICE_TO_PLAN`** (env JSON `{priceId: planId}`) + `planIdForPrice` (puro). Opcional:
  `plans/{id}.stripePriceId` solo como referencia/display.
- **`deriveSubscriptionUpdate`** (puro) calcula desde `customer.subscription.*`:
  `status`, `planId` (del precio; `null`=no cambia), `currentPeriodEnd`, `stripeCustomerId/SubscriptionId`,
  y **`pastDueSince`** (se setea al entrar en `past_due`, se limpia al volver a activo → base de la gracia).
- El webhook escribe `tenant.subscription.{status, planId, currentPeriodEnd, stripeCustomerId,
  stripeSubscriptionId, pastDueSince}` + `tenant.planId` + `tenant.limits` (caché denormalizada del
  plan **seleccionado**) e **invalida** los entitlements. **No** suspende la cuenta.
- **Estados:** `trialing`/`active` → premium; `past_due` → gracia 7 días (premium hasta el corte);
  `canceled`/`unpaid`/`incomplete`/`past_due` vencido → premium suspendido, **datos y acceso básico
  preservados** (`tenant.status` sigue `ACTIVE`).

> Verificado en `verify-fase5b-billing` (9/9): sync, idempotencia, firma 401, gracia, vencimiento,
> canceled (cuenta ACTIVE) y recuperación.

### Contrato preparado para 5B-ii (no implementado en 5B-i)

`createCheckoutSession`, `createBillingPortalSession`, `syncTenantSubscription` — con `StripeClient`
**inyectable** (SDK real en prod, fake en tests) y authz `resolveOwnerAdminAuth` (solo OWNER/ADMIN).

## Fuera de 5B-i (próximas sub-fases)

- **5B-ii:** `createCheckoutSession` / `createBillingPortalSession` / `syncTenantSubscription` con
  Stripe SDK (Billing APIs + Checkout para suscripciones, Billing Portal para self-service).
- **5C:** migración del panel del write directo de productos al callable `productUpsert` (hasta
  entonces el write directo sigue activo → **no considerar el control de productos "seguro"** aún).
- Frontend de planes, OpenAI real, Stripe productivo, dunning/emails, facturación fiscal, deploy.
