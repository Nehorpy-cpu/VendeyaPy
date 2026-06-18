'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { modulesForRole } from '@/lib/roles';
import { cn } from '@/lib/cn';

export function Sidebar() {
  const { claims } = useAuth();
  const pathname = usePathname();
  const modules = modulesForRole(claims.role);

  return (
    <aside className="flex w-16 shrink-0 flex-col border-r border-ink-100 bg-white md:w-60">
      <Link
        href="/dashboard"
        className="flex h-16 items-center justify-center gap-2.5 border-b border-ink-100 md:justify-start md:px-5"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-mint-brand shadow-glow">
          <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] text-white" fill="none" aria-hidden="true">
            <path
              d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6A2.5 2.5 0 0 1 16.5 15H10l-3.4 3v-3H7.5A2.5 2.5 0 0 1 5 12.5v-6Z"
              fill="currentColor"
            />
            <path d="M12 7.2l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1L9 10.2l2.1-.9.9-2.1Z" fill="#0d172c" />
          </svg>
        </span>
        <span className="hidden text-lg font-bold tracking-tight text-ink-900 md:inline">
          AI<span className="text-mint-600">_AFG</span>
        </span>
      </Link>
      <nav className="flex-1 space-y-1 overflow-y-auto p-2">
        {modules.map((m) => {
          const active = pathname === m.href || pathname.startsWith(m.href + '/');
          return (
            <Link
              key={m.key}
              href={m.href}
              title={m.label}
              className={cn(
                'flex items-center justify-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors md:justify-start',
                active ? 'bg-mint-50 text-mint-700' : 'text-ink-600 hover:bg-ink-50 hover:text-ink-900',
              )}
            >
              <span className="text-lg" aria-hidden>{m.icon}</span>
              <span className="hidden md:inline">{m.label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
