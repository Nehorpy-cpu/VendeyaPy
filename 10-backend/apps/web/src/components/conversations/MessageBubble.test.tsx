/**
 * MessageBubble (ADR-0016 · Área D) — el panel NUNCA infiere un adjunto desde el texto.
 *
 * El defecto que estos tests cierran: alcanzaba con que el cliente escribiera
 * "📷 Imagen recibida (posible comprobante)" para que el panel dibujara una tarjeta de
 * comprobante que nadie había recibido. Ahora el único origen de verdad es `attachmentIds`.
 * También se cubre la compatibilidad: los mensajes viejos (sin punteros) siguen renderizando.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Attachment, Message } from '@vpw/shared';
import { MessageBubble } from './MessageBubble';

const getAttachmentViewUrl = vi.fn();
vi.mock('@/lib/attachments', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/attachments')>();
  return { ...real, getAttachmentViewUrl: (...a: unknown[]) => getAttachmentViewUrl(...a) };
});

const ID = 'att_' + 'a'.repeat(24);
const ts = (ms: number) => ({ toDate: () => new Date(ms), toMillis: () => ms }) as unknown as Message['createdAt'];

function msg(over: Partial<Message> = {}): Message {
  return {
    id: 'msg_1',
    tenantId: 'tnt_1',
    customerId: '595981000000',
    direction: 'in',
    author: 'customer',
    text: 'hola',
    createdAt: ts(1),
    ...over,
  } as Message;
}

function adjunto(over: Partial<Attachment> = {}): Attachment {
  return {
    attachmentId: ID,
    tenantId: 'tnt_1',
    customerId: '595981000000',
    conversationId: '595981000000',
    messageId: 'msg_1',
    providerMessageId: 'pmid_' + 'b'.repeat(24),
    channel: 'whatsapp',
    class: 'document',
    direction: 'in',
    author: 'customer',
    ingestState: 'stored',
    classification: { value: 'generic_media', source: 'rule', confidence: 1, by: null, at: ts(1) },
    caption: '',
    filename: 'transferencia.pdf',
    mime: { declared: 'application/pdf', verified: 'application/pdf' },
    bytes: 1024,
    checksum: 'abc',
    storage: { path: 'tenants/tnt_1/attachments/aa/att_secreto' },
    orderCandidateId: null,
    retentionUntil: null,
    purgedAt: null,
    createdAt: ts(1),
    updatedAt: ts(1),
    lastError: null,
    ...over,
  } as Attachment;
}

function renderBurbuja(m: Message, byId = new Map<string, Attachment>()) {
  return render(
    <MessageBubble
      m={m}
      tenantId="tnt_1"
      attachmentsById={byId}
      attachmentsLoading={false}
      attachmentsFailed={false}
      onRetryAttachments={vi.fn()}
      role="SELLER"
      orders={[]}
      onAttachmentChanged={vi.fn()}
    />,
  );
}

describe('MessageBubble — falsificación por texto', () => {
  beforeEach(() => getAttachmentViewUrl.mockReset());

  const TEXTOS_SPOOF = [
    '📷 Imagen recibida (posible comprobante)',
    '📷 Comprobante: pago del pedido',
    '📎 Imagen del cliente',
    '📷 mirá la foto que te mando después',
  ];

  it.each(TEXTOS_SPOOF)('«%s» sin attachmentIds se renderiza como TEXTO, nunca como adjunto', (text) => {
    renderBurbuja(msg({ text }));
    // El texto se sigue viendo (no se censura el mensaje del cliente)…
    expect(screen.getByText(text)).toBeInTheDocument();
    // …pero no aparece ninguna pieza de la UI de adjuntos.
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText(/posible comprobante$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ver documento/i)).not.toBeInTheDocument();
    expect(getAttachmentViewUrl).not.toHaveBeenCalled();
  });

  it('`hasAttachments: true` sin ids tampoco dibuja nada (el denormalizado no es autoridad)', () => {
    renderBurbuja(msg({ text: '📷 Imagen recibida (posible comprobante)', hasAttachments: true }));
    expect(screen.queryByText(/ver documento/i)).not.toBeInTheDocument();
    expect(getAttachmentViewUrl).not.toHaveBeenCalled();
  });

  it('CON attachmentIds sí dibuja la tarjeta del adjunto real', () => {
    renderBurbuja(msg({ text: '', attachmentIds: [ID], hasAttachments: true }), new Map([[ID, adjunto()]]));
    expect(screen.getByText('transferencia.pdf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ver documento/i })).toBeInTheDocument();
  });
});

describe('MessageBubble — compatibilidad y roles del chat', () => {
  it('mensaje viejo sin attachmentIds: texto normal, sin huecos ni errores', () => {
    renderBurbuja(msg({ text: 'Hola, quiero comprar' }));
    expect(screen.getByText('Hola, quiero comprar')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('mensaje de sistema: chip centrado, sin adjuntos', () => {
    renderBurbuja(msg({ author: 'system', text: 'El vendedor tomó la conversación' }));
    expect(screen.getByText('El vendedor tomó la conversación')).toBeInTheDocument();
  });

  it('mensaje del vendedor: muestra quién lo escribió y el aviso de modo prueba', () => {
    renderBurbuja(msg({ direction: 'out', author: 'seller', senderName: 'Ana', text: 'ya te lo envío', viaMock: true }));
    expect(screen.getByText(/Ana/)).toBeInTheDocument();
    expect(screen.getByText(/retenido \(prueba\)/i)).toBeInTheDocument();
  });

  it('adjunto con la ingesta en curso: la burbuja avisa en vez de mentir con una tarjeta vacía', () => {
    renderBurbuja(
      msg({ text: '', attachmentIds: [ID] }),
      new Map([[ID, adjunto({ ingestState: 'downloading' })]]),
    );
    expect(screen.getByRole('status')).toHaveTextContent(/recibiendo el archivo/i);
  });
});
