/**
 * CatalogAuthoritySelector.test.tsx — «Quién administra tu catálogo» (ADR-0022).
 *
 * Fija los rieles del selector:
 * - roles (§6): OWNER configura, MANAGER ve en solo lectura, SELLER no ve nada;
 * - la opción vigente queda marcada y se dice si es declarada o derivada (legacy);
 * - preview con payload exacto; con bloqueos NO hay confirmar y los requisitos se traducen
 *   (conexión faltante lleva a Integración Meta);
 * - apply atado a runId+planHash, con éxito anunciado y kinds traducidos (expired ⇒ el
 *   preview mostrado se descarta);
 * - confirmación FUERTE (tipear CAMBIAR) para abandonar la publicación activa;
 * - frescura (§5) solo para espejo, con advertencia pasadas las 48 h y jamás «verificado»
 *   sin lectura real;
 * - honestidad del conector externo: sin fuente reconocida no hay botón falso ni campo URL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { normalizarOwnershipStatus } from '@/lib/catalog';
import type { AuthorityPreviewView } from '@/lib/catalogAuthority';
import { CatalogAuthoritySelector } from './CatalogAuthoritySelector';

const ownershipMock = vi.fn();
vi.mock('@/lib/catalog', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/catalog')>();
  return { ...real, fetchCatalogOwnershipStatus: (...a: unknown[]) => ownershipMock(...a) };
});

const previewMock = vi.fn();
const applyMock = vi.fn();
vi.mock('@/lib/catalogAuthority', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/catalogAuthority')>();
  return {
    ...real,
    fetchCatalogAuthorityPreview: (...a: unknown[]) => previewMock(...a),
    applyCatalogAuthority: (...a: unknown[]) => applyMock(...a),
  };
});

const sesion = vi.hoisted(() => ({ rol: 'TENANT_OWNER' as string | null }));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({
    user: { uid: 'owner-1' },
    claims: { role: sesion.rol, tenantId: 'perfumeria' },
    loading: false,
    signOut: async () => {},
  }),
}));

const HORA = 60 * 60 * 1000;

/** A: vendeyapy+none derivado (local sin Meta de facto). */
const OWN_NONE = () =>
  normalizarOwnershipStatus({
    enabled: true,
    configMode: 'off',
    ownership: { model: 'vendeyapy_managed', writable: ['title', 'price'], degraded: false, reasons: [] },
    authority: { authority: 'vendeyapy', relationship: 'none', declared: false, reasons: [], staleness: {} },
  });

/** B: vendeyapy+managed declarado (publicación activa). */
const OWN_MANAGED = () =>
  normalizarOwnershipStatus({
    enabled: true,
    configMode: 'live',
    effectiveMode: 'live',
    ownership: { model: 'vendeyapy_managed', writable: ['title', 'price'], modeCeiling: 'live', degraded: false, reasons: [] },
    authority: { authority: 'vendeyapy', relationship: 'managed', declared: true, reasons: [], staleness: {} },
  });

/** D: external+mirror con fuente reconocida (modelo arfagi) y frescura configurable. */
const OWN_MIRROR = (leidaHaceMs: number | null) =>
  normalizarOwnershipStatus({
    enabled: true,
    configMode: 'dry_run',
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
      degraded: false,
      reasons: [],
    },
    authority: {
      authority: 'external',
      relationship: 'mirror',
      declared: true,
      reasons: [],
      staleness: leidaHaceMs == null ? {} : { lastSourceCheckAt: Date.now() - leidaHaceMs },
    },
  });

const previewOk = (over?: Partial<AuthorityPreviewView>): AuthorityPreviewView => ({
  ok: true,
  resumen: '',
  bloqueos: [],
  advertencias: [],
  estadoEsperado: { authority: 'meta', relationship: 'mirror' },
  estadoEsperadoTexto: '',
  planHash: 'ph-1',
  runId: 'run-1',
  venceEn: new Date(Date.now() + 10 * 60_000),
  ...over,
});

function renderSelector() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CatalogAuthoritySelector tenantId="perfumeria" />
    </QueryClientProvider>,
  );
}

/** happy-dom no dispara el onChange de radio/checkbox en un click sintético: mismo
 *  workaround que page.test.tsx (setter del prototipo + click). */
function marcarRadio(el: HTMLElement) {
  const input = el as HTMLInputElement;
  const desc =
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'checked') ??
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
  desc?.set?.call(input, true);
  fireEvent.click(input);
}

/** Camino corto hasta el preview listo: elegir «Lo administro en Meta» y revisarlo. */
async function elegirMetaYRevisar() {
  marcarRadio(await screen.findByRole('radio', { name: 'Lo administro en Meta' }));
  fireEvent.click(screen.getByRole('button', { name: 'Revisar el cambio' }));
  await waitFor(() => expect(previewMock).toHaveBeenCalled());
}

beforeEach(() => {
  vi.clearAllMocks();
  sesion.rol = 'TENANT_OWNER';
  ownershipMock.mockResolvedValue(OWN_NONE());
  previewMock.mockResolvedValue(previewOk());
  applyMock.mockResolvedValue({
    ok: true,
    antes: { authority: 'vendeyapy', relationship: 'none' },
    despues: { authority: 'meta', relationship: 'mirror' },
  });
});

describe('roles (§6)', () => {
  it('OWNER ve las cuatro opciones, la vigente marcada y el origen derivado dicho sin vueltas', async () => {
    renderSelector();
    expect(screen.getByText('Quién administra tu catálogo')).toBeInTheDocument();

    // El título aparece ya durante la carga: lo que hay que esperar son los DATOS.
    const vigente = await screen.findByRole('radio', { name: 'Solo usarlo para el bot' });
    expect(vigente).toBeChecked();
    for (const n of ['También publicar en Meta', 'Lo administro en Meta', 'Lo publica otro sistema']) {
      expect(screen.getByRole('radio', { name: n })).not.toBeChecked();
    }
    expect(screen.getByText(/derivado de tu configuración actual/i)).toBeInTheDocument();
    expect(screen.getByText('Modo actual')).toBeInTheDocument();
    // Sin selección distinta no hay nada para revisar ni confirmar.
    expect(screen.queryByRole('button', { name: 'Revisar el cambio' })).not.toBeInTheDocument();
    expect(previewMock).not.toHaveBeenCalled();
  });

  it('el modo declarado se dice como elegido por la empresa', async () => {
    ownershipMock.mockResolvedValue(OWN_MANAGED());
    renderSelector();
    expect(await screen.findByText(/Este modo lo eligió tu empresa/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'También publicar en Meta' })).toBeChecked();
  });

  it('MANAGER ve el estado en solo lectura: sin radios ni botones de cambio', async () => {
    sesion.rol = 'TENANT_MANAGER';
    renderSelector();
    expect(await screen.findByText(/Lo administrás en VendeYaPy, solo para el bot/)).toBeInTheDocument();
    expect(screen.getByText('Quién administra tu catálogo')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revisar el cambio' })).not.toBeInTheDocument();
    expect(screen.getByText(/Solo el dueño de la empresa/)).toBeInTheDocument();
  });

  it('SELLER no ve la sección', async () => {
    sesion.rol = 'SELLER';
    const { container } = renderSelector();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(ownershipMock).not.toHaveBeenCalled();
  });
});

describe('preview del cambio', () => {
  it('llama al preview con el payload exacto y muestra consecuencias, advertencias y countdown', async () => {
    previewMock.mockResolvedValue(previewOk({ advertencias: ['El espejo se refresca al importar.'] }));
    renderSelector();
    await screen.findByText('Quién administra tu catálogo');
    await elegirMetaYRevisar();

    expect(previewMock).toHaveBeenCalledWith('perfumeria', { authority: 'meta', relationship: 'mirror' });
    expect(await screen.findByText(/De «Lo administrás en VendeYaPy, solo para el bot» a «Lo administrás en Meta»/)).toBeInTheDocument();
    expect(screen.getByText(/VendeYaPy no escribe nada en Meta/)).toBeInTheDocument();
    expect(screen.getByText(/No se toca nada más/)).toBeInTheDocument();
    expect(screen.getByText('• El espejo se refresca al importar.')).toBeInTheDocument();
    expect(screen.getByText(/Va a quedar:/)).toBeInTheDocument();
    expect(screen.getByText(/Podés confirmarlo durante/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirmar el cambio…' })).toBeEnabled();
  });

  it('con bloqueos NO hay confirmar: lista traducida y link a Integración Meta cuando aplica', async () => {
    previewMock.mockResolvedValue(
      previewOk({
        ok: false,
        bloqueos: [
          { id: 'outbox_not_terminal', detalle: '' },
          { id: 'connection_missing', detalle: '' },
        ],
        planHash: null,
        runId: null,
      }),
    );
    renderSelector();
    await screen.findByText('Quién administra tu catálogo');
    await elegirMetaYRevisar();

    expect(await screen.findByText(/Todavía no se puede aplicar este cambio/)).toBeInTheDocument();
    expect(screen.getByText(/Hay envíos a Meta pendientes: resolvelos antes de cambiar el modo/)).toBeInTheDocument();
    expect(screen.getByText(/Falta la conexión con Meta/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Ir a Integración Meta' });
    expect(link).toHaveAttribute('href', '/integrations');
    expect(screen.queryByRole('button', { name: 'Confirmar el cambio…' })).not.toBeInTheDocument();
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('un preview ya vencido no ofrece confirmar: pide revisar de nuevo', async () => {
    previewMock.mockResolvedValue(previewOk({ venceEn: new Date(Date.now() - 1000) }));
    renderSelector();
    await screen.findByText('Quién administra tu catálogo');
    await elegirMetaYRevisar();

    expect(await screen.findByText('El preview venció, generá uno nuevo.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revisar de nuevo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirmar el cambio…' })).not.toBeInTheDocument();
  });
});

describe('apply', () => {
  it('confirmar aplica ATADO a runId+planHash y anuncia el resultado', async () => {
    renderSelector();
    await screen.findByText('Quién administra tu catálogo');
    await elegirMetaYRevisar();

    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar el cambio…' }));
    const dialogo = await screen.findByRole('dialog');
    expect(dialogo).toHaveAccessibleName('¿Cambiar quién administra el catálogo?');
    // Cambio que no abandona una publicación activa: confirmación clara, sin palabra.
    expect(within(dialogo).queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Sí, cambiar' }));

    await waitFor(() => expect(applyMock).toHaveBeenCalledWith('perfumeria', 'run-1', 'ph-1'));
    expect(await screen.findByText('Listo. Ahora: Lo administrás en Meta.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('expired: mensaje traducido y el preview mostrado se descarta (hay que regenerar)', async () => {
    applyMock.mockRejectedValue({ code: 'functions/failed-precondition', message: 'failed-precondition', details: { kind: 'expired' } });
    renderSelector();
    await screen.findByText('Quién administra tu catálogo');
    await elegirMetaYRevisar();
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar el cambio…' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Sí, cambiar' }));

    expect(await screen.findByText('El preview venció, generá uno nuevo.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirmar el cambio…' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Listo\. Ahora/)).not.toBeInTheDocument();
  });

  it('concurrent_change: dice que la configuración cambió mientras revisabas', async () => {
    applyMock.mockRejectedValue({ message: 'failed-precondition', details: { kind: 'concurrent_change' } });
    renderSelector();
    await screen.findByText('Quién administra tu catálogo');
    await elegirMetaYRevisar();
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar el cambio…' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Sí, cambiar' }));

    expect(await screen.findByText(/La configuración cambió mientras revisabas/)).toBeInTheDocument();
  });

  it('salir de la publicación activa exige tipear CAMBIAR (confirmación fuerte)', async () => {
    ownershipMock.mockResolvedValue(OWN_MANAGED());
    previewMock.mockResolvedValue(previewOk({ estadoEsperado: { authority: 'vendeyapy', relationship: 'none' } }));
    renderSelector();
    await screen.findByText('Quién administra tu catálogo');

    marcarRadio(await screen.findByRole('radio', { name: 'Solo usarlo para el bot' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revisar el cambio' }));
    await waitFor(() => expect(previewMock).toHaveBeenCalledWith('perfumeria', { authority: 'vendeyapy', relationship: 'none' }));
    expect(await screen.findByText('• VendeYaPy deja de publicar en Meta.')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar el cambio…' }));
    const dialogo = await screen.findByRole('dialog');
    expect(within(dialogo).getByText(/VendeYaPy va a dejar de publicar en Meta/)).toBeInTheDocument();

    const boton = within(dialogo).getByRole('button', { name: 'Sí, cambiar' });
    expect(boton).toBeDisabled();
    fireEvent.click(boton);
    expect(applyMock).not.toHaveBeenCalled();

    const palabra = within(dialogo).getByLabelText(/Escribí CAMBIAR para confirmar/);
    fireEvent.change(palabra, { target: { value: 'cambiar' } });
    expect(boton).toBeDisabled();
    fireEvent.change(palabra, { target: { value: 'CAMBIAR' } });
    expect(boton).toBeEnabled();
    fireEvent.click(boton);
    await waitFor(() => expect(applyMock).toHaveBeenCalledWith('perfumeria', 'run-1', 'ph-1'));
  });
});

describe('frescura (§5) y honestidad del conector externo', () => {
  it('espejo con lectura vieja (>48 h): antigüedad legible y advertencia visual', async () => {
    ownershipMock.mockResolvedValue(OWN_MIRROR(3 * 24 * HORA));
    renderSelector();
    expect(await screen.findByText(/Última lectura de la fuente: hace 3 días/)).toBeInTheDocument();
    expect(screen.getByText(/El espejo local está viejo/)).toBeInTheDocument();
  });

  it('espejo con lectura fresca: antigüedad sin advertencia', async () => {
    ownershipMock.mockResolvedValue(OWN_MIRROR(2 * HORA));
    renderSelector();
    expect(await screen.findByText(/Última lectura de la fuente: hace 2 horas/)).toBeInTheDocument();
    expect(screen.queryByText(/El espejo local está viejo/)).not.toBeInTheDocument();
  });

  it('espejo sin NINGUNA lectura real: se dice, jamás «verificado»', async () => {
    ownershipMock.mockResolvedValue(OWN_MIRROR(null));
    renderSelector();
    expect(await screen.findByText(/Todavía no leímos la fuente/)).toBeInTheDocument();
    expect(screen.queryByText(/Última lectura de la fuente/)).not.toBeInTheDocument();
  });

  it('sin relación espejo no se muestra frescura (no aplica)', async () => {
    ownershipMock.mockResolvedValue(OWN_NONE());
    renderSelector();
    await screen.findByRole('radio', { name: 'Solo usarlo para el bot' });
    expect(screen.queryByText(/Última lectura de la fuente/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Todavía no leímos la fuente/)).not.toBeInTheDocument();
  });

  it('«Lo publica otro sistema» sin fuente reconocida: texto honesto, sin campo de URL ni botón falso', async () => {
    ownershipMock.mockResolvedValue(OWN_NONE());
    renderSelector();
    expect(
      await screen.findByText(/La conexión directa con tu página se habilita con el conector correspondiente \(próximo programa\)/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Conectar/i })).not.toBeInTheDocument();
  });

  it('«Lo publica otro sistema» con fuente reconocida: la nombra (saneada)', async () => {
    ownershipMock.mockResolvedValue(OWN_MIRROR(2 * HORA));
    renderSelector();
    expect(await screen.findByText(/Fuente reconocida:/)).toBeInTheDocument();
    expect(screen.getByText('Catálogo del sitio')).toBeInTheDocument();
    expect(screen.queryByText(/próximo programa/)).not.toBeInTheDocument();
  });

  it('el contrato viejo (sin eje de autoridad) no ofrece cambiar nada', async () => {
    ownershipMock.mockResolvedValue(
      normalizarOwnershipStatus({
        enabled: true,
        configMode: 'live',
        ownership: { model: 'vendeyapy_managed', writable: ['title'], degraded: false, reasons: [] },
      }),
    );
    renderSelector();
    expect(await screen.findByText(/todavía no informa quién administra el catálogo/)).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });
});
