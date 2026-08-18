# HANDOFF — Estado del proyecto y prioridades para Claude Code

> **INSTRUCCIONES PARA CLAUDE CODE**: este documento es para VOS, el agente. Leelo completo al
> iniciar sesión antes de tocar nada. Resume el estado real del proyecto al **2026-07-31**,
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
- **COVERAGE-GUARD-1 — guard determinístico de afirmaciones logísticas** (commit `1497b40`, EN PROD 2026-07-16, cerrado de punta a punta): interceptor PURO en el motor, ANTES de la IA (`conversation/coverageGuard.ts`), para consultas de **cobertura de envío, zonas, costo y plazo** ("¿llegan a X?", "¿envían al interior?", "¿cuánto cuesta/tarda el envío?" y formulaciones coloquiales). Responde una **frase segura fija** que NO afirma cobertura/costo/plazo e indica que el equipo los confirma según la ubicación — el pase a humano solo si el cliente lo pide (HANDOFF-2, sin handoff automático). **Regla secundaria en el prompt** ("ENVÍOS Y COBERTURA"): jamás extrapolar la FAQ genérica de envíos a cobertura geográfica ni inventar costo/plazo. **Exclusiones** (review adversarial de 12 hallazgos, 11 corregidos; el aceptado: una consulta de PLAZO durante `AWAITING_PAYMENT` recibe la respuesta segura pre-venta — honesta aunque mal enmarcada; lo resuelve COVERAGE-1): checkout/pago gana siempre ("¿me mandan el QR para pagar?" jamás se intercepta), seguimiento de pedido existente, comprobantes, pedir fotos/imágenes/link, retiro en local, "cobertura" de maquillaje, performance de producto, cita del claim de un anuncio con intención de compra; en takeover el bot ya estaba mudo. `pendingCart` se limpia (un "sí" posterior no agrega la oferta vieja). Es la **mitigación inmediata** del hallazgo del smoke de AI-FALLBACK mientras se construye COVERAGE-1; lo que escape del detector cae a la IA con la regla del prompt como segunda línea. **Deploy**: selector mínimo de 4 funciones (`onWebhookInbox`, `simulateAgentMessage`, `agentTestCaseRun`, `devMessage`); cero Hosting/Rules/indexes/Storage; cero deletes/recreates; `.env` (hash verificado pre/post) y registro cerrado preservados. **Smoke productivo aprobado**: "¿hacen envíos al interior del país?" y "¿llegan a Encarnación?" → respuesta segura EXACTA en ambos, cero llamadas/tokens de IA (contador idéntico), cero handoffs/notificaciones, carrito/órdenes/pagos intactos, ningún dato bancario, envío live y 0 errores en logs (cliente enmascarado en el log nuevo).
- **[HISTÓRICO — superado por la reactivación del 2026-07-25] COVERAGE (1B/1C/1D + HARDEN + KILL-SWITCH + OFF-INERTE) — gate de cobertura con aprobación manual, desplegado entonces con flag apagado** (commit `0326784`, EN PROD 2026-07-18; **cobertura APAGADA para clientes**): con `config/checkout.coverage` (`enabled` + `activationId` válidos), "pagar" NO crea orden ni muestra banco hasta que un humano aprueba la cobertura de la ubicación. **Captura** de ubicación nativa de WhatsApp y de dirección escrita (la ubicación exacta vive SOLO en `coverageRequests`; el historial recibe un placeholder redactado; jamás a logs/IA/notificaciones). **Revisión humana en el panel**: aprobar / rechazar / solicitar más información (callables con permisos OWNER/MANAGER y SELLER solo su asignado; PLATFORM_ADMIN solo lectura). **Reanudación idempotente** tras la decisión: **orden y banco solo DESPUÉS de aprobación**, orden única por `checkoutAttemptId`, outbox de mensajería at-most-once. **Comprobante/pago manual preservados** (HANDOFF-2 / HUMAN-HANDOFF-1). **Expiración** (24 h default) + **purga** de coordenadas/dirección a 30 días (mantenimiento diario 03:30 America/Asuncion). **Kill-switch atómico**: contrato `enabled + activationId` fail-closed; el flag se re-lee DENTRO de cada transacción y ANTES de cada envío físico → el apagado de emergencia frena todo lo que aún no salió a Meta; **las activaciones antiguas quedan INERTES** (un `activationId` nuevo cancela los jobs viejos sin efectos, sin borrarlos). **Ubicación nativa con flag OFF = 100% inerte** (comportamiento heredado pre-Coverage: se ignora en silencio, sin placeholder/reply/registro; el inbox conserva solo la redacción `payload.location=null`). **Deploy 2026-07-18** (paquete `0326784`, sin `--force`): índice **13→14** (exactamente **1 CREATE** `coverageRequests status/expiresAt`, **cero DELETE**) → READY; **15 Functions actualizadas + 7 creadas** (`coverageApprove/Reject/RequestInfo/FlowState`, `onCoverageResumeJob`, `coverageMaintenanceDaily`, `devRunCoverageMaintenance`), consumidor `onWebhookInbox` desplegado PRIMERO; cero deletes/recreates; **Rules y Hosting** desplegados; IAM/Eventarc/Scheduler provistos automáticamente (sin paso manual); `.env` con hash intacto; registro público cerrado; WhatsApp `live`; **cobertura sigue AUSENTE/OFF para arfagi y credipower** (cero `activationId`, cero requests/jobs/outbox/notificaciones). **Smoke flag-OFF aprobado (2026-07-18)**: saludo normal; consulta de envíos → interceptada por el Coverage Guard con la frase segura (no afirma cobertura, `in`/`out` en el mismo segundo, **cero IA para el tester**); cero Coverage requests/jobs/outbox/notificaciones; sesión del tester en IDLE; órdenes intactas; pedido en PENDING_VERIFICATION intacto sin auto-pago. **Aclaración honesta**: el delta de cupo IA observado en la ventana correspondió a **tráfico live concurrente de OTRO cliente** (1 turno `whatsapp_sales_agent`), NO al tester ni al deploy — el gap conocido de atribución (`customerId:null` en `aiRequests`) impide asociarlo por id, pero el historial del tester (respuestas determinísticas) y sus **0 `aiRequests`** lo confirman. **Estado: infraestructura de Coverage EN PRODUCCIÓN; Coverage para clientes APAGADO.** NO se declara la fase funcionalmente completa hasta **activar** (con `activationId` nuevo) y **aprobar el E2E real** (ubicación → revisión → aprobación/rechazo → retorno del bot). **Deudas no bloqueantes**: `NEXT_PUBLIC_META_CONFIG_ID` y `NEXT_PUBLIC_SUPPORT_WHATSAPP` quedaron sin configurar en el build de hosting actual (estado grácil documentado en `apps/web/.env.production.example`; **verificar las vars públicas de Meta antes de Meta Catalog Live / onboarding**); warnings preexistentes de runtime Node 20 (decomisiona 2026-10-30) y firebase-functions 4.9.0; **AI-USAGE-ATTRIBUTION-1** pendiente.
- **[HISTÓRICO — el estado flag-OFF fue superado por la reactivación del 2026-07-25] SHIPPING-CHAT (paquete completo: parser determinístico compartido + preview 2B + saga backend 3C + HARDEN-1/2/3/4 + integración panel 4B + HARDEN-1/2 web) — DESPLEGADO EN PRODUCCIÓN (entonces con Coverage apagado)** (commit `5f8ccbc`, deploy 2026-07-24): cotización de envío confirmada desde la revisión de cobertura (ADR-0011) — la IA jamás decide dinero; preview con confirmación explícita; saga TX-A→claim→Meta→TX-C con el outbox como única fuente de verdad; recuperación durable (pointer + fase derivada) y reconciliación humana de envíos `unknown`; sweep anti-inanición; **HARDEN-4 cerró el `sending` varado por crash duro (el sweep lo normaliza a unknown con campana idempotente) y los workers zombis (settlement con ownership por generación `attempts`: un zombi jamás pisa estado ni produce un segundo envío físico)**. Integración completa en /conversations: preview, chips de fase, resolución manual, gate del composer espejo del server, aislamiento por intento/conversación y evidencia financiera congelada. **Auditorías 4C + delta aprobadas sin CRÍTICO/ALTO/MEDIO.** **Deploy 2026-07-24** (sin `--force`): índice 14→15 (exactamente **1 CREATE** `coverageMessageOutbox action/status/stuckNotifiedAt/updatedAt`, **cero DELETE**) → 15/15 READY; **15 Functions UPDATE + 3 CREATE** (`coverageQuoteAndApprove`, `coverageQuoteResolveUnknown`, `coverageQuoteAttemptState`), consumidores (`onWebhookInbox`, `onCoverageResumeJob`) PRIMERO; **92/92 Functions ACTIVE**; cero deletes/recreates; **Hosting desplegado** (UI de cotización verificada en el chunk de conversaciones; registro sigue "por invitación"); **Rules NO desplegadas** (sin cambios); hash de `.env.vpw-prod-dd6ff` preservado pre/post; registro cerrado; WhatsApp `live`. **Smoke flag-OFF aprobado (2026-07-24)**: saludo normal determinístico; consulta de envíos respondida por el Coverage Guard con la frase segura (no promete cobertura/costo/plazo); **cero IA** (tokens idénticos); **cero documentos Coverage**; cero pedidos/pagos/notificaciones nuevos; carrito del tester intacto; logs sin errores. **Estado real: infraestructura Shipping Chat EN PRODUCCIÓN; Coverage AUSENTE/OFF en arfagi y credipower (cero activationId); la funcionalidad completa AÚN NO está validada con Coverage activo.** La activación y el E2E se completaron el 2026-07-25 (ver bullet GO-LIVE + PURGE-FIX-1). credipower sigue diferido e intocable. FASE 3 (número externo) sigue pendiente — este smoke del owner no la completa. Meta Catalog Live sigue en backlog posterior.
- **COVERAGE GO-LIVE + PURGE-FIX-1 — E2E REAL VALIDADO Y COVERAGE REACTIVADO SOLO PARA ARFAGI** (fix `eb28365`, deploy y E2E 2026-07-25): **el E2E de Coverage/Shipping Chat — hasta comprobante y cancelación manual, sin venta pagada — quedó VALIDADO en producción** con el tester interno reutilizado (número del owner, no publicado): checkout gateado (el pedido CANCELLED previo no se reutilizó) → ubicación (privacidad verificada: coordenadas SOLO en el request, placeholder redactado, campana sin PII) → rechazo con nota interna jamás filtrada → reintento con solicitud nueva → cotización ₲30.000 (renovación segura de huella en el primer intento) → mensaje canónico ÚNICO con wamid real → aprobación → **pedido único ₲280.000** (envío separado del subtotal; la ganancia jamás incluye el envío) → instrucciones bancarias con el total con envío UNA vez → comprobante a Storage con derivación al vendedor → **pedido de prueba cancelado manualmente sin confirmar el pago (no hubo venta pagada; cero PAID en todo el E2E; cero IA)**. **FASE 3 con número externo sigue PENDIENTE — este E2E no la completa.** **Gap de privacidad corregido (PURGE-FIX-1)**: las decisiones terminales (aprobación y rechazo, incluida la aprobación autoritativa de la saga de cotización) ahora programan la purga a 30 días (elimina coordenadas exactas y nombre del lugar; la dirección textual NO la elimina este maintenance) EN LA MISMA transacción — antes solo expiración/cancelación lo hacían; los reintentos idempotentes jamás reinician la fecha; una dirección textual (sin coordenadas) queda sin purga por diseño. Verificación: batería completa en verde + E2E review 36/36 · resume 28/28 · killswitch 23/23 · saga 81/81 (con checks nuevos de purga) + 2 revisores adversariales APROBADO. **Deploy**: selector mínimo de 4 callables (`coverageApprove`, `coverageReject`, `coverageQuoteAndApprove`, `coverageQuoteResolveUnknown`) — 4 updates / 0 create / 0 delete; cero Hosting/Rules/índices (las 3 funciones read-only del mismo archivo quedaron excluidas a propósito: comportamiento idéntico). **Backfill**: los 2 requests históricos del E2E (coordenadas presentes, purga ausente) recibieron `coordinatesPurgeAt = decisión + 30 días` con updateMask y precondición por documento (gate "exactamente 2" verificado). **Coverage REACTIVADO exclusivamente en arfagi** con un activationId NUEVO y opaco (el anterior queda como histórico y JAMÁS se reutiliza), política `required` con `maxChargeGs ₲200.000` y expiración 24 h; **credipower sigue apagado e intocable**. Kill-switch vigente: apagar = mutación única de `coverage.enabled=false` releyendo un updateTime fresco.
- **META CATALOG — SYNC REAL + RECONCILIACIÓN + IMPORTACIÓN + OUTBOX (estado vigente 2026-07-30)** (commits `1d2bad5` sync real, `141c4ab` reconciliación, `50793bc` outbox completo, `fbb7aab` preview binding y **`6cfc464` onboarding genérico + calidad — TODOS desplegados**; **PRIMERA SINCRONIZACIÓN REAL COMPLETADA el 2026-07-28: el canary de Odyssey — ver bullet CANARY LIVE abajo — con exactamente 1 `items_batch` en toda la historia**). **⚠️ LO DESPLEGADO EN PRODUCCIÓN HOY ES `d542cda`** (modelo de propiedad por campos del 2026-07-31 — ver el bullet del release más abajo). Los deploys previos de este bloque fueron `50793bc` (outbox dry-run inerte) y `fbb7aab` (preview binding) el 2026-07-28, y `6cfc464` (onboarding genérico + calidad) el 2026-07-29; los tres con smoke humano aprobado — ver bullets DEPLOY DRY-RUN, PREVIEW-BINDING y DEPLOY ONBOARDING abajo:
  - **Acceso a Meta desbloqueado**: token permanente de system user (SYSTEM_USER, app `1739140590442740`) con `catalog_management` + los dos de WhatsApp, cargado por el formulario cifrado. **`business_management` NO está presente y NO es bloqueante**: solo limita el descubrimiento/administración de assets a nivel Business; VendeyaPy opera con el `catalogId` autoritativo. Catálogo productivo: **`Arfagi_Catalogo_Perfumes`** (id `1032991642570797`), vinculado al WABA `3025069907696663`. El catálogo alternativo "WhatsApp Product Catalog" NO se usa ni se toca.
  - **Config de arfagi**: `config/meta.catalogSync = { enabled:true, mode:'dry_run', catalogId, sourceOfTruth:'vendeyapy' }`. **credipower sin config (fail-closed).** `mode:'live'` se ejecutó UNA sola vez (canary Odyssey 2026-07-28, con exactamente 1 `items_batch`) y volvió a `dry_run` en el mismo cierre.
  - **Contrato fail-closed**: SOLO participan del plan de sync los productos con `syncToMeta === true` **y** `stockPendingReview !== true`. Todo lo demás queda fuera por completo: sin create, sin update y **sin disable** — es lo que impide que importar el catálogo apague los artículos vivos del negocio. El apply ya NO enciende `syncToMeta` solo: el opt-in es una acción administrativa explícita (`metaCatalogSetSyncEnabled`, con gates y confirmación del diff real).
  - **Identidad**: `Product.metaRetailerId` (identidad remota) separado de `inventory.sku` (interno, jamás se altera para Meta) y de `metaProductItemId` (id opaco de Meta). Matching por vínculo confirmado; SKU solo como fallback. Unicidad garantizada por lock transaccional (`metaRetailerLocks`).
  - **Mapping confirmado en producción**: **Armaf Odyssey Mega ↔ `ARM-744646-5202`**, hoy con `syncToMeta=true` (único opt-in vigente tras el canary). **El precio autoritativo LOCAL es ₲250.000.** El canary del 2026-07-28 lo llevó a Meta, pero **el feed diario del sitio lo revirtió a ₲130.000 el 2026-07-30** (ver bullet CONFLICTO DE FUENTE DE VERDAD). Costo privado ₲200.000, SKU y estado ACTIVE intactos.
  - **Supremacy Not Only Intense**: NO es el "Supremacy Collector's Edition" de Meta (`AFN-745089-0432`) — decisión del owner. Sigue **sin vínculo** y es candidato a crearse en Meta más adelante. El Collector's Edition quedó fuera de la importación curada (excluido por decisión explícita en su momento; **la importación genérica del 2026-07-30 sí lo trajo como borrador INACTIVE — ver el bullet de IMPORTACIÓN GENÉRICA: queda pendiente de revisión humana**).
  - **Importación inicial (META-CATALOG-IMPORT-CLEAN-BATCH-1, 2026-07-27)**: **30 artículos importados** — solo los "importables directos" (sin observaciones de calidad) y con **categoría inequívoca** derivada de `product_type` ("Perfume" → categoría `perfumes`). Todos quedaron **INACTIVE**, `syncToMeta=false`, `stockPendingReview=true`, **sin `productFinancials` (costo desconocido, no 0)**, sin stock inventado (`trackStock:false`), con precio público de Meta en PYG e id determinístico `meta_<retailerId>` (idempotente). **Invisibles para el bot y para el checkout** (`searchCatalog`/`findProductByName` exigen ACTIVE + stock; `getProductById` filtra ACTIVE; `createPendingOrder` revalida vendibilidad). Auditoría `meta.catalog_items_imported` con actor y conteo.
  - **Grupos PENDIENTES de revisión humana (102 artículos sin vincular)**: 67 con **nombre genérico** (el nombre es solo la marca; el perfume real está en la descripción — hay que renombrarlos antes de que el bot pueda distinguirlos), 13 **duplicados probables** (6 grupos: Gabriela Sabatini, Acqua di Gio, Le Male Elixir, Queen of Arabia Kit, Sweet Tooth ×3, Britney/Fantasy), 26 con **incoherencia nombre↔descripción**, 1 **sin marca** y 1 **sin stock** (`ALO-402927-4298`), 1 **sin categoría inequívoca** (`VIC-029008-4271`, tipo "Colonia" sin categoría interna equivalente) y 1 **excluido por decisión** (`AFN-745089-0432`).
  - **Contrato de ESCRITURA corregido y endurecido (META-CATALOG-OUTBOUND-CONTRACT-1 `d488c39` + HARDEN-1, ADR-0012 — desplegado el 2026-07-28 dentro de `50793bc`)**: el serializador emitía los nombres del contrato de **lectura** (`name`, `image_url`, `url`) dentro de un request de **escritura** (que exige `title`, `image`, `link`), ponía la identidad como hermano de `data` en vez de `data.id`, mandaba todo como UPDATE y no declaraba `allow_upsert`. Como el camino `live` nunca corrió contra Meta y el fake aceptaba cualquier forma, el defecto sobrevivió a toda la batería y a dos revisiones adversariales. Ahora: módulo `meta/catalogOutbound.ts` con builders separados **CREATE / UPDATE parcial / DISABLE mínimo**, `allow_upsert:false` explícito, **una sola derivación** de cada campo público compartida entre el diff y el envío, y un validador (`assertItemsBatchBody`) que corre **también en el cliente HTTP real**, no solo en el fake. HARDEN-1 agregó: **identidad EXACTA — truncar está prohibido** (>100 caracteres ⇒ `identity_too_long`, jamás se toca el `metaRetailerId` persistido), **DELETE no representable** (fuera del tipo y rechazado en runtime), **URL fail-closed y canónica** (`canonicalHttpsUrl` única, en el serializador, el validador y el diff — una URL que Meta normaliza ya no genera un UPDATE perpetuo), **descripción que no se inventa** (sin fallback al título), **aislamiento por producto** (un request inválido excluye solo a ese producto en vez de tumbar el chunk y todos los siguientes), **gate de habilitación alineado con el planificador** (no promete crear lo que el plan va a bloquear), **clave de lock inyectiva** (verificado read-only contra producción: no-op para los 30 importados y el lock existente) y `productUrl` **editable desde el panel**. Batería completa en verde + E2E de emulador **97/97**. Cero `items_batch` hasta el canary del 2026-07-28 (el único de la historia — ver bullet CANARY LIVE). *(Estado "SIN DEPLOY" superado: todo esto se desplegó el 2026-07-28 dentro de `50793bc` — ver bullet DEPLOY DRY-RUN.)*
  - **Outbox persistido de escrituras (META-CATALOG-OUTBOX-1, ADR-0013, DESPLEGADO 2026-07-28)**: `catalogSyncApply` **dejó de escribir en Meta**. Confirmar el plan crea un **job persistido por acción** en `tenants/{t}/metaCatalogOutboxJobs/{jobId}` y devuelve `status:'queued'` (con `queuedCount`/`deduplicatedCount`/`blockedCount`) — **`appliedCount` y `lastSuccessfulSyncAt` ya no se escriben al encolar**. Un scheduler cada 5 min reclama los jobs con **claim transaccional + lease de 120 s + generación inmutable (`attempts`) + settlement con ownership** (`settleIfOwner`, patrón heredado de la saga de cotización), revalida **dentro de la transacción** config/tenant/catálogo/`syncToMeta`/`stockPendingReview`/snapshot del producto, envía UN lote acotado por cantidad (100) y bytes (900 KB), y **persiste el handle antes de cualquier seguimiento**. **Aceptación ≠ éxito**: la confirmación es una fase aparte que relee el catálogo con **verificación de tres estados** (`confirmed_equal`/`confirmed_different`/**`unverifiable`**) y solo declara `succeeded` con evidencia de TODOS los campos que el patch mandó. **La ambigüedad (timeout/5xx tras aceptar) jamás se reintenta a ciegas**: se mira el catálogo real y recién ahí se decide (con `allow_upsert:false` un CREATE repetido fallaría por id duplicado). El patch viaja **congelado** y un producto editado tras el preview deja el job `stale`. Estados visibles para el vendedor: **En cola · Procesando · Confirmado · Requiere revisión · Error** — `Confirmado` significa confirmado POR Meta, nunca "lo mandamos". Colección **cerrada al cliente** en `firestore.rules`.
  - **Endurecimiento (META-CATALOG-OUTBOX-HARDEN-1, mismo ADR-0013, DESPLEGADO 2026-07-28)**: (1) **historia inmutable** — se separó la `intentKey` determinística (que deduplica el trabajo ACTIVO mediante un puntero transaccional en `metaCatalogOutboxIntents`) del `jobId` por CICLO (`{intentKey}_c000001`), que **nunca se reescribe una vez terminal**; antes se reabría el job terminal con `tx.set`, borrando la evidencia del ciclo anterior, y un `succeeded` viejo impedía para siempre repetir el mismo cambio (el ciclo A→B→A de precio o de stock no llegaba nunca a Meta). Los sync logs también quedaron únicos por ciclo. (2) **Fencing del estado visible**: el producto guarda `metaSyncCurrentJobId` y toda proyección es transaccional y solo si ese job sigue vigente — un job viejo cierra su historia pero no pisa el estado, el error, el itemId ni el `metaLastSyncAt` del ciclo actual. (3) **Revalidación transaccional completa inmediatamente antes del POST** (ownership, estado del job, tenant, catálogo, existencia del producto, `syncToMeta`, `stockPendingReview` y snapshot), con exclusión individual del lote; queda documentada como límite inevitable solo la ventana de milisegundos entre ese commit y el POST externo. (4) **Recuperación humana real**: callables `metaCatalogOutboxIncidents` / `Reconcile` / `Discard` para OWNER/PLATFORM_ADMIN aislados por tenant, con CTA "Revisar sincronización" en Catálogo — la reconciliación **mira Meta primero** (igual ⇒ confirmado; distinto ⇒ ciclo nuevo; sin evidencia ⇒ sigue pendiente) y **jamás ofrece reenviar a ciegas**. (5) **Presupuesto de llamadas**: el cliente cuenta cada request (incluidas las páginas de `listItems`), la confirmación tiene techo por corrida y procesa en orden de antigüedad; lo que no entra queda intacto para la corrida siguiente. **No se afirma ningún límite de Meta sin respaldo: el techo es una decisión propia de costo.** (6) `verify-d4.mjs` se actualizó al contrato vigente (fallaba 1/5 desde `1d2bad5` porque probaba la sync demo eliminada) y ahora pasa 7/7.
  - **Release candidate (META-CATALOG-OUTBOX-HARDEN-2, mismo ADR-0013 §19, DESPLEGADO 2026-07-28)**: cerró las carreras restantes. **CAS en todas las acciones humanas**: `metaCatalogOutboxReconcile`/`Discard` releen el job dentro de la transacción; perder la carrera responde `nothing_to_do` con el estado vigente; una reconciliación jamás resucita un descartado y un descarte jamás pisa un `succeeded`/`failed` ajeno (lo preserva y solo marca `reviewedAt`). **Cierre terminal + sync log ATÓMICOS** (`cerrarTerminalConLog`, `tx.create` que no sobrescribe): nunca un `succeeded`/`failed` sin historia — `cancelled`/`stale` no llevan log, documentado. **Contadores honestos**: solo cuentan transiciones aplicadas. **Tope de consultas por INTENTOS** (`MAX_BATCH_STATUS_PER_RUN=10`, consumido antes de llamar): una API de estado caída no permite intentar la cola entera; reporte separado `handlesAttempted`/`handlesAnswered`/`deferredHandles`/`metaCalls` (HTTP reales con retries y páginas). **Bandeja sin ocultamiento**: campo persistido `attentionRequired` recalculado en cada transición + query `where(attentionRequired==true).orderBy(updatedAt desc).limit(N+1)` + `truncated` honesto con aviso accesible en el panel + **índice nuevo `metaCatalogOutboxJobs (attentionRequired ASC, updatedAt DESC)`**. **Fencing también en los errores de validación** (no pisan el ciclo vigente) y estado visible del producto escrito en la MISMA tx que crea el job.
  - **HARDEN-2 (release candidate) además cerró la auditoría final del delta completo `9495602..HEAD`** (37 hallazgos, 28 confirmados, todos los ALTO/MEDIO resueltos): el sweep escala los `submitted` congelados >1h a revisión humana aunque Meta no responda (la evidencia inaccesible ya no congela jobs ni deja que handles muertos produzcan inanición); la verificación de precio usa la MISMA regla de decimales que el planificador (adiós al split-brain "plan sin cambios / verificación distinta"); el settle ambiguo estampa `submittedAt` (la ventana de gracia ahora protege el caso para el que existe); un `submitted` fresco con remoto distinto NO escala por impaciencia (queda en reconciliación con reintento acotado); los cierres terminales LIBERAN la vigencia del producto (la convergencia del planificador vuelve a corregir estados visibles sin encolar trabajo); contadores del drain/reconcile solo cuentan settles PROPIOS (incluye `catalog_mismatch`); `metaCalls` se reporta también cuando la API falla; discard de un `processing` con lease vencido advierte que el envío pudo haber salido; guard de formato en `jobId` y `timeoutSeconds: 240` en el scheduler.
  - **DEPLOY DRY-RUN (DEPLOY-META-CATALOG-OUTBOX-DRY-RUN-1, 2026-07-28) + SMOKE APROBADO**: `50793bc` desplegado a `vpw-prod-dd6ff` con la sync **inerte** (`mode:'dry_run'`, `syncToMeta=false` en los 33 productos). Etapas en orden: índices (15→17, los 2 del outbox READY) → rules (2 matches cerrados, deny verificado 403) → callables de recuperación (3 CREATE, gate `UNAUTHENTICATED` app-level verificado) → 11 Functions UPDATE del grafo auditado → scheduler `metaCatalogOutboxMaintenance` al final (cron `*/5`, America/Asuncion, timeout 240 s, sin invoker público; corridas 200 en silencio total = gate dry_run) → hosting. **96→100 Functions ACTIVE; `devRunMetaCatalogOutbox` AUSENTE de producción; cero deletes/recreates; hash `.env` intacto; sin `--force`.** **Smoke humano aprobado**: la diferencia 133→150 de "Solo en Meta" quedó explicada con conteo directo (`product_count`=**181**, paginación completa sin duplicados): **49 altas y 1 baja EXTERNAS** en el catálogo (Commerce Manager) entre el 27 y el 28 — cero defecto de conteo (el pipeline es byte-idéntico entre `141c4ab` y `50793bc`), reclamo de los 31 vinculados intacto, cero `items_batch`, outbox 0/0.
  - **Canary Odyssey PREPARADO (auditoría read-only 2026-07-28; EJECUTADO ese mismo día — ver bullet CANARY LIVE)**: simulación del plan con el código compilado real ⇒ habilitar SOLO Odyssey da **exactamente 1 acción `update`** sobre el item correcto (`27118097977868543`) con `changedFields [name, description, price, image_url, brand]`; la URL remota no se toca. **⚠️ Decisión de negocio previa**: el apply pisaría la ficha remota con la local (precio ₲130.000→₲250.000; nombre/descripción/imagen locales hoy más pobres que las remotas) — curar la ficha local ANTES de habilitar. Guion completo con criterios estrictos de aborto en la sesión del 2026-07-28. Rollback verificado: opt-out revalida pre-POST, `Discard` jamás pisa terminales, disable de terceros imposible sin opt-in.
  - **Vínculo apply↔preview (META-CATALOG-PREVIEW-BINDING-1, `fbb7aab`, ADR-0013 sección "Vínculo apply ↔ preview" — DESPLEGADO 2026-07-28 + SMOKE APROBADO)**: cierra el hueco #3 de la auditoría del canary — `catalogSyncApply` ya NO re-planifica a ciegas: **exige `{previewRunId, planHash}`** del dry_run aprobado, valida vigencia (**TTL 10 min**)/pertenencia (tenant por ruta, catálogo, MISMO actor)/estado, **replanifica y solo encola si la huella coincide EXACTAMENTE**; consumo transaccional anti-replay (dos applies concurrentes: exactamente uno encola); toda discrepancia ⇒ **`failed-precondition`** con outbox 0/0 y run doc auditado con ambas huellas. La huella incluye el **snapshot remoto crudo de cada item afectado** (la superficie que compara el diff): "Meta modificado" invalida el preview aunque el cambio no altere la acción ni el request (PB-95c). Panel: "Previsualizar cambios" y "Enviar 1 cambio a Meta (Producto)". Verificación: unit 19 + E2E PB-91..99c (**194/194** total) + batería completa en verde. **Deploy (DEPLOY-META-CATALOG-PREVIEW-BINDING-DRY-RUN-1, 2026-07-28): 3 Functions UPDATE por grafo auditado (`runTenantJob` + `simulateAgentMessage` DIRECTAS, `devSyncCatalogToMeta` incluida para no dejar compilado un apply pre-binding; scheduler y `refreshGrowthJobsDaily` excluidos con justificación) + Hosting; cero CREATE/DELETE, cero rules/índices, hash `.env` intacto. Smoke productivo APROBADO**: corrida `dry_run`/`planned` con **`planHash` persistido y NO consumido**, Crear/Actualizar/Deshabilitar/Bloqueados = 0, 33 productos sin opt-in excluidos, remoteOnly=150; cero applies, cero outbox, cero `items_batch`; **Meta sigue en 181 artículos**; config continúa `dry_run`. **Siguiente hito cumplido: el canary controlado de Odyssey se auditó y ejecutó el mismo 2026-07-28 — ver bullet CANARY LIVE.**
  - **Onboarding genérico + calidad de catálogo (META-CATALOG-GENERIC-ONBOARDING-QUALITY-1, ADR-0014 — DESPLEGADO 2026-07-29 dentro de `6cfc464`)**: capacidad genérica para importar y preparar catálogos de Meta de CUALQUIER tamaño y vertical. (1) **Importación paginada reanudable**: `listItemsPage` en el cliente (una página por llamada; `listItems` fail-closed intacto para planner/outbox), run persistido `metaCatalogImportRuns/{runId}` con cursor commiteado por página, contadores por desenlace (imported/alreadyLinked/alreadyImported/ambiguous/conflicted/skipped/unclassified), lease+puntero `metaCatalogImportState/current` (dos imports concurrentes ⇒ `already_running`), reintentos idempotentes por ítem (`ALREADY_EXISTS` = ya importado, jamás aborta la página), cursor inválido ⇒ reset contado, **producto+lock `metaRetailerLocks` en la MISMA transacción** (cierra el hueco de doble vínculo; backfill del lock para importados viejos), categoría desconocida ⇒ borrador «sin clasificar» con observación (no se pierde), jamás vínculo por nombre aproximado (ambiguo ⇒ humano). Callables `metaCatalogImportRun` (owner) / `metaCatalogImportStatus` (manager+). (2) **Calidad**: `products/quality.ts` puro — BLOCKING derivados de los MISMOS `syncEnableBlockers`/`createBlockers` (cero duplicación), WARNINGs (nombre genérico, duplicado probable, incoherencia, sin clasificar, deriva remota), fingerprints estables con firstSeen/lastSeen/resolvedAt y poda a 30 días, perfil por tenant (marca neutral `Product.brand` con fallback a `perfume.brand`; perfumería deja de ser requisito universal); recompute server-side en `productUpsert` (respuesta con resueltas/pendientes; ACTIVE con nombre/precio inválido rechazado) — el cliente no puede falsificar `quality` (whitelist + rules). (3) **Centro de calidad**: `metaCatalogQualitySummary` (tope 200 por severidad + truncated honesto), campana agregada idempotente `catalog-quality-{tenant}` con reapertura/autocierre, banner+filtros+badges accesibles, importador con progreso `aria-live` reanudable, editor por secciones (públicos/internos/vertical condicional), selección masiva SOLO de elegibles con excluidos agrupados (sin aplicar nada). (4) **Fix de vendibilidad** en `searchCatalog` (`!trackStock || stock > 0`, consistente con el resto). Verificación (tras HARDEN-1): batería completa en verde (**1236 functions + 213 shared + 245 web**), E2E `verify-catalog-onboarding.mjs` **119/119** (×2 en 118 pre-fixes y ×1 final con el check nuevo del guard monotónico) (incluye 600 artículos en 6 páginas, carrera real de imports, fencing generacional con zombi real, mantenimiento preview/apply/conflicto, aislamiento entre tenants con retailerIds iguales, roles, rules cerradas, recorrido completo importar→resumen→corregir→habilitar con cero escrituras a Meta) + regresión `verify-meta-catalog` **194/194 ×2**.
  - **Endurecimiento (META-CATALOG-GENERIC-ONBOARDING-HARDEN-1, mismo ADR-0014 §4/4b/4c — DESPLEGADO 2026-07-29 dentro de `6cfc464`)**: (1) **default multi-vertical REAL** — sin `config/catalog.profile` (o con perfil inválido) el tenant es **genérico**: no se fabrica ficha `perfume`, la marca vive solo en `Product.brand` y las stopwords de perfumería salen del análisis; la política efectiva (`effectiveCatalogPolicy`) se propaga a TODO el pipeline (análisis remoto, matching, clasificación, quality, callables legacy); `perfumeria` es una plantilla que se activa SOLO por configuración explícita. **Gate del release: arfagi necesita `config/catalog.profile={vertical:'perfumeria'}` ANTES de desplegar las Functions** (mutación aprobada, acotada a ese campo). (2) **Fencing generacional del run de importación**: claim con `generation` inmutable en puntero+run; TODA escritura post-claim (producto+lock, drift, cursor/contadores, heartbeat verificado, cierre, liberación del puntero, campana) demuestra ownership transaccionalmente; un worker vencido responde `claim_lost` sin escribir NADA; cursor/contadores jamás retroceden. (3) **Locks en el camino legacy**: `metaCatalogImportItems` crea el lock por ítem y `confirmMapping` verifica transaccionalmente que ningún producto reclame ya el retailer_id. (4) **Operación de mantenimiento** `metaCatalogMaintenanceRun` (owner; preview por defecto, apply solo con `confirm:true`): backfill paginado/reanudable/idempotente de locks y `quality` para productos existentes — conflicto de identidad ⇒ reporte con ambos productIds, JAMÁS ganador automático; campos comerciales intactos; campana recalculada al final; **EJECUTADO en producción el 2026-07-29** (preview → revisión humana → apply con run NUEVO, jamás el del preview). (5) **Campana del manager**: la query real usa igualdades por categoría calcadas de las rules (jamás `where in`); manager recibe `catalog_quality` sin ampliar nada más. (6) **53 tests de panel** (loop de import que NO martilla ante cuota/error remoto, normalización del summary, selección masiva sin bloqueados, estados y accesibilidad) + 41 unit backend nuevos (fencing con zombi, mantenimiento, perfiles). **Este endurecimiento se desplegó junto al programa base el 2026-07-29 (ver bullet DEPLOY ONBOARDING).**
  - **DEPLOY ONBOARDING + CALIDAD EN DRY-RUN (DEPLOY-META-CATALOG-ONBOARDING-QUALITY-DRY-RUN-1, 2026-07-29) + MANTENIMIENTO Y SMOKE APROBADOS**: `6cfc464` desplegado en `vpw-prod-dd6ff` con la sincronización **inerte** (`mode:'dry_run'`; solo Odyssey con opt-in). Orden ejecutado: **(0) perfil explícito `tenants/arfagi/config/catalog` → `profile.vertical='perfumeria'`** (escritura única con `updateMask` del field path anidado y precondición `exists=false` — el doc `config/catalog` no existía —; `config/meta` con `updateTime` intacto — sin esto el default nuevo habría dejado a arfagi en `generic`) → **(1) 1 índice compuesto CREATE** `products (status ASC, quality.blocking ASC)` — 17→**18 índices, todos READY** (el "cero índices" de reportes previos era erróneo: el índice entró en `6cfc464`) → **(2) Rules**: 3 matches cerrados nuevos (`metaCatalogImportRuns`, `metaCatalogImportState`, `metaCatalogMaintenanceRuns` con `read, write: if false`) + la extensión tenant-scoped de `notifications` para que TENANT_MANAGER lea/marque leída SOLO `catalog_quality` (esa rule entró AHORA, no estaba desplegada); probes sin auth y cross-tenant: 403 → **(3) Functions: 5 CREATE** (`metaCatalogImportRun`, `metaCatalogImportStatus`, `metaCatalogQualitySummary`, `metaCatalogMaintenanceRun`, `metaCatalogMaintenanceStatus`) **+ 21 UPDATE** del grafo fresco, **100→105 ACTIVE**, cero DELETE/recreate, sin `--force`, `devRunMetaCatalogOutbox` AUSENTE, hash `.env` intacto, gate app-level verificado (`UNAUTHENTICATED` sin token en las 5 nuevas) → **(4) Hosting** (centro de calidad, importador, editor por secciones; cero referencias a emuladores; registro sigue por invitación). **Mantenimiento controlado**: `metaCatalogMaintenanceRun` en **preview** (cero escrituras de negocio, verificado con huella de `updateTime` de los 33 productos) y luego en **apply** autorizado — **30 locks creados + 1 preservado (Odyssey) = 31; 32 evaluaciones `quality`; 1 archivado omitido por diseño; 0 conflictos; 0 errores**; campos comerciales, mappings y opt-ins **con huella idéntica antes/después** (hash de los 33 productos sobre nombre, precio, moneda, estado, categoría, descripción, imágenes, stock, trackStock, sku, opt-in, ids de Meta, marca y stockPendingReview); una única notificación agregada `catalog-quality-arfagi` (31 con bloqueos, 0 advertencias). Desglose de calidad: 1 limpio (Odyssey), 31 con bloqueos (`not_active` ×30, `stock_pending_review` ×30, `product_url_missing` ×1), 1 sin evaluar (el archivado). Ambos runs se corrieron con cuentas técnicas efímeras autorizadas, eliminadas y verificadas inexistentes. **Smoke humano aprobado** (campana + CTA, centro de calidad con 31 bloqueos, filtros y detalle, editor por secciones cerrado sin guardar, importador cargado y NO ejecutado, selección masiva correctamente vacía). **Invariantes: `catalogSync.mode` sigue `dry_run`; cero imports, cero applies de catálogo NUEVOS (sigue el único histórico: el canary de Odyssey), cero jobs nuevos de outbox, cero `items_batch`; Meta seguía en 181 artículos y Odyssey remoto en ₲250.000 AL 2026-07-29 (el feed del sitio lo revirtió a ₲130.000 el 30-jul); pedidos (15) y pagos (0) en sus valores de baseline, Coverage/WhatsApp sin cambios de config, credipower intacto; 0 errores en logs.** **La importación genérica quedó disponible en producción pero NO se ejecutó ESE DÍA** (pulsar "Importar catálogo de Meta" crea productos reales en Firestore aunque Meta siga en dry_run, y requiere autorización productiva separada) — **se ejecutó el 2026-07-30 con autorización del owner: ver el bullet siguiente.**
  - **IMPORTACIÓN GENÉRICA EJECUTADA (META-CATALOG-GENERIC-IMPORT-ARFAGI-1, 2026-07-30) + SMOKE APROBADO**: se importaron a arfagi **los 150 artículos que existían SOLO en Meta** (snapshot congelado y revalidado antes de mutar: 150 retailerIds únicos, hash `522702da…`; decisión del owner: importar los 150 completos, incluidos 3 con exclusiones humanas previas). Un **único import run** `completed` (3 páginas — la tercera vacía lleva el cursor a null —, 181 procesados, 0 reinicios de cursor, `lastError` vacío, puntero liberado): **imported 150, alreadyImported 30, alreadyLinked 1, ambiguous 0, conflicted 0, skipped 0, unclassified 150**. Corrido por la callable productiva con cuenta técnica efímera autorizada, eliminada y verificada inexistente. **Estado del catálogo: 33→183 productos, 31→181 locks, 32→182 con `quality`, remoteOnly 150→0.** Los 150 nuevos nacieron **INACTIVE, `syncToMeta=false`, `stockPendingReview=true`, stock 0 sin `trackStock`, SIN categoría (neutral «sin clasificar»), sin `productFinancials`**, con id determinístico `meta_<lockKey(retailerId)>`, lock creado en la misma transacción, trazabilidad del item de Meta y `quality` al nacer (≥2 bloqueos) — invisibles para bot, carrito y checkout. Verificación: cada nuevo corresponde a un retailerId del snapshot sin repetir, cobertura total, cero productos fuera del snapshot, un lock por retailerId, cero mappings dobles, cero locks huérfanos, y los 33 previos con **huella comercial idéntica**. **Calidad (182 evaluados): 2 limpios, 180 con bloqueos, 1 archivado sin evaluar**; códigos abiertos: `not_active` 180, `stock_pending_review` 180, `category_missing` 150, `category_unclassified` 150, `name_description_mismatch` 33, `generic_name` 23, **`probable_duplicate` 18 (señalados, NINGUNO fusionado)**, `remote_drift` 1, `product_url_missing` 1, `brand_missing` 1. Una sola notificación agregada (180 con bloqueos, 151 con advertencias). **Los 3 casos con historia previa** (uno excluido por decisión, uno sin categoría inequívoca, uno sin stock) se importaron en estado seguro con 3 bloqueos cada uno y **quedan pendientes de revisión humana especial: no fueron archivados, activados ni eliminados**. Invariantes: `dry_run` intacto, **cero escrituras a Meta**, cero outbox/`items_batch` nuevos, un solo apply histórico, credipower sin config ni productos, pedidos 15 y pagos 0, Coverage y WhatsApp con `updateTime` sin cambios, 0 errores en logs. **Cero deploy y cero cambios de código.**
  - **[HISTÓRICO — RESUELTO por el release del 2026-07-31, ver el bullet del modelo de propiedad] ⚠️ CONFLICTO DE FUENTE DE VERDAD DESCUBIERTO (2026-07-30)**: el catálogo `Arfagi_Catalogo_Perfumes` tiene **un feed automático propio de arfagi** (`feed_count: 1`, creado 2026-07-14) que descarga **todos los días 03:33 America/Asuncion** un CSV desde el sitio del tenant (`api.arfagi.com/api/meta/catalog-feed.csv`) y **publica los 181 artículos** (subida del 2026-07-30: 181 detectados, 181 persistidos, 0 errores; la del 29-jul además registró `num_deleted_items: 1`). **Ese feed revirtió el canary**: Odyssey volvió de **₲250.000 a ₲130.000**, el precio que publica el sitio. El canary de VendeYaPy **sí funcionó** (Meta mostró ₲250.000 durante ~36 h, verificado varias veces) pero **fue sobrescrito** después. Evidencia de que no fue el sistema: cero jobs nuevos de outbox (el único sigue `succeeded` del 28-jul), cero `items_batch`, un solo apply histórico, `mode` en `dry_run` todo el tiempo. **Consecuencias**: (1) `sourceOfTruth:"vendeyapy"` **no refleja la autoridad efectiva** — hoy el dueño de facto del catálogo es el feed del sitio, y cualquier escritura nuestra vive como máximo hasta las 03:33 del día siguiente; (2) **Odyssey figura localmente `synced` (`metaLastSyncAt` 2026-07-28) aunque existe deriva remota real** — la detección de deriva solo corre para productos importados, no para los vinculados manualmente; (3) **el feed NO se desactivó ni modificó** (fuera del alcance de este programa; es decisión del owner). **RESUELTO el 2026-07-31**: arfagi quedó en `external_managed` con cero campos escribibles, así que las escrituras a Meta están bloqueadas POR CONSTRUCCIÓN (no existe patch posible) y la reconciliación SÍ cubre los vinculados a mano — Odyssey quedó `drifted_external`. `mode` permanece `dry_run`.
  - **Verificación de ESE programa (histórica; la cifra vigente está más arriba)**: batería completa en verde — 1107 functions + 213 shared + 182 web — y E2E `verify-meta-catalog` 174/174, dos corridas sobre emulador limpio, más `verify-d4` 7/7, `fase5c-catalog` 10/10 y `rules-catalog` 17/17. El E2E cubre doble confirmación concurrente, ciclo A→B→A con tres ejecuciones auditables, job viejo que no pisa la proyección nueva, opt-out entre el claim y el POST, crash antes/después de la aceptación, los cuatro desenlaces de la recuperación humana, **discard que gana la carrera a la reconciliación manual (hook `manual_pre_cas`), dos reconciliaciones manuales simultáneas (una transición y un log), manual vs automática (la que pierde no cuenta), descarte sobre succeeded preservado, 100 handles con la API de estado caída (10 intentos exactos, jobs intactos), 100+ revisados que no tapan una incidencia nueva, 101 abiertas ⇒ 100 + truncated, y confirmación inválida que no pisa el ciclo activo**, dos mantenimientos concurrentes, aislamiento entre tenants, `dry_run` sin claims ni POST y cero retry automático del POST. **Los DOS índices requeridos (`metaCatalogOutboxJobs (status, updatedAt)` y `(attentionRequired, updatedAt DESC)`) ya están CREADOS y READY en producción** (se crearon antes del scheduler, como exigía el orden del deploy 2026-07-28). El E2E creció después a **194/194** con los checks PB del preview binding.
  - **CANARY LIVE ODYSSEY — PRIMERA SINCRONIZACIÓN REAL EXITOSA (2026-07-28, aprobada por el owner)**: con la ficha local curada (nombre/descripción/imagen igualados al remoto; el precio autoritativo local quedó como única diferencia) y `syncToMeta=true` SOLO en Odyssey, se activó `mode:'live'` (mutación única con precondición), el owner previsualizó y envió desde el panel, y el ciclo completo del outbox corrió de punta a punta: **apply atado al preview (consumido UNA sola vez), 1 job `_c000001` → `submitted` en el drenaje de las 19:20Z (`reclamados:1 enviados:1`) → `succeeded` en la corrida de las 19:25Z tras releer el catálogo (`confirmados:1`)**. Resultado en Meta: **UPDATE exclusivamente de `price` — Odyssey ₲130.000 → ₲250.000**; nombre/descripción/imagen/availability/url del item INTACTOS; **181 artículos antes y después** (ni altas ni bajas); item de control sin tocar. Estado interno: exactamente **1 apply, 1 job (`succeeded`, intento 1), 1 sync log (id = jobId)** en toda la historia; intent liberado (activeJobId null, ciclo 1); producto `synced` con vigencia liberada y `metaLastSyncAt` sellado; **cero incidencias y cero errores**. Después del cierre, `catalogSync.mode` **volvió a `dry_run`** (mutación única con precondición; enabled/catalogId/mappings/tokens intactos). **Estado al cierre de ESE programa: `mode=dry_run`; Odyssey mantiene su opt-in y su `synced` local. ⚠️ Ese `synced` quedó DESACTUALIZADO el 2026-07-30: el feed del sitio revirtió el precio en Meta y la deriva no se detecta para productos vinculados manualmente (ver CONFLICTO DE FUENTE DE VERDAD). Cualquier nueva aplicación real requeriría volver a `live` con aprobación explícita del owner; desde el 2026-07-31 además sería INERTE, porque con `external_managed` y cero campos propios no existe patch posible.**
  - **Estado de Meta: 181 artículos; UNA escritura nuestra en toda la historia (el canary de Odyssey, UPDATE solo de `price`) — y el feed diario del sitio la REVIRTIÓ el 2026-07-30.** El catálogo creció EXTERNAMENTE de 133 a 181 (49 altas + 1 baja vía Commerce Manager entre el 27 y el 28 de julio; verificado con conteo directo y diff item por item — sin defecto de conteo); la plataforma jamás creó ni apagó un artículo. Falta: enriquecer los importados (hoy 180: costo y stock reales), revisar los grupos señalados por el centro de calidad. La fuente de verdad ya está resuelta (ADR-0015 desplegado); lo que falta es corregir el precio en el ORIGEN del feed (§6 prioridad 0). **FASE 3 con número externo sigue PENDIENTE.**

- **ADJUNTOS DE CONVERSACIÓN (imágenes y PDF) ✅ DESPLEGADO Y VALIDADO EN ARFAGI (2026-08-01/03, commit `30c1687`)** (ADR-0016, `WHATSAPP-MEDIA-SAFE-FOUNDATION-1` + `-RELEASE-HARDEN-1` + `DEPLOY-WHATSAPP-MEDIA-SAFE-ROLLOUT-1`):
  - **RELEASE EJECUTADO**: `30c1687` desplegado en `vpw-prod-dd6ff`. El rango real fueron **CUATRO** commits (`a9523ec` docs · `3939676` tooling de deploy · `12a899a` fundación · `30c1687` endurecimiento), no dos — el grafo se calculó sobre el rango completo. **Superficie exacta: 4 CREATE** (`attachmentGetViewUrl`, `attachmentMarkAsReceipt`, `attachmentUnmarkReceipt`, `attachmentRetentionMaintenance`) **+ 2 UPDATE** (`onWebhookInbox` rev 00028→00029 con 256Mi/60s → **512Mi/180s**; `metaWebhook` rev 00018→00019) **+ Firestore Rules + Storage Rules + Hosting**. Functions **111 → 115**, cero DELETE, cero recreates, **cero índices nuevos** (siguen 18/18 READY), schedulers 6 → 7 (`attachmentRetentionMaintenance`, `40 2 * * *` America/Asuncion, **invoker restringido al SA, no público**). `devRunMetaCatalogOutbox` sigue AUSENTE. Hash de `.env.vpw-prod-dd6ff` idéntico antes y después.
  - **Orden ejecutado** (consumidor antes que productor, por la asimetría de `payload.attachment` / `payload.image`): Rules → `onWebhookInbox` → las 3 callables → `metaWebhook` → scheduler → Hosting. Verificado en cada paso: 6 probes anónimas → 403, callables sin auth → **401 UNAUTHENTICATED** (rechazo de aplicación), HMAC de `metaWebhook` fail-closed (401 con firma inválida y sin firma), handshake 403, `dev*` en 404, bundle con `authDomain` productivo y **cero** localhost/staging/dev/demo, registro por invitación (0 inputs en `/register`).
  - **ROLLOUT ACTIVO SOLO EN ARFAGI**: `config/attachments.ingest.enabled = true` y `config/receiptGate.enabled = true`, ambos escritos como **booleano exacto**, cada uno con relectura previa, precondición fresca (`exists=false`) y `updateMask` exclusivo del field path. **`retention.purgeEnabled` sigue AUSENTE ⇒ la purga está APAGADA.** **credipower conserva los dos documentos AUSENTES y cero adjuntos.**
  - **VALIDADO CON SMOKES HUMANOS REALES EN PRODUCCIÓN** (no emulador): (1) **flags OFF** ⇒ inbound visible con marcador neutral, **una sola** respuesta honesta, cero Graph, cero Storage, cero documento, cero IA, cero mutación comercial (16/16); (2) **imagen y PDF genéricos** ⇒ guardados con **MIME verificado contra el declarado**, checksum sha256, paths opacos tenant-scoped sin teléfono/mediaId/nombre original, visor con URL firmada ≤10 min y **cero URLs firmadas persistidas**; (3) **silencio durante takeover** ⇒ una imagen llegada con el chat tomado no produjo **ni un solo** mensaje del bot (§12 verificado en producción); (4) **cadena completa del comprobante** ⇒ candidato automático por REGLA (`source=rule`, `by=null`) + **exactamente una** campana con id determinístico → marca humana (`source=human`, uid real) → pedido **`PENDING_VERIFICATION`** con auditoría `paymentConfirmed=false` → desmarcado → vuelta a `generic_media` y pedido a `PENDING_PAYMENT`, **con las DOS auditorías conservadas y el archivo intacto en Storage**. Pedido de prueba **CANCELLED sin pago**. **Cero PAID automático, cero pagos: 15 CANCELLED + 1 PAID (el histórico de julio) y `payments = 0` en todo el proyecto.** Cero errores en logs.
  - **La promesa y la señal son un solo hecho, verificado en vivo**: el cliente recibió «un vendedor lo revisa» y la campana existía. §11 cumplido contra producción.
  - **Compatibilidad legacy confirmada en producción**: el payload viajó en la forma NUEVA (`payload.attachment`) y los comprobantes viejos siguen abriendo.
  - **LIMITACIÓN CONOCIDA, no tapada**: la campana se emite **sin `targetUid`**, así que la ven OWNER y MANAGER pero **no un SELLER puro** — que es el rol que el mensaje al cliente nombra. Hoy sin impacto (los 3 usuarios de prod son 1 PLATFORM_ADMIN + 2 TENANT_OWNER; no existe ningún SELLER). **No se ampliaron las Rules durante este deploy**: hacerlo abriría al SELLER todas las campanas sin destinatario del tenant. Se cierra cuando exista asignación de conversación.
  - **Visión, OCR y reconocimiento de productos siguen DIFERIDOS** (ADR-0016 §9): verificado en producción que **ningún turno de adjunto llamó a la IA** — la única llamada del smoke (`whatsapp_sales_agent`, `buscar_productos`) correspondió 1:1 a un mensaje de TEXTO, y el log dice literalmente «Turno de adjunto: la IA no participa».

- **[HISTÓRICO] ADJUNTOS — cómo se llegó hasta acá** (ADR-0016, `WHATSAPP-MEDIA-SAFE-FOUNDATION-1`, 2026-07-31):
  - **Qué estaba roto** (auditoría `WHATSAPP-MEDIA-1A-AUDIT-DESIGN-1`, read-only): (1) **toda** imagen entrante se trataba como comprobante — `esImagen` era el único criterio y el mensaje nunca llegaba al bot, así que la foto de un producto congelaba el pedido en `PENDING_VERIFICATION`, disparaba handoff y sacaba al bot del chat; (2) una imagen **sin pedido pendiente ni se descargaba**: se perdía, porque la única ruta de Storage exigía un `orderId`; (3) los **PDF se descartaban en silencio** —y las apps bancarias mandan los comprobantes como PDF—, con lo cual el cliente creía haber avisado y el vendedor no veía nada. Además el modelo `Message` no tenía campo de adjunto (la única evidencia era un texto libre falsificable a mano), el MIME declarado por Graph se creía sin verificar, y el `pendingOrderId` de la sesión no se validaba contra el cliente que enviaba.
  - **Qué se implementó**: adjunto genérico `tenants/{t}/attachments/{attachmentId}` con identidad determinística y `create()` (un reintento del webhook no duplica), **dos ejes ortogonales** —ingesta `received→downloading→verifying→stored` con terminales, y clasificación `unclassified→generic_media|payment_receipt_candidate→payment_receipt_linked`—, descarga endurecida (timeout, reintentos solo de lecturas, corte por bytes **durante** el stream, checksum, **sniffing de magic bytes** contra el declarado), ruta privada sin PII, emisor de URLs con TTL ≤10 min que acepta **las dos familias** (adjuntos nuevos y comprobantes legacy), rules cerradas al cliente, y retención con purga **apagada por defecto** que nunca toca evidencia de pago.
  - **La regla que cambia el negocio**: la ingesta **jamás** mueve un pedido. Si hay contexto de pago declarado, un único pedido admisible del mismo `customerId` y cero ambigüedad, el adjunto se **propone** como candidato y se avisa por la campana — pero el pedido no se mueve. Solo OWNER/MANAGER/SELLER lo vinculan, y ni siquiera eso confirma el pago: sigue siendo el callable de ORDER-1. **Una imagen fuera del contexto explícito de pago queda como medio normal aunque parezca un comprobante.**
  - **Cambio operativo a tener presente**: antes, cualquier imagen movía el pedido y derivaba a un humano automáticamente. Ahora **la decisión es del vendedor**, que recibe el aviso y marca. Es más seguro y más honesto, pero es un cambio de rutina real para quien atiende.
  - **Visión, OCR y reconocimiento de productos quedan explícitamente DIFERIDOS** (ADR-0016 §9): el caption se sanea y se persiste pero **no se envía a la IA**. El costo por imagen (~1,3–1,6k tokens, comparable a un turno de texto completo) exige cerrar antes `AI-QUOTA-ALERTS-1` y `AI-GATE-RESERVA-1`.
  - **Cuatro rondas de revisión adversarial**, todas con hallazgos reales corregidos dentro del mismo programa. Los más caros: el caption **sí** llegaba al prompt de la IA por el historial de mensajes (la ingesta lo guardaba como texto del mensaje); un adjunto degradado no producía **ninguna** respuesta al cliente; el bot **rompía su propio silencio** cuando el archivo no traía caption (con el chat tomado por un vendedor); un comprobante marcado era **invisible** desde el panel de Pedidos; se le prometía al cliente una revisión que nadie veía; y la purga validaba el path contra el `tenantId` que declaraba el propio documento — una primitiva de borrado cross-tenant. Se **eliminó** `orders/comprobanteImage.ts`, código muerto que conservaba el contrato retirado y que un solo import habría reconectado.
  - **ENDURECIMIENTO DE ROLLOUT (`WHATSAPP-MEDIA-SAFE-RELEASE-HARDEN-1`, 2026-07-31, ADR-0016 §10/§11/§12)** — cierra los tres bloqueantes que impedían desplegar `12a899a`:
    - **(1) El rollout no existía: desplegar encendía la fundación sola, para todos los tenants a la vez.** Ahora hay **dos interruptores independientes, por tenant y fail-closed**: `config/attachments.ingest.enabled` (¿guardamos archivos?) y `config/receiptGate.enabled` (¿proponemos comprobantes?). **Solo el booleano exacto `true` enciende** — ausente, `false`, `"true"`, `1`, `"1"`, `[true]` y cualquier otra forma son OFF, y un error de Firestore al leer el interruptor también apaga (al revés que los LÍMITES, que sí caen a defaults para no perder el archivo del cliente). El flag del nivel B **se relee DENTRO de la transacción**, así un apagado ya commiteado le gana a cualquier lectura previa. Con el nivel A en OFF: cero Graph, cero Storage, cero documento de adjunto — pero el inbound queda visible con mensaje neutral y respuesta honesta, sin caption a la IA, sin tocar pedidos y sin handoff. Con el nivel B en OFF: el archivo se guarda y queda `generic_media`, `attachmentMarkAsReceipt` **rechaza** y **`attachmentUnmarkReceipt` sigue disponible** (apagar una función no puede dejar atrapada una decisión humana). Nada ya guardado se oculta ni se borra.
    - **(2) Carrera takeover → envío.** La regla de silencio de HANDOFF-2 vivía triplicada (el motor, un re-chequeo parcial que ignoraba `botEnabled`, y una versión ad-hoc rama por rama en ubicación nativa). Ahora vive en `conversation/silencio.ts` y **se releé autoritativamente pegada al POST**, fail-closed. Una **respuesta suprimida no se persiste**, y el desenlace tipado del transporte decide qué queda en el historial (`rejected` no se registra; `unknown` sí, porque pudo salir).
    - **(3) Promesa sin señal.** Candidato y campana se confirman **en la misma transacción**, con id determinístico. Si no commitea, no se promete revisión: el archivo queda como medio normal, el pedido no se toca y la respuesta es neutral.
    - **Revisión adversarial (5 revisores frescos + 6 auditores previos)**: ningún NO-GO, y **una regresión real encontrada y corregida**: el guard de silencio se había metido ENTRE el kill-switch de cobertura y el `sendText`, ensanchando con dos lecturas una ventana que era de cero E/S por diseño. El kill-switch volvió a ser el último gate (`gateFinal`), con test que lo fija. También se corrigió, encontrado por el orquestador, que **el chequeo de contrato entre motivos del gate y respuestas al cliente no se ejecutaba en ningún lado** (`tsconfig` excluye los `.test.ts` y vitest no verifica tipos): ya había dejado pasar un motivo sin mensaje. Ahora recorre un arreglo real en runtime.
    - **Un defecto encontrado por el propio hardening, en cobertura**: la respuesta honesta «no puedo procesarla» —la que existe PORQUE el kill-switch se apagó— quedaba etiquetada con el `activationId` y por lo tanto **la frenaba el mismo interruptor que la provocaba**: el cliente mandaba su ubicación y recibía silencio total. No se notaba porque la burbuja se persistía igual, así que el panel mostraba una respuesta que el cliente nunca recibió. Ahora solo se etiqueta la respuesta que CONFIRMA o PROMETE revisión.
    - **Verificación**: typecheck 0, lint 0 errores (5 warnings preexistentes), build 0, `git diff --check` 0, **2.924 tests** (2.166 functions + 310 shared + 448 web). **E2E: 310 checks, todos en verde**, desde emulador limpio y serializado: `verify-attachments` **98/98 ×2** (incluye el bloque nuevo AT-23, que prueba el estado REAL del día del deploy: los dos flags apagados), `verify-handoff2` 8/8, `verify-human-handoff` 11/11, `verify-order-comprobante` 9/9, `verify-fase4-whatsapp` 9/9, `verify-p6-rules` 5/5, `verify-rules-config` 12/12, `verify-coverage-killswitch` **23/23**, `verify-coverage-state` 29/29, `verify-coverage-guard` 8/8.
  - **SELECTOR EXACTO DEL RELEASE — se escribe ACÁ porque el rollback lo exige** (el runbook manda reproducir «el mismo selector explícito que usó el deploy», y si no queda asentado hay que rederivarlo a mano bajo presión, que es justo cuando alguien cae en `--only functions` genérico):
    - **CREATE (4)**: `attachmentGetViewUrl`, `attachmentMarkAsReceipt`, `attachmentUnmarkReceipt`, `attachmentRetentionMaintenance`.
    - **UPDATE (2)**: `onWebhookInbox`, `metaWebhook`.
    - **Infra**: Firestore Rules, Storage Rules, Hosting. **Cero índices compuestos nuevos.**
    - **Por qué el selector NO se ensancha aunque `conversation/engine.ts` haya cambiado** (se verificó, no se asumió): los otros tres llamadores de `handleMessage` —`devMessage`, `agentTestCaseRun` y `simulateAgentMessage`/`runTenantJob`— **no pasan `deferOutbound`**, así que conservan exactamente el comportamiento anterior (el motor persiste su burbuja en línea), y además **ninguno envía a WhatsApp**: cero `sendText`, cero `getWhatsAppClient`. No tienen borde de envío, así que no hay respuesta que suprimir. Desplegarlos o no es indistinto en comportamiento, y el runbook manda el selector mínimo.
    - **Orden de deploy**: rules (Firestore + Storage) → `onWebhookInbox` (**consumidor primero**: entiende la forma nueva `payload.attachment` y la legacy `payload.image`) → los 3 callables → `metaWebhook` (**productor último**: escribe `attachment` y ya no escribe `image`) → `attachmentRetentionMaintenance` (scheduler al final, con su `purgeEnabled` en OFF) → Hosting.
    - **Orden de ROLLBACK = el inverso**: Hosting → `metaWebhook` → `onWebhookInbox`. Si se revierte en el mismo orden del deploy, queda una ventana con el productor nuevo escribiendo `attachment` y el consumidor ya viejo leyendo solo `image`: **cada foto y cada PDF que entre en esa ventana se descarta sin rastro.** Y el selector del rollback **NO incluye las 4 CREATE** — en el código anterior esos exports no existen y `firebase deploy` aborta el comando entero, dejando el rollback a mitad. Se dejan desplegadas e inertes (callables sin llamador tras revertir Hosting; el scheduler con su flag en OFF) o se borran aparte con `functions:delete`, que es irreversible y no forma parte del rollback.
    - **El deploy con los flags apagados NO es inerte**, y decir lo contrario sería mentira: los flags gobiernan *guardar bytes* y *proponer comprobantes*, no restauran el camino legacy que `12a899a` eliminó. El delta esperado está enumerado en ADR-0016 §10.
  - **Encendido posterior al deploy, en este orden**: (1) desplegar con los dos flags ausentes; (2) `tenants/arfagi/config/attachments` → `ingest.enabled: true` (booleano, no string) y probar medios genéricos; (3) `tenants/arfagi/config/receiptGate` → `enabled: true`; (4) **credipower permanece apagado en todo momento**. Los flags **no son escribibles desde ningún cliente** (`firestore.rules` cierra `config/{doc}` con `write: if false` y ninguna callable los toca): se encienden por Admin SDK o consola.

- **META CATALOG — AUDITORÍA DE FUENTE DE VERDAD ✅ COMPLETA (2026-07-30) + MODELO DE PROPIEDAD ✅ DESPLEGADO Y ARFAGI MIGRADO A `external_managed` (2026-07-31)** (ADR-0015):
  - **Lo que probó la auditoría** (`META-CATALOG-SOURCE-OF-TRUTH-AUDIT-1`, sin una sola escritura): el catálogo de Meta lo gobierna **al 100 % un feed diario del propio sitio del tenant** (`product_feeds` id `1668013347585391`, `primary_feed`, `deletion_enabled:true`, Server Fetch DIARIO 03:33 America/Asuncion — arranque real 03:23-03:24 — desde `api.arfagi.com`, **con token en el query string: jamás imprimirlo, loguearlo ni persistirlo**). Publica los 181 artículos. `sourceOfTruth:"vendeyapy"` era una declaración sin efecto: la autoridad efectiva era del feed. Todo lo que VendeYaPy escriba vive, como máximo, hasta las 03:23 del día siguiente.
  - **Decisiones del owner (2026-07-30)**: arfagi adopta **`external_managed`**; el sitio/feed gobierna todos los campos públicos que publica; **el precio comercial correcto de Odyssey es ₲250.000 y se corrige EN EL ORIGEN que genera el feed, NO en Meta**; mientras Meta/feed publiquen ₲130.000, Odyssey queda `drifted_external` y **no cierra venta automática**; el feed **no se modifica ni se apaga**; Meta sigue en `dry_run`.
  - **Lo implementado (`META-CATALOG-OWNERSHIP-MODEL-1`, ADR-0015 — DESPLEGADO el 2026-07-31 en `d542cda`)**: propiedad **por campos** con tres modelos (`vendeyapy_managed` / `external_managed` / `hybrid`) y **fail-closed en dos niveles** (config ausente o contradictoria ⇒ cero campos escribibles + techo `dry_run`); **detección de fuentes externas** con metadata SANEADA (nunca URL, query string ni CSV) que corre en onboarding, antes de autorizar `live`, periódicamente y **justo antes de cada POST sensible** — una fuente nueva o con huella cambiada **bloquea la escritura** y levanta una campana idempotente, sin tocar el feed; **estado ACTUAL honesto** (`verified` / `drifted` / `drifted_external` / `remote_missing` / `unverifiable`, con `stale` DERIVADO en lectura por TTL) separado del histórico inmutable del job — `metaVerifiedAt` es la última LECTURA, `metaLastSyncAt` la última ESCRITURA confirmada; **reconciliación periódica** paginada e idempotente que cubre importados **y vinculados a mano** (el agujero por el que Odyssey figuraba `synced` estando derivado) y **jamás escribe en Meta**; **guard determinístico de deriva** en bot y checkout; **migración preview/apply** de la propiedad.
  - **Consecuencia operativa a tener presente en la migración**: al declarar la propiedad, los productos mapeados nacen `unverifiable` (nunca los leímos) y **eso bloquea la venta automática de esos productos hasta la primera reconciliación**. Por eso el scheduler corre **dos veces por día (04:30 y 16:30 Asunción) contra un TTL de 24 h**: una corrida perdida no apaga la venta. Los productos **sin identidad remota no se ven afectados** (nadie de afuera los publica). Para arfagi el impacto real es exactamente el pedido por el owner: los 180 importados están INACTIVE y no se ofrecen igual, y el único mapeado + ACTIVE es Odyssey, que **debe** quedar bloqueado hasta que el origen publique ₲250.000.
  - **Verificación**: typecheck 0, lint 0 errores (5 warnings preexistentes), **2.297 tests** (1.739 functions + 213 shared + 345 web), build 0, `git diff --check` 0, y **458 checks E2E** desde emulador limpio con dos corridas cada uno (`verify-ownership-model.mjs` 145/145 — nuevo, `verify-catalog-onboarding.mjs` 119/119, `verify-meta-catalog.mjs` 194/194). **Cuatro rondas de revisión adversarial**: las cuatro devolvieron hallazgos reales (2 CRÍTICOS, 11 ALTOS y varios MEDIOS) y todos se corrigieron con prueba de discriminación — cada fix se neutralizó para confirmar que su test se ponía en rojo, y se restauró. Los defectos más caros que encontraron: el detector de fuentes externas no estaba cableado en producción (la migración era inalcanzable), dos definiciones incompatibles de la misma huella, el bot cotizando el precio divergente en el listado y en la intersección "pagar" + "ver carrito", la rama de reuso del checkout reenviando datos bancarios sin guard, `verified` sin haber comparado un solo campo comercial, productos que quedaban trabados en `unverifiable` para siempre, y —el más sutil— que **apagar la sincronización apagaba también la honestidad**: el guard quedaba inerte y la reconciliación no podía correr, así que a las 24 h se apagaba la venta automática de todo el catálogo en silencio.
  - **RELEASE EJECUTADO EL 2026-07-31** (`RELEASE-META-CATALOG-OWNERSHIP-EXTERNAL-MANAGED-1`, commit **`d542cda`**, con smoke humano aprobado). Precedido de 6 auditores read-only y una batería preflight completa (458 checks focalizados, 2.297 tests, 3 suites E2E 145/119/194 desde emulador limpio).
    - **Superficie**: rules → functions → hosting. **6 CREATE + 39 UPDATE**, **0 delete, 0 recreate, sin `--force`**; **105 → 111 Functions ACTIVE**; **0 índices** (18 = 18 READY); **3 matches de Rules** nuevos, los tres cerrados al cliente (`metaCatalogSourceChecks`, `metaCatalogVerificationRuns`, `metaCatalogOwnershipRuns`) — probes sin auth: 403; hash de `.env.vpw-prod-dd6ff` idéntico pre/post; `devRunMetaCatalogOutbox` sigue AUSENTE. Las 5 callables nuevas rechazan con `UNAUTHENTICATED` sin sesión; el scheduler `metaCatalogVerificationMaintenance` quedó **privado** (403 en la capa Cloud Run) con cron real `30 4,16 * * *` America/Asuncion, ENABLED.
    - **Migración de arfagi**: preview y apply con cuenta técnica efímera (identidad aleatoria, credenciales nunca impresas, eliminada y verificada por lookup en cada corrida). Resultado: **`external_managed`, `ownedFields` vacío, los 10 campos públicos declarados externos, `mode` sigue `dry_run`**, fuente reconocida **una sola** (feed `1668013347585391`, host `api.arfagi.com`, DAILY 03:33 America/Asuncion — metadata saneada, sin URL, query string ni token), legacy `sourceOfTruth:'vendeyapy'` preservado sin efecto. Gate crítico verificado: la propiedad efectiva **NO quedó degradada** (`external` incluye `price` y `availability`; si degradara, el guard quedaría apagado en silencio).
    - **Reconciliación inicial** (misma ventana, no se esperó al scheduler): 4 páginas, **181 artículos remotos, 181 matched, 0 errores**, detección de bajas ejecutada, TTL 24 h. **50 `verified` · 131 `drifted_external` · 0 `drifted` · 0 `remote_missing` · 0 `unverifiable`.** Campos divergentes: `availability` ×130 (los importados están INACTIVE localmente y el feed los publica disponibles), `brand` ×1, `title` ×1 y **`price` ×1 — Odyssey: local ₲250.000 vs publicado ₲130.000**, owner `external`, severidad `commercial`, con el eje histórico (`metaSyncStatus:'synced'`, `metaLastSyncAt`) **preservado y separado del actual**.
    - **Invariantes verificados**: huella comercial de los 183 productos **idéntica** al baseline (recalculada con el mismo algoritmo, post-apply y post-reconciliación), mappings y locks idénticos, **cero productos alterados**; pedidos 15 y pagos 0 sin cambios; outbox con su único job histórico `succeeded`; **cero `items_batch` y cero escrituras a Meta**; credipower sin config y sin productos; logs sin errores. De los 5 documentos de config del tenant, el release tocó **exactamente uno** (`config/meta`) — Coverage y bancos viven en `config/checkout` (sin cambios desde el 25-jul) y WhatsApp en `config/channels` (3-jul).
    - **Smoke humano aprobado (2026-07-31)**: en el panel, tarjeta "Administrado por fuente externa", Odyssey con ₲250.000 local vs ₲130.000 publicado, sincronización bloqueada y ninguna URL/token del feed a la vista. Por WhatsApp, **1 inbound y exactamente 2 salientes**: el bot NO afirmó ₲250.000 como precio final, no creó pedido, no mandó datos bancarios, derivó **una sola vez** al vendedor con mensaje honesto y preservó el carrito; chat devuelto al bot con la metadata de handoff limpia (`humanTakeover:false`, sin `takeoverBy`/`reason`/`sourceId`). **Cero llamadas de IA** (guard determinístico) y **una sola** notificación nueva (`handoff_catalog_drift`, total 7 → 8).
  - **Dos defectos del runbook que este release detectó y corrigió** (ver §5): el comando documentado `--only functions` **sin selector** habría CREADO `devRunMetaCatalogOutbox` en producción (7 CREATE en vez de 6), y el `.env.production.local` documentado **omitía `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`**, que por precedencia de Next habría caído al valor DEMO del `.env.local` de la máquina — rompiendo reset de contraseña y action links sin que un smoke de "/login responde 200" lo detectara. Los valores se tomaron de `firebase apps:sdkconfig WEB` (autoritativo) y se verificó en el bundle vivo: `vpw-prod-dd6ff.firebaseapp.com` presente, cero `localhost`/`vpw-staging`/`vpw-dev`/demo.
  - **Limitación conocida (no bloqueante)**: la tarjeta de propiedad del panel muestra la fuente externa **sin nombre y sin horario**, y sin el aviso de que el feed borra de Meta lo que no publica. El callable de propiedad devuelve `detectedSources: []` a propósito (no llama a Graph) y la vista persistida solo guarda tipo/ids/campos/huella. El badge "administrado por fuente externa" y el detalle de deriva sí funcionan.
  - **Lo que sigue pendiente**: `mode` permanece en `dry_run`; el feed sigue corriendo **intacto** (no se modificó, no se ejecutó, no se desactivó); Meta sigue publicando Odyssey a **₲130.000** y **el origen que genera el feed TODAVÍA NO fue corregido** — es trabajo del sitio de arfagi, fuera de este repo, y es la prueba final de que el modelo funciona: cuando el origen publique ₲250.000, la reconciliación siguiente debe devolver Odyssey a `verified` y el guard debe dejar de bloquearlo.
  - **Dato de baseline que NO originó este release**: de los 15 pedidos, **1 está en estado `PAID`** (los otros 14 `CANCELLED`). Ya estaba así antes del release y sigue igual; la narrativa previa de "cero venta pagada en las pruebas" no lo mencionaba.

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

- **Deploy functions** — ⚠️ **SIEMPRE con selector explícito, SIEMPRE con `--project`, NUNCA con `--force`**:
  `firebase deploy --only functions:<n1>,functions:<n2>,… --config firebase.functions.json --project vpw-prod-dd6ff`
  - **Por qué el selector es obligatorio**: `src/index.ts` exporta funciones que deliberadamente NO existen en producción (hoy `devRunMetaCatalogOutbox`). `--only functions` a secas **las crea**. En el release del 2026-07-31 el comando que estaba documentado acá habría creado 7 funciones en vez de 6.
  - **Por qué `--project` es obligatorio**: el `default` de `.firebaserc` es `vpw-dev`. Omitirlo despliega al proyecto equivocado.
  - **Cómo calcular el selector**: cierre transitivo de imports desde cada export de `index.ts` hasta los módulos cuyo COMPORTAMIENTO cambió en el diff. Se incluye toda función alcanzada semánticamente aunque su handler no haya cambiado; se excluye a propósito lo que no debe existir en prod. Verificar el selector contra `firebase functions:list --project vpw-prod-dd6ff --json` ANTES de desplegar: el conteo de nombres que no existen debe ser exactamente el de CREATE esperados.
  - **Los scripts de npm ya no pueden desplegar a producción** (DEPLOY-TOOLING-FAIL-CLOSED-1): todos pasan por `apps/functions/scripts/firebase-deploy.mjs`, que valida antes de ejecutar (proyecto explícito y permitido, sin `--force`, `--only` presente, selector de Functions exacto, config correcto) y corre sin shell. `pnpm deploy:prod` y el `deploy` de `apps/functions` están BLOQUEADOS: imprimen el motivo y salen con código 1 sin invocar Firebase. Para STAGING, `pnpm deploy:functions -- --only functions:<n1>,functions:<n2>`. Producción sigue siendo este procedimiento manual, y `node apps/functions/scripts/deploy-guard.mjs --audit` verifica que ninguna ruta ejecutable del repo se salga de esta regla.
  - **Orden**: rules → functions (consumidores primero, schedulers al final) → hosting. El predeploy genera `apps/functions/.deploy`; los 429 de cuota reintentan solos; verificar "Successful update/create operation" por función. **No inspeccionar `.deploy` con el shell parado adentro**: deja el directorio bloqueado en Windows y el predeploy siguiente falla con `EBUSY`.
- **Deploy hosting**: crear TEMPORAL `apps/web/.env.production.local` → `firebase deploy --only hosting --project vpw-prod-dd6ff` → **BORRAR el env temporal**.
  - ⚠️ **El temporal debe definir TODAS las claves que `apps/web/.env.local` define.** Next resuelve `.env.production.local` > `.env.local`, así que **cualquier variable ausente del temporal cae al valor DEMO del `.env.local` de la máquina** (proyecto demo + emuladores). Un smoke de "/login responde 200" NO detecta esto: un `authDomain` demo rompe el reset de contraseña y los action links, no el login.
  - **Claves obligatorias (9)**: `NEXT_PUBLIC_FIREBASE_API_KEY`, **`NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`** (faltaba en versiones previas de este runbook), `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`, `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`, `NEXT_PUBLIC_USE_EMULATORS=false`, **`NEXT_PUBLIC_ALLOW_SELF_REGISTRATION=false`** (si se olvida, /register vuelve a mostrar el form) y `NEXT_PUBLIC_API_BASE_URL`.
  - **De dónde salen los valores, sin inventar ninguno**: `firebase apps:sdkconfig WEB --project vpw-prod-dd6ff` devuelve la config autoritativa (apiKey, authDomain `vpw-prod-dd6ff.firebaseapp.com`, projectId `vpw-prod-dd6ff`, bucket `vpw-prod-dd6ff.firebasestorage.app`, senderId `410226633946`, appId `1:410226633946:web:0b3fa3f3f94e3bcce2c9e3`). `API_BASE_URL` = `https://us-central1-vpw-prod-dd6ff.cloudfunctions.net`.
  - **Verificación post-deploy**: descargar los chunks de la raíz del sitio y confirmar `vpw-prod-dd6ff.firebaseapp.com` presente y **cero** ocurrencias de `localhost:`, `vpw-staging`, `vpw-dev` y del projectId demo. Plantilla de claves: `apps/web/.env.production.example`.
- **IAM**: el SA de functions `410226633946-compute@developer.gserviceaccount.com` tiene `iam.serviceAccountTokenCreator` sobre sí mismo (firma de URLs de comprobantes). **Si se cambia el SA de functions, re-otorgar el grant.**
- **Acceso a prod sin gcloud** (patrón usado por todos los scripts de verificación): en Node, `require('<ruta firebase-tools global>/lib/requireAuth')` + `auth.getProjectDefaultAccount()` + `apiv2.Client` contra las APIs REST (Firestore runQuery, Identity Toolkit, Cloud Logging, Hosting). Requiere `firebase login` con la cuenta owner del proyecto en la máquina. Usuarios de prueba en prod: crear temporal por Identity Toolkit (claims `{tenantId, role:'TENANT_MANAGER'}`), smoke por Playwright, **eliminar al terminar**.
- **Emulador E2E**: SIEMPRE `--project demo-aiafg` + build + **seed-users.mjs Y load-catalog.mjs** (sin catálogo, verify-human-handoff falla 5/11); `.env.local` con TODAS las vars de `getConfig()`; esperar ~30s el settle del caché de entitlements; nunca pipe `emulators:start` a `head`.
- **Costo IA**: los turnos determinísticos son gratis; un turno del sales agent cuesta ~3.900 tokens promedio (hasta ~7.700) porque cada llamada re-envía system+tools+historial+fichas y el loop de tools re-factura el input (sin prompt caching todavía). Costo real observado: ~US$1,16 por millón de tokens.
- **Incidente de cupo de IA (2026-07-15, MITIGADO)**: el tenant `arfagi` agotó el cupo mensual — 251.398 tokens usados contra el límite anterior de 250.000 (plan growth). Auditoría completa: **65 llamadas 100% atribuidas** (todas `whatsapp_sales_agent` desde WhatsApp real de los números del owner — smokes de desarrollo + operación), **sin doble conteo confirmado**, consumo dominado por input/contexto (96%). Al agotarse, la degradación era **determinística y silenciosa**: el cliente recibía respuestas de reglas (fallback genérico) sin aviso al owner — **mitigado estructuralmente el 2026-07-16 por AI-FALLBACK-HONESTO-1** (ver §3): con cupo agotado, las consultas que necesitan IA ahora derivan a un humano con aviso en la campana. **Restauración**: `plans/growth.limits.maxAiTokensPerMonth` 250.000 → **1.500.000** (única mutación, con precondición y updateMask; contador y período PRESERVADOS — nunca se borra consumo). Servicio restaurado y verificado con smoke live. **Próximo reset: 01-ago-2026** (mes calendario UTC, job `resetUsageMonthly`).

## 6. PRIORIDADES (en orden)

0. **CORREGIR EL PRECIO DE ODYSSEY EN EL ORIGEN QUE GENERA EL FEED (PRIORIDAD MÁXIMA — fuera de este repo)**. El release del modelo de propiedad **ya está desplegado y arfagi ya está en `external_managed`** (ver §3): el sistema hoy detecta la divergencia, la muestra en el panel y **no cierra venta automática** de Odyssey. Lo que falta es el paso que este proyecto no puede hacer solo: que el precio publicado por el feed coincida con el local. **ACTUALIZADO 2026-07-31**: el owner corrigió el registro canónico del sitio (producto id 258, SKU `ARM-744646-5202`) de ₲130.000 a **₲190.000**, que es el precio comercial vigente, y alineó el precio local de VendeYaPy al mismo valor. Verificado read-only: cambió exactamente una celda comercial en el origen (los otros 182 productos y todos los campos no-precio de Odyssey con huella idéntica). **Pendiente de propagación natural**: el feed publica ~03:23-03:24 America/Asuncion y la reconciliación corre a las 04:30 (segunda oportunidad 16:30). Recién ahí `metaSyncState` debería pasar de `drifted_external` a `verified` y el bot volver a cotizarlo — **esa es la prueba final de que el modelo funciona**. **OBSERVADO READ-ONLY el 2026-08-03 (sin tocar nada): la reconciliación SÍ corrió (`metaVerifiedAt = 2026-08-03T07:30:16Z`) y Odyssey SIGUE `drifted_external` con el local en ₲190.000.** O sea que pasaron dos ciclos completos de feed y la divergencia persiste: el origen que genera el CSV no está publicando ₲190.000, o publica otro campo divergente. **Sigue siendo la prioridad 0 y es trabajo fuera de este repo.** **El feed no se toca, no se ejecuta a mano y no se desactiva. No se escribe en Meta. `mode` sigue en `dry_run`.**
   - **Efecto colateral verificado, y es una buena noticia**: durante el smoke de adjuntos del 2026-08-01 el bot listó productos y **excluyó Odyssey**, ofreciendo solo el que no tiene identidad remota. Es la **primera vez que el guard de deriva bloquea un producto en una conversación real de producción** — el modelo de propiedad funciona de punta a punta.
   - **Deuda menor que salió del release** (no bloquea la venta): la tarjeta de propiedad del panel muestra la fuente sin nombre ni horario y sin el aviso de borrado de faltantes; `metaSyncState` no se recalcula al editar un producto, así que **al activar un importado enriquecido va a arrastrar el `drifted_external` por disponibilidad hasta la reconciliación siguiente** (máximo ~12 h) — tenerlo presente al habilitar productos.
0b. **DEFECTOS ENCONTRADOS POR EL DEPLOY DE ADJUNTOS (2026-08-01/03), cada uno necesita su propio programa:**
   - **`releaseToBot` destruye el estado de checkout (ALTO, preexistente de HANDOFF-2/HUMAN-HANDOFF-1).** El botón «devolver al asistente» del panel (`conversation/handoff.ts`, `releaseToBot`) escribe **`state: 'IDLE'` incondicionalmente** y limpia `handoffReason`. Si un vendedor toma y libera el chat durante el checkout, se pierde el `AWAITING_PAYMENT` que había puesto `coverageResume`, y a partir de ahí **el receipt gate ya no puede proponer nada**: el cliente manda el comprobante y el gate deniega con `no_explicit_payment_context`. **Reproducido en producción el 2026-08-01**: pago instruido 11:50:48 → chat liberado 11:51:11 → comprobante 11:52:03 → denegado. Con el estado repuesto (el cliente escribió *pagar* de nuevo) el gate propuso el candidato sin problema. Nada se pierde —el archivo queda guardado y visible, y marcar a mano sigue funcionando— pero la automatización queda muda en el camino más común. **Contraste que acota el arreglo**: la liberación AUTOMÁTICA del flujo de cobertura (`coverageResume.liberarSesionGuardado`) está bien hecha y **no toca `state`**; el defecto vive solo en el botón manual.
   - **El artefacto de deploy filtraba secretos de staging a producción (ALTO) — ✅ FUGA HACIA ADELANTE CORREGIDA el 2026-08-03 en `RELEASE-SECURITY-AND-RUNBOOK-HARDEN-1`; ROTACIÓN TODAVÍA NO EJECUTADA.**
     - **Qué se arregló, en dos capas independientes.** (1) `build-deploy.mjs` copiaba cualquier `.env.<algo>` no-`.local` porque **no sabía a qué proyecto se desplegaba**; ahora el destino es obligatorio (`GCLOUD_PROJECT` que firebase expone al `predeploy`, ya resuelto de alias, o `--project` explícito) y la allowlist es `.env` + `.env.<projectId>` + `.env.<alias-que-resuelve-a-ese-projectId>`, con aborto ante env faltante, proyecto ambiguo o env ajeno detectado al releer el artefacto. (2) Los dos `firebase*.json` ahora excluyen `.env*` del zip — hacía falta igual, porque `firebase.json` apunta a `apps/functions` DIRECTO y subía **los dos entornos juntos**, y la subida ocurre **antes** de que Cloud Build falle por `workspace:*`, así que hasta un deploy fallido dejaba secretos arriba. Excluirlos **no cambia ninguna variable desplegada**: firebase lee los `.env` del disco local en `prepare` (`loadUserEnvs`) y el `ignore` solo gobierna el zip. Probado con el walker real del CLI que el repo ejecuta (13.35.1): `firebase.json` 2191 archivos y `firebase.functions.json` 874, **cero `.env` subidos** en ambos, con las variables cargando idénticas (10 prod / 8 staging).
     - **Alcance real de la exposición, medido y sin inflar.** El bucket `gcf-v2-sources-410226633946-us-central1` **NO es público**: `uniformBucketLevelAccess`, cero bindings a `allUsers`/`allAuthenticatedUsers`, 4 roles con 1–2 principals. La exposición es **interna**, para quien tenga lectura de ese bucket. Y **no alcanza a producción**: los 4 secretos tienen **valores distintos** en cada entorno (comparación por hash; el único valor compartido es `LOG_LEVEL`, que no es credencial).
     - **Artefactos históricos: PENDIENTES, no borrados.** 224 versiones de objeto (115 vivas + 109 archivadas, del 09-jul al 01-ago). Solo **6 vivas** son posteriores a la mitigación manual del 2026-08-01; quedan **109 objetos vivos** cuyo zip se construyó con el `.env` de staging presente. Es **INFERIDO**, no demostrado: confirmarlo exigiría descargar un zip con secretos. El lifecycle borra versiones **no vigentes** cuando hay 3 más nuevas, pero **los objetos vivos no expiran nunca**: persisten hasta que cada función se redespliegue, y con el fix cualquier redeploy los reemplaza por artefactos limpios. **No se borró ningún objeto.**
     - **⚠️ La cabecera de `.env.vpw-staging` dice «Placeholders staging-safe; NO son secrets reales» y la evidencia lo contradice**: los cuatro son hex minúscula de longitudes criptográficas exactas (48/32/32/64 chars), **ninguno** lleva marcador `test`/`demo`/`staging`, y en cambio las URLs inocuas del mismo archivo **sí** dicen "staging". `vpw-staging` tiene **74 functions ACTIVE**: protegen un entorno vivo. **No se puede afirmar que sean placeholders.**
     - **Producción SIN CAMBIOS**: este programa no desplegó nada, no roté ni revoqué ningún secreto, no toqué IAM y no borré ningún objeto.
   - **Cuatro secretos productivos viven como env vars planas** (`N8N_INTERNAL_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `TENANT_SECRETS_ENCRYPTION_KEY`), contra lo que dice `docs/deploy.md`. El proyecto ya sabe usar Secret Manager (9 funciones lo usan para `ANTHROPIC_API_KEY` y `META_APP_SECRET`): falta migrar estos cuatro. Preexistente; el release no lo empeora en naturaleza, solo en superficie.
   - **Menores de UX del motor** (no son de este release): un caption ininteligible dispara el fallback «no entendí → mostrá catálogo», y cuando el motor contesta se suprime el acuse del adjunto, así que el cliente que manda una foto con caption puede recibir **solo** una recomendación de productos y ningún «recibí tu imagen».
1. **Evidencia de FASE 3**: primera conversación de número externo → verificación read-only completa (§4-FASE 3). Las pruebas hechas hasta ahora salieron de números del owner: la fase NO está completa.
2. **FASE 5 completa** (runbook + backups + alertas + docs al día) — programa estándar, sin deploy de código previsto.
3. **Programas pendientes ya identificados** (AI-FALLBACK-HONESTO-1, COVERAGE-GUARD-1 y el paquete COVERAGE con flag OFF CERRADOS/DESPLEGADOS — ver §3; el resto sigue): **COVERAGE — ACTIVO EXCLUSIVAMENTE EN ARFAGI (estado vigente 2026-07-25)**: E2E de Coverage/Shipping Chat validado en producción hasta comprobante y cancelación manual (tester interno; no hubo venta pagada); política `required` con `maxChargeGs ₲200.000`; purga a 30 días corregida (elimina coordenadas exactas y nombre del lugar; la dirección textual no la elimina este maintenance) con backfill de los 2 requests históricos; credipower apagado. **La prueba FASE 3 con número EXTERNO sigue PENDIENTE y usará la activación VIGENTE** (no requiere activationId nuevo salvo que antes se ejecute un kill-switch o exista una razón operativa real). El hallazgo del guard que la máquina de estados debe cubrir: "¿el costo de envío se calcula antes o después de pagar mi pedido?" fue clasificado como VISTA DE CARRITO por contener "mi pedido" — honesto y sin efectos, pero UX incorrecta. · **AI-QUOTA-ALERTS-1** (campana 70/85/95/100% + aviso al bloquear) · **AI-PROMPT-CACHING-1** (cache_control en system+tools + contar cache tokens) · **microprograma de cortesía determinística** (hallazgo del smoke: "Gracias" consumió un turno de IA de ~3.4k tokens — la cortesía pura debería responderse por reglas; con cupo agotado NO deriva gracias al guard `esConsultaDerivable`, es solo costo) · **higiene de logs** (el `customerId` completo — que en este modelo ES el teléfono — viaja como campo de correlación en la metadata estructurada de logs; el TEXTO de los logs está limpio; preexistente, enmascararlo en un microprograma) · **AI-USAGE-ATTRIBUTION-1** (origen/customerId en aiRequests + marcar/eximir simulador y test cases) · **AI-GATE-RESERVA-1** (estimación realista o reserva transaccional) · **META CATALOG — próximo paso: ENRIQUECER los 180 importados** (eran 30; la importación genérica del 2026-07-30 sumó 150) (cargarles costo real y stock real; hasta que no se edite su inventario siguen con `stockPendingReview:true` y no se pueden habilitar) y **revisar los grupos señalados por el centro de calidad** (conteo VIGENTE tras la importación genérica: 23 nombres genéricos, 18 duplicados probables, 33 incoherencias, 1 sin marca; las cifras 67/13/26 eran del análisis previo a importar). Recién después se decide qué productos habilitar con `metaCatalogSetSyncEnabled` y si se pasa a `mode:live`. **Hoy: la ÚNICA sincronización real de la historia (canary Odyssey, UPDATE solo de price ₲130.000→₲250.000) fue REVERTIDA por el feed diario del sitio el 2026-07-30 (Meta volvió a ₲130.000); Meta en 181 artículos (el crecimiento 133→181 fue EXTERNO); mode sigue en dry_run y las escrituras a Meta siguen BLOQUEADAS POR CONSTRUCCIÓN: desde el 2026-07-31 arfagi está en `external_managed` con cero campos escribibles, así que no existe patch posible (ADR-0015). Odyssey quedó `drifted_external` y no cierra venta automática hasta que el ORIGEN del feed publique ₲250.000 (prioridad 0)** — ver §3 · **campana para futuros usuarios con rol SELLER puro** (hoy SIN impacto: el vendedor configurado actual es TENANT_OWNER y ve todo; el staff ve la bandeja de /conversations con no-leídos, pero la campana de notificaciones requiere rules + gate de UI en un programa posterior (excepto `catalog_quality`, que desde el 2026-07-29 el MANAGER ya ve)) · **microajuste conversacional**: comparaciones contextuales ("¿ambas son dulces?") hoy caen al listado por reglas en vez de responderse, y las comparaciones de la IA deben citar la marca de CADA producto por dato. No hay pedidos pendientes de verificación. De los 15 pedidos históricos, 14 están CANCELLED y **1 quedó en estado PAID** (anterior a los releases de julio; la narrativa previa de "cero venta pagada en las pruebas" no lo mencionaba).
4. **Criterio de "terminado" del proyecto**: una persona externa completa el ciclo entero sin intervención técnica — escribe al +595 986 440752 → el bot recomienda con ficha (honesto en "¿sirve para X?") → carrito → "pagar" crea la orden → foto del comprobante → el vendedor la VE en el panel desde `vendeyapy.com` → confirma el pago → venta registrada con ganancia. Verificación read-only en cada paso + registro público cerrado + backup semanal documentado.
5. Después de eso: FASE 6 solo a pedido del owner.

---

## Coexistence de WhatsApp Business App — estado al 2026-08-04

**Programa `WHATSAPP-COEXISTENCE-FOUNDATION-COMPLETE-1`, sobre `4af6607`.** Autoridad: ADR-0017
(§5 y §6 son correcciones del contrato oficial de Meta verificado el 2026-08-04) y ARCHITECTURE §12/§12.1.

### Estado honesto

- Fundación **COMPLETA EN REPO**.
- **NO desplegada.**
- Número real **NO conectado**. **QR NO ejecutado.**
- **Backup productivo NO ejecutado**: en este programa se construyeron y probaron las HERRAMIENTAS.
- El cutover es el **Programa 2**: `docs/coexistence-release-runbook.md` tiene el orden exacto de los 13 pasos.
- **La aprobación externa de Meta sigue siendo un gate abierto** (ver abajo).
- **Restaurar Firebase NO deshace cambios externos ya hechos por Meta ni por la app móvil.** Un restore no
  des-onboardea un número.

### Lo que quedó construido

| Pieza | Dónde |
|---|---|
| Embedded Signup en DOS flujos (`standard` \| `coexistence`) | `apps/web/src/lib/metaEmbeddedSignup.ts` |
| Nonce atado a tenant + uid + **modo** + vencimiento + uso único | `apps/functions/src/meta/nonce.ts` |
| Conexión `wa_{pnid}` que jamás toca `main` | `apps/functions/src/meta/coexistenceConnect.ts` |
| Coordinador durable del historial + disparo de `smb_app_data` | `apps/functions/src/meta/historyCoordinator.ts` |
| Ciclo de desconexión (`account_update`) | `apps/functions/src/meta/accountUpdate.ts` |
| Backup restaurable + restore aislado + prueba de equivalencia | `apps/functions/scripts/backup-*.mjs`, `restore-*.mjs`, `backup-restore-e2e.mjs` |
| Auditoría de release calculada desde el grafo compilado | `apps/functions/scripts/release-audit.mjs` |
| Runbook del Programa 2 | `docs/coexistence-release-runbook.md` |
| Backup y restauración | `docs/backup-restore.md` |

### Precondiciones del E2E (importante)

Emulador con **`--project demo-aiafg`** (con otro, las callables dan 404). Sembrar con `seed-users.mjs` +
`load-catalog.mjs`. **`seed-demo.mjs` SOLO para `verify-p6-rules`**: siembra 3 órdenes `PAID` en el tenant
`perfumeria` y el caso 23 de `verify-shipping-quote-saga` afirma sobre TODAS las órdenes del tenant.
`backup-restore-e2e.mjs` exige `FIRESTORE_EMULATOR_HOST` y **NO** tolera `GCLOUD_PROJECT` (contradice su
`--project` de destino y dispara el guard, correctamente). E2E **siempre serializado**.

### Pendientes que NO son código

1. **Elegibilidad de Paraguay para Coexistence**: Meta no publica lista maestra de países. Gate externo abierto.
2. **`NEXT_PUBLIC_META_COEXISTENCE_CONFIG_ID`** sin valor: hace falta una configuración APARTE en Meta con
   `featureType = whatsapp_business_app_onboarding`. Mientras esté vacío, la tarjeta se muestra pero explica
   que la opción no está habilitada y no deja lanzar nada.
3. **Política TTL de `metaOAuthStates`** sobre `expiresAt` (el campo ya se escribe). No se declara por código:
   declarar el TTL de una colección preexistente podría CREAR una política que hoy no existe.
4. **Embedded Signup corre en v2** (no se manda `extras.version`) y **v2 se depreca el 2026-10-15**. Es un
   plazo duro, no una mejora opcional. Decisión aparte.
5. Deploy de índices **NUNCA con `--force`**: borra los field overrides que no estén en el archivo, incluida
   la política TTL de consola de `metaWebhookInbox`, que no está en IaC a propósito.
6. **CERRADO por el correctivo (2026-08-04)**: el gate `SESIONES_POR_CANAL_MIGRADAS` fue RETIRADO del
   script — la garantía es estructural (`paths.session` exige la clave; compilador) y la demuestra
   `verify-coexistence-dual.mjs` con la herramienta real. Ver el runbook, Paso 12.

### Correctivo de cierre del Programa 1 — 2026-08-04 (continuación sobre `9413047`)

Los 7 gates que el reporte anterior no había cerrado, cerrados con tests rojos primero:

1. **`live` real para el canal nuevo**: el gate `SESIONES_POR_CANAL_MIGRADAS` fue **retirado** (no
   puesto en `true`): la garantía es estructural (`paths.session` exige la clave; compilador) y la
   demuestra `verify-coexistence-dual.mjs` (20/20) — dos PNID, mismo cliente, promoción a `live` con
   `migrarModoAutomatizacion(...,--apply)`, jamás escritura directa. `verify-coexistence.mjs` también
   promueve con la herramienta real (checks 25/27).
2. **Instagram/Messenger con canal propio** (`ig`/`msgr`): ya no comparten `active` con el número que
   vende. El panel resuelve el canal primero por plataforma (`conversation.channel`).
3. **Cutover seguro del número por defecto**: `cutover-whatsapp-number.mjs` (una transacción, firma
   sha256 del dry-run obligatoria en `--apply`, `--degradar-anterior shadow|inactive`, registro de
   reversa en `whatsappCutovers/`, rollback byte a byte) + guard en `selectMetaPhoneNumber` (rechaza
   default no-live cuando otro asset declara live; pre-migración intacta). `verify-cutover.mjs` 22/22.
4. **UI humana del historial**: tarjeta en /integrations — decidir share/skip, disparar el único
   pedido, ver estado saneado con `aria-live`. Wrappers nuevos en `integrations.ts`.
5. **Generaciones del historial**: offboard cierra la vigente honesta; solo un signup nuevo (claim de
   code) abre la siguiente; la anterior se archiva íntegra (`{pnid}_gen{N}`); replay viejo bloqueado;
   `skip` anterior no bloquea reconexión.
6. **Backup de Storage con BYTES**: `backup-storage.mjs` copia y verifica todo (manifest
   `copiaDeBytes:true`); `restore-storage.mjs` nuevo (producción prohibida sin excepción);
   `backup-restore-e2e.mjs` exige los TRES emuladores (sin Storage ⇒ exit 1) — 51/51.
7. **Runbook** al día: pasos 2-3 exigen export administrado + restore aislado con Graph GET read-only
   + política de Auth explícita; paso 12 documenta el cutover; hallazgos 4 y 5 cerrados.

### Cierre correctivo final del Programa 1 — 2026-08-05 (sobre `2798296`)

Se cerraron los **11 hallazgos** del scan de Codex Security (5 MEDIUM, 6 LOW) más los bloqueantes de
release-safety, y los **8 confirmados** por la review adversarial posterior (1 CRITICAL, 1 HIGH,
5 MEDIUM, 1 LOW). Todo con test discriminante rojo primero.

Lo que más importa recordar de esta ronda:

- **Un mapa vacío con `merge:true` NO fusiona: REEMPLAZA.** Verificado contra
  `@google-cloud/firestore@7.11.6`: `set({conversation:{}},{merge:true})` serializa
  `updateMask:["conversation"]` con `mapValue:{}`. El guard monotónico del resumen dejaba `conv`
  vacío para un mensaje viejo sin decisiones y BORRABA `receivedVia`, `channel`, `humanTakeover`,
  `state` y `unreadForSeller`. `appendMessage` ahora omite la clave cuando no hay nada que escribir.
- **El 503 del archivo no puede tirar el lote entero**: Meta batchea varias `entry` en un POST, y
  `deactivateWhatsappNumber` borra el índice a propósito, así que el binding ausente no siempre es
  transitorio. Se persiste el tráfico vivo (idempotente por wamid) y se pide reintento solo por el
  archivo.
- **Fence temporal del offboarding**: `cerrarGeneracionPorOffboarding` recibe el timestamp de Meta y
  no sella una generación que nació DESPUÉS de esa desconexión.
- **WABA explícito también en el flujo estándar** (`connectFlow.ts`): con más de un WABA autorizado
  y sin elección, rechaza. «El primero de la lista» puede ser el de otro cliente del Tech Provider.
- **Precondición E2E nueva**: `verify-shipping-quote-saga` espera a que la cuenta de salientes se
  ESTABILICE antes del check 44 — `AWAITING_PAYMENT` se persiste antes de mandar el mensaje
  bancario, así que el estado de sesión no alcanza como señal de «terminó de hablar».

**Pruebas externas DIFERIDAS al Programa 2** (fail-closed resuelto en código; la evidencia real
requiere credenciales):
1. Contrato de `account_update` sin `timestamp` — el dedup cae a un hash canónico y queda
   reprocesable; falta la captura saneada del payload productivo.
2. Cardinalidad y ownership de WABAs en el token Tech Provider real.
3. Prueba durable de offboarding: no se abre generación nueva sin claim de code nuevo.
4. Provenance/ACL de los bundles de restore: la contención de paths se aplica SIEMPRE, sin confiar
   en el origen.

## Programa 2 — Preflight del release Coexistence (2026-08-06, sobre `b42a8fb`)

**Etapa A (local) VERDE**: typecheck/lint/tests/build/diff-check en 0 (240 archivos de test);
E2E coexistence 51/51, dual 20/20, cutover 26/26, backup-restore 51/51. Grafo recalculado del
compilado: 122 exports (src == lib), 0 bloqueos locales, 53 módulos cambiados + 11 nuevos vs
`30c1687`. Auditoría contra producción: **CREATE=6, UPDATE=115, DELETE=0** (coincide con el
runbook) y veredicto **BLOQUEADO por `migracion_pendiente`** — el estado pre-Paso-5 esperado.

**Etapa B (baseline productiva `vpw-prod-dd6ff`, read-only) CONGELADA**: tenants `arfagi` +
`credipower`; un único PNID whatsapp ruteando (asset `125…04` de arfagi, `connectionId: main`,
`status: active`, `automationMode` **ausente** en asset e índice); cero conexiones `wa_*`;
`coexistenceHistorySyncs` vacía; credipower sin superficies whatsapp (intacto); 115 functions
ACTIVE, `devRunMetaCatalogOutbox` ausente, 7 schedulers, 18 índices, `fieldOverrides: []` (sin TTL
en prod, revalidado); Hosting con release del 2026-07-31; conteos arfagi: 6 customers / 16 orders /
6 sessions. Hash sha256 de `apps/functions/.env.vpw-prod-dd6ff`:
`9d78bbd95c0765e0ac771b20ea087721e72d0171183cea4f334ec5f12532391f`.

**Correcciones doc-only aplicadas al runbook por el preflight** (verificadas contra código):
1. §6.4: la lista del temporal de Hosting era incompleta — el código consume 14 `NEXT_PUBLIC_*`;
   obligatorias 12 (se sumaron `NEXT_PUBLIC_META_APP_ID` y `NEXT_PUBLIC_META_CONFIG_ID`, ambas sin
   fallback; la estándar puede ir vacía a propósito para deshabilitar ese flujo).
2. Paso 13: el redeploy de reversa NO puede usar "el MISMO selector" — los 6 CREATE no existen en
   `30c1687`; selector de reversa = solo las 115 UPDATE, artefacto armado con tooling de HEAD.
3. Pasos 5/11/13: `migrate-whatsapp-automation-mode.mjs` no acepta `--project`; destino por
   `GCLOUD_PROJECT` con default `demo-aiafg` — todos los comandos llevan ahora el prefijo
   explícito. Hardening pendiente (código, fuera de este programa): flag `--project` como el cutover.
4. §2: los `statuses` viajan dentro de `messages` (5 fields reales); ese gate es el único
   verificable por Graph GET read-only (`/{app-id}/subscriptions` con app token server-side).
5. Paso 6: deploy siempre con el CLI del repo (13.35.1), no el global 15.x.
6. `firestore.indexes.json`: el comentario decía verificar "las dos" políticas TTL; son TRES.

**BLOQUEANTES para la Etapa C (deploy), ninguno resoluble desde el repo**:
- **Los 5 gates externos de Meta siguen sin evidencia de cierre** (Paso 1 bloquea todo), incluida
  la elegibilidad de Paraguay (solo por soporte/partner manager). Tech Provider / App Live /
  Advanced Access se cierran en pantallas del owner (App Dashboard app `1739140590442740`).
- **`NEXT_PUBLIC_META_COEXISTENCE_CONFIG_ID` sin valor**: el owner debe crear la configuración
  aparte en Meta (`featureType: whatsapp_business_app_onboarding`) y traer el config_id.
- **ADC ausente en la máquina** (`gcloud` no instalado, sin `GOOGLE_APPLICATION_CREDENTIALS`):
  los backups del Paso 2, la migración del Paso 5 y el kill-switch usan firebase-admin y hoy NO
  pueden ejecutarse. La sesión del firebase CLI no alcanza. Resolver con el owner antes de tocar
  producción; el rollback tiene que ser demostrable ANTES de la primera mutación.
- **Deuda v2 del Embedded Signup** (sin `extras.version`; v2 se depreca el 2026-10-15): decisión
  del owner — conectar en v2 ahora es funcional y la conexión persiste; v3 es cambio de código
  aparte con su propio ciclo de tests/review.

Sin gates cerrados + sin rollback demostrable ⇒ **el programa se detuvo fail-closed al final de la
Etapa B, sin ninguna mutación productiva ni llamada a Meta.**

## AI-USAGE-RESERVATION-AND-ALERTS-1 — 2026-08-14 (EN PROD desde 2026-08-15 — ver DEPLOY-AI-RESERVATION-VISION-INERT-1)

Cierra `AI-GATE-RESERVA-1` y `AI-QUOTA-ALERTS-1` (§6.3) con **ADR-0018**: la base de control de
consumo previa a visión/OCR (que sigue DIFERIDA al programa siguiente).

**Contrato** (`entitlements/aiReservation.ts`, abstracción única): reserva transaccional ANTES del
proveedor (`aiTokensThisMonth + aiTokensReserved + est ≤ límite`; la clave es el id lógico —
`ventas-{wamid}`: reintentos del webhook no facturan dos veces) → ciclo persistido en
`tenants/{t}/aiReservations/{clave}` (`reservada → liquidada | liberada | vencida`, lease 10 min)
→ liquidación exactamente-una-vez con el uso REAL (el gateway ahora reporta el parcial acumulado
también en error; los replies vacíos liquidan — antes subconteo) → recuperación lazy + scheduler
`aiReservationMaintenance` (horario). Alertas idempotentes por campana (categoría `ai_quota`,
70/85/95/100, id `ai-quota-{AAAAMM}-{umbral}`), CTA a /billing. `usage.aiTokensReserved` NO entra
en el ZEROED del reset (las reservas en vuelo cruzan el mes; decremento con clamp ≥0).

**Superficie del deploy futuro** (nada desplegado): scheduler nuevo `aiReservationMaintenance`
(8→9 al desplegarse junto a Coexistence), 2 índices `aiReservations (status, expiresAt)`
(COLLECTION + COLLECTION_GROUP), 1 match nuevo en rules (`aiReservations: read,write:false`), y
los consumidores de IA existentes (onWebhookInbox, askInternalGrowthAssistant, agentTestCaseRun).

**Verificación**: 12 casos discriminantes rojos→verdes→neutralización (gate anulado ⇒ 7 rojos ⇒
restaurado 19/19); E2E nuevo `verify-ai-reservation.mjs` **9/9 con concurrencia real** contra el
emulador (carrera por capacidad, misma clave en paralelo, liquidación concurrente, barrido,
alertas, aislamiento); batería completa 243 archivos verde; regresiones handoff 11/11 + 8/8,
fase6 6/6, p6-rules 5/5; typecheck/lint/build/diff-check en 0.

**Review adversarial final** (concurrencia/idempotencia/contabilidad/multi-tenancy): cero
CRITICAL/ALTO; el MEDIO (liquidar/liberar descontaban el estimado del closure, no el del doc —
drift permanente del espejo en handles reusados) y el BAJO de umbrales perdidos quedaron
CORREGIDOS con test discriminante y warn de clamp. Sobre-admisión concurrente, doble vencimiento,
doble facturación por re-entrega, reset que pisa el espejo, cruces de tenant y regresión del
mapeo de errores: REFUTADOS con evidencia.

**Deudas honestas**: el costo USD sigue sin límite propio (solo tokens); el simulador consume
cuota real (su exención es AI-USAGE-ATTRIBUTION-1, pendiente); los `aiReservations` liquidados no
tienen TTL (volumen bajo, decisión de retención pendiente); dos ejecuciones VIVAS del mismo wamid
(un zombi que supere el lease del claim del inbox) llaman al proveedor dos veces aunque facturan
una — acotado por el claim upstream, sin fix barato; la alerta `agotada` puede dispararse por
presión de reservas en vuelo antes del 100% liquidado (semántica declarada del ADR §5); el sweep
va de a 200/hora secuenciales (suficiente en régimen normal; un incidente masivo lo drenaría en
varias corridas).

## PRODUCT-IMAGE-UNDERSTANDING-SAFE-1 — 2026-08-14 (EN PROD INERTE desde 2026-08-15, FLAG APAGADO — ver DEPLOY-AI-RESERVATION-VISION-INERT-1)

Segundo y último programa del bloque de ADR-0018. **ADR-0019**: reconocimiento de imágenes de
productos contra el catálogo local, multi-vertical (nada de perfumería hardcodeada), con el
clasificador determinístico de comprobantes en precedencia absoluta.

**Diseño**: adjunto elegible (stored + imagen verificada + NO propuesto como pago + flag
`tenants/{t}/config/productVision.enabled === true` literal — apagado por defecto) ⇒ job durable
`aiVisionJobs/{attachmentId}` (id determinístico ⇒ reintentos del webhook no duplican; re-envíos
son hechos nuevos). Worker (trigger `onAiVisionJob`): claim transaccional + lease 60 s + fencing
por claimId (un zombi no aplica NADA) + envío único (`pendiente→en_vuelo→enviado`; incierto ⇒
failed sin re-enviar) + intentos ≤5 + recuperación en `aiReservationMaintenance` (lazy + barrido).
Reserva `imagen_vision` (2.600 est.) ANTES del proveedor; liquidación con uso real (parcial en
error). La IA solo devuelve indicios universales (tool forzada `reportar_indicios`, zod, campos
capados, sin lugar para precios/IDs); el servidor busca con `searchCatalog` + guards vigentes
(ACTIVE, stock, deriva) y responde SOLO con datos de Firestore; sin match ⇒ honestidad; ambiguo ⇒
pregunta (máx. 3 opciones); indicios pobres ⇒ pedir nombre/marca. El caption sigue SIN viajar al
modelo (ADR-0016 §9 intacto); takeover ⇒ silencio absoluto; purgado/PDF/MIME raro ⇒ fail-closed
sin IA. Panel: campo saneado `attachment.vision` + chip discreto en Conversaciones.

**Verificación**: núcleo 28 tests (claim/fencing/envío único/desenlaces/aislamiento/PII) con
neutralización demostrada (fencing anulado ⇒ rojo ⇒ restaurado verde); E2E
`verify-ai-vision.mjs` **11/11 con el trigger REAL del emulador** (imagen sintética en Storage,
FakeAiClient por fixture, catálogo de macetas — multi-vertical), regresiones y batería completa
(ver commit).

**Superficie de deploy futura de ESTE programa** (nada desplegado): trigger `onAiVisionJob`
(CREATE), 1 match de rules (`aiVisionJobs: read,write:false`), 1 índice collection-group
`aiVisionJobs (status, leaseUntil)`, y el sweep ya viaja dentro de `aiReservationMaintenance`.
**Depende del deploy pendiente del programa anterior** (ADR-0018: rules de `aiReservations`,
2 índices y el scheduler). **La activación productiva (flag ON por tenant) requiere un programa
separado**, con el proveedor real y calibración del extractor.

**Review adversarial final** (separación comprobante/producto, idempotencia, fencing, autoridad,
multi-tenant, privacidad, no-alucinación): 3 ALTO y 3 MEDIO confirmados y **corregidos con test**:
(1) guard autoritativo de silencio pre-envío (`evaluarSilencioPreEnvio` como última operación antes
del POST — takeover tardío o bot apagado callan la visión); (2) matching estricto
(`splitByQueryMatch.pinned`: el relleno de sugerencias del buscador ya no se presenta como
identificación — `sin_match` es alcanzable); (3) reserva por INTENTO (`vision-{att}-a{n}`: los
reintentos dejaron de morir en `reserva_cerrada`); (4) el barrido re-DISPARA los jobs re-encolados
(onDocumentCreated no ve updates); (5) si el gate de comprobantes LANZA, visión no corre
(fail-closed); (6) lease 5 min + timeout 360 s del trigger (60 s producía claims solapados de
workers vivos y doble llamada paga). Refutados con evidencia: alucinación en textos, doble mensaje
físico, cruce de tenants, fuga de privacidad.

**Limitaciones honestas**: PDF/documentos y OCR de comprobantes fuera de alcance; el matching es
por búsqueda de texto sobre indicios (sin embeddings); la calidad real del extractor no está
calibrada (el E2E usa FakeAiClient); un crash exactamente entre el envío y el settle termina
`failed/envio_incierto` sin respuesta de visión (preferible al duplicado); el chip del panel no
muestra "analizando" en vivo (el estado aparece al terminar, con el refetch de 10 s); el orden
acuse-primero/análisis-después no está garantizado formalmente (dos caminos asíncronos); un job
`queued` cuyo evento de Eventarc se perdiera del todo depende del barrido horario; el gancho de
encolado de process.ts se cubre por E2E (sin unit test propio).

## AI-VISION-RELEASE-TRAIN-PREP-1 — 2026-08-14 (read-only, CERO deploy)

Plan completo en **`10-backend/docs/ai-vision-release-plan.md`**. Veredicto: **SEPARABLE CON
AJUSTE LOCAL** — la Fase 1 (índices+TTL, rules inertes, 2 CREATE + 4 UPDATE del asistente
interno/simulador) es INDEPENDIENTE de Coexistence y no toca la experiencia de App Review; la
Fase 2 (productor `onWebhookInbox` = cuota del sales agent + encolado de visión) queda BLOQUEADA
hasta el programa correctivo de migración de `automationMode`, que ahora es BICÉFALO: el audit
detecta DOS números sin el campo — `arfagi …7904` y **`meta-review …5686`** (el número de prueba
conectado durante la revisión de Meta: desplegar el gate sin migrarlo silenciaría el bot que los
revisores están probando). Baseline por superficie demostrada (Hosting 2026-08-11 ≠ Functions
2026-08-01 = `30c1687`); grafo en dos pasadas coincidente (124 exports); `onWebhookInbox` es el
ÚNICO export del release que arrastra el gate ADR-0017. Prerequisitos del correctivo: ADC en la
máquina + autorización del owner para migrar ambos números.

## AI-VISION-PRODUCER-DECOUPLE-1 — 2026-08-14 (EN PROD desde 2026-08-15 — ver DEPLOY-AI-RESERVATION-VISION-INERT-1)

El productor de jobs de visión salió de `process.ts` (que quedó **byte-idéntico** a `855d553`) y
ahora es el trigger propio **`onAiVisionProducer`** (`onDocumentUpdated` sobre la transición del
inbox a `processed` — la escribe igual el process.ts productivo viejo, con tenantId sellado y
después del gate de comprobantes). Reglas: clasificación estricta `generic_media` (`unclassified`
= gate sin decidir ⇒ fail-closed); sessionKey por índice externo (`main`⇒`active`, `wa_*`⇒propia)
sin importar process.ts; discriminador sin timers (mediaId anulado ⇒ almacenado ⇒ reintentar por
redelivery; presente ⇒ jamás almacenado ⇒ cerrar). Grafo demostrado en dos pasadas: `onWebhookInbox
→ productVision: false`; `onAiVisionProducer → process/engine: false`. **La visión completa ya no
necesita tocar `onWebhookInbox`**; lo único que sigue esperando la migración bicéfala de
`automationMode` es la cuota del sales agent (inherente al webhook). Plan de release recalculado
en `10-backend/docs/ai-vision-release-plan.md`: Fase 1c = 3 CREATE + 6 UPDATE.
16 tests nuevos del productor (rojo→verde) + E2E 12/12 con el trigger real de punta a punta.

## DEPLOY-AI-RESERVATION-VISION-INERT-1 — 2026-08-15 (EN PROD, VISIÓN INERTE, SMOKE VERIFICADO)

Deploy técnico de ADR-0018 + ADR-0019 (Fase 1 completa del plan `10-backend/docs/ai-vision-release-plan.md`),
desde `bdaffbe`, sin tocar `onWebhookInbox` ni nada que arrastre el gate ADR-0017:
- **Índices** 18→21 (los 3 `ai*` READY, 0 deletes) + 3 TTL overrides de Coexistence ACTIVE (inertes).
- **Rules** `a9c99e05`→`132712ca`: 0 líneas quitadas, 6 matches nuevos todos `if false` (2 IA + 4
  Coexistence); probes no autenticados 403 (lectura/listado/escritura); Storage rules intactas.
- **Functions 115→118**: 3 CREATE (`aiReservationMaintenance`, `onAiVisionJob`, `onAiVisionProducer`)
  + 6 UPDATE (`askInternalGrowthAssistant`, `agentTestCase{Run,Upsert,Delete}`, `simulateAgentMessage`,
  `runTenantJob`) + 0 DELETE, **sin `--force`** (el prompt de failure policy de los dos triggers con
  `retry:true` se respondió en modo interactivo `-i` — un solo `y` al prompt conocido; un prompt
  inesperado habría abortado fail-closed). `onWebhookInbox` conservó su updateTime (2026-08-01) y las
  106 funciones fuera del selector su hash exacto. Scheduler `10 * * * *` Asunción sin invoker público;
  ejecución natural observada cerrando en silencio. Hosting/`.env`/Meta/IAM intactos (hashes verificados).
- **Rollback ARMADO antes de desplegar**: worktree `30c1687` + tooling de HEAD (el build-deploy viejo
  filtraba `.env` de otros entornos), artefacto construido con las 6 UPDATE presentes y las 3 CREATE
  ausentes (la reversa no puede tocarlas; quedan inertes por flag/colecciones vacías). La cifra
  "4 UPDATE" del plan v1 quedó corregida a 6.
- **Smoke humano verificado** (simulador de Arfagi, 3er intento — los dos primeros los resolvió el
  camino determinístico, correcto y gratis; el 2º por el interceptor de ocasión que matcheó la frase
  sugerida): reserva `ventas-…` creada 15:21:30 → **liquidada** 15:21:33, est 1500 / real 3770,
  `usage.aiTokensReserved` en 0, delta del mes conciliado a token exacto contra el único aiRequest,
  cero mensajes externos/pedidos/jobs de visión; meta-review intacto (0 reservas, conexión activa,
  3 productos). Un delta previo de +3.611 quedó atribuido a un cliente real por el webhook viejo
  (contexto `whatsapp_sales_agent` — comportamiento esperado de Fase 1).
- **Observación para el canary**: `estimacionDeTokens('texto_ventas')=1500` subestima el turno
  consultivo real (~3.770 con catálogo en el prompt) — la contabilidad se reconcilia sola, pero bajo
  concurrencia el gate admite más de lo ideal; calibrar la estimación es candidato del programa de
  activación.
- **Sigue pendiente**: Fase 2 (cuota del sales agent vía `onWebhookInbox`) BLOQUEADA hasta la
  migración bicéfala de `automationMode` (arfagi `…7904` + meta-review `…5686`); Fase 3 = canary de
  visión con proveedor real, programa aparte con aprobación separada. Flag de visión APAGADO en los 3
  tenants.

## AI-VISION-PROVIDER-CANARY-ARFAGI-1 — 2026-08-15 (CANARY EJECUTADO — BLOQUEANTE REAL DOCUMENTADO — ESTADO RESTAURADO)

Primer canary del proveedor real de visión en arfagi, con aprobación del owner y precondiciones
extra (sesión del remitente sin takeover — hubo que LIBERAR un takeover residual del 2026-08-10
del propio tester —, sin contexto de pago, sin pedido abierto). Activación quirúrgica del flag
(`exists=false` + updateMask enabled/updatedAt) e imagen sintética inocua (frasco dibujado
"ARMAF ODYSSEY MEGA", sin PII/montos).

**Lo que FUNCIONÓ por contrato (proveedor real, producción):** producer → job único (tenant
sellado, sessionKey `active` correcta), claim+lease intento 1, reserva `vision-att_…-a1` (est
2.600) → proveedor real → **liquidada con uso real 2.529** (delta del mes conciliado a token
exacto), extracción + catálogo con guards, job saneado (solo ids/estados), cero duplicados,
cero pedidos/pagos/carrito, meta-review/credipower intactos.

**El BLOQUEANTE:** la respuesta de visión NO llegó al cliente. El cliente de WhatsApp del
ARTEFACTO NUEVO aplica el permiso de canal de ADR-0017 en modo automático y el número `…7904`
tiene `automationMode` AUSENTE ⇒ `WhatsApp: envío BLOQUEADO por el permiso del canal (ADR-0017)`
⇒ job `failed / envio_incierto` sin reintento (correcto: jamás duplicado). La nota de riesgo del
plan ("su guard es silencio.ts") era INCOMPLETA: el worker no consulta automationMode, pero el
whatsappClient compartido del artefacto nuevo SÍ — y fail-closed. **Consecuencia: la ENTREGA de
visión en arfagi (y meta-review) requiere la migración bicéfala de `automationMode` — la misma
que bloquea la Fase 2.** El bot común no lo sufre porque `onWebhookInbox` corre el artefacto
viejo (pre-gate).

Kill-switch inmediato al detectar la desviación (enabled=false con precondición fresca) y
restauración final a **AUSENTE exacto** verificada contra la baseline. Rastros históricos
legítimos: 1 job terminal saneado + 1 reserva liquidada. Próximo paso natural: el programa
correctivo de migración `automationMode` (arfagi `…7904` + meta-review `…5686`) y recién
después re-canary de visión.

## WHATSAPP-AUTOMATIONMODE-DUAL-MIGRATION-AND-VISION-RECANARY-1 — 2026-08-15 (MIGRACIÓN EN PROD + RE-CANARY EXITOSO)

**Migración dual `automationMode` → `live` EJECUTADA** con la herramienta oficial
(`migrarModoAutomatizacion`, dry-run→apply, prefijo `GCLOUD_PROJECT` siempre): arfagi `…7904` y
meta-review `…5686`, ambos `written` — un solo campo en cada ASSET, con precondición fresca;
índice `no_declara` (NO tocado); conexiones con updateTime byte-idéntico a la baseline; cero
Meta/tokens/WABA/webhooks; credipower fuera por construcción. ADC habilitada por el owner
(gcloud application-default) tras detención fail-closed documentada; primer dry-run de
meta-review rechazado `not_found` por un PNID reconstruido de memoria — corregido leyendo el
identificador real del índice (lección: los identificadores se LEEN, no se recuerdan). Checks
del runbook en verde: dual 20/20 + coexistence 51/51 (emulador, herramienta real). Rollback
documentado `--mode inactive --apply` por número: funcionalmente equivalente al estado inicial
fail-closed pero NO byte-idéntico (el campo estaba AUSENTE). El webhook productivo viejo ignora
el campo ⇒ cero cambio de comportamiento visible hoy; lo que se desbloquea es el artefacto
nuevo (visión + Fase 2).

**RE-CANARY de visión EXITOSO** (mismo programa, precondiciones del owner verificadas — takeover
residual del tester liberado antes): job único `att_45eba9d9…` `succeeded` + `envio=enviado`
(terminal NO ambiguo, intento 1, 16 s), reserva `vision-…-a1` liquidada (est 2.600 / real
2.507), espejo en 0, UNA llamada al proveedor real, adjunto `generic_media`, respuesta de
visión entregada por el canal correcto (`via …7904`) y UNA sola: el desenlace fue el honesto
`sin_match` ("no encontré ese producto… ¿me decís el nombre o la marca?") — el matcher estricto
no ancló "ARMAF ODYSSEY MEGA" (imagen sintética) contra "ARMAF ODYSSEY MEGA LIMITED EDITION
EDP" del catálogo. **Deuda de CALIBRACIÓN extractor/matcher para el programa de activación**;
el ciclo técnico está demostrado de punta a punta. Cero pedidos/pagos/carrito/comprobantes;
meta-review y credipower intactos. Gestión de ventana: el flag se apagó durante la espera del
owner (20 min sin imagen) y se reencendió al confirmar — cero exposición a clientes reales.
`productVision` RESTAURADO a AUSENTE (los 3 tenants); `automationMode=live` SE CONSERVA en los
dos números (programa cerrado en verde). **Fase 2 (deploy de `onWebhookInbox`) queda
DESBLOQUEADA y pendiente SOLO de aprobación del owner.**

## AI-PHASE2-MATCHER-AND-RESERVATION-HARDENING-1 — 2026-08-15 (EN REPO — NO DESPLEGADO)

Los dos pendientes demostrados por producción, corregidos con test rojo primero + review
adversarial fresco (0 ALTO, 3 MEDIO, 1 BAJO — TODOS corregidos):
- **Matcher de identificación** (`catalog/matchIdentificacion.ts`, puro y multi-vertical):
  `identificarProducto` ⇒ `matched|ambiguous|no_match` con umbral + **evidencia estructural**
  (≥2 tokens exactos, o 1 exacto + consulta íntegra ≥2 tokens) + **margen inequívoco** vs el 2º.
  `decidirDesenlace` de visión ya no identifica por conteo ("estar solo" jamás identifica; el
  review probó 'odys'/'lattafa' ⇒ hoy no_match). Conteo/posición/precio jamás deciden; empates ⇒
  repreguntar. NOTA HONESTA: el sin_match del canary ARMAF seguirá mientras el guard de deriva
  excluya al producto (conflicto de precio local ₲250.000 vs feed — pendiente del owner).
- **Reserva contextual del sales agent**: `estimarTurnoDeTexto` (chars/3 del system+historial+
  tools + colchón por ronda + salida; piso 1500, techo 16k) reemplaza la estática que quedó corta
  (1.500 vs 3.770 reales). Contrato honesto: cubre el turno típico ~2.5-3×; el peor caso
  multi-ronda lo reconcilia la liquidación. `reservarTurnoDeIa` clampea al límite efectivo chico
  (jamás "antes podía, ahora nunca"). `texto_interno` sigue estático. Piso práctico del agente
  ~9.5k ⇒ starter 50k pasa de ~33 a ~5 turnos CONCURRENTES admisibles (degradación con gracia:
  fallback honesto) — anotado para pricing.
- **Integración Fase 2 verificada**: sección 7/7 nueva de `verify-ai-reservation.mjs` maneja el
  TRIGGER real `onWebhookInbox` en emulador — determinístico ⇒ respuesta y CERO reservas; turno
  de IA ⇒ UNA reserva `ventas-*` liquidada con uso real y espejo en 0; `automationMode` AUSENTE ⇒
  `ignored` por el gate, sin respuesta ni reserva. (Fix de arnés: customerId con dígitos puros —
  process.ts sanea `from`.)
- **Selector mínimo del release (grafo compilado)**: **10 UPDATE + 0 CREATE + 0 DELETE** =
  `onWebhookInbox` + las 9 de Fase 1c (todas alcanzan los módulos cambiados; `devMessage` fuera
  por dev-only). Smoke previsto del release: mensaje consultivo real por WhatsApp ⇒ reserva
  `ventas-{wamid}` liquidada; mensaje "hola" ⇒ cero reservas; imagen ⇒ job de visión (flag
  mediante).

## DEPLOY-AI-PHASE2-SALES-RESERVATION-1 — 2026-08-16Z (EN PROD — FASE 2 COMPLETA, SMOKES VERDES)

Deploy mínimo del hardening desde **`6f75601`** con selector derivado del grafo compilado:
**10 UPDATE + 0 CREATE + 0 DELETE** — orden: primero las 9 de soporte
(`askInternalGrowthAssistant`, `agentTestCase{Run,Upsert,Delete}`, `simulateAgentMessage`,
`runTenantJob`, `aiReservationMaintenance`, `onAiVisionJob`, `onAiVisionProducer`), verificadas
ACTIVE con updateTime nuevo y cero efectos, y **`onWebhookInbox` al FINAL** (su update activa la
reserva para el inbound real). `devMessage` alcanzada por el grafo pero EXCLUIDA a propósito
(dev-only, prohibida): queda corriendo su artefacto viejo. Rollback ARMADO antes del deploy y
conservado: worktrees `rollback-bdaffbe` (las 9) + `rollback-30c1687` (`onWebhookInbox`), ambos
con allowlist de env limpia. Baseline productiva completa pre-deploy en el registro del programa.

**Smokes controlados en arfagi, atribuidos por wamid y ventana (no por deltas):**
- "hola" ⇒ processed por el webhook NUEVO, UNA respuesta, **CERO reserva para ese wamid**, cero
  aiRequests en la ventana, espejo 0 — lo determinístico sigue costando cero.
- Turno consultivo real ⇒ reserva `ventas-{wamid}` **creada con estimación contextual 9.775**
  (dentro de piso 1500/techo 16k) → **liquidada con uso real 3.833**, conciliado A TOKEN EXACTO
  con el ÚNICO aiRequest (contexto `whatsapp_sales_agent`), espejo de vuelta en 0, UNA sola
  respuesta con waMessageId real. Cero visión, cero pedidos/pagos/carrito, meta-review y
  credipower sin un byte de cambio (revisión de Meta en curso, preservada).

Post-deploy: 118 functions (las 117 no seleccionadas con updateTime intacto),
`automationMode='live'` conservado en `…7904` y `…5686`, visión AUSENTE ×3, `.env` hash
idéntico, cero errores en logs. Con esto el TREN DE RELEASE de ADR-0018/0019 queda completo:
cuota transaccional EN PROD para TODAS las superficies (sales agent incluido) y visión
desplegada de punta a punta INERTE. **Deuda vigente antes de activar visión**: reconciliar el
conflicto de precio de Odyssey (source-of-truth) — sin eso, el guard de deriva seguirá
excluyendo al producto insignia de cualquier identificación.

## META-ONBOARDING-SELF-SERVICE-1 — 2026-08-17 (EN REPO — NO DESPLEGADO)

**ADR-0020**: onboarding Meta autoservicio — el ciclo owner-facing existente (Embedded Signup +
nonce + code server-side + SecretStore + discovery transaccional) se CONSOLIDÓ cerrando los 11
gaps del mapa (sin sistema paralelo). Backend: selección de WABA con estado PENDIENTE (secreto
determinístico + nonce `waba_selection` + callable NUEVA `completeMetaConnectWaba`; el error
`waba_selection_required` lleva la lista saneada), verify/disconnect por `connectionId`
(`main`/`wa_*` — el owner ya da de baja sus números de Coexistence), desconexión de `main`
TRANSACCIONAL (índice+assets+conexión en una tx; secreto después, compensable — y retira también
el pendiente huérfano), guard de colisión a nivel WABA (`metaExternalIndex/waba_{id}`, misma tx,
ausencia=libre con ventana documentada), rate-limit de emisión de nonces (10/10min por tenant),
TTL de `metaOAuthStates` (fieldOverride), auditoría con actor + acciones `meta.verified`/
`meta.reconnected`. Panel: selector de WABA accesible, confirmación fuerte tipeando DESCONECTAR
(aclara que NADA se borra dentro de Meta), `lastConnectError` traducido (jamás crudo),
antigüedad de verificación con aviso >7 días, acciones por número, RBAC fijado por tests.

**Verificación**: rojo→verde por gap (backend 46 rojos → meta 92 archivos/1604 tests; web 17
rojos → 521/521); batería completa typecheck/lint/build/tests/diff-check en 0; E2E fase4b-meta
**27/27** con la sección AUTOSERVICIO nueva (viaje completo: 2 WABAs → selección → conexión →
verify main+wa_ → reconexión inválida conserva la anterior → válida ⇒ `meta.reconnected` →
disconnect wa_ → disconnect main transaccional) + regresiones coexistence 51/51, dual 20/20,
multi-number, fase4-whatsapp, cutover, wm1-manual y d1 en verde (dos arneses desactualizados
corregidos: WM1.9 y el check 11/16 de fase4b — semántica ADR-0017 vigente). **Review
adversarial**: 1 MEDIO (el modal disfrazaba todo failed-precondition de "venció" — ahora solo
`details.reason='seleccion_invalida'` pide rehacer login y el resto conserva su mensaje) + 2
BAJO (pendiente huérfano ahora se retira también al desconectar; ventana de reclamo de WABA
documentada en el ADR con nota operativa: reconectar tenants existentes tras el deploy) — TODOS
corregidos.

**Deuda explícita (ADR-0020)**: G5 verificación periódica programada (scheduler) diferida.
**Superficie estimada del futuro deploy**: 1 CREATE (`completeMetaConnectWaba`) + UPDATE de la
familia meta-connect + `firestore:indexes` (TTL nuevo) + Hosting (panel) — selector exacto lo
emitirá release-audit en su programa; **el frontend de Meta Review NO se toca mientras la
revisión siga en curso**.

## CONVERSATIONS-WHATSAPP-UX-1 — 2026-08-18 (EN REPO — NO DESPLEGADO)

**ADR-0021**: la pantalla `/conversations` pasó a bandeja profesional tipo WhatsApp Business con
identidad propia, reutilizando primitivas (cero sistema paralelo). **Backend**: (1) recibos del
proveedor — los `value.statuses` que se DESCARTABAN (`parseWebhook.ts:495`) ahora fluyen por el
camino real (productor `webhookHttp` escribe un doc de inbox POR recibo, clave idempotente
`status_{estado}_{wamid}`; `aplicarReciboDeEntrega` correlaciona por `waMessageId` y aplica
transición monotónica transaccional `pending<sent<delivered<read`, `failed` terminal solo antes
de delivered; jamás se infiere «leído»; cero costo de cuota IA — §7 de verify-ai-reservation
respetado); `profileName` de `contacts[]` capturado sin pisar `name` CRM; salientes reales nacen
`deliveryStatus:'pending'` (viaMock/system sin estado); un entrante desarchiva. (2) Media
saliente — `WhatsAppClient` gana `sendImage`/`sendDocument` (3 implementaciones),
`uploadWhatsappMedia` (POST /{pnid}/media multipart nativo Node 20), callable
`conversationSendAttachment` (imagen jpeg/png/webp ≤5 MB, PDF ≤7 MB, base64; tope pre-decode;
magic bytes verificados; SVG/HTML/ZIP/EXE rechazados; filename saneado; caption en el DOC de
adjunto — jamás al historial ⇒ jamás a IA; idempotencia `outboundOps` con reserva transaccional
+ lease 5 min + replay coherente `operation_mismatch`; compensación sin delete físico). Texto y
media comparten UN guard (`resolverEnvioManual`: canal fail-closed, takeover/override, gate de
cotización — evaluado también sobre el caption —, PNID exacto). Saliente JAMÁS comprobante:
doble cerrojo (nace `generic_media` + `attachment_outbound` en receipt-gate). (3) Ciclo de vida
y vínculo — 10 callables nuevos (`conversationArchive/Unarchive/SoftDelete/Restore/Assign/
MarkRead/LinkClient/UnlinkClient/CreateClient`, `customerSearch`) con matriz §7 re-verificada en
el núcleo, transaccionales e idempotentes, 9 acciones de audit nuevas; vínculo sin cadenas EN
AMBAS DIRECCIONES ni sobre eliminadas; softDelete reversible que bloquea envíos y jamás borra
nada físico; búsqueda server-side paginada (≤20, cursor opaco validado). **Panel**: page
reescrita en 10 componentes (lista con buscador + 7 filtros, historial con separadores
Hoy/Ayer/fecha, ticks accesibles ✓/✓✓/✓✓-subrayado+color/error con aria-labels, paginación
hacia atrás con scroll estable, botón «ir al más reciente», compositor con emojis propios +
adjuntos con preview/progreso/reintento + borradores por conversación limpiados en logout,
panel de info con avatar iniciales, `~nombre` de perfil no confirmado, teléfono ENMASCARADO,
vínculo y asignación), MANAGER ve el módulo (fix roles.ts), estados completos y a11y
(ModalShell/focus trap/Escape/aria-live).

**Verificación**: RED-first en todo; batería completa typecheck/lint/build/tests/diff-check en
0 (functions 3302+ tests, web 632/632); E2E NUEVO `verify-conversations-inbox` **42/42** en
emuladores limpios (perfil, paginación, takeover+no-leídos+markRead, texto+imagen+PDF con
idempotencia, hostiles MIME/SVG/oversize sin efectos, recibos reales sent→delivered→read con
tardíos/failed/desconocidos ignorados, vínculo, búsqueda, asignación, archivado/desarchivado
automático, softDelete que bloquea y restaura, cross-tenant, regreso del bot) + regresiones:
human-handoff 11/11, handoff2 8/8, attachments 98/98, shipping-quote-saga 81/81,
ai-reservation 14/14. **Visual en navegador real** (emuladores sembrados, panel Next dev):
desktop 1600, laptop 1280 y móvil 375 verificados estructuralmente (list-or-chat, volver,
sin overflow, info panel, teléfono enmascarado); 3 hallazgos vivos corregidos (keys duplicadas
entre hermanos que acumulaban 41 historiales montados; «marcar comprobante» ofrecido sobre
salientes con textos de «archivo del cliente»; plural del badge). **Review adversarial**:
**0 ALTO**; 1 MEDIO (cadena inversa del vínculo) + 6 BAJO (lease de reserva, replay
incoherente, vínculo sobre eliminada, markRead creaba docs fantasma, borradores tras logout,
ticks solo-color) — **TODOS corregidos**; P1 (lote de statuses — mitigado por firma del
webhook), P2 (bytes de Storage tras compensación — sin GC) y P3 (nombre de perfil ambiguo —
mitigado con `~`) documentados en el ADR.

**Deploy futuro estimado**: 11 CREATE (los callables nuevos) + UPDATE de `metaWebhook`/
`onWebhookInbox` (recibos+perfil), `conversationSendManualMessage` (guard compartido),
callables de adjuntos/receipt-gate (cerrojo saliente) + Hosting (panel). **Sin índices
compuestos nuevos, sin cambios de Rules, sin TTL nuevos.** Deudas ADR-0021: polling (no
realtime), filtros client-side sobre ventana de 100, IG/Messenger solo lectura, GC de
salientes fallidos.

## CATALOG-AUTHORITY-SELF-SERVICE-1 — 2026-08-18 (EN REPO — NO DESPLEGADO)

**ADR-0022**: autoridad de catálogo autoservicio SOBRE la base desplegada de ADR-0015 (nada se
renombra; `sourceOfTruth` sigue muerto). Eje declarado nuevo `catalogSync.relationship`
(`none|mirror|managed`) + contrato derivado puro `deriveCatalogAuthority` (`authority`
vendeyapy|meta|external desde `ownership.model`+`external.kind`; invariante `botCatalog:
local_mirror`). Combinaciones: A vendeyapy+none (local-sin-Meta — por fin expresable),
B vendeyapy+managed (rieles vigentes), C meta+mirror, D external+mirror (arfagi);
external+managed inválido. Derivación legacy determinística sin backfills (sin config ⇒ A;
arfagi ⇒ D; credipower intocado; `mode` NO participa — `enabled+off` = managed con envío
apagado). **Transición**: `metaCatalogAuthorityPreview/Apply` (OWNER/ADMIN; planHash+TTL 10
min+uso único+actor, patrón real de meta/catalog.ts; `concurrent_change` por huella canónica de
TODO catalogSync; update mask estricto — solo `relationship` y, si cambia el modelo,
`ownership` re-normalizado; jamás enabled/mode/catalogId/productos/jobs/live/opt-ins; audit
`meta.catalog_authority_changed`; runs en `metaCatalogAuthorityRuns` sin secretos). **Gating
por relación** en todos los callables Meta de catálogo (none ⇒ nada Meta; mirror ⇒
import/reconcile/verify sí + dry-run `catalogSync` read-only sí, escrituras no; managed ⇒
rieles vigentes; lecturas de estado sin gate) + schedulers por tenant con aislamiento; RBAC
corregido: `catalogSyncApply` OWNER-only también en backend (antes MANAGER podía). **Panel**:
selector «Quién administra tu catálogo» (4 opciones comprensibles, preview visual con bloqueos
traducidos y links a requisitos, confirmación fuerte tipeando CAMBIAR para salir de managed,
frescura del espejo solo en mirror, honestidad del conector externo sin botón falso, roles §6),
gating de acciones espejo, edición consciente de campos gobernados (incluye `status`→
disponibilidad) con confirmación explícita y aviso genérico si el ownership no cargó.

**Review adversarial**: 1 ALTO (jobs de outbox no-terminales bajo mirror/none quedaban zombis
irrecuperables — scheduler salteaba hasta el sweep — y bloqueaban el REGRESO a managed:
deadlock) + 1 MEDIO (carrera catalogSyncApply↔authorityApply que encolaba jobs bajo none) + 6
BAJO — **TODOS corregidos**: gate del scheduler solo al drain (sweep/confirmación siempre),
discard des-gateado (cancelación local), re-derivación de relación DENTRO de la tx de encolado
+ re-check de sync-run en el apply, opt-out de verificación solo sin fuente comercial, re-check
de conexión en apply, dry-run bajo mirror, detección de `status` gobernado, textos honestos.

**Verificación (exit codes reales)**: batería completa typecheck/lint/build/test/diff-check en
0 (functions: suites de catálogo 38 archivos / 1052 tests; web 695/695). E2E NUEVO
`verify-catalog-authority` **23/23** en emulador limpio (derivación local-sin-Meta con BOT
respondiendo sin Meta, clasificación legacy, preview→apply con update-mask asertado por valor,
replay/mismatch/concurrent, gates none/mirror con kind exacto, dry-run mirror permitido, dos
tenants en modos distintos simultáneos, cero deletes/jobs, credipower jamás tocado, runs sin
secretos) + regresiones: verify-meta-catalog **194/194** (3 checks superseded honestos con
aserciones MÁS fuertes + 2 preservados vía fixes de derivación/orden), ownership-model,
catalog-onboarding, fase4b-meta y conversations-inbox en verde.

**Deploy futuro estimado**: 2 CREATE (`metaCatalogAuthorityPreview/Apply`) + UPDATE de la
familia metaCatalog\* (gates), `runTenantJob` (RBAC+gate), schedulers de outbox/verificación,
`metaCatalogOwnershipStatus` (bloque authority) + Hosting (panel). **Sin índices compuestos
nuevos, sin cambios de Rules** (los runs caen en el default deny; match explícito queda
cosmético). **Deudas → programa del conector externo**: selector de `catalogId`, conector
directo URL CSV/JSON, TTL/limpieza de runs de autoridad, match explícito de rules, doc para
tenants locales con productos legacy sin quality (re-guardar recalcula).
