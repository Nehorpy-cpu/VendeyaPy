/**
 * page.feedback.test.tsx — H-38 y H-15 en /ads.
 *
 * H-38: «Sincronizar» y «Calcular atribución» no confirmaban nada; con los mismos números en
 * pantalla, el dueño no podía distinguir «se recalculó y no cambió» de «no se ejecutó».
 *
 * H-15: si la lectura de campañas fallaba, la pantalla quedaba en blanco — ni error, ni vacío, ni
 * explicación.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AdsPage from './page';

const listCampaignsMock = vi.fn();
const syncAdsMock = vi.fn();
const computeAttributionMock = vi.fn();

vi.mock('@/lib/ads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ads')>()),
  listCampaigns: (...a: unknown[]) => listCampaignsMock(...a),
  syncAds: (...a: unknown[]) => syncAdsMock(...a),
  computeAttribution: (...a: unknown[]) => computeAttributionMock(...a),
}));
vi.mock('@/lib/active-company', () => ({
  useActiveCompany: () => ({ tenantId: 'perfumeria', loading: false, companies: [], setTenantId: vi.fn() }),
}));

const renderPage = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AdsPage />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  listCampaignsMock.mockResolvedValue([]);
  syncAdsMock.mockResolvedValue(undefined);
  computeAttributionMock.mockResolvedValue(undefined);
});

describe('H-38 · sincronizar y atribuir dicen cómo terminaron', () => {
  it('sincronización exitosa ⇒ lo confirma', async () => {
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /sincronizar/i }));

    const avisos = await screen.findAllByText(/pedimos la sincronización de campañas/i);
    expect(avisos.some((e) => e.tagName === 'P')).toBe(true); // el visible
    expect(avisos.some((e) => e.className.includes('sr-only'))).toBe(true); // el anunciado
    // El texto es un PEDIDO, no un resultado: `syncAds` va por un endpoint dev que no chequea res.ok.
    expect(screen.queryByText(/campañas sincronizadas./i)).toBeNull();
  });

  it('atribución rechazada ⇒ muestra el motivo del backend', async () => {
    computeAttributionMock.mockRejectedValue(
      Object.assign(new Error('Tu plan no incluye atribución.'), { code: 'functions/failed-precondition' }),
    );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /calcular atribución/i }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/tu plan no incluye atribución/i);
  });
});

describe('H-15 · la lectura caída no deja la pantalla en blanco', () => {
  it('si no se pueden leer las campañas, lo dice', async () => {
    listCampaignsMock.mockRejectedValue(new Error('permission-denied'));
    renderPage();

    expect(await screen.findByText(/no pudimos leer tus campañas/i)).toBeTruthy();
    expect(screen.queryByText(/Sin campañas todavía/i)).toBeNull();
  });

  it('NO REGRESIÓN: vacío de verdad ⇒ sigue mostrando el estado vacío', async () => {
    listCampaignsMock.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText(/Sin campañas todavía/i)).toBeTruthy();
    expect(screen.queryByText(/no pudimos leer/i)).toBeNull();
  });
});
