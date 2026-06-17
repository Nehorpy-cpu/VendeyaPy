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
    <aside className="flex w-16 shrink-0 flex-col border-r border-gray-200 bg-white md:w-60">
      <div className="flex h-16 items-center justify-center border-b border-gray-200 md:justify-start md:px-5">
        <span className="text-xl font-bold text-brand-700">AI<span className="hidden md:inline">_AFG</span></span>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-2">
        {modules.map((m) => {
          const active = pathname === m.href || pathname.startsWith(m.href + '/');
          return (
            <Link
              key={m.key}
              href={m.href}
              title={m.label}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                active ? 'bg-brand-50 text-brand-700' : 'text-gray-600 hover:bg-gray-100',
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
