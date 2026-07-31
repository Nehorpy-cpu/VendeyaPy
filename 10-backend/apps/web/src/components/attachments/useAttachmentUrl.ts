'use client';

/**
 * Hook del enlace TEMPORAL de un adjunto (ADR-0016 §6).
 *
 * POR QUÉ un hook y no react-query: la URL firmada es de vida corta y NO se persiste ni se
 * comparte entre pantallas. Manteniéndola en estado local del componente muere cuando el
 * componente se desmonta, sin quedar colgada en una caché global.
 *
 * `reload()` es de SOLO LECTURA: vuelve a pedirle al callable que firme, no muta nada. Por eso
 * el botón "Reintentar" de la UI puede llamarlo sin confirmación.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getAttachmentViewUrl, friendlyAttachmentError } from '@/lib/attachments';

export interface AttachmentUrlState {
  url: string | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useAttachmentUrl(
  tenantId: string,
  attachmentId: string,
  enabled: boolean,
): AttachmentUrlState {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // Contador de generación: una respuesta VIEJA (de otro adjunto o de un intento cancelado) nunca
  // puede pisar el estado del pedido vigente — mismo patrón probado en ComprobanteViewer.
  const genRef = useRef(0);

  useEffect(() => {
    if (!enabled || !tenantId || !attachmentId) {
      genRef.current++; // invalida cualquier request en vuelo
      setUrl(null);
      setLoading(false);
      setError(null);
      return;
    }
    const gen = ++genRef.current;
    let vivo = true;
    setLoading(true);
    setError(null);
    setUrl(null);
    getAttachmentViewUrl(tenantId, attachmentId)
      .then((r) => {
        if (!vivo || gen !== genRef.current) return;
        setUrl(r.url);
      })
      .catch((e: unknown) => {
        if (!vivo || gen !== genRef.current) return;
        setError(friendlyAttachmentError(e));
      })
      .finally(() => {
        if (!vivo || gen !== genRef.current) return;
        setLoading(false);
      });
    return () => {
      vivo = false;
    };
  }, [tenantId, attachmentId, enabled, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { url, loading, error, reload };
}
