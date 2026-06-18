# Integraciones reales — AI_AFG (Fase 3)

Las integraciones se construyen como **adapters con fallback a demo**: sin credenciales
(o en el emulador) usan un mock y la demo sigue intacta; con credenciales reales se
activan solas. Nada de esto rompe el flujo actual.

## 1. WhatsApp Cloud API (envío de respuestas)

El bot ya calcula la respuesta; ahora se **entrega** vía `messaging/whatsappClient.ts`.

- **Emulador** → `MockWhatsAppClient` (sólo loguea, **nunca** llama a Meta).
- **Producción** → `CloudAPIClient` (POST a `graph.facebook.com/{phoneNumberId}/messages`),
  **con credenciales por tenant** (ver §1.c). Sin conexión/credenciales → Mock por tenant.

> Las globales `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_ACCESS_TOKEN` **ya no son la fuente
> primaria** (Fase 4A): solo se usan como bootstrap deprecado tras `ALLOW_GLOBAL_WHATSAPP_FALLBACK`.

## 1.b Webhook Meta — formato real, normalización e idempotencia (Hardening F3)

`metaWebhook` (`functions/meta/webhookHttp.ts`) recibe el payload **real** de Meta y lo
normaliza con un parser **puro** (`meta/parseWebhook.ts`, `parseMetaWebhookPayload`).

**Formato real soportado** (fuente: docs oficiales de Meta — WhatsApp messages webhook, Messenger
messages, Instagram messaging):
- **WhatsApp** (`object: whatsapp_business_account`): `entry[].changes[].value`;
  `externalId = value.metadata.phone_number_id`; `value.messages[]` (texto → `text.body`;
  interactive button/list → título; `button` de plantilla → `button.text`); `referral.source_id`
  → `adReferral.adId`; `value.statuses[]` (recibos) → **ignorado**; media/audio/etc → **ignorado**.
- **Messenger** (`object: page`) e **Instagram** (`object: instagram`): `externalId = entry[].id`;
  `entry[].messaging[]` con `sender.id` y `message.{mid,text}`; adjuntos sin texto / echoes →
  ignorado; `referral.ad_id` → `adReferral.adId`.

El parser devuelve `{ messages, ignored }` y **no lanza** ante payload malformado.

**Idempotencia por `messageId`:** se escribe **un evento de inbox por mensaje** con id
determinístico `${platform}_${messageId}` (sanitizado para Firestore) usando `.create()`. Un
reenvío de Meta con el mismo `messageId` falla con ALREADY_EXISTS → se cuenta como `duplicate`
(no se duplica ni se reprocesa). **Otros errores se loguean** (no se ocultan como duplicado).

**`phone_number_id → tenantId`:** el parser extrae `phone_number_id` como `externalId`;
`process.ts` lo resuelve con `metaExternalIndex[whatsapp_${phone_number_id}].tenantId`. Ese
índice se **puebla al conectar Meta** (hoy demo: `whatsapp_wa-595 → tenant`; el OAuth real
registrará el `phone_number_id` real del tenant). Si no resuelve → el evento queda `ignored`.

**Compatibilidad:** el inbox sigue teniendo `payload.{from,text,adReferral}` (+ `messageId`,
`timestamp`, `rawMessage` para debug, **sin tokens**) → `process.ts` **no cambia**.
`devSimulateInbound` (payload simplificado) **sigue funcionando** para emulador/seed/tests.

**Firma:** sin cambios — `X-Hub-Signature-256` obligatoria fuera del emulador (fail-closed).

**Pendiente / limitaciones (fuera de F3):**
- **WhatsApp real por tenant:** falta resolver credenciales por tenant para el ENVÍO
  (`getWhatsAppClient` usa env global) y registrar el `phone_number_id` real en
  `metaExternalIndex` al conectar (OAuth real).
- **`adReferral` sin campaña:** Meta manda `source_id` / `ad_id` (el **anuncio**), **no** el
  `campaignId`. La atribución por campaña usa `adReferral.campaignId`, así que los clics de
  anuncio reales **no auto-atribuyen por campaña** hasta mapear `adId → campaignId` (vía el sync
  de Meta Ads). **Limitación conocida.**

## 1.c WhatsApp outbound por tenant (Hardening F4A)

El envío real se resuelve **por tenant** (no global). `getWhatsAppClient(tenantId)` decide así:

1. **Emulador** (`FUNCTIONS_EMULATOR`) → SIEMPRE `MockWhatsAppClient` (nunca toca Graph). Aun
   así **resuelve** las credenciales para poder testear el aislamiento: el Mock queda
   *inspeccionable* (lleva el `phone_number_id` del tenant; el token NUNCA se loguea ni se
   expone). En emulador escribe una traza en `tenants/{t}/_debug/lastWhatsappSend` (solo
   emulador) para los e2e.
2. **`whatsappSendMode`** del tenant (`tenants/{t}/config/channels`, default **`'mock'`**):
   si no es `'live'` → Mock (`reason: mode_mock`). Es el interruptor de "responder en
   WhatsApp real", **separado** del on/off del agente (`AgentConfig.botEnabled`).
3. **Resolución de credenciales** (`messaging/resolveWhatsappCreds.ts`, decisión pura
   `decideWhatsappCreds`): junta `MetaConnection` (estado `active` + `tokenSecretRef`) +
   `metaAsset` `whatsapp_phone_number` (selected → el `phone_number_id`) + token en claro vía
   `SecretStore.get(tokenSecretRef)`. Si todo resuelve → `CloudAPIClient(phoneNumberId, token)`
   (cacheado por tenant, TTL 60s acotado a `tokenExpiresAt`). Si no → Mock con **motivo claro**:
   `no_tenant` · `not_connected` · `token_expired` · `no_phone_asset` · `token_unavailable`.
4. **Fallback global DEPRECATED**: solo si `ALLOW_GLOBAL_WHATSAPP_FALLBACK=true` (default
   `false`) y hay env globales → usa el par global (bootstrap mono-tenant). Si no → Mock.

**Tres estados separados** (Fase 4A): (a) *agente activo* = `AgentConfig.botEnabled` (el bot
habla); (b) *WhatsApp conectado* = `MetaConnection.status==='active'` + asset + token; (c)
*responder en WhatsApp real* = `whatsappSendMode==='live'`. El envío real ocurre solo con (a)∧(b)∧(c)
fuera del emulador.

**SecretStore:** el token nunca va a Firestore en claro (solo `tokenSecretRef`); `disconnectMeta`
ahora **borra** el secreto referenciado (`SecretStore.remove`) para no dejar huérfanos.

**Pendiente Fase 4B (NO incluido):** OAuth/Embedded Signup self-service completo y **discovery
real** del `phone_number_id` (poblar `metaAssets` vía Graph al conectar). En F4A se usan assets
ya seedeados; la conexión real self-service **no está completa todavía**. Tampoco entra el envío
de plantillas/media ni el refresh automático de tokens (Meta: `190` token, `131047` ventana 24h,
`131030` destinatario no permitido, `131056`/`80007` rate limit).

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

## 3. Conexión real de Meta por tenant (Hardening F4B)

Flujo **Embedded Signup** vía **callables autenticados** (no hay endpoint público de redirect).
Autorización ESTRICTA (`meta/authz.ts`): solo **PLATFORM_ADMIN** (con tenant objetivo) o
**TENANT_OWNER** de su empresa. Manager/viewer/seller: denegado.

1. **`startMetaConnect`** → emite un **nonce** de un solo uso (`metaOAuthStates/{nonce}`,
   atado a `tenant`+`uid`, TTL 10 min, Admin-only). El frontend lanza el JS SDK de ES.
2. **`connectMeta`** ({nonce, code, wabaId?, phoneNumberId?, businessId?}) → consume el nonce
   (transacción, una sola vez), y orquesta (`meta/connectFlow.ts` `runMetaConnect`):
   - **exchange** del `code` (token de System User de larga duración) — `MetaGraphClient`.
   - **`debug_token`**: valida `is_valid`, **scopes** (`whatsapp_business_messaging` +
     `whatsapp_business_management`), **WABA ids** (de `granular_scopes`) y `expires_at` →
     `tokenExpiresAt`.
   - guarda el token en **SecretStore** con **naming seguro** `metaTokenSecretName(tenantId)`
     = `meta-token-{tenant}` (sin `/`; el bug de F4A queda corregido y `SecretStore.set`
     ahora **rechaza** nombres inválidos).
   - **discovery** (`meta/discovery.ts`): `GET /{waba}/phone_numbers` → escribe `metaAssets`
     (business, WABA, cada `whatsapp_phone_number`) + `metaExternalIndex/whatsapp_{phone_number_id}`.
   - `subscribed_apps` (best-effort) + **preflight**.
   - **Falla seguro** (sin guardar token, con estado claro): `token_invalid`→`expired`,
     scopes faltantes→`permission_missing`, sin WABA/sin número→`error`.
3. **`verifyMetaChannel`** → preflight on-demand (`meta/preflight.ts`): `debug_token` +
   `GET /{phone_number_id}` (NO registra el número), actualiza `status`
   (`active`/`expired`/`permission_missing`/`error`) + `lastVerifiedAt`.
4. **`selectMetaPhoneNumber`** → fija el `phone_number_id` activo (lo consume el envío de F4A).
5. **`metaDisconnect`** → `disconnectMeta`: `not_connected` + borra `metaAssets` +
   `metaExternalIndex` del tenant + **el secreto** (`SecretStore.remove`).

**Seguridad:** el token/`code`/app secret **nunca** se loguean; el token va **solo** a
SecretStore (cifrado AES-256-GCM; `secrets` con `read,write:false`). `MetaConnection`/`metaAssets`
con `write:false` desde cliente (solo Admin SDK). Cierra el lazo con F4A: tras conectar,
`getWhatsAppClient(tenantId)` resuelve el número + token reales del tenant.

**Testabilidad:** todas las llamadas a Graph pasan por `MetaGraphClient` (inyectable). En
emulador/tests se usa `FixtureMetaGraphClient` (lee `metaTestFixtures/graph`) → **nunca** se
llama a `graph.facebook.com`.

`lib/secretStore.ts` (`FirestoreSecretStore`): cifra con AES-256-GCM (`lib/crypto`) en la
colección global `secrets` (Admin SDK only). Punto de extensión a **Google Secret Manager**
bajo `USE_SECRET_MANAGER`.

Variables: `META_APP_ID`, `META_APP_SECRET`, `META_OAUTH_REDIRECT_URI` (el app access token
del `debug_token` es `{META_APP_ID}|{META_APP_SECRET}`). Requiere Meta habilitado (App
Review/verificación — ADR-0010). En demo se sigue usando `connectMetaDemo` (intacto).

**Pendiente / fuera de F4B:** frontend del Embedded Signup (el contrato de callables queda
listo, sin cablear `apps/web`); registro del número (`POST /{phone_number_id}/register` con
PIN — acción operativa/F4C, no se hace automático); **refresh automático** de tokens (F4B solo
detecta `expired`/`revoked` y pide reconexión); envío de plantillas/media; Google Secret Manager.

## Resumen de variables (Functions, staging/prod → Secret Manager)

| Variable | Integración |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` | **DEPRECATED** (F4A): solo bootstrap global tras el flag de abajo |
| `ALLOW_GLOBAL_WHATSAPP_FALLBACK` | F4A: habilita el fallback global deprecado (default `false`) |
| `tenants/{t}/config/channels.whatsappSendMode` | F4A: `'mock'`(default)/`'live'` — envío real por tenant (no es env var) |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` | Webhook Meta (Fase 2) |
| `STRIPE_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY` | Pagos Stripe |
| `META_APP_ID`, `META_APP_SECRET`, `META_OAUTH_REDIRECT_URI` | Meta OAuth |
| `TENANT_SECRETS_ENCRYPTION_KEY` | Cifrado de SecretStore |

El `.env.example` consolidado y el cableado a Secret Manager se completan en la Fase 5 (deploy).
