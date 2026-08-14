# ADR-0018 — Reserva transaccional de cuota de IA y alertas por umbral

- **Estado:** aceptado (2026-08-14) — EN REPO, NO DESPLEGADO
- **Programa:** AI-USAGE-RESERVATION-AND-ALERTS-1 (cierra los pendientes `AI-GATE-RESERVA-1` y `AI-QUOTA-ALERTS-1` de HANDOFF §6.3)
- **Relacionados:** ADR-0002 (multi-tenant), ADR-0016 §9 (adjuntos: la IA no ve captions), guía `docs/ai-backend-guide.md` (§Costos, §Jobs async, §Principios línea 19)

## Contexto

El gate de IA vigente es **check-then-act sin transacción**: `assertAiBudget` lee el uso
(`checkQuota`, lectura suelta) y decide con una estimación fija de 1.500 tokens
(`EST_TOKENS_PER_TURN`), y el consumo real se registra DESPUÉS del proveedor con un
`FieldValue.increment` ciego (`meterAiUsage`) envuelto en `try/catch` vacío. Consecuencias
medidas y registradas:

1. **TOCTOU**: dos turnos concurrentes del mismo tenant pasan el gate a la vez y sobregiran
   la cuota (el incidente del 2026-07-15 — 251.398/250.000 — fue de este tipo: el agotamiento
   se detectó tarde y en silencio).
2. **Subconteo silencioso**: si el increment posterior falla, el consumo real no se registra.
3. **Sin reconciliación**: la estimación nunca se compara con el uso real; no hay liberación.
4. **Sin alertas**: el owner se entera del agotamiento cuando el bot ya degradó
   (AI-FALLBACK-HONESTO-1 lo hace honesto, pero avisa recién al BLOQUEAR, no al acercarse).

El próximo programa (visión/OCR de comprobantes e imágenes) multiplica el costo por turno,
así que esta base debe quedar cerrada ANTES.

## Decisión

### 1. Ciclo de vida persistido de cada llamada facturable

Colección nueva **`tenants/{tenantId}/aiReservations/{clave}`** — solo metadata operativa
(jamás prompts, mensajes, imágenes, PII ni tokens de auth):

```
{ id, tenantId, context,            // AiContext existente ('whatsapp_sales_agent' | ...)
  status: 'reservada' | 'liquidada' | 'liberada' | 'vencida',
  estimatedTokens, actualTokens?, costUsd?,
  periodStartMs,                    // período vigente al reservar (informativo)
  reservedAt, expiresAt,            // lease: reservedAt + AI_RESERVATION_LEASE_MS (10 min)
  settledAt?, releasedAt?, expiredAt?, motivo? }
```

- **La clave del documento ES el identificador lógico determinístico** de la llamada:
  `ventas-{wamid}` para el agente de ventas (los reintentos del webhook re-entran con el
  mismo wamid ⇒ misma reserva, jamás doble facturación); `interno-{uuid}` y `sim-{uuid}`
  para asistente interno y simulador (su unidad de reintento es la propia invocación:
  no existe re-entrega upstream que re-ejecute el mismo turno lógico).
- Contador espejo en el doc tenant: **`usage.aiTokensReserved`** (number). NO entra en el
  `ZEROED` del reset mensual: las reservas en vuelo cruzan el cambio de período y su propio
  ciclo (liquidar/liberar/vencer) lo drena, siempre con **clamp a ≥ 0** calculado dentro de
  la transacción (nunca increment ciego negativo).

### 2. Reserva previa (transaccional)

`reservarTurnoDeIa(tenantId, clave, estimatedTokens, { context, actorUid })` — módulo único
`entitlements/aiReservation.ts`, la ÚNICA abstracción para todos los consumidores:

1. `assertFeatureEnabled('aiAssistant')` — sin cambios (`failed-precondition`).
2. `maybeResetUsage` (lazy reset existente) + `resolveEntitlements` (posture/trial: mismos
   códigos de error que hoy — `failed-precondition`; cuota — `resource-exhausted`).
3. **Transacción**: lee el doc tenant y el doc de reserva.
   - La reserva ya existe `reservada` ⇒ se **reusa** (no se re-reserva: dos ejecuciones
     concurrentes con la misma clave obtienen una sola reserva).
   - Ya cerrada (`liquidada`/`liberada`/`vencida`) ⇒ handle **inerte** (no re-factura).
   - No existe ⇒ `decideQuota(liquidado + reservado, límite, est)` con la función pura
     existente; **used = aiTokensThisMonth + aiTokensReserved**. Si no cabe ⇒ intento único
     de **recuperación lazy** de reservas vencidas del tenant y re-chequeo; si sigue sin
     caber ⇒ audit `entitlement.blocked` + alerta `agotado` (idempotente) +
     `resource-exhausted`. Si cabe ⇒ `tx.create(reserva)` + `aiTokensReserved += est`.
4. Devuelve un handle `{ liquidar, liberar }`.

**Invariante agregado**: en todo momento `aiTokensThisMonth + aiTokensReserved ≤ límite`
para las operaciones admitidas (las N reservas concurrentes compiten por transacción:
Firestore serializa y solo caben las que caben).

### 3. Liquidación exactamente-una-vez

`handle.liquidar({inputTokens, outputTokens}, costUsd)` — transacción:
- estado ≠ `reservada` ⇒ **no-op idempotente** (reintentar no re-cobra).
- estado `reservada` ⇒ `status: 'liquidada'`, `aiTokensThisMonth += real`,
  `aiCostUsdThisMonth += costo`, `aiTokensReserved = max(0, reservado − est)` (la
  diferencia estimado-vs-real queda liberada implícitamente: se descuenta la estimación
  completa y se suma solo lo real).
- Nunca lanza al caller (igual que el metering actual); si falla tras reintentos de la
  transacción, la reserva queda `reservada` y la recupera el vencimiento (sin doble cobro).

`handle.liberar(motivo)` — error ANTES de contactar al proveedor (p.ej. gateway `disabled`):
transacción `reservada → liberada`, devuelve la capacidad completa. Idempotente.

**Resultado ambiguo** (el proveedor respondió pero el proceso murió antes de liquidar): la
reserva queda `reservada` hasta `expiresAt` ⇒ **recuperable**, sin doble cobro y sin
liberación prematura (el lease de 10 min supera con margen la duración máxima de un turno:
timeout 10 s × 5 llamadas del loop de tools). El gateway ahora devuelve el uso PARCIAL
acumulado también en `status:'error'` (metadata segura que ya acumulaba), así el caller
liquida lo realmente consumido en errores a mitad del loop — hoy se perdía.

### 4. Recuperación de reservas abandonadas

Dos vías (patrón de mantenimiento existente + lazy):
- **`aiReservationMaintenance`** (scheduler nuevo, mismo patrón que
  `attachmentRetentionMaintenance`): collection-group
  `aiReservations where status=='reservada' && expiresAt < now` ⇒ por doc, transacción
  `reservada → vencida` + devolución del contador con clamp. Índice collection-group
  `(status ASC, expiresAt ASC)` — exigido por esta query real.
- **Lazy en la reserva**: al rechazar por falta de capacidad se barren primero las vencidas
  del propio tenant (query acotada) y se re-chequea — la recuperación no depende del cron.

### 5. Alertas agregadas e idempotentes (campana existente)

Umbrales centralizados `UMBRALES_ALERTA_IA = [70, 85, 95, 100]` (% del límite efectivo,
según el pendiente literal de HANDOFF). Al liquidar (y al bloquear una reserva, para el
100) se evalúa `pct = aiTokensThisMonth / límite` y se emite a
`tenants/{t}/notifications` con el patrón de idempotencia canónico del repo
(**id determinístico + `.create()` + tragar `already-exists`**, como `handoff.ts:261`):
`id = ai-quota-{AAAAMM del período}-{umbral}` ⇒ exactamente UNA campana por
tenant × período × umbral. Categoría nueva `ai_quota`, tipos
`ai_quota_70 | ai_quota_85 | ai_quota_95 | ai_quota_agotada` (unión en
`@vpw/shared/notification.types.ts` + severidad en el panel). Visible para OWNER (scope
'all' existente); sin PII: solo porcentaje, tokens y límite. El límite ilimitado
(enterprise) no alerta.

### 6. Compatibilidad y API futura

- `salesAgent`/`internalAssistant` cambian SOLO el seam de deps: `assertBudget` +
  `recordUsage` se reemplazan por `openBudget(tenantId, clave, est) → handle`. El mapeo de
  errores estructurado (`resource-exhausted` → `quota_exhausted` → derivación honesta;
  `failed-precondition` → `feature_unavailable`) queda BYTE a byte igual; los tests
  vigentes de esos mapas siguen en verde.
- El simulador y los test cases corren el motor real ⇒ heredan la reserva por el mismo seam
  (clave sintética); su exención de cuota sigue siendo el programa AI-USAGE-ATTRIBUTION-1,
  fuera de este alcance.
- **Estimaciones por operación** centralizadas en `estimacionDeTokens(op)`:
  `texto_ventas: 1500`, `texto_interno: 1500` (los `EST_TOKENS_PER_TURN` duplicados se
  mudan acá), `imagen_vision: 2600` — **declarada pero SIN consumidor**: visión/OCR queda
  para el programa siguiente; ningún modelo de visión se conecta acá.

### 7. Autorización y Rules

- Todo nace del `tenantId` resuelto server-side (claims/inbox/índice — sin cambios); el
  modelo y el navegador jamás proponen tenant.
- `aiReservations`: match explícito **`allow read, write: if false`** (patrón de
  superficies puras backend, como `coverageResumeJobs`); el default-deny ya la cubría,
  el match la documenta. Los clientes no pueden crear/alterar/liquidar/liberar reservas.
- El panel no necesita lectura nueva: el resumen de uso ya existe (doc tenant, campo
  `usage` legible por rol) y las alertas llegan por la campana existente.

## Consecuencias

- (+) El límite del plan se vuelve un TOPE real bajo concurrencia, no una aspiración.
- (+) Contabilidad exacta: reconciliación estimado-vs-real por turno, errores a mitad de
  loop incluidos; el owner se entera ANTES de agotar.
- (+) La visión/OCR entra después con una llamada: `reservarTurnoDeIa(..., estimacionDeTokens('imagen_vision'))`.
- (−) Una escritura transaccional más por turno de IA (reserva) + una al liquidar; costo
  aceptable frente al costo del modelo.
- (−) `usage.aiTokensReserved` es contador espejo: si un bug lo desalineara, el clamp y el
  vencimiento lo drenan; el barrido lo corrige sin intervención.
- Deuda explícita: los umbrales alertan por TOKENS; el costo USD sigue sin límite propio
  (`maxAiCostUsdPerMonth` no existe en `PlanLimits`) — igual que hoy, fuera de alcance.
