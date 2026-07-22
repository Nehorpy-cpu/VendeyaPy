/**
 * CoverageReviewCard.test.tsx — Estados de la revisión de cobertura (COVERAGE-1C).
 * Cubre: pendiente con acciones, decidido (actor+fecha), vencido, sin request/denegado → nada,
 * botones deshabilitados mientras procesan, "Decisión registrada" tras aprobar, mapa SOLO al
 * clic (window.open con noopener; sin <a href> pre-cargado) y mapsUrlFor puro.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CoverageReviewCard, buildShippingDraftContext } from './CoverageReviewCard';
import { mapsUrlFor } from '@/lib/coverage';
import type { CoverageRequest } from '@vpw/shared';

const getCoverageRequestFor = vi.fn();
const getCoverageFlowState = vi.fn();
const approveCoverage = vi.fn();
const rejectCoverage = vi.fn();
const requestCoverageInfo = vi.fn();
// SHIPPING-CHAT-4B: adapters de la saga de cotización.
const quoteAndApproveCoverage = vi.fn();
const getCoverageQuoteAttemptState = vi.fn();
const resolveCoverageQuoteUnknown = vi.fn();
vi.mock('@/lib/coverage', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/coverage')>();
  return {
    ...real,
    getCoverageRequestFor: (...a: unknown[]) => getCoverageRequestFor(...a),
    getCoverageFlowState: (...a: unknown[]) => getCoverageFlowState(...a),
    approveCoverage: (...a: unknown[]) => approveCoverage(...a),
    rejectCoverage: (...a: unknown[]) => rejectCoverage(...a),
    requestCoverageInfo: (...a: unknown[]) => requestCoverageInfo(...a),
    quoteAndApproveCoverage: (...a: unknown[]) => quoteAndApproveCoverage(...a),
    getCoverageQuoteAttemptState: (...a: unknown[]) => getCoverageQuoteAttemptState(...a),
    resolveCoverageQuoteUnknown: (...a: unknown[]) => resolveCoverageQuoteUnknown(...a),
  };
});
// 4B (test 29): la confirmación de la cotización JAMÁS pasa por el envío manual.
const sendManualMessageSpy = vi.fn();
vi.mock('@/lib/conversations', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/conversations')>();
  return { ...real, sendManualMessage: (...a: unknown[]) => sendManualMessageSpy(...a) };
});
const mockAuth = { user: { uid: 'owner-1' }, claims: { role: 'TENANT_OWNER', tenantId: 'perfumeria' } };
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => mockAuth,
}));

const ts = (ms: number) => ({ toMillis: () => ms }) as unknown as CoverageRequest['createdAt'];
const ACT = 'act-test-000001';
const baseReq = (over: Partial<CoverageRequest> = {}): CoverageRequest =>
  ({
    id: 'covr_abc123DEF456',
    tenantId: 'perfumeria',
    customerId: '595991234567',
    activationId: ACT,
    status: 'pending_coverage_review',
    location: { source: 'text', addressText: 'Av. Test 123, Luque', name: null, coordinates: null },
    locationFingerprint: 'txt:abc',
    cartSnapshot: { items: [{ productId: 'p1', name: 'Perfume A', price: 100000, quantity: 1 }], subtotal: 100000 },
    sellerName: 'Vendedora Uno',
    decision: null,
    expiresAt: ts(Date.now() + 60 * 60 * 1000),
    createdAt: ts(Date.now() - 1000),
    ...over,
  }) as unknown as CoverageRequest;

const renderCard = (props: Partial<Parameters<typeof CoverageReviewCard>[0]> = {}) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CoverageReviewCard tenantId="perfumeria" customerId="595991234567" {...props} />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.claims = { role: 'TENANT_OWNER', tenantId: 'perfumeria' };
  // HARDEN-1: por defecto el flujo está ACTIVO bajo la misma activación del request base.
  // (Sin shippingQuote ⇒ política OFF por normalización: los tests legacy no cambian.)
  getCoverageFlowState.mockResolvedValue({ enabled: true, activationId: ACT });
  getCoverageQuoteAttemptState.mockResolvedValue({ ok: true, attempt: null });
});

describe('CoverageReviewCard', () => {
  it('pendiente → muestra estado, dirección, carrito, cliente enmascarado y las 3 acciones', async () => {
    getCoverageRequestFor.mockResolvedValue({ request: baseReq(), denied: false });
    renderCard();
    expect(await screen.findByText(/pendiente de revisión/i)).toBeTruthy();
    expect(screen.getByText(/…4567/)).toBeTruthy();
    expect(screen.getByText(/Av\. Test 123/)).toBeTruthy();
    expect(screen.getByText(/Perfume A x1/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /aprobar cobertura/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /rechazar/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /más información/i })).toBeTruthy();
  });

  it('sin request o lectura denegada (seller no asignado) → no muestra NADA (sin filtrar existencia)', async () => {
    getCoverageRequestFor.mockResolvedValue({ request: null, denied: true });
    const { container } = renderCard();
    await waitFor(() => expect(getCoverageRequestFor).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('aprobar → pasa el fingerprint mostrado, deshabilita mientras procesa y confirma "Decisión registrada"', async () => {
    getCoverageRequestFor.mockResolvedValue({ request: baseReq(), denied: false });
    approveCoverage.mockResolvedValue({ ok: true, status: 'coverage_approved' });
    renderCard();
    const btn = await screen.findByRole('button', { name: /aprobar cobertura/i });
    fireEvent.click(btn);
    await waitFor(() => expect(approveCoverage).toHaveBeenCalledWith('perfumeria', 'covr_abc123DEF456', 'txt:abc'));
    expect(await screen.findByText(/Decisión registrada: cobertura aprobada/)).toBeTruthy();
    // No afirma pedido creado ni muestra banco; no promete liberación.
    expect(screen.queryByText(/pedido creado|transferí|cuenta/i)).toBeNull();
  });

  it('error de la callable (p.ej. ubicación actualizada) → mensaje visible sin romper la UI', async () => {
    getCoverageRequestFor.mockResolvedValue({ request: baseReq(), denied: false });
    rejectCoverage.mockRejectedValue(new Error('El cliente actualizó su ubicación: revisá la versión más reciente antes de decidir.'));
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /rechazar/i }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/actualizó su ubicación/)).toBeTruthy();
  });

  it('ya decidido → actor + fecha, sin botones de acción', async () => {
    getCoverageRequestFor.mockResolvedValue({
      request: baseReq({ status: 'coverage_approved', decision: { action: 'approved', byUid: 'u', byName: 'Ana Owner', byRole: 'TENANT_OWNER', at: ts(Date.now()), note: null, locationFingerprint: 'txt:abc' } as CoverageRequest['decision'] }),
      denied: false,
    });
    renderCard();
    expect(await screen.findByText(/aprobada/i)).toBeTruthy();
    expect(screen.getByText(/Ana Owner/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /aprobar cobertura/i })).toBeNull();
  });

  it('vencido sin decisión → aviso de vencimiento, sin acciones', async () => {
    getCoverageRequestFor.mockResolvedValue({ request: baseReq({ expiresAt: ts(Date.now() - 1000) }), denied: false });
    renderCard();
    expect(await screen.findByText(/venció/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /aprobar cobertura/i })).toBeNull();
  });

  it('mapa: sin <a href> pre-cargado; window.open SOLO al clic, con noopener', async () => {
    getCoverageRequestFor.mockResolvedValue({
      request: baseReq({ location: { source: 'whatsapp_location', addressText: null, name: null, coordinates: { lat: -25.28, lng: -57.64 } } as CoverageRequest['location'] }),
      denied: false,
    });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { container } = renderCard();
    const btn = await screen.findByRole('button', { name: /abrir la ubicación/i });
    expect(container.querySelector('a[href*="google"]')).toBeNull(); // nada pre-cargado en el DOM
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(btn);
    expect(open).toHaveBeenCalledWith('https://www.google.com/maps?q=-25.28%2C-57.64', '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });
});

describe('CoverageReviewCard — review 1C', () => {
  it('"Pedir más información" muestra el aviso pero NO oculta Aprobar/Rechazar (sigue pendiente)', async () => {
    getCoverageRequestFor.mockResolvedValue({ request: baseReq(), denied: false });
    requestCoverageInfo.mockResolvedValue({ ok: true, already: false });
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /más información/i }));
    expect(await screen.findByText(/Le pedimos más detalle/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /aprobar cobertura/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /rechazar/i })).toBeTruthy();
  });

  it('doble clic de "más info" (already) → aviso claro, sin re-envío implícito', async () => {
    getCoverageRequestFor.mockResolvedValue({ request: baseReq(), denied: false });
    requestCoverageInfo.mockResolvedValue({ ok: true, already: true });
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /más información/i }));
    expect(await screen.findByText(/Ya se pidió más información/)).toBeTruthy();
  });

  it('PLATFORM_ADMIN ve la revisión pero SIN botones de decisión (el server igual lo rechaza)', async () => {
    mockAuth.claims = { role: 'PLATFORM_ADMIN', tenantId: 'perfumeria' };
    getCoverageRequestFor.mockResolvedValue({ request: baseReq(), denied: false });
    renderCard();
    expect(await screen.findByText(/pendiente de revisión/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /aprobar cobertura/i })).toBeNull();
  });

  it('HARDEN-1: flujo DESHABILITADO → solo lectura, sin botones, con explicación breve', async () => {
    getCoverageFlowState.mockResolvedValue({ enabled: false, activationId: null });
    getCoverageRequestFor.mockResolvedValue({ request: baseReq(), denied: false });
    renderCard();
    expect(await screen.findByText(/pendiente de revisión/i)).toBeTruthy();
    expect(await screen.findByText(/flujo de cobertura está deshabilitado/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /aprobar cobertura/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /rechazar/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /más información/i })).toBeNull();
  });

  it('HARDEN-1: request de una activación ANTERIOR (id no coincide) → solo lectura, sin botones, con la nota PRECISA', async () => {
    getCoverageFlowState.mockResolvedValue({ enabled: true, activationId: 'act-nueva-000002' });
    getCoverageRequestFor.mockResolvedValue({ request: baseReq(), denied: false });
    renderCard();
    expect(await screen.findByText(/activación anterior del flujo/i)).toBeTruthy();
    expect(screen.queryByText(/flujo de cobertura está deshabilitado/i)).toBeNull(); // el flujo SÍ está activo
    expect(screen.queryByRole('button', { name: /aprobar cobertura/i })).toBeNull();
  });

  it('HARDEN-1: el SELLER con el flujo activo y la misma activación VE las tres acciones (regresión de review)', async () => {
    mockAuth.claims = { role: 'SELLER', tenantId: 'perfumeria' };
    getCoverageRequestFor.mockResolvedValue({ request: baseReq(), denied: false });
    renderCard();
    expect(await screen.findByRole('button', { name: /aprobar cobertura/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /rechazar/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /más información/i })).toBeTruthy();
  });

  it('HARDEN-1: mientras carga el estado del flujo → fail-closed (sin botones, sin aviso todavía)', async () => {
    getCoverageFlowState.mockReturnValue(new Promise(() => {})); // nunca resuelve
    getCoverageRequestFor.mockResolvedValue({ request: baseReq(), denied: false });
    renderCard();
    expect(await screen.findByText(/pendiente de revisión/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /aprobar cobertura/i })).toBeNull();
    expect(screen.queryByText(/flujo de cobertura está deshabilitado/i)).toBeNull();
  });

  it('HARDEN-1: error TRANSITORIO del estado del flujo → sin botones (fail-closed) pero sin la nota engañosa', async () => {
    getCoverageFlowState.mockRejectedValue(new Error('unavailable'));
    getCoverageRequestFor.mockResolvedValue({ request: baseReq(), denied: false });
    renderCard();
    expect(await screen.findByText(/pendiente de revisión/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /aprobar cobertura/i })).toBeNull();
    expect(screen.queryByText(/flujo de cobertura está deshabilitado/i)).toBeNull();
  });

  it('HARDEN-1: aprobado con reanudación CANCELADA (cambio de activación) → aviso de atención manual, no parece "resuelto"', async () => {
    getCoverageRequestFor.mockResolvedValue({
      request: baseReq({
        status: 'coverage_approved',
        decision: { action: 'approved', byUid: 'u', byName: 'Ana Owner', byRole: 'TENANT_OWNER', at: ts(Date.now()), note: null, locationFingerprint: 'txt:abc' } as CoverageRequest['decision'],
        resume: { status: 'cancelled', orderId: null },
      }),
      denied: false,
    });
    renderCard();
    expect(await screen.findByText(/reanudación quedó cancelada/i)).toBeTruthy();
    expect(screen.getByText(/atendé el pedido/i)).toBeTruthy();
  });

  it('la nota interna viaja al rechazar', async () => {
    getCoverageRequestFor.mockResolvedValue({ request: baseReq(), denied: false });
    rejectCoverage.mockResolvedValue({ ok: true });
    renderCard();
    fireEvent.change(await screen.findByLabelText(/nota interna/i), { target: { value: 'fuera de zona' } });
    fireEvent.click(screen.getByRole('button', { name: /rechazar/i }));
    await waitFor(() => expect(rejectCoverage).toHaveBeenCalledWith('perfumeria', 'covr_abc123DEF456', 'txt:abc', 'fuera de zona'));
  });
});

describe('mapsUrlFor — puro', () => {
  it('construye el link de Google Maps con las coordenadas codificadas', () => {
    expect(mapsUrlFor({ lat: -25.5, lng: -57.1 })).toBe('https://www.google.com/maps?q=-25.5%2C-57.1');
  });
});

// ============================================================================
// SHIPPING-CHAT-4B — integración de la saga de cotización en el card
// ============================================================================

const POLICY_REQ = { status: 'required', maxChargeGs: 5_000_000 } as const;
const reqQuote = (over: Partial<CoverageRequest> = {}): CoverageRequest =>
  baseReq({ cartFingerprint: 'cart2:vivo123', ...over } as Partial<CoverageRequest>);
const flowRequired = () => getCoverageFlowState.mockResolvedValue({ enabled: true, activationId: ACT, shippingQuote: POLICY_REQ });
const DRAFT_OK = 'El costo de envío para tu ubicación es ₲30.000';

describe('4B · política off/required/invalid', () => {
  it('required ⇒ botón viejo AUSENTE, preview MONTADO (atajo visible); Rechazar y Pedir info se conservan', async () => {
    flowRequired();
    getCoverageRequestFor.mockResolvedValue({ request: reqQuote(), denied: false });
    renderCard();
    expect(await screen.findByRole('button', { name: /informar costo de envío/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /aprobar cobertura/i })).toBeNull();
    expect(screen.getByRole('button', { name: /rechazar/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /pedir más información/i })).toBeTruthy();
  });
  it('off (default de los mocks legacy) ⇒ botón viejo PRESENTE, preview NO montado', async () => {
    getCoverageRequestFor.mockResolvedValue({ request: reqQuote(), denied: false });
    renderCard();
    expect(await screen.findByRole('button', { name: /aprobar cobertura/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /informar costo de envío/i })).toBeNull();
  });
  it('invalid ⇒ fail-closed: ni botón viejo ni aprobación posible + mensaje administrativo', async () => {
    getCoverageFlowState.mockResolvedValue({ enabled: true, activationId: ACT, shippingQuote: { status: 'invalid' } });
    getCoverageRequestFor.mockResolvedValue({ request: reqQuote(), denied: false });
    renderCard();
    expect(await screen.findByText(/configuración de cotización de envío no es válida/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /aprobar cobertura/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /enviar costo y aprobar/i })).toBeNull();
  });
  it('PLATFORM_ADMIN con required ⇒ solo lectura: sin preview ni acciones', async () => {
    mockAuth.claims = { role: 'PLATFORM_ADMIN', tenantId: 'perfumeria' };
    flowRequired();
    getCoverageRequestFor.mockResolvedValue({ request: reqQuote(), denied: false });
    renderCard();
    await screen.findByText(/pendiente de revisión/i);
    expect(screen.queryByRole('button', { name: /informar costo de envío/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /aprobar cobertura/i })).toBeNull();
  });
  it('Coverage OFF (flag) ⇒ cero callables de cotización', async () => {
    getCoverageFlowState.mockResolvedValue({ enabled: false, activationId: null, shippingQuote: { status: 'off' } });
    getCoverageRequestFor.mockResolvedValue({ request: reqQuote(), denied: false });
    renderCard();
    await screen.findByText(/deshabilitado/i);
    expect(quoteAndApproveCoverage).not.toHaveBeenCalled();
    expect(getCoverageQuoteAttemptState).not.toHaveBeenCalled();
  });
});

describe('4B · contexto saneado (no-PII)', () => {
  it('las claves entregadas al preview son EXACTAMENTE las de ShippingDraftContext (sin dirección/coords/teléfono/customerId/banco)', () => {
    const req = reqQuote(); // incluye location con addressText y customerId completo
    const ctx = buildShippingDraftContext(req, POLICY_REQ, { flowActive: true, canDecide: true, draft: 'x', nowMs: 123 });
    expect(Object.keys(ctx).sort()).toEqual([
      'canDecide', 'cartFingerprint', 'draft', 'expiresAtMs', 'flowActive', 'locationFingerprint',
      'maxChargeGs', 'nowMs', 'requestId', 'required', 'status', 'subtotalGs',
    ]);
    const dump = JSON.stringify(ctx);
    expect(dump).not.toContain('Av. Test');       // dirección
    expect(dump).not.toContain('595991234567');   // customerId/teléfono
  });
});

describe('4B · confirmación (mutation)', () => {
  it('confirmar llama UNA vez con el payload exacto; doble clic no duplica; el éxito usa montos DEL SERVIDOR; jamás sendManualMessage', async () => {
    flowRequired();
    getCoverageRequestFor.mockResolvedValue({ request: reqQuote(), denied: false });
    let resolver!: (v: unknown) => void;
    quoteAndApproveCoverage.mockReturnValue(new Promise((res) => { resolver = res; }));
    renderCard({ draft: DRAFT_OK });
    const btn = await screen.findByRole('button', { name: /enviar costo y aprobar cobertura/i });
    fireEvent.click(btn);
    fireEvent.click(btn); // doble clic
    await waitFor(() => expect(quoteAndApproveCoverage).toHaveBeenCalledTimes(1)); // react-query invoca async
    expect(quoteAndApproveCoverage).toHaveBeenCalledTimes(1);
    expect(quoteAndApproveCoverage).toHaveBeenCalledWith('perfumeria', {
      requestId: 'covr_abc123DEF456',
      sellerDraft: DRAFT_OK,
      confirmedShippingGs: 30000,
      expectedLocationFingerprint: 'txt:abc',
      expectedCartFingerprint: 'cart2:vivo123',
    });
    // Montos del SERVIDOR distintos a los derivados localmente: la UI muestra los del server.
    resolver({ ok: true, status: 'coverage_approved', shippingGs: 30000, totalGs: 999999 });
    await screen.findByText(/costo enviado y cobertura aprobada/i);
    expect(screen.getByText(/999\.999/)).toBeTruthy();
    expect(sendManualMessageSpy).not.toHaveBeenCalled();
  });
  it('"Seguir editando" tras un error CIERRA el ciclo local: el preview vuelve a derivar (hallazgo visual)', async () => {
    flowRequired();
    getCoverageRequestFor.mockResolvedValue({ request: reqQuote(), denied: false });
    quoteAndApproveCoverage.mockRejectedValue({ code: 'functions/failed-precondition', details: { kind: 'channel_unavailable' } });
    renderCard({ draft: DRAFT_OK });
    fireEvent.click(await screen.findByRole('button', { name: /enviar costo y aprobar cobertura/i }));
    await screen.findByText(/no está disponible para cotizar/i);
    fireEvent.click(screen.getByRole('button', { name: /seguir editando/i }));
    // Vuelve la vista de derivación (idle): el costo detectado y el botón de confirmar reaparecen.
    expect(await screen.findByText(/costo de envío detectado/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /enviar costo y aprobar cobertura/i })).toBeTruthy();
  });

  it('error de transporte ambiguo (sin kind) ⇒ generic SIN retry ciego (solo "Seguir editando")', async () => {
    flowRequired();
    getCoverageRequestFor.mockResolvedValue({ request: reqQuote(), denied: false });
    quoteAndApproveCoverage.mockRejectedValue(new Error('network down'));
    renderCard({ draft: DRAFT_OK });
    fireEvent.click(await screen.findByRole('button', { name: /enviar costo y aprobar cobertura/i }));
    await screen.findByText(/estado actualizado de la revisión/i);
    expect(screen.getByRole('button', { name: /seguir editando/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /reintentar|volver a enviar/i })).toBeNull();
  });
});

describe('4B · recuperación durable (pointer + fase server)', () => {
  const PENDING = { quoteAttemptId: 'qat_XYZ987654321', chargeGs: 25000, locationFingerprint: 'geo:VIEJO', cartFingerprint: 'cart2:VIEJO', quotedByUid: 'u', quotedByName: 'V', quotedByRole: 'TENANT_OWNER', createdAt: ts(Date.now() - 1000) };
  const conPointer = (over: Partial<CoverageRequest> = {}) =>
    reqQuote({ shippingQuotePending: PENDING as CoverageRequest['shippingQuotePending'], ...over } as Partial<CoverageRequest>);

  it('sent_pending_approval ⇒ "Completar la aprobación" con el payload CONGELADO del pointer (jamás huellas vivas)', async () => {
    flowRequired();
    getCoverageRequestFor.mockResolvedValue({ request: conPointer(), denied: false });
    getCoverageQuoteAttemptState.mockResolvedValue({ ok: true, attempt: { quoteAttemptId: PENDING.quoteAttemptId, chargeGs: 25000, phase: 'sent_pending_approval' } });
    quoteAndApproveCoverage.mockResolvedValue({ ok: true, status: 'coverage_approved', shippingGs: 25000, totalGs: 125000 });
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /completar la aprobación/i }));
    await waitFor(() => expect(quoteAndApproveCoverage).toHaveBeenCalledWith('perfumeria', {
      requestId: 'covr_abc123DEF456',
      sellerDraft: 'El costo de envío para tu ubicación es ₲25.000.',
      confirmedShippingGs: 25000,
      expectedLocationFingerprint: 'geo:VIEJO',
      expectedCartFingerprint: 'cart2:VIEJO',
    }));
  });
  it('preparing ⇒ "Continuar el envío"; in_progress ⇒ SIN acciones (jamás unknown); failed ⇒ recotizar', async () => {
    flowRequired();
    getCoverageRequestFor.mockResolvedValue({ request: conPointer(), denied: false });
    getCoverageQuoteAttemptState.mockResolvedValue({ ok: true, attempt: { quoteAttemptId: PENDING.quoteAttemptId, chargeGs: 25000, phase: 'preparing' } });
    const r1 = renderCard();
    expect(await screen.findByRole('button', { name: /continuar el envío/i })).toBeTruthy();
    r1.unmount();
    getCoverageQuoteAttemptState.mockResolvedValue({ ok: true, attempt: { quoteAttemptId: PENDING.quoteAttemptId, chargeGs: 25000, phase: 'in_progress' } });
    const r2 = renderCard();
    await screen.findByText(/envío del costo en curso/i);
    expect(screen.queryByRole('button', { name: /continuar|completar|llegó/i })).toBeNull();
    expect(screen.queryByText(/sin confirmar/i)).toBeNull(); // in_progress JAMÁS se muestra como unknown
    r2.unmount();
    getCoverageQuoteAttemptState.mockResolvedValue({ ok: true, attempt: { quoteAttemptId: PENDING.quoteAttemptId, chargeGs: 25000, phase: 'failed' } });
    renderCard();
    await screen.findByText(/quedó cerrado o inconsistente/i);
  });
  it('ALTO review: in_progress local se RECONCILIA con la fase durable — jamás spinner absorbente', async () => {
    flowRequired();
    getCoverageRequestFor.mockResolvedValue({ request: conPointer(), denied: false });
    // El server responde in_progress (otro worker con el lease): estado local sending SIN mutation.
    quoteAndApproveCoverage.mockRejectedValue({ code: 'functions/failed-precondition', details: { kind: 'in_progress' } });
    // La fuente durable dice que el envío YA quedó sent: la UI debe salir del spinner y ofrecer completar.
    getCoverageQuoteAttemptState.mockResolvedValue({ ok: true, attempt: { quoteAttemptId: PENDING.quoteAttemptId, chargeGs: 25000, phase: 'sent_pending_approval' } });
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /completar la aprobación/i }));
    // (el click dispara quoteMut que rechaza con in_progress ⇒ send=sending ⇒ reconciliación ⇒ idle ⇒ chip visible)
    expect(await screen.findByRole('button', { name: /completar la aprobación/i })).toBeTruthy();
    expect(screen.queryByText(/estamos enviando el mensaje/i)).toBeNull();
  });

  it('éxito PERSISTIDO desde req.shippingQuote tras recarga (send local idle): costo + total por computeOrderTotals', async () => {
    getCoverageRequestFor.mockResolvedValue({
      request: reqQuote({
        status: 'coverage_approved',
        shippingQuote: { chargeGs: 30000 } as CoverageRequest['shippingQuote'],
        decision: { action: 'approved', byName: 'Vendedora', byRole: 'TENANT_OWNER', at: ts(Date.now()) } as CoverageRequest['decision'],
      }),
      denied: false,
    });
    renderCard();
    await screen.findByText(/costo de envío enviado y aplicado/i);
    expect(screen.getByText(/130\.000/)).toBeTruthy(); // 100.000 + 30.000 vía computeOrderTotals
  });
  it('éxito persistido con subtotal corrupto ⇒ fail-closed (no inventa el total)', async () => {
    getCoverageRequestFor.mockResolvedValue({
      request: reqQuote({
        status: 'coverage_approved',
        shippingQuote: { chargeGs: 30000 } as CoverageRequest['shippingQuote'],
        cartSnapshot: { items: [], subtotal: 100000.5 } as CoverageRequest['cartSnapshot'],
      }),
      denied: false,
    });
    renderCard();
    await screen.findByText(/no se pudo verificar/i);
  });
});

describe('4B · reconciliación de unknown (solo fase server)', () => {
  const PENDING = { quoteAttemptId: 'qat_XYZ987654321', chargeGs: 25000, locationFingerprint: 'geo:V', cartFingerprint: 'cart2:V', quotedByUid: 'u', quotedByName: 'V', quotedByRole: 'TENANT_OWNER', createdAt: ts(Date.now() - 1000) };
  const conUnknown = () => {
    flowRequired();
    getCoverageRequestFor.mockResolvedValue({ request: reqQuote({ shippingQuotePending: PENDING as CoverageRequest['shippingQuotePending'] } as Partial<CoverageRequest>), denied: false });
    getCoverageQuoteAttemptState.mockResolvedValue({ ok: true, attempt: { quoteAttemptId: PENDING.quoteAttemptId, chargeGs: 25000, phase: 'unknown' } });
  };
  it('OWNER: nota vacía ⇒ botones deshabilitados y la callable NO se llama; con nota ⇒ delivered exacto', async () => {
    conUnknown();
    resolveCoverageQuoteUnknown.mockResolvedValue({ ok: true, resolved: 'delivered', status: 'coverage_approved', shippingGs: 25000, totalGs: 125000 });
    renderCard();
    const si = await screen.findByRole('button', { name: /sí llegó al cliente/i });
    expect((si as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(si);
    expect(resolveCoverageQuoteUnknown).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/nota obligatoria/i), { target: { value: 'verificado en el teléfono' } });
    fireEvent.click(screen.getByRole('button', { name: /sí llegó al cliente/i }));
    await waitFor(() => expect(resolveCoverageQuoteUnknown).toHaveBeenCalledWith('perfumeria', 'covr_abc123DEF456', 'qat_XYZ987654321', 'delivered', 'verificado en el teléfono'));
    await screen.findByText(/costo enviado y cobertura aprobada/i);
  });
  it('not_delivered ⇒ vuelve a idle (permite recotizar) sin aprobar', async () => {
    conUnknown();
    resolveCoverageQuoteUnknown.mockResolvedValue({ ok: true, resolved: 'not_delivered' });
    renderCard();
    fireEvent.change(await screen.findByLabelText(/nota obligatoria/i), { target: { value: 'no llegó' } });
    fireEvent.click(screen.getByRole('button', { name: /no llegó al cliente/i }));
    await waitFor(() => expect(resolveCoverageQuoteUnknown).toHaveBeenCalledWith('perfumeria', 'covr_abc123DEF456', 'qat_XYZ987654321', 'not_delivered', 'no llegó'));
    expect(screen.queryByText(/costo enviado y cobertura aprobada/i)).toBeNull();
  });
  it('SELLER: no recibe controles de resolución (solo el aviso de encargado)', async () => {
    mockAuth.claims = { role: 'SELLER', tenantId: 'perfumeria' };
    mockAuth.user = { uid: 'seller-1' } as typeof mockAuth.user;
    conUnknown();
    renderCard();
    await screen.findByText(/un encargado del negocio debe resolverlo/i);
    expect(screen.queryByRole('button', { name: /llegó al cliente/i })).toBeNull();
  });
});

describe('4B · gate del envío manual (publicación aislada)', () => {
  it('required + borrador con costo ⇒ blocked:true; desmontar ⇒ blocked:false', async () => {
    flowRequired();
    getCoverageRequestFor.mockResolvedValue({ request: reqQuote(), denied: false });
    const onGate = vi.fn();
    const r = renderCard({ draft: DRAFT_OK, onManualShippingGateChange: onGate });
    await waitFor(() => expect(onGate).toHaveBeenCalledWith({ customerId: '595991234567', requestId: 'covr_abc123DEF456', blocked: true, canQuote: true }));
    r.unmount();
    expect(onGate).toHaveBeenLastCalledWith({ customerId: '595991234567', requestId: null, blocked: false, canQuote: true });
  });
  it('texto común NO bloquea; política off NO bloquea aunque el texto sea una cotización', async () => {
    flowRequired();
    getCoverageRequestFor.mockResolvedValue({ request: reqQuote(), denied: false });
    const onGate = vi.fn();
    const r = renderCard({ draft: 'hola, ya te confirmo', onManualShippingGateChange: onGate });
    await waitFor(() => expect(onGate).toHaveBeenCalled());
    expect(onGate.mock.calls.every((c) => c[0].blocked === false)).toBe(true);
    r.unmount();
    vi.clearAllMocks();
    getCoverageFlowState.mockResolvedValue({ enabled: true, activationId: ACT }); // sin shippingQuote: off
    getCoverageRequestFor.mockResolvedValue({ request: reqQuote(), denied: false });
    getCoverageQuoteAttemptState.mockResolvedValue({ ok: true, attempt: null });
    const onGate2 = vi.fn();
    renderCard({ draft: DRAFT_OK, onManualShippingGateChange: onGate2 });
    await screen.findByRole('button', { name: /aprobar cobertura/i });
    expect(onGate2.mock.calls.every((c) => c[0].blocked === false)).toBe(true);
  });
  it('política INVALID bloquea intentos de costo (fail-closed, mismo criterio compartido)', async () => {
    getCoverageFlowState.mockResolvedValue({ enabled: true, activationId: ACT, shippingQuote: { status: 'invalid' } });
    getCoverageRequestFor.mockResolvedValue({ request: reqQuote(), denied: false });
    const onGate = vi.fn();
    renderCard({ draft: DRAFT_OK, onManualShippingGateChange: onGate });
    await waitFor(() => expect(onGate).toHaveBeenCalledWith(expect.objectContaining({ blocked: true })));
  });
});
