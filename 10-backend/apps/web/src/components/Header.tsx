'use client';

import { useAuth } from '@/lib/auth-context';
import { ROLE_LABELS } from '@/lib/roles';
import { useActiveCompany } from '@/lib/active-company';
import { NotificationBell } from '@/components/NotificationBell';

export function Header() {
  const { user, claims, signOut } = useAuth();
  const { companies, tenantId, isSuperAdmin, setTenantId } = useActiveCompany();
  const active = tenantId ?? '';
  const onSelect = (id: string) => setTenantId(id);

  return (
    <header className="flex h-16 items-center justify-between border-b border-ink-100 bg-white px-4 md:px-6">
      <div className="flex items-center gap-3">
        {isSuperAdmin ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-ink-500">Empresa:</span>
            <select
              value={active}
              onChange={(e) => onSelect(e.target.value)}
              className="rounded-lg border border-ink-200 px-2 py-1.5 text-sm text-ink-800 focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30"
            >
              {companies.length === 0 && <option value="">(sin empresas)</option>}
              {companies.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        ) : (
          <span className="text-sm font-medium text-ink-700">
            {claims.tenantId ?? 'Mi empresa'}
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        <NotificationBell />
        <div className="hidden text-right sm:block">
          <div className="text-sm font-medium text-ink-800">{user?.email}</div>
          <div className="text-xs text-ink-500">
            {claims.role ? ROLE_LABELS[claims.role] : '—'}
          </div>
        </div>
        <button
          onClick={() => signOut()}
          className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50"
        >
          Salir
        </button>
      </div>
    </header>
  );
}
