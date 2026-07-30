/**
 * CatalogQualityCenter.test.tsx — Estados del centro de calidad (HARDEN-1).
 * Cubre: cargando / error con reintento / vacío honesto / éxito con detalle y filtros,
 * el fallback con muestras del servidor (sin "[object Object]" ni crash con codigos
 * normalizados) y el aviso de truncado. El agregado viene SIEMPRE del server
 * (fetchCatalogQualitySummary, mockeado acá); las filas, de los productos cargados.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CatalogQualitySummary, ProductConCalidad, QualityFingerprintEntry } from '@/lib/catalog';
import { CatalogQualityCenter } from './CatalogQualityCenter';

const fetchSummary = vi.fn();
vi.mock('@/lib/catalog', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/catalog')>();
  return { ...real, fetchCatalogQualitySummary: (...a: unknown[]) => fetchSummary(...a) };
});

const ts = { seconds: 0, nanoseconds: 0, toDate: () => new Date(0), toMillis: () => 0 };

const entry = (over: Partial<QualityFingerprintEntry> = {}): QualityFingerprintEntry =>
  ({
    code: 'brand_missing',
    severity: 'BLOCKING',
    field: 'brand',
    message: 'Falta la marca',
    action: 'Cargá la marca en el editor',
    firstSeenAt: ts,
    lastSeenAt: ts,
    resolvedAt: null,
    origin: 'import',
    ...over,
  }) as QualityFingerprintEntry;

const prod = (over: Partial<ProductConCalidad> = {}): ProductConCalidad =>
  ({ id: 'p1', name: 'Producto 1', status: 'ACTIVE', ...over }) as unknown as ProductConCalidad;

const resumen = (over: Partial<CatalogQualitySummary> = {}): CatalogQualitySummary => ({
  conBloqueos: 0,
  conAdvertencias: 0,
  sinEvaluar: 0,
  porCodigo: {},
  muestras: [],
  truncated: false,
  ...over,
});

function renderCentro(products: ProductConCalidad[] = [], onEditar = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <CatalogQualityCenter tenantId="perfumeria" products={products} onEditar={onEditar} />
    </QueryClientProvider>,
  );
  return { ...utils, onEditar };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CatalogQualityCenter — estados', () => {
  it('cargando: anuncia con aria-live y no muestra datos inventados', () => {
    fetchSummary.mockReturnValue(new Promise(() => {})); // nunca resuelve
    renderCentro();
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('Revisando la calidad del catálogo…')).toBeInTheDocument();
  });

  it('error: role=alert con Reintentar que re-consulta al server', async () => {
    fetchSummary.mockRejectedValue(new Error('permission-denied'));
    renderCentro();
    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent('No pudimos revisar la calidad del catálogo ahora.');
    expect(fetchSummary).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(fetchSummary).toHaveBeenCalledTimes(2));
  });

  it('vacío honesto: sin problemas → mensaje compacto, sin detalle desplegable', async () => {
    fetchSummary.mockResolvedValue(resumen());
    renderCentro();
    await screen.findByText('Sin datos pendientes: tus productos están completos.');
    expect(screen.queryByRole('button', { name: 'Ver qué falta' })).not.toBeInTheDocument();
  });

  it('éxito: contadores del server, detalle desplegable con filtros y observaciones', async () => {
    fetchSummary.mockResolvedValue(
      resumen({ conBloqueos: 1, conAdvertencias: 1, porCodigo: { brand_missing: 1, generic_name: 1 } }),
    );
    const products = [
      prod({
        id: 'a',
        name: 'Alfa',
        quality: {
          blocking: 1,
          warning: 0,
          evaluatedAt: ts,
          fingerprints: { 'brand_missing:brand': entry() },
        } as ProductConCalidad['quality'],
      }),
      prod({
        id: 'b',
        name: 'Beta',
        quality: {
          blocking: 0,
          warning: 1,
          evaluatedAt: ts,
          fingerprints: { 'generic_name:name': entry({ code: 'generic_name', severity: 'WARNING', field: 'name', message: 'Nombre genérico', origin: 'editor' }) },
        } as ProductConCalidad['quality'],
      }),
    ];
    const { onEditar } = renderCentro(products);
    await screen.findByText(/1 producto con datos incompletos · 1 con advertencias/);

    const toggle = screen.getByRole('button', { name: 'Ver qué falta' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Ocultar detalle' })).toHaveAttribute('aria-expanded', 'true');

    // Filtros con labels asociadas (accesibles y operables por teclado: selects nativos).
    expect(screen.getByLabelText('Gravedad').tagName).toBe('SELECT');
    expect(screen.getByLabelText('Estado')).toBeInTheDocument();
    expect(screen.getByLabelText('Origen')).toBeInTheDocument();
    expect(screen.getByLabelText('Problema')).toBeInTheDocument();

    // Las dos observaciones abiertas, bloqueante primero.
    expect(screen.getByText('Falta la marca')).toBeInTheDocument();
    expect(screen.getByText('Nombre genérico')).toBeInTheDocument();
    expect(screen.getByText('Impide vender/publicar')).toBeInTheDocument();
    expect(screen.getByText('Advertencia')).toBeInTheDocument();

    // El conteo por código del server aparece como número (jamás "[object Object]").
    expect(document.body.textContent).not.toContain('[object Object]');

    // Filtrar por gravedad WARNING oculta la bloqueante.
    fireEvent.change(screen.getByLabelText('Gravedad'), { target: { value: 'WARNING' } });
    expect(screen.queryByText('Falta la marca')).not.toBeInTheDocument();
    expect(screen.getByText('Nombre genérico')).toBeInTheDocument();

    // Editar abre el producto correcto.
    fireEvent.change(screen.getByLabelText('Gravedad'), { target: { value: 'todas' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Editar' })[0]!);
    expect(onEditar).toHaveBeenCalledWith('a');
  });

  it('fallback: el agregado tiene problemas pero los productos aún no traen detalle → muestras del server (codigos normalizados, sin crash)', async () => {
    fetchSummary.mockResolvedValue(
      resumen({
        conBloqueos: 2,
        porCodigo: { brand_missing: 2 },
        muestras: [
          { productId: 'p9', productName: 'Perfume X', blocking: 2, warning: 0, codigos: ['brand_missing', 'price_invalid'] },
          { productId: 'p10', productName: '', blocking: 1, warning: 0, codigos: [] }, // sin nombre ni códigos: no crashea
        ],
      }),
    );
    const { onEditar } = renderCentro([]); // productos sin fingerprints cargados
    await screen.findByText(/2 productos con datos incompletos/);
    fireEvent.click(screen.getByRole('button', { name: 'Ver qué falta' }));

    expect(screen.getByText(/Estos productos necesitan revisión/)).toBeInTheDocument();
    expect(screen.getByText('Perfume X')).toBeInTheDocument();
    // Los códigos llegan traducidos (etiquetaCodigo), nunca como objetos serializados.
    expect(screen.getByText('falta la marca · el precio no es válido')).toBeInTheDocument();
    expect(screen.getByText('Faltan datos (2)')).toBeInTheDocument();
    // Sin nombre → fallback al productId; sin códigos → sin crash.
    expect(screen.getByText('p10')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('[object Object]');

    fireEvent.click(screen.getAllByRole('button', { name: 'Editar' })[0]!);
    expect(onEditar).toHaveBeenCalledWith('p9');
  });

  it('deriva: un producto SIN datos faltantes pero publicado distinto NO se muestra en verde', async () => {
    // Caso Odyssey: ficha completa (el agregado no reporta nada) y precio publicado distinto.
    // Antes de ADR-0015 esta pantalla decía "tus productos están completos".
    fetchSummary.mockResolvedValue(resumen());
    const odyssey = prod({
      id: 'odyssey',
      name: 'Armaf Odyssey Mega',
      metaSyncStatus: 'synced',
      metaSyncState: 'drifted_external',
      metaDrift: {
        fields: ['price'],
        owner: 'external',
        severity: 'commercial',
        observed: [{ field: 'price', owner: 'external', severity: 'commercial', local: '250000 PYG', remote: '130000 PYG' }],
      },
    } as unknown as Partial<ProductConCalidad>);
    const { onEditar } = renderCentro([odyssey]);

    await screen.findByText(/1 publicado distinto a lo tuyo/);
    expect(screen.queryByText('Sin datos pendientes: tus productos están completos.')).not.toBeInTheDocument();

    // El detalle sale sin abrir nada: valores de acá y publicados, y la corrección en el origen.
    expect(screen.getByText('Publicado distinto a lo tuyo (1)')).toBeInTheDocument();
    expect(screen.getByText('Armaf Odyssey Mega')).toBeInTheDocument();
    expect(screen.getByText('₲ 250.000')).toBeInTheDocument();
    expect(screen.getByText('₲ 130.000')).toBeInTheDocument();
    expect(screen.getByText(/Corregilo en el origen/)).toBeInTheDocument();
    // Cubre importados Y vinculados a mano: el texto lo dice y el dato sale del producto.
    expect(screen.getByText(/los que importaste y los que vinculaste a mano/)).toBeInTheDocument();
    // Jamás propone tocar el catálogo de Meta a mano.
    expect(document.body.textContent ?? '').not.toMatch(/edit\w*\s+(?:el\s+|la\s+)?\w*\s*en Meta/i);

    fireEvent.click(screen.getByRole('button', { name: 'Ver el producto' }));
    expect(onEditar).toHaveBeenCalledWith('odyssey');
  });

  it('verificación vencida: se cuenta aparte y NO se presenta como "publicado distinto"', async () => {
    // `stale` se deriva en lectura: un `verified` viejo deja de afirmar que coincide, pero
    // meterlo en la lista de divergencias inflaría el aviso y le sacaría peso a lo que sí
    // está publicado distinto.
    fetchSummary.mockResolvedValue(resumen());
    const viejo = prod({
      id: 'viejo',
      name: 'Producto Viejo',
      metaSyncState: 'verified',
      metaVerifiedAt: { _seconds: Math.floor(Date.now() / 1000) - 40 * 60 * 60 },
    } as unknown as Partial<ProductConCalidad>);
    renderCentro([viejo]);

    await screen.findByText(/1 sin poder verificar contra lo publicado/);
    expect(screen.getByText('Sin verificar contra lo publicado')).toBeInTheDocument();
    expect(screen.queryByText(/Publicado distinto a lo tuyo/)).not.toBeInTheDocument();
    expect(screen.queryByText('Sin datos pendientes: tus productos están completos.')).not.toBeInTheDocument();
  });

  it('truncado: avisa que hay más productos con observaciones que los listados', async () => {
    fetchSummary.mockResolvedValue(
      resumen({
        conBloqueos: 1,
        muestras: [{ productId: 'p1', productName: 'Uno', blocking: 1, warning: 0, codigos: ['brand_missing'] }],
        truncated: true,
      }),
    );
    renderCentro([]);
    await screen.findByText(/1 producto con datos incompletos/);
    fireEvent.click(screen.getByRole('button', { name: 'Ver qué falta' }));
    expect(screen.getByText(/Hay más productos con observaciones/)).toBeInTheDocument();
  });
});
