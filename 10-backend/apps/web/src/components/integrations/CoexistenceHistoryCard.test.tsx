/**
 * CoexistenceHistoryCard — el flujo HUMANO del historial, por fin operable (correctivo ADR-0017).
 * =============================================================================================
 * Los tres callables del historial (`decide` / `request` / `status`) existían en Functions y NO
 * tenían ni un solo consumidor en el panel: el owner no podía decidir compartir o no, ni disparar
 * la sincronización, ni ver en qué estado estaba. La ventana de 24 h y el disparo de un solo uso
 * quedaban gobernados por... nada visible.
 *
 * Este test afirma el contrato de la tarjeta:
 *  · sin decisión ⇒ las DOS opciones explícitas (compartir / no compartir), cada una con su
 *    confirmación, y el texto que explica la ventana limitada y que el disparo no se repite;
 *  · decidido `share` ⇒ el disparo aparece SOLO en `pending_request`, con confirmación fuerte;
 *  · `receiving` ⇒ progreso visible y CERO botón de disparo (no hay reintento ciego);
 *  · desenlaces terminales legibles (incluido «el negocio no compartió», código 2593109);
 *  · sin permiso de operar ⇒ solo lectura;
 *  · el estado vive en una región `aria-live` para lectores de pantalla.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/integrations', () => ({
  coexistenceSyncStatus: vi.fn(),
  coexistenceDecideHistorySharing: vi.fn(),
  coexistenceRequestHistorySync: vi.fn(),
}));

import {
  coexistenceSyncStatus,
  coexistenceDecideHistorySharing,
  coexistenceRequestHistorySync,
  type CoexistenceSyncStatus,
} from '@/lib/integrations';
import { CoexistenceHistoryCard } from './CoexistenceHistoryCard';

const T = 'tnt_hist';
const PNID = '555111222333';
const status = vi.mocked(coexistenceSyncStatus);
const decide = vi.mocked(coexistenceDecideHistorySharing);
const request = vi.mocked(coexistenceRequestHistorySync);

function montar(props: Partial<Parameters<typeof CoexistenceHistoryCard>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CoexistenceHistoryCard tenantId={T} phoneNumberId={PNID} canOperate {...props} />
    </QueryClientProvider>,
  );
}

const estado = (over: Partial<CoexistenceSyncStatus>): CoexistenceSyncStatus => ({ ok: true, exists: true, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  decide.mockResolvedValue({ ok: true, status: 'pending_request', deadlineAtMs: Date.now() + 3_600_000 });
  request.mockResolvedValue({ ok: true, syncTypes: ['smb_app_state_sync', 'history'] });
});

describe('sin decisión — las dos opciones explícitas', () => {
  it('ofrece compartir y no compartir, y explica que la ventana es limitada y el disparo único', async () => {
    status.mockResolvedValue({ ok: true, exists: false });
    montar();

    expect(await screen.findByRole('button', { name: /compartir historial/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /no compartir/i })).toBeTruthy();
    expect(screen.getByText(/24\s*h/i)).toBeTruthy();
    expect(screen.getByText(/una sola vez/i)).toBeTruthy();
  });

  it('«no compartir» exige confirmación y recién ahí llama al callable con `skip`', async () => {
    status.mockResolvedValue({ ok: true, exists: false });
    montar();

    fireEvent.click(await screen.findByRole('button', { name: /no compartir/i }));
    expect(decide).not.toHaveBeenCalled(); // la decisión es sensible: sin confirmar no viaja nada
    fireEvent.click(screen.getByRole('button', { name: /confirmar/i }));

    await waitFor(() => expect(decide).toHaveBeenCalledWith(T, PNID, 'skip'));
  });

  it('«compartir» confirmado llama con `share`', async () => {
    status.mockResolvedValue({ ok: true, exists: false });
    montar();

    fireEvent.click(await screen.findByRole('button', { name: /compartir historial/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirmar/i }));

    await waitFor(() => expect(decide).toHaveBeenCalledWith(T, PNID, 'share'));
  });
});

describe('decidido `share` — el disparo único', () => {
  it('en `pending_request` ofrece el disparo con confirmación fuerte y lo llama UNA vez', async () => {
    status.mockResolvedValue(estado({ status: 'pending_request', sharingDecision: 'share', deadlineAtMs: Date.now() + 3_600_000 }));
    montar();

    fireEvent.click(await screen.findByRole('button', { name: /traer el historial/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirmar/i }));

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledWith(T, PNID);
  });

  it('en `receiving` muestra el progreso y NO ofrece volver a disparar', async () => {
    status.mockResolvedValue(estado({ status: 'receiving', sharingDecision: 'share', progress: 40, chunks: 12 }));
    montar();

    expect(await screen.findByText(/40/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /traer el historial/i })).toBeNull();
  });
});

describe('desenlaces terminales — legibles y sin botones', () => {
  it('`declined` por el negocio (2593109) lo dice en castellano', async () => {
    status.mockResolvedValue(estado({ status: 'declined', sharingDecision: 'share', declineCode: 2593109 }));
    montar();

    expect(await screen.findByText(/no compartió/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /traer el historial/i })).toBeNull();
  });

  it('`expired` explica que la ventana se venció y cómo se recupera', async () => {
    status.mockResolvedValue(estado({ status: 'expired', sharingDecision: 'share' }));
    montar();

    // La explicación completa, no solo el badge: tiene que decir el desenlace Y la única
    // recuperación real (desconectar desde la app y volver a conectar).
    expect(await screen.findByText(/se venció sin traer el historial/i)).toBeTruthy();
    expect(screen.getByText(/volver a conectarlo/i)).toBeTruthy();
  });
});

describe('permisos y accesibilidad', () => {
  it('sin permiso de operar: estado visible, cero botones de acción', async () => {
    status.mockResolvedValue({ ok: true, exists: false });
    montar({ canOperate: false });

    await waitFor(() => expect(status).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /compartir historial/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /no compartir/i })).toBeNull();
  });

  it('el estado vive en una región aria-live', async () => {
    status.mockResolvedValue(estado({ status: 'receiving', sharingDecision: 'share', progress: 10 }));
    const { container } = montar();

    await screen.findByText(/10/);
    expect(container.querySelector('[aria-live]')).toBeTruthy();
  });
});
