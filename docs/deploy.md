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

### Opción A — GitHub Actions — ⛔ **SOLO STAGING. PROHIBIDA PARA PRODUCCIÓN.**
`.github/workflows/deploy.yml` → **Run workflow** → elegí `staging`.
Requiere el secret `FIREBASE_SERVICE_ACCOUNT` (JSON de service account con permisos de deploy).

> **No la uses con `production`.** El workflow corre `firebase deploy --only functions,…` **sin
> selector explícito**, que es exactamente lo que crea en producción funciones que no deben existir
> (`devRunMetaCatalogOutbox`), y buildea Hosting **sin** el `.env.production.local` de 9 claves —
> con lo cual las variables públicas ausentes caen al `.env.local` demo de la máquina. Producción
> (`vpw-prod-dd6ff`) se despliega **solo** siguiendo `docs/HANDOFF.md` §5.

### Opción B — local (desde 10-backend/)

> ⚠️ **En PRODUCCIÓN nunca uses `--only functions` a secas.** El proyecto exporta funciones que
> deliberadamente NO existen en producción (`devRunMetaCatalogOutbox`): un deploy sin selector las
> CREA. Se despliega siempre con el selector explícito `functions:<nombre>,functions:<nombre>,…`
> calculado desde el grafo de imports del cambio. Ver el runbook detallado en
> `docs/HANDOFF.md` §5.
>
> ⚠️ **`--project` es obligatorio SIEMPRE.** El `default` de `.firebaserc` es `vpw-dev`: omitirlo
> despliega al proyecto equivocado.

```bash
pnpm build
# staging (entorno de prueba: el selector completo es aceptable acá).
# `--config firebase.functions.json` es obligatorio: un deploy directo de apps/functions
# falla con EUNSUPPORTEDPROTOCOL por la dependencia workspace:* de @vpw/shared.
pnpm exec firebase deploy --only firestore:rules,firestore:indexes,storage,hosting --project staging
pnpm exec firebase deploy --only functions --config firebase.functions.json --project staging
```

Para **producción** (`vpw-prod-dd6ff`) seguí `docs/HANDOFF.md` §5: rules primero, después functions
con selector explícito y sin `--force`, y hosting al final con su `.env.production.local` temporal.

## Smoke test post-deploy
```bash
curl https://<region>-<project>.cloudfunctions.net/healthCheck   # → {"status":"ok","checks":{"firestore":"ok"}}
```
Verificá además: login del panel, que los endpoints `dev*` respondan **404** (no expuestos), y que el
webhook de Meta rechace una firma inválida (401).

## Rollback

- **Hosting (panel):** `pnpm exec firebase hosting:rollback --project <env>` (revierte a la release anterior).
- **Reglas Firestore:** `git revert` del cambio + `pnpm exec firebase deploy --only firestore:rules --project <env>`.
- **Functions:** redeploy del commit anterior, **con el MISMO selector explícito que usó el deploy que se revierte** y `--project` (`git checkout <commit-bueno> -- . && pnpm build && pnpm exec firebase deploy --only functions:<n1>,functions:<n2>,… --config firebase.functions.json --project vpw-prod-dd6ff`). Las Functions no tienen rollback nativo: se redeploya la versión buena. Nunca `--only functions` a secas ni `--force`.
- **Datos:** Firestore tiene PITR/backups según el plan; restaurar desde la consola de Firebase.

## Checklist de producción
- [ ] `ENABLE_DEV_ENDPOINTS` ausente → `dev*` en 404.
- [ ] Secretos en Secret Manager, no en el repo.
- [ ] `WHATSAPP_APP_SECRET` y `STRIPE_WEBHOOK_SECRET` seteados (webhooks fail-closed).
- [ ] CI verde en el commit que se despliega.
- [ ] Branch `main` protegida (CI obligatorio antes de merge).
