/**
 * MessageBubble.delivery.test.tsx — ticks de entrega (ADR-0021 §1).
 * El estado se dice con PALABRAS (aria-label/title), nunca solo con color; los entrantes, los
 * históricos sin estado y los retenidos por mock NO muestran tick.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Message } from '@vpw/shared';
import { MessageBubble } from './MessageBubble';

const ts = (ms: number) => ({ toDate: () => new Date(ms), toMillis: () => ms }) as unknown as Message['createdAt'];

function msg(over: Partial<Message> = {}): Message {
  return {
    id: 'msg_1',
    tenantId: 'tnt_1',
    customerId: '595981000000',
    direction: 'out',
    author: 'seller',
    text: 'ya te lo envío',
    createdAt: ts(1),
    ...over,
  } as Message;
}

function renderBurbuja(m: Message) {
  return render(
    <MessageBubble
      m={m}
      tenantId="tnt_1"
      attachmentsById={new Map()}
      attachmentsLoading={false}
      attachmentsFailed={false}
      onRetryAttachments={vi.fn()}
      role="SELLER"
      orders={[]}
      onAttachmentChanged={vi.fn()}
    />,
  );
}

describe('MessageBubble — ticks de entrega', () => {
  it.each([
    ['pending', 'Enviando…'],
    ['sent', 'Enviado'],
    ['delivered', 'Entregado'],
    ['read', 'Leído'],
  ] as const)('deliveryStatus %s → aria-label «%s»', (status, label) => {
    renderBurbuja(msg({ deliveryStatus: status }));
    expect(screen.getByRole('img', { name: label })).toBeInTheDocument();
  });

  it('sent y delivered se distinguen por el glifo (✓ vs ✓✓), no solo por color', () => {
    const { unmount } = renderBurbuja(msg({ deliveryStatus: 'sent' }));
    expect(screen.getByRole('img', { name: 'Enviado' })).toHaveTextContent('✓');
    unmount();
    renderBurbuja(msg({ deliveryStatus: 'delivered' }));
    expect(screen.getByRole('img', { name: 'Entregado' })).toHaveTextContent('✓✓');
  });

  it('B6: delivered y read se distinguen por una señal NO cromática (subrayado), no solo color', () => {
    // Mismo glifo ✓✓: un daltónico sin hover necesita otra diferencia visual además del color.
    const { unmount } = renderBurbuja(msg({ deliveryStatus: 'read' }));
    expect(screen.getByRole('img', { name: 'Leído' }).className).toMatch(/underline/);
    unmount();
    renderBurbuja(msg({ deliveryStatus: 'delivered' }));
    expect(screen.getByRole('img', { name: 'Entregado' }).className).not.toMatch(/underline/);
  });

  it('failed → ícono con label textual + detalle sanitizado visible', () => {
    renderBurbuja(msg({ deliveryStatus: 'failed', deliveryError: { code: '131026', detail: 'El número no recibe mensajes.' } }));
    expect(screen.getByRole('img', { name: 'No se pudo entregar' })).toBeInTheDocument();
    expect(screen.getByText('El número no recibe mensajes.')).toBeInTheDocument();
  });

  it('failed SIN detail: igual dice que no se pudo entregar (nunca silencio)', () => {
    renderBurbuja(msg({ deliveryStatus: 'failed' }));
    expect(screen.getByText('No se pudo entregar')).toBeInTheDocument();
  });

  it('mensaje ENTRANTE: sin tick aunque traiga deliveryStatus por error', () => {
    renderBurbuja(msg({ direction: 'in', author: 'customer', deliveryStatus: 'read' }));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('mensaje histórico saliente SIN deliveryStatus: sin tick, sin errores', () => {
    renderBurbuja(msg({ deliveryStatus: undefined }));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('viaMock: sin tick — ya lo cubre « · retenido (prueba)»', () => {
    renderBurbuja(msg({ deliveryStatus: 'sent', viaMock: true }));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText(/retenido \(prueba\)/i)).toBeInTheDocument();
  });
});
