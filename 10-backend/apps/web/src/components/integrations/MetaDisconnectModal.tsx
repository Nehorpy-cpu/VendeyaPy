'use client';

import { useId, useState } from 'react';
import { ConfirmModal } from '@/components/ui';

const PALABRA = 'DESCONECTAR';

/**
 * Confirmación FUERTE de desconexión (ADR-0020 · G3/G12 en la UI) — para `main` y para un número
 * Coexistence propio. No es un window.confirm: exige tipear DESCONECTAR (exacto) porque del otro
 * lado hay clientes escribiendo, y explica lo que de verdad pasa:
 *  - EN VendeYaPy se corta el ruteo de mensajes y la automatización.
 *  - DENTRO de Meta no se elimina nada: ni la cuenta de WhatsApp Business, ni el número, ni el
 *    catálogo (ADR-0020 §4: la revocación remota deliberadamente no existe). Se puede reconectar.
 * El botón destructivo queda deshabilitado hasta que la palabra coincida EXACTO.
 */
export function MetaDisconnectModal({
  numberName,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  /** Nombre del número Coexistence a dar de baja; null ⇒ se desconecta la conexión principal. */
  numberName: string | null;
  pending: boolean;
  /** Error ya amable; se muestra sin cerrar el modal (reintentable). */
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [texto, setTexto] = useState('');
  const inputId = useId();
  const coincide = texto === PALABRA;
  const esNumero = numberName !== null;

  return (
    <ConfirmModal
      title={esNumero ? `Desconectar el número ${numberName}` : 'Desconectar Meta de VendeYaPy'}
      confirmLabel="Sí, desconectar"
      cancelLabel="Cancelar"
      danger
      pending={pending}
      confirmDisabled={!coincide}
      onConfirm={() => {
        if (coincide && !pending) onConfirm();
      }}
      onCancel={onCancel}
      error={error}
    >
      <p>
        {esNumero
          ? 'Este número deja de recibir y responder mensajes desde VendeYaPy: se corta su ruteo y su automatización.'
          : 'La empresa deja de recibir y responder WhatsApp desde VendeYaPy: se corta el ruteo de mensajes y la automatización.'}
      </p>
      <p className="mt-2">
        <strong>No se elimina nada dentro de Meta</strong>: ni la cuenta de WhatsApp Business, ni el
        número, ni el catálogo. Podés reconectar cuando quieras.
      </p>
      <label htmlFor={inputId} className="mt-4 block text-xs font-semibold text-ink-700">
        Escribí {PALABRA} para confirmar
      </label>
      <input
        id={inputId}
        type="text"
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        disabled={pending}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        placeholder={PALABRA}
        className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm tracking-wide text-ink-900 focus:border-coral-500 focus:outline-none focus:ring-2 focus:ring-coral-500/30 disabled:opacity-60"
      />
    </ConfirmModal>
  );
}
