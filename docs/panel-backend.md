# Backend del panel — callables autenticados (Hardening F2)

Capa **segura** que reemplaza el uso de los endpoints `dev*` desde el frontend.
Hoy el panel llama `dev*` por `fetch`; en producción esos endpoints están en **404**
(devGuard, Fase 2 de productización). Esta capa es la que el frontend deberá usar
**en producción** (se cablea más adelante; en esta fase NO se tocó `apps/web`).

## Callables

### `runTenantJob({ action, tenantId? })`
Ejecuta una acción de mantenimiento del tenant. `action` ∈:

| action | Reemplaza el dev* | Función núcleo |
|---|---|---|
| `metaAdsSync` | `devSyncMetaAds` | `meta/ads.syncMetaAdsDemo` |
| `computeAttribution` | `devComputeAttribution` | `meta/attribution.computeAttribution` |
| `catalogSync` | `devSyncCatalogToMeta` | `meta/catalog.syncProductsToMetaDemo` |
| `generateFollowups` | `devGenerateFollowups` | `followups/generate.generateFollowUpTasks` |
| `generateAudits` | `devGenerateAudits` | `audits/generate.generateAgentAudits` |
| `computeTracking` | `devComputeTracking` | `tracking/tracking.computeTrackingAttribution` |
| `generateWinningReplies` | `devGenerateWinningReplies` | `replies/mine.generateWinningReplies` |
| `processConversions` | `devProcessConversions` | `events/businessEvents.backfill+send` |

Respuesta: `{ ok, action, tenantId, result }`.

### `simulateAgentMessage({ from, text })`
Simula un mensaje entrante al bot (página **Simulador**). Reemplaza `devMessage`.
Respuesta: `{ ok, reply, state }`.

## Autorización (rol + tenant)
Resuelta por `panel/auth.resolvePanelAuth` (pura, testeada):

- **PLATFORM_ADMIN** → cualquier empresa; **debe** pasar `tenantId`.
- **TENANT_OWNER / TENANT_MANAGER** → **solo su empresa**; cualquier `tenantId` pedido se **ignora** (anti cross-tenant).
- **SELLER / TENANT_VIEWER / sin rol** → **denegado** (`permission-denied`).

## Cómo lo llamará el frontend (más adelante)
Con el SDK de Firebase (callable autenticado, NO `fetch` a `dev*`):

```ts
import { getFunctions, httpsCallable } from 'firebase/functions';
const functions = getFunctions(app, 'us-central1');

// Acción de mantenimiento:
await httpsCallable(functions, 'runTenantJob')({ action: 'metaAdsSync' });

// Simulador del agente:
const { data } = await httpsCallable(functions, 'simulateAgentMessage')({ from: '+595…', text: 'hola' });
// data = { ok, reply, state }
```

> El frontend NO necesita pasar `tenantId` (sale del token del usuario). Solo un
> PLATFORM_ADMIN operando otra empresa lo pasa.

## Estado de los `dev*`
Siguen existiendo **solo para emulador / staging controlado** (devGuard: emulador
siempre; fuera, solo con `ENABLE_DEV_ENDPOINTS` + `x-internal-secret`). En producción → **404**.
Los seeds y `verify-*.mjs` los siguen usando contra el emulador.

## Fuera de alcance de F2 (pendiente)
- **Conexión Meta** (`devMetaConnect`/`Disconnect`): va con el flujo OAuth real
  (`meta/oauth.connectMetaReal`) — se aborda con WhatsApp/Meta por tenant.
- **stats / scores / insights / suggestions**: pasarán a **jobs programados** (Cloud
  Scheduler) en una fase posterior; el disparo manual del panel usará `runTenantJob`
  cuando se agreguen esas acciones.
- **Cableado del frontend**: lo hace el owner; esta capa queda lista y documentada.
