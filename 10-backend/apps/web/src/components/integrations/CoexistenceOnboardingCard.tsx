'use client';

import { useState } from 'react';
import { ConfirmModal, StatusBadge } from '@/components/ui';

/**
 * Conectar el número que el negocio YA usa en la app de WhatsApp Business (ADR-0017 · Coexistence).
 *
 * Esta tarjeta existe porque el acto es distinto del alta de un número nuevo: del otro lado hay
 * clientes vivos, conversaciones abiertas y un vendedor contestando desde su teléfono. Por eso
 * dice, ANTES de tocar nada, qué conserva, qué pierde y —lo más importante— que el número **empieza
 * inactivo**: conectarlo no lo pone a responder solo.
 *
 * No hace I/O: recibe el disparador y lo llama DIRECTO en el click. Esa cadena importa — el popup
 * del Embedded Signup tiene que abrirse dentro del gesto del usuario o el navegador lo bloquea.
 */
const card = 'rounded-2xl border border-ink-100 bg-white p-5 shadow-soft';

export function CoexistenceOnboardingCard({
  configured,
  canOperate,
  pending,
  onConfirm,
}: {
  /** Hay `config_id` propio de Coexistence. Sin él la tarjeta explica por qué no se puede todavía. */
  configured: boolean;
  canOperate: boolean;
  pending: boolean;
  onConfirm: () => void;
}) {
  const [confirmando, setConfirmando] = useState(false);

  return (
    <div className={card}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-lg font-semibold text-ink-900">Conectar el número que ya usás</span>
          <StatusBadge tone="ink">Número real</StatusBadge>
        </div>
        {canOperate && configured && (
          <button
            onClick={() => setConfirmando(true)}
            disabled={pending}
            className="rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60"
          >
            {pending ? 'Conectando…' : 'Conectar el número que ya uso'}
          </button>
        )}
      </div>

      <p className="mt-3 text-sm text-ink-600">
        Si ya atendés a tus clientes desde la app de WhatsApp Business, podés conectar ese mismo número.
        Vos seguís contestando desde tu teléfono como siempre; el panel ve las conversaciones.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-mint-700">Lo que conservás</h3>
          <ul className="mt-2 space-y-1 text-sm text-ink-600">
            <li>Catálogo, pedidos, Status, perfil, etiquetas, grupos y llamadas siguen funcionando en tu app.</li>
            <li>Tus chats y contactos actuales no se borran.</li>
          </ul>
        </div>
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-700">Lo que cambia</h3>
          <ul className="mt-2 space-y-1 text-sm text-ink-600">
            <li>Las listas de difusión quedan de solo lectura: no vas a poder crear nuevas.</li>
            <li>Dejan de andar los mensajes temporales, el &quot;ver una vez&quot; y la ubicación en vivo.</li>
            <li>Los dispositivos vinculados se desvinculan durante la conexión y hay que volver a vincularlos.</li>
          </ul>
        </div>
      </div>

      <p className="mt-4 rounded-xl bg-ink-50 px-4 py-2.5 text-sm text-ink-700">
        El número empieza inactivo: no automatizamos nada hasta que vos lo actives en un paso aparte.
      </p>

      {!configured ? (
        <p className="mt-3 text-xs text-ink-400">
          Esta opción todavía no está habilitada para tu empresa. Te avisamos cuando esté disponible.
        </p>
      ) : !canOperate ? (
        <p className="mt-3 text-xs text-ink-400">Solo el dueño o un administrador pueden conectar el número.</p>
      ) : null}

      {confirmando && (
        <ConfirmModal
          title="Conectar tu número de WhatsApp Business"
          confirmLabel="Sí, conectar mi número"
          onConfirm={() => {
            // El disparo va DIRECTO en el click: el popup de Meta tiene que abrirse dentro del
            // gesto del usuario. Cualquier `await` en el medio hace que el navegador lo bloquee.
            setConfirmando(false);
            onConfirm();
          }}
          onCancel={() => setConfirmando(false)}
        >
          Vas a conectar el número que ya usás con tus clientes. Se te va a abrir una ventana de Meta y puede
          pedirte confirmar desde tu teléfono. Al terminar, el número queda conectado pero <strong>inactivo</strong>.
        </ConfirmModal>
      )}
    </div>
  );
}
