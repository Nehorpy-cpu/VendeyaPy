'use client';

/**
 * CoverageReviewCard — Revisión humana de cobertura (COVERAGE-1C).
 * Aparece en /conversations cuando el cliente seleccionado tiene un coverageRequest. Muestra la
 * ubicación SOLO a roles autorizados (rules), el carrito del snapshot y las acciones Aprobar /
 * Rechazar / Pedir más info. La decisión NO libera el chat ni crea el pedido (eso es 1D): acá
 * solo queda registrada. El mapa se abre ÚNICAMENTE al hacer clic (nada de terceros embebidos).
 *
 * Review 1C: el estado local (hecho/error/nota) se resetea al cambiar de request — el mensaje de
 * una decisión JAMÁS aparece sobre otro cliente/request; "pedir más info" no oculta las acciones.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { CoverageRequest } from '@vpw/shared';
import { useAuth } from '@/lib/auth-context';
import { getCoverageRequestFor, approveCoverage, rejectCoverage, requestCoverageInfo, mapsUrlFor } from '@/lib/coverage';

const ESTADO_LABEL: Record<CoverageRequest['status'], string> = {
  awaiting_location: 'Esperando la ubicación del cliente',
  pending_coverage_review: 'Cobertura pendiente de revisión',
  coverage_approved: 'Cobertura aprobada',
  coverage_rejected: 'Cobertura rechazada',
  coverage_expired: 'Solicitud vencida',
  coverage_cancelled: 'Cancelada por el cliente',
};

/** Roles que pueden VER la revisión (los demás ni consultan — evita polls denegados). */
const ROLES_LECTURA = new Set(['TENANT_OWNER', 'TENANT_MANAGER', 'SELLER', 'PLATFORM_ADMIN']);

const fmtFecha = (t: { toMillis?: () => number } | null | undefined) =>
  t?.toMillis ? new Date(t.toMillis()).toLocaleString('es-PY', { dateStyle: 'short', timeStyle: 'short' }) : '—';

export function CoverageReviewCard({ tenantId, customerId }: { tenantId: string; customerId: string }) {
  const { user, claims } = useAuth();
  const qc = useQueryClient();
  const [nota, setNota] = useState('');
  const [hecho, setHecho] = useState<string | null>(null); // SOLO decisiones (aprobar/rechazar)
  const [aviso, setAviso] = useState<string | null>(null); // informativo (pedir info): no oculta acciones
  const [error, setError] = useState<string | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  const puedeVer = !!claims.role && ROLES_LECTURA.has(claims.role);
  const covQ = useQuery({
    queryKey: ['coverage', tenantId, customerId, claims.role, user?.uid],
    queryFn: () => getCoverageRequestFor(tenantId, customerId, { role: claims.role, uid: user?.uid ?? null }),
    enabled: !!tenantId && !!customerId && puedeVer,
    refetchInterval: 8000,
  });
  const req = covQ.data?.request ?? null;

  // Cambió el request (otro cliente u otro intento del mismo): limpiar el estado local.
  const reqId = req?.id ?? null;
  useEffect(() => {
    setNota('');
    setHecho(null);
    setAviso(null);
    setError(null);
  }, [reqId, customerId]);

  const invalidar = () => qc.invalidateQueries({ queryKey: ['coverage', tenantId, customerId] });
  const onDecidido = (msg: string) => { setHecho(msg); setAviso(null); setError(null); invalidar(); statusRef.current?.focus(); };
  const onErr = (e: unknown) => { setError(e instanceof Error ? e.message : 'No se pudo completar la acción.'); invalidar(); };

  const fingerprint = req?.locationFingerprint ?? '';
  const aprobar = useMutation({ mutationFn: () => approveCoverage(tenantId, req!.id, fingerprint), onSuccess: () => onDecidido('Decisión registrada: cobertura aprobada.'), onError: onErr });
  const rechazar = useMutation({ mutationFn: () => rejectCoverage(tenantId, req!.id, fingerprint, nota), onSuccess: () => onDecidido('Decisión registrada: cobertura rechazada.'), onError: onErr });
  const pedirInfo = useMutation({
    mutationFn: () => requestCoverageInfo(tenantId, req!.id),
    onSuccess: (r) => { setAviso(r.already ? 'Ya se pidió más información hace un momento.' : 'Le pedimos más detalle al cliente.'); setError(null); },
    onError: onErr,
  });
  const ocupado = aprobar.isPending || rechazar.isPending || pedirInfo.isPending;

  if (!puedeVer) return null;
  if (covQ.isLoading) return <div className="border-b border-sky-100 bg-sky-50/60 px-4 py-2 text-xs text-ink-400" role="status">Cargando revisión de cobertura…</div>;
  // Sin request o sin permiso (seller no asignado) → nada, sin filtrar existencia.
  if (!req || covQ.data?.denied) return null;

  const vencido = (req.expiresAt?.toMillis?.() ?? 0) <= Date.now();
  const pendiente = req.status === 'pending_coverage_review' && !vencido;
  // El soporte de plataforma LEE pero no decide (el server lo rechaza igual — acá ni se ofrece).
  const puedeDecidir = claims.role !== 'PLATFORM_ADMIN';
  const cliente = `…${customerId.slice(-4)}`;

  return (
    <section aria-label="Revisión de cobertura" className="border-b border-sky-100 bg-sky-50/60 px-4 py-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-ink-800">
          📍 {ESTADO_LABEL[req.status] ?? req.status} · cliente {cliente}
        </span>
        <span className="text-ink-500">vence: {fmtFecha(req.expiresAt)}</span>
      </div>

      {req.location?.addressText && (
        <p className="mt-1 break-words text-ink-700">
          <span className="font-medium">Dirección:</span> {req.location.addressText}
          {req.location.name ? ` (${req.location.name})` : ''}
        </p>
      )}
      {req.location?.coordinates && (
        <button
          type="button"
          onClick={() => window.open(mapsUrlFor(req.location!.coordinates!), '_blank', 'noopener,noreferrer')}
          className="mt-1 font-semibold text-sky-700 underline-offset-2 hover:underline"
          aria-label="Abrir la ubicación del cliente en el mapa (pestaña nueva)"
        >
          Abrir mapa ↗
        </button>
      )}

      {req.cartSnapshot?.items?.length ? (
        <p className="mt-1 text-ink-600">
          🛒 {req.cartSnapshot.items.map((i) => `${i.name} x${i.quantity}`).join(' · ')} — Total ₲{' '}
          {req.cartSnapshot.subtotal?.toLocaleString('es-PY') ?? '—'}
        </p>
      ) : null}
      {req.sellerName && <p className="mt-0.5 text-ink-500">Asignado a: {req.sellerName}</p>}

      {req.decision && (
        <p className="mt-1 text-ink-600">
          Decidido por <span className="font-medium">{req.decision.byName}</span> ({req.decision.byRole}) el {fmtFecha(req.decision.at)}.
        </p>
      )}
      {vencido && !req.decision && (req.status === 'pending_coverage_review' || req.status === 'awaiting_location' || req.status === 'coverage_expired') && (
        <p className="mt-1 text-amber-700">La solicitud venció: el cliente tiene que escribir *pagar* para retomar.</p>
      )}

      {hecho && <p ref={statusRef} tabIndex={-1} className="mt-2 font-semibold text-mint-700 outline-none" role="status">{hecho}</p>}
      {aviso && !hecho && <p className="mt-2 font-medium text-sky-700" role="status">{aviso}</p>}
      {error && <p className="mt-2 font-semibold text-coral-700" role="alert">{error}</p>}

      {pendiente && !hecho && puedeDecidir && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => aprobar.mutate()}
            disabled={ocupado}
            className="rounded-lg bg-mint-600 px-3 py-1.5 font-semibold text-white transition-colors hover:bg-mint-500 disabled:opacity-50"
          >
            {aprobar.isPending ? 'Aprobando…' : 'Aprobar cobertura'}
          </button>
          <button
            type="button"
            onClick={() => rechazar.mutate()}
            disabled={ocupado}
            className="rounded-lg bg-coral-600 px-3 py-1.5 font-semibold text-white transition-colors hover:bg-coral-500 disabled:opacity-50"
          >
            {rechazar.isPending ? 'Rechazando…' : 'Rechazar'}
          </button>
          <button
            type="button"
            onClick={() => pedirInfo.mutate()}
            disabled={ocupado}
            className="rounded-lg border border-ink-300 px-3 py-1.5 font-semibold text-ink-700 transition-colors hover:bg-ink-50 disabled:opacity-50"
          >
            {pedirInfo.isPending ? 'Enviando…' : 'Pedir más información'}
          </button>
          <input
            type="text"
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            maxLength={300}
            placeholder="Nota interna (opcional, solo si rechazás)"
            aria-label="Nota interna del rechazo (opcional, no se envía al cliente)"
            className="min-w-[12rem] flex-1 rounded-lg border border-ink-200 px-2 py-1.5 text-xs"
          />
        </div>
      )}
    </section>
  );
}
