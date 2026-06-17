'use client';

import { useAuth } from '@/lib/auth-context';
import { ROLE_LABELS, modulesForRole } from '@/lib/roles';

export default function DashboardPage() {
  const { user, claims } = useAuth();
  const modules = modulesForRole(claims.role);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-sm text-gray-500">
          Hola {user?.email} · {claims.role ? ROLE_LABELS[claims.role] : '—'}
          {claims.tenantId ? ` · ${claims.tenantId}` : ' · Plataforma'}
        </p>
      </div>

      {/* Tarjetas de métricas — placeholder (datos reales en P3) */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          { label: 'Ventas (mes)', value: '—' },
          { label: 'Ingresos', value: '—' },
          { label: 'Ganancia', value: '—' },
          { label: 'Conversaciones', value: '—' },
        ].map((c) => (
          <div key={c.label} className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-gray-400">{c.label}</div>
            <div className="mt-1 text-2xl font-bold text-gray-900">{c.value}</div>
          </div>
        ))}
      </div>

      {/* Estado vacío honesto */}
      <div className="rounded-xl border border-dashed border-gray-300 bg-white p-6 text-center text-sm text-gray-500">
        📊 Las métricas reales aparecen en la fase <span className="font-medium">P3</span>.
        Por ahora esto confirma que el acceso y los roles funcionan.
      </div>

      {/* Accesos a los módulos según rol */}
      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Tus módulos
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {modules.map((m) => (
            <a
              key={m.key}
              href={m.href}
              className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 transition-colors hover:border-brand-400 hover:bg-brand-50"
            >
              <span className="text-2xl" aria-hidden>{m.icon}</span>
              <span className="text-sm font-medium text-gray-800">{m.label}</span>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
