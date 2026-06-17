# ADR-0009 — Arquitectura de integración con Meta (omnicanal, webhooks, sync por jobs, tokens seguros)

**Fecha:** 2026-06-17
**Estado:** Aceptada (planificación; se implementa como **Track D**, modo manual→real)
**Decisores:** Owner del proyecto

---

## Contexto

El objetivo final del sistema es **conectarse a Meta Business Suite** y mostrar lo que Meta no
muestra: **qué campaña genera ventas reales y cuánta ganancia deja** (anuncio → conversación →
cliente → pedido → producto → vendedor → ganancia). El sistema debe centralizar **WhatsApp,
Instagram DM y Facebook Messenger**, leer **Meta Ads**, sincronizar el **catálogo** y enviar
eventos a la **Conversions API**. Meta está **bloqueado del lado del owner** por ahora
(verificación pendiente), así que todo se diseña para funcionar primero en **modo manual/demo** y
"enchufarse" cuando Meta apruebe.

Adaptación obligatoria: **Firebase/Firestore**, no SQL (ADR-0001). Multi-tenant `tenants/{tenantId}`
(ADR-0007). Costo bajo (ADR-0006).

## Decisión

1. **Tokens de Meta nunca en texto plano.** Se guardan en **Secret Manager** (o cifrados del lado
   servidor); en Firestore solo va una **referencia** (`tokenSecretRef`) + metadata (scopes, expiry,
   estado). El cliente nunca lee tokens. Conexión/refresh solo por Cloud Functions.
2. **Estructura por empresa:** `tenants/{t}/metaConnections`, `metaAssets`, `metaCampaigns`,
   `metaAdsets`, `metaAds`, `metaAdInsightsDaily`, `metaCatalogSyncLogs`, `businessEvents`,
   `metaConversionEvents`. Estados de conexión soportados: `not_connected, connected_limited,
   pending_review, permission_missing, active, error, expired, revoked` (visibles en el panel).
3. **Índice global para webhooks:** `metaExternalIndex/{platform_externalId}` → mapea un ID externo
   de Meta (ej. `whatsapp_123…`, `instagram_178…`) a su `tenantId`/`connectionId`. Permite saber a
   qué empresa pertenece un evento entrante.
4. **Webhooks robustos (recibir rápido, procesar después):** un endpoint HTTPS guarda el payload
   crudo en `metaWebhookInbox/{eventId}` (colección global, con `expiresAt` + **TTL** para limpieza),
   responde a Meta de inmediato, y procesa en segundo plano (Cloud Function por trigger de Firestore):
   resuelve empresa por `metaExternalIndex`, crea/actualiza conversación, guarda el mensaje y dispara
   bot/handoff. **No se procesa de forma síncrona dentro del webhook.**
5. **Omnicanal:** las conversaciones/mensajes llevan `channel` (`whatsapp|instagram|messenger`). El
   motor del bot actual (channel-agnostic, ADR-0003) se reusa; el webhook entrega al mismo motor.
6. **Meta Ads = solo lectura por jobs programados.** **No** se consulta Meta en cada carga del
   dashboard. Cloud Scheduler/Pub-Sub corre funciones que traen campañas/adsets/ads/insights y
   guardan **snapshots diarios** (`metaAdInsightsDaily`). Baja costo y evita rate limits.
7. **Catálogo: nuestro panel es la fuente primaria.** Meta Catalog **recibe** productos sincronizados
   desde nuestro sistema (`syncToMeta`, `metaCatalogId`, `metaProductItemId`, `metaSyncStatus`…),
   con logs (`metaCatalogSyncLogs`). La sync corre en Cloud Functions, nunca en el frontend.
8. **Atribución y CAPI:** primero una capa interna `businessEvents` (ViewContent, Lead, Contact,
   AddToCart, InitiateCheckout, Purchase) y la atribución anuncio→conversación→pedido→ganancia;
   después `metaConversionEvents` para enviar a la Conversions API (con consentimiento/privacidad).

## Por qué

Patrón estándar y barato para webhooks de alto volumen (inbox + proceso async + TTL), sin joins
SQL: todo por documentos/índices precalculados. Mantiene Meta desacoplado (si cae o falta permiso,
el panel sigue funcionando en modo manual). Protege datos sensibles (tokens fuera de Firestore).

## Relación con las fases F (track del bot)

Este ADR **absorbe y reordena** F1 (WhatsApp Cloud API) y F7 (Meta CAPI + catálogo + click-to-WA)
dentro del **Track D**. F1 pasa a ser el primer paso de "Webhooks + omnicanal"; F7 se reparte entre
"Catálogo→Meta", "Atribución" y "Conversions API". El **gate de verificación de Meta Business** sigue
vigente antes de producción de ads.

## Alcance

**Track D** (ver ROADMAP), después de terminar el núcleo del panel (P6–P9) y en paralelo posible con
Track C. Se construye en **modo manual/demo** y se conecta a Meta real al pasar el gate de verificación.
