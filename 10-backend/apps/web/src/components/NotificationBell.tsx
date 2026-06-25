'use client';

/**
 * NotificationBell — Indicador DISCRETO de notificaciones internas del trial (TRIAL-NOTIFICATIONS-2).
 * En el Header: campana con badge de no leídas + dropdown con título/texto, "Marcar como leído" y CTA a
 * /billing. Solo lee las del tenant activo (rules: owner/admin); si el rol no tiene acceso, `listNotifications`
 * devuelve [] → no se muestra nada. El frontend NO crea ni borra; el bloqueo del trial lo hace `TrialGuard`.
 */
import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useActiveCompany } from '@/lib/active-company';
import { listNotifications, markNotificationRead, selectUnreadSorted } from '@/lib/notifications';

function BellIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" />
      <path d="M10.5 19a1.6 1.6 0 0 0 3 0" />
    </svg>
  );
}

export function NotificationBell() {
  const { tenantId } = useActiveCompany();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ['notifications', tenantId],
    queryFn: () => listNotifications(tenantId!),
    enabled: !!tenantId,
  });
  const markRead = useMutation({
    mutationFn: (id: string) => markNotificationRead(tenantId!, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications', tenantId] }),
  });

  const unread = selectUnreadSorted(data ?? []);
  if (unread.length === 0) return null; // pago / sin notificaciones / sin permiso → nada

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={`Notificaciones (${unread.length} sin leer)`}
        className="relative grid h-9 w-9 place-items-center rounded-lg border border-ink-200 text-ink-600 transition-colors hover:bg-ink-50"
      >
        <BellIcon className="h-5 w-5" />
        <span className="absolute -right-1 -top-1 grid h-4 min-w-[1rem] place-items-center rounded-full bg-coral-600 px-1 text-[0.6rem] font-bold text-white">
          {unread.length}
        </span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 z-20 mt-2 w-80 overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-float">
            <div className="border-b border-ink-100 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-ink-500">Notificaciones</div>
            <ul className="max-h-80 divide-y divide-ink-100 overflow-y-auto">
              {unread.map((nf) => (
                <li key={nf.id} className="px-4 py-3">
                  <div className="text-sm font-semibold text-ink-900">{nf.title}</div>
                  <p className="mt-0.5 text-xs leading-snug text-ink-500">{nf.body}</p>
                  <div className="mt-2 flex items-center gap-3">
                    <Link href="/billing" onClick={() => setOpen(false)} className="text-xs font-semibold text-mint-700 hover:text-mint-600">
                      Ver planes
                    </Link>
                    <button
                      onClick={() => markRead.mutate(nf.id)}
                      disabled={markRead.isPending}
                      className="text-xs font-medium text-ink-500 hover:text-ink-700 disabled:opacity-50"
                    >
                      Marcar como leído
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
