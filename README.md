# AI_AFG

> Plataforma multi-tenant de automatización de ventas vía WhatsApp **en Paraguay**.
>
> **Fase 1 (en desarrollo):** tenant perfumería y cuidado personal femenino.
> **Fase 2 (diferida):** tenant créditos (CrediAgil / LlevaYa / Solar Banco) — ver ADR-0002.
>
> Flujo fase 1: Meta Ads → WhatsApp → cierre de venta.

---

## Estructura del repositorio

Las carpetas usan **prefijo numérico** para orden visual y para señalar dependencia (los números bajos son fundamentos; los altos son módulos de negocio o infra).

| Carpeta | Qué contiene | Estado |
|---|---|---|
| `00-architecture/` | Fuente única de verdad: `ARCHITECTURE.md` y ADRs (decisiones técnicas) | ✅ Heredado de VentaporWhatsapp (ya Paraguay-céntrico) |
| `10-backend/` | Monorepo Node.js 20 + TypeScript: Firebase Functions, packages compartidos | ✅ Base de VentaporWhatsapp |
| `20-n8n/` | Workflows N8N (`*.json`) + README de importación | ✅ 5 workflows de Arfagi + 2 placeholders |
| `30-services-python/` | Microservicios Python (visión, ML scoring de crédito) | ⏳ Vacío — opcional |
| `40-mobile/` | App móvil Flutter | ⏳ Vacío — opcional |
| `50-whatsapp-server/OpenWA/` | Servidor WhatsApp local (OpenWA) | ✅ Migrado con sesión activa |
| `60-admin/` | Panel admin web propio | ⏳ Vacío — diferido (uso de Supabase Studio + n8n dashboard mientras tanto) |
| `70-perfumeria/` | ⚡ **Foco actual:** catálogo, promociones, checkout de perfumería | ⏳ Vacío — próximo a desarrollar |
| `80-creditos.future/` | Tenant créditos — DIFERIDO fase 2 (ADR-0002). No tocar | 🚫 No se desarrolla ahora |
| `90-ops/` | `docker-compose.yml` unificado, `.env.example`, scripts deploy | ⏳ Vacío |
| `_archive/` | Proyectos previos (VentaporWhatsapp, Proyecto_Arfagi) y backups zip | ✅ |
| `docs/` | Documentación adicional (no-arquitectura) | ⏳ Vacío |
| `.claude/` | Skills y settings scope-proyecto | ✅ |

---

## Cómo arrancar

1. **Backend:** ver `10-backend/README.md`
2. **N8N workflows:** ver `20-n8n/README.md`
3. **WhatsApp server (OpenWA):** ver `50-whatsapp-server/OpenWA/README.md`
4. **Infra unificada (a configurar):** ver `90-ops/docker-compose.yml`

---

## Decisiones clave tomadas

Ver `00-architecture/decisions/`:
- [ADR-0001](00-architecture/decisions/ADR-0001-base-stack-decision.md) — Base stack y consolidación
- [ADR-0002](00-architecture/decisions/ADR-0002-scope-fase1-solo-perfumeria.md) — Scope fase 1: solo perfumería con arquitectura multi-tenant

---

## Tareas pendientes

### Fase 1 (perfumería — en curso)
- [ ] Documentar perfumería como tenant inicial en `ARCHITECTURE.md` sección 2 Multi-Tenant
- [ ] Resolver build de OpenWA (vite v8 → v7 en `50-whatsapp-server/OpenWA/dashboard/package.json`)
- [ ] Crear `90-ops/docker-compose.yml` unificado (n8n + OpenWA)
- [ ] Decidir API de WhatsApp final (OpenWA local vs Cloud API oficial)
- [ ] Diseñar schema Firestore para tenant perfumería (catálogo, órdenes, conversaciones)
- [ ] Desarrollar `70-perfumeria/catalogo/` y `70-perfumeria/promociones/`

### Fase 2 (créditos — diferida, no se trabaja ahora)
- [ ] Agregar capítulo "Entidades de crédito" cuando se retome el scope
- [ ] Documentar APIs de CrediAgil / LlevaYa / Solar Banco
- [ ] Evaluar compliance regulatoria (INCOOP, BCP, KYC, AML)
