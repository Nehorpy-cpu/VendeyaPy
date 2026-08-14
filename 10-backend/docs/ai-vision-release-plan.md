# Plan de release — Reserva de cuota IA (ADR-0018) + Visión de productos (ADR-0019)

> Producido por `AI-VISION-RELEASE-TRAIN-PREP-1` (2026-08-14, HEAD `970c31e`), **read-only: nada
> de este documento se ejecutó**. Complementa (no reemplaza) el runbook de Coexistence.
> Veredicto: **SEPARABLE CON AJUSTE LOCAL** — la Fase 1 es independiente de Coexistence; la
> Fase 2 (el productor) exige el programa correctivo de migración de `automationMode` para
> DOS números, incluido el del tenant de App Review.

## 1. Baseline por superficie (medida 2026-08-14 — NO es un solo commit)

| Superficie | Estado vigente | Fecha |
|---|---|---|
| **Hosting** | release `a68bfb37` (config estándar de Meta horneada) | 2026-08-11T12:39Z |
| **Functions** | 115 ACTIVE, base `30c1687` (release de adjuntos) | 2026-07-31/08-01 |
| **Firestore Rules** | ruleset `a9c99e05…` — SIN matches ai* ni coexistence* | 2026-08-01 |
| **Índices** | 18 compuestos; los 3 `ai*` NO existen; `fieldOverrides: []` (cero TTL) | 2026-08-01 |
| **Storage Rules** | release del | 2026-08-01 |
| **Schedulers** | 7 (sin `aiReservationMaintenance`) | 2026-08-01 |

Confirmado read-only: `meta-review` aislado (flag de visión AUSENTE, 0 jobs, 0 reservas, 0
alertas, 3 productos sintéticos intactos, su asistente ya consumió ~3,6k tokens — la revisión
está activa); `arfagi` con flag AUSENTE y `usage` sin `aiTokensReserved` (el código viejo no lo
escribe); `credipower` intacto; `aiTestFixtures/ai` NO existe en prod; ninguna colección nueva
tiene documentos. **No hay trabajo productivo pendiente de ADR-0018/0019.**

## 2. Grafo (dos pasadas coincidentes) y clasificación

`release-audit.mjs --sin-red`: **124 exports, fuente y compilado idénticos, 0 divergencias**
(66 módulos cambiados + 16 nuevos vs `30c1687`). Contra producción: CREATE=8 (6 coexistence* +
2 de este release), UPDATE=115, DELETE=0, veredicto **BLOQUEADO `migracion_pendiente`** — ahora
con **DOS números** sin `automationMode`: `arfagi …7904` y **`meta-review …5686`** (el número de
prueba conectado durante la revisión de Meta).

Clasificación de los exports de ESTE release (evidencia: caminos de import verificados):

| Export | Clase | ¿Arrastra el gate ADR-0017? |
|---|---|---|
| `aiReservationMaintenance` | **CREATE** (scheduler horario + sweep de visión) | NO |
| `onAiVisionJob` | **CREATE** (worker; guard pre-envío = `silencio.ts`) | NO |
| `askInternalGrowthAssistant` | UPDATE directa (seam de reserva) | NO (no importa process.ts) |
| `agentTestCaseRun` | UPDATE directa (engine→salesAgent→reserva) | NO (engine no importa process.ts) |
| `simulateAgentMessage` | UPDATE directa (mismo camino) | NO |
| `devMessage` | UPDATE directa (dev*, ya desplegada) | NO |
| `onWebhookInbox` | UPDATE directa (hook de visión + gateFallo en process.ts) | **SÍ — el ÚNICO** |
| `resetUsageMonthly` | sin cambio semántico | NO |
| `devRunMetaCatalogOutbox` | dev-only — **PROHIBIDA en producción** | — |
| `coexistence*` (6) | Coexistence-only — fuera de este release | — |

Shared: los dos type-files cambiados compilan a **cero diferencia de runtime JS**;
`whatsappAutomation.ts` (Coexistence) NO fue tocado por `855d553`/`970c31e`.

## 3. Dependencia con Coexistence (Etapa D, con evidencia)

1. Los exports del release SÍ comparten módulos que Coexistence también modificó (engine,
   paths de sesión) — con **neutralidad de comportamiento demostrada** para el canal heredado
   (dual-PNID E2E 20/20; shipping 81/81; adjuntos 98/98 a HEAD).
2. Comportamiento de canales/números: cambia SOLO vía `onWebhookInbox` (el gate fail-closed).
3. El paquete arranca sin desplegar las callables de Coexistence: quedan exportadas en el
   artefacto y ausentes en prod — el mismo patrón probado de `devRunMetaCatalogOutbox`.
4. Dependencias de infra de Coexistence: **ninguna** para las funciones de la Fase 1. El
   ARCHIVO de índices/rules sí arrastra los 3 TTL overrides y los 4 matches inertes de
   Coexistence (mismo archivo, sin flag para separar — decisión explícita, ver Fase 1a).
5. Cuota con visión apagada, sin UI de Coexistence: **sí** (Hosting excluido).
6. Worker sin productor: **sí** — inerte (cero jobs posibles + flag apagado).
7. El productor es `onWebhookInbox` (hook en `process.ts:751-765`): actualizarlo arrastra el
   gate ADR-0017 y todo el cierre de Coexistence de `process.ts` (echo, shadow, historial).
8. Impacto sobre App Review: la Fase 1 **no toca** los flujos del reviewer (su webhook corre
   el código viejo; su asistente interno cambia a reserva con contrato de errores idéntico).
   La Fase 2 SIN la migración del número `…5686` **silenciaría el bot que los revisores están
   probando** — por eso la migración correctiva cubre AMBOS números antes de esa fase.

## 4. El orden del release (NADA ejecutado)

> Reglas duras: jamás `--force`, jamás `--only functions` a secas, 0 DELETE, 0 recreates, CLI
> del repo (13.35.1), `--project vpw-prod-dd6ff` explícito siempre, Hosting EXCLUIDO, cero Meta.

**Fase 1a — Índices** · `firebase deploy --only firestore:indexes --project vpw-prod-dd6ff`
(sin `--force`; el CLI 13.35.1 es aditivo: crea los 3 `ai*` y NO borra nada — `indexesToDelete`
daría vacío igual). ⚠️ Arrastra los 3 TTL overrides de Coexistence (colecciones hoy
inexistentes: riesgo bajo, pero es un adelanto de fase que la aprobación debe incluir).
Precondición: batería local verde. Aborto: cualquier error del CLI. Verificación: los 3 en
**READY** en consola antes de seguir. Rollback: los índices sobrantes son inofensivos (nada los
consulta con el código viejo). App Review: sin impacto.

**Fase 1b — Rules** · `firebase deploy --only firestore:rules --project vpw-prod-dd6ff`.
Publica los cierres `read,write:false` de `aiReservations`/`aiVisionJobs` + los 4 de
Coexistence (todos inertes: nada activable). Verificación: 403 sin auth y cross-tenant.
Rollback: redeploy del ruleset anterior (`a9c99e05…`). App Review: sin impacto.

**Fase 1c — Functions (núcleo independiente)** ·
`firebase deploy --only functions:aiReservationMaintenance,functions:onAiVisionJob,functions:askInternalGrowthAssistant,functions:agentTestCaseRun,functions:simulateAgentMessage,functions:devMessage --config firebase.functions.json --project vpw-prod-dd6ff`
— **2 CREATE + 4 UPDATE + 0 DELETE**. Precondiciones: Fase 1a en READY (las queries de
recuperación las necesitan), 1b aplicada, flag de visión AUSENTE en todos los tenants
(verificado). Aborto: cualquier DELETE/recreate propuesto por el CLI, o si el plan difiere de
2C+4U. Verificación: 117 ACTIVE, `devRunMetaCatalogOutbox` y `coexistence*` siguen ausentes,
scheduler nuevo **sin invoker público**, hash del `.env` productivo intacto. Efecto inmediato
honesto: los turnos del ASISTENTE INTERNO y el SIMULADOR pasan a reserva transaccional (mismo
contrato de errores — 180 tests + E2E); el SALES AGENT de WhatsApp **no cambia** (su función no
se toca). Kill-switch: visión = flag ausente (ya apagada); cuota = redeploy del artefacto
`30c1687` de las 4 UPDATE (selector de reversa SIN los CREATE; artefacto armado con tooling de
HEAD). Los CREATE no se borran jamás (política 0-DELETE): quedan inertes si se revierte.
App Review: su asistente usa reserva (equivalente); nada más cambia.

**Fase 1d — Verificación técnica** · read-only: `release-audit.mjs` (conteos), un turno del
asistente interno propio (tenant interno, NO meta-review) y observar la reserva liquidada en
`aiReservations`, logs sin errores nuevos, `usage.aiTokensReserved` apareciendo y drenando.

**Fase 2 — Productor (BLOQUEADA hasta el programa correctivo)** ·
`firebase deploy --only functions:onWebhookInbox --config firebase.functions.json --project vpw-prod-dd6ff`.
Precondición DURA: `release-audit.mjs --project vpw-prod-dd6ff` con **exit 0** — hoy sale
BLOQUEADO porque `automationMode` está AUSENTE en los DOS números; el programa correctivo debe
migrar a `live` **arfagi …7904 Y meta-review …5686** (con ADC habilitada y
`GCLOUD_PROJECT=vpw-prod-dd6ff` explícito) ANTES de esta fase. Sin eso: el número que vende y
el bot de la revisión de Meta quedan MUDOS. Efecto al desplegar: cuota transaccional para el
sales agent + encolado de visión (inerte con flag apagado). Kill-switch del gate: migración
`--mode inactive` (jamás se bloquea). App Review: NEUTRO solo si la migración incluyó `…5686`.

**Fase 3 — Canary separado (fuera de este plan)** · activación del flag de visión en UN tenant
de prueba con proveedor real, calibración del extractor, y recién después decidir tenants
reales. Nunca junto al deploy técnico.

## 5. Comportamiento inerte demostrado (Etapa F)

Con el flag apagado (estado actual de TODOS los tenants), desde el código compilado y el E2E:
cero jobs (hook: `productVisionActiva()` exige `enabled === true` literal ANTES de encolar;
E2E caso 4: `skipped` + **0 aiRequests**), cero descargas para IA, cero reservas `vision-*`,
cero llamadas al proveedor, cero mensajes nuevos, receipt gate con precedencia intacta
(`yaPropuestoComoPago` + `gateFallo` + re-verificación en el worker; adjuntos 98/98), pedidos y
comprobantes con contrato idéntico, panel mostrando adjuntos normalmente (campo `vision`
opcional; guard de exfiltración actualizado). La reserva general SÍ cambia de inmediato los
turnos de texto de las funciones ACTUALIZADAS — por eso la Fase 1 limita el selector al
asistente interno/simulador y deja el sales agent para la Fase 2.

## 6. Riesgos honestos

- La cuota no tiene kill-switch selectivo propio: mitigación gruesa (`features.aiAssistant`
  off) o redeploy de reversa — dejar el artefacto de reversa ARMADO antes de la Fase 1c.
- El deploy de índices adelanta los 3 TTL de Coexistence (decisión explícita, bajo riesgo).
- `onAiVisionJob`/`aiReservationMaintenance` pueden enviar WhatsApp sin consultar
  `automationMode` (su guard es `silencio.ts`): inerte hoy (sin jobs, flag off); el programa de
  activación debe decidir si suma ese chequeo.
- El número `…5686` de meta-review convierte la migración correctiva en BICÉFALA: olvidarlo
  silencia la revisión de Meta en curso.
- La base de reversa es hoy `30c1687` por función; si Coexistence despliega primero, la base
  cambia y este plan debe recalcularse (`release-audit.mjs` lo hace solo).
