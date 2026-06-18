# Deploy y rollback — AI_AFG (Fase 5)

> No hay deploy automático "a ciegas": staging es manual y production requiere aprobación.

## Entornos (10-backend/.firebaserc)

| Entorno | Proyecto Firebase | Uso |
|---|---|---|
| dev | `vpw-dev` | desarrollo (o emulador `demo-aiafg`) |
| staging | `vpw-staging` | QA / demo online |
| production | `vpw-prod` | clientes reales |

## Variables y secretos

- Plantilla: `10-backend/.env.example` (backend) y `10-backend/apps/web/.env.example` (web público).
- En staging/prod los secretos van a **Secret Manager** / config de Functions (NUNCA al repo):
  `WHATSAPP_APP_SECRET`, `STRIPE_WEBHOOK_SECRET`, `PLATFORM_BILLING_WEBHOOK_SECRET`,
  `TENANT_SECRETS_ENCRYPTION_KEY`, `META_APP_SECRET`, `DEV_ENDPOINTS_SECRET`.
- `ENABLE_DEV_ENDPOINTS` **no se setea en producción** (deja los `dev*` en 404).

## Deploy

### Opción A — GitHub Actions (recomendada)
`.github/workflows/deploy.yml` → **Run workflow** → elegí `staging` o `production`.
Requiere el secret `FIREBASE_SERVICE_ACCOUNT` (JSON de service account con permisos de deploy).

### Opción B — local (desde 10-backend/)
```bash
pnpm build
pnpm exec firebase deploy --only functions,firestore:rules,firestore:indexes,storage,hosting --project staging
# producción:
pnpm exec firebase deploy --only functions,firestore:rules,firestore:indexes,storage,hosting --project production
```

## Smoke test post-deploy
```bash
curl https://<region>-<project>.cloudfunctions.net/healthCheck   # → {"status":"ok","checks":{"firestore":"ok"}}
```
Verificá además: login del panel, que los endpoints `dev*` respondan **404** (no expuestos), y que el
webhook de Meta rechace una firma inválida (401).

## Rollback

- **Hosting (panel):** `pnpm exec firebase hosting:rollback --project <env>` (revierte a la release anterior).
- **Reglas Firestore:** `git revert` del cambio + `pnpm exec firebase deploy --only firestore:rules --project <env>`.
- **Functions:** redeploy del commit anterior (`git checkout <commit-bueno> -- . && pnpm build && firebase deploy --only functions`). Las Functions no tienen rollback nativo: se redeploya la versión buena.
- **Datos:** Firestore tiene PITR/backups según el plan; restaurar desde la consola de Firebase.

## Checklist de producción
- [ ] `ENABLE_DEV_ENDPOINTS` ausente → `dev*` en 404.
- [ ] Secretos en Secret Manager, no en el repo.
- [ ] `WHATSAPP_APP_SECRET` y `STRIPE_WEBHOOK_SECRET` seteados (webhooks fail-closed).
- [ ] CI verde en el commit que se despliega.
- [ ] Branch `main` protegida (CI obligatorio antes de merge).
