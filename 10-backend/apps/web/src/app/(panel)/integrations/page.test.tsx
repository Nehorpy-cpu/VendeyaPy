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
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import IntegrationsPage from './page';

// ---- Dobles de las capas con I/O ----
const getConnMock = vi.fn();
const listAssetsMock = vi.fn();
const startConnectMock = vi.fn();
const connectMetaMock = vi.fn();
const coexStartMock = vi.fn();
const coexConnectMock = vi.fn();
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
    coexistenceStart: (...a: unknown[]) => coexStartMock(...a),
    coexistenceConnect: (...a: unknown[]) => coexConnectMock(...a),
    verifyMetaChannel: vi.fn(),
    selectMetaPhoneNumber: vi.fn(),
    metaDisconnect: vi.fn(),
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
  coexStartMock.mockResolvedValue({ nonce: 'nonce-coexistence' });
  coexConnectMock.mockResolvedValue({
    ok: true, connectionId: 'wa_pnid-2', phoneNumberId: 'pnid-2', phoneNumber: null, status: 'active', replay: false, automationMode: 'inactive',
  });
  launchMock.mockResolvedValue({ code: 'code-de-prueba', flow: 'standard' });
});

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
