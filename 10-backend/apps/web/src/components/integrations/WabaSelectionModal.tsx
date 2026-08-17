'use client';

import { useState } from 'react';
import { ConfirmModal } from '@/components/ui';
import type { WabaOption } from '@/lib/integrations';

/**
 * Selector de WABA (ADR-0020 · G2). Aparece cuando el token del Embedded Signup autoriza VARIAS
 * cuentas de WhatsApp Business: el `code` ya fue canjeado (single-flight), así que no existe el
 * «reintentá» — o el owner elige acá, o rehace el login de Meta.
 *
 * Dos estados, excluyentes:
 *  - ELEGIR: radio-list saneada (nombre + id ENMASCARADO — el id completo jamás se muestra),
 *    Conectar deshabilitado hasta elegir y mientras hay un envío en curso (doble click bloqueado).
 *  - SELECCIÓN PERDIDA (vencida/replay/wabaId inválido): mensaje honesto + CTA que RELANZA la
 *    conexión. El CTA corre en el gesto del click (el caller abre el popup sincrónicamente).
 *
 * La accesibilidad base (dialog + foco inicial + trap + Escape) la pone ConfirmModal.
 */
const enmascarar = (id: string) => `…${id.slice(-4)}`;

export function WabaSelectionModal({
  wabas,
  pending,
  expired,
  error,
  onConfirm,
  onCancel,
  onRetryLogin,
}: {
  wabas: WabaOption[];
  pending: boolean;
  /** La selección ya no sirve en el backend: solo queda rehacer el login de Meta. */
  expired: boolean;
  /** Error RECUPERABLE (texto ya amable): se muestra sin cerrar el modal. */
  error: string | null;
  onConfirm: (wabaId: string) => void;
  onCancel: () => void;
  /** DEBE relanzar la conexión sincrónicamente (popup dentro del gesto del usuario). */
  onRetryLogin: () => void;
}) {
  const [elegido, setElegido] = useState<string | null>(wabas.length === 1 ? (wabas[0]?.id ?? null) : null);

  if (expired) {
    return (
      <ConfirmModal
        title="La elección de cuenta venció"
        confirmLabel="Rehacer el login de Meta"
        cancelLabel="Ahora no"
        onConfirm={onRetryLogin}
        onCancel={onCancel}
      >
        Pasó demasiado tiempo desde la autorización, o la elección ya se usó. Por seguridad no se
        conectó nada: para elegir la cuenta hay que rehacer el login de Meta y volver a este paso.
      </ConfirmModal>
    );
  }

  return (
    <ConfirmModal
      title="Tu cuenta tiene varias cuentas de WhatsApp Business — elegí cuál conectar"
      confirmLabel="Conectar"
      cancelLabel="Cancelar"
      pending={pending}
      confirmDisabled={!elegido}
      onConfirm={() => {
        if (elegido && !pending) onConfirm(elegido);
      }}
      onCancel={onCancel}
      error={error}
    >
      <fieldset disabled={pending} className="m-0 border-0 p-0">
        <legend className="text-sm text-ink-600">
          Vamos a conectar una sola. Las demás quedan como están dentro de Meta.
        </legend>
        <div role="radiogroup" aria-label="Cuenta de WhatsApp Business a conectar" className="mt-3 space-y-2">
          {wabas.map((w) => (
            <label
              key={w.id}
              className={
                'flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors ' +
                (elegido === w.id ? 'border-mint-500 bg-mint-50' : 'border-ink-200 hover:bg-ink-50')
              }
            >
              {/* onChange cubre teclado; onClick, además, entornos donde el click no dispara la
                  acción por defecto del radio (happy-dom). Idempotentes entre sí. */}
              <input
                type="radio"
                name="waba-a-conectar"
                value={w.id}
                checked={elegido === w.id}
                onChange={() => setElegido(w.id)}
                onClick={() => setElegido(w.id)}
                className="h-4 w-4 accent-mint-600"
              />
              <span className="min-w-0 flex-1 truncate font-medium text-ink-800">{w.name}</span>
              <span className="shrink-0 text-xs text-ink-500">{enmascarar(w.id)}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </ConfirmModal>
  );
}
