# Onboarding manual de WhatsApp (WM-1 · WM-2)

Camino alternativo cuando Embedded Signup / App Review / Business Verification de Meta están
demorados o bloqueados: un **PLATFORM_ADMIN** carga manualmente la conexión de WhatsApp de un cliente.
Reusa el **mismo modelo** que el Embedded Signup, así que el envío, los webhooks, el modo mock/live y
`metaDisconnect` funcionan idéntico.

> **Estado:** **WM-1** = el admin carga la conexión (`adminSetManualWhatsappConnection`). **WM-2** = el
> owner pide **activación asistida** desde el panel (`requestWhatsappActivation`) y el admin la ve/gestiona
> en su panel. El flujo end-to-end es: el owner solicita → el admin carga la conexión (WM-1) referenciando
> esa solicitud → la solicitud queda `completed`. Embedded Signup sigue igual y puede reemplazar la
> conexión manual del mismo tenant en cualquier momento.

## WM-2 — Solicitud del owner + panel del admin

**Flujo:**
1. **Owner** (panel → *Integración Meta*, cuando Embedded no está configurado): botón **"Solicitar activación
   asistida de WhatsApp"** → `requestWhatsappActivation` crea una solicitud `pending` en
   `tenants/{t}/whatsappActivationRequests/{id}`. **1 pending por empresa**. No toca `metaConnections` ni
   tokens. Solo el **TENANT_OWNER** (su empresa) o **PLATFORM_ADMIN** pueden solicitar; seller/manager/viewer no.
2. **Admin** (panel → *Ajustes → WhatsApp (admin)*, solo `PLATFORM_ADMIN`): ve las solicitudes pendientes
   (collectionGroup) y usa el form de carga manual (WM-1). Al enviar con `requestId`, la solicitud pasa a
   `completed` (best-effort: un requestId inválido nunca rompe la conexión ya escrita).
3. **Cancelar:** `cancelWhatsappActivationRequest` — el owner cancela solo la suya pendiente; el admin, cualquiera.

**Seguridad:** la solicitud **nunca** contiene el token (solo metadatos: nota/contacto/estado/phone id). El
token sigue el camino de WM-1 (cifrado en SecretStore, ver §3). La escritura de las solicitudes es **solo por
callable** (Admin SDK; rules `write:false`). El owner ve las suyas; el admin las lee vía `collectionGroup`
(regla + índice `whatsappActivationRequests` en `firestore.indexes.json`). El owner **no** puede cargar tokens:
el form de carga es exclusivo del panel admin.

## 1. Qué datos pedir al cliente
| Dato | Qué es | Requerido |
|---|---|---|
| **WABA ID** (`wabaId`) | id del WhatsApp Business Account | ✅ |
| **Phone Number ID** (`phoneNumberId`) | id **numérico interno** de Meta del número (NO el `+595…`) | ✅ |
| **Display phone number** (`displayPhoneNumber`) | el número visible (`+595 99 …`) | ✅ |
| **Access token** (`accessToken`) | token de acceso (ver §3) | ✅ |
| **Business ID / name** | opcionales (metadatos) | ❌ |
| **Token expiry** (`tokenExpiresAt`, epoch ms) | si el token expira | ❌ (ausente = sin expiración) |

## 2. Dónde conseguir `wabaId` y `phoneNumberId`
- **Meta Business Manager** → *WhatsApp Accounts* → la cuenta del cliente → ahí aparece el **WABA ID**.
- **Meta for Developers** → la App → *WhatsApp → API Setup*: muestra el **Phone number ID** (id numérico,
  ej. `109876543210987`) y el *display number*. ⚠️ El `phoneNumberId` es ese **id numérico**, NO el número
  con `+`. Cargar el número humano rompe la resolución del webhook (la validación lo rechaza).

## 3. Qué token usar
- Recomendado: **token de System User** de larga duración (o permanente) del Business del cliente, con los
  permisos `whatsapp_business_messaging` y `whatsapp_business_management`.
- Si el token **expira**, cargá `tokenExpiresAt` (epoch ms). Si es permanente, dejalo **ausente/null**.
- El token se guarda **cifrado** (AES-256-GCM) en el SecretStore; en Firestore solo queda `tokenSecretRef`.
  **Nunca** se loguea ni se muestra en el panel.

## 4. Cómo cargar la conexión (callable)
`adminSetManualWhatsappConnection` (solo PLATFORM_ADMIN):
```jsonc
{
  "tenantId": "<empresa>",
  "wabaId": "100000000000001",
  "phoneNumberId": "109876543210987",   // id numérico de Meta
  "displayPhoneNumber": "+595 99 123 4567",
  "accessToken": "<token>",             // va cifrado al SecretStore
  "tokenExpiresAt": 1893456000000        // opcional (epoch ms) o ausente
}
```
El callable: valida el input → chequea **colisión** del `phoneNumberId` (si pertenece a otra empresa, falla)
→ guarda el token cifrado → escribe `metaConnections/main` (estado inicial `pending_review`, `source: 'manual_admin'`)
→ escribe el asset `whatsapp_phone_number` (selected) + el índice global `metaExternalIndex/whatsapp_{pnid}`
→ **verifica** con Graph (debug_token + getPhoneNumber) y deja el estado **`active`** solo si el token valida.

## 5. Suscribir la app al WABA (recibir inbounds)
El alta intenta `subscribeApp(wabaId, token)` automáticamente (best-effort). **Si falla**, hay que
suscribir manualmente en Meta para que lleguen los mensajes entrantes:
- Meta for Developers → la App → *WhatsApp → Configuration*: configurar el **Callback URL** del webhook
  (`https://<functions>/metaWebhook`) y el **Verify Token** (`WHATSAPP_WEBHOOK_VERIFY_TOKEN`), y suscribir
  el campo **messages**. La WABA debe pertenecer a la **misma Meta App** cuyo `WHATSAPP_APP_SECRET` está
  configurado (si no, los inbounds se rechazan por firma).

## 6. Cómo verificar
- El callable devuelve `{ status, ready }`. `status: 'active'` + `ready: true` = el token validó y el número
  resolvió.
- En el panel, el owner ve el estado de la conexión (no el token). Para re-verificar: `verifyMetaChannel`.
- Si `status` queda `expired` / `permission_missing` / `error`: el token es inválido, le faltan permisos, o
  el número no resolvió — corregir y volver a cargar (es idempotente: reescribe limpio).

## 7. Cómo activar "respuestas reales" (live)
Una vez `status: 'active'` + número seleccionado, el **owner** activa el envío real desde *Integraciones →
Activar respuestas reales* (callable `channelConfigUpdate` con `whatsappSendMode: 'live'`). El gate solo deja
pasar si la conexión es resoluble (token vivo + número + creds). No depende del origen (manual o Embedded).

## 8. Riesgos: expiración / revocación
- **Expiración:** si el token vence (`tokenExpiresAt` en el pasado), el envío se bloquea silenciosamente
  (cae a mock). Recargar con un token nuevo.
- **Revocación:** si el cliente revoca el acceso en Meta, los envíos/inbounds fallan; re-verificar deja la
  conexión en `expired`/`error`. Recargar.
- **Colisión:** un `phoneNumberId` ya usado por otra empresa se rechaza (evita secuestrar webhooks).
- **Clave de cifrado:** el token se cifra con `TENANT_SECRETS_ENCRYPTION_KEY`. Rotar esa clave invalida
  todos los tokens guardados (manuales y Embedded) — requiere recarga.
- **Límite de plan:** se respeta `maxWhatsappNumbers` (igual que el flujo normal): si el plan no incluye
  números de WhatsApp, el alta falla.

## Desconectar
`metaDisconnect` (owner/admin) limpia la conexión manual igual que la de Embedded Signup: estado
`not_connected`, borra assets + índice + el secreto del token.

## Tests
- Unit: `apps/functions/src/meta/manualConnect.test.ts` (validación + orquestación con deps inyectables).
- E2E (emulador): `apps/functions/scripts/verify-wm1-manual.mjs` (auth, validación, escritura del modelo,
  token no legible, resoluble, colisión, disconnect). Requiere emuladores + build + el mismo
  `TENANT_SECRETS_ENCRYPTION_KEY` que el emulador.
