'use client';

/**
 * MetaReconciliation — Reconciliación del catálogo con Meta (META-CATALOG-RECONCILIATION-1).
 *
 * Muestra los artículos que ya existen en Meta y todavía no están vinculados a un producto
 * del panel, los candidatos de vínculo por producto (SUGERENCIA: el vínculo lo confirma una
 * persona) y permite importarlos como productos INACTIVE.
 *
 * Nunca muestra costos ni datos privados junto a la información remota.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Category } from '@vpw/shared';
import { useAuth } from '@/lib/auth-context';
import {
  confirmMetaMapping,
  fetchReconcilePlan,
  importMetaItems,
  type MappingCandidate,
  type RemoteCandidateItem,
  type RemoteQualityFlag,
} from '@/lib/catalog';

const gs = (n: number) => '₲ ' + n.toLocaleString('es-PY');

const FLAG_LABEL: Record<RemoteQualityFlag, string> = {
  generic_name: 'nombre genérico',
  probable_duplicate: 'probable duplicado',
  missing_brand: 'sin marca',
  out_of_stock: 'sin stock en Meta',
  name_description_mismatch: 'nombre y descripción no coinciden',
  invalid_price: 'precio inválido',
  image_not_https: 'imagen no segura',
};

type FilterKey = 'todos' | 'importable' | 'generic_name' | 'probable_duplicate' | 'out_of_stock' | 'name_description_mismatch';

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: 'todos', label: 'Todos' },
  { key: 'importable', label: 'Importables' },
  { key: 'generic_name', label: 'Nombre genérico' },
  { key: 'probable_duplicate', label: 'Probable duplicado' },
  { key: 'out_of_stock', label: 'Sin stock' },
  { key: 'name_description_mismatch', label: 'Datos incoherentes' },
];

/** Vincular, importar y habilitar la sync son acciones de dueño (el backend las restringe igual). */
const ROLES_RECONCILIACION = new Set(['TENANT_OWNER', 'PLATFORM_ADMIN']);

const BLOCK_REASON_LABEL: Record<string, string> = {
  already_mapped: 'ya está vinculado a un producto',
  already_imported: 'ya existe un producto con ese código',
  duplicate_name_local: 'ya tenés un producto con ese nombre',
  strong_mapping_candidate: 'se parece mucho a un producto tuyo: vinculalo en vez de importarlo',
  not_found_in_meta: 'no está en el catálogo de Meta',
  invalid_price: 'precio inválido',
  image_not_https: 'imagen no segura',
  category_required: 'falta elegir la categoría destino',
};

export function MetaReconciliation({ tenantId, categories }: { tenantId: string; categories: Category[] }) {
  const qc = useQueryClient();
  const { claims } = useAuth();
  const puedeReconciliar = !!claims.role && ROLES_RECONCILIACION.has(claims.role);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<FilterKey>('todos');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [categoryId, setCategoryId] = useState('');
  const [confirmImport, setConfirmImport] = useState(false);
  const [confirmMap, setConfirmMap] = useState<{ productId: string; productName: string; candidate: MappingCandidate } | null>(null);

  const planQ = useQuery({
    queryKey: ['metaReconcile', tenantId],
    queryFn: () => fetchReconcilePlan(tenantId),
    enabled: open && !!tenantId,
    retry: false,
  });

  const mapMut = useMutation({
    mutationFn: (v: { productId: string; retailerId: string }) => confirmMetaMapping(tenantId, v.productId, v.retailerId),
    onSuccess: () => {
      setConfirmMap(null);
      qc.invalidateQueries({ queryKey: ['metaReconcile', tenantId] });
      qc.invalidateQueries({ queryKey: ['products', tenantId] });
    },
  });

  const importMut = useMutation({
    mutationFn: () => importMetaItems(tenantId, [...selected], categoryId),
    onSuccess: () => {
      setConfirmImport(false);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['metaReconcile', tenantId] });
      qc.invalidateQueries({ queryKey: ['products', tenantId] });
    },
  });

  const plan = planQ.data;
  const filtered = useMemo(() => {
    const items = plan?.unlinked ?? [];
    const s = search.trim().toLowerCase();
    return items.filter((it) => {
      if (filter === 'importable' && !it.importable) return false;
      if (filter !== 'todos' && filter !== 'importable' && !it.flags.includes(filter)) return false;
      if (!s) return true;
      return it.name.toLowerCase().includes(s) || it.brand.toLowerCase().includes(s) || it.retailerId.toLowerCase().includes(s);
    });
  }, [plan, filter, search]);

  const toggle = (rid: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rid)) next.delete(rid);
      else next.add(rid);
      return next;
    });

  // Selección masiva SOLO de los importables del filtro actual (los bloqueados nunca se tildan).
  const importablesVisibles = useMemo(() => filtered.filter((it) => it.importable), [filtered]);
  const todosImportablesSeleccionados =
    importablesVisibles.length > 0 && importablesVisibles.every((it) => selected.has(it.retailerId));
  const toggleTodos = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (todosImportablesSeleccionados) {
        for (const it of importablesVisibles) next.delete(it.retailerId);
      } else {
        for (const it of importablesVisibles) next.add(it.retailerId);
      }
      return next;
    });

  // Escape cierra el modal abierto (los diálogos se abren sobre la sección).
  useEffect(() => {
    if (!confirmMap && !confirmImport) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setConfirmMap(null);
      setConfirmImport(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmMap, confirmImport]);

  // La reconciliación es más estricta que el resto del catálogo: sin el rol, no se ofrece
  // (el backend la rechaza igual, pero mostrar botones que fallan no es honesto).
  if (!puedeReconciliar) return null;

  if (!open) {
    return (
      <div className="rounded-2xl border border-ink-100 bg-white p-4 shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink-900">Reconciliación con Meta</h2>
            <p className="mt-0.5 text-sm text-ink-500">
              Vinculá tus productos con los artículos que ya existen en el catálogo de Meta e importá los que falten.
            </p>
          </div>
          <button
            onClick={() => setOpen(true)}
            className="rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50"
          >
            Abrir reconciliación
          </button>
        </div>
      </div>
    );
  }

  return (
    <section aria-label="Reconciliación con Meta" className="space-y-4 rounded-2xl border border-ink-100 bg-white p-4 shadow-soft">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-900">Reconciliación con Meta</h2>
          {plan && (
            <p className="mt-0.5 text-sm text-ink-500">
              {plan.totals.remoteItems} artículos en Meta · {plan.totals.linked} vinculados · {plan.totals.unlinked} sin vincular
            </p>
          )}
        </div>
        <button onClick={() => setOpen(false)} className="text-xs font-medium text-ink-400 transition-colors hover:text-ink-600">
          Cerrar
        </button>
      </div>

      {planQ.isLoading && (
        <div className="space-y-2" role="status" aria-live="polite">
          <span className="sr-only">Cargando la reconciliación…</span>
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-12 animate-pulse rounded-xl border border-ink-100 bg-ink-50/60" />)}
        </div>
      )}

      {planQ.isError && (
        <p role="alert" className="rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">
          No se pudo cargar la reconciliación: {errText(planQ.error)}
        </p>
      )}

      {plan && (
        <>
          {/* --- Candidatos de vínculo por producto --- */}
          {plan.suggestions.some((s) => s.candidates.length > 0) && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-400">Tus productos sin vincular</h3>
              {plan.suggestions.map((s) => (
                <div key={s.productId} className="rounded-xl border border-ink-100 p-3">
                  <p className="text-sm font-medium text-ink-900">{s.productName}</p>
                  <p className="text-xs text-ink-400">SKU interno: {s.internalSku || '—'}</p>
                  {s.candidates.filter((c) => c.confidence !== 'baja').length === 0 ? (
                    <p className="mt-2 text-xs text-ink-500">
                      No encontramos un artículo parecido en Meta. Si querés publicarlo, se creará como artículo nuevo cuando lo habilites.
                    </p>
                  ) : (
                    <ul className="mt-2 space-y-1.5">
                      {s.candidates
                        .filter((c) => c.confidence !== 'baja')
                        .map((c) => (
                          <li key={c.retailerId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-ink-50/60 px-2.5 py-2">
                            <div className="min-w-0">
                              <p className="truncate text-sm text-ink-800">
                                <span className={c.confidence === 'alta' ? 'font-semibold text-mint-700' : 'text-ink-700'}>
                                  {c.confidence === 'alta' ? 'Coincidencia alta' : 'Coincidencia media'}
                                </span>{' '}
                                · {c.name}
                              </p>
                              <p className="text-xs text-ink-500">
                                {c.retailerId} · {gs(c.priceGs)} · {c.brand || 'sin marca'} · {c.availability}
                              </p>
                              <p className="text-xs text-ink-400">{c.reasons.join(' · ')}</p>
                            </div>
                            <button
                              onClick={() => setConfirmMap({ productId: s.productId, productName: s.productName, candidate: c })}
                              className="shrink-0 rounded-lg border border-mint-600 px-2.5 py-1 text-xs font-semibold text-mint-700 transition-colors hover:bg-mint-50"
                            >
                              Vincular…
                            </button>
                          </li>
                        ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}

          {plan.linked.length > 0 && (
            <div className="rounded-xl border border-mint-200 bg-mint-50/50 p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-mint-700">Ya vinculados</h3>
              <ul className="mt-1 space-y-0.5">
                {plan.linked.map((l) => (
                  <li key={l.retailerId} className="text-sm text-ink-700">
                    {l.productName} <span className="text-xs text-ink-500">↔ {l.retailerId}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* --- Artículos de Meta sin vincular --- */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-400">Artículos en Meta sin vincular</h3>
            <div className="flex flex-wrap items-center gap-2">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  aria-pressed={filter === f.key}
                  className={
                    'rounded-full px-2.5 py-1 text-xs font-medium transition-colors ' +
                    (filter === f.key ? 'bg-ink-900 text-white' : 'bg-ink-50 text-ink-600 hover:bg-ink-100')
                  }
                >
                  {f.label}
                  {f.key !== 'todos' && f.key !== 'importable' && ` (${countFlag(plan.unlinked, f.key)})`}
                </button>
              ))}
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Buscar artículos de Meta"
                placeholder="Buscar por nombre, marca o ID…"
                className="ml-auto w-full max-w-xs rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm text-ink-800 focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30"
              />
            </div>

            {filtered.length === 0 ? (
              <p className="rounded-xl border border-dashed border-ink-200 p-6 text-center text-sm text-ink-500">
                {plan.unlinked.length === 0 ? 'Todos los artículos de Meta están vinculados.' : 'Ningún artículo coincide con el filtro.'}
              </p>
            ) : (
              <div className="max-h-96 overflow-y-auto rounded-xl border border-ink-100">
                <table className="min-w-full text-sm">
                  <caption className="sr-only">Artículos del catálogo de Meta sin producto vinculado</caption>
                  <thead className="sticky top-0 border-b border-ink-100 bg-ink-50/90 text-left text-xs uppercase tracking-wide text-ink-500">
                    <tr>
                      <th scope="col" className="w-10 px-3 py-2">
                        <input
                          type="checkbox"
                          ref={(el) => {
                            if (el) el.indeterminate = !todosImportablesSeleccionados && importablesVisibles.some((it) => selected.has(it.retailerId));
                          }}
                          checked={todosImportablesSeleccionados}
                          onChange={toggleTodos}
                          disabled={importablesVisibles.length === 0}
                          aria-label={`Seleccionar los ${importablesVisibles.length} artículos importables de esta vista`}
                          title={importablesVisibles.length === 0 ? 'No hay artículos importables en esta vista' : 'Seleccionar todos los importables del filtro'}
                          className="h-4 w-4 rounded border-ink-300 text-mint-600 focus:ring-mint-500 disabled:opacity-40"
                        />
                      </th>
                      <th scope="col" className="px-3 py-2">Artículo</th>
                      <th scope="col" className="px-3 py-2">Precio en Meta</th>
                      <th scope="col" className="px-3 py-2">Disponibilidad</th>
                      <th scope="col" className="px-3 py-2">Avisos</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-50">
                    {filtered.map((it) => (
                      <tr key={it.retailerId} className={it.importable ? '' : 'bg-coral-50/40'}>
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={selected.has(it.retailerId)}
                            disabled={!it.importable}
                            onChange={() => toggle(it.retailerId)}
                            aria-label={`Seleccionar ${it.name}`}
                            className="h-4 w-4 rounded border-ink-300 text-mint-600 focus:ring-mint-500 disabled:opacity-40"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <p className="font-medium text-ink-900">{it.name}</p>
                          <p className="text-xs text-ink-400">{it.retailerId} · {it.brand || 'sin marca'}</p>
                        </td>
                        <td className="px-3 py-2 text-ink-700">{gs(it.priceGs)}</td>
                        <td className="px-3 py-2 text-ink-600">{it.availability}</td>
                        <td className="px-3 py-2">
                          {it.flags.length === 0 ? (
                            <span className="text-xs text-mint-700">sin observaciones</span>
                          ) : (
                            <span className="text-xs text-amber-700">{it.flags.map((f) => FLAG_LABEL[f]).join(' · ')}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {plan.page.hasMore && (
              <p className="text-xs text-ink-500">
                Mostrando {plan.page.offset + plan.unlinked.length} de {plan.page.total} artículos. Para traer el
                catálogo completo usá “Importar catálogo de Meta”.
              </p>
            )}
          </div>

          {/* --- Importación --- */}
          <div className="flex flex-wrap items-center gap-3 border-t border-ink-100 pt-3">
            <label htmlFor="import-category" className="text-sm text-ink-700">Categoría destino</label>
            <select
              id="import-category"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm text-ink-800 focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30"
            >
              <option value="">Elegí una categoría…</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <span className="text-sm text-ink-500">{selected.size} seleccionado{selected.size === 1 ? '' : 's'}</span>
            <button
              onClick={() => setConfirmImport(true)}
              disabled={selected.size === 0 || !categoryId || importMut.isPending}
              className="rounded-lg bg-mint-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-50"
            >
              Importar seleccionados…
            </button>
          </div>

          {importMut.isError && (
            <p role="alert" className="rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">No se pudo importar: {errText(importMut.error)}</p>
          )}
          {importMut.isSuccess && importMut.data && (
            <div role="status" className={'space-y-1 rounded-lg px-3 py-2 text-sm ' + ((importMut.data.imported?.length ?? 0) > 0 ? 'bg-mint-50 text-mint-700' : 'bg-amber-50 text-amber-800')}>
              <p>
                {(importMut.data.imported?.length ?? 0) > 0 ? (
                  <>Importados {importMut.data.imported!.length} productos como <strong>inactivos</strong>. Revisá su stock y activalos cuando estén listos.</>
                ) : (
                  <>No se importó ningún artículo.</>
                )}
              </p>
              {importMut.data.blocked.length > 0 && (
                <ul className="space-y-0.5 text-xs">
                  {importMut.data.blocked.map((b) => (
                    <li key={b.retailerId}>
                      <span className="font-medium">{b.retailerId}</span>: {BLOCK_REASON_LABEL[b.reason] ?? b.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}

      {/* Modal: confirmar vínculo */}
      {confirmMap && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4" onClick={() => setConfirmMap(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="map-title" className="w-full max-w-md rounded-2xl border border-ink-100 bg-white p-6 shadow-float" onClick={(e) => e.stopPropagation()}>
            <h3 id="map-title" className="text-base font-semibold text-ink-900">¿Vincular con este artículo de Meta?</h3>
            <p className="mt-2 text-sm text-ink-600">
              <span className="font-medium text-ink-800">{confirmMap.productName}</span> va a quedar vinculado a{' '}
              <span className="font-medium text-ink-800">{confirmMap.candidate.name}</span> ({confirmMap.candidate.retailerId}).
            </p>
            <p className="mt-2 rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
              El vínculo es permanente y no se puede cambiar después. No modifica el precio, el costo ni el stock, y{' '}
              <strong>no envía nada a Meta</strong>: la sincronización se habilita por separado.
            </p>
            {mapMut.isError && <p role="alert" className="mt-3 rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">{errText(mapMut.error)}</p>}
            <div className="mt-5 flex justify-end gap-3">
              <button onClick={() => setConfirmMap(null)} className="rounded-lg border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50">
                Cancelar
              </button>
              <button
                onClick={() => mapMut.mutate({ productId: confirmMap.productId, retailerId: confirmMap.candidate.retailerId })}
                disabled={mapMut.isPending}
                className="rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60"
              >
                {mapMut.isPending ? 'Vinculando…' : 'Sí, vincular'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: confirmar importación */}
      {confirmImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4" onClick={() => setConfirmImport(false)}>
          <div role="dialog" aria-modal="true" aria-labelledby="imp-title" className="w-full max-w-md rounded-2xl border border-ink-100 bg-white p-6 shadow-float" onClick={(e) => e.stopPropagation()}>
            <h3 id="imp-title" className="text-base font-semibold text-ink-900">¿Importar {selected.size} artículo{selected.size === 1 ? '' : 's'}?</h3>
            <p className="mt-2 rounded-lg bg-ink-50 px-3 py-2 text-sm text-ink-700">
              Categoría destino: <strong>{categories.find((c) => c.id === categoryId)?.name ?? '—'}</strong>
            </p>
            <ul className="mt-2 space-y-1 text-sm text-ink-600">
              <li>• Se crean como productos <strong>inactivos</strong>: el bot no los va a ofrecer.</li>
              <li>• Se importan nombre, precio, marca, descripción e imagen.</li>
              <li>• El <strong>costo queda vacío</strong> y el <strong>stock sin definir</strong>: los completás vos.</li>
              <li>• <strong>No se modifica nada en Meta.</strong></li>
            </ul>
            <div className="mt-5 flex justify-end gap-3">
              <button onClick={() => setConfirmImport(false)} className="rounded-lg border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50">
                Cancelar
              </button>
              <button
                onClick={() => importMut.mutate()}
                disabled={importMut.isPending}
                className="rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60"
              >
                {importMut.isPending ? 'Importando…' : 'Sí, importar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function countFlag(items: RemoteCandidateItem[], flag: string): number {
  return items.filter((i) => i.flags.includes(flag as RemoteQualityFlag)).length;
}

function errText(e: unknown): string {
  const m = (e as { message?: string } | null)?.message;
  return m && m.trim() ? m : 'Error inesperado. Revisá tus permisos.';
}
