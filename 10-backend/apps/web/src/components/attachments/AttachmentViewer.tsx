'use client';

/**
 * Visor de un adjunto de conversación (ADR-0016 · Área D).
 *
 * Accesibilidad (requisito duro): `role="dialog"` + `aria-modal`, foco al abrir, TRAMPA de foco
 * mientras está abierto, devolución del foco al disparador al cerrar y cierre con Escape.
 * Se monta/desmonta (no se oculta con CSS) para que la devolución del foco sea confiable.
 *
 * SEGURIDAD DE LA UI: la URL firmada existe solo en memoria y solo llega al `src` de la imagen —
 * jamás a un `href`, a un `title`, a un texto visible ni a un log. La ruta de Storage no entra
 * nunca al panel: el componente ni siquiera la recibe.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  attachmentAltText,
  attachmentDisplayName,
  attachmentTypeLabel,
  formatAttachmentSize,
  isImageAttachment,
  type PanelAttachment,
} from '@/lib/attachments';
import { useAttachmentUrl } from './useAttachmentUrl';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export function AttachmentViewer({
  tenantId,
  attachment,
  onClose,
}: {
  tenantId: string;
  attachment: PanelAttachment;
  onClose: () => void;
}) {
  const titleId = useId();
  const descId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const { url, loading, error, reload } = useAttachmentUrl(tenantId, attachment.attachmentId, true);
  const esImagen = isImageAttachment(attachment);
  // El enlace es de vida corta: si expira mientras el visor está abierto, la imagen falla en el
  // navegador y NO hay error del callable. Sin esto el usuario ve un ícono roto sin explicación.
  const [falloImagen, setFalloImagen] = useState(false);
  useEffect(() => setFalloImagen(false), [url]);
  const mensajeError =
    error ??
    (falloImagen ? 'No se pudo cargar la imagen: el enlace es temporal y pudo expirar.' : null);

  // Foco inicial en el diálogo y devolución al elemento que lo abrió.
  useEffect(() => {
    const previo = document.activeElement as HTMLElement | null;
    cardRef.current?.focus();
    return () => previo?.focus?.();
  }, []);

  // Escape cierra desde cualquier lado (aunque el foco se haya escapado del card).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Trampa de foco: Tab/Shift+Tab circulan DENTRO del diálogo. Sin esto el lector de pantalla se
  // va al chat de atrás, que está tapado por el overlay.
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const card = cardRef.current;
    if (!card) return;
    const nodes = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (nodes.length === 0) {
      e.preventDefault();
      card.focus();
      return;
    }
    const primero = nodes[0]!;
    const ultimo = nodes[nodes.length - 1]!;
    const activo = document.activeElement;
    const dentro = !!activo && card.contains(activo);
    if (e.shiftKey && (!dentro || activo === primero || activo === card)) {
      e.preventDefault();
      ultimo.focus();
    } else if (!e.shiftKey && (!dentro || activo === ultimo)) {
      e.preventDefault();
      primero.focus();
    }
  }, []);

  const abrirDocumento = () => {
    if (!url) return;
    // La URL firmada NO se pone en un href: se abre en una pestaña nueva sin dejarla en el DOM.
    window.open?.(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-ink-950/60 p-4"
      onClick={onClose}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-float focus:outline-none"
      >
        <div className="flex items-start justify-between gap-3 border-b border-ink-100 px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-sm font-semibold text-ink-900">
              {attachmentDisplayName(attachment)}
            </h2>
            <p id={descId} className="mt-0.5 text-xs text-ink-500">
              {attachmentTypeLabel(attachment)} · {formatAttachmentSize(attachment.bytes)} · enviado
              por el cliente
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar el visor"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-ink-400 transition-colors hover:bg-ink-50 hover:text-ink-700"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <div className="grid h-56 place-items-center" aria-busy="true">
              <p className="text-sm text-ink-500" role="status">
                <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-ink-200 border-t-mint-600 align-middle" />
                Generando enlace seguro…
              </p>
            </div>
          )}

          {!loading && mensajeError && (
            <div className="rounded-xl bg-coral-50 px-4 py-3 text-sm text-coral-700">
              <p role="alert">{mensajeError}</p>
              <button
                type="button"
                onClick={reload}
                className="mt-2 rounded-lg border border-coral-200 bg-white px-3 py-1.5 text-xs font-semibold text-coral-700 transition-colors hover:bg-coral-50"
              >
                Reintentar
              </button>
            </div>
          )}

          {!loading && !mensajeError && url && esImagen && (
            /* eslint-disable-next-line @next/next/no-img-element -- URL firmada temporal: next/image no puede optimizarla */
            <img
              src={url}
              alt={attachmentAltText(attachment)}
              onError={() => setFalloImagen(true)}
              className="mx-auto max-h-[65vh] w-auto max-w-full rounded-xl border border-ink-100 object-contain"
            />
          )}

          {!loading && !mensajeError && url && !esImagen && (
            <div className="rounded-xl border border-ink-100 bg-ink-50/60 px-4 py-6 text-center">
              <p className="text-sm text-ink-700">{attachmentAltText(attachment)}</p>
              <p className="mt-1 text-xs text-ink-500">
                Los documentos se abren en una pestaña nueva.
              </p>
              <button
                type="button"
                onClick={abrirDocumento}
                className="mt-3 rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700"
              >
                Abrir el documento
              </button>
            </div>
          )}

          {attachment.caption?.trim() && (
            <p className="mt-3 whitespace-pre-wrap rounded-xl bg-ink-50 px-3 py-2 text-sm text-ink-700">
              {attachment.caption}
            </p>
          )}
        </div>

        <p className="border-t border-ink-100 px-4 py-2 text-center text-[11px] text-ink-400">
          Enlace temporal y seguro (expira en unos minutos). Recibir un archivo no confirma ningún
          pago.
        </p>
      </div>
    </div>
  );
}
