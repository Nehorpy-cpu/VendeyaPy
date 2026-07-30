/**
 * page.ownership.test.tsx — El catálogo con el modelo de propiedad (ADR-0015).
 *
 * Escenario real de arfagi: el catálogo de Meta lo gobierna un feed diario del sitio del
 * tenant, VendeYaPy no gobierna ningún campo publicable y el modo sigue en dry-run. Lo que
 * se fija acá:
 * - la tarjeta "Fuente de verdad del catálogo" está en la pantalla y NOMBRA los productos
 *   publicados distinto, con el valor de acá y el publicado (Odyssey: ₲250.000 vs ₲130.000);
 * - NO se ofrece la selección masiva de "habilitar sincronización" (no hay envío posible);
 * - el opt-in por producto queda bloqueado y con el motivo a la vista;
 * - la previsualización sigue disponible (es lectura) pero el ENVÍO no se ofrece, con su
 *   explicación, y jamás se llama al apply;
 * - FAIL-CLOSED: si la propiedad no se puede leer (o está cargando) tampoco se habilita nada;
 * - con campos propios, todo el flujo de siempre sigue funcionando.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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

// Hijos con vida propia: tienen sus propios tests. La tarjeta de propiedad NO se stubea:
// parte de lo que se verifica acá es que la pantalla la muestre.
vi.mock('@/components/MetaReconciliation', () => ({ MetaReconciliation: () => null }));
vi.mock('@/components/OutboxIncidents', () => ({ OutboxIncidents: () => null }));
vi.mock('@/components/MetaCatalogImport', () => ({ MetaCatalogImport: () => null }));
vi.mock('@/components/CatalogQualityCenter', () => ({ CatalogQualityCenter: () => null }));
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

const prod = (over: Partial<Product> & { id: string; name: string }): Product =>
  ({
    status: 'ACTIVE',
    price: 250000,
    currency: 'PYG',
    inventory: { trackStock: true, stock: 5, lowStockThreshold: 2, sku: over.id },
    images: [],
    ...over,
  }) as unknown as Product;

const PRODUCTOS: Product[] = [
  prod({
    id: 'odyssey',
    name: 'Armaf Odyssey Mega',
    syncToMeta: true,
    metaSyncStatus: 'synced',
    metaRetailerId: 'ARF-ODY-1',
    // Forma CANÓNICA del backend (ADR-0015 §5): `fields` son NOMBRES y los valores saneados
    // viajan en `observed`. El precio es `commercial`: frena la venta automática.
    ...({
      metaSyncState: 'drifted_external',
      metaDrift: {
        fields: ['price'],
        owner: 'external',
        severity: 'commercial',
        observed: [{ field: 'price', owner: 'external', severity: 'commercial', local: '250000 PYG', remote: '130000 PYG' }],
      },
    } as unknown as Partial<Product>),
  }),
  prod({ id: 'otro', name: 'Otro Producto', metaRetailerId: 'ARF-OTRO' }),
];

/** arfagi: el feed del sitio gobierna todo lo público; VendeYaPy no publica nada. */
const OWN_EXTERNO = normalizarOwnershipStatus({
  enabled: true,
  configMode: 'dry_run',
  effectiveMode: 'dry_run',
  ownership: {
    model: 'external_managed',
    writable: [],
    external: ['title', 'description', 'price', 'currency', 'availability', 'inventory', 'brand', 'image', 'url'],
    externalSource: {
      kind: 'meta_feed',
      acknowledgedSourceIds: ['1'],
      declaredFields: ['title', 'price'],
      fingerprint: 'h',
      acknowledgedByUid: 'u',
      name: 'Catálogo del sitio',
      schedule: { hour: 3, minute: 33, timezone: 'America/Asuncion' },
      deletionEnabled: true,
    },
    modeCeiling: 'dry_run',
    degraded: false,
    reasons: [],
  },
});

const OWN_PROPIO = normalizarOwnershipStatus({
  enabled: true,
  configMode: 'live',
  effectiveMode: 'live',
  ownership: {
    model: 'vendeyapy_managed',
    writable: ['title', 'price', 'availability', 'inventory'],
    modeCeiling: 'live',
    degraded: false,
    reasons: [],
  },
});

const planned = (): CatalogSyncRun => ({
  runId: 'run-1',
  requestedMode: 'dry_run',
  status: 'planned',
  configMode: 'live',
  planHash: 'hash-1',
  summary: { create: 0, update: 1, disable: 0, unchanged: 0, blocked: 0, remoteOnly: 0 },
  entries: [{ productId: 'odyssey', sku: 'ARF-ODY-1', productName: 'Armaf Odyssey Mega', action: 'update' }],
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

describe('CatalogPage — catálogo gobernado por una fuente externa (arfagi)', () => {
  it('muestra la tarjeta de propiedad y marca los productos administrados afuera', async () => {
    ownershipMock.mockResolvedValue(OWN_EXTERNO);
    renderPage();
    // El nombre aparece DOS veces desde ADR-0015: en la grilla y en la tarjeta de propiedad,
    // que ahora nombra los productos publicados distinto en vez de contarlos en silencio.
    await screen.findAllByText('Armaf Odyssey Mega');

    const tarjeta = await screen.findByRole('region', { name: 'Fuente de verdad del catálogo' });
    await waitFor(() => expect(screen.getAllByText('Administrado por fuente externa')).toHaveLength(2));
    // Y el estado publicado le gana al "Confirmado" histórico de Odyssey.
    expect(screen.getAllByText('Publicado distinto por tu sistema').length).toBeGreaterThan(0);
    expect(screen.queryByText('Confirmado')).not.toBeInTheDocument();

    // La tarjeta muestra el producto divergente CON su precio local y el publicado, y manda a
    // corregir en el origen. Nunca a editar el catálogo de Meta (el feed lo pisaría mañana).
    expect(within(tarjeta).getByText('Armaf Odyssey Mega')).toBeInTheDocument();
    expect(tarjeta).toHaveTextContent('acá ₲ 250.000 · publicado ₲ 130.000');
    expect(tarjeta).toHaveTextContent('(frena la venta automática)');
    expect(tarjeta).toHaveTextContent(/Corregilo en el origen que genera Catálogo del sitio/);
    expect(tarjeta.textContent ?? '').not.toMatch(/Commerce Manager|Administrador de Comercio/i);
  });

  it('el segundo producto, jamás verificado, NO se muestra en verde', async () => {
    ownershipMock.mockResolvedValue(OWN_EXTERNO);
    renderPage();
    await screen.findByText('Otro Producto');
    // "Otro Producto" no tiene opt-in ni verificación: el panel no puede afirmar nada de él.
    expect(screen.getByText('No se sincroniza')).toBeInTheDocument();
    expect(screen.queryByText('Coincide con lo publicado')).not.toBeInTheDocument();
  });

  it('no ofrece la selección masiva y bloquea el opt-in por producto con su motivo', async () => {
    ownershipMock.mockResolvedValue(OWN_EXTERNO);
    renderPage();
    await screen.findByText('Otro Producto');

    await waitFor(() =>
      expect(screen.queryByLabelText(/Seleccionar los .* productos elegibles/)).not.toBeInTheDocument(),
    );
    expect(screen.queryByLabelText('Seleccionar Otro Producto para habilitar sincronización')).not.toBeInTheDocument();

    const boton = screen.getByRole('button', { name: 'Sincronizar con Meta…' });
    expect(boton).toBeDisabled();
    fireEvent.click(boton);
    expect(screen.getByText(/Tu propio sistema administra los datos publicados/)).toBeInTheDocument();
    expect(setSyncEnabledMock).not.toHaveBeenCalled();
  });

  it('la previsualización sigue disponible, pero el ENVÍO no se ofrece y se explica por qué', async () => {
    ownershipMock.mockResolvedValue(OWN_EXTERNO);
    renderPage();
    await screen.findAllByText('Armaf Odyssey Mega');

    fireEvent.click(screen.getByRole('button', { name: 'Previsualizar cambios' }));
    await screen.findByText('Previsualización del catálogo (sin escrituras en Meta)');

    expect(screen.getByText(/No se puede enviar nada a Meta:/)).toBeInTheDocument();
    expect(screen.getByText(/Esta previsualización es solo para que veas las diferencias/)).toBeInTheDocument();
    // El botón de envío ni existe: no hay forma de disparar un apply desde acá.
    expect(screen.queryByRole('button', { name: /Enviar .* cambio/ })).not.toBeInTheDocument();
    expect(syncCatalogMock).toHaveBeenCalledTimes(1);
    expect(syncCatalogMock).toHaveBeenCalledWith('perfumeria', { apply: false });
  });
});

/**
 * FAIL-CLOSED de punta a punta: el callable de propiedad falla (hoy pasa siempre, porque el
 * panel invocaba un callable que no existía) y la pantalla NO puede ofrecer publicar.
 */
describe('CatalogPage — la propiedad no se pudo leer', () => {
  it('bloquea el opt-in, la tanda masiva y el envío, con el motivo a la vista', async () => {
    ownershipMock.mockRejectedValue(new Error('not-found'));
    renderPage();
    await screen.findByText('Otro Producto');

    // La tarjeta lo dice con role=alert y explica que el bloqueo es consecuencia de eso.
    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent('No pudimos verificar quién administra tu catálogo ahora.');
    expect(alerta).toHaveTextContent(/quedan bloqueados/);

    // Opt-in por producto: inerte y con motivo (no un botón que dispara y falla en el backend).
    const botones = await screen.findAllByRole('button', { name: 'Sincronizar con Meta…' });
    for (const b of botones) expect(b).toBeDisabled();
    fireEvent.click(botones[0]!);
    expect(setSyncEnabledMock).not.toHaveBeenCalled();
    expect(screen.getAllByText(/No pudimos verificar quién administra el catálogo/).length).toBeGreaterThan(0);

    // Tanda masiva: ni siquiera se ofrece.
    expect(screen.queryByLabelText(/Seleccionar los .* productos elegibles/)).not.toBeInTheDocument();

    // Y el envío del plan previsualizado tampoco: solo lectura.
    fireEvent.click(screen.getByRole('button', { name: 'Previsualizar cambios' }));
    await screen.findByText('Previsualización del catálogo (sin escrituras en Meta)');
    expect(screen.getByText(/No se puede enviar nada a Meta:/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Enviar .* cambio/ })).not.toBeInTheDocument();
    expect(syncCatalogMock).toHaveBeenCalledTimes(1);
    expect(syncCatalogMock).toHaveBeenCalledWith('perfumeria', { apply: false });
  });

  it('mientras la propiedad se está leyendo tampoco se habilita nada', async () => {
    // Promesa que nunca resuelve: la tarjeta queda en "cargando" y el panel espera, bloqueado.
    ownershipMock.mockReturnValue(new Promise(() => {}));
    renderPage();
    await screen.findByText('Otro Producto');

    const botones = screen.getAllByRole('button', { name: 'Sincronizar con Meta…' });
    for (const b of botones) expect(b).toBeDisabled();
    expect(screen.getAllByText(/Estamos verificando quién administra el catálogo/).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText(/Seleccionar los .* productos elegibles/)).not.toBeInTheDocument();
    expect(setSyncEnabledMock).not.toHaveBeenCalled();
  });
});

describe('CatalogPage — con campos propios el flujo de siempre sigue intacto', () => {
  it('ofrece la selección masiva, el opt-in y el envío del plan previsualizado', async () => {
    ownershipMock.mockResolvedValue(OWN_PROPIO);
    renderPage();
    await screen.findByText('Otro Producto');

    expect(await screen.findByLabelText('Seleccionar Otro Producto para habilitar sincronización')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Sincronizar con Meta…' })).toBeEnabled();
    expect(screen.queryByText('Administrado por fuente externa')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Previsualizar cambios' }));
    await screen.findByText('Previsualización del catálogo (sin escrituras en Meta)');
    expect(screen.getByRole('button', { name: /Enviar 1 cambio a Meta \(Armaf Odyssey Mega\)…/ })).toBeInTheDocument();
    expect(screen.queryByText(/No se puede enviar nada a Meta:/)).not.toBeInTheDocument();
  });
});
