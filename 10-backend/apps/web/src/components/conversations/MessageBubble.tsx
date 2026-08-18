'use client';

/**
 * Burbuja de un mensaje del chat (extraída de la página para poder testearla sola).
 *
 * ADR-0016: acá vivía una rama que dibujaba una "tarjeta de imagen del cliente" cuando el TEXTO
 * del mensaje empezaba con "📷 Imagen recibida (posible comprobante)". Se eliminó: ese texto lo
 * podía escribir el propio cliente y fabricar una tarjeta de comprobante falsa. Ahora un adjunto
 * se renderiza si —y solo si— el mensaje trae punteros en `attachmentIds`.
 *
 * COMPATIBILIDAD: los mensajes viejos no tienen `attachmentIds` y siguen renderizando como texto
 * normal, sin tarjetas, sin errores y sin huecos.
 */

import type { Message, Order } from '@vpw/shared';
import type { Role } from '@/lib/auth-context';
import type { PanelAttachment } from '@/lib/attachments';
import { deliveryTick, hhmm } from '@/lib/conversationsUi';
import { MessageAttachments } from '@/components/attachments/MessageAttachments';
import { cn } from '@/lib/cn';

export interface MessageBubbleProps {
  m: Message;
  tenantId: string;
  attachmentsById: Map<string, PanelAttachment>;
  attachmentsLoading: boolean;
  attachmentsFailed: boolean;
  onRetryAttachments: () => void;
  role: Role | null;
  orders: readonly Order[];
  onAttachmentChanged: () => void;
}

export function MessageBubble({
  m,
  tenantId,
  attachmentsById,
  attachmentsLoading,
  attachmentsFailed,
  onRetryAttachments,
  role,
  orders,
  onAttachmentChanged,
}: MessageBubbleProps) {
  if (m.author === 'system') {
    return (
      <div className="text-center">
        <span className="inline-block rounded-full bg-ink-100 px-3 py-1 text-[11px] text-ink-600">
          {m.text}
        </span>
      </div>
    );
  }

  const mine = m.direction === 'out'; // bot o vendedor (sale de nosotros)
  const tone =
    m.author === 'seller'
      ? 'bg-amber-500 text-white'
      : mine
        ? 'bg-mint-600 text-white'
        : 'border border-ink-100 bg-white text-ink-800';
  const authorLabel = m.author === 'seller' ? (m.senderName ?? 'Vendedor') : null;
  // Único origen de verdad del adjunto. `hasAttachments` es solo un denormalizado para listar:
  // si viniera en true sin ids, no hay nada que resolver y no se dibuja nada.
  const ids = m.attachmentIds ?? [];
  // null en entrantes, históricos sin estado y salientes retenidos por mock.
  const tick = deliveryTick(m);

  return (
    <div className={mine ? 'text-right' : 'text-left'}>
      {m.text?.trim() && (
        <div className={'inline-block max-w-[80%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ' + tone}>
          {authorLabel && <div className="mb-0.5 text-[10px] font-semibold opacity-80">🧑‍💼 {authorLabel}</div>}
          {m.text}
        </div>
      )}
      {ids.length > 0 && (
        <div className={mine ? 'flex justify-end' : 'flex justify-start'}>
          <MessageAttachments
            tenantId={tenantId}
            ids={ids}
            byId={attachmentsById}
            loading={attachmentsLoading}
            failed={attachmentsFailed}
            onRetry={onRetryAttachments}
            role={role}
            orders={orders}
            onChanged={onAttachmentChanged}
          />
        </div>
      )}
      <div className="mt-0.5 text-[10px] text-ink-400">
        {hhmm(m.createdAt)}
        {/* ADR-0021 §1: tick de entrega SOLO en salientes con estado del proveedor. Nunca solo
            color: el aria-label + title dicen el estado con palabras («Leído», «Entregado»…). */}
        {tick && (
          <span
            role="img"
            aria-label={tick.label}
            title={tick.label}
            className={cn(
              'ml-1 font-semibold tracking-tighter',
              // B6: «leído» lleva además una señal NO cromática (subrayado) — mismo glifo ✓✓
              // que «entregado», y el color solo no alcanza para un daltónico sin hover.
              tick.failed
                ? 'text-coral-600'
                : tick.accent
                  ? 'text-sky-600 underline decoration-2 underline-offset-2'
                  : 'text-ink-400',
            )}
          >
            {tick.glyph}
          </span>
        )}
        {tick?.failed && (
          <span className="ml-1 text-coral-600">
            {m.deliveryError?.detail?.trim() || 'No se pudo entregar'}
          </span>
        )}
        {m.author === 'seller' && m.viaMock && (
          <span title="Modo prueba: no salió a WhatsApp"> · retenido (prueba)</span>
        )}
      </div>
    </div>
  );
}
