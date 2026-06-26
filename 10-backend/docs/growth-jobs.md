# Jobs de growth — manuales vs automáticos

Los **jobs de growth** son funciones core (`panel/jobs.ts` → `runPanelJob`) que refrescan datos del panel. Se disparan por:

- **Manual:** botón del panel → callable `runTenantJob` (`functions/panel/panelActions.ts`). Autoriza por rol (owner/manager/admin) + entitlements, y mete cuota (`meter: 'jobs'`).
- **Automático:** scheduler diario `refreshGrowthJobsDaily` (`functions/scheduled/refreshGrowthJobs.ts`, **04:00 America/Asuncion**), solo para tenants `ACTIVE` (no demo, no borrados). Core compartido: `growth/scheduler.ts` (`refreshGrowthJobsForActiveTenants`). **No** mete cuota ni gates (es mantenimiento del sistema). Aísla errores por tenant/job y loguea solo metadata.

## Matriz

| Acción (`runTenantJob`) | Core | Manual (botón) | Automático (scheduler diario) | ¿Usa IA? |
|---|---|---|---|---|
| `computeTracking` | `tracking/tracking.ts` | ✅ Tracking → "Calcular atribución" | ✅ | ❌ agregación |
| `generateWinningReplies` | `replies/mine.ts` | ✅ Respuestas → "Buscar ganadoras" | ✅ | ❌ "Sin IA" |
| `generateFollowups` | `followups/generate.ts` | ✅ Seguimientos → "Actualizar tareas" | ✅ | ❌ reglas |
| `generateAudits` | `audits/generate.ts` | ✅ Agente → "Revisar ahora" | ✅ | ❌ "Sin IA" |
| `computeAttribution` | `meta/attribution.ts` | ⛔ oculto (Meta real) | ❌ excluido | ❌ agregación |
| `metaAdsSync` | `meta/ads.ts` | ⛔ demo | ❌ excluido | ❌ demo |
| `catalogSync` | `meta/catalog.ts` | ⛔ (Meta) | ❌ excluido | ❌ |
| `processConversions` | `events/businessEvents.ts` | ⛔ (Meta) | ❌ excluido | ❌ |

## Por qué el scheduler solo corre 4

Incluidos = **rule-based (sin Claude / sin IA)** y **sin dependencia de Meta/spend** → seguros para correr a diario sin riesgo de costo de IA. Lista en `growth/scheduler.ts` → `SCHEDULED_GROWTH_JOBS`.

Excluidos:
- `computeAttribution` / `metaAdsSync` / `catalogSync` / `processConversions`: dependen de Meta (spend/campaignId reales) que todavía no se ingieren; quedan para la fase de Meta go-live.
- `generateInsights` (generateAllInsights) y `generatePromotionSuggestions`: **no existen** como acción en `panel/jobs.ts` (no hay mapeo en `PANEL_JOB_ACTIONS`), así que ni el botón ni el scheduler los corren todavía.

## Costo

Todos los jobs del scheduler son **lecturas/escrituras de Firestore** (cero tokens de IA). El costo escala con #tenants ACTIVE × 4 jobs × tamaño de cada tenant (órdenes/clientes/mensajes). Cotas: `DEFAULT_MAX_TENANTS=500` por corrida y paginación de `PAGE_SIZE=200`. Cada job es idempotente (ids deterministas), así que correrlo a diario no duplica datos.

## Deploy

`refreshGrowthJobsDaily` es una **scheduled function** → requiere Cloud Scheduler habilitado en el proyecto, y **no** debe recibir `allUsers` `run.invoker` (queda privada, ver `deploy-readiness.md` §7.3). En el emulador el cron no se dispara solo; el test (`growth/scheduler.test.ts`) prueba el core directo.
