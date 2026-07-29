'use client';

/**
 * CatalogQualityCenter — Centro de calidad del catálogo
 * (META-CATALOG-GENERIC-ONBOARDING-QUALITY-1).
 *
 * Tarjeta con el AGREGADO server-side (metaCatalogQualitySummary — nunca se cuenta
 * recorriendo productos en el cliente) + lista filtrable construida con las observaciones
 * (`quality.fingerprints`) de los productos ya cargados en la página. Texto no técnico:
 * el dueño tiene que entender qué falta y qué hacer, no códigos.
 *
 * Patrón visual de OutboxIncidents: sección con aria-labelledby y estados
 * cargando / vacío / error (con reintento) / éxito.
 */

import { useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchCatalogQualitySummary, type ProductConCalidad } from '@/lib/catalog';
import {
  filasDeCalidad,
  filtrarFilas,
  FILTROS_CALIDAD_DEFAULT,
  etiquetaCodigo,
  ORIGEN_LABEL,
  type FiltrosCalidad,
} from '@/lib/catalogQuality';
import { StatusBadge } from '@/components/ui';

export function CatalogQualityCenter({
  tenantId,
  products,
  onEditar,
}: {
  tenantId: string;
  products: ProductConCalidad[];
  /** Abre el editor del producto (la página resuelve el Product por id). */
  onEditar: (productId: string) => void;
}) {
  const uid = useId();
  const [abierto, setAbierto] = useState(false);
  const [filtros, setFiltros] = useState<FiltrosCalidad>(FILTROS_CALIDAD_DEFAULT);

  const summaryQ = useQuery({
    queryKey: ['catalogQuality', tenantId],
    queryFn: () => fetchCatalogQualitySummary(tenantId),
    enabled: !!tenantId,
    retry: false,
  });

  const filas = useMemo(() => filasDeCalidad(products), [products]);
  const visibles = useMemo(() => filtrarFilas(filas, filtros), [filas, filtros]);
  // Códigos disponibles para el filtro: los del agregado del server + los locales.
  const codigos = useMemo(() => {
    const s = new Set<string>(Object.keys(summaryQ.data?.porCodigo ?? {}));
    for (const f of filas) s.add(f.entry.code);
    return [...s].sort((a, b) => etiquetaCodigo(a).localeCompare(etiquetaCodigo(b), 'es'));
  }, [summaryQ.data, filas]);

  const resumen = summaryQ.data;
  const hayProblemas = (resumen?.conBloqueos ?? 0) > 0 || (resumen?.conAdvertencias ?? 0) > 0;

  // --- Cargando ---
  if (summaryQ.isLoading) {
    return (
      <section aria-labelledby={`${uid}-titulo`} className="rounded-2xl border border-ink-100 bg-white p-4 shadow-soft">
        <h2 id={`${uid}-titulo`} className="text-sm font-semibold text-ink-900">Calidad del catálogo</h2>
        <div role="status" aria-live="polite" className="mt-2">
          <span className="sr-only">Revisando la calidad del catálogo…</span>
          <div className="h-6 w-2/3 animate-pulse rounded-lg bg-ink-50" />
        </div>
      </section>
    );
  }

  // --- Error con reintento ---
  if (summaryQ.isError) {
    return (
      <section aria-labelledby={`${uid}-titulo`} className="rounded-2xl border border-ink-100 bg-white p-4 shadow-soft">
        <h2 id={`${uid}-titulo`} className="text-sm font-semibold text-ink-900">Calidad del catálogo</h2>
        <div role="alert" className="mt-2 flex flex-wrap items-center gap-3 rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">
          <span>No pudimos revisar la calidad del catálogo ahora.</span>
          <button
            onClick={() => summaryQ.refetch()}
            className="rounded-lg border border-coral-200 bg-white px-2.5 py-1 text-xs font-semibold text-coral-700 transition-colors hover:bg-coral-50"
          >
            Reintentar
          </button>
        </div>
      </section>
    );
  }

  // --- Todo en orden (vacío honesto, compacto: sin ruido permanente) ---
  if (!hayProblemas) {
    return (
      <section
        aria-labelledby={`${uid}-titulo`}
        className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-mint-200 bg-mint-50/40 px-4 py-3"
      >
        <h2 id={`${uid}-titulo`} className="text-sm font-semibold text-ink-900">
          Calidad del catálogo
        </h2>
        <p className="text-sm text-mint-700">Sin datos pendientes: tus productos están completos.</p>
      </section>
    );
  }

  const contadorTexto = [
    resumen!.conBloqueos > 0
      ? `${resumen!.conBloqueos} producto${resumen!.conBloqueos === 1 ? '' : 's'} con datos incompletos`
      : null,
    resumen!.conAdvertencias > 0
      ? `${resumen!.conAdvertencias} con advertencias`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <section aria-labelledby={`${uid}-titulo`} className="rounded-2xl border border-amber-200 bg-amber-50/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id={`${uid}-titulo`} className="font-semibold text-ink-900">Calidad del catálogo</h2>
          <p className="mt-0.5 text-sm text-ink-600">
            {contadorTexto}. Completá esos datos para que puedan venderse y publicarse sin trabas.
          </p>
        </div>
        <button
          onClick={() => setAbierto((v) => !v)}
          aria-expanded={abierto}
          className="rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50"
        >
          {abierto ? 'Ocultar detalle' : 'Ver qué falta'}
        </button>
      </div>

      {abierto && (
        <div className="mt-3 space-y-3">
          {/* Filtros (labels asociadas; navegables por teclado) */}
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor={`${uid}-sev`} className="mb-1 block text-xs font-medium text-ink-600">Gravedad</label>
              <select
                id={`${uid}-sev`}
                value={filtros.severidad}
                onChange={(e) => setFiltros((f) => ({ ...f, severidad: e.target.value as FiltrosCalidad['severidad'] }))}
                className="rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-sm text-ink-800 focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30"
              >
                <option value="todas">Todas</option>
                <option value="BLOCKING">Impiden vender/publicar</option>
                <option value="WARNING">Advertencias</option>
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-est`} className="mb-1 block text-xs font-medium text-ink-600">Estado</label>
              <select
                id={`${uid}-est`}
                value={filtros.estado}
                onChange={(e) => setFiltros((f) => ({ ...f, estado: e.target.value as FiltrosCalidad['estado'] }))}
                className="rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-sm text-ink-800 focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30"
              >
                <option value="abiertas">Pendientes</option>
                <option value="resueltas">Resueltas</option>
                <option value="todas">Todas</option>
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-ori`} className="mb-1 block text-xs font-medium text-ink-600">Origen</label>
              <select
                id={`${uid}-ori`}
                value={filtros.origen}
                onChange={(e) => setFiltros((f) => ({ ...f, origen: e.target.value as FiltrosCalidad['origen'] }))}
                className="rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-sm text-ink-800 focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30"
              >
                <option value="todos">Todos</option>
                <option value="import">Importación</option>
                <option value="editor">Edición</option>
                <option value="sync_gate">Requisitos de Meta</option>
                <option value="system">Sistema</option>
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-cod`} className="mb-1 block text-xs font-medium text-ink-600">Problema</label>
              <select
                id={`${uid}-cod`}
                value={filtros.codigo}
                onChange={(e) => setFiltros((f) => ({ ...f, codigo: e.target.value }))}
                className="max-w-[16rem] rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-sm text-ink-800 focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30"
              >
                <option value="">Todos</option>
                {codigos.map((c) => (
                  <option key={c} value={c}>
                    {etiquetaCodigo(c)}
                    {resumen!.porCodigo[c] != null ? ` (${resumen!.porCodigo[c]})` : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Lista de observaciones (de los productos cargados) */}
          {filas.length === 0 ? (
            // El agregado dice que hay problemas pero los productos cargados aún no traen el
            // detalle (evaluación recién desplegada o datos por refrescar): fallback honesto
            // con las muestras del servidor.
            <div className="space-y-2">
              <p className="text-sm text-ink-600">
                Estos productos necesitan revisión (recargá la página para ver el detalle campo por campo):
              </p>
              <ul className="space-y-1.5">
                {resumen!.muestras.map((m) => (
                  <li key={m.productId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ink-100 bg-white p-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-ink-900">{m.productName || m.productId}</p>
                      <p className="text-xs text-ink-600">{m.codigos.map(etiquetaCodigo).join(' · ')}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {m.blocking > 0 && <StatusBadge tone="coral">Faltan datos ({m.blocking})</StatusBadge>}
                      {m.warning > 0 && <StatusBadge tone="amber">Revisar ({m.warning})</StatusBadge>}
                      <button
                        onClick={() => onEditar(m.productId)}
                        className="rounded-lg border border-ink-200 px-2.5 py-1 text-xs font-medium text-ink-700 transition-colors hover:bg-ink-50"
                      >
                        Editar
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : visibles.length === 0 ? (
            <p className="rounded-xl border border-dashed border-ink-200 bg-white p-4 text-center text-sm text-ink-600">
              Ninguna observación coincide con los filtros elegidos.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {visibles.map((f) => (
                <li key={`${f.productId}:${f.fingerprint}`} className="rounded-xl border border-ink-100 bg-white p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-ink-900">{f.productName}</p>
                      <p className="mt-0.5 text-sm text-ink-700">{f.entry.message || etiquetaCodigo(f.entry.code)}</p>
                      {f.abierta && f.entry.action && (
                        <p className="mt-0.5 text-xs text-ink-600">Qué hacer: {f.entry.action}</p>
                      )}
                      <p className="mt-0.5 text-[11px] text-ink-500">Origen: {ORIGEN_LABEL[f.entry.origin] ?? f.entry.origin}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {!f.abierta ? (
                        <StatusBadge tone="mint">Resuelta</StatusBadge>
                      ) : f.entry.severity === 'BLOCKING' ? (
                        <StatusBadge tone="coral">Impide vender/publicar</StatusBadge>
                      ) : (
                        <StatusBadge tone="amber">Advertencia</StatusBadge>
                      )}
                      <button
                        onClick={() => onEditar(f.productId)}
                        className="rounded-lg border border-ink-200 px-2.5 py-1 text-xs font-medium text-ink-700 transition-colors hover:bg-ink-50"
                      >
                        Editar
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {resumen!.truncated && (
            <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Hay más productos con observaciones que los listados acá. A medida que resuelvas estos van a aparecer los demás.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
