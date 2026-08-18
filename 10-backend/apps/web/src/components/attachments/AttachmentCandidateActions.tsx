'use client';

/**
 * Acciones HUMANAS sobre la clasificación de un adjunto (ADR-0016 §3 y §5 · Área D).
 *
 * REGLA QUE ESTA UI TIENE QUE CONTAR BIEN: "Posible comprobante" es una SUGERENCIA. No es un
 * comprobante, no movió el pedido y no confirmó ningún pago. Recién cuando una persona autorizada
 * elige un pedido y marca, el adjunto queda vinculado y el pedido pasa a verificación — y ni
 * siquiera eso confirma el pago.
 *
 * AMBIGÜEDAD: si el cliente tiene más de un pedido admisible, la UI OBLIGA a elegir cuál. Adivinar
 * es exactamente lo que rompía el flujo viejo.
 */

import { useId, useMemo, useState } from 'react';
import type { Order } from '@vpw/shared';
import { cn } from '@/lib/cn';
import {
  autorClasificacion,
  classificationLabel,
  fechaCorta,
  friendlyAttachmentError,
  isLinkedReceipt,
  isReceiptCandidate,
  markAttachmentAsReceipt,
  pedidosElegiblesParaComprobante,
  puedeDesmarcarComprobante,
  puedeMarcarComprobante,
  unmarkAttachmentReceipt,
  type PanelAttachment,
} from '@/lib/attachments';
import { ORDER_STATUS_LABEL } from '@/lib/orders';
import type { Role } from '@/lib/auth-context';

const guaranies = (n: number | null | undefined) =>
  n == null ? '—' : '₲ ' + Math.round(n).toLocaleString('es-PY');

/** Id corto y legible del pedido. No es PII: es un id interno del tenant. */
const idCorto = (id: string) => (id.length > 12 ? `${id.slice(0, 12)}…` : id);

function ResumenPedido({ order }: { order: Order }) {
  const unidades = order.items?.reduce((s, i) => s + i.quantity, 0) ?? 0;
  return (
    <div className="mt-1.5 rounded-lg border border-ink-100 bg-white px-3 py-2 text-[11px] text-ink-600">
      <div className="font-semibold text-ink-800">
        Pedido <span className="font-mono">{idCorto(order.id)}</span> ·{' '}
        {ORDER_STATUS_LABEL[order.status] ?? order.status}
      </div>
      <div className="mt-0.5">
        {unidades} {unidades === 1 ? 'unidad' : 'unidades'} · Total {guaranies(order.totals?.total)}
      </div>
      {order.items?.slice(0, 3).map((i) => (
        <div key={i.itemId} className="mt-0.5 truncate text-ink-500">
          {i.quantity}× {i.productName}
        </div>
      ))}
      {(order.items?.length ?? 0) > 3 && (
        <div className="mt-0.5 text-ink-400">y {order.items.length - 3} más…</div>
      )}
      <a href="/orders" className="mt-1 inline-block font-semibold text-mint-700 hover:underline">
        Abrir en Pedidos →
      </a>
    </div>
  );
}

export function AttachmentCandidateActions({
  tenantId,
  attachment,
  role,
  orders,
  onChanged,
}: {
  tenantId: string;
  attachment: PanelAttachment;
  role: Role | null;
  /** Pedidos abiertos del cliente (los trae la conversación). */
  orders: readonly Order[];
  /** Refresca adjuntos + pedidos después de una acción humana. */
  onChanged: () => void;
}) {
  const selectId = useId();
  const panelId = useId();

  const candidato = useMemo(
    () => orders.find((o) => o.id === attachment.orderCandidateId) ?? null,
    [orders, attachment.orderCandidateId],
  );
  const elegibles = useMemo(
    () => pedidosElegiblesParaComprobante(orders, attachment.customerId),
    [orders, attachment.customerId],
  );

  const puedeMarcar = puedeMarcarComprobante(attachment, role);
  const puedeDesmarcar = puedeDesmarcarComprobante(attachment, candidato, role);
  const ambiguo = elegibles.length > 1;

  const [verPedido, setVerPedido] = useState(false);
  const [modo, setModo] = useState<'idle' | 'marcar' | 'desmarcar'>('idle');
  // Sin preselección cuando hay ambigüedad: elegir por el vendedor es adivinar.
  const [orderId, setOrderId] = useState<string>(() =>
    elegibles.length === 1 ? elegibles[0]!.id : '',
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cerrar = () => {
    setModo('idle');
    setError(null);
  };

  const confirmarMarcar = async () => {
    if (!orderId || pending) return;
    setPending(true);
    setError(null);
    try {
      await markAttachmentAsReceipt(tenantId, attachment.attachmentId, orderId);
      cerrar();
      onChanged();
    } catch (e) {
      setError(friendlyAttachmentError(e));
    } finally {
      setPending(false);
    }
  };

  const confirmarDesmarcar = async () => {
    // Desmarcar es SIEMPRE sobre un pedido concreto: sin pedido a la vista no hay acción posible.
    if (!candidato || pending) return;
    setPending(true);
    setError(null);
    try {
      await unmarkAttachmentReceipt(tenantId, attachment.attachmentId, candidato.id);
      cerrar();
      onChanged();
    } catch (e) {
      setError(friendlyAttachmentError(e));
    } finally {
      setPending(false);
    }
  };

  const esCandidato = isReceiptCandidate(attachment);
  const esVinculado = isLinkedReceipt(attachment);

  return (
    <div className="mt-2 border-t border-ink-100 pt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {esCandidato && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
            🧾 Posible comprobante
          </span>
        )}
        {esVinculado && (
          <span className="rounded-full bg-mint-100 px-2 py-0.5 text-[10px] font-semibold text-mint-800">
            🧾 Comprobante vinculado
          </span>
        )}
        {/* ADR-0019: desenlace discreto del análisis visual. Solo estado saneado + nombre del
            producto si hubo match único — jamás confianza técnica, prompts ni rutas. Un
            comprobante nunca trae este chip (la visión no corre sobre comprobantes). */}
        {attachment.vision && (
          <span
            aria-live="polite"
            className={
              attachment.vision.state === 'identificado'
                ? 'rounded-full bg-mint-100 px-2 py-0.5 text-[10px] font-semibold text-mint-800'
                : 'rounded-full bg-ink-50 px-2 py-0.5 text-[10px] font-semibold text-ink-600'
            }
          >
            {attachment.vision.state === 'identificado'
              ? `📸 Producto identificado${attachment.vision.productName ? `: ${attachment.vision.productName}` : ''}`
              : attachment.vision.state === 'aclaracion'
                ? '📸 Necesita aclaración'
                : attachment.vision.state === 'sin_match'
                  ? '📸 Sin coincidencia en el catálogo'
                  : '📸 No analizado'}
          </span>
        )}
        {/* Chip navegable: abre el pedido ACÁ MISMO. Nadie tiene que irse a la pantalla de Pedidos
            para saber de qué pedido se está hablando. */}
        {attachment.orderCandidateId && (
          <button
            type="button"
            onClick={() => setVerPedido((v) => !v)}
            aria-expanded={verPedido}
            aria-controls={panelId}
            className="rounded-full border border-ink-200 bg-white px-2 py-0.5 font-mono text-[10px] text-ink-600 transition-colors hover:bg-ink-50"
          >
            📦 {idCorto(attachment.orderCandidateId)}
          </button>
        )}
      </div>

      {esCandidato && (
        <p className="mt-1 text-[11px] text-ink-500">
          Es una sugerencia del sistema: el pedido sigue esperando el pago y nadie confirmó nada
          todavía.
        </p>
      )}

      <div id={panelId} hidden={!verPedido}>
        {verPedido &&
          (candidato ? (
            <ResumenPedido order={candidato} />
          ) : (
            <p className="mt-1.5 rounded-lg border border-ink-100 bg-white px-3 py-2 text-[11px] text-ink-500">
              Este pedido ya no está entre los abiertos del cliente.{' '}
              <a href="/orders" className="font-semibold text-mint-700 hover:underline">
                Buscarlo en Pedidos →
              </a>
            </p>
          ))}
      </div>

      {/* ── Acciones humanas ── */}
      {modo === 'idle' && (puedeMarcar || puedeDesmarcar) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {puedeMarcar && (
            <button
              type="button"
              onClick={() => setModo('marcar')}
              className="rounded-lg bg-mint-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-mint-700"
            >
              Marcar como comprobante
            </button>
          )}
          {puedeDesmarcar && (
            <button
              type="button"
              onClick={() => setModo('desmarcar')}
              className="rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-xs font-semibold text-ink-700 transition-colors hover:bg-ink-50"
            >
              Desmarcar
            </button>
          )}
        </div>
      )}

      {modo === 'marcar' && (
        <div className="mt-2 rounded-xl border border-ink-100 bg-white p-3">
          {elegibles.length === 0 ? (
            <p className="text-[11px] text-ink-600">
              Este cliente no tiene ningún pedido esperando pago. Creá o reabrí el pedido antes de
              vincular el comprobante.
            </p>
          ) : (
            <>
              <label htmlFor={selectId} className="block text-[11px] font-semibold text-ink-700">
                {ambiguo
                  ? 'El cliente tiene más de un pedido abierto: elegí a cuál corresponde'
                  : 'Se va a vincular a este pedido'}
              </label>
              <select
                id={selectId}
                value={orderId}
                onChange={(e) => setOrderId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-ink-200 px-2 py-1.5 text-xs text-ink-900 outline-none focus:border-mint-500"
              >
                {/* Con ambigüedad el placeholder queda seleccionado: no hay default posible. */}
                {ambiguo && <option value="">Elegí un pedido…</option>}
                {elegibles.map((o) => (
                  <option key={o.id} value={o.id}>
                    {idCorto(o.id)} · {ORDER_STATUS_LABEL[o.status] ?? o.status} ·{' '}
                    {guaranies(o.totals?.total)}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-[11px] text-ink-500">
                El pedido pasa a “Comprobante por verificar”. Esto NO confirma el pago: revisá el
                monto y confirmalo desde Pedidos.
              </p>
            </>
          )}
          {error && (
            <p role="alert" className="mt-2 rounded-lg bg-coral-50 px-2 py-1.5 text-[11px] text-coral-700">
              {error}
            </p>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={cerrar}
              className="rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 transition-colors hover:bg-ink-50"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={confirmarMarcar}
              disabled={!orderId || pending}
              className={cn(
                'rounded-lg bg-mint-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-mint-700',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              {pending ? 'Vinculando…' : 'Confirmar'}
            </button>
          </div>
        </div>
      )}

      {modo === 'desmarcar' && (
        <div className="mt-2 rounded-xl border border-ink-100 bg-white p-3">
          <p className="text-[11px] font-semibold text-ink-700">
            Desvincular este archivo del pedido{' '}
            <span className="font-mono">{candidato ? idCorto(candidato.id) : ''}</span>
          </p>
          <p className="mt-1.5 text-[11px] text-ink-500">
            El archivo se conserva como medio normal del chat: no se borra nada. Queda registrado
            en la auditoría quién lo desmarcó y cuándo.
          </p>
          {error && (
            <p role="alert" className="mt-2 rounded-lg bg-coral-50 px-2 py-1.5 text-[11px] text-coral-700">
              {error}
            </p>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={cerrar}
              className="rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 transition-colors hover:bg-ink-50"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={confirmarDesmarcar}
              disabled={!candidato || pending}
              className="rounded-lg bg-coral-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-coral-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? 'Desmarcando…' : 'Sí, desmarcar'}
            </button>
          </div>
        </div>
      )}

      {/* ── Auditoría: quién clasificó y cuándo. No se borra ni se reescribe. ── */}
      <dl className="mt-2 space-y-0.5 text-[10px] text-ink-400">
        <div>
          <dt className="inline font-semibold">Recibido:</dt>{' '}
          <dd className="inline">{fechaCorta(attachment.createdAt) || 'sin fecha'}</dd>
        </div>
        <div>
          <dt className="inline font-semibold">Clasificación:</dt>{' '}
          <dd className="inline">
            {classificationLabel(attachment.classification?.value, attachment.direction)} — la puso{' '}
            {autorClasificacion(attachment)}
            {fechaCorta(attachment.classification?.at)
              ? ` el ${fechaCorta(attachment.classification?.at)}`
              : ''}
          </dd>
        </div>
      </dl>
    </div>
  );
}
