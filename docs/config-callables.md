# Callables de config sensible — contrato (Fase 5C-A)

Migración de los writes directos del panel a `config/checkout`, `config/agent` y `config/channels`
hacia **callables con gate de backend**. **Autorización ESTRICTA: solo `TENANT_OWNER` del tenant o
`PLATFORM_ADMIN`** (`resolveOwnerAdminAuth`). Nunca `SELLER` ni `TENANT_MANAGER`. Validación estricta
(whitelist de campos) y auditoría de cada cambio.

> **Cierre (G-1, hecho):** el frontend (`agent-config.ts`/`templates.ts`) ya invoca estos callables y
> `firestore.rules` cerró el wildcard `match /config/{doc}` a **`allow write: if false`** (lectura
> viewer+ sin cambios). Agent/checkout/channels **solo** se escriben vía backend validado (Admin SDK).
> Verificado con `verify-rules-config.mjs` (12/12).

Errores comunes: `unauthenticated` (sin sesión), `permission-denied` (rol no autorizado),
`invalid-argument` (tenantId faltante para admin / payload inválido), `failed-precondition`
(precondición de negocio). Todos vía `HttpsError`.

---

## `checkoutConfigUpdate`

Escribe `tenants/{tenantId}/config/checkout` (cuentas bancarias + vendedores). Redirige cobros → owner/admin.

- **Payload:** `{ tenantId?: string, data: { bankAccounts: BankAccount[], sellers: Seller[] } }`
  - `BankAccount = { bank, accountNumber, holder, document, alias? }` (strings; máx 50 cuentas).
  - `Seller = { name, whatsapp, active: boolean }` (máx 100).
  - Listas ausentes → `[]`. Estructura inválida → `invalid-argument`.
- **Respuesta:** `{ ok: true }`.
- **Roles:** `TENANT_OWNER` (su tenant) · `PLATFORM_ADMIN` (con `tenantId`).
- **Auditoría:** `checkout.updated` (sin números de cuenta en el log; solo conteos).

## `agentConfigUpdate`

Escribe `tenants/{tenantId}/config/agent` (comportamiento del bot). **Patch con whitelist**: solo se
aceptan estos campos; cualquier otro (p.ej. `planId`, `limits`) se **descarta**.

- **Payload:** `{ tenantId?: string, data: Partial<{ agentName, businessName, tone, language,
  greetingMessage, farewellMessage, fallbackMessage, handoffMessage, salesRules, industry (strings);
  botEnabled, testMode, profitMode (booleans); faq: { q, a }[] }> }`
  - Tipo incorrecto o `faq` mal formada → `invalid-argument`. Sin campos válidos → `invalid-argument`.
- **Respuesta:** `{ ok: true }`.
- **Roles:** `TENANT_OWNER` · `PLATFORM_ADMIN`.
- **Auditoría:** `agentConfig.updated` (lista de campos cambiados; sin valores).

## `channelConfigUpdate`

Escribe `tenants/{tenantId}/config/channels` (`whatsappSendMode`). **Activar WhatsApp REAL nunca lo
decide el frontend.**

- **Payload:** `{ tenantId?: string, data: { whatsappSendMode: 'mock' | 'live' } }`.
- **Regla `live`:** solo se permite si la conexión Meta del tenant es **resoluble**
  (`resolveTenantWhatsappCreds`: conexión `active` + número `whatsapp_phone_number` seleccionado +
  token válido/no vencido). Si no → **`failed-precondition`** (motivo: no conectado / token vencido /
  sin número / token no disponible). `mock` siempre permitido.
- **Respuesta:** `{ ok: true, whatsappSendMode }`.
- **Roles:** `TENANT_OWNER` · `PLATFORM_ADMIN`.
- **Auditoría:** `channelConfig.updated`.

---

## Migración de frontend (hecha — G-1)

`apps/web/src/lib/agent-config.ts` y `templates.ts` ya invocan los callables:
`saveAgentConfig`/`applyTemplate` → `agentConfigUpdate`, `saveCheckoutConfig` → `checkoutConfigUpdate`
(con el payload `{ tenantId, data }`; los `HttpsError` los maneja react-query). Las **lecturas** de
config siguen directas (`getDoc`). Con la migración aplicada, `firestore.rules` cerró `config/{doc}`
a `write:false`.

## Pendiente 5C (otras sub-fases)

- **5C-B (catálogo):** `productUpsert` (plegando `productFinancials`) + `productDelete` + categorías.
- **5C-C (growth):** promociones, tracking, repartidores (cuota), winningReplies, agentTestCases.
- **5C-D (bajo riesgo, opcional):** marcar resuelto/completado (`agentAudits`/`followUpTasks`/`insights`).
- **Cierre de `firestore.rules`** a `write:false` por módulo, tras la migración del frontend.
