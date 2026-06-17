/**
 * Módulos del panel y qué rol puede ver cada uno (ver docs/panel-roles-permisos.md).
 * Esto controla la navegación visible; el backend igual valida permisos.
 */

import type { Role } from './auth-context';

export interface NavModule {
  key: string;
  label: string;
  href: string;
  icon: string;
  roles: Role[];
}

export const MODULES: NavModule[] = [
  { key: 'dashboard', label: 'Dashboard', href: '/dashboard', icon: '📊', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER', 'SELLER'] },
  { key: 'decisions', label: 'Acciones de hoy', href: '/decisions', icon: '🧭', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER', 'TENANT_MANAGER'] },
  { key: 'companies', label: 'Empresas', href: '/companies', icon: '🏢', roles: ['PLATFORM_ADMIN'] },
  { key: 'catalog', label: 'Catálogo', href: '/catalog', icon: '📦', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER'] },
  { key: 'orders', label: 'Pedidos', href: '/orders', icon: '🧾', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER', 'SELLER'] },
  { key: 'customers', label: 'Clientes', href: '/customers', icon: '👥', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER', 'SELLER'] },
  { key: 'conversations', label: 'Conversaciones', href: '/conversations', icon: '💬', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER', 'SELLER'] },
  { key: 'followups', label: 'Seguimientos', href: '/followups', icon: '📌', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER', 'TENANT_MANAGER', 'SELLER'] },
  { key: 'campaigns', label: 'Campañas', href: '/campaigns', icon: '📣', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER'] },
  { key: 'analytics', label: 'Vistas y analíticas', href: '/analytics', icon: '📈', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER'] },
  { key: 'promotions', label: 'Promotion Strategy', href: '/promotions', icon: '🎯', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER'] },
  { key: 'agent', label: 'Config. del agente', href: '/agent', icon: '🤖', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER'] },
  { key: 'company', label: 'Config. de empresa', href: '/company', icon: '⚙️', roles: ['PLATFORM_ADMIN', 'TENANT_OWNER'] },
];

export const ROLE_LABELS: Record<Role, string> = {
  PLATFORM_ADMIN: 'Super Admin',
  TENANT_OWNER: 'Dueño',
  TENANT_MANAGER: 'Manager',
  TENANT_VIEWER: 'Lector',
  SELLER: 'Vendedor',
};

export function modulesForRole(role: Role | null): NavModule[] {
  if (!role) return [];
  return MODULES.filter((m) => m.roles.includes(role));
}
