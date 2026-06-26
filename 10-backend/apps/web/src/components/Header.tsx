'use client';

import { useAuth } from '@/lib/auth-context';
import { ROLE_LABELS } from '@/lib/roles';
import { useActiveCompany } from '@/lib/active-company';
import { NotificationBell } from '@/components/NotificationBell';
import { MenuIcon } from '@/components/marketing/icons';

export function Header({ onMenuClick }: { onMenuClick?: () => void }) {
  const { user, claims, signOut } = useAuth();
  const { companies, tenantId, companyName, isSuperAdmin, setTenantId } = useActiveCompany();
  const active = tenantId ?? '';
  const onSelect = (id: string) => setTenantId(id);

  return (
    <header className="flex h-16 items-center justify-between gap-2 border-b border-ink-100 bg-white px-3 sm:gap-3 sm:px-6">
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
        <button
          onClick={onMenuClick}
          aria-label="Abrir menú"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-ink-200 text-ink-700 transition-colors hover:bg-ink-50 md:hidden"
        >
          <MenuIcon className="h-5 w-5" />
        </button>

        {isSuperAdmin ? (
          <div className="flex min-w-0 items-center gap-2">
            <span className="hidden text-sm text-ink-500 sm:inline">Empresa:</span>
            <select
              value={active}
              onChange={(e) => onSelect(e.target.value)}
              className="min-w-0 max-w-[45vw] rounded-lg border border-ink-200 px-2 py-1.5 text-sm text-ink-800 focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30 sm:max-w-xs"
            >
              {companies.length === 0 && <option value="">(sin empresas)</option>}
              {companies.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        ) : (
          <span className="truncate text-sm font-medium text-ink-700" title={claims.tenantId ?? undefined}>
            {companyName ?? claims.tenantId ?? 'Mi empresa'}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        <NotificationBell />
        <div className="hidden text-right sm:block">
          <div className="max-w-[14rem] truncate text-sm font-medium text-ink-800">{user?.email}</div>
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
