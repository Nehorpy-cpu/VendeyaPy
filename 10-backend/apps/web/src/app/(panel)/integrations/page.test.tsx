/**
 * page.test.tsx — LA PANTALLA QUE EL DUEÑO USA PARA METER SU NÚMERO REAL
 * ======================================================================
 * ADR-0017. Tres cosas se fijan acá, y ninguna es cosmética:
 *
 *  1. **El popup se abre en el gesto.** El botón llamaba al Embedded Signup después de DOS `await`,
 *     así que el navegador bloqueaba la ventana y el código lo reportaba como «cancelaste la
 *     conexión». En el teléfono del dueño, con la ventana de 24 h de Coexistence corriendo, eso es
 *     mandarlo a buscar un error que no existe.
 *  2. **La UI no puede decir «Activo/En vivo» de un número que está callado.** `automationMode`
 *     nace `inactive` a propósito (§1): mostrarlo como si automatizara es mentirle al dueño sobre
 *     lo que su negocio está haciendo.
 *  3. **Coexistence se explica antes de tocarlo**: qué conserva, qué pierde y que el número
 *     empieza INACTIVO. Es un número con clientes vivos adentro.
 *  4. **Coexistence usa SUS callables, jamás el flujo estándar.** Este archivo afirmaba lo
 *     contrario —que el botón viajaba por `startMetaConnect`/`connectMeta` con `mode: 'coexistence'`—
 *     y por eso ningún test detectó el defecto crítico: `connectMeta` corre `runMetaConnect`, que
 *     pisa el secreto de `main` y reescribe `metaAssets` con `connectionId: 'main'`, borrando el
 *     asset y la entrada de índice del número que HOY vende. Apretar «conectar mi número real»
 *     apagaba el número que está vendiendo. Los tests de abajo fallan si alguien vuelve a
 *     cablearlo al camino estándar.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import IntegrationsPage from './page';

// ---- Dobles de las capas con I/O ----
const getConnMock = vi.fn();
const listAssetsMock = vi.fn();
const startConnectMock = vi.fn();
const connectMetaMock = vi.fn();
const completeWabaMock = vi.fn();
const verifyMock = vi.fn();
const metaDisconnectMock = vi.fn();
const coexStartMock = vi.fn();
const coexConnectMock = vi.fn();
const coexSyncStatusMock = vi.fn();
const launchMock = vi.fn();
const preloadMock = vi.fn();
const rolActual = { role: 'TENANT_OWNER' as string };

vi.mock('@/lib/integrations', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/integrations')>();
  return {
    ...real,
    isMetaConfigured: () => true,
    isDemoIntegrationsAllowed: () => false,
    getMetaConnection: (...a: unknown[]) => getConnMock(...a),
    listMetaAssets: (...a: unknown[]) => listAssetsMock(...a),
    startMetaConnect: (...a: unknown[]) => startConnectMock(...a),
    connectMeta: (...a: unknown[]) => connectMetaMock(...a),
    completeMetaConnectWaba: (...a: unknown[]) => completeWabaMock(...a),
    coexistenceStart: (...a: unknown[]) => coexStartMock(...a),
    coexistenceConnect: (...a: unknown[]) => coexConnectMock(...a),
    coexistenceSyncStatus: (...a: unknown[]) => coexSyncStatusMock(...a),
    verifyMetaChannel: (...a: unknown[]) => verifyMock(...a),
    selectMetaPhoneNumber: vi.fn(),
    metaDisconnect: (...a: unknown[]) => metaDisconnectMock(...a),
    listConversionEvents: async () => [],
  };
});

vi.mock('@/lib/metaEmbeddedSignup', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/metaEmbeddedSignup')>();
  return {
    ...real,
    isEmbeddedSignupConfigured: () => true,
    preloadFacebookSdk: (...a: unknown[]) => preloadMock(...a),
    launchEmbeddedSignup: (...a: unknown[]) => launchMock(...a),
  };
});

vi.mock('@/lib/channels', () => ({
  getChannelConfig: async () => ({ whatsappSendMode: 'live' }),
  setWhatsappSendMode: vi.fn(),
  friendlyChannelError: (e: unknown) => String(e),
}));
vi.mock('@/lib/agent-config', () => ({ getAgentConfig: async () => ({ botEnabled: true }) }));
vi.mock('@/lib/entitlements', () => ({
  resolveEntitlements: async () => ({}),
  getUsage: async () => ({ items: [] }),
  isUnlimited: () => true,
}));
vi.mock('@/components/integrations/WhatsappAssistedActivation', () => ({ WhatsappAssistedActivation: () => null }));
vi.mock('@/lib/active-company', () => ({
  useActiveCompany: () => ({ tenantId: 'tnt_alpha', companyName: 'Empresa', companies: [], isSuperAdmin: false, loading: false, setTenantId: () => {} }),
}));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { uid: 'owner-1' }, claims: { role: rolActual.role, tenantId: 'tnt_alpha' }, loading: false, signOut: async () => {} }),
}));

const ts = { seconds: 0, nanoseconds: 0 };
const numero = (over: Record<string, unknown>) => ({
  id: 'pnid-1',
  tenantId: 'tnt_alpha',
  connectionId: 'main',
  assetType: 'whatsapp_phone_number',
  externalId: 'pnid-1',
  name: 'Perfumería (+595 …)',
  status: 'active',
  selected: true,
  automationMode: null,
  createdAt: ts,
  updatedAt: ts,
  ...over,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <IntegrationsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  rolActual.role = 'TENANT_OWNER';
  getConnMock.mockResolvedValue({ id: 'main', status: 'active', metaBusinessName: 'Negocio', scopes: ['whatsapp_business_messaging'] });
  listAssetsMock.mockResolvedValue([numero({ automationMode: 'live' })]);
  startConnectMock.mockResolvedValue({ nonce: 'nonce-de-prueba' });
  connectMetaMock.mockResolvedValue({ ok: true, status: 'active', phoneNumberId: 'pnid-1', phoneNumber: null, assets: 1 });
  completeWabaMock.mockResolvedValue({ ok: true, status: 'active', phoneNumberId: 'pnid-1', phoneNumber: null, assets: 1 });
  verifyMock.mockResolvedValue({ ok: true, ready: true, status: 'active' });
  metaDisconnectMock.mockResolvedValue(undefined);
  coexStartMock.mockResolvedValue({ nonce: 'nonce-coexistence' });
  coexConnectMock.mockResolvedValue({
    ok: true, connectionId: 'wa_pnid-2', phoneNumberId: 'pnid-2', phoneNumber: null, status: 'active', replay: false, automationMode: 'inactive',
  });
  coexSyncStatusMock.mockResolvedValue({ ok: true, exists: false });
  launchMock.mockResolvedValue({ code: 'code-de-prueba', flow: 'standard' });
});

/** El rechazo que un callable de Firebase entrega en el cliente (código + details saneados). */
const errorCallable = (code: string, message: string, details?: unknown) => ({ code, message, details });

const DIA_MS = 86_400_000;
/** Timestamp de Firestore serializado ({seconds}) apuntando `ms` milisegundos atrás. */
const tsHace = (ms: number) => ({ seconds: (Date.now() - ms) / 1000, nanoseconds: 0 });

/** Un número Coexistence (conexión propia wa_*), aparte del número de `main`. */
const numeroCoexistence = () =>
  numero({ id: 'pnid-2', externalId: 'pnid-2', connectionId: 'wa_pnid-2', name: 'Ventas (+595 …)', selected: false, automationMode: 'inactive' });

describe('guard de rol en la ruta', () => {
  it('un rol sin permiso no ve la pantalla de conexión (no solo los botones)', async () => {
    rolActual.role = 'TENANT_MANAGER';
    renderPage();
    expect(await screen.findByText(/solo el dueño|solo para/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /conectar/i })).toBeNull();
    // La pantalla entera no se arma: ni el estado de la conexión ni el checklist.
    expect(screen.queryByText(/respuestas reales por whatsapp/i)).toBeNull();
  });

  it('el dueño sí la ve', async () => {
    renderPage();
    expect(await screen.findByText(/respuestas reales por whatsapp/i)).toBeInTheDocument();
  });
});

describe('el popup se abre en el gesto del usuario', () => {
  it('el click llama al Embedded Signup SINCRÓNICAMENTE (sin esperar al nonce)', async () => {
    getConnMock.mockResolvedValue(null);
    listAssetsMock.mockResolvedValue([]);
    renderPage();
    const btn = await screen.findByRole('button', { name: /conectar meta business/i });
    fireEvent.click(btn);
    // Sin waitFor: si el lanzamiento espera al callable del nonce, acá todavía no se llamó.
    expect(launchMock).toHaveBeenCalledTimes(1);
  });

  it('precarga el SDK cuando hay config, para que el click no tenga que esperarlo', async () => {
    renderPage();
    await waitFor(() => expect(preloadMock).toHaveBeenCalled());
  });

  it('un popup BLOQUEADO se explica como tal, no como una cancelación', async () => {
    const { MetaSignupError } = await import('@/lib/metaEmbeddedSignup');
    getConnMock.mockResolvedValue(null);
    listAssetsMock.mockResolvedValue([]);
    launchMock.mockRejectedValue(new MetaSignupError('popup_blocked', 'El navegador bloqueó la ventana de Meta.'));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /conectar meta business/i }));
    expect(await screen.findByText(/bloqueó la ventana/i)).toBeInTheDocument();
    expect(screen.queryByText(/cancelaste/i)).toBeNull();
  });
});

describe('accesibilidad del feedback', () => {
  it('el aviso se anuncia con aria-live (un lector de pantalla no lo perdería)', async () => {
    const { MetaSignupError } = await import('@/lib/metaEmbeddedSignup');
    getConnMock.mockResolvedValue(null);
    listAssetsMock.mockResolvedValue([]);
    launchMock.mockRejectedValue(new MetaSignupError('cancelled', 'Cancelaste la conexión con Meta.'));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /conectar meta business/i }));
    // El contenedor `role="status"` existe SIEMPRE (vacío mientras no hay aviso), así que
    // `findByRole` resuelve al instante y afirmar el texto sin esperar es una carrera contra la
    // mutación. Lo que se afirma es lo mismo; lo que cambia es que ya no depende de la máquina.
    const aviso = await screen.findByRole('status');
    await waitFor(() => expect(aviso).toHaveTextContent(/cancelaste/i));
  });
});

describe('la UI no puede mentir sobre lo que el número está haciendo', () => {
  it('un número en shadow NO se muestra como que está automatizando', async () => {
    listAssetsMock.mockResolvedValue([numero({ automationMode: 'shadow' })]);
    renderPage();
    expect(await screen.findByText(/en observación/i)).toBeInTheDocument();
    expect(screen.getByText(/todavía no responde|no responde automáticamente/i)).toBeInTheDocument();
  });

  it('un número sin declarar (campo ausente) se muestra INACTIVO, no activo', async () => {
    listAssetsMock.mockResolvedValue([numero({ automationMode: null })]);
    renderPage();
    expect(await screen.findByText(/sin automatizar/i)).toBeInTheDocument();
  });

  it('solo `live` se muestra como automatizando', async () => {
    listAssetsMock.mockResolvedValue([numero({ automationMode: 'live' })]);
    renderPage();
    expect(await screen.findByText(/automatizando/i)).toBeInTheDocument();
  });
});

describe('Coexistence: el dueño entiende qué va a pasar con su número', () => {
  it('ofrece el flujo del número ya usado en WhatsApp Business, aparte del estándar', async () => {
    renderPage();
    expect(await screen.findByRole('button', { name: /número que ya us/i })).toBeInTheDocument();
  });

  it('dice qué conserva, qué pierde y que el número empieza INACTIVO', async () => {
    renderPage();
    expect(await screen.findByText(/listas de difusión/i)).toBeInTheDocument();
    expect(screen.getByText(/dispositivos vinculados/i)).toBeInTheDocument();
    expect(screen.getByText(/catálogo, pedidos/i)).toBeInTheDocument();
    expect(screen.getByText(/empieza inactivo/i)).toBeInTheDocument();
  });

  /**
   * EL DEFECTO CRÍTICO, fijado. `connectMeta` → `runMetaConnect` → `getSecretStore().set(
   * metaTokenSecretName(tenantId))` (el nombre del secreto es determinístico POR TENANT, así que
   * pisa el token de `main`) y `writeDiscoveredAssets(tenantId, 'main', …)`, que borra todo asset y
   * toda entrada de índice con `connectionId === 'main'` — el asset del número que vende y su
   * `metaExternalIndex/whatsapp_…`. El botón de Coexistence NO puede llegar ahí.
   */
  it('el botón de Coexistence usa los callables de Coexistence, NUNCA el flujo estándar', async () => {
    launchMock.mockResolvedValue({ code: 'code-de-prueba', flow: 'coexistence', sessionInfo: { wabaId: '111' } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /número que ya us/i }));
    const confirmar = await screen.findByRole('button', { name: /sí, conectar/i });
    fireEvent.click(confirmar);
    await waitFor(() => expect(launchMock).toHaveBeenCalledWith('coexistence'));
    await waitFor(() => expect(coexStartMock).toHaveBeenCalledWith('tnt_alpha'));
    await waitFor(() =>
      expect(coexConnectMock).toHaveBeenCalledWith('tnt_alpha', expect.objectContaining({ nonce: 'nonce-coexistence', code: 'code-de-prueba', wabaId: '111' })),
    );
  });

  it('y NO toca el camino que reescribe la conexión `main` (ni el nonce estándar)', async () => {
    launchMock.mockResolvedValue({ code: 'code-de-prueba', flow: 'coexistence', sessionInfo: { wabaId: '111' } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /número que ya us/i }));
    fireEvent.click(await screen.findByRole('button', { name: /sí, conectar/i }));
    await waitFor(() => expect(coexConnectMock).toHaveBeenCalled());
    expect(connectMetaMock).not.toHaveBeenCalled();
    expect(startConnectMock).not.toHaveBeenCalled();
  });

  it('el flujo ESTÁNDAR sigue usando su propio camino (sin regresión)', async () => {
    getConnMock.mockResolvedValue(null);
    listAssetsMock.mockResolvedValue([]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /conectar meta business/i }));
    await waitFor(() => expect(startConnectMock).toHaveBeenCalledWith('tnt_alpha', 'standard'));
    await waitFor(() =>
      expect(connectMetaMock).toHaveBeenCalledWith('tnt_alpha', expect.objectContaining({ mode: 'standard', nonce: 'nonce-de-prueba', code: 'code-de-prueba' })),
    );
    expect(coexConnectMock).not.toHaveBeenCalled();
  });

  it('el éxito NO promete automatización: avisa que el número queda inactivo', async () => {
    launchMock.mockResolvedValue({ code: 'code-de-prueba', flow: 'coexistence', sessionInfo: { wabaId: '111' } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /número que ya us/i }));
    fireEvent.click(await screen.findByRole('button', { name: /sí, conectar/i }));
    expect(await screen.findByText(/no responde automáticamente|queda inactivo/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// META-ONBOARDING-SELF-SERVICE-1 (ADR-0020): selector de WABA, lastConnectError
// visible, antigüedad de verificación, acciones por número y desconexión fuerte.
// ---------------------------------------------------------------------------

/** El rechazo de `connectMeta` cuando el token autoriza varios WABA (contrato G2). */
const rechazoSeleccionWaba = () =>
  errorCallable('functions/failed-precondition', 'Elegí la cuenta de WhatsApp Business.', {
    reason: 'waba_selection_required',
    selectionId: 'sel-1',
    wabas: [
      { id: '1234567890', name: 'Perfumería PY' },
      { id: '9876540222', name: 'Distribuidora Sur' },
    ],
  });

async function conectarYAbrirSelector() {
  getConnMock.mockResolvedValue(null);
  listAssetsMock.mockResolvedValue([]);
  connectMetaMock.mockRejectedValue(rechazoSeleccionWaba());
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: /conectar meta business/i }));
  return await screen.findByRole('dialog', { name: /varias cuentas de whatsapp business/i });
}

describe('selector de WABA (waba_selection_required · G2)', () => {
  it('al rechazar connectMeta con los details, aparece el modal con las cuentas y el id enmascarado', async () => {
    const modal = await conectarYAbrirSelector();
    const radios = within(modal).getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(within(modal).getByRole('radio', { name: /perfumería py/i })).toBeInTheDocument();
    // El id NUNCA se muestra completo: solo los últimos 4.
    expect(within(modal).getByText(/…7890/)).toBeInTheDocument();
    expect(within(modal).queryByText(/1234567890/)).toBeNull();
  });

  it('Conectar queda deshabilitado hasta elegir, y confirma con completeMetaConnectWaba(elegido)', async () => {
    const modal = await conectarYAbrirSelector();
    const confirmar = within(modal).getByRole('button', { name: /^conectar$/i });
    expect(confirmar).toBeDisabled();
    fireEvent.click(within(modal).getByRole('radio', { name: /distribuidora sur/i }));
    expect(confirmar).not.toBeDisabled();
    fireEvent.click(confirmar);
    await waitFor(() => expect(completeWabaMock).toHaveBeenCalledWith('tnt_alpha', 'sel-1', '9876540222'));
    // Mismo desenlace que la conexión normal: modal cerrado + aviso de éxito.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /varias cuentas/i })).toBeNull());
    expect(await screen.findByText(/¡meta conectado! ya podés recibir mensajes/i)).toBeInTheDocument();
  });

  it('doble click NO dispara dos veces el callable', async () => {
    let liberar: (() => void) | undefined;
    completeWabaMock.mockImplementation(
      () => new Promise((resolve) => { liberar = () => resolve({ ok: true, status: 'active', phoneNumberId: 'pnid-1', phoneNumber: null, assets: 1 }); }),
    );
    const modal = await conectarYAbrirSelector();
    fireEvent.click(within(modal).getByRole('radio', { name: /perfumería py/i }));
    const confirmar = within(modal).getByRole('button', { name: /^conectar$/i });
    fireEvent.click(confirmar);
    fireEvent.click(confirmar);
    await waitFor(() => expect(completeWabaMock).toHaveBeenCalledTimes(1));
    liberar?.();
  });

  it('selectionId vencido ⇒ mensaje de rehacer el login + CTA que relanza la conexión', async () => {
    // Review MEDIO: solo `details.reason === 'seleccion_invalida'` marca la selección MUERTA;
    // un failed-precondition sin esa marca conserva su mensaje accionable (test siguiente).
    completeWabaMock.mockRejectedValue(errorCallable('functions/failed-precondition', 'La selección venció.', { reason: 'seleccion_invalida' }));
    const modal = await conectarYAbrirSelector();
    fireEvent.click(within(modal).getByRole('radio', { name: /perfumería py/i }));
    fireEvent.click(within(modal).getByRole('button', { name: /^conectar$/i }));
    // El mensaje aparece (cuerpo del modal) y también el CTA: por eso *AllBy*.
    expect((await screen.findAllByText(/rehacer el login de meta/i)).length).toBeGreaterThan(0);
    const cta = screen.getByRole('button', { name: /rehacer el login de meta/i });
    expect(launchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(cta);
    // El relanzamiento abre el popup EN el gesto (sincrónico), igual que el botón original.
    expect(launchMock).toHaveBeenCalledTimes(2);
  });

  it('un error recuperable se muestra en el modal sin cerrarlo (se puede reintentar)', async () => {
    completeWabaMock.mockRejectedValue(errorCallable('functions/internal', 'No se pudo completar la operación con Meta. Probá de nuevo.'));
    const modal = await conectarYAbrirSelector();
    fireEvent.click(within(modal).getByRole('radio', { name: /perfumería py/i }));
    fireEvent.click(within(modal).getByRole('button', { name: /^conectar$/i }));
    expect(await within(modal).findByText(/no se pudo completar/i)).toBeInTheDocument();
    expect(within(modal).getByRole('button', { name: /^conectar$/i })).toBeInTheDocument();
  });

  it('un failed-precondition SIN seleccion_invalida (p. ej. colisión de WABA) conserva su mensaje accionable — jamás se disfraza de "venció" (review MEDIO)', async () => {
    completeWabaMock.mockRejectedValue(errorCallable(
      'functions/failed-precondition',
      'Esa cuenta de WhatsApp Business ya está conectada a otra empresa.',
      { reason: 'waba_collision' },
    ));
    const modal = await conectarYAbrirSelector();
    fireEvent.click(within(modal).getByRole('radio', { name: /perfumería py/i }));
    fireEvent.click(within(modal).getByRole('button', { name: /^conectar$/i }));
    expect(await within(modal).findByText(/ya está conectada a otra empresa/i)).toBeInTheDocument();
    // NO entra al estado "vencido": no aparece el CTA de rehacer el login.
    expect(screen.queryByRole('button', { name: /rehacer el login de meta/i })).toBeNull();
  });
});

describe('lastConnectError visible y TRADUCIDO (G8)', () => {
  it('una razón conocida se muestra en es-PY, jamás cruda', async () => {
    getConnMock.mockResolvedValue({
      id: 'main', status: 'error', metaBusinessName: 'Negocio', scopes: [],
      lastConnectError: 'token_invalid', lastConnectErrorAt: tsHace(3_600_000),
    });
    renderPage();
    expect(await screen.findByText(/meta rechazó la credencial/i)).toBeInTheDocument();
    expect(screen.queryByText(/token_invalid/)).toBeNull();
  });

  it('una razón desconocida cae al genérico honesto, jamás cruda', async () => {
    getConnMock.mockResolvedValue({
      id: 'main', status: 'error', metaBusinessName: 'Negocio', scopes: [],
      lastConnectError: 'motivo_misterioso_42', lastConnectErrorAt: tsHace(3_600_000),
    });
    renderPage();
    expect(await screen.findByText(/el último intento de conexión no se pudo completar/i)).toBeInTheDocument();
    expect(screen.queryByText(/motivo_misterioso_42/)).toBeNull();
  });

  it('con la conexión activa y sana no se muestra un error viejo', async () => {
    getConnMock.mockResolvedValue({
      id: 'main', status: 'active', metaBusinessName: 'Negocio', scopes: [],
      lastConnectError: 'token_invalid', lastConnectErrorAt: tsHace(3_600_000),
    });
    renderPage();
    await screen.findByText(/respuestas reales por whatsapp/i);
    expect(screen.queryByText(/meta rechazó la credencial/i)).toBeNull();
  });
});

describe('antigüedad de la última verificación (G5 mitigado en UI)', () => {
  it('muestra "hace X" junto a la última verificación', async () => {
    getConnMock.mockResolvedValue({
      id: 'main', status: 'active', metaBusinessName: 'Negocio', scopes: [], lastVerifiedAt: tsHace(2 * 3_600_000),
    });
    renderPage();
    expect(await screen.findByText(/hace 2 horas/i)).toBeInTheDocument();
    expect(screen.queryByText(/no se verifica desde hace/i)).toBeNull();
  });

  it('con más de 7 días avisa, sobrio, sugiriendo Revisar conexión', async () => {
    getConnMock.mockResolvedValue({
      id: 'main', status: 'active', metaBusinessName: 'Negocio', scopes: [], lastVerifiedAt: tsHace(10 * DIA_MS),
    });
    renderPage();
    expect(await screen.findByText(/no se verifica desde hace/i)).toBeInTheDocument();
    expect(screen.getByText(/última verificación: hace 10 días/i)).toBeInTheDocument();
  });
});

describe('acciones por número Coexistence (wa_*) · G3/G4', () => {
  it('Verificar llama a verifyMetaChannel con el connectionId del número', async () => {
    listAssetsMock.mockResolvedValue([numero({ automationMode: 'live' }), numeroCoexistence()]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /^verificar$/i }));
    await waitFor(() => expect(verifyMock).toHaveBeenCalledWith('tnt_alpha', 'wa_pnid-2'));
  });

  it('Desconectar número exige tipear DESCONECTAR y manda su connectionId', async () => {
    listAssetsMock.mockResolvedValue([numero({ automationMode: 'live' }), numeroCoexistence()]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /desconectar número/i }));
    const modal = await screen.findByRole('dialog', { name: /desconectar el número/i });
    const confirmar = within(modal).getByRole('button', { name: /sí, desconectar/i });
    expect(confirmar).toBeDisabled();
    fireEvent.change(within(modal).getByLabelText(/escribí desconectar/i), { target: { value: 'DESCONECTAR' } });
    expect(confirmar).not.toBeDisabled();
    fireEvent.click(confirmar);
    await waitFor(() => expect(metaDisconnectMock).toHaveBeenCalledWith('tnt_alpha', 'wa_pnid-2'));
  });
});

describe('desconexión de main con confirmación FUERTE (G12 en la UI)', () => {
  it('el botón destructivo queda bloqueado hasta tipear DESCONECTAR exacto', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /^desconectar$/i }));
    const modal = await screen.findByRole('dialog', { name: /desconectar meta/i });
    const confirmar = within(modal).getByRole('button', { name: /sí, desconectar/i });
    expect(confirmar).toBeDisabled();
    // Minúsculas NO alcanzan: la palabra es exacta.
    fireEvent.change(within(modal).getByLabelText(/escribí desconectar/i), { target: { value: 'desconectar' } });
    expect(confirmar).toBeDisabled();
    fireEvent.click(confirmar);
    expect(metaDisconnectMock).not.toHaveBeenCalled();
    fireEvent.change(within(modal).getByLabelText(/escribí desconectar/i), { target: { value: 'DESCONECTAR' } });
    expect(confirmar).not.toBeDisabled();
    fireEvent.click(confirmar);
    await waitFor(() => expect(metaDisconnectMock).toHaveBeenCalledWith('tnt_alpha', undefined));
  });

  it('explica la no-destructividad: se corta el ruteo acá, pero NO se borra nada dentro de Meta', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /^desconectar$/i }));
    const modal = await screen.findByRole('dialog', { name: /desconectar meta/i });
    expect(within(modal).getByText(/no se elimina nada dentro de meta/i)).toBeInTheDocument();
    expect(within(modal).getByText(/reconectar/i)).toBeInTheDocument();
  });
});

describe('RBAC: nada nuevo visible para roles sin permiso', () => {
  it.each(['TENANT_MANAGER', 'TENANT_SELLER', 'TENANT_VIEWER'])('%s no ve ninguna acción nueva', async (rol) => {
    rolActual.role = rol;
    listAssetsMock.mockResolvedValue([numero({ automationMode: 'live' }), numeroCoexistence()]);
    renderPage();
    await screen.findByText(/solo el dueño|solo para/i);
    expect(screen.queryByRole('button', { name: /^verificar$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /desconectar número/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^desconectar$/i })).toBeNull();
  });
});

// Helpers puros del contrato (la versión REAL del módulo, sin el mock de arriba).
describe('helpers del contrato waba_selection_required / lastConnectError', () => {
  it('readWabaSelectionRequired: parsea details válidos y sanea entradas sin id', async () => {
    const real = await vi.importActual<typeof import('@/lib/integrations')>('@/lib/integrations');
    const sel = real.readWabaSelectionRequired(
      errorCallable('functions/failed-precondition', 'x', {
        reason: 'waba_selection_required',
        selectionId: 'sel-9',
        wabas: [{ id: ' 111 ', name: 'Uno' }, { id: '', name: 'sin id' }, { name: 'tampoco' }, { id: '222' }],
      }),
    );
    expect(sel).toEqual({
      selectionId: 'sel-9',
      wabas: [
        { id: '111', name: 'Uno' },
        { id: '222', name: 'Cuenta de WhatsApp Business' },
      ],
    });
  });

  it('readWabaSelectionRequired: null ante otro código, otra razón o details malformados', async () => {
    const real = await vi.importActual<typeof import('@/lib/integrations')>('@/lib/integrations');
    expect(real.readWabaSelectionRequired(errorCallable('functions/internal', 'x'))).toBeNull();
    expect(real.readWabaSelectionRequired(errorCallable('functions/failed-precondition', 'x', { reason: 'otra' }))).toBeNull();
    expect(real.readWabaSelectionRequired(errorCallable('functions/failed-precondition', 'x', { reason: 'waba_selection_required', selectionId: '', wabas: [] }))).toBeNull();
    expect(real.readWabaSelectionRequired(null)).toBeNull();
  });

  it('textoDeConnectError: traduce razones conocidas y NUNCA devuelve la cruda', async () => {
    const real = await vi.importActual<typeof import('@/lib/integrations')>('@/lib/integrations');
    expect(real.textoDeConnectError('scopes_insuficientes')).toMatch(/permisos/i);
    expect(real.textoDeConnectError('seleccion_invalida')).toMatch(/rehacé el login/i);
    const raro = real.textoDeConnectError('GraphError#190 <raw>');
    expect(raro).not.toContain('GraphError#190');
    expect(raro).toMatch(/no se pudo completar/i);
  });

  it('textoDeConnectError: también traduce las FRASES que el backend persiste hoy', async () => {
    const real = await vi.importActual<typeof import('@/lib/integrations')>('@/lib/integrations');
    expect(real.textoDeConnectError('el número de WhatsApp ya está conectado en otra empresa')).toMatch(/otra empresa/i);
    expect(real.textoDeConnectError('sin WhatsApp Business Account')).toMatch(/whatsapp business/i);
    // La frase de scopes es dinámica: se resuelve por prefijo, sin ecoar la lista cruda.
    const scopes = real.textoDeConnectError('faltan permisos: whatsapp_business_management');
    expect(scopes).toMatch(/permisos/i);
    expect(scopes).not.toContain('whatsapp_business_management');
  });

  it('formatHace: minutos, horas y días en es-PY', async () => {
    const real = await vi.importActual<typeof import('@/lib/integrations')>('@/lib/integrations');
    const ahora = Date.now();
    expect(real.formatHace(ahora - 30_000, ahora)).toBe('hace un momento');
    expect(real.formatHace(ahora - 5 * 60_000, ahora)).toBe('hace 5 minutos');
    expect(real.formatHace(ahora - 3 * 3_600_000, ahora)).toBe('hace 3 horas');
    expect(real.formatHace(ahora - 12 * DIA_MS, ahora)).toBe('hace 12 días');
  });
});
