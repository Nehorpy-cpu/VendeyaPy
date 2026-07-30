/**
 * page.test.tsx — Selección y habilitación MASIVA de sincronización del catálogo (HARDEN-1).
 * Fija los comportamientos que bloquearon la review adversarial:
 * - la selección masiva excluye TODOS los bloqueados (quality.blocking>0) y aplica el
 *   predicado conservador a los sin evaluar (solo ACTIVE con stock revisado);
 * - la barra masiva informa elegibles y excluidos AGRUPADOS por razón;
 * - la tanda llama SOLO a metaCatalogSetSyncEnabled (jamás apply/endpoints de Meta) y
 *   reporta el desenlace por producto (habilitados y quedados fuera, con motivo).
 * Los hijos pesados (reconciliación, importador, centro de calidad, form) se stubbean:
 * tienen sus propios tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Product } from '@vpw/shared';
import { normalizarOwnershipStatus } from '@/lib/catalog';
import CatalogPage from './page';

const listProductsMock = vi.fn();
const listCategoriesMock = vi.fn();
const listFinancialsMock = vi.fn();
const setSyncEnabledMock = vi.fn();
const syncCatalogMock = vi.fn();
const upsertMock = vi.fn();
const deleteMock = vi.fn();
const importItemsMock = vi.fn();
const confirmMappingMock = vi.fn();
const reconcileJobMock = vi.fn();
const runImportMock = vi.fn();
const ownershipMock = vi.fn();
vi.mock('@/lib/catalog', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/catalog')>();
  return {
    ...real,
    fetchCatalogOwnershipStatus: (...a: unknown[]) => ownershipMock(...a),
    listProducts: (...a: unknown[]) => listProductsMock(...a),
    listCategories: (...a: unknown[]) => listCategoriesMock(...a),
    listProductFinancials: (...a: unknown[]) => listFinancialsMock(...a),
    setProductSyncEnabled: (...a: unknown[]) => setSyncEnabledMock(...a),
    syncCatalogToMeta: (...a: unknown[]) => syncCatalogMock(...a),
    upsertProduct: (...a: unknown[]) => upsertMock(...a),
    deleteProduct: (...a: unknown[]) => deleteMock(...a),
    importMetaItems: (...a: unknown[]) => importItemsMock(...a),
    confirmMetaMapping: (...a: unknown[]) => confirmMappingMock(...a),
    reconcileOutboxJob: (...a: unknown[]) => reconcileJobMock(...a),
    runMetaCatalogImport: (...a: unknown[]) => runImportMock(...a),
  };
});

// Hijos con vida propia (queries, callables): stubs — sus comportamientos tienen tests propios.
vi.mock('@/components/MetaReconciliation', () => ({ MetaReconciliation: () => null }));
vi.mock('@/components/OutboxIncidents', () => ({ OutboxIncidents: () => null }));
vi.mock('@/components/MetaCatalogImport', () => ({ MetaCatalogImport: () => null }));
vi.mock('@/components/CatalogQualityCenter', () => ({ CatalogQualityCenter: () => null }));
vi.mock('@/components/CatalogOwnershipCard', () => ({ CatalogOwnershipCard: () => null }));
vi.mock('@/components/ProductForm', () => ({ ProductForm: () => null }));

vi.mock('@/lib/active-company', () => ({
  useActiveCompany: () => ({
    tenantId: 'perfumeria',
    companyName: 'Perfumería',
    companies: [],
    isSuperAdmin: false,
    loading: false,
    setTenantId: () => {},
  }),
}));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({
    user: { uid: 'owner-1' },
    claims: { role: 'TENANT_OWNER', tenantId: 'perfumeria' },
    loading: false,
    signOut: async () => {},
  }),
}));

const ts = { seconds: 0, nanoseconds: 0, toDate: () => new Date(0), toMillis: () => 0 };
const calidad = (blocking: number, warning = 0): NonNullable<Product['quality']> =>
  ({ blocking, warning, fingerprints: {}, evaluatedAt: ts }) as unknown as NonNullable<Product['quality']>;

const prod = (over: Partial<Product> & { id: string; name: string }): Product =>
  ({
    status: 'ACTIVE',
    price: 100000,
    currency: 'PYG',
    inventory: { trackStock: true, stock: 10, lowStockThreshold: 2, sku: over.id },
    images: [],
    ...over,
  }) as unknown as Product;

/**
 * Vista con TODOS los casos del predicado conservador:
 * elegibles = Alfa (evaluado sin bloqueos) y Beta (sin evaluar, ACTIVE y stock revisado);
 * excluidos = Gamma (bloqueado), Delta (sin evaluar inactivo), Epsilon (stock sin revisar),
 * Zeta (ya sincroniza).
 */
const PRODUCTOS: Product[] = [
  prod({ id: 'eleg-a', name: 'Alfa Elegible', quality: calidad(0, 1) }),
  prod({ id: 'eleg-b', name: 'Beta Sin Evaluar' }),
  prod({ id: 'bloq', name: 'Gamma Bloqueado', quality: calidad(2) }),
  prod({ id: 'inact', name: 'Delta Inactivo', status: 'INACTIVE' }),
  prod({ id: 'stockp', name: 'Epsilon Stock', stockPendingReview: true }),
  prod({ id: 'sync', name: 'Zeta Sincronizado', syncToMeta: true, quality: calidad(0) }),
];

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CatalogPage />
    </QueryClientProvider>,
  );
}

/**
 * happy-dom no ejecuta el activation behavior del checkbox en un click sintético (React
 * nunca ve el onChange). Workaround estándar: setear `checked` vía el setter del PROTOTIPO
 * (esquiva el value-tracker de React) y recién ahí disparar el click.
 *
 * Los checkboxes se buscan con `findByLabelText` (no `getBy`) desde ADR-0015: la selección
 * masiva es fail-CLOSED, así que la columna recién existe cuando la consulta de propiedad
 * respondió — antes no se sabe si VendeYaPy puede publicar algo.
 */
function tildarCheckbox(el: HTMLElement) {
  const input = el as HTMLInputElement;
  const desc =
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'checked') ??
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
  desc?.set?.call(input, !input.checked);
  fireEvent.click(input);
}

beforeEach(() => {
  vi.clearAllMocks();
  listProductsMock.mockResolvedValue(PRODUCTOS);
  listCategoriesMock.mockResolvedValue([]);
  listFinancialsMock.mockResolvedValue({});
  setSyncEnabledMock.mockResolvedValue({ ok: true, enabled: true, blockers: [] });
  // ADR-0015: la selección masiva solo existe si VendeYaPy gobierna algún campo publicable.
  // El bloqueo por propiedad tiene su propio archivo (page.ownership.test.tsx).
  ownershipMock.mockResolvedValue(
    normalizarOwnershipStatus({
      enabled: true,
      configMode: 'live',
      ownership: {
        model: 'vendeyapy_managed',
        writable: ['title', 'description', 'price', 'currency', 'availability', 'inventory', 'brand', 'category', 'image', 'url'],
        modeCeiling: 'live',
        degraded: false,
        reasons: [],
      },
    }),
  );
});

describe('CatalogPage — selección masiva de elegibles', () => {
  it('"seleccionar todos" tilda SOLO los elegibles; bloqueados y no evaluables quedan deshabilitados con su razón', async () => {
    renderPage();
    await screen.findByText('Alfa Elegible');

    // El header ya declara cuántos elegibles hay (2: evaluado sin bloqueos + conservador OK).
    tildarCheckbox(await screen.findByLabelText('Seleccionar los 2 productos elegibles para habilitar sincronización'));

    expect(screen.getByLabelText('Seleccionar Alfa Elegible para habilitar sincronización')).toBeChecked();
    expect(screen.getByLabelText('Seleccionar Beta Sin Evaluar para habilitar sincronización')).toBeChecked();

    // TODOS los no elegibles: deshabilitados, sin tildar y con la razón en el nombre accesible.
    const gamma = screen.getByLabelText('Gamma Bloqueado: no seleccionable (con datos incompletos (bloqueantes))');
    const delta = screen.getByLabelText('Delta Inactivo: no seleccionable (no está activo)');
    const epsilon = screen.getByLabelText('Epsilon Stock: no seleccionable (con stock sin revisar)');
    const zeta = screen.getByLabelText('Zeta Sincronizado: no seleccionable (ya se sincroniza con Meta)');
    for (const cb of [gamma, delta, epsilon, zeta]) {
      expect(cb).toBeDisabled();
      expect(cb).not.toBeChecked();
    }
  });

  it('la barra masiva muestra elegibles seleccionados y excluidos AGRUPADOS por razón', async () => {
    renderPage();
    await screen.findByText('Alfa Elegible');
    tildarCheckbox(await screen.findByLabelText('Seleccionar los 2 productos elegibles para habilitar sincronización'));

    const barra = screen.getByRole('region', { name: 'Habilitación masiva de sincronización' });
    expect(barra).toHaveTextContent('2 productos seleccionados');
    expect(barra).toHaveTextContent('4 de los productos visibles no se pueden seleccionar');
    expect(barra).toHaveTextContent('1 con datos incompletos (bloqueantes)');
    expect(barra).toHaveTextContent('1 no está activo');
    expect(barra).toHaveTextContent('1 con stock sin revisar');
    expect(barra).toHaveTextContent('1 ya se sincroniza con Meta');
    // La barra es honesta sobre el alcance: habilitar NO envía nada a Meta.
    expect(barra).toHaveTextContent('No envía nada a Meta');

    // La confirmación dice exactamente cuántos va a habilitar.
    fireEvent.click(screen.getByRole('button', { name: 'Habilitar sincronización (2)' }));
    const dialogo = await screen.findByRole('dialog');
    expect(dialogo).toHaveAccessibleName('¿Habilitar la sincronización de 2 productos?');
    expect(dialogo).toHaveTextContent('No se envía nada a Meta ahora');
  });

  it('la tanda llama SOLO a metaCatalogSetSyncEnabled y reporta habilitados y quedados fuera por motivo', async () => {
    // Beta falla server-side con un blocker: el desenlace se informa por producto.
    setSyncEnabledMock.mockImplementation(async (_t: string, productId: string) =>
      productId === 'eleg-b'
        ? { ok: false, enabled: false, blockers: ['brand_missing'] }
        : { ok: true, enabled: true, blockers: [] },
    );
    renderPage();
    await screen.findByText('Alfa Elegible');
    tildarCheckbox(await screen.findByLabelText('Seleccionar los 2 productos elegibles para habilitar sincronización'));
    fireEvent.click(screen.getByRole('button', { name: 'Habilitar sincronización (2)' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Sí, habilitar' }));

    await screen.findByText('1 habilitado');
    expect(screen.getByText('1 quedaron fuera')).toBeInTheDocument();
    // Agrupación por motivo legible (el blocker del backend, traducido) con el producto.
    expect(screen.getByText(/falta la marca/)).toBeInTheDocument();
    expect(screen.getByText(/Beta Sin Evaluar/, { selector: 'li' })).toBeInTheDocument();

    // Una llamada por producto seleccionado, siempre enabled=true + confirmDiff.
    expect(setSyncEnabledMock).toHaveBeenCalledTimes(2);
    expect(setSyncEnabledMock).toHaveBeenNthCalledWith(1, 'perfumeria', 'eleg-a', true, { confirmDiff: true });
    expect(setSyncEnabledMock).toHaveBeenNthCalledWith(2, 'perfumeria', 'eleg-b', true, { confirmDiff: true });

    // JAMÁS apply ni endpoints de Meta desde la acción masiva.
    expect(syncCatalogMock).not.toHaveBeenCalled();
    expect(importItemsMock).not.toHaveBeenCalled();
    expect(confirmMappingMock).not.toHaveBeenCalled();
    expect(reconcileJobMock).not.toHaveBeenCalled();
    expect(runImportMock).not.toHaveBeenCalled();
  });

  it('cancelar la confirmación no habilita nada', async () => {
    renderPage();
    await screen.findByText('Alfa Elegible');
    tildarCheckbox(await screen.findByLabelText('Seleccionar los 2 productos elegibles para habilitar sincronización'));
    fireEvent.click(screen.getByRole('button', { name: 'Habilitar sincronización (2)' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(setSyncEnabledMock).not.toHaveBeenCalled();
  });

  it('"Quitar selección" limpia la barra sin llamar a nada', async () => {
    renderPage();
    await screen.findByText('Alfa Elegible');
    tildarCheckbox(await screen.findByLabelText('Seleccionar los 2 productos elegibles para habilitar sincronización'));
    expect(screen.getByText('2 productos seleccionados')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Quitar selección' }));
    expect(screen.queryByText('2 productos seleccionados')).not.toBeInTheDocument();
    expect(setSyncEnabledMock).not.toHaveBeenCalled();
  });
});
