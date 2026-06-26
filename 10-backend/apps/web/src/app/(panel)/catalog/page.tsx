'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Product } from '@vpw/shared';
import { useActiveCompany } from '@/lib/active-company';
import {
  listProducts,
  listCategories,
  listProductFinancials,
  upsertProduct,
  deleteProduct,
  productMargin,
  syncCatalogToMeta,
  type ProductInput,
} from '@/lib/catalog';
import { ProductForm } from '@/components/ProductForm';

const gs = (n: number | null | undefined) =>
  n == null ? '—' : '₲ ' + n.toLocaleString('es-PY');

export default function CatalogPage() {
  const { tenantId, loading: companyLoading } = useActiveCompany();
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
  const syncMut = useMutation({ mutationFn: () => syncCatalogToMeta(tenantId!), onSuccess: () => qc.invalidateQueries({ queryKey: ['products', tenantId] }) });

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
          <button onClick={() => syncMut.mutate()} disabled={syncMut.isPending} className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50 disabled:opacity-50">
            {syncMut.isPending ? 'Sincronizando…' : 'Sincronizar a Meta'}
          </button>
          <button onClick={() => setEditing(null)} className="rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700">
            + Nuevo producto
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
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
                return (
                  <tr key={p.id} className="hover:bg-ink-50/50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-ink-900">
                        {p.emoji} {p.name} {p.featured && <span title="Destacado">🌟</span>}
                      </div>
                      {p.perfume?.brand && <div className="text-xs text-ink-400">{p.perfume.brand}</div>}
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
                      {p.metaSyncStatus === 'synced'
                        ? <span className="inline-flex rounded-full bg-mint-50 px-2 py-0.5 text-xs font-semibold text-mint-700">Sincronizado</span>
                        : <span className="text-xs text-ink-400">—</span>}
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

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4" onClick={() => setConfirmDelete(null)}>
          <div className="w-full max-w-sm rounded-2xl border border-ink-100 bg-white p-6 shadow-float" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-ink-900">¿Dar de baja el producto?</h3>
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
