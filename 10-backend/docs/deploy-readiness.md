# Deploy readiness — Firebase (Hosting + Functions + Firestore + Auth) · dominio Hostinger

> Auditoría READ-ONLY (DEPLOY-READINESS-AUDIT). Mapea el estado real para pasar de local/emulador a
> producción **sin romper** seguridad, billing, Meta/WhatsApp, AI ni multi-tenant. **No se hizo deploy.**
> Estados: ✅ listo · ⚠️ falta configurar · ⛔ bloqueado por externo · ⛔🚫 NO hacer en producción.

## 0. Cómo está armado el deploy (hechos del repo)
- **Proyectos** (`.firebaserc`): `dev`/default = `vpw-dev`, `staging` = `vpw-staging`, **prod = `vpw-prod`**. Local/emulador usa `demo-aiafg` (proyecto demo desechable; lo usan `.env.local` del web y los `verify-*.mjs`).
- **Hosting = Firebase Web Frameworks (Next.js SSR).** `firebase.json` → `hosting.source: "apps/web"` + `frameworksBackend.region: "us-central1"`. NO es export estático: `next.config.mjs` no tiene `output:'export'` (hay server components/SSR). `firebase deploy` detecta Next.js, corre `next build` y **provisiona un backend SSR (Cloud Function 2ª gen) + sube los estáticos al CDN**. ⇒ requiere **plan Blaze** y, según versión de CLI, habilitar Web Frameworks.
- **Functions:** `firebase.json` → source `apps/functions`, `predeploy: pnpm --filter functions build` (buildea antes de deployar). Región `us-central1`.
- **Firestore:** `rules` = `firestore.rules` (402 líneas, **default-deny** al final), `indexes` = `firestore.indexes.json` (111 líneas). **Storage:** `storage.rules` (tenant-isolated).
- **Scripts de deploy** (`package.json` raíz): `deploy:staging` (`firebase deploy --project vpw-staging`), `deploy:prod` (`--project vpw-prod`), `deploy:rules` (`firestore:rules,storage`), `deploy:indexes`. Functions: `apps/functions` → `deploy` (`--only functions`). Web build: `apps/web` → `next build`.

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
- **Habilitar servicios en la consola del proyecto** (aprendido en staging — NO se crean solos al crear el proyecto): **Firebase Authentication + proveedor Email/Password** (sin esto, `signUp`/`signInWithPassword` → **`CONFIGURATION_NOT_FOUND`** y nadie puede registrarse/loguear; el panel redirige a `/login` pero el login falla), **base Firestore** (elegir región; sin ella `deploy:rules`/`deploy:indexes` fallan) y **Cloud Storage for Firebase**. Recién con Auth habilitado tiene sentido el smoke autenticado del panel.
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
6. **Functions:** `firebase deploy --only functions --config firebase.functions.json --project vpw-prod` (config **alterno** del fix de empaquetado pnpm — STAGING-FUNCTIONS-BUNDLE-FIX; el predeploy genera el artefacto autónomo `apps/functions/.deploy`, porque un deploy directo de `apps/functions` falla con `EUNSUPPORTEDPROTOCOL` por `"@vpw/shared":"workspace:*"`). Verificar en logs que arrancan sin "missing env/secret".
7. **IAM público de Functions (§7):** los servicios Cloud Run v2 **nacen privados** → conceder `roles/run.invoker` a `allUsers` en las HTTP/callable, **excluyendo** las event/scheduled. Sin esto, todo da **403** (incluso `healthCheck`). **Repetir tras cada deploy de functions** (las funciones nuevas también nacen privadas). Comandos + exclusión + smoke en §7.
8. **Hosting (web frameworks):** `firebase deploy --only hosting --project vpw-prod` (buildea Next.js + provisiona SSR). Probar la URL `*.web.app` antes del dominio.
9. **Smoke en prod** (sin clientes reales): login, panel, dashboard, integraciones en estado "Meta no configurada", billing manual, trial. Confirmar que NO aparecen acciones demo y que la consola no tira errores.
10. **Dominio Hostinger** (§3): agregar el custom domain, cargar DNS, esperar SSL, configurar redirect.
11. **Meta go-live** (`docs/meta-go-live.md`): recién cuando App Review + dominio verificado en Meta + secrets → conectar una empresa de prueba → activar `live` → habilitar clientes.
12. **Backfill free-trials** en prod (dry-run → `--apply`) para tenants legacy.

## 3. Dominio Hostinger → Firebase Hosting (pasos, sin ejecutar)
1. En **Firebase Console → Hosting → Add custom domain**: ingresar el dominio (root `midominio.com` y/o `www`). Firebase muestra los **registros exactos** a cargar (no hardcodear acá: usar los que da la consola).
2. **Verificación de propiedad:** cargar el **TXT** que da Firebase en el DNS de **Hostinger** (zona DNS del dominio). Esperar verificación.
3. **Apuntar el dominio:** Firebase da **registros A** (apex/root → IPs de Firebase Hosting) y, para `www`, normalmente **A** o **CNAME** según lo que indique. Cargarlos en Hostinger (borrar A/CNAME previos que apunten al hosting de Hostinger para evitar conflicto).
4. **SSL:** Firebase **provisiona el certificado automáticamente** (Let's Encrypt) una vez verificado el DNS; puede tardar (minutos a 24 h por propagación).
5. **Redirect www↔root:** decidir el canónico (recomendado `www → root` o `root → www`). ⚠️ **Requiere el dominio final** y por eso se difiere a **DOMAIN-HOSTINGER-1** (ver §6). NO se agregó `redirects` a `firebase.json` en DEPLOY-PREP-1: un redirect host-canónico no se puede expresar de forma genérica/sin dominio, y meter un `redirects` array bajo Web Frameworks puede chocar con el adaptador de Next.
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

## 5. Plantillas de entorno de producción (DEPLOY-PREP-1)

> Solo **plantillas/checklist** — sin valores reales. Frontend = plantilla versionada;
> backend = lista para setear en el runtime de Functions. Marcado: 🌐 público (va al cliente) ·
> 🔒 secreto (Secret Manager) · 🧩 sensible (env deployado, no commitear).

### 5.1 Frontend (`apps/web`) — build-time, PÚBLICO

Plantilla versionada: **`apps/web/.env.production.example`** → copiar a `apps/web/.env.production`
(gitignored) o setear en el entorno del **build de deploy**. Las `NEXT_PUBLIC_*` se hornean en el
bundle; si faltan en el build, quedan vacías. **Ninguna es secreta** (la API key de Firebase Web es
identificador de proyecto, no credencial; la seguridad la dan rules + Auth).

| Var | Marca | Notas |
|---|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | 🌐 | SDK config de vpw-prod (Console → Project Settings) |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | 🌐 | `vpw-prod.firebaseapp.com` |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | 🌐 | `vpw-prod` |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | 🌐 | usar el EXACTO de la consola (`.appspot.com` o `.firebasestorage.app`) |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | 🌐 | SDK config |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | 🌐 | SDK config |
| `NEXT_PUBLIC_USE_EMULATORS` | 🌐 | **DEBE ser `false`/ausente.** ★ Riesgo #1 ★ |
| `NEXT_PUBLIC_META_APP_ID` | 🌐 | Embedded Signup; si falta → "Meta no configurada" |
| `NEXT_PUBLIC_META_CONFIG_ID` | 🌐 | Embedded Signup; idem |
| `NEXT_PUBLIC_META_GRAPH_VERSION` | 🌐 | ej. `v19.0` |
| `NEXT_PUBLIC_SUPPORT_WHATSAPP` | 🌐 | número soporte (solo dígitos); link wa.me de billing manual / RegistrationGate |
| `NEXT_PUBLIC_API_BASE_URL` | 🌐 | **opcional en prod**: solo endpoints dev-tooling (404 en prod). Setear a la base real para evitar fallback a localhost |

### 5.2 Backend (`apps/functions`) — runtime de Functions

Setear en el runtime de `vpw-prod`. Plantilla completa con notas en **`.env.example`** (raíz). Lo
SECRETO va a **Secret Manager** (`defineSecret` + binding); lo SENSIBLE-pero-no-secret va por env
deployado (no commitear). Sin estos, `getConfig()` (Zod) tira al primer request y las functions fallan.

| Var | Marca | Cómo se provee |
|---|---|---|
| `ANTHROPIC_API_KEY` | 🔒 | `firebase functions:secrets:set ANTHROPIC_API_KEY` (bound a IA). Sin ella → AI `disabled` (fallback rule-based) |
| `META_APP_SECRET` | 🔒 | `firebase functions:secrets:set META_APP_SECRET` (bound a `connectMeta`/`verifyMetaChannel`). **Mismo valor que `WHATSAPP_APP_SECRET`** |
| `TENANT_SECRETS_ENCRYPTION_KEY` | 🧩 | env deployado, min 32, **DEFINITIVA** antes de cifrar tokens reales (rotarla obliga a re-cifrar todo) |
| `WHATSAPP_APP_SECRET` | 🧩 | env deployado, firma del webhook (HMAC). Mismo App Secret que `META_APP_SECRET` |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | 🧩 | env deployado, token de verificación del webhook (configurado igual en Meta) |
| `META_APP_ID` | 🌐 | env deployado, ID público de la app de Meta (no secreto) |
| `API_BASE_URL` | 🌐 | env deployado, base de functions de prod |
| `WEB_BASE_URL` | 🌐 | env deployado, URL pública del panel (dominio/`*.web.app`) |
| `N8N_BASE_URL` | 🌐 | env deployado, si se usa n8n |
| `N8N_INTERNAL_SECRET` | 🧩 | env deployado, min 32, si se usa n8n |

> **Propuesto (META-SECRETS-2):** migrar `WHATSAPP_APP_SECRET` / `WHATSAPP_WEBHOOK_VERIFY_TOKEN` /
> `TENANT_SECRETS_ENCRYPTION_KEY` (hoy 🧩 env deployado) a Secret Manager. Hoy están acoplados a
> `config.ts` (los valida `getConfig`, usados backend-wide) → migración backend-wide, no por-función.

## 6. Redirect host-canónico (www↔root) — diferido a DOMAIN-HOSTINGER-1

**No se tocó `firebase.json`.** Un redirect www↔root **no se puede expresar sin el dominio final**:
el `redirects` array de Firebase Hosting es por-path (source/destination), no por-host; un
host-canónico necesita destino absoluto con el dominio. Además, bajo **Web Frameworks (Next SSR)**
meter un `redirects` array puede chocar con el adaptador de Next. Por eso se difiere. Opciones seguras
para esa fase (elegir una, ya con el dominio):

1. **Hostinger / registrar:** redirect 301 `www → root` (o viceversa) en la zona DNS / panel del dominio (lo más simple, no toca el repo).
2. **Next.js `redirects()`** en `next.config.mjs` con matcher de host (`has: [{ type: 'host', value: 'www.midominio.com' }]`) → `permanent: true`. Compatible con Web Frameworks; requiere el dominio.

_DEPLOY-PREP-1: solo config/docs. Se creó `apps/web/.env.production.example` y se documentó el
checklist backend + el diferimiento de redirects. **No se hizo deploy, no se conectó dominio ni Meta,
no se tocaron secrets reales ni lógica de producto.** Próximo: DOMAIN-HOSTINGER-1 (dominio + redirect)._

## 7. Invocación pública de Functions (IAM Cloud Run) — STAGING-FUNCTIONS-IAM

> Paso **obligatorio después de cada deploy de functions**. Validado en `vpw-staging`.

### 7.1 Por qué hace falta
- Cloud Functions v2 = servicios **Cloud Run**, que **nacen privados** (sin invoker público). Antes del
  paso IAM, `healthCheck` (una HTTP function **sin auth en el código**) devolvía **HTTP 403**: la request
  ni siquiera llega al código.
- Tras conceder `roles/run.invoker` a `allUsers` en los servicios HTTP/callable, `healthCheck` → **200**.
- **La seguridad real la hace el CÓDIGO, no el IAM de Cloud Run:** auth + rol + tenant en los callables,
  firma HMAC en webhooks (`metaWebhook`/`stripeWebhook`), y el `guardDevEndpoint` (dev* → 404 fuera del
  emulador). `allUsers` solo permite que la request **llegue** al handler; el handler decide.

### 7.2 Qué servicios SÍ abrir (`allUsers` / `run.invoker`)
- **HTTP functions** (`httpsTrigger`): webhooks reales (`metaWebhook`, `stripeWebhook`,
  `paypalBillingWebhook`, `platformBillingWebhook`), `healthCheck`, y los `dev*` (quedan en **404** por el guard).
- **Callable functions** (`callableTrigger`): todas (el panel las invoca con token de Auth; auth in-app).
- En staging fueron **65** servicios (40 callable + 25 https).

### 7.3 Qué servicios NO abrir (dejar privados)
Disparados por Eventarc/Scheduler — exponerlos dejaría que cualquiera POSTee eventos/jobs falsos. El
`runServiceId` es el nombre de la función **en minúsculas**:
- `onOrderWriteStats` → `onorderwritestats` · `onProductWriteAudit` → `onproductwriteaudit` · `onWebhookInbox` → `onwebhookinbox` (event / Firestore)
- `resetUsageMonthly` → `resetusagemonthly` · `trialNotificationsDaily` → `trialnotificationsdaily` · `refreshGrowthJobsDaily` → `refreshgrowthjobsdaily` (scheduled)

### 7.4 Comandos (Cloud Shell)
```bash
gcloud config set project <PROJECT>            # vpw-staging | vpw-prod
gcloud run services list --region=us-central1

# 1) Probar PRIMERO con healthCheck (sin auth en código → test limpio):
gcloud run services add-iam-policy-binding healthcheck \
  --region=us-central1 --member=allUsers --role=roles/run.invoker
HC=$(gcloud run services describe healthcheck --region=us-central1 --format='value(status.url)')
curl -s -o /dev/null -w "healthCheck -> %{http_code}\n" "$HC"     # esperar 200

# 2) Si healthCheck pasa a 200, aplicar al resto EXCLUYENDO event/scheduled:
EXCLUDE="onorderwritestats onproductwriteaudit onwebhookinbox resetusagemonthly trialnotificationsdaily refreshgrowthjobsdaily"
for SVC in $(gcloud run services list --region=us-central1 --format='value(metadata.name)'); do
  case " $EXCLUDE " in *" $SVC "*) echo "skip (event/scheduled): $SVC"; continue;; esac
  gcloud run services add-iam-policy-binding "$SVC" \
    --region=us-central1 --member=allUsers --role=roles/run.invoker --quiet >/dev/null \
    && echo "ok: $SVC"
done
```

### 7.5 Smoke esperado (tras IAM)
- `healthCheck` → **200** (era 403)
- dev endpoints (`devMetaConnect`, …) → **404** por el guard (NO 403 IAM)
- callable sin auth (`provisionTenant`, …) → **401** unauthenticated (NO 403/500; algún callable con
  validación previa de args puede dar **400** — también es "controlado", no IAM ni crash)
- `metaWebhook` GET con `verify_token` inválido → **403** (rechazo de la app, no 500)
- `stripeWebhook` POST sin firma → **401** (rechazo de firma, no 500)
- Logs (`firebase functions:log`): los containers cold-startean OK (`STARTUP TCP probe succeeded`);
  **sin** `MODULE_NOT_FOUND` / `@vpw/shared` / `ZodError` / missing-env.

### 7.6 Producción
- **Repetir este paso después de cada deploy de functions** (servicios v2 — y funciones nuevas — nacen
  privados). Apuntar `--project vpw-prod`.
- ⛔ Si `add-iam-policy-binding` con `allUsers` es **rechazado** por `constraints/iam.allowedPolicyMemberDomains`
  (**Domain Restricted Sharing**) → **bloqueo externo**: lo resuelve quien administre la org/Workspace
  (eximir el proyecto o ajustar la policy). En `vpw-staging` **no** había DRS (se aplicó sin problema).

_DEPLOY-DOCS-IAM: solo docs. Documenta el paso IAM (por qué, qué abrir/excluir, comandos, smoke, nota
prod). **No se ejecutó deploy ni IAM, no se tocó código ni secrets.**_
