# Onboarding SaaS multiempresa — AI_AFG (Fase 4)

Cómo una empresa entra al sistema de forma ordenada, con planes, usuarios y billing.

## 1. Alta de empresa (provisioning)

Callable **`provisionTenant`** (solo `PLATFORM_ADMIN`). Crea en una operación:
- el **tenant** (`tenants/{slug}`) con plan, límites del plan, uso en cero y estado `ACTIVE`;
- el **owner** en Firebase Auth con custom claims `{ tenantId, role: TENANT_OWNER }`;
- el doc `users/{uid}`;
- la **config inicial del agente** (`config/agent`) con un saludo según el rubro.

Input: `{ name, slug?, ownerEmail, ownerName?, ownerPassword?, planId?, industry?, country?, currency? }`.

> La **plantilla de catálogo** completa del rubro se aplica después, desde el panel `/onboarding`
> (P19), cuando el owner entra por primera vez.

## 2. Usuarios del equipo

Callables (autorizados para el `TENANT_OWNER` de esa empresa o `PLATFORM_ADMIN`):
- **`inviteUser`** `{ tenantId, email, role, name? }` — crea/vincula el usuario y le asigna claims.
- **`setUserRole`** `{ tenantId, uid, role }` — cambia el rol.
- **`setUserActive`** `{ tenantId, uid, active }` — activa/desactiva (deshabilita el login).

Roles de empresa: `TENANT_OWNER`, `TENANT_MANAGER`, `TENANT_VIEWER`, `SELLER`.

## 3. Planes y límites

Colección `plans/{id}` (sembrada automáticamente en el primer provisioning):

| Plan | Productos | Pedidos/mes | Mensajes WA/mes | USD/mes |
|---|---|---|---|---|
| free | 20 | 50 | 500 | 0 |
| starter | 200 | 500 | 5.000 | 29 |
| growth | 1.000 | 2.000 | 20.000 | 79 |
| pro | ∞ | ∞ | ∞ | 199 |

El tenant copia `limits` de su plan y lleva `usage` (mensajes/pedidos del mes). El **límite de
mensajes** se aplica en el ingreso (`tenants/lifecycle.checkTenantInboundGate`): si la empresa
está suspendida o pasó el límite, el bot no procesa el mensaje.

> Enforcement de `maxProducts`/`maxOrdersPerMonth` en cada escritura directa requiere routear esas
> operaciones por callables (hoy se escriben por reglas). Queda como follow-up; el modelo y el
> límite de mensajes ya están activos.

## 4. Billing de plataforma (Stripe Billing)

Webhook **`platformBillingWebhook`** (firma Stripe, idempotente). Según el estado de la suscripción
(`subscription.metadata.tenantId`):
- `active` / `trialing` → empresa **ACTIVE**;
- `past_due` / `canceled` / `incomplete` → empresa **SUSPENDED** (el bot deja de atender).

Variables: `PLATFORM_BILLING_WEBHOOK_SECRET` (o reusa `STRIPE_WEBHOOK_SECRET`).

## Criterios de aceptación (verify-fase4.mjs)

1. Crear un tenant nuevo desde cero (callable admin) → 13/13 checks.
2. El owner ve SU empresa (200) y NO otra (403).
3. El vendedor NO ve finanzas (403).
4. Invitar usuario; un vendedor NO puede invitar.
5. Billing cancelado → SUSPENDED; activo → ACTIVE.
