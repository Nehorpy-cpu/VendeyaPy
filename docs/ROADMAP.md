# ROADMAP — AI_AFG (Agente WhatsApp Perfumería)

> **Metodología:** desarrollo incremental. Se trabaja UNA fase a la vez.
> Cada fase se divide en **~2 sub-fases** (preferencia del owner). Si una fase tiene un
> tercer paso genuinamente riesgoso, se avisa y se separa; si no, el default son 2.
> Solo la fase actual está desglosada. Las siguientes se desglosan al cerrar la anterior.

**Última actualización:** 2026-06-17

---

## 🆕 TRACK B — Panel SaaS multiempresa (track principal actual; Meta bloqueado)

> Ver ADR-0005. Panel admin (CRM) sobre `apps/web` (Next.js) + Firestore. Cada fase en ~2 sub-fases.

| Fase | Nombre | Estado |
|------|--------|--------|
| **P1** | Fundación: auth + roles (SuperAdmin/Owner/Seller) + aislamiento por empresa + cáscara del panel | ✅ Completada |
| **P2** | Catálogo como fuente de verdad (productos + `costPrice` + `aiNotes` + categorías + imágenes) | ✅ Completada |
| **P3** | Pedidos con costo/ganancia + Dashboard (ventas, ingresos, ganancia, margen, tops) | ✅ Completada |
| **P4** | Configuración del agente (identidad, tono, reglas, FAQ, bancos, envíos, vendedores, control bot) + chat de prueba | ✅ Completada |
| **P5** | Clientes + Conversaciones/Bot (historial de mensajes + handoff en UI) | ✅ Completada |
| **P6** | 🔒 Privacidad financiera: `productFinancials`/`orderFinancials` + reglas (el vendedor no ve costo/ganancia ni desde la base) | ✅ Completada |
| **P7** | Dashboards baratos con agregados (`stats/public`+`private`, `statsDaily`, `platformStats` por trigger/job) | ✅ Completada |
| **P8** | Promotion Strategy (promos + estados/fechas + sugerencias por reglas → `insights`) | ✅ Completada |
| **P9** | Hardening multi-tenant + asignación de vendedores + seeders demo + criterios de aceptación | ✅ Completada — **Track B COMPLETO** 🎉 |

> **Reubicado (por el plan unificado 2026-06-17):** la vieja "P6 Campañas" y "P7 analíticas de
> anuncios" pasaron al **Track D (Meta)**. La "P10 Hardening" es ahora **P9**.
> **Integración tienda PHP** (`arfagi_php` consume el catálogo): independiente, se hace cuando haya
> acceso al código PHP; no bloquea las demás fases (ver ADR-0004).

### 🔌 TRACK D — Integración Meta (NUEVO — modo manual→real; ver ADR-0009)

> Conectar **Meta Business Suite**: WhatsApp + Instagram DM + Messenger, Meta Ads, catálogo y
> Conversions API. Diferencial: **atribución anuncio → conversación → pedido → ganancia real**.
> Se diseña en **modo manual/demo** (Meta bloqueado) y se "enchufa" al pasar el gate de verificación.
> **Absorbe y reordena F1 (WhatsApp Cloud API) y F7.** Tokens en Secret Manager, nunca en Firestore.

| Fase | Nombre | Estado |
|------|--------|--------|
| **D1** | Centro de Integración Meta: `metaConnections` (+ tokens seguros) + `metaAssets` + estados de conexión en el panel | ⏳ |
| **D2** | Webhooks + omnicanal: `metaWebhookInbox` (TTL) + `metaExternalIndex` + `processMetaWebhook` + `channel` (whatsapp/instagram/messenger). Incluye ex-F1 | ⏳ |
| **D3** | Meta Ads (solo lectura): campañas/adsets/ads + `metaAdInsightsDaily` por jobs + snapshots diarios | ⏳ |
| **D4** | Catálogo → Meta: `syncToMeta` + `syncProductToMeta` + `metaCatalogSyncLogs` | ⏳ |
| **D5** | Atribución: anuncio → conversación → cliente → pedido → ganancia (`attributionType`/confidence) | ⏳ |
| **D6** | `businessEvents` + Conversions API (`metaConversionEvents`, `sendConversionEventToMeta`) | ⏳ |

### 🚀 TRACK C — Growth Copilot (capa diferenciadora, DESPUÉS del núcleo del panel)
> Asistente de decisiones: "qué hacer para vender más y ganar más". Reglas + jobs que precalculan
> (Firestore), IA solo para redactar. Ver ADR-0006 y `docs/growth-copilot-diferenciador.md`.
> **Preparar durante P1–P10:** campos de tracking (`source/utm*/couponCode`) en pedidos/
> conversaciones/clientes y guardar historial de mensajes — para que estos módulos tengan datos.

| Fase | Nombre | Estado |
|------|--------|--------|
| **P11** | Tracking propio sin Meta (source/UTM/cupones/QR por campaña) | ⏳ (se hace junto al Track D / atribución) |
| **P12** | Score de clientes + segmentación (job + reglas) | ✅ Completada |
| **P13** | Centro de Decisiones / Growth Copilot + "Acciones de hoy" (`insights`) | ✅ Completada |
| **P14** | Follow-ups inteligentes (`followUpTasks`, tareas sugeridas, sin envío auto) | ✅ Completada |
| **P15** | Modo Ganancia del agente (margen/prioridad/descuento + reglas de venta) | ✅ Completada |
| **P16** | Auditoría del agente (`agentAudits`) | ⏳ |
| **P17** | Simulador del agente — escenarios guardados (`agentTestCases`) | ⏳ |
| **P18** | Biblioteca de respuestas ganadoras (`winningReplies`) | ⏳ |
| **P19** | Onboarding rápido + plantillas por rubro | ⏳ |

### ⚡ P1 — Fundación del panel (sub-fases, de a una)
| Sub-fase | Acción | Estado |
|----------|--------|--------|
| **P1.1** | Modelo de auth/roles: agregar rol `SELLER`, matriz de permisos, ADR-0005, doc de roles. Verificar typecheck. | ⚡ |
| **P1.2** | Cáscara del panel en Next.js: login (Firebase Auth) + contexto de rol/empresa + shell (sidebar/header/selector de empresa) + guards de ruta + seed de usuarios de prueba. | ✅ |

---

## Leyenda de estado

- ✅ Completada
- ⚡ EN CURSO (fase activa — desglosada en sub-fases)
- ⏸️ Pausada (bloqueada por algo externo)
- ⏳ Pendiente (alto nivel, se desglosa al llegar)
- 🚫 Diferida (fase 2 — créditos, ver ADR-0002)

---

## Mapa de fases (alto nivel)

| Fase | Nombre | Estado |
|------|--------|--------|
| **F0** | Preparación del entorno y estructura | ✅ Completada |
| **F1** | Setup WhatsApp Cloud API (canal oficial Meta) | ⏸️ Pausada → **absorbida en Track D / D2** (ADR-0009) |
| **F2** | Diseño de datos (schema Firestore tenant perfumería) | ✅ Completada |
| **F3** | Entorno ejecutable local + carga del catálogo | ✅ Completada |
| **F4** | Bot conversacional básico (recibe → responde) | ✅ Completada |
| **F5** | Catálogo + carrito (el bot vende) | ✅ Completada |
| **F6** | Cobros — link de pago (simulado) | ✅ Completada |
| **F6b** | Pago por transferencia + comprobante + handoff a vendedor | ✅ Completada |
| **F7** | Integración Meta Business Suite (CAPI + catálogo + click-to-WA) | ⏳ → **absorbida en Track D / D3–D6** (ADR-0009) |
| **F8** | Posventa + seguimiento + fidelización | ⏳ Pendiente |
| **F9** | Testing E2E + salida a producción | ⏳ Pendiente |

> **Nota de canal:** se usa WhatsApp Cloud API oficial. OpenWA fue descartado (ver ADR-0003).
> **Nota de hosting:** arquitectura híbrida — tienda **PHP+MySQL a medida** (`arfagi_php`) en
> Hostinger (fuente del catálogo) + backend del bot en Firebase. NO es WooCommerce (ver ADR-0004).
> Nueva sub-fase a insertar: sincronización MySQL `products` → Firestore (export CSV / endpoint JSON).

---

# ✅ FASE COMPLETADA: P15 — Modo Ganancia del agente

Con el "Modo Ganancia" activado, el bot prioriza los productos más **rentables** al recomendar (lee
costo/prioridad de `productFinancials` del lado del servidor; el cliente nunca ve el costo). La dueña
activa el modo en la config del agente y puede fijar "Prioridad de venta" por producto.

**Hecho:** `AgentConfig.profitMode`; `ProductFinancials.priorityScore/targetMargin/allowDiscount/
maxDiscountPercentage`; `searchCatalog` rerankea por margen + prioridad cuando `profitMode`; toggle
"💰 Modo Ganancia" en `/agent`; campo "Prioridad de venta" en el form de producto.

**Verificado:** `typecheck` EXIT 0 · build de producción · `verify-p15.mjs` **3/3** (OFF = relevancia;
ON = el más rentable primero; el costo nunca aparece en la respuesta al cliente).

**Antecede:** P14 — Follow-ups. **🎉 Track B (P1–P9) COMPLETO.**
**Próxima (pendiente, no iniciada):** P16 — Auditoría del agente (`agentAudits`).

---

# ✅ FASES COMPLETADAS: F4 (bot) · F5 (catálogo+carrito) · F6 (cobro link simulado)

- **F4:** motor de conversación con sesión en Firestore (`conversation/engine.ts`, `devMessage`).
- **F5:** el bot muestra perfumes reales (`catalog/search.ts`) y arma carrito (`conversation/cart.ts`),
  todo persistido en la sesión. Probado E2E contra el emulador.

---

# ⏸️ FASE PAUSADA: F1 — Setup WhatsApp Cloud API

> Pausada porque el owner no puede acceder a Meta/Facebook por ahora. Se retoma cuando
> recupere el acceso. Las sub-fases ya están definidas y listas.

**Objetivo:** tener el canal oficial de WhatsApp listo para que el backend pueda recibir
y enviar mensajes — número dedicado registrado, app de Meta creada, tokens obtenidos,
y webhook respondiendo el handshake de verificación de Meta.

**Modo:** DESARROLLO sin verificación de Meta Business (decisión 2026-06-10). Se usa el
**número de prueba gratuito** de Meta + hasta ~5 destinatarios de prueba. La verificación de
Meta Business + número propio se difiere al **gate de F7** (antes de ads/producción).

**Criterio de "fase terminada" (Definition of Done):**
- [ ] App de WhatsApp creada en developers.facebook.com (modo desarrollo)
- [ ] Número de prueba de Meta activo + destinatario(s) de prueba agregados
- [ ] Access token (temporal de dev sirve para empezar) + Phone Number ID guardados
- [ ] `verify token` propio definido y documentado
- [ ] Webhook desplegado que responde el `GET` de verificación de Meta (hub.challenge)
- [ ] Mensaje de prueba recibido en el webhook (entrante) y uno enviado (saliente) OK

### Sub-fases de F1

| Sub-fase | Acción | Estado | Riesgo |
|----------|--------|--------|--------|
| **F1.1** | Crear app en developers.facebook.com + agregar producto WhatsApp + obtener número de prueba | ⏳ | Bajo |
| **F1.2** | Agregar destinatario(s) de prueba + guardar App ID, Phone Number ID y token temporal | ⏳ | Bajo |
| **F1.3** | Definir `verify token` propio + documentar config en `50-whatsapp-cloud-api/config/` | ⏳ | Cero |
| **F1.4** | Codear webhook mínimo en `10-backend` (GET verificación + POST recepción) | ⏳ | Medio |
| **F1.5** | Desplegar webhook (túnel cloudflared/ngrok para dev) y registrarlo en Meta | ⏳ | Medio |
| **F1.6** | Prueba E2E: recibir un mensaje de test + enviar uno saliente. Commit | ⏳ | Bajo |

**Diferido al gate de F7 (producción):** verificación de Meta Business, registro de número
propio dedicado, access token permanente (System User), display name approval, subir tiers.

**Regla de oro de F1:** si una sub-fase falla, NO se pasa a la siguiente. Se para, se diagnostica
el error en español simple, se proponen 2 opciones, y el owner elige. Nada de "ya va a funcionar".

**Nota:** F1.1–F1.3 son **config en Meta** (las hacés vos, yo te guío). F1.4–F1.6 son
**código** (las hago yo, vos validás).

---

# Fases siguientes (alto nivel — se desglosan al llegar)

### F5 — Catálogo + carrito
El bot muestra productos, arma carrito, calcula totales. Acá empieza a vender.

### F6 — Cobros
Generación de links de pago (Bancard/Tigo Money/Stripe) y confirmación de pago.

### F7 — Integración Meta Business Suite
**⚠️ GATE DE VERIFICACIÓN:** antes de esta fase se completa la verificación de Meta Business,
el registro del número propio dedicado, el access token permanente (System User) y el display
name approval. Recién con eso: Conversion API, catálogo sincronizado, click-to-WhatsApp ads,
audiencias de retargeting. La verificación puede iniciarse en paralelo desde cualquier momento
(tarda 1-3 días del lado de Meta).

### F8 — Posventa
Seguimiento de envío, mensajes de fidelización, NPS.

### F9 — Testing E2E + producción
Pruebas de punta a punta (ad → conversación → venta), hardening y publicación.

---

## Cómo se actualiza este roadmap

1. Cuando se cierra una fase: marcar ✅, mover la siguiente a ⚡, y **desglosarla en sub-fases** acá.
2. Cada decisión grande genera un ADR en `00-architecture/decisions/`.
3. Las sub-fases se reflejan también en el sistema de tareas de la sesión (TaskCreate).
