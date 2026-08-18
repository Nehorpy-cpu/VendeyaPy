'use client';

/**
 * Historial del chat (ADR-0021): separadores de fecha Hoy/Ayer/fecha es-PY, paginación hacia
 * atrás con scroll ESTABLE (se preserva la posición al prepender), autoscroll SOLO si el usuario
 * está cerca del fondo (o al enviar), y botón flotante «Ir al mensaje más reciente».
 */

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Message, Order } from '@vpw/shared';
import type { Role } from '@/lib/auth-context';
import type { PanelAttachment } from '@/lib/attachments';
import { dayLabel, needsDateSeparator } from '@/lib/conversationsUi';
import { MessageBubble } from './MessageBubble';

/** Distancia al fondo (px) por debajo de la cual se considera que el usuario «está al final». */
const NEAR_BOTTOM_PX = 120;

export function MessageHistory({
  tenantId,
  messages,
  loading,
  hasMore,
  loadingOlder,
  olderError,
  onLoadOlder,
  scrollToEndSignal,
  attachmentsById,
  attachmentsLoading,
  attachmentsFailed,
  onRetryAttachments,
  role,
  orders,
  onAttachmentChanged,
}: {
  tenantId: string;
  /** Ventana combinada (páginas viejas + ventana viva), en orden cronológico. */
  messages: readonly Message[];
  loading: boolean;
  hasMore: boolean;
  loadingOlder: boolean;
  olderError: string | null;
  onLoadOlder: () => void;
  /** Bump (contador) para forzar el scroll al final — p. ej. al enviar un mensaje. */
  scrollToEndSignal: number;
  attachmentsById: Map<string, PanelAttachment>;
  attachmentsLoading: boolean;
  attachmentsFailed: boolean;
  onRetryAttachments: () => void;
  role: Role | null;
  orders: readonly Order[];
  onAttachmentChanged: () => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  // Firma de la ventana previa para distinguir «prepend» (paginación) de «append» (mensaje nuevo).
  const prevRef = useRef<{ firstId: string | null; lastId: string | null; count: number; scrollHeight: number }>({
    firstId: null,
    lastId: null,
    count: 0,
    scrollHeight: 0,
  });

  const irAlFinal = (smooth: boolean) => {
    const el = scrollerRef.current;
    if (!el) return;
    try {
      el.scrollTo?.({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    } catch {
      el.scrollTop = el.scrollHeight;
    }
    atBottomRef.current = true;
    setAtBottom(true);
  };

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const cerca = dist < NEAR_BOTTOM_PX;
    atBottomRef.current = cerca;
    setAtBottom(cerca);
  };

  // Preservación de posición al PREPENDER + autoscroll condicional al APPEND.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    const prev = prevRef.current;
    const firstId = messages[0]?.id ?? null;
    const lastId = messages[messages.length - 1]?.id ?? null;

    if (el && messages.length > 0) {
      const prepended = prev.count > 0 && firstId !== prev.firstId && lastId === prev.lastId;
      const appended = prev.count > 0 && lastId !== prev.lastId;
      const initial = prev.count === 0;
      if (prepended) {
        // Scroll estable: la vista se queda sobre el mismo mensaje que estaba mirando.
        el.scrollTop += el.scrollHeight - prev.scrollHeight;
      } else if (initial || (appended && atBottomRef.current)) {
        irAlFinal(false);
      }
    }
    prevRef.current = { firstId, lastId, count: messages.length, scrollHeight: el?.scrollHeight ?? 0 };
  }, [messages]);

  // Señal externa (enviar mensaje): siempre baja al final.
  useEffect(() => {
    if (scrollToEndSignal > 0) irAlFinal(true);
  }, [scrollToEndSignal]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="h-full space-y-2 overflow-y-auto bg-ink-50/40 p-4"
        aria-label="Historial de mensajes"
      >
        {loading && <div className="text-sm text-ink-400" role="status">Cargando mensajes…</div>}
        {!loading && messages.length === 0 && (
          <div className="text-center text-sm text-ink-400">Sin mensajes.</div>
        )}

        {!loading && messages.length > 0 && hasMore && (
          <div className="text-center">
            <button
              type="button"
              onClick={onLoadOlder}
              disabled={loadingOlder}
              className="rounded-full border border-ink-200 bg-white px-3 py-1 text-[11px] font-semibold text-ink-600 transition-colors hover:bg-ink-50 disabled:opacity-60"
            >
              {loadingOlder ? 'Cargando…' : 'Ver mensajes anteriores'}
            </button>
          </div>
        )}
        {olderError && (
          <div className="text-center text-xs text-coral-600" role="alert">{olderError}</div>
        )}

        {messages.map((m, i) => (
          <Fragment key={m.id || i}>
            {needsDateSeparator(messages[i - 1], m) && (
              <div className="py-1 text-center">
                <span className="inline-block rounded-full bg-ink-100/90 px-3 py-1 text-[11px] font-medium text-ink-600">
                  {dayLabel(m.createdAt)}
                </span>
              </div>
            )}
            <MessageBubble
              m={m}
              tenantId={tenantId}
              attachmentsById={attachmentsById}
              attachmentsLoading={attachmentsLoading}
              attachmentsFailed={attachmentsFailed}
              onRetryAttachments={onRetryAttachments}
              role={role}
              orders={orders}
              onAttachmentChanged={onAttachmentChanged}
            />
          </Fragment>
        ))}
      </div>

      {!atBottom && messages.length > 0 && (
        <button
          type="button"
          onClick={() => irAlFinal(true)}
          className="absolute bottom-3 right-3 rounded-full border border-ink-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-ink-700 shadow-card transition-colors hover:bg-ink-50"
        >
          ↓ Ir al mensaje más reciente
        </button>
      )}
    </div>
  );
}
