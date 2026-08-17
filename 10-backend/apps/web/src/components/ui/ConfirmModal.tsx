'use client';

import { useEffect, useId, useRef } from 'react';
import { cn } from '@/lib/cn';

/**
 * Modal de confirmación consistente (overlay + card). Cierra al tocar el fondo o con Escape.
 * Accesible: role="dialog" + aria-modal + aria-labelledby, foco inicial en el diálogo, trap
 * básico de Tab (el foco no se escapa a la página tapada) y devolución del foco al elemento
 * que lo abrió (el diálogo se monta/desmonta, no se oculta).
 */
export function ConfirmModal({
  title,
  children,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  onConfirm,
  onCancel,
  pending = false,
  danger = false,
  /** Bloquea SOLO el botón de confirmar (p. ej. hasta elegir una opción o tipear la palabra). */
  confirmDisabled = false,
  error,
}: {
  title: string;
  children?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  pending?: boolean;
  danger?: boolean;
  confirmDisabled?: boolean;
  error?: string | null;
}) {
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);

  // Foco inicial en el diálogo y devolución al abrirlo/cerrarlo (mismo patrón que ProductForm).
  useEffect(() => {
    const previo = document.activeElement as HTMLElement | null;
    cardRef.current?.focus();
    return () => previo?.focus?.();
  }, []);

  // Escape cierra (salvo que haya una operación en curso: cerrar a mitad sería mentirle al usuario).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pending) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, pending]);

  // Trap básico de Tab: al llegar al borde del diálogo, el foco da la vuelta en vez de irse a la
  // página tapada por el overlay (que sigue en el DOM y sería operable a ciegas).
  const atraparTab = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const focusables = cardRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables || focusables.length === 0) return;
    const primero = focusables[0]!;
    const ultimo = focusables[focusables.length - 1]!;
    if (e.shiftKey && (document.activeElement === primero || document.activeElement === cardRef.current)) {
      e.preventDefault();
      ultimo.focus();
    } else if (!e.shiftKey && document.activeElement === ultimo) {
      e.preventDefault();
      primero.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4" onClick={onCancel}>
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-full max-w-sm rounded-2xl border border-ink-100 bg-white p-6 shadow-float focus:outline-none"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={atraparTab}
      >
        <h3 id={titleId} className="text-base font-semibold text-ink-900">{title}</h3>
        {children && <div className="mt-2 text-sm text-ink-600">{children}</div>}
        {error && <p role="alert" className="mt-3 rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">{error}</p>}
        <div className="mt-5 flex justify-end gap-3">
          <button onClick={onCancel} className="rounded-lg border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50">
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={pending || confirmDisabled}
            className={cn(
              'rounded-lg px-4 py-2 text-sm font-semibold text-white transition-colors disabled:opacity-60',
              danger ? 'bg-coral-600 hover:bg-coral-700' : 'bg-mint-600 hover:bg-mint-700',
            )}
          >
            {pending ? '…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
