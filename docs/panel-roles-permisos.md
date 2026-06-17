# Panel SaaS — Roles, permisos y autenticación

> Modelo de acceso del panel administrativo (ver ADR-0005). Multi-tenant estricto.

## Autenticación

- **Firebase Authentication.** Cada usuario tiene **custom claims**: `{ tenantId, role }`.
- El `tenantId` ata al usuario a su empresa. **Super Admin** no tiene `tenantId` (o usa un flag
  especial) → puede ver/entrar a cualquier empresa.
- Los claims los setea una Cloud Function con Admin SDK (`userProvision`), nunca el cliente.
- El backend (firestore.rules + Functions) valida `tenantId` y `role` en CADA operación.
  **El frontend NO es la fuente de autorización** — solo oculta/muestra UI.

## Roles

| Rol del spec | Rol técnico | Alcance |
|---|---|---|
| **Super Admin (Marco)** | `PLATFORM_ADMIN` | Todo el SaaS: todas las empresas, crear/editar/suspender, entrar como empresa, métricas globales, gestionar usuarios, planes |
| **Company Owner** | `TENANT_OWNER` | Solo SU empresa: catálogo, pedidos, clientes, vendedores, promociones, campañas, config del agente, métricas/reportes |
| **Seller (Vendedor)** | `SELLER` | Solo lo permitido de su empresa: pedidos, conversaciones asignadas, handoffs, tareas comerciales. **NO** edita productos, config, costos ni ganancias |

## Matriz de permisos (resumen)

| Módulo | Super Admin | Owner | Seller |
|---|---|---|---|
| Empresas (crear/editar/suspender) | ✅ | ❌ | ❌ |
| Dashboard / métricas de la empresa | ✅ (todas) | ✅ (la suya) | 🔶 limitado (sin costos/ganancia) |
| Catálogo (productos, costos) | ✅ | ✅ | ❌ (solo lectura si acaso) |
| Pedidos | ✅ | ✅ | ✅ (estados permitidos) |
| Clientes | ✅ | ✅ | 🔶 ver |
| Conversaciones / handoff | ✅ | ✅ | ✅ (asignadas) |
| Campañas / Promotion Strategy | ✅ | ✅ | ❌ |
| Config del agente / empresa | ✅ | ✅ | ❌ |
| Ganancias / costos | ✅ | ✅ | ❌ |
| Usuarios y roles | ✅ | 🔶 (de su empresa) | ❌ |

## Reglas de aislamiento (no negociables)

- Toda consulta filtra por `tenantId`, **excepto** Super Admin.
- Un usuario **no puede** cambiar IDs en la URL/petición para ver otra empresa (se valida en backend).
- Rutas y APIs administrativas protegidas por rol.
- Logs de acciones importantes (auditoría).

## Pendiente de implementación (se construye por fases)

- Agregar rol `SELLER` al enum `USER_ROLE` (P1.1). ✅ en esta sub-fase.
- `userProvision` / seed para crear usuarios de prueba con claims (P1.2).
- `firestore.rules`: helper `isSeller` + permisos por módulo (se afinan al construir cada módulo + hardening final).
- Middleware/guards de ruta en Next.js por rol (P1.2).
