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
| `maxOrdersPerMonth` | ⚠️ **medido** (L2), sin gate | `engine.ts` `meterUsage('orders')` tras `createPendingOrder` (no bloqueante); gate `assertWithinLimit('orders')` = **L3** | **partial** |
| `maxWhatsappNumbers` | ⚠️ parcial | gate booleano `≥1` (`assertWhatsappNumbersEntitled`); **L2** cableó `whatsappNumbers` al modelo de métricas (`QuotaMetric`+`COUNT_FN`); el gate de **conteo** = **L3** | **partial** |

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
| *(Trial 7d)* `free` | FREE | $0 | ❌ | ❌ | ❌ | ❌ | 20 | 50 | 0 | 1 | 1 | 2 |  ⟵ FREE-TRIAL (§13)
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

## 8. PLAN-LIMITS-2 — cambios aplicados (modelo congelado, sin gates nuevos)

Solo backend/shared/docs/tests. **No** se añadieron gates de bloqueo (eso es L3). IDs internos sin cambiar.

- **Catálogo (`plans/plans.ts`):** `name` comercial → `free`="Prueba gratis" · `starter`="Básico" ·
  `growth`="Pro" · `pro`="Max" · `enterprise`="Enterprise". `description` comerciales. Nuevo campo
  `pricePygPerMonth` (₲, fuente de verdad comercial): 0 / **150.000** / **350.000** / **650.000** / 0.
  `priceUsdPerMonth` se **deja intacto** ($29/79/199) → billing-manual y frontend no cambian de comportamiento
  (lo leen). **LÍMITES sin cambios.**
- **Features honestas:** solo se prenden las **realmente enforceadas** → `aiAssistant` (Básico+),
  `marketingAutomation` (Pro+, modo demo gateado). Las de pago/facturación/multicanal/priority
  (`bancard`/`stripe`/`localWallets`/`electronicInvoicing`/`multiChannel`/`prioritySupport`) quedan en
  **`false` en todos los planes** (no se venden como disponibles hasta que L3 implemente sus gates). Cambio
  **inerte** en backend (nada gatea esas features) y el frontend usa su propio espejo (`apps/web/lib/entitlements.ts`).
- **Métricas cableadas al modelo:** `whatsappNumbers` agregado a `QuotaMetric`/`CountMetric`/`QUOTA_LIMIT`/
  `COUNT_FN` (conteo de assets WA). `orders` ahora **se mide** (`meterUsage('orders')` no bloqueante en el
  pago del bot). **Ningún gate de bloqueo** para ninguno de los dos (L3).
- **`applySubscriptionUpdate`** intacto (sigue siendo el path canónico). Billing manual / webhooks **sin tocar**.
- **Tests:** `plans.test.ts` congela ids/nombres/precios/features. Suite 217/217.

### Pendiente para PLAN-LIMITS-3 (gates de bloqueo)
`assertWithinLimit('orders')` en el pago · gate de **conteo** `whatsappNumbers` en el connect ·
`assertFeatureEnabled('stripe'/'bancard'/'localWallets'/'electronicInvoicing'/'multiChannel')` en checkout/
pagos/facturación/canal (y prender esas features en los planes cuando su gate exista) · confirmar conteo
`messages` in/out. Frontend (espejo + textos por plan) = PLAN-LIMITS-4. E2E por plan = PLAN-LIMITS-5.

## 9. PLAN-LIMITS-2B — moneda comercial PYG (display/prellenado)

Cambio chico y controlado: PYG (`pricePygPerMonth`) es la **fuente comercial** para mostrar/prellenar
precios. Sin tocar gates, lógica de suscripción ni cobros reales.

- **Backend (`manualActivationCallables.ts`):** el texto prellenado de WhatsApp ahora dice ₲ ("...el plan
  Básico (₲150.000/mes)...") o "precio a medida" (Enterprise); `whatsappData` agrega `pricePygPerMonth`
  (mantiene `priceUsdPerMonth` por compatibilidad). `applySubscriptionUpdate` y los cobros PayPal/Stripe/
  Bancard **sin tocar**.
- **Frontend (`apps/web`):** `lib/entitlements.ts` agrega `pricePygPerMonth` al espejo + nombres comerciales
  (Básico/Pro/Max) + helper `formatPlanPrice(plan)` (₲ si hay; "A medida" Enterprise; "Gratis"; fallback
  `US$` legacy). `PlanComparison`/`AdminActivationQueue`/`ManualActivationPanel` usan el helper → muestran
  **₲150.000 / ₲350.000 / ₲650.000 / A medida** en vez de USD.
- **`priceUsdPerMonth` queda como legacy/fallback** (no se elimina): solo se muestra si un plan no tuviera
  `pricePygPerMonth`. Hoy ningún plan del catálogo cae en ese fallback.

## 10. PLAN-LIMITS-3A — primeros gates de bloqueo (orders + whatsappNumbers)

Backend/tests/docs only. **No** gates de pagos/facturación/multicanal (eso es 3B). Sin frontend, sin deploy.

- **Órdenes (`conversation/engine.ts`, rama "pagar"):** ANTES de `createPendingOrder` se hace
  `checkQuota(tenantId,'orders')` (no-throw). Si llegó al tope de `maxOrdersPerMonth`: **no** crea la orden,
  **no** mide, y le responde al CLIENTE FINAL un mensaje **seguro** ("…un asesor te contacta…") — sin exponer
  plan/cuota. El `meterUsage('orders')` queda **después** de `createPendingOrder` → 1:1 con creación exitosa
  (si la creación lanza, no incrementa). Auditoría segura (logger, sin PII). Cierra **H1**. *Nota:* `checkQuota`
  también devolvería `suspended`, pero por diseño la cuenta nunca se suspende (`billingPosture.operational`
  siempre true) → hoy el billing caído **no** frena órdenes; solo el cupo mensual lo hace.
- **Números WhatsApp (`meta/connectFlow.ts` `runMetaConnect`):** tras `listWabaPhoneNumbers` y **antes** de
  persistir nada, si `phones.length > maxWhatsappNumbers` (de `resolveEntitlements`) → falla con
  `failed-precondition` (`over_number_limit` → `CONNECT_FAIL_MESSAGE`). **No** escribe token/conexión/assets
  ni toca una conexión existente. Idempotente: reconectar el mismo WABA repite el mismo conteo;
  `selectMetaPhoneNumber` no agrega assets (single-select) → no consume cupo. Conteo tenant-scoped
  (`COUNT_FN` por `tenants/{t}/metaAssets`). **Sin** override de admin (no existía; no se inventó). Cierra **H3**.
- **e2e `scripts/verify-plan-limits.mjs` (6/6):** orden dentro/sobre el límite (crea+mide / bloquea sin medir,
  mensaje seguro), primer número ok, re-select idempotente, número nuevo sobre el límite → failed-precondition
  con conexión previa intacta, cross-tenant. `verify-fase4b-meta` ajustado (su test de 2 números fija el plan
  a `growth`).

**Pendiente para PLAN-LIMITS-3B:** gates de features `stripe`/`bancard`/`localWallets` (checkout/pagos),
`electronicInvoicing` (factura), `multiChannel` (IG/FB) — y prender esas features en los planes cuando su gate
exista (H2/H4). Confirmar conteo `messages` in/out (H7). Frontend (espejo + alineado de features + textos por
plan) = PLAN-LIMITS-4. E2E por plan completa = PLAN-LIMITS-5.

**Riesgos restantes 3A** (revisión adversarial — 5 hallazgos, todos low):
1. El gate de números falla el connect entero si el WABA tiene más números que el plan (no permite "elegir
   cuál" usar) — UX a mejorar en una fase posterior.
2. El mensaje de bloqueo de órdenes no dispara handoff humano real (el vendedor ve la conversación y atiende
   manualmente).
3. **Cuota mensual de órdenes "blanda":** `checkQuota` lee `ordersThisMonth` y `meterUsage` incrementa por
   separado (no atómico, igual que el resto de las cuotas del repo) → bajo concurrencia (dos "pagar" a la vez
   en `limit-1`) puede sobrepasarse por ~1 orden. Enforcement estricto = transacción Firestore (fase posterior).
4. **Billing caído no frena órdenes** (ver nota arriba): por diseño la cuenta nunca se suspende; solo el cupo
   mensual enforcea. Si se quisiera frenar pedidos con billing vencido, hay que introducir una postura real
   `operational:false`.
5. **`connectMetaDemo`** (`meta/connect.ts`, vía `devMetaConnect`) persiste 1 número demo SIN el gate, pero es
   un endpoint **dev-only** (404 en prod por `guardDevEndpoint`) y escribe 1 número fijo → impacto nulo en prod.

## 11. PLAN-LIMITS-3B — features comerciales sensibles (auditoría + gate de multiChannel)

Backend/shared/tests/docs only. Sin frontend, sin deploy, sin tocar precios/landing/billing manual.
**Regla de oro:** no encender como disponible una feature sin implementación real **y** gate real; si está
`planned`/`not_started`, queda en `false` en los planes y solo se documenta. Auditoría exhaustiva (workflow
multi-agente con verificación adversarial) de las 6 features: **solo `multiChannel` tiene un punto de uso real
ungated**; las otras 5 son scaffold de tipos sin ruta de código activable → documentadas apagadas.

**Matriz de decisión 3B:**

| Feature | Veredicto | Categoría | Por qué |
|---|---|---|---|
| `multiChannel` | **GATEADA** | capacidad del tenant | Inbound IG/Messenger REAL y testeado (`parseWebhook`→`metaWebhook`→`onWebhookInbox`→`process.ts`). Punto ungated: `process.ts` entregaba canales no-WhatsApp al MISMO motor sin chequear el plan (H4). |
| `stripe` | apagada (`not_started`) | pago del negocio (sus clientes) | Solo el tipo `StripeConfig`; nunca leído/escrito. `stripeWebhook` es receptor sin productor (nada crea la sesión de cobro). Checkout real = transferencia. |
| `bancard` | apagada (`not_started`) | pago del negocio | `verifyBancardSignature` es STUB (`TODO`), `paymentBancardWebhook` comentado, `BancardConfig` nunca usado. El `'BANCARD'` de `createPendingOrder` es placeholder (cobro real = transferencia). |
| `localWallets` | apagada (`not_started`) | pago del negocio | Solo `WalletConfig` (tigo/personal/zimple) como tipo; cero consumidores; checkout no ofrece billeteras. |
| `electronicInvoicing` | apagada (`planned`) | capacidad del tenant (factura SET/SIFEN) | Scaffold más amplio (tipos `Invoice`, `TenantFiscalConfig`/timbrado, `paths.invoices`, rules) pero **sin emisión**: `createPendingOrder` solo deja `invoice:{invoiceId:null}`. *Red herring:* los "comprobante" son la FOTO de la transferencia, no factura fiscal. |
| `prioritySupport` | apagada (`not_started`) | etiqueta comercial | Sin software ejecutable (no hay tickets/SLA/enrutado). Es nivel de soporte humano, no gateable. |

**Distinción SaaS-billing vs pago-del-negocio:** `stripe`/`bancard` aparecen mucho en `billing/*` y
`PLATFORM_PAYMENT_PROVIDER` — eso es **cómo el SaaS le cobra la suscripción al tenant** (otro camino, ya
funciona, fuera de alcance). Las **features de plan** `stripe`/`bancard`/`localWallets` son **cómo el negocio
le cobra a SUS clientes** (`PAYMENT_METHOD` + `TenantPaymentsConfig`), que es scaffold puro.

**Implementado (gate de `multiChannel`):**
- **`meta/process.ts`:** tras resolver el canal, si `platform !== 'whatsapp'` se chequea
  `isFeatureEnabled(ent.features, 'multiChannel')` (NO-lanzante, vía `resolveEntitlements`). Si no está
  habilitada → el evento se marca `ignored` (no se entrega al motor) — **no** se usa `assertFeatureEnabled`
  porque lanza `HttpsError` y caería en el catch marcando `failed` (con reintento). **WhatsApp nunca se gatea**
  (incluido en todos los planes). Cierra **H4**.
- **`featureOverrides` per-tenant (nuevo, espejo de `limitOverrides`):** `Tenant.featureOverrides?:
  Partial<PlanFeatures>` + `effectiveFeatures()` en `decide.ts`, cableado en `resolveEntitlements` (solo aplica
  con premium habilitado). Permite habilitar una feature a un tenant puntual (demo/Enterprise/tests) **sin
  encenderla en el plan**. `multiChannel` queda en **`false` en TODOS los planes** (el outbound IG/Messenger
  aún no existe → no es vendible); perfumeria (demo) lo habilita por override en `verify-d2`/`verify-d5`.
- **Tests:** `verify-plan-limits-3b.mjs` (8/8): IG/Messenger sin feature → `ignored` (con el motivo exacto);
  WhatsApp siempre `processed`; IG con override → `processed` (canal instagram); cross-tenant (el override de
  un tenant no habilita a otro). `decide.test.ts` cubre `effectiveFeatures`. `verify-d2`/`verify-d5` setean el
  featureOverride + settle (su inbound IG sigue procesando). *No bypass desde payload:* el tenant se resuelve
  server-side por `metaExternalIndex`; el remitente no puede declararse una feature.

**Apagadas — punto FUTURO de gate (cuando se construya la capacidad real, recién ahí encender en planes):**
- `stripe`/`bancard`/`localWallets` → en el callable que cree la sesión de cobro y/o un `paymentsConfigUpdate`
  que escriba `*.enabled` (planes sugeridos a futuro: `growth`/`pro`/`enterprise`).
- `electronicInvoicing` → en la función de emisión fiscal (SIFEN/timbrado) (plan sugerido: `pro`).
- `prioritySupport` → no aplica gate de software (capacidad operativa de soporte humano, fuera de código).
- Todas siguen en la lista `NOT_YET` de `plans.test.ts` (asegura `false` en todos los planes).

**Riesgos restantes 3B:**
1. **`multiChannel` outbound incompleto:** el inbound IG/Messenger está completo y gateado, pero el envío
   saliente (`getWhatsAppClient`/`CloudAPIClient`) siempre postea al endpoint de WhatsApp Cloud API — no hay
   cliente de envío IG/Messenger. Por eso `multiChannel` **no se enciende en ningún plan** todavía (solo por
   override per-tenant). Encenderla en planes recién cuando exista envío saliente real por canal.
2. **Alcance del hueco H4 hoy:** el connect REAL de prod (`runMetaConnect`→`buildMetaAssets`) solo crea assets
   `whatsapp_*`; el índice IG/Messenger solo lo crean endpoints **dev-only** (`devMetaConnect`,
   `devSimulateInbound`, 404 en prod). El gate igual se agregó (defensivo + forward-safe): cuando se construya
   el connect IG/FB real, el plan ya queda enforceado.
3. **Inconsistencia FE/BE (copy):** el espejo del frontend (`apps/web/lib/entitlements.ts`) muestra
   `prioritySupport`/billeteras como incluidas en planes premium mientras el backend las tiene en `false`. Es
   marketing/copy (la fuente de verdad es `resolveEntitlements` sobre `plans/{id}`), no un hueco de
   enforcement. Alinear en PLAN-LIMITS-4.
4. **Scaffold muerto** (`paths.invoices`, `BancardConfig`/`StripeConfig`/`WalletConfig`, receptor
   `stripeWebhook`): existe pero no se debe encender ninguna feature por la mera presencia de tipos/infra; el
   criterio sigue siendo **punto de uso real + gate real**.

## 12. PLAN-LIMITS-4 — alineación del frontend (espejo/billing/PlanGate) con la verdad del backend

Solo frontend (zona billing/plans) + docs. Sin backend (solo lectura), sin deploy, sin rediseño. El frontend
**muestra la verdad del backend**: no vende como disponible ninguna feature que el backend tenga en `false`.

- **`apps/web/src/lib/entitlements.ts` — `PLAN_CATALOG.features` alineado EXACTO con `plans/plans.ts`:**
  antes el espejo prendía `bancard/stripe/localWallets/multiChannel/electronicInvoicing/prioritySupport` (mock).
  Ahora cada plan trae solo lo real: `aiAssistant` (Básico+) y `marketingAutomation` (Pro+). Nuevos exports:
  `ENFORCED_FEATURES` (las 2 reales, únicas que se muestran como "incluidas") y `UPCOMING_FEATURES` (roadmap,
  se muestran como "Próximamente": pagos online, facturación electrónica, multicanal completo, soporte
  prioritario). Nombres/precios PYG/límites ya estaban alineados (2/2B) — solo las features estaban mock.
- **`PlanComparison.tsx`:** `KEY_FEATURES` → solo `aiAssistant`+`marketingAutomation` (check/dash real por plan);
  bloque "Próximamente" debajo del grid con `UPCOMING_FEATURES` (no por plan, no como incluidas).
- **`billing/page.tsx`:** sección "Incluido en tu plan" → solo `ENFORCED_FEATURES`; nueva sección
  "Próximamente" con `UPCOMING_FEATURES`. El `PlanGate` demo dejaba de prometer **facturación electrónica
  "desde Growth"** (feature inexistente) → ahora gatea `marketingAutomation` (feature REAL, disponible en Pro+).
- **PlanGate** sigue siendo solo UX (el backend valida seguridad); CTA de upgrade lleva a `/billing` donde la
  activación de plan se solicita por WhatsApp (billing manual, muestra ₲). Enterprise = "A medida" / "Contactar".
- **Verificación:** web typecheck 0, lint 0 err (1 warning pre-existente ajeno), sin tests frontend. Sin strings
  de plan en USD; features futuras solo bajo "Próximamente".

**Riesgos restantes 4 / pendiente para FRONTEND-UX-1:**
1. **Landing (`apps/web/src/app/page.tsx` → `marketing/PricingSection.tsx`) NO tocada** (fuera de alcance: "no
   tocar landing todavía"). **Tiene su propio copy desincronizado y con promesas falsas:** planes
   "Inicial/Crecimiento/Escala" a ₲290.000/₲690.000/A medida (≠ Básico ₲150.000 / Pro ₲350.000 / Max ₲650.000
   del backend) y features "WhatsApp + Instagram + Messenger" y "Soporte prioritario" como incluidas
   (multiChannel/prioritySupport NO disponibles). **Alinear o marcar como roadmap en FRONTEND-UX-1 / fase de
   landing.** Mismo cuidado en `login` splash y wizard `welcome` ("Conectá Instagram y Facebook" — hoy la
   conexión Meta es para ads/atribución, no multicanal de mensajería).
2. **`entitlements.ts` sigue parcialmente mock** para acciones no cableadas (`requestPlanChange`/`openBillingPortal`
   devuelven `NotWired`; uso puntual de productos/usuarios/números en 0 hasta cablear `count()`). Es honesto
   (no promete) pero queda para cuando el backend exponga esas lecturas como callables.
3. La sección "Próximamente" es informativa; cuando el backend prenda una feature en un plan hay que moverla de
   `UPCOMING_FEATURES` a las incluidas (queda centralizado en `entitlements.ts`).

## 13. PLAN-LIMITS-FREE-TRIAL — `free` = prueba gratis acotada de 7 días

Backend/shared/tests/docs + frontend (límites del free trial). El plan `free` **deja de ser un plan gratuito
permanente**: pasa a ser una prueba acotada de 7 días con límites bajos para acotar costo. ID interno `free`
sin cambiar; nombre comercial "Prueba gratis"; planes pagos **intactos**.

**Matriz final del free trial** (`plans/plans.ts` `DEFAULT_PLANS.free` + espejo `apps/web/lib/entitlements.ts`):

| campo | valor | nota |
|---|---|---|
| `trialDays` | **7** | metadata nueva (campo `Plan.trialDays?`) |
| `maxProducts` | 20 | sin cambio |
| `maxOrdersPerMonth` | **10** | bajó de 50 |
| `maxWhatsappMessagesPerMonth` | **50** | bajó de 500 |
| `maxUsers` | **2** | owner + 1 empleado (el registro crea solo al owner → no rompe onboarding) |
| `maxDeliveryPersons` | **1** | bajó de 2 (no 0: con 0 se rompía `verify-fase5c-growth-c2` y el trial no podría probar delivery) |
| `maxWhatsappNumbers` | 1 | sin cambio |
| `maxAiTokensPerMonth` | 0 | sin cambio (sin IA en el trial) |
| `maxAdSyncsPerMonth` | 0 | sin cambio |
| `aiAssistant` / `marketingAutomation` / `multiChannel` / pagos / facturación | **false** | sin features premium |

**`trialDays` es METADATA — `Plan.trialDays?: number`** (en `@vpw/shared`): solo `free` lo define (7); los
planes pagos lo dejan `undefined` (no son trials). Compatible/no rompe nada (campo opcional; `resolveEntitlements`
no lo usa). El frontend lo espeja en `PlanView.trialDays` y lo muestra ("Prueba gratis de 7 días").

**GAP documentado (no implementado en esta fase):** **NO existe vencimiento automático del trial.** `trialDays`
hoy es solo informativo: pasados los 7 días, la cuenta NO se auto-degrada ni se bloquea — los límites del free
siguen aplicando indefinidamente. Implementar el vencimiento (auto-lock / forzar upgrade al día 7, con su fecha
de inicio del trial y un job/gate que lo aplique) es una **fase futura** (requiere lógica de billing nueva; el
usuario pidió explícitamente NO inventarla acá). Riesgo restante: un tenant puede quedarse en el free trial sin
límite de tiempo hasta que se construya ese enforcement.

**Tests:** `plans.test.ts` (pin de la matriz free + `trialDays` solo en free), `verify-plan-matrix.mjs` (matriz
e2e con los nuevos valores + check de `trialDays`), `verify-plan-limits.mjs` (gate de órdenes ajustado a free=10:
ordersThisMonth 9→10). `verify-fase4-whatsapp` (test de mensajes pasa igual: 500 sigue sobre el nuevo tope 50;
solo se actualizó el comentario). `verify-fase5c-growth-c2` sin cambios (su test 1 crea 1 repartidor → ok con
free=1; tests 2/3 usan `limitOverrides`).

**Estado:** PLAN-LIMITS-1 + 2 + 2B + 3A + 3B + 4 + FREE-TRIAL (free = prueba 7d) cerrados. Sigue **PLAN-LIMITS-5**
(e2e por plan — script `verify-plan-matrix.mjs` listo) y **FRONTEND-UX-1** (landing/rediseño). Pendiente futuro:
**enforcement del vencimiento del trial** (no implementado, ver gap arriba).
