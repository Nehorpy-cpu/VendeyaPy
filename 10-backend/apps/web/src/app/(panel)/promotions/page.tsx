'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Promotion, Insight, Product, PromotionType, PromotionStatus } from '@vpw/shared';
import { useActiveCompany } from '@/lib/active-company';
import { listProducts } from '@/lib/catalog';
import {
  listPromotions,
  upsertPromotion,
  deletePromotion,
  listPromoSuggestions,
  setInsightStatus,
  tsToDateInput,
  type PromotionInput,
} from '@/lib/promotions';

const API = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:5001/demo-aiafg/us-central1';

const TYPE_LABEL: Record<PromotionType, string> = {
  PERCENTAGE: '% Descuento',
  FIXED_AMOUNT: 'Monto fijo',
  BUNDLE: 'Combo',
  TWO_FOR_ONE: '2x1',
  FREE_SHIPPING: 'Envío gratis',
};
const STATUS_LABEL: Record<PromotionStatus, string> = {
  DRAFT: 'Borrador',
  ACTIVE: 'Activa',
  PAUSED: 'Pausada',
  FINISHED: 'Finalizada',
};
const STATUS_STYLE: Record<PromotionStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-600',
  ACTIVE: 'bg-brand-100 text-brand-700',
  PAUSED: 'bg-amber-100 text-amber-700',
  FINISHED: 'bg-gray-100 text-gray-400',
};

const field = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none';
const lbl = 'mb-1 block text-xs font-medium text-gray-600';

export default function PromotionsPage() {
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const qc = useQueryClient();
  const [form, setForm] = useState<{ open: boolean; promo: Promotion | null; prefill: Partial<PromotionInput> | null; fromInsight: string | null }>({
    open: false,
    promo: null,
    prefill: null,
    fromInsight: null,
  });
  const [confirmDel, setConfirmDel] = useState<Promotion | null>(null);

  const promosQ = useQuery({ queryKey: ['promotions', tenantId], queryFn: () => listPromotions(tenantId!), enabled: !!tenantId });
  const productsQ = useQuery({ queryKey: ['products', tenantId], queryFn: () => listProducts(tenantId!), enabled: !!tenantId });
  const suggestionsQ = useQuery({ queryKey: ['promoSuggestions', tenantId], queryFn: () => listPromoSuggestions(tenantId!), enabled: !!tenantId });

  const saveMut = useMutation({
    mutationFn: async (input: PromotionInput) => {
      await upsertPromotion(tenantId!, input);
      if (form.fromInsight) await setInsightStatus(tenantId!, form.fromInsight, 'ACCEPTED');
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['promotions', tenantId] });
      qc.invalidateQueries({ queryKey: ['promoSuggestions', tenantId] });
      setForm({ open: false, promo: null, prefill: null, fromInsight: null });
    },
  });
  const delMut = useMutation({
    mutationFn: (id: string) => deletePromotion(tenantId!, id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['promotions', tenantId] }); setConfirmDel(null); },
  });
  const statusMut = useMutation({
    mutationFn: ({ p, status }: { p: Promotion; status: PromotionStatus }) =>
      upsertPromotion(tenantId!, promoToInput(p, status)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['promotions', tenantId] }),
  });
  const dismissMut = useMutation({
    mutationFn: (id: string) => setInsightStatus(tenantId!, id, 'DISMISSED'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['promoSuggestions', tenantId] }),
  });
  const genMut = useMutation({
    mutationFn: async () => {
      await fetch(`${API}/devGenerateSuggestions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId }) });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['promoSuggestions', tenantId] }),
  });

  const suggestions = suggestionsQ.data ?? [];

  if (companyLoading) return <div className="text-gray-400">Cargando…</div>;
  if (!tenantId) {
    return <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">Seleccioná una empresa.</div>;
  }

  const openNew = () => setForm({ open: true, promo: null, prefill: null, fromInsight: null });
  const openEdit = (p: Promotion) => setForm({ open: true, promo: p, prefill: null, fromInsight: null });
  const openFromInsight = (i: Insight) =>
    setForm({
      open: true,
      promo: null,
      fromInsight: i.id,
      prefill: {
        name: i.title.replace(/^Destacá |^Mové el stock de /, 'Promo: '),
        objective: i.recommendedAction,
        type: 'PERCENTAGE',
        discountValue: 10,
        status: 'DRAFT',
        productIds: i.relatedEntityId ? [i.relatedEntityId] : [],
      },
    });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900">Promotion Strategy</h1>
        <button onClick={openNew} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">+ Nueva promo</button>
      </div>

      {/* Sugerencias por reglas */}
      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">💡 Sugerencias para vos</h2>
          <button onClick={() => genMut.mutate()} disabled={genMut.isPending} className="text-xs text-brand-700 hover:underline disabled:opacity-50">
            {genMut.isPending ? 'Buscando…' : 'Actualizar sugerencias'}
          </button>
        </div>
        {suggestions.length === 0 ? (
          <p className="text-sm text-gray-400">No hay sugerencias por ahora. Tocá “Actualizar sugerencias”.</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {suggestions.map((i) => (
              <div key={i.id} className="rounded-lg border border-gray-200 p-3">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium text-gray-900">{i.title}</span>
                  <span className={'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ' + (i.priority === 'HIGH' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700')}>{i.priority === 'HIGH' ? 'urgente' : 'oportunidad'}</span>
                </div>
                <p className="mt-1 text-xs text-gray-600">{i.description}</p>
                <p className="mt-1 text-xs text-gray-500">📈 {i.estimatedImpact}</p>
                <div className="mt-2 flex gap-2">
                  <button onClick={() => openFromInsight(i)} className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700">Crear promo</button>
                  <button onClick={() => dismissMut.mutate(i.id)} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">Descartar</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Lista de promos */}
      {promosQ.isLoading && <div className="text-gray-400">Cargando promociones…</div>}
      {promosQ.isSuccess && (promosQ.data?.length ?? 0) === 0 && (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
          Todavía no hay promociones. Creá una con “+ Nueva promo” o desde una sugerencia.
        </div>
      )}
      {promosQ.isSuccess && (promosQ.data?.length ?? 0) > 0 && (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-3">Promo</th>
                <th className="px-4 py-3">Tipo</th>
                <th className="px-4 py-3">Descuento</th>
                <th className="px-4 py-3">Vigencia</th>
                <th className="px-4 py-3">Productos</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {promosQ.data!.map((p) => (
                <tr key={p.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3"><div className="font-medium text-gray-900">{p.name}</div><div className="text-xs text-gray-500">{p.objective}</div></td>
                  <td className="px-4 py-3">{TYPE_LABEL[p.type]}</td>
                  <td className="px-4 py-3">{p.type === 'PERCENTAGE' ? `${p.discountValue}%` : p.type === 'FIXED_AMOUNT' ? `₲ ${p.discountValue.toLocaleString('es-PY')}` : '—'}</td>
                  <td className="px-4 py-3 text-xs text-gray-600">{tsToDateInput(p.startDate) || '—'} → {tsToDateInput(p.endDate) || '—'}</td>
                  <td className="px-4 py-3">{p.productIds?.length ?? 0}</td>
                  <td className="px-4 py-3"><span className={'rounded-full px-2 py-0.5 text-xs font-medium ' + STATUS_STYLE[p.status]}>{STATUS_LABEL[p.status]}</span></td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {p.status === 'ACTIVE' ? (
                      <button onClick={() => statusMut.mutate({ p, status: 'PAUSED' })} className="mr-3 text-amber-600 hover:underline">Pausar</button>
                    ) : p.status !== 'FINISHED' ? (
                      <button onClick={() => statusMut.mutate({ p, status: 'ACTIVE' })} className="mr-3 text-brand-700 hover:underline">Activar</button>
                    ) : null}
                    <button onClick={() => openEdit(p)} className="mr-3 text-brand-700 hover:underline">Editar</button>
                    <button onClick={() => setConfirmDel(p)} className="text-red-600 hover:underline">Finalizar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {form.open && (
        <PromoForm
          initial={form.promo}
          prefill={form.prefill}
          products={productsQ.data ?? []}
          saving={saveMut.isPending}
          onCancel={() => setForm({ open: false, promo: null, prefill: null, fromInsight: null })}
          onSubmit={(input) => saveMut.mutate(input)}
        />
      )}

      {confirmDel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="text-base font-semibold text-gray-900">¿Finalizar promoción?</h3>
            <p className="mt-2 text-sm text-gray-600">Vas a finalizar <span className="font-medium">{confirmDel.name}</span>. Dejará de estar activa y saldrá del listado (se conserva el historial).</p>
            <div className="mt-5 flex justify-end gap-3">
              <button onClick={() => setConfirmDel(null)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100">Cancelar</button>
              <button onClick={() => delMut.mutate(confirmDel.id)} disabled={delMut.isPending} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60">{delMut.isPending ? 'Finalizando…' : 'Finalizar'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function promoToInput(p: Promotion, status: PromotionStatus): PromotionInput {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    type: p.type,
    discountValue: p.discountValue,
    objective: p.objective,
    productIds: p.productIds ?? [],
    categoryIds: p.categoryIds ?? [],
    startDate: tsToDateInput(p.startDate) || null,
    endDate: tsToDateInput(p.endDate) || null,
    status,
  };
}

function PromoForm({
  initial,
  prefill,
  products,
  saving,
  onCancel,
  onSubmit,
}: {
  initial: Promotion | null;
  prefill: Partial<PromotionInput> | null;
  products: Product[];
  saving: boolean;
  onCancel: () => void;
  onSubmit: (input: PromotionInput) => void;
}) {
  const [f, setF] = useState<PromotionInput>({
    ...(initial ? { id: initial.id } : {}),
    name: initial?.name ?? prefill?.name ?? '',
    description: initial?.description ?? prefill?.description ?? '',
    type: initial?.type ?? prefill?.type ?? 'PERCENTAGE',
    discountValue: initial?.discountValue ?? prefill?.discountValue ?? 10,
    objective: initial?.objective ?? prefill?.objective ?? '',
    productIds: initial?.productIds ?? prefill?.productIds ?? [],
    categoryIds: initial?.categoryIds ?? prefill?.categoryIds ?? [],
    startDate: initial ? tsToDateInput(initial.startDate) || null : prefill?.startDate ?? null,
    endDate: initial ? tsToDateInput(initial.endDate) || null : prefill?.endDate ?? null,
    status: initial?.status ?? prefill?.status ?? 'DRAFT',
  });
  const set = <K extends keyof PromotionInput>(k: K, v: PromotionInput[K]) => setF((s) => ({ ...s, [k]: v }));
  const toggleProduct = (id: string) => set('productIds', f.productIds.includes(id) ? f.productIds.filter((x) => x !== id) : [...f.productIds, id]);
  const showDiscount = f.type === 'PERCENTAGE' || f.type === 'FIXED_AMOUNT';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <form
        onSubmit={(e) => { e.preventDefault(); onSubmit({ ...f, name: f.name.trim(), discountValue: showDiscount ? Number(f.discountValue) || 0 : 0 }); }}
        className="my-8 w-full max-w-xl rounded-2xl bg-white p-6 shadow-xl"
      >
        <h2 className="mb-4 text-lg font-bold text-gray-900">{initial ? 'Editar promoción' : 'Nueva promoción'}</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><label className={lbl}>Nombre *</label><input className={field} required value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
          <div><label className={lbl}>Tipo</label>
            <select className={field} value={f.type} onChange={(e) => set('type', e.target.value as PromotionType)}>
              {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          {showDiscount && (
            <div><label className={lbl}>{f.type === 'PERCENTAGE' ? 'Descuento (%)' : 'Descuento (₲)'}</label>
              <input className={field} type="number" value={f.discountValue} onChange={(e) => set('discountValue', Number(e.target.value))} />
            </div>
          )}
          <div><label className={lbl}>Desde</label><input className={field} type="date" value={f.startDate ?? ''} onChange={(e) => set('startDate', e.target.value || null)} /></div>
          <div><label className={lbl}>Hasta</label><input className={field} type="date" value={f.endDate ?? ''} onChange={(e) => set('endDate', e.target.value || null)} /></div>
          <div><label className={lbl}>Estado</label>
            <select className={field} value={f.status} onChange={(e) => set('status', e.target.value as PromotionStatus)}>
              {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="sm:col-span-2"><label className={lbl}>Objetivo</label><input className={field} value={f.objective} onChange={(e) => set('objective', e.target.value)} placeholder="rotar stock, subir ticket…" /></div>
          <div className="sm:col-span-2"><label className={lbl}>Descripción</label><textarea className={field} rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} /></div>
          <div className="sm:col-span-2">
            <label className={lbl}>Productos en la promo ({f.productIds.length})</label>
            <div className="max-h-40 overflow-y-auto rounded-lg border border-gray-200 p-2">
              {products.length === 0 && <p className="text-xs text-gray-400">No hay productos.</p>}
              {products.map((p) => (
                <label key={p.id} className="flex items-center gap-2 py-0.5 text-sm text-gray-700">
                  <input type="checkbox" checked={f.productIds.includes(p.id)} onChange={() => toggleProduct(p.id)} />
                  {p.emoji} {p.name}
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={onCancel} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100">Cancelar</button>
          <button type="submit" disabled={saving} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">{saving ? 'Guardando…' : 'Guardar'}</button>
        </div>
      </form>
    </div>
  );
}
