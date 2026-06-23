# Planes, límites y entitlements — Auditoría + Matriz propuesta (PLAN-LIMITS-1)

> **Estado:** auditoría read-only (PLAN-LIMITS-1). **No** implementa cambios. Cada afirmación de
> enforcement está citada a `file:line`; los huecos fueron verificados adversarialmente (workflow).
> Clasificación de features: `available` (enforceado en backend) · `partial` (existe pero incompleto/sin
> gate) · `planned` (declarado, sin implementar) · `not_started`.

## 1. Modelo actual (cómo funciona hoy)

- **Catálogo de planes** (`plans/plans.ts` `DEFAULT_PLANS`): 5 planes → `free` ($0) · `starter` ($29) ·
  `growth` ($79) · `pro` ($199) · `enterprise` (a medida vía `limitOverrides`). Sembrados en `plans/{id}`
  (idempotente); `getPlan` rellena defaults. Tipos en `packages/shared/.../plan.types.ts`
  (`PlanLimits` × 8, `PlanFeatures` × 8).
- **Entitlements** (`entitlements/entitlements.ts`): `resolveEntitlements(tenantId)` = plan efectivo
  (degrada premium→free si el billing no está al día, ventana de gracia 7d vía `pastDueSince`) +
  `limitOverrides` (solo enterprise) + caché 30s. Gates: `checkQuota` / `assertWithinLimit`
  (`resource-exhausted`) / `assertFeatureEnabled` (`failed-precondition`) / `meterUsage` / `meterAiUsage`.
- **Usage** (`TenantUsage`): `messagesThisMonth`, `ordersThisMonth`, `adSyncsThisMonth`, `jobsThisMonth`,
  `aiTokensThisMonth`, `aiCostUsdThisMonth`. Lazy-reset mensual (`usageReset.ts`) + cron `resetUsageMonthly`.
- **Billing**: `applySubscriptionUpdate` (`billing/applySubscription.ts`) es el **único escritor** de
  `planId`/`subscription`, compartido por activación manual (admin), webhooks PayPal/Stripe/plataforma.
  Cambio de plan: **solo `PLATFORM_ADMIN`** (`manualBillingActivate`) o webhook de pago verificado; el owner
  solo **solicita** (`requestManualPlanActivation`). El front nunca cambia el plan.
- **Frontend** (`apps/web`, solo lectura aquí): `PlanGate`/`PlanComparison`/`UsageMeter`/`SubscriptionCard` +
  `lib/entitlements.ts` (espejo del catálogo). **`PlanGate` es cosmético** (lo dice explícito: "la seguridad
  real la valida el backend").

## 2. Matriz de enforcement REAL (lo verificado)

### Límites (`PlanLimits`)
| Límite | ¿Enforceado? | Dónde | Clasificación |
|---|---|---|---|
| `maxProducts` | ✅ sí (create) | `productUpsert.ts:45` `assertWithinLimit('products')` + count `products` | **available** |
| `maxUsers` | ✅ sí (create) | `userManagement.ts:30` `assertWithinLimit('users')` + count `users` | **available** |
| `maxDeliveryPersons` | ✅ sí (create) | `deliveryCallables.ts:37` + count activos | **available** |
| `maxWhatsappMessagesPerMonth` | ✅ sí (bloquea inbound) | `lifecycle.ts:39` `checkQuota('messages')` + `:46` meter | **available** |
| `maxAiTokensPerMonth` | ✅ sí | `entitlements/ai.ts:13` `assertAiBudget` (sales+internal) + `recordAiUsage` | **available** |
| `maxAdSyncsPerMonth` | ✅ sí | `panelActions.ts:41` `assertWithinLimit('adSyncs')` (vía `runTenantJob`) | **available** |
| `maxOrdersPerMonth` | ❌ **NO** | métrica muerta: 0 callers; `createPendingOrder` no gatea ni mide; `ordersThisMonth` solo se setea a 0 | **not_started** |
| `maxWhatsappNumbers` | ⚠️ parcial | `assertWhatsappNumbersEntitled` solo chequea `<1` (booleano "incluye WhatsApp"); el **conteo** por plan (starter=1/growth=3/pro=10) **no** se enforcea; `connectFlow` persiste TODOS los números descubiertos | **partial** |

### Features (`PlanFeatures`)
| Feature | ¿Gateada? | Dónde | Clasificación |
|---|---|---|---|
| `aiAssistant` | ✅ sí | `ai.ts:12` `assertFeatureEnabled('aiAssistant')` | **available** |
| `marketingAutomation` | ✅ sí | `panelActions.ts:40` vía `JOB_REQUIREMENTS` (ads/atribución/catálogo/conversiones) | **available** |
| `bancard` | ❌ **NO** | sin `assertFeatureEnabled`; `createPendingOrder` hardcodea `method:'BANCARD'` | **not_started** (gate) |
| `stripe` | ❌ **NO** | `stripeWebhook` solo valida firma+idempotencia; checkout sin gate de feature | **not_started** (gate) |
| `localWallets` | ❌ **NO** | sin gate | **not_started** (gate) |
| `electronicInvoicing` | ❌ **NO** | flag declarado; campo `invoice`/paths existen pero sin gate ni integración real | **planned** |
| `multiChannel` | ⚠️ parcial | el engine es channel-agnostic (IG/FB/WA) y funciona, pero **sin** gate de feature | **partial** |
| `prioritySupport` | ❌ N/A código | tier de soporte humano; sin punto de enforcement en código | **not_started** (operativo) |

**Conclusión:** `assertFeatureEnabled` solo gatea `aiAssistant` y `marketingAutomation`. Las 6 features de
pago/premium restantes están declaradas pero **no enforceadas**.

## 3. Propiedades de seguridad VERIFICADAS (no son huecos)

- **El frontend/cliente NO puede saltarse límites de plan.** `firestore.rules:138-140` prohíbe escritura
  cliente de `planId/limits/limitOverrides/usage/subscription/status/...`; `products`/`deliveryPersons`/`users`
  tienen `write:if false` (solo Admin SDK) y se crean por callables **gateados** (`assertWithinLimit` antes
  del write). Default-deny cierra el resto.
- **Ninguna función costosa de prod queda sin gate.** Bot real (`onWebhookInbox` → `checkTenantInboundGate`
  messages + `assertAiBudget`), asistente interno (`assertAiBudget`), jobs Meta/marketing (solo vía
  `runTenantJob` gateado), y los 19 `dev*` → **404 en prod** (`guardDevEndpoint`).
- **AI 100% medido.** `salesAgent` + `internalAssistant` ambos `assertAiBudget` antes y `recordAiUsage`
  después; auditoría `aiRequests` (tokens/costo/modelo). *Detalle:* el gate usa una **estimación** (~1500 tok)
  antes; el real se registra después → un turno cerca del tope puede sobrepasar levemente (corregible).

## 4. Huecos peligrosos (priorizados)

| # | Hueco | Riesgo | Severidad |
|---|---|---|---|
| H1 | **`maxOrdersPerMonth` muerto** (sin medir ni gatear) | un tenant crea órdenes ilimitadas; límite comercial inexistente | **alta** (comercial) |
| H2 | **Features de pago sin gate** (`bancard`/`stripe`/`localWallets`/`electronicInvoicing`) | un plan bajo/free usa medios de pago/facturación "premium" → fuga de valor | **alta** (comercial) |
| H3 | **`maxWhatsappNumbers` sin conteo** | multi-número se persiste sin tope por plan | **media** (hoy 1 número soportado; sube si se habilita multi-número) |
| H4 | **`multiChannel` sin gate** | IG/FB usable sin estar en el plan | **media** |
| H5 | **AI budget por estimación** | leve overshoot del tope de tokens | **baja** |
| H6 | **Catálogo front espejo** (`apps/web/lib/entitlements.ts`) puede driftar del backend | UI muestra/oculta mal (no es bypass; backend es la verdad) | **baja** |
| H7 | **`messages`: confirmar in vs in+out** | si solo cuenta inbound, el costo real (out a Meta) se subestima | **baja** (verificar en L2) |

> *Overrides admin:* `limitOverrides` ya existe (solo enterprise, solo con premium). No hay hueco ahí; falta
> exponerlo en el flujo admin para los planes a medida (PLAN-LIMITS-4).

## 5. Matriz de planes propuesta (Básico / Pro / Max / Enterprise)

**Decisión de diseño pendiente de tu OK:** hoy el registro crea tenants en `free` (default). Recomiendo
**conservar `free` como trial/entrada** (no comercial) y mapear los 4 nombres comerciales sobre los tiers
pagos actuales, para no romper registro/onboarding:

| Comercial | Tier actual | Precio ref. | aiAssistant | marketing | pagos premium | multiCanal | Productos | Mensajes/mes | AI tok/mes | Números WA | Repartidores | Usuarios |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| *(Trial)* `free` | FREE | $0 | ❌ | ❌ | ❌ | ❌ | 20 | 500 | 0 | 1 | 2 | 2 |
| **Básico** | STARTER | $29 | ✅ | ❌ | ✅ básicos | ❌ | 200 | 5.000 | 50k | 1 | 10 | 5 |
| **Pro** | GROWTH | $79 | ✅ | ✅ | ✅ | ✅ | 1.000 | 20.000 | 250k | 3 | 50 | 15 |
| **Max** | PRO | $199 | ✅ | ✅ + priority | ✅ + e-invoicing | ✅ | 10.000 | 100.000 | 1M | 10 | 200 | 50 |
| **Enterprise** | ENTERPRISE | a medida | ✅ | ✅ | ✅ | ✅ | ∞ (overrides) | ∞ | ∞ | ∞ | ∞ | ∞ |

Para **cada plan** se define (resumen; detalle por plan en PLAN-LIMITS-2):
- **features disponibles** → las de la fila (todo lo que esté `available`/se vuelva `available` en L3).
- **límites técnicos** → los de la fila (los 8 `PlanLimits`).
- **riesgo/costo operativo** → el costo variable está en **IA** (tokens × $1/$5 por 1M) y **WhatsApp** (envío
  Meta). Por eso `maxAiTokensPerMonth` y `maxWhatsappMessagesPerMonth` son los topes que protegen el margen;
  ambos ya enforceados. Órdenes/productos/usuarios son límites comerciales (bajo costo de infra).
- **gates backend necesarios** → ver §6 (los faltantes para que la fila sea real).
- **textos/estado frontend** → `PlanGate` con CTA de upgrade por feature; `UsageMeter` por `messages`/`aiTokens`
  (y `orders` cuando se mida); etiqueta de plan + estado de billing (`SubscriptionCard`).

> Nota: los nombres comerciales (Básico/Pro/Max) **no** tienen que cambiar los `id` internos
> (`starter/growth/pro`) para no romper billing/webhooks; basta mapear `name`/`tier` y la UI. Esa decisión
> (renombrar id vs solo `name`) se cierra en PLAN-LIMITS-2.

## 6. Gates faltantes (qué hay que implementar para que la matriz sea real)

| Gate faltante | Dónde iría | Cierra |
|---|---|---|
| `assertWithinLimit('orders')` + `meterUsage('orders')` | antes/después de `createPendingOrder` (`engine.ts` rama "pagar") | H1 |
| `assertFeatureEnabled('stripe'/'bancard'/'localWallets')` | al habilitar/usar el medio de pago (`checkoutConfigUpdate` y/o creación de sesión de cobro) | H2 |
| `assertFeatureEnabled('electronicInvoicing')` | en el punto de emisión de factura (cuando se construya la integración) | H2/E-inv |
| `assertFeatureEnabled('multiChannel')` | en el ruteo de canal no-WhatsApp (IG/FB) del webhook/engine | H4 |
| `maxWhatsappNumbers` como **count metric** (o conteo en `connectFlow`) | añadir `whatsappNumbers` a `QuotaMetric`/`COUNT_FN` y chequear en connect | H3 |
| Confirmar conteo `messages` in/out | `lifecycle.ts` / `recordMessage` | H7 |

## 7. Orden de implementación recomendado

1. **PLAN-LIMITS-2 — backend/shared (modelo):** congelar la matriz §5 en `plans.ts` + `plan.types.ts`
   (nombres comerciales, valores de límites), añadir `whatsappNumbers` como métrica, wirear `orders`
   (campo→metric). Sin gates nuevos todavía. Tests de catálogo.
2. **PLAN-LIMITS-3 — gates faltantes (§6):** órdenes, features de pago/facturación, multiCanal,
   conteo de números WA. Cada uno con su error controlado + auditoría de bloqueo (`auditBlock`) ya existente.
3. **PLAN-LIMITS-4 — frontend:** alinear `lib/entitlements.ts` (espejo) + `PlanComparison`/`PlanGate`/
   `UsageMeter` a la matriz; estados/textos por plan; exponer overrides admin (enterprise).
4. **PLAN-LIMITS-5 — e2e por plan:** `verify-plan-limits.mjs` (matriz por plan: cada límite/feature bloquea
   en el plan que no lo incluye y permite en el que sí; fake client para IA; cero red), + regresiones.

**Estado:** PLAN-LIMITS-1 cerrado (auditoría + esta matriz). Nada implementado. Esperando aprobación de la
matriz y de PLAN-LIMITS-2.
