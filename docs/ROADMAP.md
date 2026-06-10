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

---

# ⚡ FASE ACTIVA: F1 — Setup WhatsApp Cloud API

**Objetivo:** tener el canal oficial de WhatsApp listo para que el backend pueda recibir
y enviar mensajes — número dedicado registrado, app de Meta creada, tokens obtenidos,
y webhook respondiendo el handshake de verificación de Meta.

**Por qué primero:** sin el canal de WhatsApp conectado, el bot no puede recibir ni
responder mensajes. Es el cimiento del producto.

**Criterio de "fase terminada" (Definition of Done):**
- [ ] Meta Business verificado
- [ ] App de WhatsApp creada en developers.facebook.com
- [ ] Número dedicado registrado en WhatsApp Business API
- [ ] Access token permanente (System User) obtenido y guardado de forma segura
- [ ] Webhook desplegado que responde el `GET` de verificación de Meta (hub.challenge)
- [ ] Mensaje de prueba recibido en el webhook (entrante) y uno enviado (saliente) OK

### Sub-fases de F1

| Sub-fase | Acción | Estado | Riesgo |
|----------|--------|--------|--------|
| **F1.1** | Verificar estado de Meta Business (¿verificado? ¿qué falta?) — guía al owner | ⏳ | Bajo |
| **F1.2** | Crear app de WhatsApp en developers.facebook.com + obtener App ID / App Secret | ⏳ | Bajo |
| **F1.3** | Registrar número dedicado en WhatsApp Business API (no personal) | ⏳ | Medio (trámite Meta) |
| **F1.4** | Generar access token permanente vía System User (no el temporal de 24h) | ⏳ | Bajo |
| **F1.5** | Definir `verify token` propio + documentar config en `50-whatsapp-cloud-api/config/` | ⏳ | Cero |
| **F1.6** | Codear webhook mínimo en `10-backend` (GET verificación + POST recepción) | ⏳ | Medio |
| **F1.7** | Desplegar webhook (Cloud Functions o túnel local) y registrarlo en Meta | ⏳ | Medio |
| **F1.8** | Prueba E2E: enviar/recibir un mensaje de test. Commit + ADR si surge decisión | ⏳ | Bajo |

**Regla de oro de F1:** si una sub-fase falla, NO se pasa a la siguiente. Se para, se diagnostica
el error en español simple, se proponen 2 opciones, y el owner elige. Nada de "ya va a funcionar".

**Nota:** las sub-fases F1.1–F1.5 son **trámites/config en Meta** (las hacés vos, yo te guío
paso a paso). Las F1.6–F1.8 son **código** (las hago yo, vos validás).

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
Conversion API, catálogo sincronizado, click-to-WhatsApp ads, audiencias de retargeting.

### F8 — Posventa
Seguimiento de envío, mensajes de fidelización, NPS.

### F9 — Testing E2E + producción
Pruebas de punta a punta (ad → conversación → venta), hardening y publicación.

---

## Cómo se actualiza este roadmap

1. Cuando se cierra una fase: marcar ✅, mover la siguiente a ⚡, y **desglosarla en sub-fases** acá.
2. Cada decisión grande genera un ADR en `00-architecture/decisions/`.
3. Las sub-fases se reflejan también en el sistema de tareas de la sesión (TaskCreate).
