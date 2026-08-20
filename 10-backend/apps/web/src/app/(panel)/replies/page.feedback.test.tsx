/**
 * page.feedback.test.tsx — H-03/H-38 y H-15 en /replies.
 *
 * Guardar o archivar una respuesta ganadora no tenía rama de error, «Buscar ganadoras» no
 * confirmaba nada, y una lectura caída dejaba la pantalla sin lista ni explicación.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import RepliesPage from './page';

const listRepliesMock = vi.fn();
const upsertReplyMock = vi.fn();
const generateRepliesMock = vi.fn();

vi.mock('@/lib/replies', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/replies')>()),
  listReplies: (...a: unknown[]) => listRepliesMock(...a),
  upsertReply: (...a: unknown[]) => upsertReplyMock(...a),
  archiveReply: vi.fn(async () => undefined),
  generateReplies: (...a: unknown[]) => generateRepliesMock(...a),
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
      <RepliesPage />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  listRepliesMock.mockResolvedValue([]);
  upsertReplyMock.mockResolvedValue(undefined);
  generateRepliesMock.mockResolvedValue(undefined);
});

describe('H-03/H-38 · las acciones de respuestas dicen qué pasó', () => {
  it('si guardar falla, muestra el motivo y conserva lo escrito', async () => {
    upsertReplyMock.mockRejectedValue(
      Object.assign(new Error('Campo "text" demasiado largo.'), { code: 'functions/invalid-argument' }),
    );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /nueva/i }));
    const primero = screen.getAllByRole('textbox')[0] as HTMLInputElement;
    fireEvent.change(primero, { target: { value: 'Cuando preguntan por el precio' } });
    fireEvent.submit(primero.closest('form') as HTMLFormElement);

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toMatch(/demasiado largo/i);
    // Dentro del modal: un aviso en el cuerpo de la página quedaría detrás del overlay.
    expect(primero.closest('form')!.contains(aviso)).toBe(true);
    expect((screen.getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('Cuando preguntan por el precio');
  });

  it('«Buscar ganadoras» confirma cuando sale bien y explica cuando falla', async () => {
    const { unmount } = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /buscar ganadoras/i }));
    const avisos = await screen.findAllByText(/buscamos tus respuestas ganadoras/i);
    expect(avisos.some((e) => e.tagName === 'P')).toBe(true); // el visible
    expect(avisos.some((e) => e.className.includes('sr-only'))).toBe(true); // el anunciado
    unmount();

    generateRepliesMock.mockRejectedValue(
      Object.assign(new Error('nope'), { code: 'functions/permission-denied' }),
    );
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /buscar ganadoras/i }));
    const avisosError = await screen.findAllByText(/tu rol no puede ejecutar/i);
    expect(avisosError).toHaveLength(1); // el error no se duplica (va solo al alert, no a la live region)
  });
});

describe('H-15 · la lectura caída no deja la pantalla muda', () => {
  it('si no se pueden leer las respuestas, lo dice y no inventa un vacío', async () => {
    listRepliesMock.mockRejectedValue(new Error('permission-denied'));
    renderPage();

    expect(await screen.findByText(/no pudimos leer tus respuestas/i)).toBeTruthy();
    expect(screen.queryByText(/Sin respuestas todavía/i)).toBeNull();
  });

  it('NO REGRESIÓN: vacío de verdad ⇒ sigue mostrando el estado vacío', async () => {
    listRepliesMock.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText(/Sin respuestas todavía/i)).toBeTruthy();
    expect(screen.queryByText(/no pudimos leer/i)).toBeNull();
  });
});
