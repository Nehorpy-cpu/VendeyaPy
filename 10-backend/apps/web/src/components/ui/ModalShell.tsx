'use client';

import { useEffect, useId, useRef } from 'react';
import { cn } from '@/lib/cn';

/**
 * Contenedor de modal con CONTENIDO libre (para diálogos que no son un confirmar/cancelar,
 * p. ej. el modal de vínculo de cliente). Mismo contrato de accesibilidad que ConfirmModal:
 * role="dialog" + aria-modal + aria-labelledby, foco inicial, trap de Tab, Escape y click en el
 * fondo cierran, y el foco vuelve al elemento que lo abrió.
 */
export function ModalShell({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previo = document.activeElement as HTMLElement | null;
    cardRef.current?.focus();
    return () => previo?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4" onClick={onClose}>
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          'flex max-h-[85vh] w-full flex-col rounded-2xl border border-ink-100 bg-white shadow-float focus:outline-none',
          wide ? 'max-w-lg' : 'max-w-sm',
        )}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={atraparTab}
      >
        <div className="flex items-center justify-between gap-2 border-b border-ink-100 px-5 py-3.5">
          <h3 id={titleId} className="text-base font-semibold text-ink-900">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="grid h-8 w-8 place-items-center rounded-lg text-ink-400 transition-colors hover:bg-ink-50 hover:text-ink-600"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
