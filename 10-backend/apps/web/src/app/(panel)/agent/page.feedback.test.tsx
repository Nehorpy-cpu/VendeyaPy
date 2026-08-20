/**
 * page.feedback.test.tsx — H-03: el guardado de la config del agente NO puede ser mudo.
 *
 * Defecto auditado (`docs/system-audit-2026-08.md` §H-03, reproducido en vivo): con más de 5.000
 * caracteres en «Reglas de venta» el backend responde 400 y la pantalla no mostraba NADA — ni
 * éxito ni error. El botón volvía de «Guardando…» a «Guardar cambios» como si hubiera salido
 * bien, y al recargar el texto volvía al anterior. La config del agente es CÓMO VENDE EL BOT: el
 * dueño quedaba operando con una creencia falsa sobre su propio vendedor automático.
 *
 * Y H-15 en la misma pantalla: `(auditsQ.data?.length ?? 0) === 0` renderiza «✓ Sin hallazgos.»
 * — si la lectura FALLÓ, `data` es undefined, el `?? 0` lo vuelve cero y la UI afirma que está
 * todo bien. Un tilde verde sobre una lectura que nunca ocurrió.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AgentPage from './page';

const getAgentConfigMock = vi.fn();
const saveAgentConfigMock = vi.fn();
const getCheckoutConfigMock = vi.fn();
const saveCheckoutConfigMock = vi.fn();
const listOpenAuditsMock = vi.fn();
const generateAuditsMock = vi.fn();
const setAuditStatusMock = vi.fn();

// Se conservan los exports REALES (constantes, tipos, helpers) y solo se doblan las funciones de
// red: así el test ejercita la pantalla de verdad y no una maqueta.
vi.mock('@/lib/agent-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-config')>()),
  getAgentConfig: (...a: unknown[]) => getAgentConfigMock(...a),
  saveAgentConfig: (...a: unknown[]) => saveAgentConfigMock(...a),
  getCheckoutConfig: (...a: unknown[]) => getCheckoutConfigMock(...a),
  saveCheckoutConfig: (...a: unknown[]) => saveCheckoutConfigMock(...a),
}));
vi.mock('@/components/AgentTestChat', () => ({ AgentTestChat: () => null }));
vi.mock('@/lib/audits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audits')>()),
  listOpenAudits: (...a: unknown[]) => listOpenAuditsMock(...a),
  setAuditStatus: (...a: unknown[]) => setAuditStatusMock(...a),
  generateAudits: (...a: unknown[]) => generateAuditsMock(...a),
}));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ claims: { tenantId: 'perfumeria', role: 'TENANT_OWNER' }, user: { uid: 'uid-owner' } }),
}));
vi.mock('@/lib/active-company', () => ({
  useActiveCompany: () => ({ tenantId: 'perfumeria', loading: false, companies: [], setTenantId: vi.fn() }),
}));

const CONFIG = {
  agentName: 'Sofía',
  businessName: 'Perfumería AFG',
  greetingMessage: 'Hola',
  salesRules: 'Reglas cortas',
  fallbackMessage: '',
  handoffMessage: '',
  farewellMessage: '',
  faq: [],
  botEnabled: true,
  profitMode: false,
  industry: 'perfumeria',
};

const renderPage = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AgentPage />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  getAgentConfigMock.mockResolvedValue({ ...CONFIG });
  getCheckoutConfigMock.mockResolvedValue({ bankAccounts: [], sellers: [] });
  listOpenAuditsMock.mockResolvedValue([]);
  saveAgentConfigMock.mockResolvedValue(undefined);
  setAuditStatusMock.mockResolvedValue(undefined);
  saveCheckoutConfigMock.mockResolvedValue(undefined);
});

describe('H-03 · guardar la configuración del agente dice qué pasó', () => {
  it('si el backend rechaza (400 por reglas demasiado largas), la pantalla LO DICE', async () => {
    // El error real que devuelve el callable: `invalid-argument` con el motivo del validador.
    saveAgentConfigMock.mockRejectedValue(
      Object.assign(new Error('Campo "salesRules" demasiado largo.'), {
        code: 'functions/invalid-argument',
      }),
    );
    renderPage();
    await screen.findByDisplayValue('Sofía');

    fireEvent.click(screen.getByRole('button', { name: /guardar cambios/i }));

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toMatch(/no se pudo guardar/i);
    expect(aviso.textContent).toMatch(/demasiado largo/i); // el motivo real del backend llega al dueño
    // Y NO puede decir que guardó.
    expect(screen.queryByText(/✓ Guardado/)).toBeNull();
  });

  it('ante el error, el trabajo del dueño SIGUE en el formulario', async () => {
    saveAgentConfigMock.mockRejectedValue(
      Object.assign(new Error('Campo "salesRules" demasiado largo.'), {
        code: 'functions/invalid-argument',
      }),
    );
    renderPage();
    const nombre = await screen.findByDisplayValue('Sofía');

    fireEvent.change(nombre, { target: { value: 'Vale' } });
    fireEvent.click(screen.getByRole('button', { name: /guardar cambios/i }));
    await screen.findByRole('alert');

    // Lo que escribió no se revierte ni se recarga del servidor en la rama de error.
    expect((screen.getByDisplayValue('Vale') as HTMLInputElement).value).toBe('Vale');
  });

  it('NO REGRESIÓN: si guarda bien, sigue diciendo «✓ Guardado» y no muestra error', async () => {
    renderPage();
    await screen.findByDisplayValue('Sofía');

    fireEvent.click(screen.getByRole('button', { name: /guardar cambios/i }));

    await waitFor(() => expect(screen.getByText(/✓ Guardado/)).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(saveAgentConfigMock).toHaveBeenCalledTimes(1);
    expect(saveCheckoutConfigMock).toHaveBeenCalledTimes(1);
  });
});

describe('H-03 · las acciones sobre los hallazgos de la auditoría tampoco son mudas', () => {
  it('si «Resuelto» es rechazado, la pantalla lo dice', async () => {
    listOpenAuditsMock.mockResolvedValue([
      { id: 'a1', severity: 'HIGH', summary: 'El bot no responde precios', recommendedFix: 'Revisá las reglas', status: 'OPEN' },
    ]);
    setAuditStatusMock.mockRejectedValue(
      Object.assign(new Error('nope'), { code: 'functions/permission-denied' }),
    );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /resuelto/i }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/tu rol no puede ejecutar/i);
  });

  it('NO REGRESIÓN: si se acepta, no muestra ningún error', async () => {
    listOpenAuditsMock.mockResolvedValue([
      { id: 'a1', severity: 'HIGH', summary: 'El bot no responde precios', recommendedFix: 'Revisá las reglas', status: 'OPEN' },
    ]);
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /resuelto/i }));

    await waitFor(() => expect(setAuditStatusMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('H-15 · una config que no se pudo LEER no se puede sobrescribir', () => {
  it('si la config no se leyó, lo dice y BLOQUEA el guardado', async () => {
    // Sin esto, el formulario muestra DEFAULT_AGENT con bancos y vendedores vacíos: guardar
    // pisaría la configuración real del tenant y borraría sus datos de cobro.
    getAgentConfigMock.mockRejectedValue(new Error('unavailable'));
    renderPage();

    expect(await screen.findByText(/no pudimos leer la configuración de tu agente/i)).toBeTruthy();
    const guardar = screen.getByRole('button', { name: /guardar cambios/i }) as HTMLButtonElement;
    expect(guardar.disabled).toBe(true);

    fireEvent.click(guardar);
    await waitFor(() => expect(saveAgentConfigMock).not.toHaveBeenCalled());
  });

  it('mientras los datos de cobro TODAVÍA cargan, no se puede guardar', async () => {
    // La ventana real: `agentQ` ya resolvió y `checkoutQ` sigue en vuelo. Con el formulario
    // renderizado y `banks`/`sellers` vacíos, guardar borraba las cuentas y los vendedores.
    let resolverCheckout: ((v: unknown) => void) | undefined;
    getCheckoutConfigMock.mockImplementation(() => new Promise((ok) => { resolverCheckout = ok; }));
    renderPage();

    // No se muestra nada editable hasta que las DOS lecturas aterrizaron.
    await waitFor(() => expect(getCheckoutConfigMock).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /guardar cambios/i })).toBeNull();

    resolverCheckout!({ bankAccounts: [{ bank: 'Ueno', accountNumber: '123' }], sellers: [] });
    const guardar = await screen.findByRole('button', { name: /guardar cambios/i });
    expect((guardar as HTMLButtonElement).disabled).toBe(false);
  });

  it('si falla la lectura de datos de cobro, también bloquea', async () => {
    getCheckoutConfigMock.mockRejectedValue(new Error('unavailable'));
    renderPage();

    // El aviso nombra la lectura que falló, no una genérica.
    await screen.findByText(/no pudimos leer tus datos de cobro/i);
    expect((screen.getByRole('button', { name: /guardar cambios/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('un refetch fallido DESPUÉS de guardar bien no acusa ni traba el botón', async () => {
    // El propio guardado invalida las dos queries. Si un refetch falla con datos buenos ya
    // cargados, `isError` se enciende igual: avisar ahí sería mentir («esto no es lo que tenés
    // guardado») y, peor, bloquear el guardado ofreciendo «recargá», que borra el trabajo.
    renderPage();
    await screen.findByDisplayValue('Sofía');

    fireEvent.click(screen.getByRole('button', { name: /guardar cambios/i }));
    await waitFor(() => expect(saveAgentConfigMock).toHaveBeenCalledTimes(1));

    getAgentConfigMock.mockRejectedValue(new Error('unavailable')); // el refetch invalidado falla
    await waitFor(() => expect(getAgentConfigMock).toHaveBeenCalledTimes(2));

    expect(screen.queryByText(/no pudimos leer/i)).toBeNull();
    expect((screen.getByRole('button', { name: /guardar cambios/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByDisplayValue('Sofía')).toBeTruthy(); // los datos siguen ahí
  });

  it('NO REGRESIÓN: con las lecturas OK, el botón guarda normalmente', async () => {
    renderPage();
    await screen.findByDisplayValue('Sofía');

    expect((screen.getByRole('button', { name: /guardar cambios/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/no pudimos leer la configuración/i)).toBeNull();
  });
});

describe('H-15 · el estado vacío deja de mentir cuando la lectura falla', () => {
  it('si la auditoría NO se pudo leer, la pantalla no dice «✓ Sin hallazgos»', async () => {
    listOpenAuditsMock.mockRejectedValue(new Error('permission-denied'));
    renderPage();
    await screen.findByDisplayValue('Sofía');

    await waitFor(() => expect(screen.queryByText(/Sin hallazgos/i)).toBeNull());
    // Y lo dice honestamente en vez de callarse.
    expect(await screen.findByText(/no pudimos|no se pudo/i)).toBeTruthy();
  });

  it('NO REGRESIÓN: vacío de verdad ⇒ sigue diciendo «✓ Sin hallazgos.»', async () => {
    listOpenAuditsMock.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText(/✓ Sin hallazgos/)).toBeTruthy();
  });
});
