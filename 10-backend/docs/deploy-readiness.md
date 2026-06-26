# Deploy readiness — Firebase (Hosting + Functions + Firestore + Auth) · dominio Hostinger

> Auditoría READ-ONLY (DEPLOY-READINESS-AUDIT). Mapea el estado real para pasar de local/emulador a
> producción **sin romper** seguridad, billing, Meta/WhatsApp, AI ni multi-tenant. **No se hizo deploy.**
> Estados: ✅ listo · ⚠️ falta configurar · ⛔ bloqueado por externo · ⛔🚫 NO hacer en producción.

## 0. Cómo está armado el deploy (hechos del repo)
- **Proyectos** (`.firebaserc`): `dev`/default = `vpw-dev`, `staging` = `vpw-staging`, **prod = `vpw-prod`**. Local/emulador usa `demo-aiafg` (proyecto demo desechable; lo usan `.env.local` del web y los `verify-*.mjs`).
- **Hosting = Firebase Web Frameworks (Next.js SSR).** `firebase.json` → `hosting.source: "apps/web"` + `frameworksBackend.region: "us-central1"`. NO es export estático: `next.config.mjs` no tiene `output:'export'` (hay server components/SSR). `firebase deploy` detecta Next.js, corre `next build` y **provisiona un backend SSR (Cloud Function 2ª gen) + sube los estáticos al CDN**. ⇒ requiere **plan Blaze** y, según versión de CLI, habilitar Web Frameworks.
- **Functions:** `firebase.json` → source `apps/functions`, `predeploy: pnpm --filter functions build` (buildea antes de deployar). Región `us-central1`.
- **Firestore:** `rules` = `firestore.rules` (402 líneas, **default-deny** al final), `indexes` = `firestore.indexes.json` (111 líneas). **Storage:** `storage.rules` (tenant-isolated).
- **Scripts de deploy** (`package.json` raíz): `deploy:staging` (`firebase deploy --project vpw-staging`), `deploy:prod` (`--project vpw-prod`), `deploy:rules` (`firestore:rules,storage:rules`), `deploy:indexes`. Functions: `apps/functions` → `deploy` (`--only functions`). Web build: `apps/web` → `next build`.

## 1. Checklist

### ✅ Listo (en código / config)
- `firebase.json` completo (firestore + storage + functions + hosting web-frameworks + emuladores).
- `firestore.rules` con **default-deny** + helpers multi-tenant (claims `{tenantId, role}`); `storage.rules` tenant-isolated.
- `firestore.indexes.json` presente (deployable con `deploy:indexes`).
- Predeploy de functions buildea (`pnpm --filter functions build`).
- **Seguridad (de fases previas):** dev endpoints → **404 en prod** (`guardDevEndpoint`); tenant isolation por claims; roles/admin (`resolveMetaConnectAuth`, rules); **billing manual** (activación por WhatsApp, admin confirma); **free-trial enforcement** (derivado por fecha en checkQuota/assertFeatureEnabled); **AI limits** (entitlements + AI gateway); **WhatsApp live gate** (`canGoLive` + validación backend en `channelConfigUpdate`).
- **Secrets cableados a Secret Manager:** `ANTHROPIC_API_KEY` (bound a funciones de IA), `META_APP_SECRET` (bound a `connectMeta`/`verifyMetaChannel`, META-SECRETS-1).
- Build verde: functions typecheck/lint/test (239) + web typecheck/lint/test. E2E Meta/WhatsApp en emulador 16/16 + 9/9 (META-SECRETS-1B).

### ⚠️ Falta configurar (acción nuestra, sin bloqueo externo)
- **Frontend env de prod (build-time, se hornean en el bundle Next):** crear `apps/web/.env.production` (o setear en el entorno del build de deploy) con los `NEXT_PUBLIC_FIREBASE_*` de **vpw-prod**, `NEXT_PUBLIC_API_BASE_URL` (URL real de functions), `NEXT_PUBLIC_META_APP_ID` + `NEXT_PUBLIC_META_CONFIG_ID` + `NEXT_PUBLIC_META_GRAPH_VERSION`.
  - **CRÍTICO:** `NEXT_PUBLIC_USE_EMULATORS` **debe quedar `false`/ausente** en prod (si queda `true`, el panel habla con `localhost` y se rompe todo + muestra credenciales demo).
- **Backend env de prod** (los valida `config.ts` vía `getConfig()` → deben existir en el runtime de Functions): `N8N_BASE_URL`, `N8N_INTERNAL_SECRET` (min 32), `API_BASE_URL`, `WEB_BASE_URL`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `TENANT_SECRETS_ENCRYPTION_KEY` (min 32, **definitiva**). Proveer por **env deployado** (`.env.vpw-prod` en `apps/functions`) o Secret Manager (ver META-SECRETS-2 propuesto). `META_APP_ID` (no secreto) también.
- **Secret Manager (prod):** `firebase functions:secrets:set ANTHROPIC_API_KEY` y `... META_APP_SECRET` en `vpw-prod`.
- **Plan Blaze** en `vpw-prod` (Functions 2ª gen + SSR de web frameworks + Cloud Storage egress).
- **Web Frameworks habilitado** en la CLI si la versión lo pide (`firebase experiments:enable webframeworks`).
- **Índices Firestore:** desplegar (`deploy:indexes`) y esperar a que terminen de construirse antes de servir tráfico.
- **Backfill de free-trials en prod** (`backfill-free-trials.mjs`, dry-run → `--apply`) para los tenants legacy que existan en prod (apunta a emulador por env hoy; en prod hay que apuntarlo a `vpw-prod` con credenciales admin — ver "NO hacer" para el resguardo).

### ⛔ Bloqueado por externo
- **Meta/WhatsApp real:** App de Meta en modo Live + dominio verificado en Meta + **App Review/Advanced Access** de los scopes WhatsApp + Embedded Signup config (`NEXT_PUBLIC_META_CONFIG_ID`). Ver `docs/meta-go-live.md`. Hasta entonces, Meta queda en estado honesto "no configurada" (INTEGRATIONS-PROD-SAFETY) y NO se conectan clientes reales por WhatsApp.
- **Dominio (Hostinger → Firebase Hosting):** depende de propagación DNS + emisión de SSL (ver §3).
- **Pagos online** (Stripe/PayPal): hoy el alta es **billing manual por WhatsApp** → Stripe/PayPal son **opcionales/roadmap**. No bloquean el deploy (sí requieren sus keys si se activan).

### ⛔🚫 NO hacer en producción
- **NO** `NEXT_PUBLIC_USE_EMULATORS=true` ni `ENABLE_DEV_ENDPOINTS=true` / `DEV_ENDPOINTS_SECRET` en prod (dejarían dev endpoints accesibles).
- **NO** correr seeds en prod: `seed-users.mjs`, `seed-demo.mjs`, `seed-demo-chats.mjs`, `load-catalog.mjs` (son datos demo; además apuntan al emulador por env — no apuntarlos a prod).
- **NO** correr `verify-*.mjs` contra prod (están atados a `FIRESTORE_EMULATOR_HOST`/`demo-aiafg`).
- **NO** commitear valores reales de secrets (`.env.local`/`.env.<project>`/`.secret.local` van gitignored).
- **NO** rotar `TENANT_SECRETS_ENCRYPTION_KEY` después de cifrar tokens reales (obliga a re-cifrar todo).
- **NO** activar `ALLOW_GLOBAL_WHATSAPP_FALLBACK` (fallback global deprecado; rompe el multi-tenant).
- **NO** deployar con el proyecto equivocado: usar `--project vpw-prod` explícito (default es `vpw-dev`).

## 2. Orden recomendado de ejecución (deploy oficial)
1. **Staging primero** (`vpw-staging`): repetir todos los pasos en staging y validar antes de prod (web frameworks + pnpm monorepo conviene probarlo).
2. **Plan Blaze** en `vpw-prod` + (si la CLI lo pide) `firebase experiments:enable webframeworks`.
3. **Secrets prod:** `firebase functions:secrets:set ANTHROPIC_API_KEY` y `META_APP_SECRET` (proyecto `vpw-prod`). Setear el resto del backend env (`config.ts`) por `.env.vpw-prod` en `apps/functions`.
4. **Env frontend prod:** `apps/web/.env.production` con los `NEXT_PUBLIC_*` de vpw-prod (USE_EMULATORS **false**).
5. **Rules + indexes:** `pnpm deploy:rules` + `pnpm deploy:indexes` (`--project vpw-prod`); esperar a que los índices terminen.
6. **Functions:** `firebase deploy --only functions --project vpw-prod` (corre el predeploy build). Verificar en logs que arrancan sin "missing env/secret".
7. **Hosting (web frameworks):** `firebase deploy --only hosting --project vpw-prod` (buildea Next.js + provisiona SSR). Probar la URL `*.web.app` antes del dominio.
8. **Smoke en prod** (sin clientes reales): login, panel, dashboard, integraciones en estado "Meta no configurada", billing manual, trial. Confirmar que NO aparecen acciones demo y que la consola no tira errores.
9. **Dominio Hostinger** (§3): agregar el custom domain, cargar DNS, esperar SSL, configurar redirect.
10. **Meta go-live** (`docs/meta-go-live.md`): recién cuando App Review + dominio verificado en Meta + secrets → conectar una empresa de prueba → activar `live` → habilitar clientes.
11. **Backfill free-trials** en prod (dry-run → `--apply`) para tenants legacy.

## 3. Dominio Hostinger → Firebase Hosting (pasos, sin ejecutar)
1. En **Firebase Console → Hosting → Add custom domain**: ingresar el dominio (root `midominio.com` y/o `www`). Firebase muestra los **registros exactos** a cargar (no hardcodear acá: usar los que da la consola).
2. **Verificación de propiedad:** cargar el **TXT** que da Firebase en el DNS de **Hostinger** (zona DNS del dominio). Esperar verificación.
3. **Apuntar el dominio:** Firebase da **registros A** (apex/root → IPs de Firebase Hosting) y, para `www`, normalmente **A** o **CNAME** según lo que indique. Cargarlos en Hostinger (borrar A/CNAME previos que apunten al hosting de Hostinger para evitar conflicto).
4. **SSL:** Firebase **provisiona el certificado automáticamente** (Let's Encrypt) una vez verificado el DNS; puede tardar (minutos a 24 h por propagación).
5. **Redirect www↔root:** decidir el canónico (recomendado `www → root` o `root → www`) y configurarlo (en Firebase Hosting al agregar ambos dominios, o con `redirects` en `firebase.json`). Hoy `firebase.json` **no tiene `redirects`** → si se quiere redirect, se agrega ahí (cambio menor, fuera de esta auditoría).
6. **No conectar el dominio todavía** (alcance de esta fase). Cuando se haga, validar `https://midominio.com` + `https://www…` + que el SSL esté activo.

## 4. Riesgos
- **`NEXT_PUBLIC_USE_EMULATORS` mal seteado** → la app de prod pega a `localhost` (todo roto) y muestra credenciales/acciones demo. **El riesgo #1.** Verificar el bundle de prod.
- **`NEXT_PUBLIC_*` son build-time** (se hornean en el cliente). Si el build de deploy no tiene el env correcto, quedan vacíos → Meta no se activa, Firebase mal apuntado. Setearlos en el entorno del build.
- **Env backend faltante** → `getConfig()` (Zod) tira al primer request y las functions fallan (incluye `TENANT_SECRETS_ENCRYPTION_KEY`, `WHATSAPP_APP_SECRET`, verify token, n8n, urls). Proveer TODO antes del deploy de functions.
- **Web frameworks + pnpm monorepo** puede ser quisquilloso en el build de Hosting → **probar en staging primero**.
- **Índices Firestore no construidos** → queries fallan con "needs index". Deployar indexes y esperar.
- **Depende de App Review de Meta:** sin ella, NO hay WhatsApp real (queda en estado honesto). No bloquea el deploy del panel, sí el go-live de mensajería.
- **Depende de Secret Manager:** sin `ANTHROPIC_API_KEY` → AI en `disabled` (fallback rule-based, no rompe); sin `META_APP_SECRET` → el connect real falla (pero el panel no se rompe).
- **Depende del dominio:** hasta SSL emitido, solo sirve `*.web.app`.
- **No listo para clientes reales todavía:** falta Meta App Review + secrets reales + dominio + smoke en prod. El panel/billing-manual/trial sí están listos para operar en prod una vez configurado el env.

_No se implementó nada: auditoría + plan. Próximos cambios (ej. `redirects` en firebase.json, `.env.production`) se hacen en fases dedicadas._
