/**
 * Pedidos — el comprobante se ve DONDE se decide el pago (ADR-0016 §3, §5 y §7 · Área C).
 *
 * El defecto que fija este archivo: la tarjeta "🧾 Comprobante recibido" estaba gateada por
 * `payment.comprobanteUrl`, así que un comprobante marcado desde Conversaciones —que se escribe
 * como adjunto— era INVISIBLE en el pedido. Acá se prueba que:
 *   · un comprobante nuevo (adjunto) aparece en el detalle del pedido;
 *   · el comprobante LEGACY sigue abriendo exactamente como antes (§7: no se rompe historia);
 *   · un pedido sin comprobantes no inventa una tarjeta;
 *   · el DOM del detalle no contiene rutas de Storage ni URLs firmadas.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Attachment, Order } from '@vpw/shared';
import type { PanelAttachment } from '@/lib/attachments';
import OrdersPage from './page';

const listOrdersMock = vi.fn();
const listOrderFinancialsMock = vi.fn();
const getComprobanteViewUrlMock = vi.fn();
vi.mock('@/lib/orders', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/orders')>();
  return {
    ...real,
    listOrders: (...a: unknown[]) => listOrdersMock(...a),
    listOrderFinancials: (...a: unknown[]) => listOrderFinancialsMock(...a),
    getComprobanteViewUrl: (...a: unknown[]) => getComprobanteViewUrlMock(...a),
  };
});

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

vi.mock('@/lib/active-company', () => ({
  useActiveCompany: () => ({
    tenantId: 'tnt_1',
    companyName: 'Empresa',
    companies: [],
    isSuperAdmin: false,
    loading: false,
    setTenantId: () => {},
  }),
}));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({
    user: { uid: 'owner-1' },
    claims: { role: 'TENANT_OWNER', tenantId: 'tnt_1' },
    loading: false,
    signOut: async () => {},
  }),
}));

const A1 = 'att_' + '1'.repeat(24);
const CLIENTE = '595981000000';
const URL_FIRMADA = 'https://storage.googleapis.example/firmada?token=SECRETO123';
const PATH_LEGACY = 'tenants/tnt_1/orders/ord_1/comprobantes/foto.jpg';

const ts = (ms: number) => ({ toDate: () => new Date(ms), toMillis: () => ms }) as unknown as Attachment['createdAt'];

const pedido = (over: Record<string, unknown> = {}): Order =>
  ({
    id: 'ord_1',
    tenantId: 'tnt_1',
    customerId: CLIENTE,
    status: 'PENDING_VERIFICATION',
    items: [{ itemId: 'it_1', productId: 'prd_1', productName: 'Perfume', unitPrice: 100, quantity: 1, subtotal: 100 }],
    totals: { subtotal: 100, discount: 0, total: 100, currency: 'PYG' },
    payment: { method: 'transfer', paymentId: 'pay_1', paidAt: null, comprobanteUrl: null },
    delivery: { deliveryId: null, address: {} },
    invoice: { invoiceId: null, number: null },
    channel: 'whatsapp',
    sellerId: null,
    source: 'whatsapp-bot',
    createdAt: ts(1),
    ...over,
  }) as unknown as Order;

const adjunto: PanelAttachment = {
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
};

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OrdersPage />
    </QueryClientProvider>,
  );
}

/** Abre el detalle del primer pedido de la tabla. */
async function abrirDetalle() {
  fireEvent.click(await screen.findByRole('button', { name: 'Ver' }));
}

beforeEach(() => {
  listOrdersMock.mockReset();
  listOrderFinancialsMock.mockReset().mockResolvedValue({});
  getComprobanteViewUrlMock.mockReset().mockResolvedValue({ url: URL_FIRMADA, expiresAt: Date.now() + 300000 });
  listAttachmentsByIdsMock.mockReset().mockResolvedValue({ items: [adjunto], missingIds: [] });
  getAttachmentViewUrlMock.mockReset().mockResolvedValue({ url: URL_FIRMADA, expiresAt: Date.now() + 300000 });
});

describe('Pedidos — comprobante nuevo (adjunto)', () => {
  it('el comprobante vinculado desde Conversaciones se VE en el detalle del pedido', async () => {
    listOrdersMock.mockResolvedValue([
      pedido({ receiptAttachments: { linkedIds: [A1], candidateIds: [A1], statusDrivenBy: A1 } }),
    ]);
    montar();
    await abrirDetalle();

    expect(await screen.findByText(/comprobante vinculado/i)).toBeInTheDocument();
    expect(listAttachmentsByIdsMock).toHaveBeenCalledWith('tnt_1', [A1]);
    // Se abre por attachmentId con el visor seguro, no por la ruta del archivo.
    fireEvent.click(screen.getByRole('button', { name: /ver comprobante/i }));
    expect(await screen.findByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(getAttachmentViewUrlMock).toHaveBeenCalledWith('tnt_1', A1);
    expect(getComprobanteViewUrlMock).not.toHaveBeenCalled();
  });

  it('el detalle no muestra rutas de Storage ni la URL firmada', async () => {
    listOrdersMock.mockResolvedValue([
      pedido({ receiptAttachments: { linkedIds: [A1], statusDrivenBy: A1 } }),
    ]);
    montar();
    await abrirDetalle();
    fireEvent.click(await screen.findByRole('button', { name: /ver comprobante/i }));
    await screen.findByAltText(/imagen enviada por el cliente/i);

    expect(document.body.innerHTML).not.toContain('tenants/');
    expect(document.body.textContent ?? '').not.toContain(URL_FIRMADA);
  });
});

describe('Pedidos — comprobante LEGACY (ADR-0016 §7)', () => {
  it('sigue mostrándose y sigue abriendo con el visor de pedido de siempre', async () => {
    listOrdersMock.mockResolvedValue([
      pedido({ payment: { method: 'transfer', paymentId: 'pay_1', paidAt: null, comprobanteUrl: PATH_LEGACY } }),
    ]);
    montar();
    await abrirDetalle();

    expect(screen.getByText(/comprobante recibido/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /ver comprobante/i }));
    expect(getComprobanteViewUrlMock).toHaveBeenCalledWith('tnt_1', 'ord_1');
    expect(await screen.findByAltText(/comprobante de pago enviado por el cliente/i)).toBeInTheDocument();
    // El camino viejo no pasa por la lectura de adjuntos ni filtra la ruta legacy al DOM.
    expect(listAttachmentsByIdsMock).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain(PATH_LEGACY);
  });

  it('con comprobante legacy no se dibuja además el vacío de la sección nueva', async () => {
    listOrdersMock.mockResolvedValue([
      pedido({ payment: { method: 'transfer', paymentId: 'pay_1', paidAt: null, comprobanteUrl: PATH_LEGACY } }),
    ]);
    montar();
    await abrirDetalle();
    expect(screen.queryByText(/todavía no llegó ningún comprobante/i)).not.toBeInTheDocument();
  });
});

describe('Pedidos — sin comprobantes', () => {
  it('un pedido esperando pago dice que todavía no llegó ninguno, sin leer adjuntos', async () => {
    listOrdersMock.mockResolvedValue([pedido({ status: 'PENDING_PAYMENT' })]);
    montar();
    await abrirDetalle();
    expect(screen.getByText(/todavía no llegó ningún comprobante/i)).toBeInTheDocument();
    expect(listAttachmentsByIdsMock).not.toHaveBeenCalled();
  });

  it('un pedido ya entregado no dibuja ninguna sección de comprobantes', async () => {
    listOrdersMock.mockResolvedValue([pedido({ status: 'DELIVERED' })]);
    montar();
    await abrirDetalle();
    expect(screen.queryByText(/comprobante/i)).not.toBeInTheDocument();
  });
});
