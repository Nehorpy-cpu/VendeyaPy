'use client';

import { cn } from '@/lib/cn';

/** Modal de confirmación consistente (overlay + card). Cierra al tocar el fondo. */
export function ConfirmModal({
  title,
  children,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  onConfirm,
  onCancel,
  pending = false,
  danger = false,
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
  error?: string | null;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4" onClick={onCancel}>
      <div className="w-full max-w-sm rounded-2xl border border-ink-100 bg-white p-6 shadow-float" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-ink-900">{title}</h3>
        {children && <div className="mt-2 text-sm text-ink-600">{children}</div>}
        {error && <p className="mt-3 rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">{error}</p>}
        <div className="mt-5 flex justify-end gap-3">
          <button onClick={onCancel} className="rounded-lg border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50">
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={pending}
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
