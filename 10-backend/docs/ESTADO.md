# ESTADO — VendeYaPy

> **Última actualización: 2026-08-18.**
> Este archivo describe el **presente**, no la historia. La historia vive en `BITACORA.md`.
> Se reescribe, no se acumula. Máximo una página.
> `⚠️ verificar` = dato derivado de la bitácora, no leído de producción en la última sesión.

## Identidad

- **Proyecto:** VendeYaPy — SaaS multi-tenant de ventas por WhatsApp en Paraguay.
- **Repositorio:** `Nehorpy-cpu/VendeyaPy`, monorepo en `C:\AI_AFG\10-backend`.
- **Stack:** Next.js, TypeScript, Firebase (Auth/Firestore/Storage/Functions), WhatsApp Cloud
  API, Anthropic Claude, pnpm workspaces.
- **Producción:** `vpw-prod-dd6ff` · panel en `https://vendeyapy.com`.
- **Tenants:** `arfagi` (real, activo) · `credipower` (diferido e intocable) ·
  `meta-review` (número …5686, de revisión de Meta).

## Producción hoy

| Superficie | Estado |
|---|---|
| Último commit desplegado | `6f75601` — DEPLOY-AI-PHASE2-SALES-RESERVATION-1 (2026-08-16Z) |
| Functions | 118 ACTIVE ⚠️ verificar (115→118 el 2026-08-15; Fase 2 fue 10 UPDATE / 0 CREATE / 0 DELETE) |
| Índices | 21 READY (18→21 el 2026-08-15, 3 `ai*`) |
| Rules hash | `132712ca` (desde `a9c99e05`, 2026-08-15) |
| Schedulers | 7, sin invoker público ⚠️ verificar |
| WhatsApp | `automationMode: live` en …7904 (arfagi) y …5686 (meta-review) |

**Rollbacks armados y conservados:** `bdaffbe` y `30c1687`.

## Flags e interruptores por tenant

| Flag | arfagi | credipower | meta-review |
|---|---|---|---|
| Visión de productos (ADR-0019) | AUSENTE (apagada) | AUSENTE | AUSENTE |
| Coverage | ACTIVO — `required`, máx ₲200.000, exp. 24 h | apagado | — |
| `attachments.ingest.enabled` | `true` | documento AUSENTE | — |
| `receiptGate.enabled` | `true` | documento AUSENTE | — |
| Purga de adjuntos | APAGADA | — | — |
| Meta Catalog `mode` | `dry_run` | sin config | — |
| Meta Catalog propiedad | `external_managed`, cero campos escribibles | — | — |

## Catálogo Meta

El catálogo de Meta lo gobierna **al 100 % un feed diario del sitio del tenant**
(`primary_feed` `1668013347585391`, `deletion_enabled: true`, Server Fetch diario 03:33
America/Asuncion desde `api.arfagi.com`). 181 artículos. El feed **no se toca, no se ejecuta
a mano y no se desactiva**. Nunca escribimos en Meta: una sola escritura en toda la historia
del proyecto (canary de Odyssey, 2026-07-28, revertido por el feed 36 h después).

Reconciliación 04:30 y 16:30 America/Asuncion contra TTL de 24 h, solo lectura.

## Bloqueantes abiertos

1. **Precio de Odyssey en el origen del feed — PRIORIDAD 0, fuera de este repo.**
   El feed publica ₲130.000, el precio autoritativo local es ₲250.000. Mientras diverja,
   Odyssey queda `drifted_external` y el guard **no cierra venta automática** de ese producto.
   La corrección va en el sistema que genera el CSV, no en Meta ni en este repo. Tras la
   publicación siguiente (03:23-03:24), la reconciliación de las 04:30 debe devolverlo a
   `verified` — esa es la prueba final de que el modelo de propiedad funciona.
2. **Fase 3 sin evidencia.** Todas las pruebas end-to-end salieron de números del owner.
   Falta el ciclo completo con un número **externo**: inbound real → bot → carrito → orden →
   comprobante visible en el panel → logs limpios.
3. **Activación de visión.** Desplegada e inerte desde el 2026-08-15, re-canary exitoso.
   Activarla es un programa aparte y depende de (1) y de la calibración del matcher.
4. **Coexistence, Programa 2.** Detenido fail-closed en el preflight del 2026-08-06: 5 gates
   externos de Meta sin evidencia (incluida la elegibilidad de Paraguay, que Meta no
   documenta) y el `config_id` de Coexistence sin crear. El bloqueo por ADC quedó resuelto
   el 2026-08-15 cuando el owner la habilitó.
5. **Rotación de los 4 secretos de staging — NO EJECUTADA.** Deploys anteriores a
   RELEASE-SECURITY-AND-RUNBOOK-HARDEN-1 subieron `.env.vpw-staging` al bucket de fuentes de
   prod. La fuga es interna (bucket no público, valores distintos por entorno), pero quedan
   109 versiones vivas construidas con ese `.env`, no borradas.
6. **`releaseToBot` destruye el estado de checkout (ALTO, sin programa asignado).**
   El botón "devolver al asistente" escribe `state: 'IDLE'` incondicionalmente y borra el
   `AWAITING_PAYMENT`; desde ahí el receipt gate deniega con `no_explicit_payment_context`.
   Reproducido en producción. Contraste que acota el arreglo: la liberación automática de
   cobertura (`coverageResume.liberarSesionGuardado`) está bien hecha y no toca `state`.

## En repo, sin desplegar

| Programa | Fecha | Superficie estimada del release |
|---|---|---|
| Coexistence (fundación + correctivos) | 2026-08-04/05 | Cutover = Programa 2, bloqueado |
| META-ONBOARDING-SELF-SERVICE-1 (ADR-0020) | 2026-08-17 | 1 CREATE + updates meta-connect + índices TTL + Hosting |
| CONVERSATIONS-WHATSAPP-UX-1 (ADR-0021) | 2026-08-18 | 11 CREATE + updates webhook/manualMessage/adjuntos + Hosting; sin índices/Rules/TTL |
| CATALOG-AUTHORITY-SELF-SERVICE-1 (ADR-0022) | 2026-08-18 | 2 CREATE + updates metaCatalog*/runTenantJob/schedulers + Hosting; sin índices/Rules |

## Deudas menores conocidas

- La campana no lleva `targetUid`: un rol SELLER puro no la ve. Hoy sin impacto (el vendedor
  configurado es el owner).
- 4 secretos productivos siguen como env vars planas en vez de Secret Manager, contra la
  política escrita del propio repo.
- Higiene de logs: el `customerId` completo (el teléfono) va en metadata estructurada.
- La tarjeta de propiedad del catálogo muestra la fuente sin nombre, sin horario y sin avisar
  que el feed borra de Meta lo que no publica (`deletion_enabled: true`).
- `metaSyncState` no se recalcula al editar un producto: un importado enriquecido arrastra
  `drifted_external` hasta la reconciliación siguiente (máx. ~12 h).
- Pendientes de calidad de catálogo: 23 genéricos, 18 duplicados probables, 33 incoherencias,
  1 sin marca.
- Pedidos: 15 históricos, 14 CANCELLED y 1 PAID anterior a los releases de julio. Cero pagos
  nuevos. Ningún pedido pendiente de verificación.

## Backlog (solo a pedido del owner)

Fase 5 — Operación (runbook del owner, backups semanales, alertas de presupuesto GCP y de
errores de functions) · AI-PROMPT-CACHING-1 · cortesía determinística · AI-USAGE-ATTRIBUTION-1 ·
Meta Catalog Live · `CATALOG-IMPORT-1` (CSV/Excel/Sheets) · `CATALOG-ENRICHMENT-3` ·
`META-ADS-GROWTH` · integración genérica con CRM.

## Criterio de cierre del proyecto

Una persona externa completa el ciclo entero sin intervención técnica: WhatsApp →
recomendación → carrito → orden → comprobante → el vendedor lo ve y lo confirma en el panel
desde `vendeyapy.com`.
