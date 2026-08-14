/**
 * NotificationBell.test.tsx — A DÓNDE manda cada aviso de la campana (ADR-0015 §4 y §6).
 *
 * El hallazgo que motivó este archivo: el CTA se decidía por descarte ("¿es de catálogo? si no,
 * Planes"), y la lista de categorías de catálogo se quedó corta. Con `catalog_source` —una fuente
 * externa apareció sin reconocer y las escrituras hacia Meta quedaron DETENIDAS— el owner abría la
 * campana y leía "Ver planes" con link a /billing: el peor lugar posible, porque lo que hay que
 * destrabar está en Catálogo y la venta automática mientras tanto está frenada.
 *
 * Lo que se ata acá es el mapa COMPLETO de categorías vivas del backend, no solo la que falló.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Notification } from '@vpw/shared';
import { NotificationBell, ctaDeNotificacion } from './NotificationBell';

vi.mock('next/link', () => ({
  default: (p: { href: string; children: React.ReactNode; onClick?: () => void }) => (
    <a href={p.href} onClick={p.onClick}>{p.children}</a>
  ),
}));
vi.mock('@/lib/active-company', () => ({ useActiveCompany: () => ({ tenantId: 'perfumeria' }) }));
vi.mock('@/lib/auth-context', () => ({ useAuth: () => ({ user: { uid: 'u-owner' }, claims: { role: 'TENANT_OWNER' } }) }));

const listNotifications = vi.fn();
const markNotificationRead = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('@/lib/notifications', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/notifications')>();
  return {
    ...real, // `selectUnreadSorted` REAL: el orden de la campana es parte de lo que se prueba
    listNotifications: (...a: unknown[]) => listNotifications(...a),
    markNotificationRead: (...a: unknown[]) => markNotificationRead(...a),
  };
});

const aviso = (over: Partial<Notification> = {}): Notification =>
  ({
    id: 'n1',
    tenantId: 'perfumeria',
    category: 'catalog_source',
    type: 'catalog_source_changed',
    title: 'Cambió la fuente de tu catálogo',
    body: 'Detectamos un origen de datos que nadie reconoció.',
    dedupeKey: 'n1',
    read: false,
    readAt: null,
    ...over,
  }) as unknown as Notification;

/** Abre la campana y devuelve los links del dropdown (href + texto). */
async function abrirCampana(avisos: Notification[]): Promise<{ href: string; texto: string }[]> {
  listNotifications.mockResolvedValue(avisos);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <NotificationBell />
    </QueryClientProvider>,
  );
  const boton = await screen.findByRole('button', { name: /Notificaciones/ });
  fireEvent.click(boton);
  await waitFor(() => expect(screen.getByText('Notificaciones')).toBeInTheDocument());
  return screen.queryAllByRole('link').map((a) => ({ href: a.getAttribute('href') ?? '', texto: a.textContent ?? '' }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('NotificationBell — el CTA lleva a donde el aviso SE RESUELVE', () => {
  it('HALLAZGO: `catalog_source` (escrituras a Meta detenidas) manda al Catálogo, jamás a Planes', async () => {
    const links = await abrirCampana([aviso()]);
    expect(links).toEqual([{ href: '/catalog', texto: 'Ver catálogo' }]);
    // El fondo del asunto, escrito como aserción: nunca /billing para un problema de catálogo.
    expect(links.some((l) => l.href === '/billing' || /planes/i.test(l.texto))).toBe(false);
  });

  it('el aviso se muestra completo (título y cuerpo) y se puede marcar como leído', async () => {
    await abrirCampana([aviso()]);
    expect(screen.getByText('Cambió la fuente de tu catálogo')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Marcar como leído'));
    await waitFor(() => expect(markNotificationRead).toHaveBeenCalledWith('perfumeria', 'n1'));
  });

  it('sin avisos sin leer la campana no existe (cero ruido para un tenant al día)', async () => {
    listNotifications.mockResolvedValue([aviso({ read: true })]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <NotificationBell />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(listNotifications).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Notificaciones/ })).toBeNull();
  });
});

describe('ctaDeNotificacion — mapa EXHAUSTIVO de las categorías que el backend crea hoy', () => {
  /**
   * Este Record es lo que ata el contrato: al ser `Record<Notification['category'], …>`, agregar
   * una categoría al tipo compartido ROMPE la compilación de este test hasta que alguien decida
   * —a mano— dónde se resuelve. Las cinco de hoy: `trial` (runTrialNotificationsJob),
   * `handoff` (handoff/coverage), `catalog_quality` (qualityNotification),
   * `catalog_source` (catalogSourceGate) y `catalog_verification` (catalogVerification).
   */
  const DESTINO_ESPERADO: Record<Notification['category'], { href: string; label: string }> = {
    trial: { href: '/billing', label: 'Ver planes' },
    handoff: { href: '/conversations', label: 'Ver conversación' },
    catalog_quality: { href: '/catalog', label: 'Ver catálogo' },
    catalog_source: { href: '/catalog', label: 'Ver catálogo' },
    catalog_verification: { href: '/catalog', label: 'Ver catálogo' },
    // ADR-0018: el cupo de IA se amplía desde Billing.
    ai_quota: { href: '/billing', label: 'Ver planes' },
  };

  it('cada categoría viva cae en su pantalla (y solo `trial` y `ai_quota` van a Planes)', () => {
    for (const [category, esperado] of Object.entries(DESTINO_ESPERADO)) {
      const cta = ctaDeNotificacion({ category } as Pick<Notification, 'category' | 'customerId'>);
      expect(cta, category).toEqual(esperado);
    }
    // ADR-0018: el cupo de IA también se resuelve en Billing (ampliar plan), igual que el trial.
    const aPlanes = Object.entries(DESTINO_ESPERADO).filter(([, d]) => d.href === '/billing');
    expect(aPlanes.map(([c]) => c)).toEqual(['trial', 'ai_quota']);
  });

  it('las TRES categorías de catálogo se resuelven en /catalog (ninguna cae por descarte)', () => {
    for (const category of ['catalog_quality', 'catalog_source', 'catalog_verification'] as const) {
      expect(ctaDeNotificacion({ category })?.href, category).toBe('/catalog');
    }
  });

  it('handoff abre LA conversación del cliente cuando el aviso lo trae; sin cliente, la bandeja', () => {
    expect(ctaDeNotificacion({ category: 'handoff', customerId: '595991234567' })?.href).toBe('/conversations?c=595991234567');
    expect(ctaDeNotificacion({ category: 'handoff' })?.href).toBe('/conversations');
  });

  it('categoría DESCONOCIDA (backend más nuevo que el panel) ⇒ sin link: no se adivina un destino', async () => {
    // Adivinar es lo que produjo el hallazgo. Sin CTA el aviso se sigue leyendo y marcando leído.
    expect(ctaDeNotificacion({ category: 'catalog_futuro' as Notification['category'] })).toBeNull();
    const links = await abrirCampana([aviso({ category: 'catalog_futuro' as Notification['category'] })]);
    expect(links).toEqual([]);
    expect(screen.getByText('Marcar como leído')).toBeInTheDocument();
  });
});
