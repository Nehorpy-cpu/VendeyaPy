# Deploy y rollback — AI_AFG (Fase 5)

> No hay deploy automático "a ciegas": staging es manual y production requiere aprobación.

## Entornos (10-backend/.firebaserc)

| Entorno | Proyecto Firebase | Uso |
|---|---|---|
| dev | `vpw-dev` | desarrollo (o emulador `demo-aiafg`) |
| staging | `vpw-staging` | QA / demo online |
| production | `vpw-prod-dd6ff` (alias `production`) | clientes reales |

## Variables y secretos

- Plantilla: `10-backend/.env.example` (backend) y `10-backend/apps/web/.env.example` (web público).
- En staging/prod los secretos van a **Secret Manager** / config de Functions (NUNCA al repo):
  `WHATSAPP_APP_SECRET`, `STRIPE_WEBHOOK_SECRET`, `PLATFORM_BILLING_WEBHOOK_SECRET`,
  `TENANT_SECRETS_ENCRYPTION_KEY`, `META_APP_SECRET`, `DEV_ENDPOINTS_SECRET`.
- `ENABLE_DEV_ENDPOINTS` **no se setea en producción** (deja los `dev*` en 404).

## Deploy

**Política, en una línea:** GitHub Actions es **staging-only**; producción es **procedimiento manual
auditado** con selector mínimo y proyecto/config explícitos; **nunca** `--force`; **nunca**
`--only functions` genérico; **nunca** depender del proyecto `default` de `.firebaserc`.

### Opción A — GitHub Actions — **STAGING-ONLY por construcción**
`.github/workflows/deploy.yml` → **Run workflow**. No tiene ningún input: no hay forma de elegir
destino, y por lo tanto producción no es alcanzable. Despliega **solo** `firestore:rules`,
`firestore:indexes` y `storage` sobre `vpw-staging`. Requiere el secret `FIREBASE_SERVICE_ACCOUNT`.

Functions y Hosting quedan **fuera del workflow a propósito**: un deploy seguro de Functions exige
el selector exacto derivado del grafo de imports del cambio más `--config firebase.functions.json`
—cosas que CI no puede derivar— y el build de Hosting hornea las `NEXT_PUBLIC_*`, que necesitan el
archivo de entorno correcto. Ambos se hacen a mano.

Antes de autenticarse, el propio job corre `node apps/functions/scripts/deploy-guard.mjs --audit`:
si alguien reintroduce un destino de producción, un flag repetido, un `--force` o un selector
genérico, el workflow **falla antes de tocar Firebase**. El verificador recorre los workflows, los
`package.json`, los `firebase*.json` (incluidos sus hooks `predeploy`) y los scripts ejecutables del
repo. **Lo que no cubre**: la configuración del GitHub Environment (restricción de ramas y revisores
obligatorios) vive fuera del repositorio y hay que verificarla a mano en Settings → Environments.

### Opción B — local (desde 10-backend/), solo dev/staging

Todos los scripts pasan por `apps/functions/scripts/firebase-deploy.mjs`, que **valida antes de
ejecutar** (proyecto explícito y permitido, sin `--force`, `--only` presente, selector de Functions
exacto, config correcto) y ejecuta sin shell. Si algo no cierra, sale con código 1 sin tocar la red.

```bash
pnpm build
pnpm deploy:rules        # firestore:rules + storage      → vpw-staging
pnpm deploy:indexes      # firestore:indexes              → vpw-staging
pnpm deploy:staging      # rules + indexes + storage + hosting → vpw-staging
# Functions: el selector lo aporta quien despliega, y sin él el helper falla cerrado.
pnpm deploy:functions -- --only functions:onWebhookInbox,functions:runTenantJob
```

`pnpm deploy:prod` está **bloqueado**: imprime el motivo y sale con código 1 sin ejecutar Firebase.

Para **producción** (`vpw-prod-dd6ff`) seguí `docs/HANDOFF.md` §5: rules primero, después functions
con selector explícito y sin `--force`, y hosting al final con su `.env.production.local` temporal.

## Smoke test post-deploy
```bash
curl https://<region>-<project>.cloudfunctions.net/healthCheck   # → {"status":"ok","checks":{"firestore":"ok"}}
```
Verificá además: login del panel, que los endpoints `dev*` respondan **404** (no expuestos), y que el
webhook de Meta rechace una firma inválida (401).

## Rollback

> Los comandos de esta sección para **producción** se ejecutan con `firebase` directo, a propósito:
> el helper `firebase-deploy.mjs` bloquea el proyecto productivo por diseño, y un rollback de
> producción es una operación manual supervisada. Siguen valiendo las mismas reglas: selector
> explícito, `--project` explícito y **nunca** `--force`.

- **Hosting (panel):** ⚠️ **`hosting:rollback` NO EXISTE.** Verificado en las DOS versiones que hay en juego: la que el repo ejecuta (devDependency **13.35.1**, la que usan `pnpm exec firebase` y `firebase-deploy.mjs`) y la instalación global de la máquina de deploy (**15.23.0**). En ninguna hay `lib/commands/hosting-rollback.js` ni el comando registrado. El que documentaba este runbook fallaba con «is not a Firebase command» — y era el PASO 1 del rollback, o sea que el procedimiento de emergencia arrancaba roto justo donde hay que cortar al llamador del backend. *(La distinción importa: un verificador anclado al binario equivocado no verifica nada; `apps/functions/src/ops/runbook.test.ts` resuelve el CLI desde el repo por eso.)* El comando real es `hosting:clone`, que acepta la forma `<site>@<versionId>`:
  ```bash
  pnpm exec firebase hosting:clone vpw-prod-dd6ff@<versionId> vpw-prod-dd6ff:live
  ```
  El `<versionId>` se obtiene listando releases: `GET https://firebasehosting.googleapis.com/v1beta1/sites/vpw-prod-dd6ff/releases` (el campo `version.name`, último segmento), o desde Firebase Console → Hosting → Historial de versiones.
  - ⚠️ **Dos trampas verificadas en el código de `hosting:clone`, y las dos devuelven EXIT 0:**
    1. **`--project` es inerte.** El comando resuelve el sitio con `getChannel("-", siteId, …)`: el destino sale del `<site>` del argumento, no del flag. Poner mal el site y bien el `--project` NO protege.
    2. **Un canal inexistente se CREA en vez de fallar** (`hosting-clone.js:54-62`: «could not find channel …, creating it»). Un typo como `vpw-prod-dd6ff:liv` crea un canal *preview* llamado `liv`, imprime «Created new channel», sale con éxito **y deja el sitio live intacto**. En un incidente eso se lee como «ya revertí» cuando no se revirtió nada.
  - Por eso el rollback de Hosting **se verifica después**, no se da por hecho: `GET .../sites/vpw-prod-dd6ff/releases` y confirmar que la release más nueva apunta al `versionId` esperado. La alternativa de un clic (Console → Historial de versiones → **Revertir**) no tiene ninguna de las dos trampas y es preferible bajo presión.
- **Reglas Firestore:** `git revert` del cambio + `pnpm exec firebase deploy --only firestore:rules --project <env>`.
- **Functions:** redeploy del commit anterior con selector explícito y `--project` (`git checkout <commit-bueno> -- . && pnpm build && pnpm exec firebase deploy --only functions:<n1>,functions:<n2>,… --config firebase.functions.json --project vpw-prod-dd6ff`). Las Functions no tienen rollback nativo: se redeploya la versión buena. Nunca `--only functions` a secas ni `--force`.
  - ⚠️ **El selector del rollback NO es el mismo que el del deploy: es ése MENOS las funciones que el deploy CREÓ.** En el commit anterior esos exports no existen, y firebase **aborta el comando entero** al validar el selector — no revierte nada, ni siquiera las funciones que sí existían. Las CREATE se dejan desplegadas e inertes (callables sin llamador tras revertir Hosting; schedulers pausados según el punto anterior) y se borran aparte, más tarde y con calma, con `functions:delete`, que es irreversible y **no forma parte del rollback**.
  - **EL ORDEN DEL ROLLBACK ES EL INVERSO DEL DEPLOY, y no es un detalle de estilo.** Cuando un cambio altera el formato de un dato que una función *escribe* y otra *lee*, la compatibilidad es asimétrica: el consumidor nuevo suele entender las dos formas, el viejo entiende solo la vieja. Por eso el deploy va **consumidor primero, productor después** — y el rollback tiene que ir **productor primero, consumidor después**. Si se revierte en el mismo orden que el deploy, queda una ventana con el productor nuevo escribiendo el formato nuevo y el consumidor ya viejo sin saber leerlo: todo lo que entre en esa ventana se descarta sin rastro.
  - Caso concreto y vigente (ADR-0016): `metaWebhook` escribe `payload.attachment`; el `onWebhookInbox` nuevo lee `attachment` **y** el legacy `image`, pero el viejo lee solo `image`. Deploy: `onWebhookInbox` → `metaWebhook`. Rollback: **`metaWebhook` → `onWebhookInbox`**. Al revés se pierden las fotos y los PDF que manden los clientes durante la ventana.
  - Y no des por hecho que un flag apagado hace inerte al deploy: los flags de rollout gobiernan lo que el código *hace de más*, no restauran comportamiento *eliminado*. Si el cambio borró un camino viejo, volver atrás exige redesplegar código.
- **Schedulers: el rollback de código NO los frena.** Un scheduler creado por el release sigue existiendo y disparando aunque se revierta el código de las demás funciones, porque su selector no lo incluye (y borrarlo durante un incidente es irreversible: `functions:delete` no tiene vuelta atrás). El orden correcto es **pausar el scheduler ANTES de revertir consumidores y productores** — si no, sigue produciendo trabajo contra código a medio revertir.
  1. **Inventariar** qué schedulers introdujo el release (comparar contra la baseline previa al deploy; los jobs se llaman `firebase-schedule-<fn>-<region>`).
  2. **Pausar** cada uno. `firebase-tools` no expone el comando **y `gcloud` NO está instalado en la máquina de deploy** (verificado: `gcloud: command not found`) — así que el camino primario es la API REST o la consola, no un `gcloud` que no existe:
     ```
     POST https://cloudscheduler.googleapis.com/v1/projects/vpw-prod-dd6ff/locations/us-central1/jobs/firebase-schedule-<fn>-us-central1:pause
     ```
     (con el token de `firebase login`, mismo patrón de acceso que documenta `docs/HANDOFF.md` §5). El clic equivalente está en Cloud Console → Cloud Scheduler → **Pausar**. Si alguna vez se instala `gcloud`, el comando es `gcloud scheduler jobs pause <job> --location us-central1 --project vpw-prod-dd6ff`.
  3. **Verificar que dejó de producir trabajo**: el job debe quedar en `state: PAUSED` (`GET .../jobs/<job>`) y no debe aparecer ninguna invocación nueva en los logs de esa función después del instante de la pausa.
  4. Recién entonces revertir Hosting → productor → consumidor.
  5. **Reanudar** cuando el incidente esté cerrado — pausar sin reanudar deja el sistema a medias y el trabajo diferido se acumula en silencio:
     ```
     POST https://cloudscheduler.googleapis.com/v1/projects/vpw-prod-dd6ff/locations/us-central1/jobs/firebase-schedule-<fn>-us-central1:resume
     ```
     Verificar que vuelve a `state: ENABLED` y que `scheduleTime` avanza al siguiente disparo.
  6. **Nunca borres la función para frenar el scheduler.** `functions:delete` destruye también su job de Cloud Scheduler, y eso no se deshace con un redeploy del commit anterior: hay que recrearlo. Pausar es reversible; borrar no.

  Y antes de todo eso, revisá el flag que gobierna su efecto: si el scheduler ya es inerte por configuración, pausarlo es innecesario. Para adjuntos, `tenants/{t}/config/attachments.retention.purgeEnabled` debe estar en `false`/ausente.
- **Ningún script de npm elige el entorno.** `deploy:rules` traía `--project vpw-staging` adentro: un operador que lo corriera pensando en producción se llevaba **EXIT 0** y producción intacta — un falso positivo perfecto, la peor falla posible porque se parece a un éxito. Desde `RELEASE-SECURITY-AND-RUNBOOK-HARDEN-1` los scripts **no traen proyecto** y el helper falla cerrado si falta: `pnpm deploy:rules -- --project vpw-staging`. Producción sigue sin ser alcanzable por esta vía; sus Rules se despliegan a mano con `firebase deploy --only firestore:rules,storage --project vpw-prod-dd6ff`, y después se verifica **contra la API** que el ruleset vigente sea el esperado (no alcanza con que el comando haya salido bien).
- **Datos:** Firestore tiene PITR/backups según el plan; restaurar desde la consola de Firebase.
- **Higiene del artefacto — UN ARTEFACTO, UN ENTORNO** (`RELEASE-SECURITY-AND-RUNBOOK-HARDEN-1`). Dos capas, porque había dos caminos:
  1. **El artefacto**: `build-deploy.mjs` copiaba **cualquier** `.env.<algo>` que no terminara en `.local`, porque no sabía a qué proyecto se desplegaba; con `.env.vpw-staging` en la máquina, esos secretos viajaban al bucket de fuentes de **producción**. Ahora el destino es obligatorio (`GCLOUD_PROJECT` del `predeploy`, o `--project` explícito), la allowlist es `.env` + `.env.<projectId>` + `.env.<alias-que-resuelve-a-ese-projectId>`, y el build **aborta** si falta el env del destino, si el proyecto es ambiguo o si al releer el artefacto aparece un env ajeno.
  2. **La subida**: los dos `firebase*.json` ahora excluyen `.env*` del zip. Esto es independiente de lo anterior y hacía falta igual — `firebase.json` apunta a `apps/functions` DIRECTO y subía los dos entornos juntos, y encima la subida ocurre **antes** de que Cloud Build falle por `workspace:*`, así que hasta un deploy fallido dejaba secretos arriba. Excluirlos **no cambia ninguna variable desplegada**: firebase lee los `.env` del disco local en `prepare` (`loadUserEnvs`) y el `ignore` solo gobierna el zip.
  ```bash
  node apps/functions/scripts/build-deploy.mjs --project vpw-prod-dd6ff --inspeccionar
  ```
  - ⚠️ **Lo ya subido NO se limpió con este cambio.** El arreglo corta la fuga hacia adelante; los artefactos históricos del bucket de fuentes de producción siguen conteniendo el `.env` de staging de los deploys anteriores (109 objetos vivos previos a la mitigación del 2026-08-01, más generaciones archivadas). **La rotación de esos 4 secretos de staging sigue PENDIENTE de decisión del owner** — ver `docs/HANDOFF.md` §0b. No leer este bullet como «incidente cerrado».

## Checklist de producción
- [ ] `ENABLE_DEV_ENDPOINTS` ausente → `dev*` en 404.
- [ ] Secretos en Secret Manager, no en el repo.
- [ ] `WHATSAPP_APP_SECRET` y `STRIPE_WEBHOOK_SECRET` seteados (webhooks fail-closed).
- [ ] CI verde en el commit que se despliega.
- [ ] Branch `main` protegida (CI obligatorio antes de merge).
