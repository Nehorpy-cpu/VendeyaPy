'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Product } from '@vpw/shared';
import { aiFichaQuality } from '@vpw/shared';
import { useActiveCompany } from '@/lib/active-company';
import { useAuth } from '@/lib/auth-context';
import {
  listProducts,
  listCategories,
  listProductFinancials,
  upsertProduct,
  deleteProduct,
  productMargin,
  syncCatalogToMeta,
  setProductSyncEnabled,
  type CatalogSyncRun,
  type ProductInput,
  type SetSyncEnabledResult,
} from '@/lib/catalog';
import { ProductForm } from '@/components/ProductForm';
import { MetaReconciliation } from '@/components/MetaReconciliation';
import { OutboxIncidents } from '@/components/OutboxIncidents';

const gs = (n: number | null | undefined) =>
  n == null ? '—' : '₲ ' + n.toLocaleString('es-PY');

/** Habilitar la sincronización con Meta es una acción de dueño (el backend la restringe igual). */
const ROLES_RECONCILIACION = new Set(['TENANT_OWNER', 'PLATFORM_ADMIN']);

const SYNC_BLOCKER_LABEL: Record<string, string> = {
  not_active: 'el producto no está activo',
  name_missing: 'falta el nombre',
  price_invalid: 'el precio no es válido',
  currency_not_pyg: 'la moneda no es PYG',
  image_not_https: 'falta una imagen segura (https)',
  category_missing: 'falta la categoría',
  stock_pending_review: 'falta revisar el stock (editá el producto y guardá su inventario)',
  not_sellable_now: 'hoy no es vendible (sin stock)',
  unconfirmed_remote_match: 'su código ya existe en Meta: vinculalo desde la reconciliación antes de sincronizar',
  no_identity: 'falta el SKU o el vínculo con Meta',
  identity_too_long: 'el código supera los 100 caracteres que admite Meta',
  // Solo aparecen cuando el artículo todavía NO existe en Meta: crearlo exige estos datos.
  description_missing: 'falta la descripción (Meta la exige para crear el artículo)',
  brand_missing: 'falta la marca (Meta la exige para crear el artículo)',
  product_url_missing: 'falta el enlace al producto (editá el producto y cargá su URL)',
  product_url_not_https: 'el enlace al producto debe empezar con https://',
};

export default function CatalogPage() {
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const { claims } = useAuth();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Product | null | undefined>(undefined); // undefined = cerrado
  const [confirmDelete, setConfirmDelete] = useState<Product | null>(null);

  const productsQ = useQuery({
    queryKey: ['products', tenantId],
    queryFn: () => listProducts(tenantId!),
    enabled: !!tenantId,
  });
  const categoriesQ = useQuery({
    queryKey: ['categories', tenantId],
    queryFn: () => listCategories(tenantId!),
    enabled: !!tenantId,
  });
  // Costos privados (productFinancials): solo Owner/Manager pueden leerlos.
  const financialsQ = useQuery({
    queryKey: ['productFinancials', tenantId],
    queryFn: () => listProductFinancials(tenantId!),
    enabled: !!tenantId,
  });
  const finMap = financialsQ.data ?? {};

  const saveMut = useMutation({
    mutationFn: (input: ProductInput) => upsertProduct(tenantId!, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['products', tenantId] });
      qc.invalidateQueries({ queryKey: ['productFinancials', tenantId] });
      setEditing(undefined);
    },
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteProduct(tenantId!, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['products', tenantId] });
      qc.invalidateQueries({ queryKey: ['productFinancials', tenantId] });
      setConfirmDelete(null);
    },
  });
  // META-CATALOG-LIVE-1: el botón corre SIEMPRE un dry-run (plan sin escrituras en Meta).
  // "Aplicar" solo aparece si el backend confirma config en modo live, y con confirmación.
  const [syncRun, setSyncRun] = useState<CatalogSyncRun | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  // META-CATALOG-RECONCILIATION-1: opt-in de sincronización por producto (fail-closed).
  const puedeReconciliar = !!claims.role && ROLES_RECONCILIACION.has(claims.role);
  const [confirmSync, setConfirmSync] = useState<Product | null>(null);
  const [syncPreview, setSyncPreview] = useState<SetSyncEnabledResult | null>(null);
  const syncFlagMut = useMutation({
    mutationFn: (v: { productId: string; enabled: boolean; confirmDiff?: boolean }) =>
      setProductSyncEnabled(tenantId!, v.productId, v.enabled, { confirmDiff: v.confirmDiff }),
    onSuccess: (res, v) => {
      if (res.ok) {
        setConfirmSync(null);
        setSyncPreview(null);
        qc.invalidateQueries({ queryKey: ['products', tenantId] });
      } else if (v.enabled) {
        // El backend devuelve el diff a confirmar o la lista de requisitos que faltan.
        setSyncPreview(res);
      }
    },
  });
  const syncMut = useMutation({
    // META-CATALOG-PREVIEW-BINDING-1: el envío real viaja ATADO a la previsualización
    // aprobada (runId + planHash). Si algo cambió desde entonces, el backend responde
    // failed-precondition y NO encola nada: hay que previsualizar de nuevo.
    mutationFn: (apply: boolean) =>
      syncCatalogToMeta(tenantId!, {
        apply,
        ...(apply && syncRun?.planHash ? { preview: { runId: syncRun.runId, planHash: syncRun.planHash } } : {}),
      }),
    onSuccess: (run) => {
      setSyncRun(run);
      setConfirmApply(false);
      if (run.requestedMode === 'apply') qc.invalidateQueries({ queryKey: ['products', tenantId] });
    },
    onError: (_e, apply) => {
      setConfirmApply(false);
      // La evidencia quedó inválida (vencida/consumida/desactualizada): el plan mostrado ya
      // no es aplicable — se limpia para forzar una previsualización fresca.
      if (apply) setSyncRun(null);
    },
  });

  // Ocultamos los productos dados de baja (status ARCHIVED, por el soft-delete del callable).
  const activeProducts = useMemo(
    () => (productsQ.data ?? []).filter((p) => p.status !== 'ARCHIVED'),
    [productsQ.data],
  );
  const archivedCount = (productsQ.data ?? []).length - activeProducts.length;
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return activeProducts;
    return activeProducts.filter(
      (p) => p.name.toLowerCase().includes(s) || (p.perfume?.brand ?? '').toLowerCase().includes(s),
    );
  }, [activeProducts, search]);

  if (companyLoading) return <div className="text-sm text-ink-400">Cargando…</div>;
  if (!tenantId) {
    return (
      <div className="rounded-2xl border border-dashed border-ink-200 bg-white p-10 text-center text-sm text-ink-500">
        Seleccioná una empresa en la barra superior para ver su catálogo.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">Catálogo</h1>
          <p className="mt-1 text-sm text-ink-500">Tus productos, precios y stock. El bot ofrece lo que esté activo acá.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => syncMut.mutate(false)} disabled={syncMut.isPending} className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50 disabled:opacity-50">
            {syncMut.isPending ? 'Previsualizando…' : 'Previsualizar cambios'}
          </button>
          <button onClick={() => setEditing(null)} className="rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700">
            + Nuevo producto
          </button>
        </div>
      </div>

      {/* Solo el dueño puede resolver un envío trabado (el backend lo restringe igual). */}
      {puedeReconciliar && <OutboxIncidents tenantId={tenantId} />}

      <MetaReconciliation tenantId={tenantId} categories={categoriesQ.data ?? []} />

      {(syncMut.isError || syncRun) && (
        <div role="status" aria-live="polite" className="rounded-2xl border border-ink-100 bg-white p-4 shadow-soft">
          {syncMut.isError ? (
            <p className="rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">
              No se pudo correr la sincronización: {errMsg(syncMut.error)}
            </p>
          ) : syncRun ? (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-semibold text-ink-900">{syncTitle(syncRun)}</h2>
                <button
                  onClick={() => { setSyncRun(null); setConfirmApply(false); }}
                  className="text-xs font-medium text-ink-400 transition-colors hover:text-ink-600"
                >
                  Cerrar
                </button>
              </div>

              {syncRun.status === 'disabled' && (
                <p className="text-ink-600">
                  Esta empresa no tiene habilitada la sincronización de catálogo con Meta. Se habilita por configuración de la plataforma.
                </p>
              )}
              {syncRun.status === 'apply_blocked' && (
                <p className="text-ink-600">
                  La configuración está en modo <span className="font-semibold">{syncRun.configMode}</span>: aplicar cambios reales en Meta requiere el modo <span className="font-semibold">live</span>.
                </p>
              )}
              {syncRun.status === 'error' && (
                <p className="rounded-lg bg-coral-50 px-3 py-2 text-coral-700">{syncErrorText(syncRun)}</p>
              )}

              {syncRun.summary && (
                <>
                  <div className="flex flex-wrap gap-2 text-xs">
                    <SyncChip label="Crear" n={syncRun.summary.create} tone="mint" />
                    <SyncChip label="Actualizar" n={syncRun.summary.update} tone="mint" />
                    <SyncChip label="Deshabilitar" n={syncRun.summary.disable} tone="amber" />
                    <SyncChip label="Sin cambios" n={syncRun.summary.unchanged} tone="ink" />
                    <SyncChip label="Bloqueados" n={syncRun.summary.blocked} tone="coral" />
                    <SyncChip label="Solo en Meta" n={syncRun.summary.remoteOnly} tone="ink" />
                  </div>
                  {(syncRun.excludedNotManaged ?? 0) > 0 && (
                    <p className="text-xs text-ink-500">
                      {syncRun.excludedNotManaged} producto{syncRun.excludedNotManaged === 1 ? '' : 's'} sin sincronización habilitada:
                      quedan fuera de esta corrida (no se crean, no se actualizan ni se dan de baja en Meta).
                    </p>
                  )}
                </>
              )}

              {(syncRun.entries ?? []).some((e) => e.action === 'blocked') && (
                <ul className="space-y-1 rounded-lg bg-coral-50/60 px-3 py-2 text-xs text-coral-800">
                  {(syncRun.entries ?? [])
                    .filter((e) => e.action === 'blocked')
                    .map((e) => (
                      <li key={e.productId}>
                        <span className="font-medium">{e.productName}</span>
                        {e.sku ? ` (SKU ${e.sku})` : ''}: {(e.blockedReasons ?? []).map(blockReasonLabel).join(', ')}
                        {e.suggestion && (
                          <> — en Meta existe “{e.suggestion.remoteName}” con SKU {e.suggestion.remoteRetailerId}; verificá el SKU antes de sincronizar.</>
                        )}
                      </li>
                    ))}
                </ul>
              )}

              {(syncRun.status === 'queued' || syncRun.status === 'partial_failure') && (
                <div className={syncRun.status === 'queued' ? 'text-mint-700' : 'text-coral-700'} role="status">
                  <p>
                    En cola: {syncRun.queuedCount ?? 0}
                    {(syncRun.deduplicatedCount ?? 0) > 0 ? ` · Ya estaban en cola: ${syncRun.deduplicatedCount}` : ''}
                    {(syncRun.awaitingReviewCount ?? 0) > 0 ? ` · Esperando tu revisión: ${syncRun.awaitingReviewCount}` : ''}
                    {(syncRun.blockedCount ?? 0) > 0 ? ` · Con problemas: ${syncRun.blockedCount}` : ''}
                    {syncRun.errorDetail ? ` — ${syncRun.errorDetail}` : ''}
                  </p>
                  {/* Honestidad explícita: encolar NO es haber cambiado nada en Meta. */}
                  <p className="mt-1 text-xs text-ink-500">
                    Los cambios salen hacia Meta en los próximos minutos. Cada producto muestra su estado en la lista y
                    solo dice <strong>Confirmado</strong> cuando Meta confirma que quedó igual que acá.
                  </p>
                </div>
              )}

              {syncRun.status === 'planned' && (
                <div className="flex flex-wrap items-center gap-3 border-t border-ink-100 pt-3">
                  {syncRun.configMode === 'live' ? (
                    // El envío real solo se ofrece con evidencia (planHash) y con algo para
                    // enviar: va atado a ESTA previsualización, con cantidad y producto a la vista.
                    !syncRun.planHash || applySummary(syncRun).count === 0 ? (
                      <p className="text-xs text-ink-400">
                        {applySummary(syncRun).count === 0
                          ? 'No hay cambios para enviar: todo está igual que en Meta o excluido del plan.'
                          : 'Esta previsualización no es utilizable para enviar. Previsualizá de nuevo.'}
                      </p>
                    ) : confirmApply ? (
                      <>
                        <span className="text-xs text-ink-600">{applySummary(syncRun).confirm}</span>
                        <button
                          onClick={() => syncMut.mutate(true)}
                          disabled={syncMut.isPending}
                          className="rounded-lg bg-mint-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60"
                        >
                          {syncMut.isPending ? 'Encolando…' : 'Sí, enviar'}
                        </button>
                        <button
                          onClick={() => setConfirmApply(false)}
                          className="rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 transition-colors hover:bg-ink-50"
                        >
                          Cancelar
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setConfirmApply(true)}
                        className="rounded-lg border border-mint-600 px-3 py-1.5 text-xs font-semibold text-mint-700 transition-colors hover:bg-mint-50"
                      >
                        {applySummary(syncRun).label}
                      </button>
                    )
                  ) : (
                    <p className="text-xs text-ink-400">
                      Modo dry-run: esta previsualización no escribió nada en Meta. Para aplicar cambios reales, la plataforma debe activar el modo live.
                    </p>
                  )}
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Buscar productos por nombre o marca"
          placeholder="Buscar por nombre o marca…"
          className="w-full max-w-sm rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 transition-colors focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30"
        />
        {archivedCount > 0 && (
          <p className="text-xs text-ink-400">
            {archivedCount} producto{archivedCount === 1 ? '' : 's'} dado{archivedCount === 1 ? '' : 's'} de baja (ocultos).
          </p>
        )}
      </div>

      {productsQ.isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-14 animate-pulse rounded-xl border border-ink-100 bg-ink-50/60" />)}
        </div>
      )}
      {productsQ.isError && (
        <div className="rounded-2xl border border-coral-200 bg-coral-50 px-4 py-3 text-sm text-coral-700">
          No se pudo cargar el catálogo. Revisá tu sesión y permisos.
        </div>
      )}

      {productsQ.isSuccess && filtered.length === 0 && (
        <div className="rounded-2xl border border-dashed border-ink-200 bg-white p-10 text-center">
          <h3 className="text-sm font-semibold text-ink-800">{search ? 'Sin coincidencias' : 'Todavía no hay productos'}</h3>
          <p className="mx-auto mt-1 max-w-sm text-sm text-ink-500">
            {search ? 'No hay productos que coincidan con la búsqueda.' : 'Creá el primero con “+ Nuevo producto” para que el bot pueda ofrecerlo.'}
          </p>
        </div>
      )}

      {productsQ.isSuccess && filtered.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-ink-100 bg-white shadow-soft">
          <table className="min-w-full text-sm">
            <thead className="border-b border-ink-100 bg-ink-50/60 text-left text-xs uppercase tracking-wide text-ink-400">
              <tr>
                <th className="px-4 py-3">Producto</th>
                <th className="px-4 py-3">Precio</th>
                <th className="px-4 py-3">Costo</th>
                <th className="px-4 py-3">Margen</th>
                <th className="px-4 py-3">Stock</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Meta</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-50">
              {filtered.map((p) => {
                const cost = finMap[p.id]?.costPrice ?? null;
                const margin = productMargin(p.price, cost);
                const stock = p.inventory?.stock ?? 0;
                // Ficha para recomendaciones (CAT-1): avisar si al agente le falta info clave.
                const calidad = aiFichaQuality(p);
                const fichaIncompleta = calidad.level === 'incompleto' || calidad.level === 'basico';
                return (
                  <tr key={p.id} className="hover:bg-ink-50/50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-ink-900">
                        {p.emoji} {p.name} {p.featured && <span title="Destacado">🌟</span>}
                      </div>
                      {p.perfume?.brand && <div className="text-xs text-ink-400">{p.perfume.brand}</div>}
                      {fichaIncompleta && (
                        <span
                          className="mt-1 inline-flex rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700"
                          title={'La IA recomienda mejor con la ficha completa. Falta: ' + calidad.faltantes.slice(0, 4).join(', ')}
                        >
                          Ficha IA incompleta
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-ink-700">{gs(p.price)}</td>
                    <td className="px-4 py-3 text-ink-600">{gs(cost)}</td>
                    <td className="px-4 py-3">
                      {margin == null ? (
                        <span className="text-amber-600" title="Sin precio de costo → ganancia incompleta">⚠️ sin costo</span>
                      ) : (
                        <span className={margin < 15 ? 'font-medium text-coral-600' : 'text-ink-700'}>{Math.round(margin)}%</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={stock <= 3 ? 'inline-flex rounded-full bg-coral-50 px-2 py-0.5 text-xs font-semibold text-coral-600' : 'text-ink-700'}>
                        {stock} u.
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={'inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ' + (p.status === 'ACTIVE' ? 'bg-mint-50 text-mint-700' : 'bg-ink-50 text-ink-500')}>
                        {p.status === 'ACTIVE' ? 'Activo' : p.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col items-start gap-1">
                        {p.syncToMeta === true ? (
                          <SyncBadge status={p.metaSyncStatus} error={p.metaSyncError} />
                        ) : (
                          <span className="inline-flex rounded-full bg-ink-50 px-2 py-0.5 text-xs font-semibold text-ink-500">No se sincroniza</span>
                        )}
                        {p.metaRetailerId && <span className="text-[11px] text-ink-400">↔ {p.metaRetailerId}</span>}
                        {puedeReconciliar && (
                          <button
                            onClick={() => (p.syncToMeta === true ? syncFlagMut.mutate({ productId: p.id, enabled: false }) : setConfirmSync(p))}
                            disabled={syncFlagMut.isPending}
                            className="text-[11px] font-medium text-mint-700 underline-offset-2 hover:underline disabled:opacity-50"
                          >
                            {p.syncToMeta === true ? 'Dejar de sincronizar' : 'Sincronizar con Meta…'}
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => setEditing(p)} className="mr-3 font-medium text-mint-700 hover:text-mint-600">Editar</button>
                      <button onClick={() => setConfirmDelete(p)} className="font-medium text-coral-600 hover:text-coral-700">Borrar</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing !== undefined && (
        <ProductForm
          initial={editing}
          initialCost={editing ? (finMap[editing.id]?.costPrice ?? null) : null}
          initialPriority={editing ? (finMap[editing.id]?.priorityScore ?? null) : null}
          categories={categoriesQ.data ?? []}
          onCancel={() => setEditing(undefined)}
          onSubmit={(input) => saveMut.mutate(input)}
          saving={saveMut.isPending}
          error={saveMut.isError ? errMsg(saveMut.error) : null}
        />
      )}

      {confirmSync && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4" onClick={() => { setConfirmSync(null); setSyncPreview(null); }}>
          <div role="dialog" aria-modal="true" aria-labelledby="sync-title" className="w-full max-w-md rounded-2xl border border-ink-100 bg-white p-6 shadow-float" onClick={(e) => e.stopPropagation()}>
            <h3 id="sync-title" className="text-base font-semibold text-ink-900">Sincronizar este producto con Meta</h3>
            <p className="mt-2 text-sm text-ink-600">
              <span className="font-medium text-ink-800">{confirmSync.name}</span>
            </p>

            {!syncPreview && (
              <p className="mt-3 text-sm text-ink-600">
                Vamos a revisar si cumple los requisitos y a mostrarte exactamente qué se enviaría a Meta.
              </p>
            )}

            {syncPreview && syncPreview.blockers.length > 0 && (
              <div className="mt-3 rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">
                <p className="font-medium">Todavía no se puede sincronizar:</p>
                <ul className="mt-1 space-y-0.5 text-xs">
                  {syncPreview.blockers.map((b) => <li key={b}>• {SYNC_BLOCKER_LABEL[b] ?? b}</li>)}
                </ul>
              </div>
            )}

            {syncPreview?.requiresConfirmation && (
              <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                <p className="font-medium">{syncPreview.intent === 'update' ? 'Se va a ACTUALIZAR un artículo existente' : 'Se va a CREAR un artículo nuevo'}</p>
                <p className="mt-1 text-xs">{syncPreview.message}</p>
                <p className="mt-1 text-xs">Código en Meta: <strong>{syncPreview.retailerId}</strong></p>
              </div>
            )}

            {syncFlagMut.isError && <p role="alert" className="mt-3 rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">{errMsg(syncFlagMut.error)}</p>}

            <div className="mt-5 flex justify-end gap-3">
              <button onClick={() => { setConfirmSync(null); setSyncPreview(null); }} className="rounded-lg border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50">
                {syncPreview && syncPreview.blockers.length > 0 ? 'Entendido' : 'Cancelar'}
              </button>
              {(!syncPreview || syncPreview.requiresConfirmation) && (
                <button
                  onClick={() => syncFlagMut.mutate({ productId: confirmSync.id, enabled: true, confirmDiff: !!syncPreview?.requiresConfirmation })}
                  disabled={syncFlagMut.isPending}
                  className="rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60"
                >
                  {syncFlagMut.isPending ? 'Verificando…' : syncPreview?.requiresConfirmation ? 'Sí, sincronizar' : 'Revisar requisitos'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4" onClick={() => setConfirmDelete(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="confirm-delete-title" className="w-full max-w-sm rounded-2xl border border-ink-100 bg-white p-6 shadow-float" onClick={(e) => e.stopPropagation()}>
            <h3 id="confirm-delete-title" className="text-base font-semibold text-ink-900">¿Dar de baja el producto?</h3>
            <p className="mt-2 text-sm text-ink-600">
              <span className="font-medium text-ink-800">{confirmDelete.name}</span> se va a archivar: deja de mostrarse en el catálogo y al bot, pero se conservan sus pedidos y su costo. Podés reactivarlo editándolo y poniéndolo en ACTIVE.
            </p>
            {deleteMut.isError && (
              <p className="mt-3 rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">{errMsg(deleteMut.error)}</p>
            )}
            <div className="mt-5 flex justify-end gap-3">
              <button onClick={() => setConfirmDelete(null)} className="rounded-lg border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50">
                Cancelar
              </button>
              <button
                onClick={() => deleteMut.mutate(confirmDelete.id)}
                disabled={deleteMut.isPending}
                className="rounded-lg bg-coral-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-coral-700 disabled:opacity-60"
              >
                {deleteMut.isPending ? 'Archivando…' : 'Dar de baja'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Mensaje legible de un error de callable (HttpsError trae `message` claro). */
function errMsg(e: unknown): string {
  const m = (e as { message?: string } | null)?.message;
  return m && m.trim() ? m : 'No se pudo completar la operación. Revisá tus permisos o tu plan.';
}

// --- Presentación del resultado de la sync de catálogo (META-CATALOG-LIVE-1) ---

function syncTitle(run: CatalogSyncRun): string {
  switch (run.status) {
    case 'disabled': return 'Sincronización con Meta desactivada';
    case 'apply_blocked': return 'Aplicación bloqueada';
    case 'error': return 'Error al consultar Meta';
    case 'planned': return 'Previsualización del catálogo (sin escrituras en Meta)';
    case 'queued': return 'Cambios encolados hacia Meta';
    case 'partial_failure': return 'Encolado parcial (con problemas)';
  }
}

function syncErrorText(run: CatalogSyncRun): string {
  if (run.reason === 'missing_token') return 'No hay conexión con Meta configurada para esta empresa (falta el token).';
  if (run.reason === 'catalog_unreachable') return `No se pudo acceder al catálogo en Meta. ${run.errorDetail ?? ''}`.trim();
  return run.errorDetail ?? 'Error desconocido.';
}

/**
 * META-CATALOG-PREVIEW-BINDING-1: la acción real dice EXACTAMENTE qué manda — cantidad y,
 * si es un solo cambio, el producto. "Enviar 1 cambio a Meta (Armaf Odyssey Mega)" en vez
 * de un genérico "Enviar a Meta".
 */
function applySummary(run: CatalogSyncRun): { count: number; label: string; confirm: string } {
  const s = run.summary;
  const count = (s?.create ?? 0) + (s?.update ?? 0) + (s?.disable ?? 0);
  if (count === 1) {
    const entry = (run.entries ?? []).find((e) => e.action === 'create' || e.action === 'update' || e.action === 'disable');
    const quien = entry ? ` (${entry.productName})` : '';
    return { count, label: `Enviar 1 cambio a Meta${quien}…`, confirm: `¿Enviar 1 cambio al catálogo real de Meta${quien}?` };
  }
  return { count, label: `Enviar ${count} cambios a Meta…`, confirm: `¿Enviar ${count} cambios al catálogo real de Meta?` };
}

/**
 * Estado de sincronización de UN producto. META-CATALOG-OUTBOX-1: confirmar el plan encola
 * trabajo, así que el vendedor tiene que poder distinguir "todavía no salió" de "Meta lo
 * confirmó". `Sincronizado` significa CONFIRMADO contra Meta — nunca "lo mandamos".
 */
const SYNC_BADGE: Record<string, { label: string; clase: string; ayuda: string }> = {
  queued: { label: 'En cola', clase: 'bg-amber-50 text-amber-700', ayuda: 'El cambio está esperando su turno para enviarse a Meta.' },
  // `processing` cubre desde que el worker toma el cambio hasta que Meta lo confirma: puede
  // estar todavía preparando el envío, así que decir "ya salió" sería afirmar de más.
  processing: { label: 'Procesando', clase: 'bg-amber-50 text-amber-700', ayuda: 'Lo estamos enviando a Meta. Falta la confirmación.' },
  synced: { label: 'Confirmado', clase: 'bg-mint-50 text-mint-700', ayuda: 'Meta confirmó que el artículo quedó igual que acá.' },
  disabled: { label: 'Oculto en Meta', clase: 'bg-ink-50 text-ink-500', ayuda: 'El artículo quedó sin stock en el catálogo de Meta.' },
  needs_review: { label: 'Requiere revisión', clase: 'bg-amber-50 text-amber-800', ayuda: 'No se pudo confirmar solo: revisá el producto antes de reintentar.' },
  failed: { label: 'Error', clase: 'bg-coral-50 text-coral-600', ayuda: 'Meta rechazó el cambio.' },
  pending: { label: 'Procesando', clase: 'bg-amber-50 text-amber-700', ayuda: 'Lo estamos enviando a Meta. Falta la confirmación.' },
};

function SyncBadge({ status, error }: { status?: string; error?: string | null }) {
  const s = status ? SYNC_BADGE[status] : undefined;
  if (!s) {
    return <span className="inline-flex rounded-full bg-mint-50 px-2 py-0.5 text-xs font-semibold text-mint-700">Se sincroniza</span>;
  }
  return (
    <span title={error || s.ayuda} className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${s.clase}`}>
      {s.label}
    </span>
  );
}

function blockReasonLabel(r: string): string {
  switch (r) {
    case 'sku_missing': return 'sin SKU';
    case 'sku_duplicated': return 'SKU duplicado';
    case 'name_missing': return 'sin nombre';
    case 'currency_not_pyg': return 'la moneda no es PYG';
    case 'price_invalid': return 'precio inválido';
    case 'image_not_https': return 'sin imagen HTTPS';
    case 'name_conflict_requires_confirmation': return 'coincide por nombre con un item de Meta (requiere confirmación)';
    case 'retailer_id_duplicated': return 'dos productos reclaman el mismo artículo de Meta';
    case 'identity_too_long': return 'el identificador supera los 100 caracteres que admite Meta';
    case 'description_missing': return 'sin descripción';
    case 'brand_missing': return 'sin marca';
    case 'product_url_missing': return 'sin enlace al producto';
    case 'product_url_not_https': return 'el enlace al producto no es HTTPS';
    case 'no_writable_change': return 'no hay cambios publicables';
    case 'serialization_failed': return 'los datos del producto no entran en el formato de Meta';
    default: return r;
  }
}

function SyncChip({ label, n, tone }: { label: string; n: number; tone: 'mint' | 'amber' | 'coral' | 'ink' }) {
  const tones: Record<string, string> = {
    mint: 'bg-mint-50 text-mint-700',
    amber: 'bg-amber-50 text-amber-700',
    coral: 'bg-coral-50 text-coral-600',
    ink: 'bg-ink-50 text-ink-500',
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold ${n > 0 ? tones[tone] : 'bg-ink-50 text-ink-400'}`}>
      {label}: {n}
    </span>
  );
}
