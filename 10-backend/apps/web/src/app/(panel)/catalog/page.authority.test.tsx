/**
 * page.authority.test.tsx — Gating de acciones por RELACIÓN con Meta (ADR-0022 §4).
 *
 * El server ya bloquea (`authority_relationship_blocked`); acá se fija que la UI espeje sin
 * engaño:
 * - `none`: NINGUNA acción Meta a la vista (import/reconciliación/outbox/previsualizar);
 *   quedan el CRUD local y la calidad local;
 * - `mirror`: importar/reconciliar visibles, pero el ENVÍO no se ofrece y el motivo nombra
 *   a la fuente que publica; el opt-in por producto queda bloqueado con ese mismo motivo;
 * - `managed`: exactamente los rieles vigentes (nada se esconde de más);
 * - sin el contrato nuevo (autoridad null): comportamiento actual intacto — eso lo cubren
 *   page.test.tsx y page.ownership.test.tsx, que deben seguir verdes sin tocarse.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Product } from '@vpw/shared';
import { normalizarOwnershipStatus, type CatalogSyncRun } from '@/lib/catalog';
import CatalogPage from './page';

const listProductsMock = vi.fn();
const listCategoriesMock = vi.fn();
const listFinancialsMock = vi.fn();
const setSyncEnabledMock = vi.fn();
const syncCatalogMock = vi.fn();
const ownershipMock = vi.fn();
vi.mock('@/lib/catalog', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/catalog')>();
  return {
    ...real,
    listProducts: (...a: unknown[]) => listProductsMock(...a),
    listCategories: (...a: unknown[]) => listCategoriesMock(...a),
    listProductFinancials: (...a: unknown[]) => listFinancialsMock(...a),
    setProductSyncEnabled: (...a: unknown[]) => setSyncEnabledMock(...a),
    syncCatalogToMeta: (...a: unknown[]) => syncCatalogMock(...a),
    fetchCatalogOwnershipStatus: (...a: unknown[]) => ownershipMock(...a),
  };
});

// Hijos con vida propia: marcadores para poder afirmar PRESENCIA y AUSENCIA por relación.
// Sus comportamientos tienen tests propios; el selector de autoridad también.
vi.mock('@/components/MetaReconciliation', () => ({ MetaReconciliation: () => <div data-testid="stub-reconciliacion" /> }));
vi.mock('@/components/OutboxIncidents', () => ({ OutboxIncidents: () => <div data-testid="stub-outbox" /> }));
vi.mock('@/components/MetaCatalogImport', () => ({ MetaCatalogImport: () => <div data-testid="stub-import" /> }));
vi.mock('@/components/CatalogQualityCenter', () => ({ CatalogQualityCenter: () => <div data-testid="stub-calidad" /> }));
vi.mock('@/components/CatalogOwnershipCard', () => ({ CatalogOwnershipCard: () => null }));
vi.mock('@/components/ProductForm', () => ({ ProductForm: () => null }));
vi.mock('@/components/catalog/CatalogAuthoritySelector', () => ({
  CatalogAuthoritySelector: () => <div data-testid="stub-selector" />,
}));

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

const prod = (over: Partial<Product> & { id: string; name: string }): Product =>
  ({
    status: 'ACTIVE',
    price: 250000,
    currency: 'PYG',
    inventory: { trackStock: true, stock: 5, lowStockThreshold: 2, sku: over.id },
    images: [],
    ...over,
  }) as unknown as Product;

const PRODUCTOS: Product[] = [prod({ id: 'p1', name: 'Producto Uno' })];

/** A: vendeyapy+none — catálogo solo del bot. */
const OWN_NONE = normalizarOwnershipStatus({
  enabled: true,
  configMode: 'off',
  ownership: { model: 'vendeyapy_managed', writable: ['title', 'price'], degraded: false, reasons: [] },
  authority: { authority: 'vendeyapy', relationship: 'none', declared: true, reasons: [], staleness: {} },
});

/** D: external+mirror — la fuente del tenant publica; VendeYaPy solo lee. */
const OWN_MIRROR = normalizarOwnershipStatus({
  enabled: true,
  configMode: 'dry_run',
  effectiveMode: 'dry_run',
  ownership: {
    model: 'external_managed',
    writable: [],
    external: ['title', 'price'],
    externalSource: {
      kind: 'meta_feed',
      name: 'Catálogo del sitio',
      acknowledgedByUid: 'u1',
      acknowledgedSourceIds: ['1'],
      declaredFields: ['title', 'price'],
    },
    modeCeiling: 'dry_run',
    degraded: false,
    reasons: [],
  },
  authority: { authority: 'external', relationship: 'mirror', declared: true, reasons: [], staleness: {} },
});

/** B: vendeyapy+managed — los rieles vigentes, intactos. */
const OWN_MANAGED = normalizarOwnershipStatus({
  enabled: true,
  configMode: 'live',
  effectiveMode: 'live',
  ownership: {
    model: 'vendeyapy_managed',
    writable: ['title', 'description', 'price', 'currency', 'availability', 'inventory', 'brand', 'category', 'image', 'url'],
    modeCeiling: 'live',
    degraded: false,
    reasons: [],
  },
  authority: { authority: 'vendeyapy', relationship: 'managed', declared: true, reasons: [], staleness: {} },
});

const planned = (): CatalogSyncRun => ({
  runId: 'run-1',
  requestedMode: 'dry_run',
  status: 'planned',
  configMode: 'live',
  planHash: 'hash-1',
  summary: { create: 0, update: 1, disable: 0, unchanged: 0, blocked: 0, remoteOnly: 0 },
  entries: [{ productId: 'p1', sku: 'p1', productName: 'Producto Uno', action: 'update' }],
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CatalogPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listProductsMock.mockResolvedValue(PRODUCTOS);
  listCategoriesMock.mockResolvedValue([]);
  listFinancialsMock.mockResolvedValue({});
  syncCatalogMock.mockResolvedValue(planned());
});

describe('relación none — catálogo solo del bot', () => {
  it('oculta TODAS las acciones Meta y deja el CRUD local + calidad + selector', async () => {
    ownershipMock.mockResolvedValue(OWN_NONE);
    renderPage();
    await screen.findByText('Producto Uno');
    // Espera a que la propiedad esté resuelta (el gating depende de ella).
    await waitFor(() => expect(ownershipMock).toHaveBeenCalled());

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Previsualizar cambios' })).not.toBeInTheDocument());
    expect(screen.queryByTestId('stub-import')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stub-reconciliacion')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stub-outbox')).not.toBeInTheDocument();
    // Nada de selección masiva ni opt-in: no existe envío posible.
    expect(screen.queryByLabelText(/Seleccionar los .* productos elegibles/)).not.toBeInTheDocument();

    // El CRUD local, la calidad y la sección de autoridad siguen en pantalla.
    expect(screen.getByRole('button', { name: '+ Nuevo producto' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Editar' })).toBeInTheDocument();
    expect(screen.getByTestId('stub-calidad')).toBeInTheDocument();
    expect(screen.getByTestId('stub-selector')).toBeInTheDocument();
    expect(syncCatalogMock).not.toHaveBeenCalled();
  });
});

describe('relación mirror — la fuente publica, VendeYaPy no escribe', () => {
  it('muestra importar/reconciliar y bloquea el opt-in nombrando a la fuente', async () => {
    ownershipMock.mockResolvedValue(OWN_MIRROR);
    renderPage();
    await screen.findByText('Producto Uno');

    // Importar y reconciliar SÍ (alimentan el espejo local); outbox sigue (se auto-oculta vacío).
    expect(await screen.findByTestId('stub-import')).toBeInTheDocument();
    expect(screen.getByTestId('stub-reconciliacion')).toBeInTheDocument();
    expect(screen.getByTestId('stub-outbox')).toBeInTheDocument();

    // El opt-in por producto queda inerte, con el motivo que nombra a la fuente.
    const boton = await screen.findByRole('button', { name: 'Sincronizar con Meta…' });
    expect(boton).toBeDisabled();
    expect(
      screen.getAllByText(/Este catálogo lo publica Catálogo del sitio; VendeYaPy no escribe en Meta/).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByLabelText(/Seleccionar los .* productos elegibles/)).not.toBeInTheDocument();
  });

  it('la previsualización queda (es lectura) pero el ENVÍO no se ofrece, con la fuente nombrada', async () => {
    ownershipMock.mockResolvedValue(OWN_MIRROR);
    renderPage();
    await screen.findByText('Producto Uno');

    // DECISIÓN B2 (ADR-0022 §4): mirror bloquea escrituras, NO lecturas — «Previsualizar
    // cambios» se ofrece como diagnóstico read-only (comportamiento legacy de arfagi).
    const previsualizar = await screen.findByRole('button', { name: 'Previsualizar cambios' });
    expect(previsualizar).toBeEnabled();

    fireEvent.click(previsualizar);
    await screen.findByText('Previsualización del catálogo (sin escrituras en Meta)');

    expect(screen.getByText(/No se puede enviar nada a Meta:/)).toBeInTheDocument();
    expect(
      screen.getAllByText(/Este catálogo lo publica Catálogo del sitio; VendeYaPy no escribe en Meta/).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Enviar .* cambio/ })).not.toBeInTheDocument();
    expect(syncCatalogMock).toHaveBeenCalledWith('perfumeria', { apply: false });
  });
});

describe('relación managed — los rieles vigentes intactos', () => {
  it('previsualizar, enviar, opt-in y selección masiva siguen exactamente como hoy', async () => {
    ownershipMock.mockResolvedValue(OWN_MANAGED);
    renderPage();
    await screen.findByText('Producto Uno');

    expect(await screen.findByTestId('stub-import')).toBeInTheDocument();
    expect(screen.getByTestId('stub-reconciliacion')).toBeInTheDocument();
    expect(screen.getByTestId('stub-outbox')).toBeInTheDocument();
    expect(await screen.findByLabelText('Seleccionar Producto Uno para habilitar sincronización')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Sincronizar con Meta…' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Previsualizar cambios' }));
    await screen.findByText('Previsualización del catálogo (sin escrituras en Meta)');
    expect(screen.getByRole('button', { name: /Enviar 1 cambio a Meta \(Producto Uno\)…/ })).toBeInTheDocument();
    expect(screen.queryByText(/No se puede enviar nada a Meta:/)).not.toBeInTheDocument();
  });
});
