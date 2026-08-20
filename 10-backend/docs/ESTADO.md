# ESTADO — VendeYaPy

> **Última actualización: 2026-08-20** (H-03 + H-15 + H-38 + H-39 corregidos en repo: el panel dejó de guardar en silencio y de fingir vacíos).
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
| Último commit desplegado | `6f75601` — DEPLOY-AI-PHASE2-SALES-RESERVATION-1 (2026-08-16Z). **Confirmado contra prod 2026-08-18**: `updateTime` máximo de las 118 = 2026-08-16T00:35Z, 10 funciones ese día, ninguna posterior |
| Functions | 118 ACTIVE (verificado 2026-08-18 vía functions:list + GCF v2) |
| Índices | 21 READY, cero pendientes (verificado 2026-08-18; el repo declara exactamente 21) |
| TTL | 3 ACTIVE (`metaWebhookAppState/History/Shadow`); el repo declara 4 — **falta `metaOAuthStates` (ADR-0020, sale con el release)** |
| Rules hash | `132712ca` (desde `a9c99e05`, 2026-08-15) ⚠️ verificar — los 3 programas EN REPO no tocan Rules |
| Schedulers | **8** (verificado 2026-08-18: `aiReservationMaintenance`, `attachmentRetentionMaintenance`, `coverageMaintenanceDaily`, `metaCatalogOutbox/VerificationMaintenance`, `refreshGrowthJobsDaily`, `resetUsageMonthly`, `trialNotificationsDaily`); «sin invoker público» ⚠️ verificar |
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
6. **`releaseToBot` destruye el checkout — ARREGLADO EN REPO desde `4af6607` (2026-08-04),
   NO DESPLEGADO (verificado 2026-08-19).** Prod tiene `chatRelease` con `updateTime`
   2026-07-31T11:23Z (GCF v2, dato directo) < fecha del fix ⇒ el defecto SIGUE VIVO en
   producción hasta el release (`functions:chatRelease` ya está en el Paso 1 del plan).
   El fix (`ESTADOS_QUE_SOBREVIVEN_A_LIBERAR` = SELECTING_PAYMENT + AWAITING_PAYMENT, 6 tests
   en `handoff.release.test.ts`) fue re-verificado el 2026-08-19: el set de DOS es COMPLETO —
   `Session.cart` no se toca al liberar y «carrito»/«pagar» son reglas globales previas a la
   máquina de estados (el cliente conserva su carrito desde IDLE); `CHECKOUT_DONE` no tiene
   lectores y transiciona solo a IDLE; los estados de navegación se reinician a propósito.
   **⚠️ ADVERTENCIA OPERATIVA (vigente hasta el deploy, aplica a la prueba de Fase 3):**
   durante una venta real NO usar «devolver al asistente» si el cliente está por pagar o ya
   recibió los datos bancarios — el `chatRelease` desplegado todavía degrada la sesión a IDLE
   y el comprobante rebota en el receipt gate.

## En repo, sin desplegar

| Programa | Fecha | Superficie estimada del release |
|---|---|---|
| Coexistence (fundación + correctivos) | 2026-08-04/05 | Cutover = Programa 2, bloqueado. **⚠️ Sus 6 `coexistence*` son CREATE latentes: cualquier selector debe excluirlas** |
| META-ONBOARDING-SELF-SERVICE-1 (ADR-0020) | 2026-08-17 | 1 CREATE (`completeMetaConnectWaba`) + TTL `metaOAuthStates` + Hosting |
| CONVERSATIONS-WHATSAPP-UX-1 (ADR-0021) | 2026-08-18 | 11 CREATE + Hosting; sin índices/Rules/TTL |
| CATALOG-AUTHORITY-SELF-SERVICE-1 (ADR-0022) | 2026-08-18 | 2 CREATE + Hosting; sin índices/Rules |

**Superficie CONSOLIDADA calculada y verificada (2026-08-18, `docs/release-plan-tres-programas.md`):**
release = **14 CREATE + las 118 UPDATE** (los tres tocaron `lib/firebase.ts` y `audit/audit.ts`,
universales ⇒ redeploy completo) + 1 TTL + 0 índices + 0 Rules + 0 DELETE. **Backend-first APTO
sin Hosting** (panel `6f75601` no referencia ninguna CREATE; 3 divergencias de forma de error
documentadas en flujos no ejercitados). Selectores literales de deploy y rollback en el plan.

> **⛔ HOSTING CONGELADO — App Review de Meta EN CURSO, ahora CON EVIDENCIA (2026-08-19).**
> Actividad inbound REAL del número …686 leída del backend (read-only, sin contenido): ráfaga de
> **7 mensajes el 12-08 (mié 09 h)** + 2 el 15-08, **5 remitentes distintos**, 3 en los últimos
> 7 días, 0 en 48 h — compatible con revisores probando; el backend no distingue revisor de
> prueba del owner (limitación declarada). **El gate NO es solo Hosting**: el Tramo 1
> redespliega `metaWebhook`/`onWebhookInbox` (el camino del revisor).
> **CONFIRMADO POR EL OWNER EN EL DASHBOARD (2026-08-19): «Revisión en curso»** — 4 solicitudes
> (`whatsapp_business_messaging/management`, `catalog_management`, `public_profile`), plazo
> típico 20 días, fecha de envío no visible ⇒ **NO-GO FIRME para el Tramo 1** hasta
> «Aprobado»/«Rechazado». Al destrabarse: re-correr `review-window-audit.mjs` + ventana
> domingo 05:00–07:30 ASU (`release-plan-tres-programas.md` §10.4-10.6).
>
> **Deuda de release: superficie ya calculada y verificada** — ver
> `docs/release-plan-tres-programas.md` (RELEASE-AUDIT-TRES-PROGRAMAS-1). Nota clave: los tres
> programas NO se pisan entre sí (solapamiento solo aditivo en `audit.ts`/`index.ts`), pero el
> rollback por selector deja vivas las 14 CREATE (callables auth-gated, inertes sin panel;
> retiro real = `functions:delete` con gate propio). La trampa del selector crudo son las **6
> `coexistence*`** del Programa 2 bloqueado: el plan las excluye explícitamente.
>
> ✅ **`release-audit.mjs` corregido el 2026-08-18**: `COMMIT_BASE_DESPLEGADO = '6f75601'`,
> confirmado contra producción por `updateTime` antes de tocar la constante. Al próximo deploy,
> actualizarla en el mismo programa.

7. **AUDITORÍA 2026-08-19 (`docs/system-audit-2026-08.md`) — CERO CRÍTICOS ABIERTOS + 15 ALTOS**
   (los tres CRÍTICOS —H-01, H-02, H-03— están corregidos en repo; ver puntos 8, 9 y 10).
   ALTOS destacados: datos bancarios placeholder hacia
   clientes reales (H-04), pago confirmado sin audit ni aviso al cliente (H-05/H-06), borrado
   del índice global de ruteo sin verificar tenant (H-07), `customers` con `write` de MANAGER
   incluido el delete físico (H-08), fan-out de tools sin tope que rompe la cuota (H-09), sin
   validación de salida del modelo (H-10), `metaWebhookInbox` sin TTL con 176 docs vencidos con
   PII (H-11), secretos legibles con rol viewer (H-12). Ranking de fixes en §3 del informe.

8. **H-01 (pérdida silenciosa de mensajes en el webhook) — ARREGLADO EN REPO, NO DESPLEGADO**
   (2026-08-19, `CRITICAL-FIX-WEBHOOK-INBOUND-DURABILITY-1`). **Producción sigue con el defecto
   hasta el release**: hoy, si Firestore hipa mientras entra un mensaje, ese mensaje se pierde sin
   rastro. El fix **NO requiere un deploy propio**: `functions:metaWebhook` ya está en el Paso 1
   del Tramo 1 calculado (`docs/release-plan-tres-programas.md`), que espera el cierre de la App
   Review. Contenido: 503 con `retry` solo para fallos TRANSITORIOS (los permanentes responden
   200 + log de incidente, para no degradar la salud del webhook durante la revisión de Meta),
   contador `liveWriteFailures` en el resumen, `catch` general que ya no se traga el lote (cubre
   también el archivo de Coexistence), clave estable para entrantes sin wamid, y log de rastreo
   con PNID y wamid **enmascarados** (la review probó que el wamid lleva el teléfono en base64).

9. **H-02 (secuestro de cuentas por email) — ARREGLADO EN REPO, NO DESPLEGADO** (2026-08-19,
   `CRITICAL-FIX-USER-CLAIMS-1`). **Producción sigue con el defecto hasta el release.** Entra en
   el Tramo 1 ya calculado (`inviteUser`, `setUserRole` y `setUserActive` están en el selector
   del Paso 1) y **no requiere deploy adicional**.
   ⚠️ **REGLA OPERATIVA: H-02 tiene que estar DESPLEGADO antes de abrir el registro autoservicio
   a la primera empresa externa** — el privilegio de owner que ese registro entrega es
   exactamente el que explota este defecto.
   Deuda abierta que el fix NO cierra (programa aparte): `inviteUser` sigue revelando si un email
   existe en la plataforma (`created: true|false`), sin auditoría del rechazo ni rate-limit; la
   cura de fondo es la invitación con aceptación del invitado (pendiente + token).

10. **H-03 + H-15 + H-38 + H-39 (el panel guardaba en silencio y fingía vacíos) — ARREGLADO EN
    REPO, NO DESPLEGADO** (2026-08-20, `CRITICAL-FIX-PANEL-SILENT-SAVE-1`). Fix **solo frontend**:
    cero backend, cero Rules, cero índices. Nueve pantallas (`agent`, `promotions`, `decisions`,
    `ads`, `followups`, `tracking`, `replies`, `welcome`, `onboarding`) dicen el resultado de cada
    acción con el motivo real del backend, y una lectura caída ya no se disfraza de "no hay nada".
    Cinco reviews adversariales (43 hallazgos, todos corregidos) destaparon de paso un caso de
    **pérdida de datos** que la auditoría no había catalogado: en `/agent`, con la config sin poder
    leerse, el formulario mostraba los valores por defecto y «Guardar cambios» **pisaba la
    configuración real del tenant y borraba sus datos de cobro**. Ahora avisa y bloquea el guardado.
    ⚠️ **A diferencia de H-01 y H-02, este fix NO viaja en el Tramo 1**: es panel ⇒ **sale con el
    Tramo 2 (Hosting)**, hoy congelado por la App Review. Hasta entonces, producción sigue
    perdiendo el trabajo del dueño en silencio si el backend rechaza una configuración.
    Pendiente del mismo patrón, fuera de alcance (inventario en el informe de auditoría):
    `/simulator` (5 mutaciones, 0 con rama de error), `/catalog`, `NotificationBell`,
    `MetaReconciliation`, `OutboxIncidents`, `CustomerInfoPanel`, `LinkClientModal`,
    `CoexistenceHistoryCard`, `WhatsappActivationQueue`; y un H-15 vivo en el **dashboard**
    (si fallan las métricas, los KPIs quedan como esqueleto animado para siempre). Y aparte:
    `fallbackMessage`/`handoffMessage`/`farewellMessage` de `/agent` siguen siendo **config muerta**
    (se guardan, el motor no las usa) — programa propio.

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
- **Flake preexistente en la suite completa** (verificado 2026-08-19 CON y SIN el diff del día,
  en el commit base): `src/meta/coexistenceConnect.test.ts > "REPLAY: el segundo callback
  devuelve lo mismo…"` falla en la corrida completa de `apps/functions` (225 archivos) y pasa
  aislado (24/24). Compara el documento de conexión contra un snapshot previo, así que es
  sensible a timestamp/carga. No lo introdujo ningún cambio reciente; queda como deuda.
- Los tests `tests/integration/release-audit.*.test.ts` que menciona el header de
  `release-audit.mjs` **no existen** (verificado 2026-08-18): el parser del audit corre sin
  ninguna cobertura propia.
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
