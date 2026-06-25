/**
 * Módulos del panel y qué rol puede ver cada uno (ver docs/panel-roles-permisos.md).
 * Esto controla la navegación visible; el backend igual valida permisos.
 *
 * FRONTEND-UX-1C: los módulos se agrupan por `section` (sidebar agrupado). Los módulos sin página real
 * todavía quedan `hidden: true` (se conservan sus `roles` para no romper permisos, pero NO aparecen en el
 * sidebar hasta que exista su pantalla). `modulesForRole` filtra por rol Y oculta los `hidden`.
 */

import type { Role } from './auth-context';

export type NavSection = 'inicio' | 'ventas' | 'catalogo' | 'ia' | 'crecer' | 'ajustes';

/** Orden de las secciones en el sidebar. */
export const SECTION_ORDER: NavSection[] = ['inicio', 'ventas', 'catalogo', 'ia', 'crecer', 'ajustes'];

/** Encabezado visible de cada sección (se renderiza en mayúsculas vía CSS). */
export const SECTION_LABELS: Record<NavSection, string> = {
  inicio: 'Inicio',
  ventas: 'Ventas',
  catalogo: 'Catálogo',
  ia: 'IA y automatización',
  crecer: 'Crecer y medir',
  ajustes: 'Ajustes',
};

export interface NavModule {
  key: string;
  label: string;
  href: string;
  icon: string;
  roles: Role[];
  /** Sección del sidebar. Los módulos `hidden` no necesitan sección. */
  section?: NavSection;
  /** Oculto del sidebar (su página todavía no existe). Conserva `roles` para no borrar permisos. */
  hidden?: boolean;
}

export const MODULES: NavModule[] = [
  // ── INICIO ──
  { key: 'dashboard', label: 'Dashboard', href: '/dashboard', icon: '📊', section: 'inicio', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER', 'SELLER'] },
  { key: 'onboarding', label: 'Primeros pasos', href: '/onboarding', icon: '🚀', section: 'inicio', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER'] },
  { key: 'decisions', label: 'Acciones de hoy', href: '/decisions', icon: '🧭', section: 'inicio', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER', 'TENANT_MANAGER'] },
  // ── VENTAS ──
  { key: 'conversations', label: 'Conversaciones', href: '/conversations', icon: '💬', section: 'ventas', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER', 'SELLER'] },
  { key: 'orders', label: 'Pedidos', href: '/orders', icon: '🧾', section: 'ventas', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER', 'SELLER'] },
  { key: 'customers', label: 'Clientes', href: '/customers', icon: '👥', section: 'ventas', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER', 'SELLER'] },
  { key: 'followups', label: 'Seguimientos', href: '/followups', icon: '📌', section: 'ventas', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER', 'TENANT_MANAGER', 'SELLER'] },
  { key: 'replies', label: 'Respuestas ganadoras', href: '/replies', icon: '🏆', section: 'ventas', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER', 'TENANT_MANAGER', 'SELLER'] },
  // ── CATÁLOGO ──
  { key: 'catalog', label: 'Catálogo', href: '/catalog', icon: '📦', section: 'catalogo', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER'] },
  // ── IA Y AUTOMATIZACIÓN ──
  { key: 'agent', label: 'Config. del agente', href: '/agent', icon: '🤖', section: 'ia', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER'] },
  { key: 'simulator', label: 'Simulador', href: '/simulator', icon: '🧪', section: 'ia', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER', 'TENANT_MANAGER'] },
  { key: 'promotions', label: 'Promociones', href: '/promotions', icon: '🎯', section: 'ia', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER'] },
  // ── CRECER Y MEDIR ──
  { key: 'ads', label: 'Anuncios', href: '/ads', icon: '📣', section: 'crecer', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER', 'TENANT_MANAGER'] },
  { key: 'tracking', label: 'Tracking propio', href: '/tracking', icon: '🎟️', section: 'crecer', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER', 'TENANT_MANAGER'] },
  { key: 'integrations', label: 'Integración Meta', href: '/integrations', icon: '🔌', section: 'crecer', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER'] },
  // ── AJUSTES ──
  { key: 'billing', label: 'Plan y facturación', href: '/billing', icon: '💳', section: 'ajustes', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER'] },
  // ── Ocultos del sidebar hasta que exista su página (FRONTEND-UX-1C). Roles conservados. ──
  { key: 'companies', label: 'Empresas', href: '/companies', icon: '🏢', hidden: true, roles: ['PLATFORM_ADMIN'] },
  { key: 'campaigns', label: 'Campañas', href: '/campaigns', icon: '📣', hidden: true, roles: ['PLATFORM_ADMIN', 'TENANT_OWNER'] },
  { key: 'analytics', label: 'Vistas y analíticas', href: '/analytics', icon: '📈', hidden: true, roles: ['PLATFORM_ADMIN', 'TENANT_OWNER'] },
  { key: 'company', label: 'Config. de empresa', href: '/company', icon: '⚙️', hidden: true, roles: ['PLATFORM_ADMIN', 'TENANT_OWNER'] },
];

export const ROLE_LABELS: Record<Role, string> = {
  PLATFORM_ADMIN: 'Super Admin',
  TENANT_OWNER: 'Dueño',
  TENANT_MANAGER: 'Manager',
  TENANT_VIEWER: 'Lector',
  SELLER: 'Vendedor',
};

/** Módulos visibles en el sidebar para un rol: filtra por rol y oculta los `hidden` (sin página). */
export function modulesForRole(role: Role | null): NavModule[] {
  if (!role) return [];
  return MODULES.filter((m) => !m.hidden && m.roles.includes(role));
}

/** Igual que `modulesForRole` pero agrupado por sección (en `SECTION_ORDER`), sin secciones vacías. */
export function navSectionsForRole(role: Role | null): { section: NavSection; label: string; modules: NavModule[] }[] {
  const visible = modulesForRole(role);
  return SECTION_ORDER
    .map((section) => ({ section, label: SECTION_LABELS[section], modules: visible.filter((m) => m.section === section) }))
    .filter((g) => g.modules.length > 0);
}
