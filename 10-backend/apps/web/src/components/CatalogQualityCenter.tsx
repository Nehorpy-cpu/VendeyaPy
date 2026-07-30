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
 * ADR-0015: además de los datos incompletos, muestra la DERIVA contra lo publicado. Se lee del
 * estado actual de cada producto (`metaSyncState`/`metaDrift`), así que entra TODO lo vinculado
 * —lo importado y lo vinculado a mano—; la detección vieja solo miraba importados y por eso
 * Odyssey quedó invisible con el precio publicado un 92 % abajo.
 *
 * Patrón visual de OutboxIncidents: sección con aria-labelledby y estados
 * cargando / vacío / error (con reintento) / éxito.
 */

import { useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  fetchCatalogQualitySummary,
  normalizarDerivaProducto,
  type ProductConCalidad,
  type ProductoDerivaView,
} from '@/lib/catalog';
import {
  filasDeCalidad,
  filtrarFilas,
  FILTROS_CALIDAD_DEFAULT,
  etiquetaCodigo,
  ORIGEN_LABEL,
  type FiltrosCalidad,
} from '@/lib/catalogQuality';
import { ESTADO_META_INFO } from '@/lib/catalogOwnership';
import { MetaDriftDetail } from '@/components/MetaDriftDetail';
import { StatusBadge } from '@/components/ui';

/**
 * Productos cuyo estado ACTUAL contra lo publicado dejó de coincidir. Se listan SOLO las
 * divergencias reales; "no lo pudimos verificar" (`stale`/`unverifiable`) se cuenta aparte:
 * mezclarlos inflaría el aviso —con un catálogo grande casi todo vence a la vez— y le sacaría
 * el peso justo a lo que sí está publicado distinto.
 */
function derivasDe(products: ProductConCalidad[]): {
  divergentes: Array<{ id: string; nombre: string; deriva: ProductoDerivaView }>;
  sinVerificar: number;
} {
  const divergentes: Array<{ id: string; nombre: string; deriva: ProductoDerivaView }> = [];
  let sinVerificar = 0;
  for (const p of products) {
    const d = normalizarDerivaProducto(p);
    if (!d || d.estado === 'verified' || d.estado === 'desconocido') continue;
    if (d.estado === 'stale' || d.estado === 'unverifiable') {
      sinVerificar++;
      continue;
    }
    divergentes.push({ id: p.id, nombre: p.name, deriva: d });
  }
  // Lo que frena una venta primero; después, orden estable por nombre.
  divergentes.sort((a, b) =>
    a.deriva.critico !== b.deriva.critico ? (a.deriva.critico ? -1 : 1) : a.nombre.localeCompare(b.nombre, 'es'),
  );
  return { divergentes, sinVerificar };
}

/** Tope de derivas listadas en la tarjeta (el resto se anuncia, no se oculta). */
const DERIVAS_VISIBLES = 5;

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
  const { divergentes: derivas, sinVerificar } = useMemo(() => derivasDe(products), [products]);
  const hayDeriva = derivas.length > 0 || sinVerificar > 0;
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

  // --- Sin problemas REPORTADOS: el verde exige cobertura completa (ADR-0014 §4c) ---
  // Un catálogo con productos aún SIN evaluar nunca se muestra como "completo": el agregado
  // solo cuenta productos evaluados, así que sin este aviso un catálogo legacy entero
  // parecería impecable antes de correr el mantenimiento.
  // Con deriva contra lo publicado NUNCA se muestra el verde, aunque no falte ningún dato:
  // ese es exactamente el caso de Odyssey (ficha completa, precio publicado distinto).
  if (!hayProblemas && !hayDeriva) {
    const sinEvaluar = resumen?.sinEvaluar ?? 0;
    return (
      <section
        aria-labelledby={`${uid}-titulo`}
        className={
          sinEvaluar > 0
            ? 'flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-amber-200 bg-amber-50/40 px-4 py-3'
            : 'flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-mint-200 bg-mint-50/40 px-4 py-3'
        }
      >
        <h2 id={`${uid}-titulo`} className="text-sm font-semibold text-ink-900">
          Calidad del catálogo
        </h2>
        {sinEvaluar > 0 ? (
          <p className="text-sm text-amber-800">
            {sinEvaluar} producto{sinEvaluar === 1 ? '' : 's'} sin evaluar todavía. El estado real se conoce al
            completar la revisión del catálogo.
          </p>
        ) : (
          <p className="text-sm text-mint-700">Sin datos pendientes: tus productos están completos.</p>
        )}
      </section>
    );
  }

  const contadorTexto = [
    (resumen?.conBloqueos ?? 0) > 0
      ? `${resumen!.conBloqueos} producto${resumen!.conBloqueos === 1 ? '' : 's'} con datos incompletos`
      : null,
    (resumen?.conAdvertencias ?? 0) > 0 ? `${resumen!.conAdvertencias} con advertencias` : null,
    derivas.length > 0 ? `${derivas.length} publicado${derivas.length === 1 ? '' : 's'} distinto a lo tuyo` : null,
    sinVerificar > 0 ? `${sinVerificar} sin poder verificar contra lo publicado` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <section aria-labelledby={`${uid}-titulo`} className="rounded-2xl border border-amber-200 bg-amber-50/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id={`${uid}-titulo`} className="font-semibold text-ink-900">Calidad del catálogo</h2>
          <p className="mt-0.5 text-sm text-ink-600">
            {contadorTexto}.{' '}
            {hayProblemas
              ? 'Completá esos datos para que puedan venderse y publicarse sin trabas.'
              : 'Revisá las diferencias con lo publicado antes de seguir vendiendo esos productos.'}
          </p>
        </div>
        {hayProblemas && (
          <button
            onClick={() => setAbierto((v) => !v)}
            aria-expanded={abierto}
            className="rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50"
          >
            {abierto ? 'Ocultar detalle' : 'Ver qué falta'}
          </button>
        )}
      </div>

      {/* Deriva contra lo publicado: importados Y vinculados a mano (ADR-0015 §6). */}
      {hayDeriva && (
        <div className="mt-3 rounded-xl border border-coral-200 bg-white p-3">
          <h3 className="text-sm font-semibold text-ink-900">
            {derivas.length > 0
              ? `Publicado distinto a lo tuyo (${derivas.length})`
              : 'Sin verificar contra lo publicado'}
          </h3>
          <p className="mt-0.5 text-xs text-ink-600">
            Comparamos tus productos con lo que hoy está publicado en Meta. Entran todos los vinculados: los que
            importaste y los que vinculaste a mano.
          </p>
          {sinVerificar > 0 && (
            <p className="mt-1 text-xs text-amber-800">
              Además hay {sinVerificar} producto{sinVerificar === 1 ? '' : 's'} que no pudimos verificar contra lo
              publicado (la comprobación venció o no se pudo leer). Hasta volver a compararlos no damos por confirmado
              su precio ni su stock.
            </p>
          )}
          <ul className="mt-2 space-y-2">
            {derivas.slice(0, DERIVAS_VISIBLES).map((d) => (
              <li key={d.id} className="rounded-lg border border-ink-100 p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 truncate font-medium text-ink-900">{d.nombre}</p>
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusBadge tone={ESTADO_META_INFO[d.deriva.estado].tono}>
                      {ESTADO_META_INFO[d.deriva.estado].label}
                    </StatusBadge>
                    <button
                      onClick={() => onEditar(d.id)}
                      className="rounded-lg border border-ink-200 px-2.5 py-1 text-xs font-medium text-ink-700 transition-colors hover:bg-ink-50 focus:outline-none focus:ring-2 focus:ring-mint-500/40"
                    >
                      Ver el producto
                    </button>
                  </div>
                </div>
                <MetaDriftDetail deriva={d.deriva} className="mt-1.5 space-y-1.5" />
              </li>
            ))}
          </ul>
          {derivas.length > DERIVAS_VISIBLES && (
            <p className="mt-2 text-xs text-ink-600">
              … y {derivas.length - DERIVAS_VISIBLES} producto{derivas.length - DERIVAS_VISIBLES === 1 ? '' : 's'} más
              con diferencias.
            </p>
          )}
        </div>
      )}

      {abierto && hayProblemas && (
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
