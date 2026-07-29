/**
 * MetaCatalogImport.test.tsx — Estados del importador paginado de Meta (HARDEN-1).
 * Cubre a nivel componente los cortes que NO deben loopear (cuota, error remoto,
 * already_running con contadores reales), el estado de éxito y la accesibilidad del
 * importador (aria-live, labels asociadas, modal con Escape). La política completa del
 * loop está fijada aparte en lib/metaImportLoop.test.ts (función pura inyectable).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MetaCatalogImportRunState } from '@/lib/catalog';
import { MetaCatalogImport } from './MetaCatalogImport';

const runImport = vi.fn();
const fetchStatus = vi.fn();
vi.mock('@/lib/catalog', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/catalog')>();
  return {
    ...real,
    runMetaCatalogImport: (...a: unknown[]) => runImport(...a),
    fetchMetaCatalogImportStatus: (...a: unknown[]) => fetchStatus(...a),
  };
});

const mockAuth = { role: 'TENANT_OWNER' as string | null };
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({
    user: { uid: 'owner-1' },
    claims: { role: mockAuth.role, tenantId: 'perfumeria' },
    loading: false,
    signOut: async () => {},
  }),
}));

const estado = (over: Partial<MetaCatalogImportRunState> = {}): MetaCatalogImportRunState => ({
  status: 'running',
  runId: 'run-1',
  cursor: null,
  more: false,
  pagesDone: 0,
  procesados: 0,
  contadores: {
    imported: 0,
    alreadyLinked: 0,
    alreadyImported: 0,
    ambiguous: 0,
    conflicted: 0,
    skipped: 0,
    unclassified: 0,
  },
  cursorResets: 0,
  ...over,
});

function renderImport() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MetaCatalogImport tenantId="perfumeria" categories={[]} />
    </QueryClientProvider>,
  );
}

/** Arranca la importación pasando por el modal de confirmación. */
async function arrancarImportacion() {
  fireEvent.click(screen.getByRole('button', { name: 'Importar catálogo de Meta' }));
  const dialogo = await screen.findByRole('dialog');
  expect(dialogo).toHaveAttribute('aria-modal', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Sí, importar' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.role = 'TENANT_OWNER';
  fetchStatus.mockResolvedValue({ run: null });
});

describe('MetaCatalogImport — cortes que no loopean', () => {
  it('cuota agotada: UNA invocación, mensaje del plan y botón Reanudar (no re-invoca)', async () => {
    runImport.mockResolvedValue(estado({ stopReason: 'quota', more: true, pagesDone: 2, procesados: 40 }));
    renderImport();
    await arrancarImportacion();
    await screen.findByText(/Se alcanzó el límite del plan/);
    expect(runImport).toHaveBeenCalledTimes(1);
    expect(runImport).toHaveBeenCalledWith('perfumeria', { resume: false });
    expect(screen.getByRole('button', { name: 'Reanudar' })).toBeInTheDocument();
    // Lo avanzado queda guardado y a la vista (contadores del último estado real).
    expect(screen.getByText(/Lo avanzado quedó guardado/)).toBeInTheDocument();
  });

  it('error remoto: detiene el loop con mensaje honesto y Reanudar manual', async () => {
    runImport.mockResolvedValue(estado({ stopReason: 'remote_error', more: true, pagesDone: 1 }));
    renderImport();
    await arrancarImportacion();
    await screen.findByText(/Meta no respondió bien/);
    expect(runImport).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Reanudar' })).toBeInTheDocument();
  });

  it('already_running: muestra el run vigente (contadores REALES) y NO loopea', async () => {
    runImport.mockResolvedValue(
      estado({
        status: 'already_running',
        pagesDone: 7,
        procesados: 140,
        contadores: { imported: 12, alreadyLinked: 3, alreadyImported: 0, ambiguous: 1, conflicted: 0, skipped: 2, unclassified: 4 },
      }),
    );
    renderImport();
    await arrancarImportacion();
    await screen.findByText(/Ya hay una importación corriendo/);
    expect(runImport).toHaveBeenCalledTimes(1);
    // Contadores del run vigente (los que la normalización saca del `run` anidado), no ceros.
    expect(screen.getByText('Importados: 12')).toBeInTheDocument();
    expect(screen.getByText('Sin clasificar: 4')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actualizar estado' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reanudar acá' })).toBeInTheDocument();
  });

  it('completado: éxito con totales reales y refresco de la UI', async () => {
    runImport.mockResolvedValue(estado({ status: 'completed', pagesDone: 4, procesados: 80 }));
    renderImport();
    await arrancarImportacion();
    await screen.findByText(/Importación terminada: 80 artículos revisados en 4 páginas/);
    expect(runImport).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Importar de nuevo' })).toBeInTheDocument();
  });
});

describe('MetaCatalogImport — accesibilidad y controles', () => {
  it('el avance se anuncia con aria-live (role=status polite), sin robar el foco', async () => {
    runImport.mockResolvedValue(estado({ status: 'completed', pagesDone: 1, procesados: 5 }));
    renderImport();
    await arrancarImportacion();
    await screen.findByText(/Importación terminada/);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('la categoría por defecto tiene label asociada y es un select nativo (operable por teclado)', () => {
    renderImport();
    const select = screen.getByLabelText('Categoría para los importados');
    expect(select.tagName).toBe('SELECT');
    fireEvent.change(select, { target: { value: '' } });
    expect((select as HTMLSelectElement).value).toBe('');
  });

  it('el modal de confirmación es dialog aria-modal y Escape lo cierra SIN importar', async () => {
    renderImport();
    fireEvent.click(screen.getByRole('button', { name: 'Importar catálogo de Meta' }));
    const dialogo = await screen.findByRole('dialog');
    expect(dialogo).toHaveAttribute('aria-modal', 'true');
    expect(dialogo).toHaveAccessibleName('¿Importar todo el catálogo de Meta?');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(runImport).not.toHaveBeenCalled();
  });

  it('cancelar el modal tampoco importa nada', async () => {
    renderImport();
    fireEvent.click(screen.getByRole('button', { name: 'Importar catálogo de Meta' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(runImport).not.toHaveBeenCalled();
  });

  it('roles sin permiso de importación no ven nada (gate de dueño)', () => {
    mockAuth.role = 'SELLER';
    const { container } = renderImport();
    expect(container).toBeEmptyDOMElement();
  });
});
