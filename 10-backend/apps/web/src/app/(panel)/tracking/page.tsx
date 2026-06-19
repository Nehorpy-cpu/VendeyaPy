'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { TrackingSource, TrackingType } from '@vpw/shared';
import { useActiveCompany } from '@/lib/active-company';
import { listTrackingSources, upsertTrackingSource, deleteTrackingSource, computeTracking, type TrackingInput } from '@/lib/tracking';

const TYPE_LABEL: Record<TrackingType, string> = { coupon: '🎟️ Cupón', qr: '📱 QR', link: '🔗 Link' };
const gs = (n: number) => '₲ ' + Math.round(n).toLocaleString('es-PY');
const field = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none';

export default function TrackingPage() {
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const qc = useQueryClient();
  const [form, setForm] = useState<{ open: boolean; src: TrackingSource | null }>({ open: false, src: null });

  const srcQ = useQuery({ queryKey: ['trackingSources', tenantId], queryFn: () => listTrackingSources(tenantId!), enabled: !!tenantId });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['trackingSources', tenantId] });
  const saveMut = useMutation({ mutationFn: (input: TrackingInput) => upsertTrackingSource(tenantId!, input), onSuccess: () => { invalidate(); setForm({ open: false, src: null }); } });
  const delMut = useMutation({ mutationFn: (id: string) => deleteTrackingSource(tenantId!, id), onSuccess: invalidate });
  const computeMut = useMutation({ mutationFn: () => computeTracking(tenantId!), onSuccess: invalidate });

  if (companyLoading) return <div className="text-gray-400">Cargando…</div>;
  if (!tenantId) return <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">Seleccioná una empresa.</div>;

  const sources = srcQ.data ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tracking propio</h1>
          <p className="text-sm text-gray-500">Sin Meta: medí qué promo (cupón, QR, flyer) trajo cada venta.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => computeMut.mutate()} disabled={computeMut.isPending} className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">{computeMut.isPending ? 'Calculando…' : '🎯 Calcular atribución'}</button>
          <button onClick={() => setForm({ open: true, src: null })} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">+ Nuevo código</button>
        </div>
      </div>

      <div className="rounded-lg bg-blue-50 px-4 py-2 text-xs text-blue-800">
        💡 Creá un código (ej: <strong>VERANO20</strong>), ponelo en tu flyer/QR/historia. Cuando un cliente lo menciona al bot, la venta queda atribuida a esa promo — y ves cuánto vendió y cuánta ganancia dejó.
      </div>

      {srcQ.isLoading && <div className="text-gray-400">Cargando…</div>}
      {srcQ.isSuccess && sources.length === 0 && (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">Sin códigos todavía. Creá el primero con “+ Nuevo código”.</div>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {sources.map((s) => {
          const a = s.attribution;
          return (
            <div key={s.id} className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-medium text-gray-900">{s.name}</div>
                  <div className="mt-0.5 font-mono text-lg font-bold tracking-wide text-brand-700">{s.code}</div>
                </div>
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">{TYPE_LABEL[s.type]}{!s.active && ' · inactivo'}</span>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <Stat label="Ventas" value={String(a?.orders ?? 0)} />
                <Stat label="Ingresos" value={gs(a?.revenue ?? 0)} />
                <Stat label="Ganancia" value={a?.grossProfit != null ? gs(a.grossProfit) : '—'} />
              </div>
              <div className="mt-3 flex justify-end gap-3 text-xs">
                <button onClick={() => setForm({ open: true, src: s })} className="text-brand-700 hover:underline">Editar</button>
                <button onClick={() => delMut.mutate(s.id)} className="text-amber-600 hover:underline">Desactivar</button>
              </div>
            </div>
          );
        })}
      </div>

      {form.open && (
        <TrackingForm initial={form.src} saving={saveMut.isPending} onCancel={() => setForm({ open: false, src: null })} onSubmit={(input) => saveMut.mutate(input)} />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-gray-50 p-2">
      <div className="text-[10px] uppercase tracking-wide text-gray-400">{label}</div>
      <div className="text-sm font-semibold text-gray-800">{value}</div>
    </div>
  );
}

function TrackingForm({ initial, saving, onCancel, onSubmit }: { initial: TrackingSource | null; saving: boolean; onCancel: () => void; onSubmit: (input: TrackingInput) => void }) {
  const [f, setF] = useState<TrackingInput>({ ...(initial ? { id: initial.id } : {}), name: initial?.name ?? '', code: initial?.code ?? '', type: initial?.type ?? 'coupon', active: initial?.active ?? true });
  const lbl = 'mb-1 block text-xs font-medium text-gray-600';
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <form onSubmit={(e) => { e.preventDefault(); onSubmit({ ...f, name: f.name.trim() }); }} className="my-8 w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-bold text-gray-900">{initial ? 'Editar código' : 'Nuevo código'}</h2>
        <div className="space-y-3">
          <div><label className={lbl}>Nombre de la promo *</label><input className={field} required value={f.name} onChange={(e) => setF((s) => ({ ...s, name: e.target.value }))} placeholder="Promo Verano" /></div>
          <div><label className={lbl}>Código *</label><input className={field} required value={f.code} onChange={(e) => setF((s) => ({ ...s, code: e.target.value }))} placeholder="VERANO20" /></div>
          <div><label className={lbl}>Tipo</label>
            <select className={field} value={f.type} onChange={(e) => setF((s) => ({ ...s, type: e.target.value as TrackingType }))}>
              {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={f.active} onChange={(e) => setF((s) => ({ ...s, active: e.target.checked }))} /> Activo</label>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={onCancel} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100">Cancelar</button>
          <button type="submit" disabled={saving} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">{saving ? 'Guardando…' : 'Guardar'}</button>
        </div>
      </form>
    </div>
  );
}
