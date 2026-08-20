/**
 * page.feedback.test.tsx — H-39 y H-15 en /onboarding (Primeros pasos).
 *
 * «Aplicar plantilla» no tenía rama de error: si fallaba, el botón se reseteaba y la pantalla no
 * decía nada. Y el checklist se arma con `data ?? []`: si una lectura falla, los pasos aparecen
 * como pendientes y el porcentaje miente sobre lo que el dueño ya configuró.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import OnboardingPage from './page';

const applyTemplateMock = vi.fn();
const getAgentConfigMock = vi.fn();
const listProductsMock = vi.fn();
const getCheckoutConfigMock = vi.fn();
const listCustomersMock = vi.fn();

vi.mock('@/lib/templates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/templates')>()),
  applyTemplate: (...a: unknown[]) => applyTemplateMock(...a),
}));
vi.mock('@/lib/agent-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-config')>()),
  getAgentConfig: (...a: unknown[]) => getAgentConfigMock(...a),
  getCheckoutConfig: (...a: unknown[]) => getCheckoutConfigMock(...a),
}));
vi.mock('@/lib/catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/catalog')>()),
  listProducts: (...a: unknown[]) => listProductsMock(...a),
}));
vi.mock('@/lib/conversations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/conversations')>()),
  listCustomers: (...a: unknown[]) => listCustomersMock(...a),
}));
vi.mock('@/lib/active-company', () => ({
  useActiveCompany: () => ({ tenantId: 'perfumeria', loading: false, companies: [], setTenantId: vi.fn() }),
}));

const renderPage = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OnboardingPage />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  applyTemplateMock.mockResolvedValue(undefined);
  getAgentConfigMock.mockResolvedValue({ industry: 'perfumeria' });
  getCheckoutConfigMock.mockResolvedValue({ bankAccounts: [], sellers: [] });
  listProductsMock.mockResolvedValue([]);
  listCustomersMock.mockResolvedValue([]);
});

describe('H-39 · aplicar la plantilla no falla en silencio', () => {
  it('si falla, muestra el motivo', async () => {
    applyTemplateMock.mockRejectedValue(
      Object.assign(new Error('Tu plan no permite esta acción.'), { code: 'functions/failed-precondition' }),
    );
    renderPage();

    fireEvent.click((await screen.findAllByRole('button', { name: /aplicar/i }))[0]!);

    expect((await screen.findByRole('alert')).textContent).toMatch(/tu plan no permite esta acción/i);
  });

  it('NO REGRESIÓN: si aplica bien, no muestra ningún error', async () => {
    renderPage();

    fireEvent.click((await screen.findAllByRole('button', { name: /aplicar/i }))[0]!);

    await waitFor(() => expect(applyTemplateMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('H-15 · el checklist avisa cuando no pudo leer el progreso', () => {
  it('si una lectura falla, dice que el checklist puede estar incompleto', async () => {
    listProductsMock.mockRejectedValue(new Error('permission-denied'));
    renderPage();

    expect(await screen.findByText(/no pudimos leer tus productos/i)).toBeTruthy();
  });

  it('el paso que no se pudo leer se marca «no verificado» y sale del progreso', async () => {
    listProductsMock.mockRejectedValue(new Error('permission-denied'));
    renderPage();

    expect(await screen.findByText(/no pudimos verificar este paso/i)).toBeTruthy();
    // El progreso se calcula sobre lo que SÍ se leyó: 3 pasos verificables, no 4.
    const contador = (t: string, el: Element | null) => el?.tagName === "SPAN" && el.textContent === "1/3";
    expect(await screen.findByText(contador)).toBeTruthy();
    // Y no se ofrece «Ir» sobre el paso cuyo estado se desconoce (los otros dos sí lo ofrecen).
    const irs = screen.getAllByRole('link', { name: /^ir$/i });
    expect(irs.map((a) => a.getAttribute('href'))).not.toContain('/catalog');
  });

  it('mientras carga NO dice que no pudo verificar nada', async () => {
    // Cargar no es fallar: con las cuatro lecturas en vuelo, `data` es undefined en las cuatro y
    // la pantalla de bienvenida del dueño nuevo llegó a mostrar cinco mensajes rojos de falla.
    getAgentConfigMock.mockImplementation(() => new Promise(() => {}));
    listProductsMock.mockImplementation(() => new Promise(() => {}));
    getCheckoutConfigMock.mockImplementation(() => new Promise(() => {}));
    listCustomersMock.mockImplementation(() => new Promise(() => {}));
    renderPage();

    await screen.findByText(/Primeros pasos/i);
    expect(screen.queryByText(/no pudimos verificar/i)).toBeNull();
    expect(screen.queryByText(/no pudimos leer/i)).toBeNull();
  });

  it('NO REGRESIÓN: con todas las lecturas OK no aparece el aviso', async () => {
    renderPage();

    await screen.findByText(/Primeros pasos/i);
    await waitFor(() => expect(listProductsMock).toHaveBeenCalled());
    expect(screen.queryByText(/no pudimos leer/i)).toBeNull();
    expect(screen.queryByText(/no pudimos verificar/i)).toBeNull();
  });
});
