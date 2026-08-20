/**
 * page.feedback.test.tsx — H-03 en /promotions: crear, activar, finalizar y descartar no pueden
 * fallar en silencio.
 *
 * Las cinco mutaciones de esta pantalla no tenían `onError`. Si el backend rechazaba (nombre
 * demasiado largo, rol sin permiso, plan sin la feature), el modal quedaba abierto con el trabajo
 * adentro y ni una palabra en pantalla: el dueño cerraba creyendo que no había pasado nada.
 *
 * Y H-15: la lista se renderiza con `isSuccess`, así que una lectura caída no mentía — pero dejaba
 * la pantalla muda, sin decir que no se pudo leer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PromotionsPage from './page';

const listPromotionsMock = vi.fn();
const upsertPromotionMock = vi.fn();
const listPromoSuggestionsMock = vi.fn();
const listProductsMock = vi.fn();
const deletePromotionMock = vi.fn();

vi.mock('@/lib/promotions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/promotions')>()),
  listPromotions: (...a: unknown[]) => listPromotionsMock(...a),
  upsertPromotion: (...a: unknown[]) => upsertPromotionMock(...a),
  deletePromotion: (...a: unknown[]) => deletePromotionMock(...a),
  listPromoSuggestions: (...a: unknown[]) => listPromoSuggestionsMock(...a),
  setInsightStatus: vi.fn(async () => undefined),
}));
vi.mock('@/lib/catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/catalog')>()),
  listProducts: (...a: unknown[]) => listProductsMock(...a),
}));
vi.mock('@/lib/active-company', () => ({
  useActiveCompany: () => ({ tenantId: 'perfumeria', loading: false, companies: [], setTenantId: vi.fn() }),
}));

const renderPage = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PromotionsPage />
    </QueryClientProvider>,
  );
};

// Los <label> del formulario no están asociados a sus inputs (no hay htmlFor/id), así que no se
// puede consultar por etiqueta: el primer textbox del modal es «Nombre *».
const campoNombre = () => screen.getAllByRole('textbox')[0] as HTMLInputElement;

// happy-dom no propaga el click del botón submit al <form> (convención del repo: ProductForm,
// login). Se dispara el submit sobre el form, que es lo que el botón haría en el navegador.
const guardar = () => fireEvent.submit(campoNombre().closest('form') as HTMLFormElement);

const abrirFormulario = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /nueva promo/i }));
  await screen.findByText(/Nueva promoción/i);
  fireEvent.change(campoNombre(), { target: { value: 'Promo verano' } });
};

beforeEach(() => {
  vi.clearAllMocks();
  listPromotionsMock.mockResolvedValue([]);
  listPromoSuggestionsMock.mockResolvedValue([]);
  listProductsMock.mockResolvedValue([]);
  upsertPromotionMock.mockResolvedValue(undefined);
  deletePromotionMock.mockResolvedValue(undefined);
});

describe('H-03 · las acciones de promociones dicen qué pasó', () => {
  it('si el backend rechaza la promo, la pantalla muestra el motivo', async () => {
    upsertPromotionMock.mockRejectedValue(
      Object.assign(new Error('Campo "name" demasiado largo.'), { code: 'functions/invalid-argument' }),
    );
    renderPage();
    await abrirFormulario();

    guardar();

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toMatch(/demasiado largo/i);
    // Y donde el dueño está mirando: el modal es un overlay `fixed inset-0 z-50`, así que un aviso
    // en el cuerpo de la página queda tapado (y fuera de pantalla si scrolleó hasta la promo #18).
    expect(campoNombre().closest('form')!.contains(aviso)).toBe(true);
  });

  it('ante el error, el trabajo del dueño sigue en el formulario', async () => {
    upsertPromotionMock.mockRejectedValue(
      Object.assign(new Error('Campo "name" demasiado largo.'), { code: 'functions/invalid-argument' }),
    );
    renderPage();
    await abrirFormulario();

    guardar();
    await screen.findByRole('alert');

    // El modal no se cierra y lo escrito no se pierde.
    expect(campoNombre().value).toBe('Promo verano');
  });

  it('al reabrir el formulario, el error del intento anterior NO sigue ahí', async () => {
    upsertPromotionMock.mockRejectedValue(
      Object.assign(new Error('Campo "name" demasiado largo.'), { code: 'functions/invalid-argument' }),
    );
    renderPage();
    await abrirFormulario();
    guardar();
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: /cancelar/i }));
    await waitFor(() => expect(screen.queryByText(/Nueva promoción/i)).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /nueva promo/i }));
    await screen.findByText(/Nueva promoción/i);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('NO REGRESIÓN: si guarda bien, cierra el modal y no muestra error', async () => {
    renderPage();
    await abrirFormulario();

    guardar();

    await waitFor(() => expect(screen.queryByText(/Nueva promoción/i)).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(upsertPromotionMock).toHaveBeenCalledTimes(1);
  });
});

describe('H-03 · el rechazo no se pierde ni se arrastra entre aperturas', () => {
  it('si el dueño cancela MIENTRAS guarda, el rechazo se dice igual en la pantalla', async () => {
    // Estos modales no tienen Escape ni cierre por el fondo, así que «Cancelar» no puede
    // bloquearse (encerraría al dueño hasta el timeout del callable). El precio es que el rechazo
    // puede llegar con el modal ya desmontado: ahí el aviso cae al cuerpo de la página.
    let rechazar: (() => void) | undefined;
    upsertPromotionMock.mockImplementation(
      () => new Promise((_ok, fail) => {
        rechazar = () => fail(Object.assign(new Error('Campo "name" demasiado largo.'), { code: 'functions/invalid-argument' }));
      }),
    );
    renderPage();
    await abrirFormulario();
    guardar();

    fireEvent.click(screen.getByRole('button', { name: /cancelar/i }));
    await waitFor(() => expect(screen.queryByText(/Nueva promoción/i)).toBeNull());

    rechazar!();

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toMatch(/demasiado largo/i);
  });

  it('cancelar el borrado mientras corre tampoco deja el rechazo mudo', async () => {
    listPromotionsMock.mockResolvedValue([
      { id: 'p1', name: 'Promo verano', objective: 'rotar stock', type: 'PERCENTAGE', discountValue: 10, productIds: [], categoryIds: [], status: 'ACTIVE', startDate: null, endDate: null },
    ]);
    let rechazar: (() => void) | undefined;
    deletePromotionMock.mockImplementation(
      () => new Promise((_ok, fail) => {
        rechazar = () => fail(Object.assign(new Error('nope'), { code: 'functions/permission-denied' }));
      }),
    );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /finalizar/i }));
    const dialogo = await screen.findByRole('dialog');
    fireEvent.click(within(dialogo).getByRole('button', { name: /finalizar/i }));
    // «Cancelar» del ConfirmModal sigue habilitado durante la acción (es el componente compartido).
    fireEvent.click(within(dialogo).getByRole('button', { name: /cancelar/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    rechazar!();

    expect((await screen.findByRole('alert')).textContent).toMatch(/tu rol no puede ejecutar/i);
  });

  it('crear desde una sugerencia no arrastra el error del intento anterior', async () => {
    listPromoSuggestionsMock.mockResolvedValue([
      { id: 'i1', title: 'Destacá Perfume X', description: 'Stock parado', estimatedImpact: '+10%', recommendedAction: 'Promo 10%', priority: 'HIGH', relatedEntityId: 'p1', relatedEntityType: 'product' },
    ]);
    upsertPromotionMock.mockRejectedValue(
      Object.assign(new Error('Campo "name" demasiado largo.'), { code: 'functions/invalid-argument' }),
    );
    renderPage();
    await abrirFormulario();
    guardar();
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /cancelar/i }));

    fireEvent.click(await screen.findByRole('button', { name: /crear promo/i }));
    await screen.findByText(/Nueva promoción/i);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('si finalizar una promo es rechazado, el motivo se dice DENTRO del diálogo', async () => {
    listPromotionsMock.mockResolvedValue([
      { id: 'p1', name: 'Promo verano', objective: 'rotar stock', type: 'PERCENTAGE', discountValue: 10, productIds: [], categoryIds: [], status: 'ACTIVE', startDate: null, endDate: null },
    ]);
    deletePromotionMock.mockRejectedValue(
      Object.assign(new Error('nope'), { code: 'functions/permission-denied' }),
    );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /finalizar/i }));
    const dialogo = await screen.findByRole('dialog');
    fireEvent.click(within(dialogo).getByRole('button', { name: /finalizar/i }));

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toMatch(/tu rol no puede ejecutar/i);
    expect(dialogo.contains(aviso)).toBe(true); // no detrás del overlay
  });
});

describe('H-15 · una lectura caída no deja la pantalla muda', () => {
  it('si no se pueden leer las promociones, lo dice', async () => {
    listPromotionsMock.mockRejectedValue(new Error('permission-denied'));
    renderPage();

    expect(await screen.findByText(/no pudimos leer tus promociones/i)).toBeTruthy();
    // Y no inventa un vacío que nunca se leyó.
    expect(screen.queryByText(/Todavía no hay promociones/i)).toBeNull();
  });

  it('si no se pueden leer las sugerencias, tampoco las da por vacías', async () => {
    listPromoSuggestionsMock.mockRejectedValue(new Error('permission-denied'));
    renderPage();

    expect(await screen.findByText(/no pudimos leer tus sugerencias/i)).toBeTruthy();
    expect(screen.queryByText(/No hay sugerencias por ahora/i)).toBeNull();
  });

  it('NO REGRESIÓN: vacío de verdad ⇒ sigue mostrando el estado vacío', async () => {
    listPromotionsMock.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText(/Todavía no hay promociones/i)).toBeTruthy();
    expect(screen.queryByText(/no pudimos leer/i)).toBeNull();
  });
});
