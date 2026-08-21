# ESTADO — VendeYaPy

> **Última actualización: 2026-08-21** — **el Tramo 1 (backend) está DESPLEGADO y verificado con
> tráfico real.** H-01, H-02, H-04 y H-05 pasaron a producción. **Hosting sigue sin tocar**: el
> panel es el Tramo 2 y sigue congelado por la App Review de Meta.
> Este archivo describe el **presente**, no la historia. La historia vive en `BITACORA.md`.
> Se reescribe, no se acumula.
> `⚠️ verificar` = dato derivado de la bitácora, no leído de producción en la última sesión.

## Identidad

- **Proyecto:** VendeYaPy — SaaS multi-tenant de ventas por WhatsApp en Paraguay.
- **Repositorio:** `Nehorpy-cpu/VendeyaPy`, monorepo en `C:\AI_AFG\10-backend`.
- **Stack:** Next.js, TypeScript, Firebase (Auth/Firestore/Storage/Functions), WhatsApp Cloud
  API, Anthropic Claude, pnpm workspaces.
- **Producción:** `vpw-prod-dd6ff` · panel en `https://vendeyapy.com`.
- **Tenants:** `arfagi` (real, activo) · `credipower` (diferido e intocable) ·
  `meta-review` (número …5686) — **App Review de Meta EN CURSO: Hosting CONGELADO.**

## Producción hoy

Todo lo de esta tabla fue **leído de producción el 2026-08-21** (read-only) salvo lo marcado.

| Superficie | Estado |
|---|---|
| Último commit desplegado | **`eb0432f`** — DEPLOY-TRAMO-1-BACKEND-1 (2026-08-21). Verificado contra prod: las 132 functions tienen `updateTime` de ese día, ninguna quedó atrás. **Solo backend: el Hosting sigue en `6f75601`** |
| Functions | **132 · 132 ACTIVE** (118 previas + 14 CREATE). `metaWebhook` ACTIVE, `updateTime` 2026-08-21T17:13:06Z |
| Índices | **21 READY**, cero pendientes |
| TTL | **4 ACTIVE**: `metaOAuthStates` (nueva, ADR-0020 — nació `CREATING` y cerró `ACTIVE`), `metaWebhookAppState`, `metaWebhookHistory`, `metaWebhookShadow` |
| Rules | **0 cambios en este deploy.** Ruleset vigente `132712ca`, release `updateTime` 2026-08-15T11:59:45Z (leído de la API de Firebase Rules). Storage: `8fe5a630` |
| Schedulers | **8 ENABLED**, crons intactos en `America/Asuncion` |
| WhatsApp | `automationMode: live` en …7904 (arfagi) y …5686 (meta-review) |
| Pedidos / jobs | 0 pedidos en vuelo y 0 jobs de cobertura vivos en los tres tenants |

**Smoke de producción con tráfico REAL (2026-08-21).** Mensaje entrante real al número de
`arfagi` (…7904) a las **19:18:30Z**; `metaWebhook` a las **19:18:36Z** reportó `written=1`,
**`liveWriteFailures=0`**, `duplicates=0`; cadena completa `metawebhook → onwebhookinbox →
AI gateway: ok → sales agent IA → Mensaje procesado → Webhook procesado`; **respuesta entregada
al cliente en 2 segundos**. `liveWriteFailures` es el contador que **introdujo H-01**: verlo en
los logs de prod es la prueba directa de que el fix corre, no solo de que está desplegado.
**Encuadre del bot verificado en el mismo smoke:** responde una pregunta de dominio (EDT vs
Parfum) y **rechaza** una fuera de dominio manteniendo el rol y redirigiendo al catálogo — es
**evidencia de cumplimiento de la política de Meta de enero de 2026** (prohibidos los bots de IA
de propósito general; solo se admiten agentes acotados a un proceso de negocio). Sirve para la
App Review si hay que reenviarla.

**Rollback conservado — NO BORRAR:** worktree en `C:/AI_AFG/.claude/worktrees/rollback-6f75601`,
commit `6f75601` en detached HEAD, ya compilado. El selector de vuelta atrás es el mismo del
deploy **menos las 14 CREATE** (incluir una CREATE aborta el comando entero). Históricos:
`bdaffbe` y `30c1687`.

## Flags e interruptores por tenant

| Flag | arfagi | credipower | meta-review |
|---|---|---|---|
| Visión de productos (ADR-0019) | AUSENTE (apagada) ✓2026-08-21 | AUSENTE | AUSENTE ✓2026-08-21 |
| Coverage | ACTIVO — `required`, máx ₲200.000, exp. 24 h ⚠️ verificar | apagado | — |
| `attachments.ingest.enabled` | `true` ✓2026-08-21 | documento AUSENTE | sin config |
| `receiptGate.enabled` | `true` ⚠️ verificar | documento AUSENTE | — |
| Purga de adjuntos | APAGADA ✓2026-08-21 | — | APAGADA ✓2026-08-21 |
| Meta Catalog (`config/meta.catalogSync`) | `enabled:true`, **`mode: dry_run`**, `sourceOfTruth: vendeyapy`, `ownership.model: external_managed` ✓2026-08-21 | sin `catalogSync` (fail-closed) | sin `catalogSync` (fail-closed) |

**El deploy del Tramo 1 no encendió ningún flag.** Todo lo que estaba inerte sigue inerte.

## Catálogo Meta

El catálogo de Meta lo gobierna **al 100 % un feed diario del sitio del tenant**
(`primary_feed` `1668013347585391`, `deletion_enabled: true`, Server Fetch diario 03:33
America/Asuncion desde `api.arfagi.com`). 181 artículos ⚠️ verificar. El feed **no se toca, no se
ejecuta a mano y no se desactiva**. Nunca escribimos en Meta: una sola escritura en toda la
historia del proyecto (canary de Odyssey, 2026-07-28, revertido por el feed 36 h después).

Reconciliación 04:30 y 16:30 America/Asuncion contra TTL de 24 h, solo lectura.

## Bloqueantes abiertos

1. **FEED ROTO (HTTP 403) en el origen de arfagi — PRIORIDAD 0, fuera de este repo.**
   `api.arfagi.com` devuelve **HTTP 403 desde ≤2026-08-14** y el último run del feed en Meta
   cerró con **0 items / 1 error**: el feed **no publica nada** ⚠️ verificar (diagnóstico del
   2026-08-18, no releído hoy). Odyssey (`ARM-744646-5202`) tiene precio local **₲190.000**
   contra **₲130.000 obsoleto en Meta**; el guard lo mantiene `drifted_external` y **no cierra
   venta automática** — fail-closed correcto. **Acción del owner, fuera de este repo:** arreglar
   credenciales/URL del feed. Recién después: corrida del feed → verificación de la
   reconciliación → y solo entonces el gate de activación de visión. **Mientras el feed 403ee,
   esperar la reconciliación de las 04:30 es esperar algo que no puede ocurrir.**
2. **Fase 3 sin evidencia — sigue siendo el criterio de cierre del proyecto.** El smoke del
   2026-08-21 valida el **backend** (webhook, durabilidad del entrante, encuadre del bot) con un
   mensaje del **propio owner**. Falta el ciclo completo con un número **externo**: inbound real
   → bot → carrito → orden → comprobante visible en el panel → confirmación → logs limpios.
   Nunca se hizo. **Novedad favorable:** el sistema está hoy en su mejor versión para intentarlo
   —H-01, H-04, H-05 y el fix de `chatRelease` ya corren en producción—, y la advertencia
   operativa que impedía usar «devolver al asistente» durante un checkout **quedó levantada**
   (ver la fila `releaseToBot` en la tabla de auditoría, más abajo).
3. **Activación de visión.** Desplegada e inerte desde el 2026-08-15, re-canary exitoso.
   Activarla es un programa aparte y depende de (1) y de la calibración del matcher.
4. **Coexistence, Programa 2.** Detenido fail-closed en el preflight del 2026-08-06: 5 gates
   externos de Meta sin evidencia (incluida la elegibilidad de Paraguay) y el `config_id` de
   Coexistence sin crear. **Sus 6 `coexistence*` siguen siendo CREATE latentes: cualquier
   selector de deploy debe excluirlas** — el Tramo 1 las excluyó.
5. **Rotación de los 4 secretos de staging — NO EJECUTADA.** Deploys anteriores a
   RELEASE-SECURITY-AND-RUNBOOK-HARDEN-1 subieron `.env.vpw-staging` al bucket de fuentes de
   prod. La fuga es interna (bucket no público, valores distintos por entorno). Quedaban 109
   versiones vivas construidas con ese `.env` ⚠️ verificar — **el redeploy completo del
   2026-08-21 debería haber reemplazado los artefactos de las 132 functions por artefactos
   limpios; no se verificó en esta sesión.**
6. **Tramo 2 (Hosting) — CONGELADO, esperando el fin de la App Review.** El owner confirmó en el
   dashboard de Meta (2026-08-19) **«Revisión en curso»**: 4 solicitudes
   (`whatsapp_business_messaging/management`, `catalog_management`, `public_profile`), plazo
   típico 20 días, sin fecha de envío visible. **El Tramo 1 ya se ejecutó sin incidentes y sin
   tocar Hosting.** Al destrabarse: desplegar el panel (procedimiento y las **14 claves
   obligatorias** del env temporal en `HANDOFF.md` §5) y con él salen H-03 + H-15/H-38/H-39.

## Auditoría 2026-08-19 (`docs/system-audit-2026-08.md`)

**Cero CRÍTICOS abiertos.** Los tres CRÍTICOS y los dos ALTOS de dinero están así:

| Hallazgo | Estado |
|---|---|
| **H-01** — pérdida silenciosa de mensajes en el webhook | **EN PROD — ACTIVO** (2026-08-21). Verificado con tráfico real: `liveWriteFailures=0` |
| **H-02** — secuestro de cuentas por email | **EN PROD — ACTIVO** (2026-08-21) |
| **H-04** — el bot mandaba datos bancarios falsos | **EN PROD — ACTIVO** (2026-08-21) |
| **H-05** — un pago confirmado quedaba sin rastro | **EN PROD — ACTIVO** (2026-08-21). **No ejercitado en prod**: no hubo pagos reales en la ventana |
| **H-03** + H-15/H-38/H-39 — el panel guarda en silencio y finge vacíos | **EN REPO — NO DESPLEGADO.** Es panel ⇒ sale con el **Tramo 2** |
| `releaseToBot` destruía el checkout (`chatRelease`) | **EN PROD — ACTIVO** (2026-08-21). Estaba en repo sin desplegar desde el 2026-08-04. **La advertencia operativa de no usar «devolver al asistente» durante un checkout queda LEVANTADA** |

⚠️ **Consecuencia práctica de que H-03 siga en repo:** si el owner configura el agente estos
días y el backend rechaza el guardado, **el panel no se lo dice** y puede pisar su propia
configuración. Hasta el Tramo 2, verificar a mano después de cada cambio de configuración.

**ALTOS que siguen abiertos:** el aviso de pago confirmado que nadie manda (**H-06** — el
«🎉 ¡Pago confirmado!» se construye y ningún llamador lo envía; el campo `message` quedó intacto
a propósito) · borrado del índice global de ruteo sin verificar tenant (H-07) · `customers` con
`write` de MANAGER incluido el delete físico (H-08) · fan-out de tools sin tope que rompe la
cuota (H-09) · sin validación de salida del modelo (H-10) · `metaWebhookInbox` sin TTL con 176
docs vencidos con PII (H-11) · secretos legibles con rol viewer (H-12). Ranking de fixes en §3
del informe.

**Reglas operativas que siguen vigentes:** H-02 y H-04 ya están desplegados, así que **la
precondición para abrir el registro autoservicio a la primera empresa externa está cumplida del
lado del backend** — falta el Tramo 2, porque sin H-03 el panel de esa empresa guardaría en
silencio.

## En repo, sin desplegar

| Programa | Fecha | Qué falta |
|---|---|---|
| CRITICAL-FIX-PANEL-SILENT-SAVE-1 (H-03 + H-15/H-38/H-39) | 2026-08-20 | **Solo Hosting.** Cero backend, cero Rules, cero índices ⇒ sale con el Tramo 2 |
| Coexistence (fundación + correctivos) | 2026-08-04/05 | Cutover = Programa 2, bloqueado. **Sus 6 `coexistence*` son CREATE latentes: excluirlas de todo selector** |

Todo lo demás que estaba en esta tabla **se desplegó el 2026-08-21**: META-ONBOARDING-SELF-SERVICE-1
(ADR-0020), CONVERSATIONS-WHATSAPP-UX-1 (ADR-0021) y CATALOG-AUTHORITY-SELF-SERVICE-1 (ADR-0022).

⚠️ **Sus 14 CREATE están EN PROD — INERTES, no activas.** Son callables autenticadas que **solo
el panel invoca**, y el panel no se desplegó: existen, están ACTIVE y **nadie las llama**. Su
primer uso real será con el Tramo 2. **Desplegado ≠ activo.**

✅ `release-audit.mjs` actualizado en este cierre: `COMMIT_BASE_DESPLEGADO = 'eb0432f'`, con la
verificación contra producción escrita en el comentario. **Ojo:** ese base vale para superficies
de **backend**; para auditar una superficie de **Hosting** el base correcto sigue siendo
`6f75601` vía `--base`.

## Deudas menores conocidas

**Nuevas, del deploy del 2026-08-21 — están en `HANDOFF.md` §5, que es donde hay que leerlas
antes del próximo deploy:**

- **`firebase deploy` devuelve EXIT 0 con funciones SIN aplicar.** Pasó **dos veces en el mismo
  deploy**: los 429 de cuota agotan sus reintentos, el CLI imprime el error de esa función y
  **igual cierra con éxito global**. **El éxito de un deploy se mide contrastando `updateTime`
  contra producción, JAMÁS contra el exit code.**
- **El predeploy NO compila `shared`.** El hook corre `pnpm --filter @vpw/shared build`, que
  imprime «No projects matched the filters» y sale en 0 (el filtro correcto es `--filter shared`).
  En una máquina limpia ese hook no hace nada: correr `pnpm -r build` a mano antes de desplegar.

**Las que ya venían:**

- La campana no lleva `targetUid`: un rol SELLER puro no la ve. Hoy sin impacto.
- 4 secretos productivos siguen como env vars planas en vez de Secret Manager, contra la
  política escrita del propio repo.
- Higiene de logs: el `customerId` completo (el teléfono) va en metadata estructurada.
- La tarjeta de propiedad del catálogo muestra la fuente sin nombre, sin horario y sin avisar
  que el feed borra de Meta lo que no publica (`deletion_enabled: true`).
- `metaSyncState` no se recalcula al editar un producto: un importado enriquecido arrastra
  `drifted_external` hasta la reconciliación siguiente (máx. ~12 h).
- Pendientes de calidad de catálogo: 23 genéricos, 18 duplicados probables, 33 incoherencias,
  1 sin marca ⚠️ verificar.
- Pedidos: 15 históricos, 14 CANCELLED y 1 PAID anterior a los releases de julio. Cero pagos
  nuevos. Ningún pedido pendiente de verificación (verificado 2026-08-21).
- `fallbackMessage`/`handoffMessage`/`farewellMessage` de `/agent` son **config muerta**: se
  guardan y el motor no las usa. Programa propio.
- Patrón de H-03 pendiente fuera de alcance: `/simulator` (5 mutaciones, 0 con rama de error),
  `/catalog`, `NotificationBell`, `MetaReconciliation`, `OutboxIncidents`, `CustomerInfoPanel`,
  `LinkClientModal`, `CoexistenceHistoryCard`, `WhatsappActivationQueue`, y un H-15 vivo en el
  **dashboard** (si fallan las métricas, los KPIs quedan como esqueleto animado para siempre).
- **`verify-d6` falla su check 4** («confirmar el pago registró el evento Purchase en vivo»),
  preexistente y verificado contra el código base: **el E2E que debería cubrir H-05 no lo cubre.**
- **Los `.test.ts` NO se typechequean**: `apps/functions/tsconfig.json` los excluye y
  `vitest.config.ts` no activa `typecheck`. `pnpm -r typecheck` en 0 **no cubre los tests**.
- **Flake preexistente en la suite completa**: `src/meta/coexistenceConnect.test.ts > "REPLAY…"`
  falla en la corrida completa de `apps/functions` y pasa aislado. Sensible a timestamp/carga.
- Los tests `tests/integration/release-audit.*.test.ts` que menciona el header de
  `release-audit.mjs` **no existen**: el parser del audit corre sin cobertura propia.
- **Cero CI**: `.github/` solo tiene `pull_request_template.md`. La batería completa y las 6
  suites E2E (~30-35 min) son manuales. Por eso el repo exige exit codes reales en los reportes.

## Backlog (solo a pedido del owner)

Fase 5 — Operación (runbook del owner, backups semanales, alertas de presupuesto GCP y de
errores de functions) · AI-PROMPT-CACHING-1 · cortesía determinística · AI-USAGE-ATTRIBUTION-1 ·
Meta Catalog Live · `CATALOG-IMPORT-1` (CSV/Excel/Sheets) · `CATALOG-ENRICHMENT-3` ·
`META-ADS-GROWTH` · integración genérica con CRM.

## Criterio de cierre del proyecto

Una persona externa completa el ciclo entero sin intervención técnica: WhatsApp →
recomendación → carrito → orden → comprobante → el vendedor lo ve y lo confirma en el panel
desde `vendeyapy.com`. **Sigue sin evidencia.** Lo validado el 2026-08-21 es el backend, con un
mensaje del propio owner.
