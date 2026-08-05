# Runbook del Programa 2 — incorporar el número real con Coexistence

> **Nada de este documento se ejecutó.** Es el ORDEN escrito y verificable del release posterior,
> producido por la auditoría read-only del Programa 1 (`WHATSAPP-COEXISTENCE-FOUNDATION-COMPLETE-1`,
> etapa I). Al 2026-08-04 no hubo deploy, ni escritura en producción, ni llamada mutante a Meta, ni
> QR, ni migración de `automationMode`.
>
> Contexto obligatorio antes de tocar nada: `00-architecture/decisions/ADR-0017-…md`,
> `00-architecture/ARCHITECTURE.md` §12 y §12.1, y `docs/HANDOFF.md` §5 (reglas de deploy).

---

## 0. Cómo se calculó esto, y cómo se vuelve a calcular

La superficie de abajo **no está escrita a mano**: la calcula `apps/functions/scripts/release-audit.mjs`
del grafo de imports, recorriendo `apps/functions/lib/**/*.js` (compilado) y `apps/functions/src/**/*.ts`
(fuente) y exigiendo que las dos vías coincidan exactamente.

```
pnpm --filter functions build          # el grafo se calcula del COMPILADO: sin build no hay auditoría
node apps/functions/scripts/release-audit.mjs --project vpw-prod-dd6ff --json
node apps/functions/scripts/release-audit.mjs --sin-red        # solo grafo, sin leer producción
```

El script **no despliega, no escribe y no llama a Meta**. Lo único que hace contra producción es
LEER (lista de Functions, `metaExternalIndex`, `metaAssets`). Exit code real: `0` sin bloqueos, `1`
BLOQUEADO, `2` error de uso. Un veredicto BLOQUEADO **no devuelve selector**: un informe bloqueado no
puede ofrecer nada copiable.

Por qué no alcanzaba listar los exports a ojo: `src/index.ts` re-exporta en bloques **multilínea**, y
un regex por línea pierde hoy **21 nombres** (el script lo mide y lo reporta). Cada nombre perdido es
una función que se queda sin actualizar — o una que se crea sin querer.

---

## 1. Superficie EXACTA del release (medida 2026-08-04, `--base 30c1687`)

`30c1687` es el último commit desplegado a producción (`docs/HANDOFF.md` §3); los dos commits
siguientes no desplegaron nada. La medición cubre ese commit **más la fundación `4af6607` más las
rondas 1 y 2 sin commitear**.

| Superficie | Resultado medido |
|---|---|
| Exports de `index.ts` | **122** (fuente y compilado coinciden exactamente) |
| Functions **CREATE** | **6** — `coexistenceStart`, `coexistenceConnect`, `coexistenceDecideHistorySharing`, `coexistenceRequestHistorySync`, `coexistenceSyncStatus`, `coexistenceRetentionMaintenance` |
| Functions **UPDATE** | **115** — todas las desplegadas hoy |
| Functions **DELETE** | **0** |
| Functions sin cambio | **0** |
| `dev*` que deben permanecer AUSENTES | **1** — `devRunMetaCatalogOutbox` (exportada, nunca desplegada) |
| Total esperado post-deploy | **115 → 121 ACTIVE** |
| Schedulers | **7 → 8** (`coexistenceRetentionMaintenance` es el nuevo) |
| Firestore Rules | **sí** — 4 matches nuevos, todos `read, write: if false` |
| Índices compuestos | **0 nuevos** (siguen 18) |
| **Field overrides / TTL** | **0 → 3** (`metaWebhookHistory`, `metaWebhookAppState`, `metaWebhookShadow`, campo `expiresAt`) |
| Hosting | **sí** — 3 archivos modificados + 1 componente nuevo |
| IAM | **sin cambios** (ver §1.3) |
| Secretos backend | **sin claves nuevas** — las 2 callables que intercambian el `code` reusan `META_APP_SECRET` |
| Config del panel | **1 clave pública NUEVA**: `NEXT_PUBLIC_META_COEXISTENCE_CONFIG_ID` |

### 1.1 Por qué UPDATE son 115 y no un puñado

No es pereza del cálculo: **cuatro módulos cambiados están en el cierre de los 122 exports**, porque
el arranque de `index.ts` (los `wire*`/`set*` de ADR-0015 y ADR-0016) los importa de forma estática y
ese arranque corre en toda función:

```
apps/functions/src/lib/firebase.ts              → paths.session() cambió de firma (canal por PNID)
apps/functions/src/orders/receiptAttachmentGate.ts → lo cablea index.ts; ahora resuelve sesión por canal
apps/functions/src/meta/attachmentGate.ts         → lo importa el anterior
packages/shared/src/whatsappAutomation.ts         → LEGACY_SESSION_KEY, viaja en el tarball del artefacto
```

Consecuencia operativa: **el selector es prácticamente todo el proyecto**. No hay forma honesta de
achicarlo sin sacar esos módulos del arranque, y eso es un cambio de diseño, no de release.

### 1.2 `dev*` que deben permanecer AUSENTES en producción

`devRunMetaCatalogOutbox` está exportada en `index.ts` y **no existe en producción a propósito**.
`firebase deploy --only functions` a secas **la crearía**. La auditoría la clasifica aparte, la deja
fuera del selector y sale BLOQUEADA si alguna vez se cuela. `index.ts` exporta **22** funciones
`dev*`; **21 están desplegadas** y son parte del UPDATE normal — no se tocan. La que sobra es
justamente `devRunMetaCatalogOutbox`.

Verificación post-deploy obligatoria: `firebase functions:list` debe seguir **sin**
`devRunMetaCatalogOutbox`.

### 1.3 IAM, secretos y config

- **IAM**: no hay cambios. El grant documentado en `HANDOFF` §5 (`iam.serviceAccountTokenCreator` del
  SA de functions sobre sí mismo) sigue siendo el único necesario. Si se cambia el SA de functions,
  re-otorgarlo.
- **Secret Manager**: `coexistenceConnect` y `coexistenceRequestHistorySync` declaran
  `secrets: [META_APP_SECRET]`. **No es un secreto nuevo** — es el mismo del Embedded Signup
  estándar. Al desplegarlas, verificar que el binding `secretmanager.secretAccessor` quedó puesto
  (firebase lo hace solo) y que **el valor no cambió**.
- **Panel**: `NEXT_PUBLIC_META_COEXISTENCE_CONFIG_ID` es una **clave nueva y obligatoria** del
  temporal de Hosting. Con esto, el `.env.production.local` temporal pasa de **9 a 10 claves**
  (§6.3). Si falta, la opción de Coexistence del panel queda deshabilitada — falla en silencio, no
  rompe.
- **Nuevo scheduler**: `coexistenceRetentionMaintenance` (`20 5,11,17,23 * * *`, America/Asuncion,
  timeout 300 s). Verificar tras el deploy que su invoker quedó restringido al SA (**no público**),
  igual que `attachmentRetentionMaintenance`.

---

## 2. Gates externos ABIERTOS (no se cierran desde este repo)

| Gate | Estado |
|---|---|
| Aprobación **Tech Provider** de Meta | pendiente de evidencia |
| App en **Live** (no Development) | pendiente de evidencia |
| Permisos `whatsapp_business_management` + `whatsapp_business_messaging` con Advanced Access | pendiente de evidencia |
| Webhooks suscritos: `messages`, `statuses`, `smb_message_echoes`, `history`, `smb_app_state_sync`, `account_update` | pendiente de evidencia |
| **Elegibilidad de PARAGUAY para Coexistence** | **ABIERTO, y Meta NO lo documenta en ninguna lista maestra** |

> **El gate de país es el más peligroso porque no tiene fuente que consultar.** Meta no publica una
> lista maestra de países habilitados para Coexistence. No se puede cerrar leyendo documentación ni
> mirando el repo: hay que confirmarlo con el canal de soporte / partner manager **antes** de tocar
> el número real. Si se avanza sin esa confirmación y el país no está habilitado, el Embedded Signup
> falla **con el número real del negocio en la mano**, después de haber desvinculado sus dispositivos.

---

## 3. El orden. Cada paso es bloqueante del siguiente

### Paso 1 — Confirmar los gates externos
Cerrar por escrito los cinco de §2, **incluida la elegibilidad de Paraguay**. Sin los cinco, no se
avanza: ningún paso posterior es reversible barato.

### Paso 2 — Backup productivo REAL
```
node apps/functions/scripts/backup-firestore.mjs --project vpw-prod-dd6ff --tenant <tenantId> --out <ruta ABSOLUTA fuera del repo> --apply
node apps/functions/scripts/backup-auth.mjs      --project vpw-prod-dd6ff --tenant <tenantId> --out <…> --apply
node apps/functions/scripts/backup-storage.mjs   --project vpw-prod-dd6ff --tenant <tenantId> --out <…> --apply
```
Guardar los tres manifiestos con sus conteos y hashes. Tres límites que van escritos, no supuestos:
- **Auth no respalda hashes de contraseña**: tras un restore los usuarios conservan uid, claims y
  perfil y **necesitan restablecer contraseña**.
- **Storage COPIA los bytes** (correctivo 2026-08-04): todos los objetos del prefijo del tenant, con
  verificación md5/tamaño por objeto y sha256 en el NDJSON (manifest `copiaDeBytes: true`). Un
  backup viejo sin ese campo es solo inventario y `restore-storage.mjs` lo rechaza.
- Además del export lógico por tenant, hacer el **export ADMINISTRADO y consistente de Firestore**
  del proyecto entero (`gcloud firestore export` a un bucket privado) ANTES del QR: el export
  lógico es la verificación complementaria, no el único respaldo.
- **Política de Auth, decidida y escrita**: el backup lógico NO lleva hashes de contraseña. O se
  hace el export de Auth con hashes protegido (herramienta del proveedor, custodia aparte), o se
  acepta explícitamente que un restore obliga a restablecer contraseñas. Elegir UNA y anotarla.
- Sin el **ciphertext de `secrets/`** y sin **`metaExternalIndex`**, un restore deja las conexiones
  Meta muertas y el inbound sin tenant. Verificar que ambos están en el manifiesto.

### Paso 3 — Restore PROBADO en entorno aislado
Restaurar en un proyecto **demo/emulador**, nunca en producción ni en staging con datos vivos.
Verificar: conteos por colección, tipos round-trip (`Timestamp`, `GeoPoint`, `Bytes`), subcolecciones
de `customers` (sesiones y mensajes), ítems de pedido, `metaExternalIndex` y los `secrets/`
referenciados. Restaurar también los BYTES de Storage con `restore-storage.mjs` (emulador o bucket
aislado; producción PROHIBIDA sin excepción) y exigir su verificación completa (exit 0 = todos los
objetos releídos y comparados). Con el token restaurado y descifrado en el entorno de prueba, hacer
UNA llamada **Graph GET estrictamente read-only** (p. ej. `GET /<PNID>?fields=display_phone_number`)
para probar que la credencial restaurada sirve — sin imprimirla. Verificar además que el destino
restaurado documenta lo que un restore NO repone: **políticas TTL** (se re-declaran con el deploy
de índices, jamás `--force`), **IAM** y **schedulers** (se comparan contra el manifiesto de
infraestructura de `backup-infra.mjs`). **Un backup que nadie restauró no es un backup.**

### Paso 4 — Verificar el backup NATIVO del teléfono
Es del owner y lo hace el owner. Antes del Embedded Signup:
- confirmar la copia de seguridad nativa de WhatsApp del dispositivo (Drive/local) y su fecha;
- avisar qué **pierde** en la app: listas de difusión (quedan de solo lectura), mensajes temporales,
  "ver una vez" y ubicación en vivo;
- avisar qué **conserva**: catálogo, pedidos, Status, perfil, etiquetas, grupos y llamadas;
- avisar que **los dispositivos vinculados se desvinculan** durante el onboarding y hay que
  volver a vincularlos después.

### Paso 5 — Migrar el PNID actual a `live`, con precondición fresca, **ANTES del deploy**
```
node apps/functions/scripts/migrate-whatsapp-automation-mode.mjs --tenant <tenantId> --pnid <pnid> --mode live          # dry-run: guardar el resumen
node apps/functions/scripts/migrate-whatsapp-automation-mode.mjs --tenant <tenantId> --pnid <pnid> --mode live --apply
```
**Por qué antes y no después**: el gate de ADR-0017 es fail-closed. Si se despliega primero, el
número que hoy vende lee el campo ausente, resuelve `inactive` y **queda mudo** hasta que alguien
corra la migración. El código desplegado hoy ignora el campo, así que en este orden **no hay ventana
de interrupción**.

Escribe **un campo** por documento, con `updateMask` y precondición por el `updateTime` leído: si
alguien tocó el documento en el medio (una reconexión reescribe el asset entero; `account_update`
escribe el índice), falla en vez de pisar. **Nunca un `set` del documento**: borraría `connectionId`
y `selected`, o sea el ruteo del inbound y el número por el que sale la respuesta.

**Cuántos documentos toca, y por qué a veces son dos.** En el caso normal, **uno solo**: el asset. La
ausencia del campo en el índice **no vota** en el desempate, justamente para que la migración no
tenga que escribir dos documentos en el mismo instante. Pero si el índice **declara** un modo
distinto del pedido, la migración **también lo corrige** — porque ahí sí vota, y gana el más
restrictivo. Es el estado que deja un `ACCOUNT_OFFBOARDED` (§Paso 13): degrada a `inactive` en el
asset **y en el índice**, y una migración que solo tocara el asset dejaría el número **mudo
reportando éxito**. El resumen del script lo dice explícitamente en el campo `indice`
(`no_declara` | `coincide` | `would_write` | `written`).

`--mode inactive` (el rollback) **no** lee el índice: el `inactive` del asset ya gana el desempate, y
apagar no puede fallar por un documento que no manda.

**Verificación de cierre del paso** — obligatoria, y es lo que autoriza el Paso 6:
```
node apps/functions/scripts/release-audit.mjs --project vpw-prod-dd6ff
```
debe dejar de decir `migracion_pendiente`. Hoy dice exactamente eso (medido 2026-08-04: el único
número que rutea inbound tiene `automationMode` **AUSENTE**), y por eso la auditoría sale con exit 1
y sin selector. Está probado en `tests/integration/release-audit.test.ts` que ese estado bloquea, y
que **solo** el valor crudo exactamente `live` desbloquea: `'LIVE'`, `'shadow'` o el campo vacío
resuelven `inactive` en el gate y dejarían el número callado.

La auditoría mira el **asset y el índice**, con el mismo criterio que el gate. Un índice que declara
algo distinto de `live` bloquea el release (`motivo: 'indice_no_live'`) aunque el asset ya diga
`live`: es el estado que deja un `ACCOUNT_OFFBOARDED` y la migración es la que lo corrige. Un índice
**sin el campo** no bloquea — la ausencia no vota.

### Paso 6 — Deploy
Orden: **Rules → índices → Functions → Hosting**. Todo con `--project vpw-prod-dd6ff` explícito
(el `default` de `.firebaserc` es `vpw-dev`) y con selector explícito.

**6.1 Rules.** 4 matches nuevos, los cuatro `read, write: if false`
(`metaWebhookHistory`, `metaWebhookAppState`, `metaWebhookShadow` y
`tenants/{t}/coexistenceHistorySyncs/{pnid}`). Probar tras aplicar: sin auth y cross-tenant deben dar
403.

**6.2 Índices y TTL.**

> **El deploy de índices NUNCA con `--force`**: `--force` **borra los field overrides que no estén en
> el archivo, incluida la política TTL de consola de `metaWebhookInbox`, que NO está en IaC a
> propósito**. Y **desplegar Functions no activa ninguna política TTL** — el `expiresAt` sin política
> declarada es una fecha decorativa y el documento queda para siempre.

```
firebase deploy --only firestore:indexes --project vpw-prod-dd6ff     # sin --force, jamás
```
Después, **verificar en consola que las tres políticas TTL quedaron ACTIVE** antes de habilitar la
ingesta de historial. Las tres son nuevas: `metaWebhookHistory.expiresAt`,
`metaWebhookAppState.expiresAt`, `metaWebhookShadow.expiresAt`.

> ⚠️ **Hallazgo medido el 2026-08-04, léase junto a la regla de arriba**: producción **no tiene hoy
> ninguna política TTL ni ningún field override**. Se verificó por dos vías —
> `firebase firestore:indexes` devuelve `fieldOverrides: []`, y la API de Firestore devuelve
> `ttlConfig: null` con `usesAncestorConfig: true` para `metaWebhookInbox.expiresAt`. O sea: **la
> política de consola de `metaWebhookInbox` que la IaC y el ADR dan por existente NO existe**. La
> regla de no usar `--force` se mantiene igual (protege los tres overrides nuevos apenas se
> apliquen), pero el riesgo concreto que se le atribuía todavía es hipotético — y hay un riesgo
> distinto y real: **los documentos de `metaWebhookInbox` no expiran**. Decidir eso es materia de
> otro programa; acá solo queda registrado.

**6.3 Functions.** Selector exacto derivado del grafo (§1): **6 CREATE + 115 UPDATE**. El selector
literal lo emite `release-audit.mjs` (`--only functions:…`) **solo cuando el veredicto no está
bloqueado**. Reglas que no se negocian:
- `--config firebase.functions.json` (el artefacto autónomo; el `firebase.json` por defecto no sirve
  para Functions),
- **nunca** `--only functions` a secas (crearía `devRunMetaCatalogOutbox`),
- **nunca** `--force`,
- consumidores primero, **schedulers al final** (`coexistenceRetentionMaintenance` es el último),
- los 429 de cuota reintentan solos; confirmar "Successful update/create operation" por función,
- **no inspeccionar `apps/functions/.deploy` con el shell parado adentro**: deja el directorio
  bloqueado en Windows y el predeploy siguiente falla con `EBUSY`.

Verificación post-deploy: **121 ACTIVE**, 0 DELETE, 0 recreates, `devRunMetaCatalogOutbox` AUSENTE,
hash de `.env.vpw-prod-dd6ff` idéntico antes y después, 8 schedulers con el nuevo **sin invoker
público**.

**6.4 Hosting.** Crear TEMPORAL `apps/web/.env.production.local` → desplegar → **borrarlo**.
El temporal debe definir **las 10 claves** (las 9 de `HANDOFF` §5 **más**
`NEXT_PUBLIC_META_COEXISTENCE_CONFIG_ID`): cualquier variable ausente cae al valor DEMO del
`.env.local` de la máquina y un smoke de "/login responde 200" **no lo detecta**.
Verificación: descargar los chunks de la raíz y confirmar `vpw-prod-dd6ff.firebaseapp.com` presente y
**cero** ocurrencias de `localhost:`, `vpw-staging`, `vpw-dev` y del projectId demo.

### Paso 7 — Verificación técnica CON EL NÚMERO ACTUAL
Antes de tocar el número nuevo, demostrar que el que ya vende sigue vendiendo:
- un inbound real por el número de siempre recibe respuesta automática (o sea: el gate lo lee `live`
  y no lo silenció);
- tomar y devolver un chat desde el panel sigue funcionando;
- pedidos, pagos, adjuntos y Coverage sin cambios de baseline;
- 0 errores nuevos en logs.

**Si el número quedó mudo, el Paso 5 no se hizo o no quedó `live`. Rollback inmediato (Paso 13).**

### Paso 8 — Embedded Signup humano / QR del número real
**Acto del owner, desde su teléfono. Nadie más lo ve ni lo pide, y ningún agente lo ejecuta.**
El botón vive en el panel (Integraciones) y usa la configuración **aparte** de Coexistence
(`featureType: whatsapp_business_app_onboarding`) y sus **callables propios**
(`coexistenceStart` → `coexistenceConnect`). No pasa por `connectMeta`: ese callable reescribe
`metaConnections/main` —token incluido— y borra los assets y el índice de esa conexión, o sea el
ruteo del número que hoy vende. La superficie estándar **rechaza** `mode: 'coexistence'` como
defensa en profundidad, así que un cableado equivocado falla en vez de escribir. El evento de cierre
(`FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`) trae **solo `waba_id`**: el PNID se resuelve server-side
por `GET /<WABA_ID>/phone_numbers`, nunca desde el `postMessage`.
Recordatorio del Paso 4: acá se desvinculan los dispositivos.

> **Deuda a resolver antes de este paso** (ver §4): el `extras` que manda el panel **no declara
> `version`**, y omitirlo deja el flujo en **Embedded Signup v2, que se depreca el 2026-10-15**.

### Paso 9 — La conexión nueva nace `inactive`
Verificar, sin tocar nada, que el asset del número nuevo quedó con `automationMode: 'inactive'`, que
**no** reclamó el canal heredado (`sessionKey` propia, `connectionId` distinto de `main`) y que
`metaConnections/main` **no se tocó**. Un inbound por el número nuevo debe producir ACK y **nada
más**: sin motor, IA, reglas, carrito, pedido, Coverage, metering ni outbound.
El error **131060** en el webhook de mensajes no soportados es **esperado** tras el onboarding — no
es una falla y tratarlo como tal esconde las reales.

### Paso 10 — Ingesta / historial (una sola vez en la vida del número)
La decisión de compartir historial es **humana** y se toma en el onboarding. Meta da **24 horas**
desde el onboarding (no desde el disparo). El disparo es explícito —
`POST /<PNID>/smb_app_data`, primero `sync_type: "smb_app_state_sync"` y después `"history"` — y
**se puede hacer UNA sola vez**: repetirlo exige offboardear el número y rehacer el Embedded Signup
entero, sobre un número con clientes vivos.

> **Regla dura de ADR-0017 §4: si el ingestor no está probado el día del cutover, se elige "NO
> compartir historial".** Es la única opción que no apuesta la ventana de 24 h.

Si se comparte: el historial va a `metaWebhookHistory` (cerrada al cliente, con TTL), nunca a
`messages` ni a `metaWebhookInbox`; `smb_app_state_sync` **no crea `Customer`s**; y hay que leer
`chunk.errors` — «no compartió» llega como `history[0].errors[0].code = 2593109` y sin leerlo el
coordinador espera hasta quemar la ventana.

**El flujo es del OWNER, desde el panel** (correctivo 2026-08-04): la tarjeta «Historial del número
conectado» en /integrations permite decidir `share`/`skip` (con confirmación), disparar el único
pedido (confirmación aparte que dice que no se repite) y ver el estado saneado
(`pending_request → requested → receiving → completed | declined | expired | failed`). El backend
re-verifica que el PNID sea una conexión `wa_{pnid}` del tenant: el frontend no puede apuntar a
otro número.

**Generaciones** (ADR-0017 §5, correctivo): si el número se offboardea (`ACCOUNT_OFFBOARDED`), la
generación vigente del historial se cierra de forma honesta (`failed` con el motivo; una terminal
queda intacta) y **solo un nuevo Embedded Signup** — claim de `code` nuevo — abre la siguiente:
sin decisión heredada, contadores a cero, ventana de 24 h nueva. La generación anterior queda
archivada íntegra en `coexistenceHistorySyncs/{pnid}_gen{N}` (auditoría; jamás se borra). Un
callback viejo o un replay no pueden resetear la generación vigente. Una decisión `skip` anterior
NO bloquea una reconexión legítima.

### Paso 11 — `shadow`, sin una sola respuesta
```
node apps/functions/scripts/migrate-whatsapp-automation-mode.mjs --tenant <tenantId> --pnid <pnid nuevo> --mode shadow --apply
```
Qué se observa durante la ventana de `shadow`: los inbound y los echoes del número nuevo aparecen en
`metaWebhookShadow`, **y nada más**. Lo que hay que verificar que NO pasó:
- cero mensajes salientes por el número nuevo,
- cero escrituras en `messages` y cero cambios en el resumen del cliente,
- `conversation.receivedVia` del cliente **sin tocar** (si cambiara, el mensaje manual del panel
  saldría por el número que debe estar callado),
- cero conversaciones nuevas en la bandeja del panel,
- cero metering, cero adjuntos ingeridos, cero Coverage,
- el número que ya vende **sigue vendiendo igual**.

### Paso 12 — Promoción explícita a `live`
**`live` no se alcanza por deploy.** Requisitos previos, todos:
1. smoke humano de `shadow` aprobado (Paso 11);
2. `verify-coexistence-dual.mjs` en VERDE contra el emulador. El gate transicional
   `SESIONES_POR_CANAL_MIGRADAS` fue **RETIRADO** (no puesto en `true`): la garantía de sesiones por
   canal hoy es **estructural** — `paths.session` exige la clave y la vigila el compilador; el canal
   viaja persistido en `Session.id`, `Order.sessionKey` y los documentos de Coverage — y está
   demostrada en ejecución por ese E2E (**dos PNID del mismo tenant, el MISMO cliente, promovido a
   `live` con la herramienta real**, jamás escribiendo el campo). Las dos deudas que el gate
   custodiaba están cerradas: el E2E dual existe, e Instagram/Messenger tienen canal propio
   (`ig`/`msgr`, `sessionKeyDePlataforma` en `@vpw/shared`) en vez de compartir `active`.
   La promoción del número NUEVO no exige `selected` (eso obligaría a mover el remitente por
   defecto del tenant antes de tiempo): `no_es_el_numero_por_defecto` aplica solo al canal heredado;
3. aprobación explícita del owner, aparte del smoke.

**Cambiar el número por DEFECTO del tenant (si el owner lo decide) no se hace a mano**: la
secuencia «seleccionar acá, migrar allá» son dos escrituras independientes con una ventana en la
que hay dos números contestando o ninguno. La herramienta release-only es:
```
node apps/functions/scripts/cutover-whatsapp-number.mjs --tenant <t> --nuevo <pnid> --degradar-anterior shadow|inactive
```
Dry-run por defecto: imprime la **firma** del estado (sha256 + updateTimes) que el `--apply` exige
(`--firma <valor>`); todas las escrituras van en UNA transacción (asset nuevo `selected+live`,
anterior degradado, índices si declaran otro modo) con precondiciones frescas re-verificadas
adentro; el registro de reversa queda en `tenants/{t}/whatsappCutovers/{co_<firma>}` y el rollback
(`--rollback <cutoverId> --apply`) restaura **byte a byte**, disponible aunque una verificación
secundaria falle. El kill-switch sigue siendo la migración `--mode inactive`, que el rollback jamás
pisa. Precondiciones: anterior seleccionado+`live`, nuevo en `shadow` (de `inactive` no se salta a
`live`), un solo seleccionado. El panel NO puede hacer el cutover: `selectMetaPhoneNumber` rechaza
(`failed-precondition`) elegir de default un número que no resuelve `live` cuando otro asset del
tenant declara `live` — compatible hacia atrás: sin ningún `live` declarado (producción pre-Paso 5)
no bloquea nada. Ciclo completo probado en `verify-cutover.mjs` (22 checks).

Recordar en `live` (contrato oficial, ARCHITECTURE §12.1): un echo activa el control humano pero
**no abre ni extiende la ventana de servicio de Cloud API**. Si la ventana está cerrada, la única
salida por Cloud API es una **plantilla**; tratar el echo como si abriera la ventana produce envíos
rechazados por Meta que el sistema leería como fallas propias.

> **Nota sobre el número que ya vende**: su asset tiene `connectionId: 'main'`, o sea canal heredado
> (`active`), así que el Paso 5 **no** choca con este bloqueo. El bloqueo aplica al número NUEVO.

### Paso 13 — Kill-switch y rollback
**Apagar nunca se bloquea.** El rollback del eje de automatización es un solo comando por número y no
pasa por ninguna verificación de promoción:
```
node apps/functions/scripts/migrate-whatsapp-automation-mode.mjs --tenant <tenantId> --pnid <pnid> --mode inactive --apply
```
Deja el número **conectado y sin automatizar**. No desconecta nada.

| Síntoma | Acción |
|---|---|
| El número nuevo contesta algo que no debía | `--mode inactive` sobre el número NUEVO |
| El número que ya vende quedó mudo tras el deploy | Verificar el Paso 5; si el campo no quedó `live`, correr la migración (es la cura, no el rollback) |
| El bot habla encima del vendedor | `--mode inactive` sobre ese número; revisar el consumo de `smb_message_echoes` |
| Hay que revertir el código | Redeploy del artefacto de `30c1687` con el MISMO selector; el campo `automationMode` queda escrito y el código anterior **lo ignora**, así que revertir no deja a nadie mudo |
| Meta desconectó el número solo | Llega por `account_update` (`ACCOUNT_OFFBOARDED`, `PARTNER_REMOVED`); ese PNID se degrada a `inactive` **en el asset y en el índice**. **La Deregister API está PROHIBIDA en coexistencia**: desconectar es un acto del cliente desde su app, nunca nuestro |
| Reconectado tras un `ACCOUNT_OFFBOARDED` y hay que volver a habilitarlo | La misma migración (`--mode shadow`/`live --apply`) corrige **los dos** documentos y su resumen lo declara en `indice`. Verificar con `release-audit.mjs`: si el índice quedara en `inactive`, el número estaría mudo aunque el asset diga `live` |

Lo que **no** es rollback: borrar los assets. `writeDiscoveredAssets` borra los assets y el índice del
tenant, y con ADR-0017 eso ya no es solo «se pierde el ruteo local» — el número que vende perdería su
`automationMode` y quedaría mudo.

---

## 4. Hallazgos abiertos que este runbook deja registrados

1. **Gate externo sin fuente**: la elegibilidad de **Paraguay** para Coexistence no está documentada
   por Meta en ninguna lista maestra. Es el único gate del Paso 1 que no se puede cerrar leyendo.
2. **Producción no tiene ninguna política TTL** (medido por dos vías, §6.2). La política de consola
   de `metaWebhookInbox` que la IaC y el ADR dan por existente **no existe**, y esos documentos hoy
   no expiran.
3. **Embedded Signup queda en v2**: `apps/web/src/lib/metaEmbeddedSignup.ts` manda
   `extras: { setup, featureType, sessionInfoVersion }` **sin `version`**, y ARCHITECTURE §12.1 dice
   que omitirlo deja el flujo en v2, **deprecado el 2026-10-15**. Es un plazo duro.
4. **CERRADO por el correctivo (2026-08-04)**: el gate `SESIONES_POR_CANAL_MIGRADAS` fue retirado
   con la garantía estructural + `verify-coexistence-dual.mjs` (Paso 12), e Instagram/Messenger
   tienen canal propio (`ig`/`msgr`). `live` para un número en canal propio ya es alcanzable con la
   herramienta real — y SOLO con ella.
5. **CERRADO en `4af6607`**: `releaseToBot` preserva `AWAITING_PAYMENT`/`SELECTING_PAYMENT` al
   liberar (`conversation/handoff.release.test.ts`). Tomar y liberar puede ser el ritmo normal del
   vendedor sin destruir el checkout.
6. **El selector es todo el proyecto** (§1.1). No es un error de cálculo; es la consecuencia de que
   el arranque de `index.ts` importe módulos que cambiaron.

---

*Producido por `WHATSAPP-COEXISTENCE-FOUNDATION-COMPLETE-1`, etapa I (auditoría de release sin
desplegar) — 2026-08-04. Ningún paso de este runbook fue ejecutado.*
