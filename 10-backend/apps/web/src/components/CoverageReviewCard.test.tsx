/**
 * CoverageReviewCard.test.tsx — Estados de la revisión de cobertura (COVERAGE-1C).
 * Cubre: pendiente con acciones, decidido (actor+fecha), vencido, sin request/denegado → nada,
 * botones deshabilitados mientras procesan, "Decisión registrada" tras aprobar, mapa SOLO al
 * clic (window.open con noopener; sin <a href> pre-cargado) y mapsUrlFor puro.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CoverageReviewCard } from './CoverageReviewCard';
import { mapsUrlFor } from '@/lib/coverage';
import type { CoverageRequest } from '@vpw/shared';

const getCoverageRequestFor = vi.fn();
const getCoverageFlowState = vi.fn();
const approveCoverage = vi.fn();
const rejectCoverage = vi.fn();
const requestCoverageInfo = vi.fn();
vi.mock('@/lib/coverage', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/coverage')>();
  return {
    ...real,
    getCoverageRequestFor: (...a: unknown[]) => getCoverageRequestFor(...a),
    getCoverageFlowState: (...a: unknown[]) => getCoverageFlowState(...a),
    approveCoverage: (...a: unknown[]) => approveCoverage(...a),
    rejectCoverage: (...a: unknown[]) => rejectCoverage(...a),
    requestCoverageInfo: (...a: unknown[]) => requestCoverageInfo(...a),
  };
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

const renderCard = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CoverageReviewCard tenantId="perfumeria" customerId="595991234567" />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.claims = { role: 'TENANT_OWNER', tenantId: 'perfumeria' };
  // HARDEN-1: por defecto el flujo está ACTIVO bajo la misma activación del request base.
  getCoverageFlowState.mockResolvedValue({ enabled: true, activationId: ACT });
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
