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

- **Hosting (panel):** ⚠️ **`hosting:rollback` NO EXISTE** en firebase-tools (verificado en 15.23.0: no hay `lib/commands/hosting-rollback.js` y `hosting:rollback` no está registrado). El comando documentado acá durante meses fallaba con «is not a Firebase command» — y era el PASO 1 del rollback, o sea que el runbook arrancaba roto justo donde hay que cortar al llamador del backend. El comando real es `hosting:clone`, que acepta la forma `<site>@<versionId>`:
  ```bash
  pnpm exec firebase hosting:clone vpw-prod-dd6ff@<versionId> vpw-prod-dd6ff:live --project vpw-prod-dd6ff
  ```
  El `<versionId>` se obtiene listando releases (API `firebasehosting.googleapis.com/v1beta1/sites/<site>/releases`) o desde Firebase Console → Hosting → Historial de versiones → **Revertir**, que es la alternativa de un clic.
- **Reglas Firestore:** `git revert` del cambio + `pnpm exec firebase deploy --only firestore:rules --project <env>`.
- **Functions:** redeploy del commit anterior, **con el MISMO selector explícito que usó el deploy que se revierte** y `--project` (`git checkout <commit-bueno> -- . && pnpm build && pnpm exec firebase deploy --only functions:<n1>,functions:<n2>,… --config firebase.functions.json --project vpw-prod-dd6ff`). Las Functions no tienen rollback nativo: se redeploya la versión buena. Nunca `--only functions` a secas ni `--force`.
  - **EL ORDEN DEL ROLLBACK ES EL INVERSO DEL DEPLOY, y no es un detalle de estilo.** Cuando un cambio altera el formato de un dato que una función *escribe* y otra *lee*, la compatibilidad es asimétrica: el consumidor nuevo suele entender las dos formas, el viejo entiende solo la vieja. Por eso el deploy va **consumidor primero, productor después** — y el rollback tiene que ir **productor primero, consumidor después**. Si se revierte en el mismo orden que el deploy, queda una ventana con el productor nuevo escribiendo el formato nuevo y el consumidor ya viejo sin saber leerlo: todo lo que entre en esa ventana se descarta sin rastro.
  - Caso concreto y vigente (ADR-0016): `metaWebhook` escribe `payload.attachment`; el `onWebhookInbox` nuevo lee `attachment` **y** el legacy `image`, pero el viejo lee solo `image`. Deploy: `onWebhookInbox` → `metaWebhook`. Rollback: **`metaWebhook` → `onWebhookInbox`**. Al revés se pierden las fotos y los PDF que manden los clientes durante la ventana.
  - Y no des por hecho que un flag apagado hace inerte al deploy: los flags de rollout gobiernan lo que el código *hace de más*, no restauran comportamiento *eliminado*. Si el cambio borró un camino viejo, volver atrás exige redesplegar código.
- **Schedulers: el rollback de código NO los frena.** Un scheduler creado por el release sigue existiendo y disparando aunque se revierta el código de las demás funciones, porque su selector no lo incluye (y borrarlo durante un incidente es irreversible). Si el problema puede involucrarlo, pausalo — es reversible y de efecto inmediato:
  ```bash
  gcloud scheduler jobs pause firebase-schedule-<fn>-us-central1 --location us-central1 --project vpw-prod-dd6ff
  ```
  También se pausa con un clic desde Cloud Console → Cloud Scheduler. Y antes de eso, verificá el flag que gobierna su efecto (para adjuntos: `tenants/{t}/config/attachments.retention.purgeEnabled` debe estar en `false`/ausente).
- **`pnpm deploy:rules` NO sirve para producción**: desde `3939676` está hardcodeado a `--project vpw-staging`. Usarlo creyendo que despliega prod deja producción con las reglas viejas **y el comando sale con éxito** — un falso positivo perfecto. Las Rules de producción se despliegan a mano: `firebase deploy --only firestore:rules,storage --project vpw-prod-dd6ff`, y después se verifica contra la API que el ruleset vigente sea el esperado.
- **Datos:** Firestore tiene PITR/backups según el plan; restaurar desde la consola de Firebase.
- **Higiene del artefacto:** `apps/functions/scripts/build-deploy.mjs` copia al bundle **cualquier** `.env.<algo>` que no termine en `.local`, no solo el del proyecto destino. Si en la máquina existe `.env.vpw-staging`, sus secretos viajan al bucket de fuentes de **producción**. Mitigación de cero líneas mientras no se corrija el filtro: mover ese archivo fuera de `apps/functions/` durante el deploy productivo y verificar, listando `.deploy`, que solo quedó `.env.<projectId>`.

## Checklist de producción
- [ ] `ENABLE_DEV_ENDPOINTS` ausente → `dev*` en 404.
- [ ] Secretos en Secret Manager, no en el repo.
- [ ] `WHATSAPP_APP_SECRET` y `STRIPE_WEBHOOK_SECRET` seteados (webhooks fail-closed).
- [ ] CI verde en el commit que se despliega.
- [ ] Branch `main` protegida (CI obligatorio antes de merge).
