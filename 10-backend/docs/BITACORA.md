# BITÁCORA — VendeYaPy

Registro **append-only**. Una entrada por programa, la más reciente arriba. Nada se edita ni
se borra: si un hecho se supera, se agrega una entrada nueva y la vieja se marca
`[HISTÓRICO — superado por <entrada>]`. El presente vive en `ESTADO.md`.

---

## Plantilla

```markdown
### NOMBRE-DEL-PROGRAMA-N — AAAA-MM-DD (EN REPO — NO DESPLEGADO | EN PROD — INERTE | EN PROD — ACTIVO)

**Qué hace.** Una o dos frases. Qué problema resuelve, no qué archivos toca.

**Causa raíz.** Por qué existía el problema. Si el programa destapó defectos ajenos, van acá,
cada uno con su severidad (ALTO/MEDIO/BAJO) y si quedó abierto o cerrado.

**Verificación.** Números reales: typecheck, lint, tests por paquete, E2E por suite,
review adversarial (cuántos hallazgos, de qué severidad, todos corregidos o no).
Distinguir explícitamente lo probado en emulador de lo probado en producción.

**Selector del release.** CREATE / UPDATE / DELETE con nombres, orden de deploy
(consumidores primero, productores último), índices, Rules, Hosting.
**Orden de rollback:** el inverso y SIN las CREATE.

**Commit.** `hash`

**Estado real.** Qué quedó desplegado, qué quedó inerte, qué flags, en qué tenants.
Qué NO valida esta entrada.

**Deudas y limitaciones conocidas.** Declaradas, no escondidas.
```

Reglas de escritura:

- Un número sin fuente no se escribe. Si no se verificó en la sesión, va `⚠️ verificar`.
- "Desplegado" nunca implica "activo". Si el flag está apagado, la entrada lo dice.
- Las limitaciones conocidas son parte obligatoria de la entrada, no un apéndice opcional.

---

## 2026-08

### APP-REVIEW-STATUS-AND-DEPLOY-WINDOW-1 — 2026-08-19 (READ-ONLY — CERO MUTACIÓN)

Evidencia para el GO/NO-GO del Tramo 1, en `release-plan-tres-programas.md` §10 (nueva).
Script nuevo `scripts/review-window-audit.mjs` (read-only, field mask — el texto de los
mensajes ni viaja; teléfonos enmascarados). **meta-review …686**: último inbound 15-08 ≈11:48
ASU (~4 días); ráfaga de 7 mensajes el 12-08 (mié 09 h) con 5 remitentes distintos — compatible
con revisores, no probatorio (el backend no distingue revisor de owner; limitación declarada);
3 en 7 días, 0 en 48 h ⇒ **no se puede declarar la revisión terminada**. **arfagi …904**: 57
inbound/30 d, todo 08:00–17:59 (+2 a las 22 h), **domingo con CERO mensajes en el mes** ⇒
ventana recomendada **domingo 05:00–07:30 ASU** (post verificación 04:30, pre tráfico/trials).
Graph API: NO expone el estado del App Review (dashboard-only); **cero llamadas a Meta, ni
GET**. Corrección al plan: el gate de App Review no es solo Hosting — el Tramo 1 redespliega
`metaWebhook`/`onWebhookInbox` (camino del revisor). **Recomendación: NO-GO hoy; GO
condicionado a la verificación del owner en el dashboard (§10.3) + ventana §10.4 + re-corrida
del script el día del deploy.** Verificación: typecheck/lint/build/diff-check en 0; E2E no
corresponde (programa de solo lectura y análisis).

### RELEASE-AUDIT-TRES-PROGRAMAS-1 — 2026-08-18 (READ-ONLY — CERO DEPLOY EJECUTADO)

Plan de release exacto y verificado de los tres programas EN REPO, en
`docs/release-plan-tres-programas.md`. **Base confirmada contra producción**: el `updateTime`
máximo de las 118 functions es 2026-08-16T00:35Z con exactamente 10 actualizadas ese día (las
de DEPLOY-AI-PHASE2 desde `6f75601`; nada posterior) ⇒ se corrigió
`release-audit.mjs:COMMIT_BASE_DESPLEGADO` `'30c1687'`→`'6f75601'` (único cambio de código).
**Audit con base corregida: veredicto OK, cero bloqueos** — 139 exports coincidentes
fuente/compilado, 0 divergencias de grafo, precondición `automationMode` aprobada (2/2),
contraste exacto 20 ausentes-en-prod == 20 CREATE.

**Hallazgos del cálculo**: (1) CREATE = 20, no 14 — el selector crudo incluye las **6
`coexistence*`** de la fundación EN REPO (Programa 2 bloqueado): el plan las EXCLUYE; (2)
UPDATE = **las 118** (sinCambio 0): `lib/firebase.ts` y `audit/audit.ts` son universales ⇒ el
release es un redeploy completo + 14 CREATE; (3) schedulers reales: **8**, no 7; (4) único
delta Firestore: TTL `metaOAuthStates` (3 ACTIVE en prod, repo declara 4); 21 índices READY ==
repo; cero Rules. **Backend-first APTO sin Hosting** (0 referencias del panel `6f75601` a las
14 CREATE; contratos consumidos aditivos; 3 divergencias de forma de error documentadas en
flujos hoy no ejercitados) ⇒ release en 2 tramos: backend (4 pasos ordenados) + Hosting
bloqueado por App Review. Rollback = los 118 UPDATE sin CREATEs; las 14 creadas quedan vivas e
inertes (callables auth-gated; retiro real = `functions:delete` con gate propio).

**Verificación**: typecheck/lint/build/diff-check en 0. Los tests
`tests/integration/release-audit.*.test.ts` que menciona el header del script **no existen**.
Deploy: NINGUNO — documento y constante solamente.

ADR-0022 sobre ADR-0015: eje declarado `catalogSync.relationship` (`none|mirror|managed`) con
derivación pura de autoridad (`vendeyapy|meta|external`; el bot siempre `local_mirror`). Legacy
sin backfills: arfagi ⇒ external+mirror, sin config ⇒ vendeyapy+none, `mode` no participa.
Transición preview→apply con planHash/TTL/uso único/huella `concurrent_change` y update mask
estricto (jamás `enabled`/`mode`/`catalogId`/`live`/opt-ins/deletes). Gating por relación en
todos los callables de Meta + schedulers (drain-only) + RBAC `catalogSyncApply` owner-only.
Panel con selector honesto, confirmación fuerte, frescura y edición consciente de campos
gobernados.

**Review adversarial:** 1 ALTO (zombis de outbox + deadlock de regreso) + 1 MEDIO (carrera de
encolado) + 6 BAJO — todos corregidos (sweep/discard siempre, re-derivación en la tx de encolado).
**Verificación:** batería en 0; E2E nuevo 23/23 + meta-catalog 194/194 + 4 regresiones verdes.
**Deploy futuro:** 2 CREATE + updates `metaCatalog*`/`runTenantJob`/schedulers + Hosting; sin
índices ni Rules.
**Deudas al conector:** selector de `catalogId`, URL directa, TTL de runs.

### CONVERSATIONS-WHATSAPP-UX-1 — 2026-08-18 (EN REPO — NO DESPLEGADO)

ADR-0021, bandeja profesional. Los recibos de Meta dejan de descartarse → `deliveryStatus`
monotónico transaccional por wamid (pending<sent<delivered<read, failed terminal temprano,
jamás inferir leído, cero costo de IA). `profileName` capturado. Media saliente
(`sendImage`/`sendDocument` + upload multipart + `conversationSendAttachment`: magic bytes,
allowlist, caption al documento — nunca a la IA, idempotencia con lease, jamás comprobante,
doble cerrojo). Guard de routing único para texto y media. 10 callables de ciclo de
vida/vínculo/búsqueda/asignación con matriz §7 y 9 audits. `softDelete` reversible sin borrado
físico. Panel reescrito (10 componentes, filtros, separadores, ticks accesibles, adjuntos,
borradores, info con teléfono enmascarado).

**Verificación:** RED-first; batería en 0; E2E nuevo 42/42 + 5 regresiones verdes; visual en
3 viewports con 3 hallazgos corregidos; review adversarial 0 ALTO, 1 MEDIO + 6 BAJO, todos
corregidos; P1-P3 documentados en el ADR.
**Deploy futuro:** 11 CREATE + updates de webhook/manualMessage/adjuntos + Hosting; sin
índices, Rules ni TTL.

### META-ONBOARDING-SELF-SERVICE-1 — 2026-08-17 (EN REPO — NO DESPLEGADO)

ADR-0020: lifecycle owner-facing consolidado, 11 gaps cerrados, cero sistema paralelo.
Selección de WABA con estado pendiente + `completeMetaConnectWaba`; verify/disconnect por
`connectionId` (incluidas `wa_*` para el owner); disconnect de main transaccional con secreto
compensable y retiro del pendiente huérfano; guard de WABA en el índice global en la misma tx;
rate-limit de nonces; TTL de `metaOAuthStates`; `meta.verified`/`meta.reconnected` con actor.
Panel completo: selector de WABA, confirmación fuerte, `lastConnectError` traducido, antigüedad
de verificación, acciones por número, a11y.

**Verificación:** rojo→verde por gap; fase4b 27/27 (sección AUTOSERVICIO) + 7 regresiones
verdes; review adversarial 1 MEDIO + 2 BAJO, todos corregidos.
**Deploy futuro:** 1 CREATE + updates de meta-connect + índices TTL + Hosting.
**Deuda:** scheduler de salud (G5).

### DEPLOY-AI-PHASE2-SALES-RESERVATION-1 — 2026-08-16Z (EN PROD — ACTIVO)

Fase 2 desplegada desde `6f75601`: 10 UPDATE / 0 CREATE / 0 DELETE (las 9 de soporte primero,
`onWebhookInbox` al final; `devMessage` excluida a propósito). Realiza el release de
AI-PHASE2-MATCHER-AND-RESERVATION-HARDENING-1.

**Smokes por wamid:** "hola" determinístico sin reserva ni `aiRequest`; consultivo con reserva
`ventas-{wamid}` estimada 9775 → liquidada real 3833, conciliación exacta, espejo en 0, una
sola respuesta. 117 functions intactas, `automationMode: live` ×2, visión AUSENTE ×3, meta-review
y credipower preservados, logs limpios.
**Rollback armado y conservado:** `bdaffbe` + `30c1687`.
**Deuda pre-activación de visión:** reconciliar el precio de Odyssey.

### AI-PHASE2-MATCHER-AND-RESERVATION-HARDENING-1 — 2026-08-15 (desplegado el 2026-08-16)

Matcher de identificación estructurado (`matched`/`ambiguous`/`no_match`, evidencia estructural
+ margen; conteo, posición y precio jamás identifican) reemplaza la decisión por conteo de
visión. Reserva contextual del sales agent (`estimarTurnoDeTexto`: chars/3 + rondas, piso 1500,
techo 16k, clamp al límite efectivo) reemplaza la estática de 1500 (real 3770).

**Causa raíz honesta del canary:** el guard de deriva excluía al ARMAF (conflicto de precio
pendiente del owner) — el matcher no era el único culpable.
**Review adversarial:** 0 ALTO / 3 MEDIO / 1 BAJO, todos corregidos.
**Selector:** 10 UPDATE + 0 CREATE + 0 DELETE (`onWebhookInbox` + las 9 de Fase 1c).

### WHATSAPP-AUTOMATIONMODE-DUAL-MIGRATION-AND-VISION-RECANARY-1 — 2026-08-15 (EN PROD)

Migración dual de `automationMode` → `live` con la herramienta oficial: …7904 (arfagi) y …5686
(meta-review) written; índice no tocado; conexiones byte-idénticas; rollback `--mode inactive`
documentado (equivalente fail-closed, no byte-idéntico: el campo nacía AUSENTE). ADC habilitada
por el owner tras un stop fail-closed. PNID de meta-review leído del índice tras un `not_found`
por reconstrucción de memoria.

**Checks del runbook:** dual 20/20 + coexistence 51/51.
**Re-canary de visión EXITOSO:** job `succeeded` + enviado, reserva liquidada 2507, espejo 0,
respuesta entregada por …7904, `sin_match` honesto (calibración del matcher pendiente).
Flag restaurado a AUSENTE; `live` se conserva. Fase 2 desbloqueada, pendiente de aprobación.

### AI-VISION-PROVIDER-CANARY-ARFAGI-1 — 2026-08-15 (BLOQUEANTE DOCUMENTADO — RESTAURADO)

Canary real de visión en arfagi: producer/job/claim/reserva (liquidada 2529)/extracción/catálogo
todo por contrato, cero duplicados ni efectos comerciales.
**Bloqueante hallado:** el `whatsappClient` del artefacto nuevo aplica el gate de ADR-0017 y
`automationMode` estaba AUSENTE en …7904 ⇒ envío bloqueado ⇒ `failed`/`envio_incierto`.
Kill-switch + flag restaurado a AUSENTE, verificado contra baseline.
**Precondición operativa aprendida:** liberar takeovers residuales del tester antes de un canary.

### DEPLOY-AI-RESERVATION-VISION-INERT-1 — 2026-08-15 (EN PROD — VISIÓN INERTE)

Deploy de ADR-0018 + ADR-0019 desde `bdaffbe`: índices 18→21 (3 `ai*` READY, 0 deletes), rules
`a9c99e05`→`132712ca` (0 quitadas, 6 matches `if false`, probes 403), Functions 115→118 con
selector exacto 3 CREATE + 6 UPDATE + 0 DELETE, sin `--force`. `onWebhookInbox` intacto
(updateTime 2026-08-01, hash idéntico en las 106 no tocadas). Rollback armado ANTES del deploy
(worktree `30c1687` + tooling HEAD; cubre las 6 UPDATE — el "4 UPDATE" del plan v1 estaba mal).

**Smoke humano:** reserva `ventas-…` creada→liquidada (est. 1500 / real 3770), espejo en 0,
delta conciliado al token exacto, cero efectos externos, meta-review intacto.
**Estado:** flag de visión APAGADO en los 3 tenants. Scheduler horario sin invoker público.

### AI-VISION-PRODUCER-DECOUPLE-1 — 2026-08-14 (EN REPO — NO DESPLEGADO)

Productor de visión desacoplado: trigger `onAiVisionProducer` sobre `inbox→processed`
(compatible con el `process.ts` productivo viejo); `process.ts` byte-idéntico a `855d553`;
clasificación estricta `generic_media`; discriminador `mediaId` sin timers; grafo probado en dos
pasadas (`onWebhookInbox` ya no alcanza visión). 16 tests + E2E 12/12 por el trigger real.

### AI-VISION-RELEASE-TRAIN-PREP-1 — 2026-08-14 (read-only)

Plan de release de ADR-0018/0019 en `docs/ai-vision-release-plan.md`. SEPARABLE: Fase 1
independiente (2 CREATE + 4 UPDATE sin el gate); Fase 2 (`onWebhookInbox`) bloqueada hasta
migrar `automationMode` de dos números. Cero deploy, cero mutaciones. Dos pasadas del grafo
coincidentes; App Review protegida por diseño del selector.

### PRODUCT-IMAGE-UNDERSTANDING-SAFE-1 — 2026-08-14 (desplegado inerte el 2026-08-15)

ADR-0019: visión de productos contra el catálogo local. Job durable idempotente por
`attachmentId`, claim+lease+fencing, envío único, reserva `imagen_vision` antes del proveedor,
tool forzada con zod (**la IA describe, jamás decide**), `searchCatalog` + guards como única
autoridad, comprobantes con precedencia absoluta, caption jamás al modelo, takeover = silencio.
28 tests núcleo con neutralización + E2E 11/11 con el trigger real del emulador. Activación
productiva = programa aparte.

### AI-USAGE-RESERVATION-AND-ALERTS-1 — 2026-08-14 (desplegado el 2026-08-15)

ADR-0018: reserva transaccional de cuota de IA — cierra AI-GATE-RESERVA-1 y AI-QUOTA-ALERTS-1.
Ciclo reservada→liquidada|liberada|vencida con clave determinística (wamid), contador espejo
`aiTokensReserved`, liquidación exactamente-una-vez con uso real (incluye parcial en error),
recuperación lazy + scheduler horario, alertas idempotentes 70/85/95/100 por campana.
12 casos discriminantes con neutralización demostrada + E2E 9/9 de concurrencia real.

### Programa 2 — Preflight del release de Coexistence — 2026-08-06 (DETENIDO FAIL-CLOSED)

Etapa A verde completa (batería + E2E + grafo de 122 exports, CREATE=6 / UPDATE=115 / DELETE=0)
y baseline productiva congelada read-only (un solo PNID, `automationMode` ausente =
`migracion_pendiente` esperado; credipower intacto). Runbook corregido con 6 precisiones
doc-only.
**Detenido antes de toda mutación:** 5 gates externos de Meta sin evidencia (incluida la
elegibilidad de Paraguay), `config_id` de Coexistence sin crear, ADC ausente en la máquina
(resuelto el 2026-08-15), y decisión v2/v3 pendiente del owner.

### Cierre correctivo final de Coexistence — 2026-08-05 (EN REPO — NO DESPLEGADO)

11 hallazgos de Codex Security + 8 de la review adversarial posterior, cerrados con test rojo
primero. El CRITICAL fue del propio correctivo anterior: un mapa vacío con merge **reemplaza**
en Firestore, y el guard monotónico borraba el resumen del cliente. Dos pasadas E2E completas
desde emuladores limpios (14 suites cada una). Cuatro pruebas externas diferidas al Programa 2
(contrato de timestamp, cardinalidad de WABA, prueba de offboarding, provenance de bundles),
resueltas fail-closed en código sin validación real.

### Correctivo Coexistence — 2026-08-04 (cierre del Programa 1, EN REPO)

Cerrados los 7 gates restantes: `live` real por herramienta (gate transicional retirado con
garantía estructural + E2E dual 20/20), IG/Messenger con canal propio, cutover transaccional con
rollback byte a byte (verify-cutover 22/22), UI humana del historial, generaciones del historial
(offboard cierra honesto; solo un signup nuevo abre la siguiente), backup de Storage con bytes +
restore aislado (backup-restore-e2e 51/51, exige los tres emuladores).

### Coexistence — fundación — 2026-08-04 (EN REPO — NO DESPLEGADO)

`automationMode: inactive|shadow|live` separa "la credencial sirve" de "el bot puede contestar",
fail-closed. Embedded Signup en dos flujos; el de Coexistence usa
`featureType = whatsapp_business_app_onboarding` y crea una conexión `wa_{pnid}` que jamás toca
`metaConnections/main`. El PNID se resuelve server-side desde el WABA porque el evento de cierre
oficial no lo trae. El historial hay que pedirlo (`smb_app_data`) y se pide UNA sola vez.
Número real no conectado, QR no ejecutado, backup productivo no ejecutado.

### RELEASE-SECURITY-AND-RUNBOOK-HARDEN-1 — 2026-08-03 (EN REPO — SIN DEPLOY)

Aislamiento de secretos por entorno, corregido en dos capas independientes. (1) `build-deploy.mjs`
copiaba cualquier `.env.<algo>` no-`.local` porque **no sabía a qué proyecto se desplegaba**:
ahora el destino es obligatorio y la allowlist es `.env` + `.env.<projectId>` +
`.env.<alias-que-resuelve-a-ese-projectId>`. (2) Los dos `firebase*.json` excluyen `.env*` del
zip. Probado con el walker real del CLI (13.35.1): 2191 y 874 archivos, cero `.env` subidos,
variables idénticas (10 prod / 8 staging).

**Hallazgos del runbook:** `hosting:rollback` NO EXISTE en ninguna de las dos versiones en juego
(el real es `hosting:clone`, con dos falsos positivos verificados); `gcloud` no está instalado
(el freno del scheduler va por REST); `pnpm deploy:rules` estaba hardcodeado a staging desde
`3939676` — falso positivo perfecto.
**Verificación:** typecheck 0, lint 0 errores, 2.956 tests, build 0, deploy-guard --audit 0.
**Exposición:** el bucket `gcf-v2-sources` no es público y los 4 secretos tienen valores
distintos por entorno ⇒ la fuga es interna y no alcanza a producción.
**Pendiente:** rotación NO ejecutada; 109 versiones vivas construidas con el `.env` de staging.

### Defectos que destapó el deploy de adjuntos — 2026-08-01/03

Seis, cada uno con programa propio, documentados en `docs/deploy.md` y `docs/HANDOFF.md`.
El más grave sigue abierto: **`releaseToBot` destruye el estado de checkout (ALTO)** — ver
`ESTADO.md`. Los otros cinco: fuga de secretos de staging (mitigada), `hosting:rollback`
inexistente, `deploy:rules` hardcodeado, el rollback no frena schedulers, y 4 secretos
productivos como env vars planas.

---

## 2026-07 y anterior — resumen

Entradas comprimidas. El detalle completo está en el resumen original de Codex
(`docs/_archive/codex-resumen-2026-08-18.md`).

- **`30c1687` — 2026-08-01/03 (EN PROD).** Adjuntos de conversación (ADR-0016): imágenes y PDF
  con ingesta endurecida, dos ejes ortogonales, rollout en dos niveles fail-closed
  (`attachments.ingest.enabled` + `receiptGate.enabled`), solo en arfagi. La ingesta **jamás**
  mueve un pedido. Visión y OCR diferidos. 115 ACTIVE, cero índices nuevos.
- **`d542cda` — 2026-07-31 (EN PROD).** Modelo de propiedad del catálogo por campos (ADR-0015);
  arfagi migrado a `external_managed`; primera reconciliación 50 `verified` / 131
  `drifted_external`. Resuelve el conflicto de fuente de verdad del 2026-07-30.
- **`6cfc464` — 2026-07-29 (EN PROD, dry-run).** Onboarding genérico de catálogos + centro de
  calidad (ADR-0014). Perfil `perfumeria` explícito de arfagi.
- **2026-07-30.** Importación genérica ejecutada: 150 artículos solo-en-Meta importados, 33→183
  productos, todos INACTIVE e invisibles para bot/carrito/checkout.
- **`fbb7aab` / `50793bc` — 2026-07-28 (EN PROD).** Preview binding y outbox de escrituras de
  catálogo, en dry-run inerte. Canary de Odyssey ejecutado y aprobado por el owner (única
  escritura a Meta de toda la historia del proyecto).
- **`eb28365` — 2026-07-25 (EN PROD).** Coverage GO-LIVE + PURGE-FIX-1: E2E real validado,
  Coverage reactivado solo en arfagi con activationId nuevo, `required`, máx ₲200.000.
- **`5f8ccbc` — 2026-07-24 (EN PROD).** Shipping Chat completo (ADR-0011): la IA jamás decide
  dinero; saga TX-A→claim→Meta→TX-C con el outbox como única fuente de verdad.
- **`0326784` — 2026-07-18 (EN PROD, flag OFF entonces).** Paquete Coverage con kill-switch
  atómico y contrato fail-closed `enabled + activationId`.
- **`1497b40` — 2026-07-16.** COVERAGE-GUARD-1: interceptor determinístico antes de la IA para
  consultas de cobertura, envío y plazos.
- **`855b00d` — 2026-07-16.** AI-FALLBACK-HONESTO-1: con la cuota agotada el bot deriva a un
  humano en vez de degradar en silencio.
- **`e0c284e` — 2026-07-15.** HANDOFF-2: pase real a una persona antes de la IA, transaccional
  e idempotente, con bot silencioso durante el takeover.
- **`97bb035` — 2026-07-15.** WHATSAPP-AGENT-F7: fidelidad estricta en consultas por producto
  y marca.
- **2026-07-15.** Incidente de cupo de IA (251.398 tokens vs límite de 250.000), mitigado;
  límite growth 250.000 → 1.500.000.
- **2026-07-13.** Migración de dominio: `vendeyapy.com` sirve producción con SSL.
