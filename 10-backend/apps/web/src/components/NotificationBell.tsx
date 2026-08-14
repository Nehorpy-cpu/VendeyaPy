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
import { useAuth } from '@/lib/auth-context';
import type { Notification } from '@vpw/shared';
import { listNotifications, markNotificationRead, selectUnreadSorted } from '@/lib/notifications';

/**
 * Dónde se RESUELVE cada categoría de aviso. Es un Record EXHAUSTIVO del tipo compartido a
 * propósito: la versión anterior preguntaba por dos categorías de catálogo y mandaba todo lo demás
 * a Planes POR DESCARTE, así que `catalog_source` —el aviso de ADR-0015 §4: apareció una fuente
 * externa que nadie reconoció y las escrituras hacia Meta quedaron DETENIDAS— ofrecía "Ver planes"
 * justo cuando lo que había que arreglar era el catálogo. Con el Record tipado, sumar una
 * categoría al tipo compartido rompe la COMPILACIÓN acá en vez de mandar el aviso nuevo al peor
 * lugar posible.
 */
const CTA_POR_CATEGORIA: Record<Notification['category'], { href: string; label: string }> = {
  trial: { href: '/billing', label: 'Ver planes' },
  handoff: { href: '/conversations', label: 'Ver conversación' },
  catalog_quality: { href: '/catalog', label: 'Ver catálogo' },
  // ADR-0015 §4: la fuente externa se reconoce (o se rechaza) desde la tarjeta de propiedad del
  // Catálogo — es el único lugar donde el owner puede destrabar las escrituras.
  catalog_source: { href: '/catalog', label: 'Ver catálogo' },
  // ADR-0015 §6: la config contradictoria que impide verificar también se corrige desde Catálogo.
  catalog_verification: { href: '/catalog', label: 'Ver catálogo' },
  // ADR-0018: el cupo de IA se resuelve ampliando el plan — la acción vive en Billing.
  ai_quota: { href: '/billing', label: 'Ver planes' },
};

/**
 * CTA de UN aviso. `null` ⇒ NO se muestra ningún link. Una categoría que este panel no conoce
 * (backend más nuevo que el panel desplegado) es un destino que no sabemos, y adivinarlo es
 * exactamente el modo de falla que este Record cierra: el aviso se sigue leyendo y se sigue
 * pudiendo marcar como leído, sin mandar a nadie a la pantalla equivocada.
 */
export function ctaDeNotificacion(nf: Pick<Notification, 'category' | 'customerId'>): { href: string; label: string } | null {
  const cta = CTA_POR_CATEGORIA[nf.category] as { href: string; label: string } | undefined;
  if (!cta) return null;
  // HANDOFF-2: el aviso de atención humana abre LA conversación de ese cliente cuando la trae.
  if (nf.category === 'handoff' && nf.customerId) return { ...cta, href: `${cta.href}?c=${nf.customerId}` };
  return cta;
}

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
  const { user, claims } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  // COVERAGE-1C: la query viene acotada por rol (rules) — el SELLER asignado ve SU campana.
  const { data } = useQuery({
    queryKey: ['notifications', tenantId, claims.role, user?.uid],
    queryFn: () => listNotifications(tenantId!, { role: claims.role, uid: user?.uid ?? null }),
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
        aria-expanded={open}
        aria-haspopup="true"
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
              {unread.map((nf) => {
                // El CTA depende de la CATEGORÍA (no del tipo): un pedido de atención humana lleva
                // a Conversaciones y cualquier cosa del catálogo, al Catálogo. Ver
                // `CTA_POR_CATEGORIA` arriba para por qué esto no puede volver a ser un descarte.
                const cta = ctaDeNotificacion(nf);
                return (
                  <li key={nf.id} className="px-4 py-3">
                    <div className="text-sm font-semibold text-ink-900">{nf.title}</div>
                    <p className="mt-0.5 text-xs leading-snug text-ink-500">{nf.body}</p>
                    <div className="mt-2 flex items-center gap-3">
                      {cta && (
                        <Link
                          href={cta.href}
                          onClick={() => setOpen(false)}
                          className="text-xs font-semibold text-mint-700 hover:text-mint-600"
                        >
                          {cta.label}
                        </Link>
                      )}
                      <button
                        onClick={() => markRead.mutate(nf.id)}
                        disabled={markRead.isPending}
                        className="text-xs font-medium text-ink-500 hover:text-ink-700 disabled:opacity-50"
                      >
                        Marcar como leído
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
