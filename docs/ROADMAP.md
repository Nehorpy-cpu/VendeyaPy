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
| **F1** | Fix técnico de OpenWA (servidor WhatsApp corriendo) | ⚡ EN CURSO |
| **F2** | Diseño de datos (schema Firestore tenant perfumería) | ⏳ Pendiente |
| **F3** | Infra unificada (docker-compose: OpenWA + n8n + emuladores) | ⏳ Pendiente |
| **F4** | Bot conversacional básico (recibe → responde) | ⏳ Pendiente |
| **F5** | Catálogo + carrito (el bot vende) | ⏳ Pendiente |
| **F6** | Cobros (links de pago dentro de WhatsApp) | ⏳ Pendiente |
| **F7** | Integración Meta Business Suite (CAPI + catálogo + click-to-WA) | ⏳ Pendiente |
| **F8** | Posventa + seguimiento + fidelización | ⏳ Pendiente |
| **F9** | Testing E2E + salida a producción | ⏳ Pendiente |

---

# ⚡ FASE ACTIVA: F1 — Fix técnico de OpenWA

**Objetivo:** dejar el servidor OpenWA corriendo en Docker, con el dashboard accesible en `localhost:2785`, sin errores de build.

**Por qué primero:** sin el servidor WhatsApp funcionando, nada del resto se puede probar. Es el cimiento físico.

**Criterio de "fase terminada" (Definition of Done):**
- [ ] `docker compose -f docker-compose.dev.yml up -d` levanta sin errores
- [ ] `curl http://localhost:2785` responde (no Connection refused)
- [ ] El dashboard abre en el navegador
- [ ] La sesión WhatsApp de `data/` se reconoce (o se puede escanear QR nuevo)

### Sub-fases de F1

| Sub-fase | Acción | Estado | Riesgo |
|----------|--------|--------|--------|
| **F1.1** | Diagnóstico: confirmar el error de build (vite 8 vs plugin-react 5) y revisar si hay otros | ⏳ | Bajo |
| **F1.2** | Aplicar fix en `dashboard/package.json`: bajar `vite ^8` → `vite ^7` | ⏳ | Bajo |
| **F1.3** | Regenerar `package-lock.json` del dashboard (local, fuera de Docker, para validar que resuelve) | ⏳ | Bajo |
| **F1.4** | Rebuild del container: `docker compose build dashboard` | ⏳ | Medio (puede aparecer otro conflicto) |
| **F1.5** | Levantar todo: `docker compose up -d` y mirar logs | ⏳ | Medio |
| **F1.6** | Verificar dashboard responde en `localhost:2785` | ⏳ | Bajo |
| **F1.7** | Verificar estado de sesión WhatsApp (data/ reconocida o QR) | ⏳ | Bajo |
| **F1.8** | Commit del fix + nota en CHANGELOG si aplica | ⏳ | Cero |

**Regla de oro de F1:** si una sub-fase falla, NO se pasa a la siguiente. Se para, se diagnostica el error en español simple, se proponen 2 opciones, y el owner elige. (Igual que pediste en el pedido original de OpenWA.)

---

# Fases siguientes (alto nivel — se desglosan al llegar)

### F2 — Diseño de datos
Definir cómo se guardan productos, clientes, conversaciones y órdenes en Firestore,
respetando la estructura multi-tenant (`tenants/perfumeria/...`). Sin código todavía,
solo el modelo de datos y las reglas de seguridad.

### F3 — Infra unificada
Un solo `docker-compose.yml` en `90-ops/` que levante OpenWA + n8n + emulador Firestore,
para tener el entorno completo de desarrollo con un comando.

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
