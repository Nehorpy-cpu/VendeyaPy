'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { navSectionsForRole } from '@/lib/roles';
import { cn } from '@/lib/cn';

/** Contenido de navegación (logo + secciones). Se usa en el aside desktop y en el drawer mobile. */
function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const { claims } = useAuth();
  const pathname = usePathname();
  const sections = navSectionsForRole(claims.role);

  return (
    <>
      <Link
        href="/dashboard"
        onClick={onNavigate}
        className="flex h-16 shrink-0 items-center gap-2.5 border-b border-ink-100 px-5"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#0d172c] shadow-glow">
          <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] text-mint-300" fill="none" aria-hidden="true">
            <path
              d="M6.5 7 12 13 17.5 7 M12 13 12 17.5"
              stroke="currentColor"
              strokeWidth={2.6}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="text-lg font-bold tracking-tight text-ink-900">
          VendeYa<span className="text-mint-600">Py</span>
        </span>
      </Link>
      <nav className="flex-1 space-y-4 overflow-y-auto p-2">
        {sections.map((group) => (
          <div key={group.section} className="space-y-1">
            <div className="px-3 pb-0.5 pt-1 text-[0.65rem] font-semibold uppercase tracking-wider text-ink-400">
              {group.label}
            </div>
            {group.modules.map((m) => {
              const active = pathname === m.href || pathname.startsWith(m.href + '/');
              return (
                <Link
                  key={m.key}
                  href={m.href}
                  onClick={onNavigate}
                  title={m.label}
                  className={cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    active ? 'bg-mint-50 text-mint-700' : 'text-ink-600 hover:bg-ink-50 hover:text-ink-900',
                  )}
                >
                  <span className="text-lg" aria-hidden>{m.icon}</span>
                  <span>{m.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </>
  );
}

export function Sidebar({ open = false, onClose }: { open?: boolean; onClose?: () => void }) {
  return (
    <>
      {/* Desktop: sidebar fijo */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-ink-100 bg-white md:flex">
        <NavList />
      </aside>

      {/* Mobile: drawer deslizable (oculto en desktop) */}
      <div className={cn('fixed inset-0 z-40 md:hidden', open ? '' : 'pointer-events-none')} role="dialog" aria-modal="true" aria-hidden={!open}>
        <div
          className={cn('absolute inset-0 bg-ink-950/40 transition-opacity duration-200', open ? 'opacity-100' : 'opacity-0')}
          onClick={onClose}
          aria-hidden
        />
        <aside
          className={cn(
            'absolute left-0 top-0 flex h-full w-64 flex-col border-r border-ink-100 bg-white shadow-float transition-transform duration-200',
            open ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <NavList onNavigate={onClose} />
        </aside>
      </div>
    </>
  );
}
