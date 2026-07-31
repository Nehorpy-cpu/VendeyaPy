'use client';

/**
 * Comprobantes de un pedido dentro del panel de Pedidos (ADR-0016 §3, §5 y §7 · Área C).
 *
 * EL AGUJERO QUE TAPA: la tarjeta "🧾 Comprobante recibido" del detalle estaba gateada por
 * `payment.comprobanteUrl`. Cuando un vendedor marca un comprobante desde Conversaciones el
 * vínculo se escribe como adjunto (`receiptAttachments`), así que el pedido —el lugar donde se
 * decide el pago— no mostraba NADA. Acá se leen las dos superficies y el archivo se abre por
 * `attachmentId` con el mismo visor seguro del chat.
 *
 * LA DISTINCIÓN QUE ESTA UI TIENE QUE CONTAR BIEN (es el corazón del ADR): un CANDIDATO es una
 * sugerencia automática — no es comprobante, no movió el pedido y nadie confirmó nada. Un
 * VINCULADO lo eligió una persona autorizada, y ni siquiera eso confirma el pago. Pintarlos igual
 * volvería a mezclar los dos ejes que el ADR separa a propósito.
 *
 * SEGURIDAD DE LA UI: acá no entra ni una ruta de Storage ni una URL firmada. Lo que se recibe ya
 * viene proyectado (`PanelAttachment`) y los bytes salen únicamente por el callable que firma un
 * enlace de vida corta, que vive solo en memoria del visor.
 */

import { useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Order } from '@vpw/shared';
import {
  attachmentDisplayName,
  attachmentErrorHint,
  attachmentTypeLabel,
  attachmentUiState,
  autorClasificacion,
  fechaCorta,
  formatAttachmentSize,
  isImageAttachment,
  type PanelAttachment,
} from '@/lib/attachments';
import {
  friendlyOrderAttachmentError,
  listAttachmentsByIds,
  readOrderReceiptRefs,
  separarAdjuntosDelCliente,
} from '@/lib/orderReceipts';
import { admiteComprobante, comprobanteEstado } from '@/lib/orders';
import { AttachmentViewer } from '@/components/attachments/AttachmentViewer';

/**
 * Marco de la sección: mismo tono en todos los estados para que no salte el layout.
 * El título es el nombre accesible de la región (no un `aria-label` duplicado): así el lector de
 * pantalla anuncia lo mismo que se lee en la pantalla.
 */
function Seccion({ children }: { children: React.ReactNode }) {
  const tituloId = useId();
  return (
    <section aria-labelledby={tituloId} className="mt-4 rounded-xl border border-ink-100 bg-white p-4">
      <h3 id={tituloId} className="text-xs font-semibold uppercase tracking-wide text-ink-400">
        Comprobantes del pedido
      </h3>
      {children}
    </section>
  );
}

function Etiqueta({ tono, children }: { tono: 'vinculado' | 'candidato'; children: React.ReactNode }) {
  return (
    <span
      className={
        'inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ' +
        (tono === 'vinculado' ? 'bg-mint-100 text-mint-800' : 'bg-amber-100 text-amber-800')
      }
    >
      {children}
    </span>
  );
}

function TarjetaAdjunto({
  tenantId,
  a,
  vinculado,
  mueveElEstado,
}: {
  tenantId: string;
  a: PanelAttachment;
  vinculado: boolean;
  mueveElEstado: boolean;
}) {
  const [abierto, setAbierto] = useState(false);
  const estado = attachmentUiState(a);

  return (
    <li className="rounded-xl border border-ink-100 bg-ink-50/40 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Etiqueta tono={vinculado ? 'vinculado' : 'candidato'}>
              {vinculado ? '🧾 Comprobante vinculado' : '🕵️ Posible comprobante'}
            </Etiqueta>
            {mueveElEstado && (
              <span className="text-[11px] text-ink-500">Es el que puso el pedido en verificación</span>
            )}
          </div>
          <p className="mt-1 truncate text-sm font-semibold text-ink-900">{attachmentDisplayName(a)}</p>
          <p className="text-xs text-ink-500">
            {attachmentTypeLabel(a)} · {formatAttachmentSize(a.bytes)}
          </p>
        </div>
        {/* Sin bytes guardados no hay nada que abrir: el botón no se ofrece para no prometer de más. */}
        {estado === 'ready' && (
          <button
            type="button"
            onClick={() => setAbierto(true)}
            className="shrink-0 rounded-lg bg-mint-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-mint-700"
          >
            {isImageAttachment(a) ? 'Ver comprobante' : 'Ver documento'}
          </button>
        )}
      </div>

      {estado === 'loading' && (
        <p role="status" className="mt-2 rounded-lg bg-white px-2 py-1.5 text-[11px] text-ink-500">
          Todavía estamos recibiendo este archivo del cliente.
        </p>
      )}
      {estado === 'error' && (
        <div className="mt-2 rounded-lg bg-amber-50 px-2 py-1.5">
          <p role="alert" className="text-[11px] text-amber-800">
            {attachmentErrorHint(a)}
          </p>
          {a.lastError && <p className="mt-1 text-[10px] text-amber-700/80">{a.lastError}</p>}
        </div>
      )}

      <p className="mt-2 text-[11px] text-ink-500">
        {vinculado
          ? 'Verificá el monto antes de confirmar el pago: vincular un archivo no confirma nada.'
          : 'Es una sugerencia del sistema: el pedido sigue esperando el pago y nadie confirmó nada todavía. Para vincularlo, abrí la conversación del cliente.'}
      </p>
      {!vinculado && (
        <a href="/conversations" className="mt-1 inline-block text-[11px] font-semibold text-mint-700 hover:underline">
          Abrir Conversaciones →
        </a>
      )}

      {a.caption?.trim() && (
        <p className="mt-2 whitespace-pre-wrap rounded-lg bg-white px-2 py-1.5 text-xs text-ink-700">{a.caption}</p>
      )}

      {/* Auditoría: quién clasificó y cuándo. No se borra ni se reescribe (ADR-0016 §3). */}
      <dl className="mt-2 text-[10px] text-ink-400">
        <div>
          <dt className="inline font-semibold">Recibido:</dt>{' '}
          <dd className="inline">{fechaCorta(a.createdAt) || 'sin fecha'}</dd>
        </div>
        <div>
          <dt className="inline font-semibold">Clasificación:</dt>{' '}
          <dd className="inline">
            la puso {autorClasificacion(a)}
            {fechaCorta(a.classification?.at) ? ` el ${fechaCorta(a.classification?.at)}` : ''}
          </dd>
        </div>
      </dl>

      {abierto && (
        <AttachmentViewer tenantId={tenantId} attachment={a} onClose={() => setAbierto(false)} />
      )}
    </li>
  );
}

export function OrderReceipts({ tenantId, order }: { tenantId: string; order: Order }) {
  const refs = useMemo(() => readOrderReceiptRefs(order), [order]);
  // La clave incluye los ids: si el pedido gana un comprobante, la lectura se rehace sola en vez
  // de servir una caché de cuando el pedido no tenía ninguno.
  const idsKey = refs.allIds.join('|');
  const q = useQuery({
    queryKey: ['orderAttachments', tenantId, order.id, idsKey],
    queryFn: () => listAttachmentsByIds(tenantId, refs.allIds),
    enabled: refs.allIds.length > 0,
    // Es una lectura: el reintento lo maneja la persona con el botón, sin esperas invisibles.
    retry: false,
  });

  const { propios, ajenos } = useMemo(
    () => separarAdjuntosDelCliente(q.data?.items ?? [], order.customerId),
    [q.data, order.customerId],
  );
  const faltantes = q.data?.missingIds.length ?? 0;

  if (refs.allIds.length === 0) {
    // El comprobante legacy tiene su propia tarjeta arriba: repetir "todavía no llegó ninguno"
    // debajo de ella sería contradecirla.
    if (comprobanteEstado(order) !== 'none') return null;
    if (!admiteComprobante(order.status)) return null;
    return (
      <Seccion>
        <p className="mt-2 text-sm text-ink-500">
          Todavía no llegó ningún comprobante para este pedido. Cuando el cliente mande la foto o el
          PDF por WhatsApp, aparece acá.
        </p>
      </Seccion>
    );
  }

  return (
    <Seccion>
      {q.isPending && (
        <div className="mt-2">
          <div className="h-16 animate-pulse rounded-xl bg-ink-100" aria-hidden="true" />
          <p role="status" className="mt-1.5 text-xs text-ink-500">
            Cargando los comprobantes del pedido…
          </p>
        </div>
      )}

      {q.isError && (
        <div className="mt-2 rounded-xl bg-coral-50 px-3 py-2">
          <p role="alert" className="text-sm text-coral-700">
            {friendlyOrderAttachmentError(q.error)}
          </p>
          <button
            type="button"
            onClick={() => void q.refetch()}
            className="mt-2 rounded-lg border border-coral-200 bg-white px-3 py-1.5 text-xs font-semibold text-coral-700 transition-colors hover:bg-coral-50"
          >
            Reintentar
          </button>
        </div>
      )}

      {q.isSuccess && (
        <>
          <ul className="mt-2 space-y-2">
            {propios.map((a) => (
              <TarjetaAdjunto
                key={a.attachmentId}
                tenantId={tenantId}
                a={a}
                vinculado={refs.linkedIds.includes(a.attachmentId)}
                mueveElEstado={refs.statusDrivenBy === a.attachmentId}
              />
            ))}
          </ul>

          {faltantes > 0 && (
            <p className="mt-2 rounded-xl bg-ink-50 px-3 py-2 text-xs text-ink-600">
              {faltantes === 1
                ? 'Hay 1 archivo referenciado por este pedido que no pudimos abrir: puede haberse purgado por la política de retención, o tu usuario no tiene permiso para verlo.'
                : `Hay ${faltantes} archivos referenciados por este pedido que no pudimos abrir: pueden haberse purgado por la política de retención, o tu usuario no tiene permiso para verlos.`}
            </p>
          )}

          {ajenos.length > 0 && (
            <p role="alert" className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {ajenos.length === 1
                ? 'Hay 1 archivo referenciado que no pertenece al cliente de este pedido y no se muestra.'
                : `Hay ${ajenos.length} archivos referenciados que no pertenecen al cliente de este pedido y no se muestran.`}{' '}
              Avisale a un responsable del negocio antes de confirmar el pago.
            </p>
          )}

          {propios.length === 0 && faltantes === 0 && ajenos.length === 0 && (
            <p className="mt-2 text-sm text-ink-500">
              No pudimos recuperar ningún comprobante de este pedido.
            </p>
          )}
        </>
      )}
    </Seccion>
  );
}
