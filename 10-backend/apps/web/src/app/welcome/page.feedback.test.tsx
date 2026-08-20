/**
 * page.feedback.test.tsx — H-39 en /welcome.
 *
 * Es la PRIMERA pantalla del dueño nuevo. «Aplicar plantilla» escribe la config del agente y las
 * categorías; si fallaba, el botón volvía de «Aplicando…» a «Aplicar plantilla» y no pasaba nada:
 * el dueño seguía al panel creyendo que su rubro quedó configurado. Lo mismo con «Ir al panel».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import WelcomePage from './page';

const applyTemplateMock = vi.fn();
const completeOnboardingMock = vi.fn();
const replaceMock = vi.fn();

vi.mock('@/lib/templates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/templates')>()),
  applyTemplate: (...a: unknown[]) => applyTemplateMock(...a),
}));
vi.mock('@/lib/registration', () => ({
  completeOnboarding: (...a: unknown[]) => completeOnboardingMock(...a),
  getTenantOnboardingCompleted: vi.fn(async () => false),
}));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ claims: { tenantId: 'perfumeria', role: 'TENANT_OWNER' }, user: { uid: 'uid-owner' }, loading: false }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: replaceMock, push: vi.fn() }) }));
vi.mock('firebase/firestore', () => ({ doc: vi.fn(), getDoc: vi.fn(async () => ({ data: () => ({ name: 'Perfumería AFG' }) })) }));
vi.mock('@/lib/firebase', () => ({ firebaseDb: () => ({}) }));

const renderPage = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <WelcomePage />
    </QueryClientProvider>,
  );
};

const primerBotonAplicar = async () => (await screen.findAllByRole('button', { name: /aplicar plantilla/i }))[0]!;

beforeEach(() => {
  vi.clearAllMocks();
  applyTemplateMock.mockResolvedValue(undefined);
  completeOnboardingMock.mockResolvedValue(undefined);
});

describe('H-39 · aplicar la plantilla no falla en silencio', () => {
  it('si falla, el dueño nuevo ve el motivo', async () => {
    applyTemplateMock.mockRejectedValue(
      Object.assign(new Error('Tu rol no puede escribir la configuración.'), { code: 'functions/permission-denied' }),
    );
    renderPage();

    fireEvent.click(await primerBotonAplicar());

    expect((await screen.findByRole('alert')).textContent).toMatch(/tu rol no puede ejecutar/i);
    // Y no se marca como aplicada una plantilla que nunca se escribió.
    expect(screen.queryByText(/✓ Aplicada/)).toBeNull();
  });

  it('NO REGRESIÓN: si aplica bien, marca «✓ Aplicada» y no muestra error', async () => {
    renderPage();

    fireEvent.click(await primerBotonAplicar());

    expect(await screen.findByText(/✓ Aplicada/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('si «Ir al panel» falla, lo dice en vez de dejar al dueño esperando', async () => {
    completeOnboardingMock.mockRejectedValue(
      Object.assign(new Error('nope'), { code: 'functions/unavailable' }),
    );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /ir al panel/i }));

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toMatch(/no pudimos finalizar el onboarding/i);
    expect(aviso.textContent).toMatch(/no está disponible/i); // el motivo del backend, no solo el rótulo
    expect(replaceMock).not.toHaveBeenCalledWith('/dashboard');

    // Y donde el dueño está mirando: inmediatamente antes del botón que acaba de tocar. Si el aviso
    // vive arriba de todo, en mobile queda dos secciones más arriba del fold.
    const boton = screen.getByRole('button', { name: /ir al panel/i });
    expect(aviso.nextElementSibling).toBe(boton);
  });

  it('NO REGRESIÓN: si «Ir al panel» sale bien, redirige al dashboard', async () => {
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /ir al panel/i }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/dashboard'));
  });
});
