# Meta / WhatsApp — Checklist de go-live (real en producción)

> Auditoría META-PROD-READINESS-AUDIT (read-only). El **código del flujo real (Fase 4B: Meta Connect UX + webhook + outbound) está COMPLETO**.
> Lo que falta para pasar de demo/local a real es **configuración** (env/secrets), **setup en Meta Developer** y **App Review** — no código.
> Estados: ✅ listo (en código) · ⚠️ falta (configurar) · ⛔ bloqueado (depende de Meta/setup externo).

## 1. Resumen del estado en código (ya implementado)
- ✅ Embedded Signup real: `startMetaConnect` (nonce) → `launchEmbeddedSignup` (popup, captura `code`, el token nunca pasa por el front) → `connectMeta` (intercambia `code` server-side, valida scopes vía `debug_token`, descubre WABA/números, persiste). + `verifyMetaChannel`, `selectMetaPhoneNumber`, `metaDisconnect`. Todos callables autenticados (owner/admin), exportados en `index.ts`.
- ✅ Webhook real `metaWebhook` (us-central1): handshake GET (`hub.verify_token`/`hub.challenge`), firma `X-Hub-Signature-256` (HMAC con app secret, **fail-closed en prod → 401**), idempotencia por messageId, siempre responde 200. Inbound → `metaWebhookInbox` → trigger `onWebhookInbox` → resuelve tenant por `metaExternalIndex` → gate de plan/empresa → motor → `sendText`.
- ✅ Outbound: `CloudAPIClient` → `graph.facebook.com/v19.0/{phoneNumberId}/messages` con token por tenant (de `SecretStore`), solo si conexión `active` + token vigente + `whatsappSendMode='live'`.
- ✅ Seguridad: token de Meta cifrado **AES-256-GCM** en `secrets/{name}` (solo se persiste la ref opaca `secret://…` en `MetaConnection.tokenSecretRef`); el `code` y los tokens **nunca se loguean**; dev endpoints bloqueados en prod (404, ver DEV-ENDPOINTS-PROD-GUARD).
- ✅ Entitlements: `assertWhatsappNumbersEntitled` + `maxWhatsappNumbers` gatean la conexión por plan.

## 2. Checklist por área

### A. Frontend env (`apps/web`)
| Var | Estado | Detalle |
|---|---|---|
| `NEXT_PUBLIC_META_APP_ID` | ⚠️ falta | Requerida. Sin ella `isMetaConfigured()=false` → fallback demo (que en prod está bloqueado). Documentada en `.env.example`, vacía en `.env.local`. |
| `NEXT_PUBLIC_META_CONFIG_ID` | ⚠️ falta | Requerida. Es el ID de la **configuración de Embedded Signup** creada en Meta (define los scopes que se piden). |
| `NEXT_PUBLIC_META_GRAPH_VERSION` | ✅ listo | Default `v19.0`, documentada. |
| `NEXT_PUBLIC_API_BASE_URL` | ✅ listo | Solo la usan los endpoints demo; el flujo real usa callables de Firebase. |

### B. Backend secrets/env (`apps/functions`)
| Secret/env | Estado | Detalle |
|---|---|---|
| `META_APP_ID` (backend) | ⚠️ falta | Para el intercambio `code`→token (`graphClient`/`connectFlow`). |
| `META_APP_SECRET` | ⚠️ falta | App Secret de la app de Meta; se usa en el intercambio OAuth. **Hoy se lee de `process.env`** (no Secret Manager). |
| `WHATSAPP_APP_SECRET` | ⚠️ falta | Firma del webhook (`X-Hub-Signature-256`). **Es el mismo App Secret de Meta** bajo otro nombre → setear ambos al mismo valor (o unificar). Obligatorio en prod. |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | ⚠️ falta | Token del handshake GET. En emulador default `aiafg-verify-demo`; en prod hay que definir uno propio y ponerlo igual en Meta. |
| `TENANT_SECRETS_ENCRYPTION_KEY` | ⚠️ falta (prod) | Clave maestra 32+ chars (deriva AES-256-GCM). **Rotarla = migrar todos los secrets cifrados.** Existe en local; falta proveerla en prod. |
| `ANTHROPIC_API_KEY` | ✅ listo (patrón) | Único secret vía Firebase `defineSecret` (bindeado a las functions de IA). |
| Provisioning de secrets en prod | ⚠️ falta | META/WhatsApp/encryption-key se leen de `process.env`, no de Secret Manager. **Recomendado:** migrar `META_APP_SECRET`, `WHATSAPP_APP_SECRET` y `TENANT_SECRETS_ENCRYPTION_KEY` a `defineSecret`/`functions:secrets:set` para que existan en el runtime de Cloud Functions v2 (hoy dependerían de `.env` deployado). |
| `META_OAUTH_REDIRECT_URI` | ℹ️ legacy | De la Fase 4A (`oauth.ts`, deprecada). El Embedded Signup (4B) **no** necesita redirect URI. |
| `ALLOW_GLOBAL_WHATSAPP_FALLBACK` | ✅ listo | Default `false`; **nunca activar en prod multi-tenant** (es un fallback global deprecado). |

### C. Webhook (Meta lo necesita)
| Item | Estado | Detalle |
|---|---|---|
| URL pública | ⚠️ falta (deploy) | `https://us-central1-<PROJECT_ID>.cloudfunctions.net/metaWebhook` (existe tras `deploy`). |
| Verify token | ⚠️ falta | Definir `WHATSAPP_WEBHOOK_VERIFY_TOKEN` y cargar el mismo string en Meta. |
| Firma | ✅ listo | Validación HMAC fail-closed (solo falta el secret). |
| Suscripción de eventos | ✅ listo | `subscribeApp(wabaId, token)` se llama al conectar; suscribe la app del WABA a los webhooks. |

### D. Meta Developer / App Review
| Item | Estado | Detalle |
|---|---|---|
| App de Meta creada + Embedded Signup config | ⚠️ falta | Crear app, habilitar WhatsApp, crear la config de Embedded Signup → de ahí salen `APP_ID` y `CONFIG_ID`. |
| Dominio verificado | ⛔ bloqueado | El dominio del panel (donde corre el Embedded Signup) debe estar verificado en Meta App Settings, o el popup rechaza el origen. |
| App en modo **Live** | ⛔ bloqueado | En modo *development* solo conectan testers/admins de la app. Para clientes reales: pasar a Live. |
| Scopes requeridos (WhatsApp) | ✅/⛔ | `whatsapp_business_messaging` + `whatsapp_business_management` son los **únicos validados** (hard-stop). Son Standard/aprobables sin review pesada, pero **igual requieren App Review/Advanced Access** para uso público fuera de testers. |
| Scopes extra (IG/ads/catálogo) | ⚠️ falta (futuro) | `business_management`, `ads_read`, `catalog_management`, `pages_show_list`, `instagram_basic` están **solo en demo**, no se validan ni se usan en el connect real. Requieren **Advanced Access (App Review)** si en el futuro se cablean. |
| Test users / test business | ℹ️ info | Permiten iterar **sin** App Review: app en development + usuarios de prueba + `CONFIG_ID` de test. |

### E. WhatsApp (qué conecta cada empresa)
| Item | Estado | Detalle |
|---|---|---|
| WABA + número + `phone_number_id` | ✅ listo (auto) | El connect descubre WABA y números (`discovery`); si hay >1 número, el owner elige con `selectMetaPhoneNumber`. |
| Pruebas inbound/outbound | ✅ listo | Inbound real vía `metaWebhook`; outbound vía Cloud API. (En local se simula con `devSimulateInbound`.) |
| Pasar a "respuestas reales" | ✅ listo | El owner activa `live` en /integrations (callable `channelConfigUpdate`), solo permitido si Meta `active` + número elegido. |

## 3. Orden exacto de pasos para el go-live (cuando se decida)
1. **Meta Developer:** crear/usar la app de Meta; agregar el producto WhatsApp; crear la **configuración de Embedded Signup** (define los scopes `whatsapp_business_messaging` + `whatsapp_business_management`). Anotar `APP_ID` y `CONFIG_ID`.
2. **Verificar el dominio** del panel en Meta App Settings (Business Verification si aplica).
3. **App Review / Advanced Access** para los scopes de WhatsApp (y solo esos por ahora). Mientras tanto, iterar con **test users/test business**.
4. **Secrets backend (prod):** setear `META_APP_ID`, `META_APP_SECRET`, `WHATSAPP_APP_SECRET` (= App Secret), `WHATSAPP_WEBHOOK_VERIFY_TOKEN` (string propio), `TENANT_SECRETS_ENCRYPTION_KEY` (32+ chars, **definitiva**, no rotar luego). Preferible vía `firebase functions:secrets:set` + `defineSecret`.
5. **Env frontend (prod):** `NEXT_PUBLIC_META_APP_ID` y `NEXT_PUBLIC_META_CONFIG_ID` (y `NEXT_PUBLIC_META_GRAPH_VERSION` si se cambia de v19.0).
6. **Deploy** functions + web. Obtener la URL real de `metaWebhook`.
7. **Configurar el webhook en Meta:** Callback URL = `https://us-central1-<PROJECT_ID>.cloudfunctions.net/metaWebhook`, Verify Token = el de paso 4, suscribir el objeto `whatsapp_business_account`.
8. **Smoke con una empresa de prueba:** conectar por Embedded Signup → verificar (`verifyMetaChannel`) → elegir número → enviar un inbound real → confirmar respuesta outbound → recién ahí activar `live`.
9. **Recién entonces** habilitar a clientes reales.

## 4. Riesgos
- ⛔ **App en development / dominio sin verificar / App Review pendiente** → el Embedded Signup falla o solo funciona para testers. (No es gateable en código; es setup de Meta.)
- ⚠️ **Secrets en `process.env`** (no Secret Manager) → si no se proveen en el runtime de prod, el OAuth y la firma del webhook fallan. Migrar a `defineSecret`.
- ⚠️ **`TENANT_SECRETS_ENCRYPTION_KEY`**: elegir el valor definitivo antes de cifrar tokens reales; rotarla obliga a re-cifrar todo.
- ⚠️ **Dos nombres para el App Secret** (`META_APP_SECRET` vs `WHATSAPP_APP_SECRET`): setear ambos al mismo valor o unificar, o la firma del webhook / el OAuth quedan a medias.
- ⚠️ **Costos/límites de WhatsApp**: la Cloud API cobra por conversación y tiene rate limits + ventana de 24 h para mensajes de servicio; los límites por plan ya se gatean (`maxWhatsappMessagesPerMonth`), pero el costo en Meta es aparte.
- ✅ **Tokens**: no se exponen ni loguean; cifrados en reposo. Sin riesgo conocido en código.

_No se implementó nada en esta fase: es auditoría + plan. La conexión real se hace siguiendo el orden de §3._
