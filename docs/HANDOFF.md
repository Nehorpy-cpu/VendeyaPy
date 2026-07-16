# HANDOFF — Estado del proyecto y prioridades para Claude Code

> **INSTRUCCIONES PARA CLAUDE CODE**: este documento es para VOS, el agente. Leelo completo al
> iniciar sesión antes de tocar nada. Resume el estado real del proyecto al **2026-07-16**,
> lo desarrollado hasta ahora, el estado por fases y las prioridades.
> Fue escrito por la sesión anterior de Claude Code al migrar el desarrollo a otra computadora,
> donde no está disponible la memoria local de aquella máquina — este documento es autocontenido.
> Mantenelo actualizado: cuando cierres una fase o cambie el estado, editá este archivo y commitealo.

---

## 1. Qué es el proyecto

**VendeyaPy**: SaaS multi-tenant de ventas por WhatsApp (bot IA + panel web) operando en Paraguay.

- **Repo activo**: `10-backend/` de este monorepo (`github.com/Nehorpy-cpu/VendeyaPy`, privado, rama `main`).
- **Prod**: Firebase `vpw-prod-dd6ff` (Functions v2 + Hosting Next.js SSR + Firestore + Storage + Auth). Panel: `https://vendeyapy.com` (dominio propio, migrado y verificado — ver §4-FASE 4) y `https://vpw-prod-dd6ff.web.app`.
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
- **Catálogo enriquecido** (CAT-1/2/2B): ficha estructurada por producto (`PublicProduct.ficha`), ranking por ocasión (`fichaRank.ts`), interceptor determinístico "¿X sirve para Y?" honesto con alternativa (`productOccasion.ts`). los turnos transaccionales/interceptados son determinísticos; los conversacionales delegan a la IA (costo real por turno: ver §5).
- **Planes y límites** (free→enterprise), activación manual de billing (PLATFORM_ADMIN), trial enforcement + notificaciones (campana + scheduler diario). Cloud Scheduler activo (3 jobs).
- **AI Gateway** Claude Haiku (modelo pineado `claude-haiku-4-5-20251001`).
- **Registro + onboarding** self-service (R-1/2/3) — **hoy CERRADO por flag** (ver FASE 2 abajo).
- **Frontend premium completo** (programa FRONTEND-UX 1A–1G): landing + panel + responsive + kit `components/ui`.
- **Meta**: app de producción propia (ID 1739140590442740, portafolio comercial de la perfumería), token permanente `source:manual_admin` cifrado AES-256-GCM, webhook firmado, Graph v19.0. Smoke inbound end-to-end verificado.
- **Fixes recientes (2026-07-13)**: `8552091` el chat del panel mostraba los 200 mensajes más viejos (asc+limit → desc+reverse); `db18e30` mismo patrón en `audits/generate.ts`.
- **WHATSAPP-AGENT-F7 — fidelidad estricta de producto/marca** (commit `97bb035`, EN PROD 2026-07-15): una consulta por nombre/marca devuelve SOLO coincidencias reales (marcado determinístico `coincidencia: exacta|alternativa` + rescate `fueraDeFiltros` cuando el precio/género excluye la coincidencia); la similitud explícita ("parecido a X") habilita alternativas SIEMPRE etiquetadas como tales; gramática del template de ocasión corregida. Desplegado con **selector mínimo de 4 funciones** (`onWebhookInbox`, `simulateAgentMessage`, `agentTestCaseRun`, `devMessage`), `.env` sin cambios (hash SHA-256 verificado pre/post). **Smoke live final aprobado**: consulta estricta, negación de pertenencia y búsqueda por similitud verificadas con marcas correctas y cero mutaciones comerciales. Cierre técnico completo. Observación de baja prioridad: en una comparación de dos productos la IA agrupó mal una marca en prosa (se corrigió sola al desafiarla y NO se reprodujo en el smoke final) — candidata a una regla de prompt para comparaciones.
- **HANDOFF-2 — handoff determinístico por pedido del cliente** (commit `e0c284e`, EN PROD 2026-07-15, cerrado de punta a punta): el bug real era que la IA PROMETÍA el pase ("un segundo que lo llamo") sin ejecutar nada. Ahora la detección es determinística ANTES de la IA (`conversation/humanRequest.ts`): pedidos genéricos, por NOMBRE configurado del tenant y "nuevamente"; negaciones por cláusula correctamente ignoradas ("no necesito hablar con un vendedor" no deriva; "No, quiero hablar con una persona" sí). Servicio CANÓNICO `executeHandoff` (transaccional, idempotente, razones estructuradas `customer_requested`/`payment_verification`/`coverage_review` reservada/`seller_manual`) + notificación campana idempotente por `sourceId` (wamid) + prompt guard anti-promesas + bot en silencio durante takeover (blindado contra turnos en vuelo) + liberación manual → retorno del bot con metadata limpia. Comprobante/pago manual preservados (HUMAN-HANDOFF-1 11/11). **Deploy**: 9 funciones con selector auditado (`onWebhookInbox`, `simulateAgentMessage`, `agentTestCaseRun`, `devMessage`, `chatTakeover`, `chatRelease`, `devTakeoverChat`, `devReleaseChat`, `devSubmitComprobante`) + **Hosting** (CTA "Ver conversación" en la campana), sin Rules, `.env` y registro cerrado preservados, cero deletes/recreates. **Smokes productivos aprobados**: solicitud genérica resuelve al vendedor configurado · por nombre · "nuevamente" con notificación única por pedido · campana + CTA al chat correcto · mensaje durante takeover persistido SIN respuesta del bot ni IA · respuesta humana · liberación con metadata limpia · retorno del bot · negación no deriva · cero mutaciones de carrito/pedidos/pagos.
- **AI-FALLBACK-HONESTO-1 — derivación honesta cuando la IA no está disponible** (commit `855b00d`, EN PROD 2026-07-16, cerrado de punta a punta): el motor ya no degrada en silencio cuando una consulta necesitaba IA. `runSalesAgent` expone estados de bloqueo ESTRUCTURADOS derivados solo de códigos (`quota_exhausted` / `feature_unavailable` / `configuration_error` / `provider_transient_error` / `empty_reply`), nunca de comparación de texto. **Solo `quota_exhausted`** (bloqueo persistente) activa el pase a humano, y solo si la consulta es realmente derivable (la cortesía pura tipo "gracias" NO deriva). Reusa el servicio canónico `executeHandoff` con la razón nueva **`ai_unavailable`** + notificación de campana idempotente (tipo `handoff_ai_unavailable`, severidad máxima; sin vendedor activo configurado: respuesta honesta sin promesa + aviso con bucket DIARIO anti-flood). El vendedor se resuelve SIEMPRE desde la config del tenant (asignado si sigue activo, si no el primer activo; placeholders filtrados). La confirmación al cliente sale SOLO después de persistir el takeover; si la persistencia falla, mensaje temporal honesto sin prometer pase; si ya estaba tomado, silencio. Los simuladores (`simulateAgentMessage`, `agentTestCaseRun`, `devMessage`) pasan `simulation: true` → mismo texto, CERO efectos operativos para ESTE fallback (gap conocido: el camino `customer_requested` de HANDOFF-2 desde simuladores sigue generando efectos reales). Los caminos determinísticos corren antes y quedaron intactos. **Deploy**: selector corregido a **9 funciones** — las mismas de HANDOFF-2; la propuesta inicial era de 4 y el grafo de imports mostró que `handoff.ts` también alcanza a las funciones de takeover/comprobante — + **Hosting** (severidad/CTA de la campana); cero Rules/deletes/recreates; `.env` (hash verificado pre/post), registro cerrado y config productiva preservados. **Verificación honesta**: la lógica de cuota se validó en tests/emulador (unit 34/34 · `verify-ai-fallback` 9/9 · `verify-ai-gateway` 14/14 · regresiones handoff2 8/8, human-handoff 11/11, f1/f5/f6 en verde) — el agotamiento NO se forzó en producción; prod se validó con **smoke de no-regresión** con IA disponible: consulta consultiva respondida por la IA real, "Gracias" sin handoff, delta del contador (6.805 tokens) EXACTAMENTE igual a la suma de las 2 aiRequests nuevas, cero handoffs/notificaciones nuevas, carrito/pedidos/pagos intactos, 0 errores en logs.

## 4. PLAN MAESTRO VIGENTE: cierre single-tenant (operar solo con arfagi)

Aprobado por el owner. El multi-tenant queda para después. Estado por fase:

### FASE 1 — OCV-IAM-FIX ✅ COMPLETA
Grant `roles/iam.serviceAccountTokenCreator` al SA de functions **sobre sí mismo** → visor de comprobantes funcionando en prod (verificado con imagen real).

### FASE 2 — SINGLE-TENANT-LOCK ✅ COMPLETA (commit `1df18b4`)
Registro público CERRADO por flag, reversible:
- Backend (barrera real): `ALLOW_SELF_REGISTRATION=false` en `apps/functions/.env.vpw-prod-dd6ff` (gitignored) → `registerTenantOwner` rechaza con `failed-precondition` ANTES del auth check.
- Frontend: `NEXT_PUBLIC_ALLOW_SELF_REGISTRATION=false` → `/register` muestra "Registro por invitación", login sin CTA. Los CTAs del marketing siguen apuntando a /register a propósito (leads de WhatsApp).
- Verificado que NO hay otra vía de alta (provisionTenant = admin-only; dev endpoints 404 en prod).

### FASE 3 — META-ARFAGI-LIVE ⚠️ checklist del owner OK — PENDIENTE la evidencia externa
El owner confirmó el checklist del dashboard de Meta (Business Verification, app en modo Live, display name, perfil). **PENDIENTE DE EVIDENCIA**: la prueba de aceptación con un número EXTERNO (no del owner) — al 2026-07-13 en Firestore solo hay conversaciones de sus 3 números propios (595994893000, 595972720060, 595991192613). **Cuando escriba un número externo, verificar read-only**: inbound con PNID real → respuesta del bot (wamid real) → carrito → orden → comprobante visible en panel → logs sin errores.

### FASE 4 — DOMINIO ✅ COMPLETA (2026-07-13)
Migración de `vendeyapy.com` (Hostinger) del proyecto de PRUEBA (`vpw-staging`) al real (`vpw-prod-dd6ff`), verificada end-to-end (programas FASE-4-DOMINIO-VERIFY / RESTORE-1 / CLOSE-1).

**Evidencia final (2026-07-13 — API de Hosting + smoke HTTPS + navegador):**
- DNS autoritativo (Hostinger, apollo/athena.dns-parking.com): A `@` → `199.36.158.100` · TXT `@` → `hosting-site=vpw-prod-dd6ff` · CNAME `www` → `vpw-prod-dd6ff.web.app`. Propagado también en 8.8.8.8 y 1.1.1.1; sin referencias restantes a staging.
- `vendeyapy.com`: `OWNERSHIP_ACTIVE` + `HOST_ACTIVE` + `CERT_ACTIVE`; HTTPS 200 sirviendo el panel de producción (bundle con projectId `vpw-prod-dd6ff`, sin emuladores activados).
- `www.vendeyapy.com`: `OWNERSHIP_ACTIVE` + `HOST_ACTIVE` + `CERT_ACTIVE`; redirect 301 → `https://vendeyapy.com`.
- `https://vendeyapy.com/login` y `https://vpw-prod-dd6ff.web.app` responden 200.
- `vendeyapy.com` y `www.vendeyapy.com` están en `authorizedDomains` de Firebase Auth de prod; `WEB_BASE_URL` en `apps/functions/.env.vpw-prod-dd6ff` ya era `https://vendeyapy.com` — no hizo falta redeploy de functions.

**Incidente registrado (2026-07-13):** el owner borró por accidente los custom domains desde la consola. El apex quedó recreado correctamente desde la propia consola; `www` quedó soft-deleted (recuperable 30 días) y se restauró con la operación oficial `customDomains.undelete`. No hubo deploy ni cambios adicionales de DNS.

### FASE 5 — OPERACIÓN ⏳ PENDIENTE (siguiente después de la evidencia de F3)
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
- **Costo IA**: los turnos determinísticos son gratis; un turno del sales agent cuesta ~3.900 tokens promedio (hasta ~7.700) porque cada llamada re-envía system+tools+historial+fichas y el loop de tools re-factura el input (sin prompt caching todavía). Costo real observado: ~US$1,16 por millón de tokens.
- **Incidente de cupo de IA (2026-07-15, MITIGADO)**: el tenant `arfagi` agotó el cupo mensual — 251.398 tokens usados contra el límite anterior de 250.000 (plan growth). Auditoría completa: **65 llamadas 100% atribuidas** (todas `whatsapp_sales_agent` desde WhatsApp real de los números del owner — smokes de desarrollo + operación), **sin doble conteo confirmado**, consumo dominado por input/contexto (96%). Al agotarse, la degradación era **determinística y silenciosa**: el cliente recibía respuestas de reglas (fallback genérico) sin aviso al owner — **mitigado estructuralmente el 2026-07-16 por AI-FALLBACK-HONESTO-1** (ver §3): con cupo agotado, las consultas que necesitan IA ahora derivan a un humano con aviso en la campana. **Restauración**: `plans/growth.limits.maxAiTokensPerMonth` 250.000 → **1.500.000** (única mutación, con precondición y updateMask; contador y período PRESERVADOS — nunca se borra consumo). Servicio restaurado y verificado con smoke live. **Próximo reset: 01-ago-2026** (mes calendario UTC, job `resetUsageMonthly`).

## 6. PRIORIDADES (en orden)

1. **Evidencia de FASE 3**: primera conversación de número externo → verificación read-only completa (§4-FASE 3). Las pruebas hechas hasta ahora salieron de números del owner: la fase NO está completa.
2. **FASE 5 completa** (runbook + backups + alertas + docs al día) — programa estándar, sin deploy de código previsto.
3. **Programas pendientes ya identificados** (AI-FALLBACK-HONESTO-1 CERRADO — ver §3; el resto sigue): **COVERAGE-1 — PRIORITARIO** (gate de ubicación/cobertura con handoff; la razón `coverage_review` ya está reservada en el servicio canónico. Hallazgo real del smoke 2026-07-16: ante "¿hacen envíos al interior del país?" la IA afirmó cobertura "al interior del país" cuando la FAQ configurada solo dice "hacemos envíos, coordinamos al confirmar" SIN zonas — la extensión geográfica fue inferencia sin configuración verificada; no afirmó precio ni plazos) · **AI-QUOTA-ALERTS-1** (campana 70/85/95/100% + aviso al bloquear) · **AI-PROMPT-CACHING-1** (cache_control en system+tools + contar cache tokens) · **microprograma de cortesía determinística** (hallazgo del smoke: "Gracias" consumió un turno de IA de ~3.4k tokens — la cortesía pura debería responderse por reglas; con cupo agotado NO deriva gracias al guard `esConsultaDerivable`, es solo costo) · **higiene de logs** (el `customerId` completo — que en este modelo ES el teléfono — viaja como campo de correlación en la metadata estructurada de logs; el TEXTO de los logs está limpio; preexistente, enmascararlo en un microprograma) · **AI-USAGE-ATTRIBUTION-1** (origen/customerId en aiRequests + marcar/eximir simulador y test cases) · **AI-GATE-RESERVA-1** (estimación realista o reserva transaccional) · **Meta Catalog Live** (el "norte" — mismo ítem que en FASE 6/backlog; requiere Advanced Access) · **campana para futuros usuarios con rol SELLER puro** (hoy SIN impacto: el vendedor configurado actual es TENANT_OWNER y ve todo; el staff ve la bandeja de /conversations con no-leídos, pero la campana de notificaciones requiere rules + gate de UI en un programa posterior) · **microajuste conversacional**: comparaciones contextuales ("¿ambas son dulces?") hoy caen al listado por reglas en vez de responderse, y las comparaciones de la IA deben citar la marca de CADA producto por dato. Además hay un pedido reciente en **PENDING_VERIFICATION** esperando que el owner verifique la transferencia y confirme el pago en el panel (no confirmar sin verificar).
4. **Criterio de "terminado" del proyecto**: una persona externa completa el ciclo entero sin intervención técnica — escribe al +595 986 440752 → el bot recomienda con ficha (honesto en "¿sirve para X?") → carrito → "pagar" crea la orden → foto del comprobante → el vendedor la VE en el panel desde `vendeyapy.com` → confirma el pago → venta registrada con ganancia. Verificación read-only en cada paso + registro público cerrado + backup semanal documentado.
5. Después de eso: FASE 6 solo a pedido del owner.
