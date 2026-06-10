# AI_AFG

> Plataforma de automatización de ventas y créditos.
> Empresa A: perfumería y cuidado personal. Empresa B: créditos (CrediAgil / LlevaYa / Solar Banco).
> Flujo: Meta Ads → WhatsApp → cierre de venta / aprobación de crédito.

---

## Estructura del repositorio

Las carpetas usan **prefijo numérico** para orden visual y para señalar dependencia (los números bajos son fundamentos; los altos son módulos de negocio o infra).

| Carpeta | Qué contiene | Estado |
|---|---|---|
| `00-architecture/` | Fuente única de verdad: `ARCHITECTURE.md` y ADRs (decisiones técnicas) | ✅ Heredado de VentaporWhatsapp — pendiente adaptar a Bolivia |
| `10-backend/` | Monorepo Node.js 20 + TypeScript: Firebase Functions, packages compartidos | ✅ Base de VentaporWhatsapp |
| `20-n8n/` | Workflows N8N (`*.json`) + README de importación | ✅ 5 workflows de Arfagi + 2 placeholders |
| `30-services-python/` | Microservicios Python (visión, ML scoring de crédito) | ⏳ Vacío — opcional |
| `40-mobile/` | App móvil Flutter | ⏳ Vacío — opcional |
| `50-whatsapp-server/OpenWA/` | Servidor WhatsApp local (OpenWA) | ✅ Migrado con sesión activa |
| `60-admin/` | Panel admin web propio | ⏳ Vacío — diferido (uso de Supabase Studio + n8n dashboard mientras tanto) |
| `70-perfumeria/` | Catálogo y promociones específicas del negocio perfumería | ⏳ Vacío |
| `80-creditos/` | Integraciones CrediAgil/LlevaYa/Solar Banco + scoring + docs legales | ⏳ Vacío |
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

---

## Tareas pendientes

- [ ] Adaptar `ARCHITECTURE.md` (Paraguay→Bolivia, agregar entidades de crédito y perfumería como tenants)
- [ ] Resolver build de OpenWA (vite v8 → v7 en `50-whatsapp-server/OpenWA/dashboard/package.json`)
- [ ] Crear `90-ops/docker-compose.yml` unificado (n8n + OpenWA + Postgres opcional)
- [ ] Decidir e integrar API de WhatsApp (OpenWA vs Cloud API oficial)
- [ ] Documentar APIs de entidades de crédito (CrediAgil / LlevaYa / Solar Banco)
