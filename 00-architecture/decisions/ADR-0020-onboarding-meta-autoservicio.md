# ADR-0020 — Onboarding Meta autoservicio: lifecycle de conexión owner-facing

- **Estado:** aceptado (2026-08-17) — EN REPO, NO DESPLEGADO
- **Programa:** META-ONBOARDING-SELF-SERVICE-1
- **Relacionados:** ADR-0009 (integración Meta), ADR-0010 (go-live), ADR-0017 (Coexistence y
  `automationMode`), ADR-0002 (multi-tenant); mapa de gaps del programa (11 hallazgos con evidencia)

## Contexto

El ciclo de conexión owner-facing YA existe y es sólido: Embedded Signup con nonce de uso único
atado a tenant+uid+flujo (`metaOAuthStates`, TTL 10/30 min), intercambio del `code` 100%
server-side con single-flight por hash, validación de app/token/scopes/WABA, SecretStore con
referencia opaca y compensación, descubrimiento transaccional de assets con guard de colisión
PNID→tenant (`assertPnidLibre`), preflight persistido y desconexión acotada a `main`. Este ADR
**no crea un sistema nuevo**: consolida ese contrato y cierra los gaps que impiden que un
TENANT_OWNER opere solo, con estos hallazgos como alcance (numeración del mapa del programa):
G2 selección de WABA imposible para el owner, G3 números Coexistence sin desconexión owner,
G4 verificación solo de `main`, G6 desconexión sin actor en la auditoría, G7 sin acciones
`meta.verified`/`meta.reconnected`, G8 `lastConnectError` invisible, G9 nonces sin TTL de
limpieza, G10 emisión de nonces sin límite, G11 colisión WABA sin guard, G12 desconexión no
transaccional.

## Decisión

### 1. Lifecycle y autoridad

Cuatro operaciones owner-facing (`TENANT_OWNER` o `PLATFORM_ADMIN`, RBAC único de
`meta/authz.ts`), todas idempotentes, tenant-scoped por claims del server (jamás por el
navegador), con errores saneados (razones enum, nunca texto crudo de Graph) y auditoría sin
tokens/codes/URLs:

- **CONECTAR** (`startMetaConnect` + `connectMeta`): con UN WABA (o `wabaId` explícito), sin
  cambios. Con MÚLTIPLES WABA y sin `wabaId`, el `code` YA fue canjeado y reclamado
  (single-flight): no se puede pedir "reintentá" sin otro login. Se introduce el estado de
  **SELECCIÓN PENDIENTE**: el token se guarda en un secreto PENDIENTE de nombre determinístico
  por tenant (a lo sumo un huérfano, sobrescribible y retirado al completar), referenciado por
  un nonce de modo `waba_selection` (mismo mecanismo `metaOAuthStates`: tenant+uid, TTL 10 min,
  uso único), y `connectMeta` responde `waba_selection_required` con la lista SANEADA de WABAs
  autorizados por el token (id + nombre) + el id de selección. La callable nueva
  **`completeMetaConnectWaba({selectionId, wabaId})`** consume el nonce, retira el secreto
  pendiente y termina el MISMO camino de conexión con el WABA elegido — jamás se elige uno
  dudoso, y el owner desambigua solo. La emisión de nonces gana un **límite por tenant**
  (ventana corta, transaccional): la emisión ilimitada era el único costado sin freno del
  single-flight.
- **VERIFICAR** (`verifyMetaChannel`): acepta `connectionId` opcional (default `main`),
  reutilizando el soporte ya existente de `preflight.ts`. Persiste salud/`lastVerifiedAt`/razón
  saneada; NO altera routing, token, modo, WABA ni PNID. Audita **`meta.verified`** con actor.
- **RECONECTAR** (= `connectMeta` sobre una conexión existente): el intercambio ya es
  compensable (secreto previo restaurable, discovery antes de `active`). Se agrega la
  distinción de auditoría: si había una conexión `active`, se registra **`meta.reconnected`**
  (no `meta.connected`). Si token/scopes/assets del reemplazo fallan, la conexión anterior
  queda operativa (contrato existente, ahora cubierto por test discriminante).
- **DESCONECTAR** (`metaDisconnect`): gana `connectionId` opcional — `main` (comportamiento
  actual) o una conexión `wa_{pnid}` de Coexistence (antes solo PLATFORM_ADMIN). La baja de un
  número propio reutiliza la lógica de `deactivateWhatsappNumber` con RBAC de owner. La
  desconexión de `main` se vuelve **transaccional**: índice + assets + conexión en UNA
  transacción (el routing muere junto con el estado, nunca queda un `not_connected` que sigue
  ruteando); el retiro del secreto queda FUERA de la tx como etapa compensable posterior (si
  falla, la conexión ya está `not_connected` con ref vacía y el secreto huérfano se retira en el
  reintento idempotente — nunca al revés). NO se elimina nada dentro de Meta: ni WABA, ni
  número, ni catálogo; el copy de la UI lo dice.

### 2. Estados y verdad persistida

Los 8 `MetaConnectionStatus` existentes se conservan. La UI muestra SOLO verdad persistida:
estado, scopes, `lastVerifiedAt` (con su antigüedad), y — nuevo — la razón saneada de
`lastConnectError` cuando el último intento falló. "Conectado" y "automatización en vivo"
siguen SEPARADOS: conectar jamás escribe `automationMode` (gate de ADR-0017, intocado); el
badge de automatización ya existente lo hace visible.

### 3. Aislamiento multi-tenant

- PNID: guard transaccional existente (`assertPnidLibre`) — intocado.
- **WABA (G11, nuevo):** el descubrimiento escribe también `metaExternalIndex/waba_{id}` en la
  MISMA transacción y con el MISMO guard de "libre o mío": dos tenants ya no pueden reclamar el
  mismo WABA con números distintos. Sin migración: la ausencia de entrada = libre; los WABA ya
  conectados se reclaman en la próxima conexión/reconexión. **Ventana asumida (review):** hasta
  esa reconexión, un WABA pre-conectado es reclamable por cualquier tenant con acceso REAL a él
  en Meta (agencias/Tech Provider compartidos); las conexiones de Coexistence (`wa_*`) no
  escriben `waba_` (solo el descubrimiento de `main`/manual lo hace). Nota operativa del futuro
  deploy: reconectar los tenants existentes para sellar su reclamo.
- Nonces: ya atados a tenant+uid+modo; ganan política TTL de Firestore sobre `expiresAt` (G9)
  para que los abandonados no crezcan sin límite (limpieza pasiva, cero código).

### 4. Rollback y no-destructividad

- Conectar/reconectar: compensación existente del secreto + discovery-antes-de-active.
- Desconectar: transacción única (G12) ⇒ o todo o nada; el secreto es la única etapa posterior
  y es idempotente-reintentable. Nada se revoca ni destruye REMOTAMENTE en Meta: no existe (a
  propósito) ninguna acción de borrado remoto en este ADR.
- Deploy futuro: superficie estimada UPDATE de los callables tocados + índice/TTL; cero CREATE.

## Deudas explícitas (fuera de este ADR)

- **G5 — verificación periódica programada:** un token vencido sigue sin detectarse solo hasta
  que alguien verifica. Se difiere para no sumar una función CREATE al próximo deploy; la UI
  mitiga mostrando la antigüedad de la última verificación. Candidata a scheduler propio.
- Revocación remota del token al desconectar (acción distinta y explícita si algún día se
  quiere; hoy deliberadamente inexistente).
