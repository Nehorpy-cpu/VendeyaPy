# Plan de release — Tres programas EN REPO (ADR-0020 + ADR-0021 + ADR-0022)

> **Programa:** RELEASE-AUDIT-TRES-PROGRAMAS-1 · 2026-08-18 · READ-ONLY — **este documento NO
> autoriza ningún deploy**; el deploy es un programa aparte con gate explícito del owner.
> Precedente de formato: `docs/ai-vision-release-plan.md`.

## 1. Baseline de producción (medida READ-ONLY el 2026-08-18, no asumida)

| Superficie | Valor medido | Fuente |
|---|---|---|
| Functions | **118 ACTIVE** | `firebase functions:list --project vpw-prod-dd6ff --json` |
| Último deploy | **2026-08-16T00:35Z** — exactamente **10 funciones** actualizadas ese día (las 10 de DEPLOY-AI-PHASE2, ejecutado desde `6f75601`) y **ninguna posterior** en las 118 | GCF v2 API, `updateTime` por función |
| Schedulers | **8** (`aiReservationMaintenance`, `attachmentRetentionMaintenance`, `coverageMaintenanceDaily`, `metaCatalogOutboxMaintenance`, `metaCatalogVerificationMaintenance`, `refreshGrowthJobsDaily`, `resetUsageMonthly`, `trialNotificationsDaily`) — ESTADO decía «7 ⚠️ verificar»: **eran 8** | functions:list, `scheduleTrigger` |
| Índices Firestore | **21, todos READY, cero pendientes** (el repo declara exactamente 21 ⇒ **cero índices de consulta nuevos** en este release) | Firestore Admin API, `indexes` |
| Políticas TTL | **3 ACTIVE** (`metaWebhookAppState/History/Shadow` sobre `expiresAt`). El repo declara **4**: falta **`metaOAuthStates.expiresAt`** — el ÚNICO delta de infraestructura Firestore del release (ADR-0020, commit `3ba67dd`) | Firestore Admin API, `fields?filter=ttlConfig:*` |
| Rules (Firestore/Storage) | Los tres commits **no tocan ninguna** (verificado por archivo en `3ba67dd`/`71ffad4`/`cf7da74`) ⇒ fuera del release. El hash vigente de prod no se re-leyó en esta sesión (sin impacto en el plan) | `git show --name-only` |
| Precondición ADR-0017 | `automationMode` **crudo `live` en asset E índice** para los 2 números que rutean inbound — gate del audit **aprobado** | release-audit, lectura de prod |

**Commit base confirmado contra producción:** `6f75601`. Triangulación: prod dice «último
deploy 2026-08-16, 10 funciones»; la bitácora registra ese deploy como DEPLOY-AI-PHASE2 desde
`6f75601`; git muestra que después de `6f75601` solo vienen los 3 commits de programas + 2 de
docs, todos EN REPO. Con esa confirmación se corrigió `COMMIT_BASE_DESPLEGADO` en
`release-audit.mjs` (`'30c1687'` → `'6f75601'`, §4.1 — único cambio de código del programa).

## 2. El cálculo y su verificación (release-audit con base corregida)

`node scripts/release-audit.mjs --project vpw-prod-dd6ff --json` → **veredicto OK, cero
bloqueos**. Verificaciones internas y externas, todas en números:

- Exports de `index.ts`: **139**, con coincidencia EXACTA entre fuente `.ts` y compilado
  `lib/index.js` (la vía por-línea habría perdido 31 nombres — el motivo de existir del script).
- Grafo: 294 archivos fuente, **46 módulos cambiados + 11 nuevos** vs `6f75601`; **0
  divergencias** entre grafo fuente y compilado; **0 imports sin resolver**; partición completa.
- **Contraste obligatorio (§4.2): los nombres del selector que NO existen en prod son
  exactamente 20 == las 20 CREATE calculadas.** Coincidencia uno a uno verificada.
- `ausentesEnProdPorDiseño`: `devRunMetaCatalogOutbox` (excluida por construcción del selector).
- Los tests unitarios que el encabezado del script menciona (`tests/integration/
  release-audit.*.test.ts`) **NO existen en el repo** — deuda honesta del script, no de este plan.

## 3. Superficie exacta

### 3.1 Hallazgo crítico: el audit devuelve 20 CREATE, no 14 — 6 son de Coexistence

El CREATE es por **membresía contra producción**, no por diff contra la base: los exports de la
fundación de Coexistence (2026-08-04/05, EN REPO, **Programa 2 detenido fail-closed** por 5
gates externos de Meta sin evidencia) nunca se desplegaron y siguen exportados. Un `--only` que
copie el selector crudo del audit **crearía en producción**: `coexistenceConnect`,
`coexistenceDecideHistorySharing`, `coexistenceRequestHistorySync`,
`coexistenceRetentionMaintenance` (scheduler), `coexistenceStart`, `coexistenceSyncStatus`.

**Este plan las EXCLUYE del selector.** Pertenecen al release de Coexistence cuando su programa
se destrabe. Es además la razón por la que `--only functions` a secas sigue prohibido.

### 3.2 CREATE del release (14), por programa

| Programa | CREATE |
|---|---|
| ADR-0020 (`3ba67dd`) | `completeMetaConnectWaba` |
| ADR-0021 (`71ffad4`) | `conversationArchive`, `conversationAssign`, `conversationCreateClient`, `conversationLinkClient`, `conversationMarkRead`, `conversationRestore`, `conversationSendAttachment`, `conversationSoftDelete`, `conversationUnarchive`, `conversationUnlinkClient`, `customerSearch` |
| ADR-0022 (`cf7da74`) | `metaCatalogAuthorityPreview`, `metaCatalogAuthorityApply` |

### 3.3 UPDATE: **las 118 funciones desplegadas** (sinCambio = 0) — y por qué es honesto

Los tres programas tocaron módulos **universales**: `lib/firebase.ts` (paths nuevos de
conversaciones y runs de autoridad) y `audit/audit.ts` (acciones nuevas) están en el cierre
transitivo de TODAS las funciones. El release es, de hecho, **un redeploy completo de prod + 14
CREATE**. Consecuencias prácticas: mismo artefacto compilado para todo, ventana de cold-starts
general, y los reintentos por 429 de cuota del deploy van a activarse (ya está previsto en el
runbook §5). DELETE: **cero**.

Nota: ~21 funciones `dev*` existen en prod protegidas por `devGuard` (404 fuera del emulador);
entran al UPDATE como cualquier otra. `devMessage` incluida — quedará por fin alineada con HEAD.

## 4. Selectores literales (copiables) y orden de deploy

Comandos según runbook §5 — siempre `--project` explícito (el default de `.firebaserc` es
`vpw-dev`) y `--config firebase.functions.json`. **El deploy real exige el gate del owner.**

### Paso 0 — TTL de `metaOAuthStates` (único delta Firestore; primero, por invariante)

```
firebase deploy --only firestore:indexes --project vpw-prod-dd6ff
```

Idempotente sobre los 21 índices y los 3 TTL ya ACTIVE; agrega el fieldOverride de
`metaOAuthStates`. Verificar READY/ACTIVE antes de seguir.

### Paso 1 — Functions, lote A (123: 14 CREATE + 109 UPDATE; consumidores primero)

Incluye `onWebhookInbox` (CONSUMIDOR del inbox: debe poder procesar los payloads nuevos de
recibos ANTES de que el productor los escriba). Excluye `metaWebhook` y los 8 schedulers.

```
firebase deploy --only functions:adminAddWhatsappNumber,functions:adminDeactivateWhatsappNumber,functions:adminOrderCorrect,functions:adminSetManualWhatsappConnection,functions:agentConfigUpdate,functions:agentTestCaseDelete,functions:agentTestCaseRun,functions:agentTestCaseUpsert,functions:askInternalGrowthAssistant,functions:attachmentGetViewUrl,functions:attachmentMarkAsReceipt,functions:attachmentUnmarkReceipt,functions:cancelWhatsappActivationRequest,functions:categoryDelete,functions:categoryUpsert,functions:channelConfigUpdate,functions:chatRelease,functions:chatTakeover,functions:checkoutConfigUpdate,functions:completeMetaConnectWaba,functions:completeOnboarding,functions:connectMeta,functions:conversationArchive,functions:conversationAssign,functions:conversationCreateClient,functions:conversationLinkClient,functions:conversationMarkRead,functions:conversationRestore,functions:conversationSendAttachment,functions:conversationSendManualMessage,functions:conversationSoftDelete,functions:conversationUnarchive,functions:conversationUnlinkClient,functions:coverageApprove,functions:coverageFlowState,functions:coverageQuoteAndApprove,functions:coverageQuoteAttemptState,functions:coverageQuoteResolveUnknown,functions:coverageReject,functions:coverageRequestInfo,functions:createPayPalSubscriptionSession,functions:customerSearch,functions:deliveryPersonDelete,functions:deliveryPersonUpsert,functions:devComputeAttribution,functions:devComputeTracking,functions:devConfirmPayment,functions:devGenerateAudits,functions:devGenerateFollowups,functions:devGenerateInsights,functions:devGenerateSuggestions,functions:devGenerateWinningReplies,functions:devMessage,functions:devMetaConnect,functions:devMetaDisconnect,functions:devProcessConversions,functions:devRecomputeScores,functions:devRecomputeStats,functions:devReleaseChat,functions:devRunCoverageMaintenance,functions:devSimulateInbound,functions:devSubmitComprobante,functions:devSyncCatalogToMeta,functions:devSyncMetaAds,functions:devTakeoverChat,functions:generateTrialNotifications,functions:healthCheck,functions:inviteUser,functions:manualBillingActivate,functions:manualBillingCancelRequest,functions:metaCatalogAuthorityApply,functions:metaCatalogAuthorityPreview,functions:metaCatalogConfirmMapping,functions:metaCatalogImportItems,functions:metaCatalogImportRun,functions:metaCatalogImportStatus,functions:metaCatalogMaintenanceRun,functions:metaCatalogMaintenanceStatus,functions:metaCatalogOutboxDiscard,functions:metaCatalogOutboxIncidents,functions:metaCatalogOutboxReconcile,functions:metaCatalogOwnershipMigrationRun,functions:metaCatalogOwnershipMigrationStatus,functions:metaCatalogOwnershipStatus,functions:metaCatalogQualitySummary,functions:metaCatalogReconcilePlan,functions:metaCatalogSetSyncEnabled,functions:metaCatalogVerificationRun,functions:metaCatalogVerificationStatus,functions:metaDisconnect,functions:onAiVisionJob,functions:onAiVisionProducer,functions:onCoverageResumeJob,functions:onOrderWriteStats,functions:onProductWriteAudit,functions:onWebhookInbox,functions:orderCancel,functions:orderGetComprobanteViewUrl,functions:orderUpdate,functions:orderUpdateStatus,functions:paypalBillingWebhook,functions:platformBillingWebhook,functions:productDelete,functions:productUpsert,functions:promotionDelete,functions:promotionUpsert,functions:provisionTenant,functions:registerTenantOwner,functions:requestManualPlanActivation,functions:requestWhatsappActivation,functions:runTenantJob,functions:selectMetaPhoneNumber,functions:setUserActive,functions:setUserRole,functions:simulateAgentMessage,functions:startMetaConnect,functions:stripeWebhook,functions:syncPayPalSubscription,functions:trackingSourceDelete,functions:trackingSourceUpsert,functions:verifyMetaChannel,functions:winningReplyDelete,functions:winningReplyUpsert --config firebase.functions.json --project vpw-prod-dd6ff
```

### Paso 2 — `metaWebhook` (PRODUCTOR del inbox, después del consumidor)

```
firebase deploy --only functions:metaWebhook --config firebase.functions.json --project vpw-prod-dd6ff
```

### Paso 3 — Schedulers (los 8, al final, por runbook)

```
firebase deploy --only functions:aiReservationMaintenance,functions:attachmentRetentionMaintenance,functions:coverageMaintenanceDaily,functions:metaCatalogOutboxMaintenance,functions:metaCatalogVerificationMaintenance,functions:refreshGrowthJobsDaily,functions:resetUsageMonthly,functions:trialNotificationsDaily --config firebase.functions.json --project vpw-prod-dd6ff
```

### Rollback (los mismos 118 UPDATE, **sin ninguna CREATE**)

Una CREATE en el selector de rollback aborta el comando entero (`firebase deploy` falla porque
el export no existe en el código anterior). Desde el worktree/checkout de `6f75601`:

```
firebase deploy --only functions:adminAddWhatsappNumber,functions:adminDeactivateWhatsappNumber,functions:adminOrderCorrect,functions:adminSetManualWhatsappConnection,functions:agentConfigUpdate,functions:agentTestCaseDelete,functions:agentTestCaseRun,functions:agentTestCaseUpsert,functions:aiReservationMaintenance,functions:askInternalGrowthAssistant,functions:attachmentGetViewUrl,functions:attachmentMarkAsReceipt,functions:attachmentRetentionMaintenance,functions:attachmentUnmarkReceipt,functions:cancelWhatsappActivationRequest,functions:categoryDelete,functions:categoryUpsert,functions:channelConfigUpdate,functions:chatRelease,functions:chatTakeover,functions:checkoutConfigUpdate,functions:completeOnboarding,functions:connectMeta,functions:conversationSendManualMessage,functions:coverageApprove,functions:coverageFlowState,functions:coverageMaintenanceDaily,functions:coverageQuoteAndApprove,functions:coverageQuoteAttemptState,functions:coverageQuoteResolveUnknown,functions:coverageReject,functions:coverageRequestInfo,functions:createPayPalSubscriptionSession,functions:deliveryPersonDelete,functions:deliveryPersonUpsert,functions:devComputeAttribution,functions:devComputeTracking,functions:devConfirmPayment,functions:devGenerateAudits,functions:devGenerateFollowups,functions:devGenerateInsights,functions:devGenerateSuggestions,functions:devGenerateWinningReplies,functions:devMessage,functions:devMetaConnect,functions:devMetaDisconnect,functions:devProcessConversions,functions:devRecomputeScores,functions:devRecomputeStats,functions:devReleaseChat,functions:devRunCoverageMaintenance,functions:devSimulateInbound,functions:devSubmitComprobante,functions:devSyncCatalogToMeta,functions:devSyncMetaAds,functions:devTakeoverChat,functions:generateTrialNotifications,functions:healthCheck,functions:inviteUser,functions:manualBillingActivate,functions:manualBillingCancelRequest,functions:metaCatalogConfirmMapping,functions:metaCatalogImportItems,functions:metaCatalogImportRun,functions:metaCatalogImportStatus,functions:metaCatalogMaintenanceRun,functions:metaCatalogMaintenanceStatus,functions:metaCatalogOutboxDiscard,functions:metaCatalogOutboxIncidents,functions:metaCatalogOutboxMaintenance,functions:metaCatalogOutboxReconcile,functions:metaCatalogOwnershipMigrationRun,functions:metaCatalogOwnershipMigrationStatus,functions:metaCatalogOwnershipStatus,functions:metaCatalogQualitySummary,functions:metaCatalogReconcilePlan,functions:metaCatalogSetSyncEnabled,functions:metaCatalogVerificationMaintenance,functions:metaCatalogVerificationRun,functions:metaCatalogVerificationStatus,functions:metaDisconnect,functions:metaWebhook,functions:onAiVisionJob,functions:onAiVisionProducer,functions:onCoverageResumeJob,functions:onOrderWriteStats,functions:onProductWriteAudit,functions:onWebhookInbox,functions:orderCancel,functions:orderGetComprobanteViewUrl,functions:orderUpdate,functions:orderUpdateStatus,functions:paypalBillingWebhook,functions:platformBillingWebhook,functions:productDelete,functions:productUpsert,functions:promotionDelete,functions:promotionUpsert,functions:provisionTenant,functions:refreshGrowthJobsDaily,functions:registerTenantOwner,functions:requestManualPlanActivation,functions:requestWhatsappActivation,functions:resetUsageMonthly,functions:runTenantJob,functions:selectMetaPhoneNumber,functions:setUserActive,functions:setUserRole,functions:simulateAgentMessage,functions:startMetaConnect,functions:stripeWebhook,functions:syncPayPalSubscription,functions:trackingSourceDelete,functions:trackingSourceUpsert,functions:trialNotificationsDaily,functions:verifyMetaChannel,functions:winningReplyDelete,functions:winningReplyUpsert --config firebase.functions.json --project vpw-prod-dd6ff
```

## 5. ¿Un release o secuenciado? — UNO, en los 4 pasos de arriba

Los tres programas **no se pisan**: el único solapamiento de código entre `71ffad4` y `cf7da74`
es aditivo (`audit/audit.ts` + `index.ts`); `metaWebhook`/`onWebhookInbox` los toca solo
ADR-0021 y los schedulers solo ADR-0022. Como además el UPDATE es total (§3.3), separar los
programas en ventanas distintas NO reduce superficie — la triplicaría (tres redeploys de las
mismas 118) y multiplicaría las ventanas de estado mixto. **Un solo release ordenado es la
opción de menor riesgo.**

## 6. ¿Qué se puede desplegar SIN Hosting? — TODO el backend (§4.4), con evidencia

**Hosting está congelado por la App Review de Meta** (gate externo). La pregunta es si el
backend puede ir solo dejando el panel viejo intacto. Respuesta: **sí, es apto**, con esta
evidencia y tres divergencias documentadas:

1. **Ninguna función nueva es consumida por el panel desplegado**: `git grep` de los 14 nombres
   CREATE sobre `6f75601 -- apps/web` = **0 referencias**. Backend-first es inerte: callables
   que nadie invoca hasta que Hosting se destrabe.
2. **Los contratos que el panel viejo SÍ consume son aditivos o equivalentes**:
   `metaCatalogOwnershipStatus` conserva todos sus campos previos y AGREGA el bloque `authority`
   (verificado en el callable; el panel viejo ignora campos desconocidos);
   `conversationSendManualMessage` conserva petición/respuesta — sus guards nuevos
   (`softDeleted` bloquea, archivada desarchiva) solo actúan sobre flags que **ningún dato de
   prod tiene** hasta que alguien use las callables nuevas; los campos nuevos en
   mensajes/clientes (`deliveryStatus`, `profileName`) son aditivos y el panel viejo los ignora;
   los gates de catálogo por relación DERIVAN el estado legacy: arfagi (external+mirror) conserva
   import/reconcile/verificación y su dry-run, y el opt-in ya estaba bloqueado por ownership.
3. **Divergencias honestas (las tres en flujos que hoy nadie ejercita)**: (a) un tenant SIN
   config de catálogo que dispare `catalogSync` recibiría `failed-precondition` en vez del
   `{status:'disabled'}` amable — en el panel viejo sería un toast de error; hoy solo arfagi usa
   catálogo; (b) una RECONEXIÓN de Meta con 2+ WABAs devolvería `waba_selection_required`, que el
   panel viejo muestra como error traducido sin el modal nuevo — la reconexión está congelada de
   todos modos por el App Review; (c) `catalogSyncApply` invocado por un MANAGER vía API directa
   pasa de permitido a denegado — la UI vieja ya lo escondía para ese rol (cierre de una
   asimetría real, no una regresión).

**Condición de validez** (invariante §4.4): ninguna de las divergencias toca un flujo alcanzable
por el uso real actual de `arfagi` o `meta-review`. Si el owner considera que (a)–(c) violan el
«byte-funcionalmente igual», la alternativa fail-closed es esperar el App Review y desplegar
todo junto. **La decisión es del programa de deploy, no de este plan.**

**El release queda entonces partido en dos tramos independientes:**
- **Tramo 1 (sin gate de Meta): Pasos 0–3** — todo el backend.
- **Tramo 2 (bloqueado por App Review): Hosting** — 48 archivos de panel entre los tres
  programas (6 de ADR-0020, 31 de ADR-0021, 11 de ADR-0022), con el procedimiento del runbook
  §5 (env temporal de 9 claves + verificación de chunks) cuando Meta libere el gate.

## 7. Gates externos y qué necesita cada uno

| Gate | Bloquea | Se destraba con |
|---|---|---|
| App Review de Meta (tenant `meta-review` congelado) | Tramo 2 (Hosting) | Cierre de la revisión de Meta — externo, sin fecha |
| Feed de arfagi en HTTP 403 | **Nada de este release** (la autoridad de catálogo se despliega derivando el estado actual; no activa nada) — bloquea el programa de VISIÓN, no este | El owner arregla credenciales/URL del feed en su plataforma |
| Precondición `automationMode` del audit | Ya aprobada (2/2 números `live` crudo en asset e índice) | — |

## 8. Riesgo de rollback de las 14 CREATE (§4.5)

El rollback por selector **no revierte funciones creadas**: tras un rollback quedarían vivas 14
funciones nuevas apuntando al artefacto nuevo. Evaluación una a una: **las 14 son callables**
(cero triggers, cero schedulers nuevos) protegidas por autenticación + rol
(staff/owner/PLATFORM_ADMIN) — **inertes salvo invocación directa autenticada**. Matices:

- Las 11 de conversaciones MUTAN datos reales si un staff las invoca a mano (archivar, soft
  delete, vincular, enviar adjuntos) — todo auditado, reversible y tenant-scoped; sin panel que
  las exponga, el riesgo práctico es bajo.
- `metaCatalogAuthorityPreview/Apply` requieren OWNER y un preview fresco; jamás tocan Meta.
- `completeMetaConnectWaba` exige un flujo de conexión pendiente vigente.

**Retiro real** (si un rollback debiera ser total): `firebase functions:delete <nombre>
--project vpw-prod-dd6ff` una por una — operación destructiva, EXIGE su propio gate del owner y
NO se ejecuta desde este plan.

## 9. Lo que este plan NO valida

- El build/env de Hosting (Tramo 2): el procedimiento §5 con las 9 claves se verifica recién en
  su deploy.
- El comportamiento runtime post-deploy: los smokes (recibos reales, adjunto saliente, cambio de
  autoridad en dry-run) pertenecen al programa de deploy con su gate.
- El hash de Rules vigente en prod (no se re-leyó; irrelevante: este release no toca Rules).
- Config/entitlements por tenant (sin cambios en los tres commits).
- El costo/latencia del redeploy total (118 funciones re-desplegadas: cold starts + 429 con
  reintentos automáticos — previsto pero no medido acá).
- Los tests del propio `release-audit` (no existen — ver §2).
