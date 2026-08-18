/**
 * MessageAttachments + AttachmentCandidateActions (ADR-0016 · Área D).
 * Cubre los cuatro estados de la burbuja, el rechazo que NO bloquea el chat, el candidato como
 * SUGERENCIA (no comprobante), el selector obligatorio cuando hay ambigüedad entre pedidos y la
 * garantía de que ninguna ruta de Storage llega al DOM.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Attachment, Order, OrderStatus } from '@vpw/shared';
import { MessageAttachments } from './MessageAttachments';

const getAttachmentViewUrl = vi.fn();
const markAttachmentAsReceipt = vi.fn();
const unmarkAttachmentReceipt = vi.fn();
vi.mock('@/lib/attachments', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/attachments')>();
  return {
    ...real,
    getAttachmentViewUrl: (...a: unknown[]) => getAttachmentViewUrl(...a),
    markAttachmentAsReceipt: (...a: unknown[]) => markAttachmentAsReceipt(...a),
    unmarkAttachmentReceipt: (...a: unknown[]) => unmarkAttachmentReceipt(...a),
  };
});

const URL_FIRMADA = 'https://storage.googleapis.example/firmada?token=SECRETO123';
const PATH_STORAGE = 'tenants/tnt_1/attachments/aa/att_secreto';
const CUSTOMER = '595981000000';
const ID = 'att_' + 'a'.repeat(24);
const ts = (ms: number) => ({ toDate: () => new Date(ms), toMillis: () => ms }) as unknown as Attachment['createdAt'];

function att(over: Partial<Attachment> = {}): Attachment {
  return {
    attachmentId: ID,
    tenantId: 'tnt_1',
    customerId: CUSTOMER,
    conversationId: CUSTOMER,
    messageId: 'msg_1',
    providerMessageId: 'pmid_' + 'b'.repeat(24),
    channel: 'whatsapp',
    class: 'image',
    direction: 'in',
    author: 'customer',
    ingestState: 'stored',
    classification: { value: 'generic_media', source: 'rule', confidence: 1, by: null, at: ts(1) },
    caption: '',
    filename: null,
    mime: { declared: 'image/jpeg', verified: 'image/jpeg' },
    bytes: 2048,
    checksum: 'abc',
    storage: { path: PATH_STORAGE },
    orderCandidateId: null,
    retentionUntil: null,
    purgedAt: null,
    createdAt: ts(1),
    updatedAt: ts(1),
    lastError: null,
    ...over,
  } as Attachment;
}

function order(id: string, status: OrderStatus = 'PENDING_PAYMENT', total = 100000): Order {
  return {
    id,
    tenantId: 'tnt_1',
    customerId: CUSTOMER,
    status,
    items: [{ itemId: 'i1', productId: 'p1', productName: 'Producto', unitPrice: total, quantity: 1, subtotal: total }],
    totals: { subtotal: total, discount: 0, total, currency: 'PYG' },
    createdAt: ts(10),
  } as unknown as Order;
}

function renderAdjuntos(over: Partial<React.ComponentProps<typeof MessageAttachments>> = {}) {
  const props: React.ComponentProps<typeof MessageAttachments> = {
    tenantId: 'tnt_1',
    ids: [ID],
    byId: new Map([[ID, att()]]),
    loading: false,
    failed: false,
    onRetry: vi.fn(),
    role: 'SELLER',
    orders: [],
    onChanged: vi.fn(),
    ...over,
  };
  return { ...render(<MessageAttachments {...props} />), props };
}

describe('MessageAttachments — estados', () => {
  beforeEach(() => {
    getAttachmentViewUrl.mockReset();
    markAttachmentAsReceipt.mockReset();
    unmarkAttachmentReceipt.mockReset();
    getAttachmentViewUrl.mockResolvedValue({ url: URL_FIRMADA, expiresAt: 1 });
  });

  it('sin punteros no dibuja nada (mensaje viejo sin adjuntos)', () => {
    const { container } = renderAdjuntos({ ids: [], byId: new Map() });
    expect(container).toBeEmptyDOMElement();
  });

  it('cargando: esqueleto con aviso, sin tarjeta a medias', () => {
    renderAdjuntos({ byId: new Map(), loading: true });
    expect(screen.getByRole('status')).toHaveTextContent(/cargando/i);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('la lectura falló: motivo accionable + reintento de solo lectura', () => {
    const onRetry = vi.fn();
    renderAdjuntos({ byId: new Map(), loading: false, failed: true, onRetry });
    expect(screen.getByRole('alert')).toHaveTextContent(/reintent/i);
    fireEvent.click(screen.getByRole('button', { name: /reintentar/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('ingesta en curso: se avisa que el archivo está llegando', () => {
    const a = att({ ingestState: 'downloading' });
    renderAdjuntos({ byId: new Map([[ID, a]]) });
    expect(screen.getByRole('status')).toHaveTextContent(/recibiendo el archivo/i);
  });

  it('rechazado: el chat NO se bloquea, se ve el motivo y qué pedirle al cliente', () => {
    const a = att({ ingestState: 'rejected', lastError: 'formato no admitido' });
    renderAdjuntos({ byId: new Map([[ID, a]]) });
    expect(screen.getByRole('alert')).toHaveTextContent(/reenv/i);
    expect(screen.getByText('formato no admitido')).toBeInTheDocument();
    // Terminal: no se ofrece un reintento que no puede funcionar.
    expect(screen.queryByRole('button', { name: /reintentar/i })).not.toBeInTheDocument();
  });

  it('imagen guardada: thumbnail con alt y sin acciones de pago no pedidas', async () => {
    renderAdjuntos();
    const img = await screen.findByAltText(/imagen enviada por el cliente/i);
    expect((img as HTMLImageElement).src).toContain('firmada');
    expect(screen.queryByText(/posible comprobante/i)).not.toBeInTheDocument();
  });

  it('el adjunto no aparece y la lectura NO falló → se explica el porqué (retención o permisos)', () => {
    renderAdjuntos({ byId: new Map(), loading: false, failed: false });
    expect(screen.getByRole('alert')).toHaveTextContent(/retención|permiso/i);
  });

  it('enlace de la imagen vencido → motivo claro y reintento de solo lectura', async () => {
    renderAdjuntos();
    const img = await screen.findByAltText(/imagen enviada por el cliente/i);
    fireEvent.error(img);
    expect(await screen.findByRole('alert')).toHaveTextContent(/expirar/i);
    fireEvent.click(screen.getByRole('button', { name: /reintentar/i }));
    await waitFor(() => expect(getAttachmentViewUrl).toHaveBeenCalledTimes(2));
  });

  it('documento: ficha con nombre, tipo y tamaño (sin descargar bytes)', () => {
    const pdf = att({ class: 'document', filename: 'transferencia.pdf', bytes: 250000, mime: { declared: 'application/pdf', verified: 'application/pdf' } });
    renderAdjuntos({ byId: new Map([[ID, pdf]]) });
    expect(screen.getByText('transferencia.pdf')).toBeInTheDocument();
    expect(screen.getByText(/PDF · 244 KB/)).toBeInTheDocument();
    expect(getAttachmentViewUrl).not.toHaveBeenCalled(); // el PDF no se firma hasta abrirlo
  });
});

describe('Candidato a comprobante — sugerencia, no comprobante', () => {
  // PDF a propósito: las apps bancarias mandan el comprobante como documento (defecto #3 de la
  // auditoría) y así el bloque de acciones se prueba sin el pedido asíncrono del thumbnail.
  const candidato = att({
    class: 'document',
    filename: 'transferencia.pdf',
    mime: { declared: 'application/pdf', verified: 'application/pdf' },
    classification: { value: 'payment_receipt_candidate', source: 'rule', confidence: 1, by: null, at: ts(5) },
    orderCandidateId: 'ord_uno',
  });

  beforeEach(() => {
    getAttachmentViewUrl.mockReset();
    markAttachmentAsReceipt.mockReset();
    getAttachmentViewUrl.mockResolvedValue({ url: URL_FIRMADA, expiresAt: 1 });
  });

  it('badge + aclaración de que el pedido sigue esperando el pago + auditoría de quién clasificó', () => {
    renderAdjuntos({ byId: new Map([[ID, candidato]]), orders: [order('ord_uno')] });
    expect(screen.getByText('🧾 Posible comprobante')).toBeInTheDocument();
    expect(screen.getByText(/sigue esperando el pago/i)).toBeInTheDocument();
    expect(screen.getByText(/regla autom/i)).toBeInTheDocument();
  });

  it('el chip del pedido lo abre ACÁ, sin mandar a la pantalla de Pedidos', () => {
    renderAdjuntos({ byId: new Map([[ID, candidato]]), orders: [order('ord_uno', 'PENDING_PAYMENT', 55000)] });
    const chip = screen.getByRole('button', { name: /ord_uno/i });
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/1× Producto/)).toBeInTheDocument();
    expect(screen.getByText(/₲ 55.000/)).toBeInTheDocument();
  });

  it('un solo pedido admisible: se muestra cuál y se vincula con ese id explícito', async () => {
    const onChanged = vi.fn();
    markAttachmentAsReceipt.mockResolvedValueOnce({ ok: true });
    renderAdjuntos({ byId: new Map([[ID, candidato]]), orders: [order('ord_uno')], onChanged });
    fireEvent.click(screen.getByRole('button', { name: /marcar como comprobante/i }));
    expect(screen.getByText(/se va a vincular a este pedido/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /confirmar/i }));
    await waitFor(() => expect(markAttachmentAsReceipt).toHaveBeenCalledWith('tnt_1', ID, 'ord_uno'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('AMBIGÜEDAD: con dos pedidos abiertos hay que elegir uno — no se adivina', async () => {
    markAttachmentAsReceipt.mockResolvedValueOnce({ ok: true });
    renderAdjuntos({
      byId: new Map([[ID, candidato]]),
      orders: [order('ord_uno'), order('ord_dos', 'PENDING_PAYMENT', 30000), order('ord_pago', 'PAID')],
    });
    fireEvent.click(screen.getByRole('button', { name: /marcar como comprobante/i }));

    const select = screen.getByRole('combobox', { name: /elegí a cuál corresponde/i });
    expect((select as HTMLSelectElement).value).toBe(''); // sin default: elegir es del humano
    expect(screen.getByRole('button', { name: /confirmar/i })).toBeDisabled();
    // El pedido PAGADO no es opción: vincular ahí sería fabricar evidencia sobre un pago cerrado.
    const opciones = Array.from((select as HTMLSelectElement).options).map((o) => o.value);
    expect(opciones).toEqual(['', 'ord_uno', 'ord_dos']);

    fireEvent.change(select, { target: { value: 'ord_dos' } });
    fireEvent.click(screen.getByRole('button', { name: /confirmar/i }));
    await waitFor(() => expect(markAttachmentAsReceipt).toHaveBeenCalledWith('tnt_1', ID, 'ord_dos'));
  });

  it('sin pedidos admisibles: se explica en vez de ofrecer un botón que va a fallar', () => {
    renderAdjuntos({ byId: new Map([[ID, candidato]]), orders: [order('ord_pago', 'PAID')] });
    fireEvent.click(screen.getByRole('button', { name: /marcar como comprobante/i }));
    expect(screen.getByText(/no tiene ningún pedido esperando pago/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /confirmar/i })).toBeDisabled();
  });

  it('un lector (TENANT_VIEWER) no ve ninguna acción humana', () => {
    renderAdjuntos({ byId: new Map([[ID, candidato]]), orders: [order('ord_uno')], role: 'TENANT_VIEWER' });
    expect(screen.queryByRole('button', { name: /marcar como comprobante/i })).not.toBeInTheDocument();
    expect(screen.getByText('🧾 Posible comprobante')).toBeInTheDocument(); // sí puede LEER
  });

  it('desmarcar: pide confirmación y desvincula del pedido CONCRETO', async () => {
    unmarkAttachmentReceipt.mockResolvedValueOnce({ ok: true });
    const vinculado = att({
      class: 'document',
      filename: 'transferencia.pdf',
      mime: { declared: 'application/pdf', verified: 'application/pdf' },
      classification: { value: 'payment_receipt_linked', source: 'human', confidence: 1, by: 'uid_9', at: ts(7) },
      orderCandidateId: 'ord_uno',
    });
    renderAdjuntos({ byId: new Map([[ID, vinculado]]), orders: [order('ord_uno', 'PENDING_VERIFICATION')], role: 'TENANT_OWNER' });
    expect(screen.getByText('🧾 Comprobante vinculado')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^desmarcar$/i }));
    // La confirmación dice exactamente qué pedido se toca y que no se borra nada.
    expect(screen.getByText(/desvincular este archivo del pedido/i)).toBeInTheDocument();
    expect(screen.getByText(/no se borra nada/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /sí, desmarcar/i }));
    await waitFor(() => expect(unmarkAttachmentReceipt).toHaveBeenCalledWith('tnt_1', ID, 'ord_uno'));
  });

  it('un comprobante de un pedido YA PAGADO no se puede desmarcar desde la UI', () => {
    const vinculado = att({
      class: 'document',
      filename: 'transferencia.pdf',
      mime: { declared: 'application/pdf', verified: 'application/pdf' },
      classification: { value: 'payment_receipt_linked', source: 'human', confidence: 1, by: 'uid_9', at: ts(7) },
      orderCandidateId: 'ord_uno',
    });
    renderAdjuntos({ byId: new Map([[ID, vinculado]]), orders: [order('ord_uno', 'PAID')], role: 'TENANT_OWNER' });
    expect(screen.queryByRole('button', { name: /desmarcar/i })).not.toBeInTheDocument();
  });

  it('la ruta de Storage NUNCA llega al DOM', async () => {
    const imagenCandidata = att({ ...candidato, class: 'image', filename: null, mime: { declared: 'image/jpeg', verified: 'image/jpeg' } });
    renderAdjuntos({ byId: new Map([[ID, imagenCandidata]]), orders: [order('ord_uno')] });
    await screen.findByAltText(/imagen enviada por el cliente/i);
    expect(document.body.innerHTML).not.toContain(PATH_STORAGE);
    expect(document.body.innerHTML).not.toContain('attachments/aa');
    expect(document.body.textContent ?? '').not.toContain(URL_FIRMADA);
  });
});

describe('Adjunto SALIENTE (ADR-0021 §5) — la UI distingue la dirección', () => {
  // El adjunto que el PANEL le envió al cliente: jamás es un comprobante y los textos no pueden
  // decir «del cliente». Los docs salientes traen `direction: 'out'`.
  const saliente = att({
    direction: 'out',
    author: 'seller',
    classification: { value: 'generic_media', source: 'rule', confidence: 1, by: null, at: ts(5) },
  });

  beforeEach(() => {
    getAttachmentViewUrl.mockReset();
    markAttachmentAsReceipt.mockReset();
    getAttachmentViewUrl.mockResolvedValue({ url: URL_FIRMADA, expiresAt: 1 });
  });

  it('NUNCA ofrece «Marcar como comprobante» aunque haya un pedido admisible', async () => {
    renderAdjuntos({ byId: new Map([[ID, saliente]]), orders: [order('ord_uno')], role: 'TENANT_OWNER' });
    await screen.findByRole('img'); // thumbnail listo: el bloque de acciones ya se decidió
    expect(screen.queryByRole('button', { name: /marcar como comprobante/i })).not.toBeInTheDocument();
  });

  it('el alt de la imagen dice que fue ENVIADA AL cliente, no recibida', async () => {
    renderAdjuntos({ byId: new Map([[ID, saliente]]) });
    expect(await screen.findByAltText(/imagen enviada al cliente/i)).toBeInTheDocument();
    expect(screen.queryByAltText(/por el cliente/i)).not.toBeInTheDocument();
  });

  it('la línea de clasificación no lo describe como «Archivo del cliente»', async () => {
    renderAdjuntos({ byId: new Map([[ID, saliente]]), role: 'TENANT_OWNER' });
    await screen.findByRole('img');
    expect(screen.queryByText(/archivo del cliente/i)).not.toBeInTheDocument();
    expect(screen.getByText(/enviado por tu equipo/i)).toBeInTheDocument();
  });

  it('un documento saliente sin filename tampoco dice «del cliente»', () => {
    const pdfOut = att({
      direction: 'out',
      author: 'seller',
      class: 'document',
      filename: null,
      mime: { declared: 'application/pdf', verified: 'application/pdf' },
    });
    renderAdjuntos({ byId: new Map([[ID, pdfOut]]) });
    expect(screen.queryByText(/documento del cliente/i)).not.toBeInTheDocument();
    expect(screen.getByText(/documento enviado al cliente/i)).toBeInTheDocument();
  });
});
