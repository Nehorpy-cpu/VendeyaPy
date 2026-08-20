/**
 * page.feedback.test.tsx — H-03/H-38 y H-15 en /tracking.
 *
 * Guardar o borrar un código (cupón, QR, link) no tenía rama de error: si el backend rechazaba, el
 * modal se quedaba abierto sin explicación. «Calcular atribución» tampoco confirmaba nada, y una
 * lectura caída dejaba la pantalla muda.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TrackingPage from './page';

const listTrackingSourcesMock = vi.fn();
const upsertTrackingSourceMock = vi.fn();
const computeTrackingMock = vi.fn();

vi.mock('@/lib/tracking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tracking')>()),
  listTrackingSources: (...a: unknown[]) => listTrackingSourcesMock(...a),
  upsertTrackingSource: (...a: unknown[]) => upsertTrackingSourceMock(...a),
  deleteTrackingSource: vi.fn(async () => undefined),
  computeTracking: (...a: unknown[]) => computeTrackingMock(...a),
}));
// La empresa activa es mutable: cambiarla NO remonta la pantalla (`active-company` solo cambia
// el contexto), que es justo la condición en la que un aviso viejo puede quedar colgado.
const empresa = vi.hoisted(() => ({ tenantId: 'perfumeria' }));
vi.mock('@/lib/active-company', () => ({
  useActiveCompany: () => ({ tenantId: empresa.tenantId, loading: false, companies: [], setTenantId: vi.fn() }),
}));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ claims: { tenantId: 'perfumeria', role: 'TENANT_OWNER' }, user: { uid: 'uid-owner' } }),
}));

const renderPage = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TrackingPage />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  empresa.tenantId = 'perfumeria';
  listTrackingSourcesMock.mockResolvedValue([]);
  upsertTrackingSourceMock.mockResolvedValue(undefined);
  computeTrackingMock.mockResolvedValue(undefined);
});

describe('H-03/H-38 · las acciones de tracking dicen qué pasó', () => {
  it('si guardar el código falla, muestra el motivo y no cierra el formulario', async () => {
    upsertTrackingSourceMock.mockRejectedValue(
      Object.assign(new Error('Ese código ya existe.'), { code: 'functions/invalid-argument' }),
    );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /nuevo código/i }));
    const codigo = screen.getAllByRole('textbox')[0] as HTMLInputElement;
    fireEvent.change(codigo, { target: { value: 'VERANO20' } });
    // happy-dom no propaga el click del submit al <form> (convención del repo).
    fireEvent.submit(codigo.closest('form') as HTMLFormElement);

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toMatch(/ese código ya existe/i);
    // Dentro del modal: el formulario es un overlay que taparía un aviso del cuerpo de la página.
    expect(codigo.closest('form')!.contains(aviso)).toBe(true);
    expect((screen.getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('VERANO20');
  });

  it('el aviso NO sobrevive al cambio de empresa', async () => {
    computeTrackingMock.mockRejectedValue(
      Object.assign(new Error('nope'), { code: 'functions/permission-denied' }),
    );
    const { rerender } = renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /calcular atribución/i }));
    await screen.findByRole('alert');

    empresa.tenantId = 'boutique-demo';
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TrackingPage />
      </QueryClientProvider>,
    );

    // Si el aviso siguiera, se leería como si fuera el tracking de la empresa nueva.
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('el cálculo de atribución exitoso lo confirma en pantalla', async () => {
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /calcular atribución/i }));

    const avisos = await screen.findAllByText(/atribución de cupones recalculada/i);
    expect(avisos.some((e) => e.tagName === 'P')).toBe(true); // el visible
    expect(avisos.some((e) => e.className.includes('sr-only'))).toBe(true); // el anunciado
  });

  it('el cálculo rechazado muestra el motivo una sola vez', async () => {
    computeTrackingMock.mockRejectedValue(
      Object.assign(new Error('nope'), { code: 'functions/permission-denied' }),
    );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /calcular atribución/i }));

    const avisos = await screen.findAllByText(/tu rol no puede ejecutar/i);
    expect(avisos).toHaveLength(1);
  });

  it('un éxito anterior NO tapa el rechazo de un guardado cancelado en vuelo', async () => {
    let rechazar: (() => void) | undefined;
    upsertTrackingSourceMock.mockImplementation(
      () => new Promise((_ok, fail) => {
        rechazar = () => fail(Object.assign(new Error('Ese código ya existe.'), { code: 'functions/invalid-argument' }));
      }),
    );
    renderPage();

    // 1) una acción de pantalla sale bien y deja su verde
    fireEvent.click(await screen.findByRole('button', { name: /calcular atribución/i }));
    await screen.findAllByText(/atribución de cupones recalculada/i);

    // 2) el dueño guarda un código y cancela mientras está en vuelo
    fireEvent.click(screen.getByRole('button', { name: /nuevo código/i }));
    const codigo = screen.getAllByRole('textbox')[0] as HTMLInputElement;
    fireEvent.change(codigo, { target: { value: 'VERANO20' } });
    fireEvent.submit(codigo.closest('form') as HTMLFormElement);
    await waitFor(() => expect(upsertTrackingSourceMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /cancelar/i }));

    rechazar!();

    // 3) lo que se ve es el rechazo, no el verde de antes
    expect((await screen.findByRole('alert')).textContent).toMatch(/ese código ya existe/i);
    expect(screen.queryByText(/atribución de cupones recalculada/i)).toBeNull();
  });
});

describe('H-15 · la lectura caída no deja la pantalla muda', () => {
  it('si no se pueden leer los códigos, lo dice y no inventa un vacío', async () => {
    listTrackingSourcesMock.mockRejectedValue(new Error('permission-denied'));
    renderPage();

    expect(await screen.findByText(/no pudimos leer tus códigos/i)).toBeTruthy();
    expect(screen.queryByText(/Sin códigos todavía/i)).toBeNull();
  });

  it('NO REGRESIÓN: vacío de verdad ⇒ sigue mostrando el estado vacío', async () => {
    listTrackingSourcesMock.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText(/Sin códigos todavía/i)).toBeTruthy();
    expect(screen.queryByText(/no pudimos leer/i)).toBeNull();
  });
});
