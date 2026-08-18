# ESTADO — VendeYaPy

> **Última actualización: 2026-08-18** (corregido el mismo día: feed 403, congelamiento de Hosting y deudas sistémicas verificadas contra el repo).
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
  `meta-review` (número …5686) — **App Review de Meta EN CURSO: entorno CONGELADO**, no tocar
  Hosting ni nada que Meta esté revisando.

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

1. **FEED ROTO (HTTP 403) en el origen de arfagi — PRIORIDAD 0, fuera de este repo.**
   **Diagnóstico corregido el 2026-08-18** (antes se registraba como simple divergencia de
   precio): `api.arfagi.com` devuelve **HTTP 403 desde ≤2026-08-14** y el último run del feed en
   Meta cerró con **0 items / 1 error**. No es una diferencia de precio: **el feed no publica
   nada**. Odyssey (`ARM-744646-5202`) tiene precio local **₲190.000** (intención comercial
   declarada del owner) contra **₲130.000 obsoleto en Meta**; el guard lo mantiene
   `drifted_external` y **no cierra venta automática** — fail-closed correcto.
   **Acción del owner, fuera de este repo:** arreglar credenciales/URL del feed en su plataforma.
   Recién después: corrida del feed → verificación de la reconciliación → y solo entonces el gate
   de activación de visión. **Mientras el feed 403ee, esperar la reconciliación de las 04:30 es
   esperar algo que no puede ocurrir.**
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

> **⛔ HOSTING CONGELADO — App Review de Meta EN CURSO.** El tenant `meta-review` (número …5686)
> está bajo revisión de Meta y su entorno **no se toca**: no desplegar Hosting ni nada que Meta
> esté revisando mientras dure. Los tres programas de arriba piden Hosting: **ese tramo está
> bloqueado por un gate externo**, no por el código.
>
> **⚠️ Deuda de release acumulada.** Los tres suman ~**14 funciones CREATE** + updates que se
> pisan entre sí (ADR-0021 toca `metaWebhook`/`onWebhookInbox`; ADR-0022 toca los mismos
> schedulers). El selector de rollback es *el mismo menos las CREATE*: con 14 CREATE quedarían 14
> funciones que el rollback por selector **no puede revertir**. Calcular la superficie exacta con
> `apps/functions/scripts/release-audit.mjs` **antes** de cualquier programa de deploy.
>
> **🐞 `release-audit.mjs:77` tiene `COMMIT_BASE_DESPLEGADO = '30c1687'`, desactualizado por dos
> deploys** (el último desplegado es `6f75601`). Corrido con el default calcula el diff desde
> antes del tren ADR-0018/0019 y devuelve un selector inflado con funciones ya desplegadas.
> Pasar `--base` explícito o corregir la constante.

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
- **Los `.test.ts` NO se typechequean** (verificado 2026-08-18): `apps/functions/tsconfig.json`
  los excluye y `vitest.config.ts` no activa `typecheck`. O sea que `pnpm -r typecheck` en 0
  **no cubre los archivos de test**. Preexistente y sistémico: al leer un reporte, tenerlo en
  cuenta antes de dar por cubierta esa pata.
- **Cero CI** (verificado 2026-08-18): `.github/` solo tiene `pull_request_template.md`. La
  batería completa y las 6 suites E2E (~30-35 min) son manuales; nada impide que una sesión
  declare verde sin correr. Por eso el repo exige exit codes reales en los reportes.

## Backlog (solo a pedido del owner)

Fase 5 — Operación (runbook del owner, backups semanales, alertas de presupuesto GCP y de
errores de functions) · AI-PROMPT-CACHING-1 · cortesía determinística · AI-USAGE-ATTRIBUTION-1 ·
Meta Catalog Live · `CATALOG-IMPORT-1` (CSV/Excel/Sheets) · `CATALOG-ENRICHMENT-3` ·
`META-ADS-GROWTH` · integración genérica con CRM.

## Criterio de cierre del proyecto

Una persona externa completa el ciclo entero sin intervención técnica: WhatsApp →
recomendación → carrito → orden → comprobante → el vendedor lo ve y lo confirma en el panel
desde `vendeyapy.com`.
