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

  if (companyLoading) return <div className="text-gray-400">Cargando…</div>;
  if (!tenantId) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
        Seleccioná una empresa en la barra superior para ver su catálogo.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900">Catálogo</h1>
        <div className="flex gap-2">
          <button onClick={() => syncMut.mutate()} disabled={syncMut.isPending} className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">
            {syncMut.isPending ? 'Sincronizando…' : '🛒 Sincronizar a Meta'}
          </button>
          <button onClick={() => setEditing(null)} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
            + Nuevo producto
          </button>
        </div>
      </div>

      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Buscar por nombre o marca…"
        className="w-full max-w-sm rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
      />

      {archivedCount > 0 && (
        <p className="text-xs text-gray-400">
          {archivedCount} producto{archivedCount === 1 ? '' : 's'} dado{archivedCount === 1 ? '' : 's'} de baja (ocultos).
        </p>
      )}

      {productsQ.isLoading && <div className="text-gray-400">Cargando productos…</div>}
      {productsQ.isError && (
        <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">
          No se pudo cargar el catálogo. Revisá tu sesión y permisos.
        </div>
      )}

      {productsQ.isSuccess && filtered.length === 0 && (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
          {search ? 'No hay productos que coincidan con la búsqueda.' : 'Todavía no hay productos. Creá el primero con “+ Nuevo producto”.'}
        </div>
      )}

      {productsQ.isSuccess && filtered.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
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
            <tbody className="divide-y divide-gray-100">
              {filtered.map((p) => {
                const cost = finMap[p.id]?.costPrice ?? null;
                const margin = productMargin(p.price, cost);
                return (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">
                        {p.emoji} {p.name} {p.featured && <span title="Destacado">🌟</span>}
                      </div>
                      <div className="text-xs text-gray-500">{p.perfume?.brand}</div>
                    </td>
                    <td className="px-4 py-3">{gs(p.price)}</td>
                    <td className="px-4 py-3">{gs(cost)}</td>
                    <td className="px-4 py-3">
                      {margin == null ? (
                        <span className="text-amber-600" title="Sin precio de costo → ganancia incompleta">⚠️ sin costo</span>
                      ) : (
                        <span className={margin < 15 ? 'text-red-600' : 'text-gray-700'}>{Math.round(margin)}%</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={(p.inventory?.stock ?? 0) <= 3 ? 'text-red-600' : ''}>
                        {p.inventory?.stock ?? 0}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={p.status === 'ACTIVE' ? 'text-brand-700' : 'text-gray-400'}>
                        {p.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {p.metaSyncStatus === 'synced' ? <span className="text-xs text-brand-700">🟢 Sincronizado</span> : <span className="text-xs text-gray-400">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => setEditing(p)} className="mr-3 text-brand-700 hover:underline">Editar</button>
                      <button onClick={() => setConfirmDelete(p)} className="text-red-600 hover:underline">Borrar</button>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="text-base font-semibold text-gray-900">¿Dar de baja el producto?</h3>
            <p className="mt-2 text-sm text-gray-600">
              <span className="font-medium">{confirmDelete.name}</span> se va a archivar: deja de mostrarse en el catálogo y al bot, pero se conservan sus pedidos y su costo. Podés reactivarlo editándolo y poniéndolo en ACTIVE.
            </p>
            {deleteMut.isError && (
              <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{errMsg(deleteMut.error)}</p>
            )}
            <div className="mt-5 flex justify-end gap-3">
              <button onClick={() => setConfirmDelete(null)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100">
                Cancelar
              </button>
              <button
                onClick={() => deleteMut.mutate(confirmDelete.id)}
                disabled={deleteMut.isPending}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
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
