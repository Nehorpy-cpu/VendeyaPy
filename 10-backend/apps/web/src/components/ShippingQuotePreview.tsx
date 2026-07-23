'use client';

/**
 * ShippingQuotePreview — SHIPPING-CHAT-2B (capa presentacional pura) + HARDEN-1.
 * Preview del costo de envío que el vendedor escribe en el chat, para revisarlo antes de enviarlo y
 * aprobar la cobertura. Componente CONTROLADO y SIN efectos externos: sin useQuery, sin Firebase,
 * sin httpsCallable, sin useAuth, sin tenantId/customerId, sin PII (nunca dirección/coordenadas/banco).
 *
 * HARDEN-1: (a) config de máximo inválida no bloquea mensajes comunes (intención re-clasificada en la
 * derivación); (b) AISLAMIENTO por conversación — un resultado de OTRO request no se muestra; (c) doble
 * clic local acotado al payload exacto; (d) spinner respeta reducción de movimiento.
 * La autoridad final (parseo, idempotencia) es SHIPPING-CHAT-3.
 */
import { useEffect, useId, useRef } from 'react';
import {
  deriveShippingQuote,
  formatGs,
  SEND_ERROR_TEXT,
  type ShippingDraftContext,
  type ShippingSendState,
  type ShippingConfirmPayload,
} from '@/lib/shippingQuote';

export interface ShippingQuotePreviewProps {
  /** Contexto saneado (sin PII). */
  context: ShippingDraftContext;
  /** Ciclo de vida del envío/aprobación, controlado por el padre (todo estado no-idle lleva requestId). */
  send: ShippingSendState;
  /** Confirmar: entrega el payload compatible con Omit<CoverageQuoteAndApproveInput,'tenantId'>. */
  onConfirm: (payload: ShippingConfirmPayload) => void;
  /** Volver a editar el borrador (el padre enfoca el composer). */
  onKeepEditing: () => void;
  /** Atajo "Informar costo de envío" (el padre arma el borrador — este componente NO escribe el composer). */
  onShortcut: () => void;
  /** Abrir/enfocar el historial del chat (usado por `unknown`: no ofrece reintento). */
  onReviewHistory: () => void;
  /** HARDEN-2 (A): bloqueo EXTERNO (otra acción del mismo request en vuelo — decisión o
   *  resolución manual). Deshabilita la confirmación; un clic bloqueado NO consume la guarda de
   *  doble clic, así el mismo payload puede confirmarse legítimamente al liberarse el bloqueo. */
  actionsBlocked?: boolean;
}

const shell = 'border-t border-sky-100 bg-sky-50/60 px-4 py-3 text-xs';
const eyebrow = 'flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide';
const btnPrimary = 'rounded-lg bg-mint-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-mint-500 disabled:opacity-50';
const btnGhost = 'rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-semibold text-ink-700 transition-colors hover:bg-ink-50';
const chipOk = 'rounded-full border border-mint-100 bg-mint-50 px-2 py-0.5 text-[11px] font-medium text-mint-700';

/** Emoji decorativo, oculto para lectores de pantalla (decisión 12). */
function Icon({ children }: { children: string }) {
  return <span aria-hidden="true">{children}</span>;
}

function MoneyRows({ shipping, products, total }: { shipping: string; products: string; total: string }) {
  return (
    <dl className="mt-2 grid gap-0.5">
      <div className="flex items-center justify-between gap-4">
        <dt className="text-ink-600">Costo de envío</dt>
        <dd className="font-mono font-semibold tabular-nums text-ink-900">₲ {shipping}</dd>
      </div>
      <div className="flex items-center justify-between gap-4">
        <dt className="text-ink-600">Productos</dt>
        <dd className="font-mono font-semibold tabular-nums text-ink-900">₲ {products}</dd>
      </div>
      <div className="mt-1 flex items-center justify-between gap-4 border-t border-ink-100 pt-1.5">
        <dt className="font-bold text-ink-900">Total final</dt>
        <dd className="font-mono text-sm font-bold tabular-nums text-mint-700">₲ {total}</dd>
      </div>
    </dl>
  );
}

export function ShippingQuotePreview({ context, send, onConfirm, onKeepEditing, onShortcut, onReviewHistory, actionsBlocked = false }: ShippingQuotePreviewProps) {
  const vm = deriveShippingQuote(context);
  const canonId = useId();
  const msgId = useId();
  const errId = useId();
  const unkId = useId();

  // HARDEN-1 (C): doble clic real. Guarda local acotada al payload EXACTO (requestId + fingerprints +
  // borrador + monto). Un segundo clic con el mismo payload no vuelve a llamar onConfirm, aunque el padre
  // todavía no haya re-renderizado con `sending`. Cambiar request/fingerprints/borrador ⇒ payload distinto
  // ⇒ se permite de nuevo. Al volver el padre a `idle` (ciclo cerrado) se reinicia. Sin efectos de red.
  const submittedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (send.status === 'idle') submittedKeyRef.current = null;
  }, [send.status]);
  const confirmOnce = () => {
    if (!vm.payload) return;
    // HARDEN-2 (A): bloqueo externo ANTES de consumir la guarda — un clic bloqueado no puede
    // impedir el intento legítimo posterior con el mismo payload.
    if (actionsBlocked) return;
    const key = JSON.stringify(vm.payload);
    if (submittedKeyRef.current === key) return; // ya se envió este payload exacto
    onConfirm(vm.payload);
    // La guarda se consume DESPUÉS de entregar el payload (misma vuelta síncrona — el doble clic
    // real llega en un tick posterior): consumirla sin haber llamado dejaría un payload válido
    // inenviable para siempre si cualquier guard descartara el clic (review HARDEN-2).
    submittedKeyRef.current = key;
  };

  // HARDEN-1 (B): AISLAMIENTO — un resultado de envío de OTRA conversación jamás se muestra sobre este chat.
  const mine = send.status !== 'idle' && send.requestId === context.requestId;

  if (mine && send.status === 'sending') {
    return (
      <section aria-label="Cotización del costo de envío" className={shell}>
        <div className={eyebrow + ' text-sky-700'}>
          <Icon>💸</Icon> Enviando el costo al cliente
        </div>
        <p role="status" className="mt-1 text-ink-600">Estamos enviando el mensaje y aprobando la cobertura.</p>
        <div className="mt-2">
          <button type="button" disabled className={btnPrimary + ' inline-flex items-center gap-2'}>
            <span aria-hidden="true" className="inline-block h-3 w-3 animate-spin motion-reduce:animate-none rounded-full border-2 border-white/50 border-t-white" />
            Enviando y aprobando…
          </button>
        </div>
      </section>
    );
  }

  if (mine && send.status === 'sent') {
    return (
      <section aria-label="Cotización del costo de envío" className={shell}>
        <div className={eyebrow + ' text-mint-700'}>
          <Icon>✓</Icon> Costo enviado y cobertura aprobada
        </div>
        <p role="status" className="mt-1 font-semibold text-mint-700">
          Le enviamos el costo al cliente y aprobamos la cobertura. El pedido continúa con el total actualizado.
        </p>
        <p className="mt-1 text-ink-600">
          Envío <span className="font-mono tabular-nums">₲ {formatGs(send.shippingGs)}</span> · Total{' '}
          <span className="font-mono tabular-nums">₲ {formatGs(send.totalGs)}</span>
        </p>
      </section>
    );
  }

  // HARDEN-1 (B): unknown es su propio estado, con evidencia financiera OBLIGATORIA y SOLO "Revisar historial"
  // (nada de "Seguir editando" ni reintento inmediato — decisión 8).
  if (mine && send.status === 'unknown') {
    return (
      <section aria-label="Cotización del costo de envío" className={shell}>
        <div className={eyebrow + ' text-amber-700'}>
          <Icon>⚠</Icon> Envío sin confirmar
        </div>
        <p role="alert" id={unkId} className="mt-1 font-semibold text-amber-700">
          {SEND_ERROR_TEXT.unknown}
        </p>
        <p className="mt-2 rounded-lg border border-ink-100 bg-ink-50 px-2.5 py-2 text-ink-700">
          Intentaste enviar: “{send.canonical}” · Envío{' '}
          <span className="font-mono tabular-nums">₲ {formatGs(send.shippingGs)}</span> · Total{' '}
          <span className="font-mono tabular-nums">₲ {formatGs(send.totalGs)}</span>
        </p>
        <div className="mt-2">
          <button type="button" onClick={onReviewHistory} aria-describedby={unkId} className={btnGhost}>
            Revisar historial
          </button>
        </div>
      </section>
    );
  }

  if (mine && send.status === 'error') {
    return (
      <section aria-label="Cotización del costo de envío" className={shell}>
        <div className={eyebrow + ' text-coral-700'}>
          <Icon>⚠</Icon> No se pudo aprobar la cobertura
        </div>
        <p role="alert" id={errId} className="mt-1 font-semibold text-coral-700">
          {SEND_ERROR_TEXT[send.kind]}
        </p>
        <div className="mt-2">
          <button type="button" onClick={onKeepEditing} aria-describedby={errId} className={btnGhost}>
            Seguir editando
          </button>
        </div>
      </section>
    );
  }

  // A partir de acá (estado idle o resultado de OTRO request) aplica el gate de visibilidad de la revisión.
  if (!vm.visible) return null;

  // ---- Estado idle: feedback del borrador ----
  if (vm.expired) {
    return (
      <section aria-label="Cotización del costo de envío" className={shell}>
        <p role="status" className="text-amber-700">
          {SEND_ERROR_TEXT.expired}
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Cotización del costo de envío" className={shell}>
      {/* Atajo: siempre disponible como entrada para armar el mensaje (decisión 11: solo callback). */}
      <button
        type="button"
        onClick={onShortcut}
        className="inline-flex items-center gap-1.5 rounded-full border border-sky-100 bg-sky-50 px-2.5 py-1 text-[11px] font-bold text-sky-700 transition-colors hover:bg-sky-100"
      >
        <Icon>🧮</Icon> Informar costo de envío
      </button>

      {(vm.draftClass === 'valid_amount' || vm.draftClass === 'valid_free') && vm.canApprove && (
        <div className="mt-2">
          <div className={eyebrow + (vm.draftClass === 'valid_free' ? ' text-mint-700' : ' text-sky-700')}>
            <Icon>{vm.draftClass === 'valid_free' ? '✓' : '💸'}</Icon>
            {vm.draftClass === 'valid_free' ? 'Envío sin costo' : 'Costo de envío detectado en tu mensaje'}
          </div>
          <MoneyRows shipping={vm.shippingText ?? '—'} products={vm.subtotalText} total={vm.totalText ?? '—'} />
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className={chipOk}><Icon>✓</Icon> Ubicación revisada</span>
            <span className={chipOk}><Icon>✓</Icon> Carrito vigente</span>
          </div>
          <p id={canonId} className="mt-2 rounded-lg border border-ink-100 bg-ink-50 px-2.5 py-2 text-ink-700">
            <span className="mb-0.5 block text-[10px] font-bold uppercase tracking-wide text-ink-500">
              El cliente recibirá exactamente
            </span>
            {vm.canonical}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={confirmOnce} disabled={actionsBlocked} aria-describedby={canonId} className={btnPrimary}>
              Enviar costo y aprobar cobertura
            </button>
            <button type="button" onClick={onKeepEditing} className={btnGhost}>
              Seguir editando
            </button>
          </div>
        </div>
      )}

      {/* Bloqueo/error: cualquier caso no aprobable con mensaje (invalid_price_attempt, invalid_configuration,
          o un valid_* cuyo total no se pudo calcular por subtotal corrupto). */}
      {!vm.canApprove && vm.message && (
        <div className="mt-2">
          <div className={eyebrow + (vm.draftClass === 'invalid_configuration' ? ' text-amber-700' : ' text-coral-700')}>
            <Icon>⚠</Icon>
            {vm.draftClass === 'invalid_configuration' ? 'Configuración de envío inválida' : 'No pude confirmar un costo exacto'}
          </div>
          <p role="alert" id={msgId} className={'mt-1 font-semibold ' + (vm.draftClass === 'invalid_configuration' ? 'text-amber-700' : 'text-coral-700')}>
            {vm.message}
          </p>
          <div className="mt-2">
            <button type="button" onClick={onKeepEditing} aria-describedby={msgId} className={btnGhost}>
              Seguir editando
            </button>
          </div>
        </div>
      )}

      {vm.draftClass === 'idle_unrelated' && (
        <p role="status" className="mt-1.5 text-ink-500">
          Cuando escribas el costo de envío (ej: “el costo de envío para tu ubicación es ₲30.000”), va a aparecer acá para revisarlo antes de enviarlo.
        </p>
      )}
    </section>
  );
}
