# ROADMAP — AI_AFG (Agente WhatsApp Perfumería)

> **Metodología:** desarrollo incremental. Se trabaja UNA fase a la vez.
> Solo la fase actual está desglosada en sub-fases. Las siguientes se desglosan
> recién cuando se cierra la anterior — así evitamos planificar sobre supuestos
> que cambian, y evitamos fallas por avanzar en muchos frentes a la vez.

**Última actualización:** 2026-06-10

---

## Leyenda de estado

- ✅ Completada
- ⚡ EN CURSO (fase activa — desglosada en sub-fases)
- ⏳ Pendiente (alto nivel, se desglosa al llegar)
- 🚫 Diferida (fase 2 — créditos, ver ADR-0002)

---

## Mapa de fases (alto nivel)

| Fase | Nombre | Estado |
|------|--------|--------|
| **F0** | Preparación del entorno y estructura | ✅ Completada |
| **F1** | Setup WhatsApp Cloud API (canal oficial Meta) | ⚡ EN CURSO |
| **F2** | Diseño de datos (schema Firestore tenant perfumería) | ⏳ Pendiente |
| **F3** | Infra unificada (docker-compose: n8n + emuladores Firebase) | ⏳ Pendiente |
| **F4** | Bot conversacional básico (recibe → responde) | ⏳ Pendiente |
| **F5** | Catálogo + carrito (el bot vende) | ⏳ Pendiente |
| **F6** | Cobros (links de pago dentro de WhatsApp) | ⏳ Pendiente |
| **F7** | Integración Meta Business Suite (CAPI + catálogo + click-to-WA) | ⏳ Pendiente |
| **F8** | Posventa + seguimiento + fidelización | ⏳ Pendiente |
| **F9** | Testing E2E + salida a producción | ⏳ Pendiente |

> **Nota de canal:** se usa WhatsApp Cloud API oficial. OpenWA fue descartado (ver ADR-0003).
> **Nota de hosting:** arquitectura híbrida — tienda WordPress/WooCommerce en Hostinger (fuente del
> catálogo) + backend del bot en Firebase. Catálogo se sincroniza de la tienda (ver ADR-0004).
> Nueva sub-fase a insertar: sincronización WooCommerce → Firestore (alrededor de F3/F5).

---

# ⚡ FASE ACTIVA: F1 — Setup WhatsApp Cloud API

**Objetivo:** tener el canal oficial de WhatsApp listo para que el backend pueda recibir
y enviar mensajes — número dedicado registrado, app de Meta creada, tokens obtenidos,
y webhook respondiendo el handshake de verificación de Meta.

**Por qué primero:** sin el canal de WhatsApp conectado, el bot no puede recibir ni
responder mensajes. Es el cimiento del producto.

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

### F2 — Diseño de datos
Definir cómo se guardan productos, clientes, conversaciones y órdenes en Firestore,
respetando la estructura multi-tenant (`tenants/perfumeria/...`). Sin código todavía,
solo el modelo de datos y las reglas de seguridad.

### F3 — Infra unificada
Un solo `docker-compose.yml` en `90-ops/` que levante n8n + emuladores de Firebase
(Firestore + Functions), para tener el entorno completo de desarrollo con un comando.

### F4 — Bot conversacional básico
El webhook recibe un mensaje de WhatsApp, lo procesa en Cloud Functions, y responde algo.
El "hola mundo" del bot. Sin catálogo aún.

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
