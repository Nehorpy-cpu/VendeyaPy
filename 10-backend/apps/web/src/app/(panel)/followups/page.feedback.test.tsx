/**
 * page.feedback.test.tsx — H-38 y H-15 en /followups.
 *
 * H-38: «Actualizar tareas» corría el job real y no confirmaba nada.
 * H-15: el subtítulo salía de `tasksQ.data ?? []`; con la lectura caída, la longitud daba 0 y la
 * pantalla afirmaba «Sin tareas pendientes.» — el peor mensaje posible sobre una lista de plata
 * pendiente de cobrar que nunca se leyó.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import FollowupsPage from './page';

const listFollowUpTasksMock = vi.fn();
const generateFollowupsMock = vi.fn();

vi.mock('@/lib/followups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/followups')>()),
  listFollowUpTasks: (...a: unknown[]) => listFollowUpTasksMock(...a),
  setTaskStatus: vi.fn(async () => undefined),
  generateFollowups: (...a: unknown[]) => generateFollowupsMock(...a),
}));
vi.mock('@/lib/active-company', () => ({
  useActiveCompany: () => ({ tenantId: 'perfumeria', loading: false, companies: [], setTenantId: vi.fn() }),
}));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ claims: { tenantId: 'perfumeria', role: 'TENANT_OWNER' }, user: { uid: 'uid-owner' } }),
}));

const renderPage = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FollowupsPage />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  listFollowUpTasksMock.mockResolvedValue([]);
  generateFollowupsMock.mockResolvedValue(undefined);
});

describe('H-38 · el job de seguimientos dice cómo terminó', () => {
  it('si sale bien, lo confirma', async () => {
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /actualizar tareas/i }));

    const avisos = await screen.findAllByText(/volvimos a revisar/i);
    expect(avisos.some((e) => e.tagName === 'P')).toBe(true); // el visible
    expect(avisos.some((e) => e.className.includes('sr-only'))).toBe(true); // el anunciado
  });

  it('si el plan no lo permite, muestra el motivo del backend una sola vez', async () => {
    generateFollowupsMock.mockRejectedValue(
      Object.assign(new Error('Tu plan no incluye seguimientos automáticos.'), {
        code: 'functions/failed-precondition',
      }),
    );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /actualizar tareas/i }));

    const avisos = await screen.findAllByText(/tu plan no incluye seguimientos/i);
    expect(avisos).toHaveLength(1); // no duplicado: un solo lugar dice el error
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

describe('H-15 · el subtítulo deja de mentir cuando la lectura falla', () => {
  it('lectura caída ⇒ no dice «Sin tareas pendientes»', async () => {
    listFollowUpTasksMock.mockRejectedValue(new Error('permission-denied'));
    renderPage();

    expect(await screen.findByText(/no pudimos leer tus seguimientos/i)).toBeTruthy();
    expect(screen.queryByText(/Sin tareas pendientes/i)).toBeNull();
    expect(screen.queryByText(/Sin pendientes/i)).toBeNull();
  });

  it('NO REGRESIÓN: vacío de verdad ⇒ sigue diciendo «Sin tareas pendientes.»', async () => {
    listFollowUpTasksMock.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText(/Sin tareas pendientes/i)).toBeTruthy();
    expect(screen.queryByText(/no pudimos leer/i)).toBeNull();
  });
});
