'use client';

/**
 * ComprobanteViewer (ORDER-COMPROBANTE-VIEW-1) — botón "Ver comprobante" + modal con la imagen.
 * El enlace es TEMPORAL y lo genera el callable seguro (staff del tenant / admin); acá nunca se
 * toca Storage directo ni se persiste la URL. Estados: cargando / imagen / error amable.
 * Reusado por /orders (detalle del pedido) y /conversations (banner del pedido abierto).
 */
import { useRef, useState } from 'react';
import { getComprobanteViewUrl, friendlyOrderError } from '@/lib/orders';

export function ComprobanteViewer({ tenantId, orderId, compact }: { tenantId: string; orderId: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Review OCV-1: contador de generación — cerrar/reabrir con una request en vuelo no debe dejar
  // que la respuesta VIEJA (éxito o error) pise el estado de la nueva (last-write-wins sin dueño).
  const genRef = useRef(0);

  const abrir = async () => {
    const gen = ++genRef.current;
    setOpen(true);
    setLoading(true);
    setError(null);
    setUrl(null);
    try {
      const r = await getComprobanteViewUrl(tenantId, orderId);
      if (gen !== genRef.current) return; // respuesta obsoleta: la descartamos
      setUrl(r.url);
    } catch (e) {
      if (gen !== genRef.current) return;
      // El backend manda mensajes claros (comprobante pendiente, archivo faltante, permisos);
      // friendlyOrderError queda de red de seguridad (su "not-found" habla del PEDIDO, no del archivo).
      const msg = (e as { message?: string })?.message;
      setError(msg?.trim() ? msg : friendlyOrderError(e));
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  };
  const cerrar = () => {
    genRef.current++; // invalida cualquier request en vuelo
    setOpen(false);
    setUrl(null); // el enlace es temporal: no lo retenemos más de lo necesario
    setError(null);
    setLoading(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={abrir}
        className={
          compact
            ? 'shrink-0 rounded-full bg-mint-600 px-2.5 py-0.5 text-[11px] font-semibold text-white transition-colors hover:bg-mint-700'
            : 'rounded-lg bg-mint-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-mint-700'
        }
      >
        Ver comprobante
      </button>

      {open && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-ink-950/60 p-4" onClick={cerrar}>
          <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-ink-100 bg-white p-4 shadow-float" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-ink-900">🧾 Comprobante recibido</h3>
              <button onClick={cerrar} className="grid h-8 w-8 place-items-center rounded-lg text-ink-400 transition-colors hover:bg-ink-50 hover:text-ink-700" aria-label="Cerrar">✕</button>
            </div>
            {loading && (
              <div className="grid h-48 place-items-center text-sm text-ink-400">
                <span><span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-ink-200 border-t-mint-600 align-middle" />Generando enlace seguro…</span>
              </div>
            )}
            {!loading && error && (
              <div className="rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">{error}</div>
            )}
            {!loading && !error && url && (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element -- URL firmada temporal: no es optimizable por next/image */}
                <img
                  src={url}
                  alt="Comprobante de pago enviado por el cliente"
                  className="max-h-[65vh] w-full rounded-lg border border-ink-100 object-contain"
                  onError={() => setError('No se pudo cargar la imagen. Probá abrir de nuevo (el enlace es temporal).')}
                />
                <p className="mt-2 text-center text-[11px] text-ink-400">Enlace temporal y seguro (expira en unos minutos) · verificá el monto antes de confirmar el pago</p>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
