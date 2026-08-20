/**
 * page.feedback.test.tsx — H-38 y H-15 en /decisions.
 *
 * H-38: «Actualizar acciones» y los botones Hecho/Descartar no decían nada. El botón volvía de
 * «Buscando…» a su estado normal y la lista quedaba igual: indistinguible de «no hay nada nuevo».
 *
 * H-15: el subtítulo salía de `insightsQ.data?.length ?? 0`. Con la lectura caída, `undefined ?? 0`
 * daba cero y la pantalla afirmaba «Sin acciones pendientes.» sobre una lista que nunca se leyó.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DecisionsPage from './page';

const listPendingInsightsMock = vi.fn();
const generateInsightsMock = vi.fn();

vi.mock('@/lib/insights', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/insights')>()),
  listPendingInsights: (...a: unknown[]) => listPendingInsightsMock(...a),
  setInsightStatus: vi.fn(async () => undefined),
  generateInsights: (...a: unknown[]) => generateInsightsMock(...a),
}));
vi.mock('@/lib/active-company', () => ({
  useActiveCompany: () => ({ tenantId: 'perfumeria', loading: false, companies: [], setTenantId: vi.fn() }),
}));

const renderPage = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DecisionsPage />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  listPendingInsightsMock.mockResolvedValue([]);
  generateInsightsMock.mockResolvedValue(undefined);
});

describe('H-38 · el job de acciones dice cómo terminó', () => {
  it('si sale bien, lo confirma en pantalla', async () => {
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /actualizar acciones/i }));

    // El endpoint dev no chequea res.ok, así que el mensaje promete un PEDIDO, no un resultado.
    const avisos = await screen.findAllByText(/pedimos una revisión de tus acciones/i);
    expect(avisos.some((e) => e.tagName === 'P')).toBe(true); // el visible
    expect(avisos.some((e) => e.className.includes('sr-only'))).toBe(true); // el anunciado
  });

  it('si el backend lo rechaza, muestra el motivo', async () => {
    generateInsightsMock.mockRejectedValue(
      Object.assign(new Error('nope'), { code: 'functions/permission-denied' }),
    );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /actualizar acciones/i }));

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toMatch(/tu rol no puede ejecutar/i);
  });
});

describe('H-15 · el subtítulo deja de mentir cuando la lectura falla', () => {
  it('lectura caída ⇒ no dice «Sin acciones pendientes»', async () => {
    listPendingInsightsMock.mockRejectedValue(new Error('permission-denied'));
    renderPage();

    expect(await screen.findByText(/no pudimos leer tus acciones/i)).toBeTruthy();
    expect(screen.queryByText(/Sin acciones pendientes/i)).toBeNull();
    // Tampoco muestra el estado vacío festivo sobre una lectura que no ocurrió.
    expect(screen.queryByText(/Todo al día/i)).toBeNull();
  });

  it('NO REGRESIÓN: vacío de verdad ⇒ sigue diciendo «Sin acciones pendientes.»', async () => {
    listPendingInsightsMock.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText(/Sin acciones pendientes/i)).toBeTruthy();
    expect(screen.queryByText(/no pudimos leer/i)).toBeNull();
  });
});
