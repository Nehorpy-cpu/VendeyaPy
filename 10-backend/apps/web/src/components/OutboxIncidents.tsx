'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listOutboxIncidents,
  reconcileOutboxJob,
  discardOutboxJob,
  type OutboxIncident,
  type ReconcileOutcome,
} from '@/lib/catalog';

/**
 * META-CATALOG-OUTBOX-HARDEN-1 — "Revisar sincronización".
 *
 * Muestra los envíos a Meta que el sistema NO pudo resolver solo y le da al dueño las dos
 * únicas salidas honestas: revisar contra Meta (que mira primero y decide con evidencia) o
 * descartar dejando el motivo registrado. **No hay botón de "reenviar"**: reenviar sin saber si
 * el envío anterior llegó es justamente lo que este sistema evita.
 *
 * Solo aparece cuando hay algo que revisar: una tarjeta vacía sería ruido permanente.
 */

const ACCION: Record<string, string> = {
  create: 'publicar el artículo',
  update: 'actualizar el artículo',
  disable: 'ocultar el artículo',
};

const MOTIVO: Record<string, string> = {
  submit_ambiguous: 'No sabemos si el cambio llegó a Meta (se cortó la conexión al enviarlo).',
  verification_unavailable: 'Meta no devolvió información suficiente para confirmarlo.',
  remote_differs: 'En Meta el artículo quedó con otro valor.',
  item_rejected: 'Meta rechazó este artículo.',
  contract_violation: 'Meta rechazó el envío por un dato inválido.',
  catalog_mismatch: 'El catálogo configurado cambió después de enviarlo.',
  product_changed: 'El producto se editó después de confirmar el envío.',
  sync_disabled: 'Se apagó la sincronización de este producto.',
  stock_pending_review: 'El producto tiene el stock sin revisar.',
  product_missing: 'El producto ya no existe.',
  rate_limited: 'Meta pidió esperar antes de aceptar más cambios.',
};

const CAMPO: Record<string, string> = {
  title: 'nombre', description: 'descripción', link: 'enlace', price: 'precio',
  availability: 'disponibilidad', brand: 'marca', image: 'imagen', condition: 'estado',
};

export function OutboxIncidents({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const [confirmarDescarte, setConfirmarDescarte] = useState<OutboxIncident | null>(null);
  const [motivo, setMotivo] = useState('');
  const [resultado, setResultado] = useState<{ jobId: string; r: ReconcileOutcome } | null>(null);

  const incidentsQ = useQuery({
    queryKey: ['outboxIncidents', tenantId],
    queryFn: () => listOutboxIncidents(tenantId),
    enabled: !!tenantId,
  });

  const revisarMut = useMutation({
    mutationFn: (jobId: string) => reconcileOutboxJob(tenantId, jobId),
    onSuccess: (r, jobId) => {
      setResultado({ jobId, r });
      qc.invalidateQueries({ queryKey: ['outboxIncidents', tenantId] });
      qc.invalidateQueries({ queryKey: ['products', tenantId] });
    },
  });

  const descartarMut = useMutation({
    mutationFn: (v: { jobId: string; reason: string }) => discardOutboxJob(tenantId, v.jobId, v.reason),
    onSuccess: () => {
      setConfirmarDescarte(null);
      setMotivo('');
      qc.invalidateQueries({ queryKey: ['outboxIncidents', tenantId] });
      qc.invalidateQueries({ queryKey: ['products', tenantId] });
    },
  });

  const incidencias = incidentsQ.data?.incidents ?? [];
  const hayMas = incidentsQ.data?.truncated === true;
  // Nada que revisar: no se ocupa espacio con una tarjeta vacía.
  if (!incidentsQ.isLoading && !incidentsQ.isError && incidencias.length === 0) return null;

  return (
    <section className="rounded-2xl border border-amber-200 bg-amber-50/40 p-4" aria-labelledby="outbox-incidencias">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="outbox-incidencias" className="font-semibold text-ink-900">
          Revisar sincronización con Meta
        </h2>
        {incidentsQ.isLoading && <span className="text-xs text-ink-500">Buscando envíos pendientes…</span>}
      </div>

      {incidentsQ.isError && (
        <p role="alert" className="mt-2 rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">
          No pudimos leer los envíos pendientes. Recargá la página o probá de nuevo en unos minutos.
        </p>
      )}

      {incidencias.length > 0 && (
        <p className="mt-1 text-sm text-ink-600">
          {incidencias.length === 1 ? 'Un cambio quedó' : `${incidencias.length} cambios quedaron`} sin confirmar.
          Al revisarlos consultamos Meta primero: nunca reenviamos algo sin saber si ya llegó.
        </p>
      )}

      {hayMas && (
        <p role="status" className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Hay más envíos pendientes que los que se muestran acá. A medida que resuelvas estos van a ir apareciendo los demás.
        </p>
      )}

      <ul className="mt-3 space-y-2">
        {incidencias.map((inc) => (
          <li key={inc.jobId} className="rounded-xl border border-ink-100 bg-white p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-medium text-ink-900">{inc.productName || inc.productId}</p>
                <p className="mt-0.5 text-xs text-ink-600">
                  Se intentó {ACCION[inc.action] ?? inc.action}
                  {inc.fields.length > 0 ? ` (${inc.fields.map((f) => CAMPO[f] ?? f).join(', ')})` : ''}
                  {inc.cycle > 1 ? ` · intento ${inc.cycle}` : ''}
                </p>
                <p className="mt-1 text-xs text-amber-800">{MOTIVO[inc.reason ?? ''] ?? 'Necesita una revisión manual.'}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => revisarMut.mutate(inc.jobId)}
                  disabled={revisarMut.isPending}
                  className="rounded-lg bg-mint-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60"
                >
                  {revisarMut.isPending && revisarMut.variables === inc.jobId ? 'Consultando Meta…' : 'Revisar'}
                </button>
                <button
                  onClick={() => { setConfirmarDescarte(inc); setMotivo(''); }}
                  className="rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 transition-colors hover:bg-ink-50"
                >
                  Descartar
                </button>
              </div>
            </div>

            {resultado?.jobId === inc.jobId && (
              <p
                role="status"
                className={`mt-2 rounded-lg px-3 py-2 text-xs ${
                  resultado.r.outcome === 'confirmed_equal'
                    ? 'bg-mint-50 text-mint-700'
                    : resultado.r.outcome === 'unverifiable'
                      ? 'bg-amber-50 text-amber-800'
                      : 'bg-ink-50 text-ink-700'
                }`}
              >
                {resultado.r.message}
              </p>
            )}
            {revisarMut.isError && revisarMut.variables === inc.jobId && (
              <p role="alert" className="mt-2 rounded-lg bg-coral-50 px-3 py-2 text-xs text-coral-700">
                No pudimos consultar Meta ahora. Probá de nuevo en unos minutos.
              </p>
            )}

            {confirmarDescarte?.jobId === inc.jobId && (
              <div className="mt-3 border-t border-ink-100 pt-3">
                <label htmlFor={`motivo-${inc.jobId}`} className="mb-1 block text-xs font-medium text-ink-700">
                  ¿Por qué lo descartás? (queda registrado)
                </label>
                <input
                  id={`motivo-${inc.jobId}`}
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                  className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30"
                  placeholder="Ej.: lo voy a corregir a mano en Meta"
                />
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => descartarMut.mutate({ jobId: inc.jobId, reason: motivo })}
                    disabled={!motivo.trim() || descartarMut.isPending}
                    className="rounded-lg bg-coral-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-coral-700 disabled:opacity-50"
                  >
                    {descartarMut.isPending ? 'Descartando…' : 'Sí, descartar'}
                  </button>
                  <button
                    onClick={() => setConfirmarDescarte(null)}
                    className="rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 transition-colors hover:bg-ink-50"
                  >
                    Cancelar
                  </button>
                </div>
                {descartarMut.isError && (
                  <p role="alert" className="mt-2 text-xs text-coral-700">No se pudo descartar. Probá de nuevo.</p>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
