'use client';

/**
 * Adjuntos de UN mensaje dentro de la conversación (ADR-0016 · Área D).
 *
 * ORIGEN DE VERDAD: `Message.attachmentIds`. Nunca el texto del mensaje — antes bastaba con que
 * el cliente escribiera "📷 Imagen recibida (posible comprobante)" para que el panel dibujara una
 * tarjeta de comprobante que nadie había recibido.
 *
 * ESTADOS OBLIGATORIOS, todos visibles: cargando (esqueleto), error con motivo accionable y
 * reintento de SOLO LECTURA, y éxito (thumbnail para imagen / ficha para documento).
 */

import { useEffect, useState } from 'react';
import type { Order } from '@vpw/shared';
import {
  attachmentAltText,
  attachmentDisplayName,
  attachmentErrorHint,
  attachmentTypeLabel,
  attachmentUiState,
  formatAttachmentSize,
  isImageAttachment,
  type PanelAttachment,
} from '@/lib/attachments';
import type { Role } from '@/lib/auth-context';
import { AttachmentCandidateActions } from './AttachmentCandidateActions';
import { AttachmentViewer } from './AttachmentViewer';
import { useAttachmentUrl } from './useAttachmentUrl';

/** Marco común de una tarjeta de adjunto (mismo ancho y tono en todos los estados). */
function Marco({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-64 max-w-full rounded-xl border border-ink-100 bg-white p-2 text-left shadow-soft">
      {children}
    </div>
  );
}

function Esqueleto({ texto }: { texto: string }) {
  return (
    <Marco>
      <div className="h-28 w-full animate-pulse rounded-lg bg-ink-100" aria-hidden="true" />
      <p role="status" className="mt-1.5 text-[11px] text-ink-500">
        {texto}
      </p>
    </Marco>
  );
}

function Fallo({ mensaje, onRetry }: { mensaje: string; onRetry?: () => void }) {
  return (
    <Marco>
      <div className="rounded-lg bg-coral-50 px-2 py-2">
        <p role="alert" className="text-[11px] text-coral-700">
          {mensaje}
        </p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-1.5 rounded-lg border border-coral-200 bg-white px-2 py-1 text-[11px] font-semibold text-coral-700 transition-colors hover:bg-coral-50"
          >
            Reintentar
          </button>
        )}
      </div>
    </Marco>
  );
}

/** Ficha común de nombre / tipo / tamaño. El tipo sale del MIME VERIFICADO, no del declarado. */
function Ficha({ a }: { a: PanelAttachment }) {
  return (
    <>
      <p className="truncate text-xs font-semibold text-ink-800">{attachmentDisplayName(a)}</p>
      <p className="text-[11px] text-ink-500">
        {attachmentTypeLabel(a)} · {formatAttachmentSize(a.bytes)}
      </p>
    </>
  );
}

/** Imagen guardada: se pide el enlace temporal y se muestra el thumbnail clickeable. */
function Thumbnail({
  tenantId,
  a,
  onOpen,
}: {
  tenantId: string;
  a: PanelAttachment;
  onOpen: () => void;
}) {
  const { url, loading, error, reload } = useAttachmentUrl(tenantId, a.attachmentId, true);
  // El enlace vence en minutos: si expira, el navegador falla sin que haya error del callable.
  // Se muestra el motivo y el reintento (que solo vuelve a pedir una firma nueva).
  const [falloImagen, setFalloImagen] = useState(false);
  useEffect(() => setFalloImagen(false), [url]);

  if (loading) return <Esqueleto texto="Cargando la imagen…" />;
  if (error || falloImagen || !url) {
    return (
      <Fallo
        mensaje={
          error ??
          (falloImagen
            ? 'No se pudo mostrar la imagen: el enlace es temporal y pudo expirar.'
            : 'No pudimos generar el enlace para ver esta imagen.')
        }
        onRetry={reload}
      />
    );
  }
  return (
    <Marco>
      <button
        type="button"
        onClick={onOpen}
        className="block w-full overflow-hidden rounded-lg border border-ink-100 focus:outline-none focus:ring-2 focus:ring-mint-500"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- URL firmada temporal: next/image no puede optimizarla */}
        <img
          src={url}
          alt={attachmentAltText(a)}
          onError={() => setFalloImagen(true)}
          className="h-28 w-full bg-ink-50 object-cover"
        />
      </button>
      <p className="mt-1.5 text-[11px] text-ink-500">
        {attachmentTypeLabel(a)} · {formatAttachmentSize(a.bytes)}
      </p>
    </Marco>
  );
}

function TarjetaDocumento({ a, onOpen }: { a: PanelAttachment; onOpen: () => void }) {
  return (
    <Marco>
      <div className="flex items-start gap-2">
        <span aria-hidden="true" className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-coral-50 text-lg">
          📄
        </span>
        <div className="min-w-0 flex-1">
          <Ficha a={a} />
        </div>
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="mt-2 w-full rounded-lg bg-mint-600 px-2 py-1.5 text-[11px] font-semibold text-white transition-colors hover:bg-mint-700"
      >
        Ver documento
      </button>
    </Marco>
  );
}

/** Una tarjeta por adjunto, con su visor y sus acciones humanas de clasificación. */
function TarjetaAdjunto({
  tenantId,
  a,
  role,
  orders,
  onChanged,
}: {
  tenantId: string;
  a: PanelAttachment;
  role: Role | null;
  orders: readonly Order[];
  onChanged: () => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const estado = attachmentUiState(a);

  return (
    <div>
      {estado === 'loading' && <Esqueleto texto="Recibiendo el archivo del cliente…" />}
      {/* Un rechazo NO bloquea el chat: se ve el motivo y qué pedirle al cliente. Sin reintento
          porque el estado es terminal — el reintento real es que el cliente reenvíe. */}
      {estado === 'error' && (
        <Marco>
          <div className="rounded-lg bg-amber-50 px-2 py-2">
            <p role="alert" className="text-[11px] text-amber-800">
              {attachmentErrorHint(a)}
            </p>
            {a.lastError && <p className="mt-1 text-[10px] text-amber-700/80">{a.lastError}</p>}
          </div>
        </Marco>
      )}
      {estado === 'ready' &&
        (isImageAttachment(a) ? (
          <Thumbnail tenantId={tenantId} a={a} onOpen={() => setAbierto(true)} />
        ) : (
          <TarjetaDocumento a={a} onOpen={() => setAbierto(true)} />
        ))}

      {a.caption?.trim() && (
        <p className="mt-1 max-w-[16rem] whitespace-pre-wrap text-xs text-ink-700">{a.caption}</p>
      )}

      {estado === 'ready' && (
        <div className="w-64 max-w-full">
          <AttachmentCandidateActions
            tenantId={tenantId}
            attachment={a}
            role={role}
            orders={orders}
            onChanged={onChanged}
          />
        </div>
      )}

      {abierto && (
        <AttachmentViewer tenantId={tenantId} attachment={a} onClose={() => setAbierto(false)} />
      )}
    </div>
  );
}

export function MessageAttachments({
  tenantId,
  ids,
  byId,
  loading,
  failed,
  onRetry,
  role,
  orders,
  onChanged,
}: {
  tenantId: string;
  /** `Message.attachmentIds` — el ÚNICO origen de verdad de que hay un adjunto. */
  ids: readonly string[];
  byId: Map<string, PanelAttachment>;
  /** La lectura de adjuntos de la conversación sigue en vuelo. */
  loading: boolean;
  /** La lectura falló (permisos, red): se muestra el error con reintento de solo lectura. */
  failed: boolean;
  onRetry: () => void;
  role: Role | null;
  orders: readonly Order[];
  onChanged: () => void;
}) {
  if (ids.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-2">
      {ids.map((id) => {
        const a = byId.get(id);
        if (a) {
          return (
            <TarjetaAdjunto
              key={id}
              tenantId={tenantId}
              a={a}
              role={role}
              orders={orders}
              onChanged={onChanged}
            />
          );
        }
        if (loading) return <Esqueleto key={id} texto="Cargando el archivo…" />;
        return (
          <Fallo
            key={id}
            mensaje={
              failed
                ? 'No pudimos cargar los archivos de esta conversación. Revisá tu conexión y reintentá.'
                : 'No encontramos este archivo: puede haberse purgado por la política de retención o tu usuario no tiene permiso para verlo. Consultá con un responsable del negocio.'
            }
            onRetry={onRetry}
          />
        );
      })}
    </div>
  );
}
