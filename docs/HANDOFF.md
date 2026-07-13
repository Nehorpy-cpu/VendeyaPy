# HANDOFF — Estado del proyecto y prioridades para Claude Code

> **INSTRUCCIONES PARA CLAUDE CODE**: este documento es para VOS, el agente. Leelo completo al
> iniciar sesión antes de tocar nada. Resume el estado real del proyecto al **2026-07-13**,
> lo desarrollado hasta ahora, la fase EN CURSO (con un paso a medio terminar) y las prioridades.
> Fue escrito por la sesión anterior de Claude Code al migrar el desarrollo a otra computadora,
> donde no está disponible la memoria local de aquella máquina — este documento es autocontenido.
> Mantenelo actualizado: cuando cierres una fase o cambie el estado, editá este archivo y commitealo.

---

## 1. Qué es el proyecto

**VendeyaPy**: SaaS multi-tenant de ventas por WhatsApp (bot IA + panel web) operando en Paraguay.

- **Repo activo**: `10-backend/` de este monorepo (`github.com/Nehorpy-cpu/VendeyaPy`, privado, rama `main`).
- **Prod**: Firebase `vpw-prod-dd6ff` (Functions v2 + Hosting Next.js SSR + Firestore + Storage + Auth). Panel: `https://vpw-prod-dd6ff.web.app` (y `vendeyapy.com` en migración, ver §4-FASE 4).
- **Tenant real único en operación**: `arfagi` (perfumería del owner). Número WhatsApp real +595 986 440752 (PNID 1251346811387904), `whatsappSendMode=live`, plan `growth` activo. Segundo tenant `credipower` existe (starter) — **decisión del owner: SE QUEDA, no tocarlo**.
- **Owner**: Marco — **no técnico**. Comunicarse en español, sin jerga, con reportes claros de qué se hizo y qué falta. Él maneja los dashboards externos (Meta, Hostinger) siguiendo instrucciones paso a paso.
- **Norte del producto** (post-cierre): atribución Meta anuncio→pedido→ganancia. Hoy NO se desarrolla: primero se cierra la operación single-tenant.

## 2. Metodología de trabajo (obligatoria)

El owner aprueba **programas** con nombre (ej. "Aprobado CAT-2B"). Ciclo fijo por programa:
**auditoría → implementación → tests unit + E2E emulador → review adversarial multi-agente → commit + push a main — SIN DEPLOY hasta aprobación explícita** → programa de deploy aparte (pre-flight + deploy + smoke técnico + smoke funcional real).

Reglas innegociables (todas confirmadas por el owner en sesiones anteriores):
- **Nunca deployar sin aprobación explícita.** Si un deploy aprobado requiere algo extra (rules, configs, IAM), **parar y reportar antes**.
- **Push tras cada commit** (con `git pull --rebase origin main` antes).
- **No imprimir tokens ni secretos** en logs/outputs. No hard-deletes. Nunca marcar pedidos PAID automáticamente. No cambiar `live`/`mock` sin aprobación. Mutaciones de datos siempre vía callables auditados.
- **Convivencia**: el owner a veces edita `apps/web` en paralelo — tocar frontend solo dentro de un programa aprobado.
- Verificar con `pnpm -r typecheck` + tests antes de cerrar cualquier cambio. Ojo: `cmd | tail` enmascara el exit code — verificar con `> /dev/null 2>&1; echo $?`.

## 3. Desarrollo completado (condensado, todo EN PROD y verificado)

- **Bot de ventas completo** (`apps/functions/src/conversation/engine.ts` + módulos): F1 género/router/delegación a IA, F1B grounding de productos, F2 agregar-por-confirmación, F3 carrito contextual (`pendingCartConfirmation`), F4 cortesía + interceptor de reclamos + anti-mentiras, F5 checkout idempotente (`checkoutReuse`), F6 bienvenida breve + intención en el mismo turno.
- **Pedidos**: ciclo de vida con callables auditados (ORDER-1/2/2B), comprobantes por foto a Storage (ORDER-1B), **visor de comprobante en el panel** con URL firmada de 10 min (OCV-1; requirió grant IAM, ver §5).
- **Handoff humano** (HUMAN-HANDOFF-1): el vendedor toma el chat y responde por WhatsApp desde `/conversations`; `humanTakeover` se valida contra la SESIÓN.
- **Multi-número** por tenant con ruteo por PNID.
- **Catálogo enriquecido** (CAT-1/2/2B): ficha estructurada por producto (`PublicProduct.ficha`), ranking por ocasión (`fichaRank.ts`), interceptor determinístico "¿X sirve para Y?" honesto con alternativa (`productOccasion.ts`). IA solo en turno 1 (~US$0,007/conversación); turnos siguientes determinísticos.
- **Planes y límites** (free→enterprise), activación manual de billing (PLATFORM_ADMIN), trial enforcement + notificaciones (campana + scheduler diario). Cloud Scheduler activo (3 jobs).
- **AI Gateway** Claude Haiku (modelo pineado `claude-haiku-4-5-20251001`).
- **Registro + onboarding** self-service (R-1/2/3) — **hoy CERRADO por flag** (ver FASE 2 abajo).
- **Frontend premium completo** (programa FRONTEND-UX 1A–1G): landing + panel + responsive + kit `components/ui`.
- **Meta**: app de producción propia (ID 1739140590442740, portafolio comercial de la perfumería), token permanente `source:manual_admin` cifrado AES-256-GCM, webhook firmado, Graph v19.0. Smoke inbound end-to-end verificado.
- **Fixes recientes (2026-07-13)**: `8552091` el chat del panel mostraba los 200 mensajes más viejos (asc+limit → desc+reverse); `db18e30` mismo patrón en `audits/generate.ts`.

## 4. PLAN MAESTRO VIGENTE: cierre single-tenant (operar solo con arfagi)

Aprobado por el owner. El multi-tenant queda para después. Estado por fase:

### FASE 1 — OCV-IAM-FIX ✅ COMPLETA
Grant `roles/iam.serviceAccountTokenCreator` al SA de functions **sobre sí mismo** → visor de comprobantes funcionando en prod (verificado con imagen real).

### FASE 2 — SINGLE-TENANT-LOCK ✅ COMPLETA (commit `1df18b4`)
Registro público CERRADO por flag, reversible:
- Backend (barrera real): `ALLOW_SELF_REGISTRATION=false` en `apps/functions/.env.vpw-prod-dd6ff` (gitignored) → `registerTenantOwner` rechaza con `failed-precondition` ANTES del auth check.
- Frontend: `NEXT_PUBLIC_ALLOW_SELF_REGISTRATION=false` → `/register` muestra "Registro por invitación", login sin CTA. Los CTAs del marketing siguen apuntando a /register a propósito (leads de WhatsApp).
- Verificado que NO hay otra vía de alta (provisionTenant = admin-only; dev endpoints 404 en prod).

### FASE 3 — META-ARFAGI-LIVE ✅ según el owner, con UNA verificación pendiente
El owner confirmó el checklist del dashboard de Meta (Business Verification, app en modo Live, display name, perfil). **PENDIENTE DE EVIDENCIA**: la prueba de aceptación con un número EXTERNO (no del owner) — al 2026-07-13 en Firestore solo hay conversaciones de sus 3 números propios (595994893000, 595972720060, 595991192613). **Cuando escriba un número externo, verificar read-only**: inbound con PNID real → respuesta del bot (wamid real) → carrito → orden → comprobante visible en panel → logs sin errores.

### FASE 4 — DOMINIO ⚠️ EN CURSO — A MEDIO MIGRAR (prioridad #1)
Migración de `vendeyapy.com` (Hostinger) del proyecto de PRUEBA (`vpw-staging`, project number 1038775023923) al real (`vpw-prod-dd6ff`).

**Ya hecho (lado Firebase, 2026-07-13)**:
1. Custom domains `vendeyapy.com` + `www.vendeyapy.com` ELIMINADOS de `vpw-staging`.
2. CREADOS en `vpw-prod-dd6ff` (site default): apex sirve, `www` con `redirectTarget: vendeyapy.com`. Estado al crear: `HOST_ACTIVE` + `CERT_ACTIVE` pero `OWNERSHIP_MISMATCH` (el TXT del DNS aún dice staging).
3. `vendeyapy.com` y `www.vendeyapy.com` agregados a `authorizedDomains` de Firebase Auth de prod.
4. `WEB_BASE_URL` en `apps/functions/.env.vpw-prod-dd6ff` YA es `https://vendeyapy.com` — **no hace falta redeploy de functions**.

**PENDIENTE — bloqueado en el owner (2 ediciones en Hostinger → hPanel → Dominios → vendeyapy.com → Zona DNS)**:
| Registro | Nombre | Cambiar de → a |
|---|---|---|
| TXT | `@` | `hosting-site=vpw-staging` → `hosting-site=vpw-prod-dd6ff` |
| CNAME | `www` | `vpw-staging.web.app` → `vpw-prod-dd6ff.web.app` |

(El A `@` → `199.36.158.100` queda igual; no tocar otros TXT.)

**Mientras tanto `vendeyapy.com` responde 404** (dejó staging, prod no lo sirve hasta el TXT). El bot de WhatsApp NO depende del dominio (webhook apunta directo a functions) y el panel sigue en `vpw-prod-dd6ff.web.app`.

**Para cerrar la fase cuando el owner confirme el DNS**: verificar `nslookup -type=TXT vendeyapy.com` y CNAME de www → comprobar `ownershipState=OWNERSHIP_ACTIVE` vía API Hosting (`GET /v1beta1/projects/vpw-prod-dd6ff/sites/vpw-prod-dd6ff/customDomains`) → smoke: `https://vendeyapy.com` sirve el panel real (200, bundle con projectId `vpw-prod-dd6ff`), `www` redirige al apex, login funciona en el dominio, `vpw-prod-dd6ff.web.app` sigue OK → actualizar este doc y avisar al owner.

### FASE 5 — OPERACIÓN ⏳ PENDIENTE (siguiente después de F4)
1. `docs/runbook-arfagi.md` (nuevo): operación diaria del panel para el owner (pedidos/comprobantes/estados, tomar-devolver chats, catálogo con ficha IA, qué hacer si el bot no responde — OJO: si la conexión Meta se degrada, el envío cae a mock EN SILENCIO; la señal es que los clientes no reciben respuestas).
2. Backups: rutina semanal documentada con `apps/functions/scripts/export-tenant.mjs --include-private`; evaluar exports programados de Firestore (GCP).
3. Alertas mínimas: presupuesto de facturación GCP con aviso por email + alerta de Cloud Monitoring sobre errores de functions.
4. Actualizar `docs/deploy-readiness.md` (tiene secciones anteriores a los deploys reales, puede confundir) y este HANDOFF.

### FASE 6 — BACKLOG (no bloquea; solo con pedido del owner)
UI del asistente interno de growth · botón "generar ficha con IA" (excluido a pedido del owner) · Meta Catalog sync + Conversions API reales (el "norte", requiere Advanced Access) · pagos online · reabrir multi-tenant (flag en true + App Review + Embedded Signup + dominio verificado en Meta).

## 5. Datos operativos críticos (leer antes de cualquier deploy)

- **Deploy functions**: `firebase deploy --only functions --config firebase.functions.json --project vpw-prod-dd6ff --force` (predeploy genera `apps/functions/.deploy`; los 429 de cuota reintentan solos; verificar "Successful update/create operation" por función).
- **Deploy hosting**: crear TEMPORAL `apps/web/.env.production.local` con la config pública de Firebase (apiKey `AIzaSyBp1p2UbjDAbtVYMZX03rcMuSx6cACku5c`, projectId `vpw-prod-dd6ff`, bucket `vpw-prod-dd6ff.firebasestorage.app`, senderId `410226633946`, appId `1:410226633946:web:0b3fa3f3f94e3bcce2c9e3`, `NEXT_PUBLIC_USE_EMULATORS=false`) **+ SIEMPRE `NEXT_PUBLIC_ALLOW_SELF_REGISTRATION=false`** (si se olvida, /register vuelve a mostrar el form) → `firebase deploy --only hosting --project vpw-prod-dd6ff --force` → **BORRAR el env temporal**. Plantilla completa: `apps/web/.env.production.example`.
- **IAM**: el SA de functions `410226633946-compute@developer.gserviceaccount.com` tiene `iam.serviceAccountTokenCreator` sobre sí mismo (firma de URLs de comprobantes). **Si se cambia el SA de functions, re-otorgar el grant.**
- **Acceso a prod sin gcloud** (patrón usado por todos los scripts de verificación): en Node, `require('<ruta firebase-tools global>/lib/requireAuth')` + `auth.getProjectDefaultAccount()` + `apiv2.Client` contra las APIs REST (Firestore runQuery, Identity Toolkit, Cloud Logging, Hosting). Requiere `firebase login` con la cuenta owner del proyecto en la máquina. Usuarios de prueba en prod: crear temporal por Identity Toolkit (claims `{tenantId, role:'TENANT_MANAGER'}`), smoke por Playwright, **eliminar al terminar**.
- **Emulador E2E**: SIEMPRE `--project demo-aiafg` + build + **seed-users.mjs Y load-catalog.mjs** (sin catálogo, verify-human-handoff falla 5/11); `.env.local` con TODAS las vars de `getConfig()`; esperar ~30s el settle del caché de entitlements; nunca pipe `emulators:start` a `head`.
- **Costo IA**: ~US$0,007 por conversación con búsqueda (solo turno 1); turnos determinísticos gratis.

## 6. PRIORIDADES (en orden)

1. **Cerrar FASE 4**: en cuanto el owner confirme las 2 ediciones DNS en Hostinger, correr la verificación + smoke de §4-FASE 4. Es lo único que mantiene `vendeyapy.com` caído.
2. **Evidencia de FASE 3**: primera conversación de número externo → verificación read-only completa (§4-FASE 3).
3. **FASE 5 completa** (runbook + backups + alertas + docs al día) — programa estándar, sin deploy de código previsto.
4. **Criterio de "terminado" del proyecto**: una persona externa completa el ciclo entero sin intervención técnica — escribe al +595 986 440752 → el bot recomienda con ficha (honesto en "¿sirve para X?") → carrito → "pagar" crea la orden → foto del comprobante → el vendedor la VE en el panel desde `vendeyapy.com` → confirma el pago → venta registrada con ganancia. Verificación read-only en cada paso + registro público cerrado + backup semanal documentado.
5. Después de eso: FASE 6 solo a pedido del owner.
