/**
 * OrderReceipts — comprobantes del pedido en el panel de Pedidos (ADR-0016 · Área C).
 *
 * Lo que se fija acá:
 *  - un comprobante VINCULADO se ve en el pedido (antes era invisible: la tarjeta estaba gateada
 *    por `payment.comprobanteUrl` y el flujo nuevo escribe en `receiptAttachments`);
 *  - un CANDIDATO se distingue del vinculado y dice explícitamente que nadie confirmó nada;
 *  - los cuatro estados: cargando, vacío, error con reintento y éxito;
 *  - el visor abre por `attachmentId` y es accesible (diálogo modal, Escape, foco);
 *  - el DOM no contiene NUNCA una ruta de Storage ni una URL firmada.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Attachment, Order } from '@vpw/shared';
import type { PanelAttachment } from '@/lib/attachments';
import { OrderReceipts } from './OrderReceipts';

const listAttachmentsByIdsMock = vi.fn();
vi.mock('@/lib/orderReceipts', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/orderReceipts')>();
  return { ...real, listAttachmentsByIds: (...a: unknown[]) => listAttachmentsByIdsMock(...a) };
});

const getAttachmentViewUrlMock = vi.fn();
vi.mock('@/lib/attachments', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/attachments')>();
  return { ...real, getAttachmentViewUrl: (...a: unknown[]) => getAttachmentViewUrlMock(...a) };
});

const URL_FIRMADA = 'https://storage.googleapis.example/firmada?token=SECRETO123';
const PATH_STORAGE = 'tenants/tnt_1/attachments/11/att_secreto';
const A1 = 'att_' + '1'.repeat(24);
const A2 = 'att_' + '2'.repeat(24);
const CLIENTE = '595981000000';

const ts = (ms: number) => ({ toDate: () => new Date(ms), toMillis: () => ms }) as unknown as Attachment['createdAt'];

function adj(over: Partial<PanelAttachment> = {}): PanelAttachment {
  return {
    attachmentId: A1,
    customerId: CLIENTE,
    class: 'image',
    ingestState: 'stored',
    classification: { value: 'payment_receipt_linked', source: 'human', confidence: 1, by: 'uid_1', at: ts(2) },
    caption: '',
    filename: null,
    mime: { verified: 'image/jpeg' },
    bytes: 2048,
    orderCandidateId: 'ord_1',
    createdAt: ts(1),
    lastError: null,
    ...over,
  };
}

const orden = (over: Record<string, unknown> = {}): Order =>
  ({
    id: 'ord_1',
    tenantId: 'tnt_1',
    customerId: CLIENTE,
    status: 'PENDING_VERIFICATION',
    items: [],
    totals: { subtotal: 0, discount: 0, total: 0, currency: 'PYG' },
    payment: { method: 'transfer', paymentId: 'pay_1', paidAt: null, comprobanteUrl: null },
    ...over,
  }) as unknown as Order;

const conVinculado = orden({ receiptAttachments: { linkedIds: [A1], candidateIds: [A1], statusDrivenBy: A1 } });
const conCandidato = orden({ status: 'PENDING_PAYMENT', receiptAttachments: { candidateIds: [A2] } });

function montar(order: Order) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OrderReceipts tenantId="tnt_1" order={order} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listAttachmentsByIdsMock.mockReset();
  listAttachmentsByIdsMock.mockResolvedValue({ items: [adj()], missingIds: [] });
  getAttachmentViewUrlMock.mockReset();
  getAttachmentViewUrlMock.mockResolvedValue({ url: URL_FIRMADA, expiresAt: Date.now() + 300000 });
});

describe('OrderReceipts — comprobante nuevo (adjunto)', () => {
  it('muestra el comprobante VINCULADO del pedido y lo abre por attachmentId', async () => {
    montar(conVinculado);
    expect(await screen.findByText(/comprobante vinculado/i)).toBeInTheDocument();
    expect(listAttachmentsByIdsMock).toHaveBeenCalledWith('tnt_1', [A1]);
    expect(screen.getByText(/es el que puso el pedido en verificación/i)).toBeInTheDocument();
    expect(screen.getByText(/JPG · 2 KB/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /ver comprobante/i }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(getAttachmentViewUrlMock).toHaveBeenCalledWith('tnt_1', A1);
    await screen.findByAltText(/imagen enviada por el cliente/i);
  });

  it('Escape cierra el visor y el foco vuelve al botón que lo abrió', async () => {
    montar(conVinculado);
    const boton = await screen.findByRole('button', { name: /ver comprobante/i });
    boton.focus();
    fireEvent.click(boton);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(boton);
  });

  it('un adjunto que todavía no está guardado no ofrece botón de ver', async () => {
    listAttachmentsByIdsMock.mockResolvedValue({ items: [adj({ ingestState: 'downloading' })], missingIds: [] });
    montar(conVinculado);
    expect(await screen.findByText(/recibiendo este archivo/i)).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('button', { name: /ver comprobante/i })).not.toBeInTheDocument();
  });

  it('un adjunto rechazado dice qué pedirle al cliente en vez de desaparecer', async () => {
    listAttachmentsByIdsMock.mockResolvedValue({
      items: [adj({ ingestState: 'rejected', lastError: 'formato no permitido' })],
      missingIds: [],
    });
    montar(conVinculado);
    expect(await screen.findByRole('alert')).toHaveTextContent(/reenv/i);
    expect(screen.queryByRole('button', { name: /ver comprobante/i })).not.toBeInTheDocument();
  });
});

describe('OrderReceipts — candidato vs vinculado', () => {
  it('el candidato se distingue del vinculado y dice que nadie confirmó nada', async () => {
    listAttachmentsByIdsMock.mockResolvedValue({
      items: [adj({ attachmentId: A2, classification: { value: 'payment_receipt_candidate', source: 'rule', confidence: 1, by: null, at: ts(2) } })],
      missingIds: [],
    });
    montar(conCandidato);
    expect(await screen.findByText(/posible comprobante/i)).toBeInTheDocument();
    expect(screen.queryByText(/comprobante vinculado/i)).not.toBeInTheDocument();
    expect(screen.getByText(/sigue esperando el pago y nadie confirmó nada/i)).toBeInTheDocument();
    expect(screen.getByText(/la puso una regla automática del sistema/i)).toBeInTheDocument();
  });

  it('con los dos en el mismo pedido, cada uno lleva su propia etiqueta', async () => {
    listAttachmentsByIdsMock.mockResolvedValue({
      items: [
        adj(),
        adj({ attachmentId: A2, classification: { value: 'payment_receipt_candidate', source: 'rule', confidence: 1, by: null, at: ts(3) } }),
      ],
      missingIds: [],
    });
    montar(orden({ receiptAttachments: { linkedIds: [A1], candidateIds: [A1, A2], statusDrivenBy: A1 } }));
    expect(await screen.findByText(/comprobante vinculado/i)).toBeInTheDocument();
    expect(screen.getByText(/posible comprobante/i)).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('OrderReceipts — estados', () => {
  it('cargando: esqueleto con aviso legible', () => {
    listAttachmentsByIdsMock.mockReturnValue(new Promise(() => {})); // nunca resuelve
    montar(conVinculado);
    expect(screen.getByRole('status')).toHaveTextContent(/cargando los comprobantes/i);
  });

  it('vacío: pedido esperando pago y sin comprobantes, sin leer nada', () => {
    montar(orden({ status: 'PENDING_PAYMENT' }));
    expect(screen.getByText(/todavía no llegó ningún comprobante/i)).toBeInTheDocument();
    expect(listAttachmentsByIdsMock).not.toHaveBeenCalled();
  });

  it('vacío: no contradice a la tarjeta del comprobante legacy', () => {
    const { container } = montar(
      orden({
        status: 'PENDING_VERIFICATION',
        payment: { method: 'transfer', paymentId: 'p', paidAt: null, comprobanteUrl: 'tenants/tnt_1/orders/ord_1/comprobantes/foto.jpg' },
      }),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('error: motivo accionable + reintento que vuelve a LEER', async () => {
    listAttachmentsByIdsMock.mockRejectedValueOnce({ code: 'permission-denied', message: `no leer tenants/tnt_1/attachments/${A1}` });
    listAttachmentsByIdsMock.mockResolvedValueOnce({ items: [adj()], missingIds: [] });
    montar(conVinculado);
    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent(/permiso/i);
    expect(alerta.textContent ?? '').not.toContain('tenants/');

    fireEvent.click(screen.getByRole('button', { name: /reintentar/i }));
    expect(await screen.findByText(/comprobante vinculado/i)).toBeInTheDocument();
    expect(listAttachmentsByIdsMock).toHaveBeenCalledTimes(2);
  });

  it('archivo referenciado que ya no está: se explica, no se rompe la pantalla', async () => {
    listAttachmentsByIdsMock.mockResolvedValue({ items: [], missingIds: [A1] });
    montar(conVinculado);
    expect(await screen.findByText(/no pudimos abrir/i)).toHaveTextContent(/retención|permiso/i);
  });

  it('adjunto de OTRO cliente referenciado por el pedido: no se muestra y se avisa', async () => {
    listAttachmentsByIdsMock.mockResolvedValue({
      items: [adj({ customerId: '595990999999' })],
      missingIds: [],
    });
    montar(conVinculado);
    expect(await screen.findByRole('alert')).toHaveTextContent(/no pertenece al cliente de este pedido/i);
    expect(screen.queryByRole('button', { name: /ver comprobante/i })).not.toBeInTheDocument();
  });
});

describe('OrderReceipts — la pantalla no filtra rutas ni URLs firmadas', () => {
  it('ni con el visor abierto aparece una ruta de Storage o la URL firmada como texto', async () => {
    listAttachmentsByIdsMock.mockResolvedValue({
      items: [adj({ caption: 'ya te pagué', filename: 'comprobante.jpg' })],
      missingIds: [],
    });
    montar(conVinculado);
    fireEvent.click(await screen.findByRole('button', { name: /ver comprobante/i }));
    await screen.findByAltText(/imagen enviada por el cliente: ya te pagué/i);

    expect(document.body.innerHTML).not.toContain(PATH_STORAGE);
    expect(document.body.innerHTML).not.toContain('tenants/');
    expect(document.body.textContent ?? '').not.toContain(URL_FIRMADA);
    for (const a of Array.from(document.querySelectorAll('a'))) {
      expect(a.getAttribute('href') ?? '').not.toContain('firmada');
    }
  });
});
