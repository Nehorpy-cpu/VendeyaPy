'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { TrackingSource, TrackingType } from '@vpw/shared';
import { useActiveCompany } from '@/lib/active-company';
import { listTrackingSources, upsertTrackingSource, deleteTrackingSource, computeTracking, type TrackingInput } from '@/lib/tracking';
import { SectionHeader, EmptyState, SkeletonList, StatusBadge } from '@/components/ui';

const TYPE_LABEL: Record<TrackingType, string> = { coupon: '🎟️ Cupón', qr: '📱 QR', link: '🔗 Link' };
const gs = (n: number) => '₲ ' + Math.round(n).toLocaleString('es-PY');
const field = 'w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 transition-colors focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30';

export default function TrackingPage() {
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const qc = useQueryClient();
  const [form, setForm] = useState<{ open: boolean; src: TrackingSource | null }>({ open: false, src: null });

  const srcQ = useQuery({ queryKey: ['trackingSources', tenantId], queryFn: () => listTrackingSources(tenantId!), enabled: !!tenantId });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['trackingSources', tenantId] });
  const saveMut = useMutation({ mutationFn: (input: TrackingInput) => upsertTrackingSource(tenantId!, input), onSuccess: () => { invalidate(); setForm({ open: false, src: null }); } });
  const delMut = useMutation({ mutationFn: (id: string) => deleteTrackingSource(tenantId!, id), onSuccess: invalidate });
  const computeMut = useMutation({ mutationFn: () => computeTracking(tenantId!), onSuccess: invalidate });

  if (companyLoading) return <div className="text-sm text-ink-400">Cargando…</div>;
  if (!tenantId) return <EmptyState title="Seleccioná una empresa" text="Elegí una empresa en la barra superior para ver su tracking propio." />;

  const sources = srcQ.data ?? [];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Tracking propio"
        subtitle="Sin Meta: medí qué promo (cupón, QR, flyer) trajo cada venta."
        actions={
          <>
            <button onClick={() => computeMut.mutate()} disabled={computeMut.isPending} className="rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50 disabled:opacity-50">{computeMut.isPending ? 'Calculando…' : '🎯 Calcular atribución'}</button>
            <button onClick={() => setForm({ open: true, src: null })} className="rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700">+ Nuevo código</button>
          </>
        }
      />

      <div className="rounded-2xl border border-mint-100 bg-mint-50/60 px-4 py-3 text-xs text-ink-600">
        💡 Creá un código (ej: <strong className="text-ink-800">VERANO20</strong>), ponelo en tu flyer/QR/historia. Cuando un cliente lo menciona al bot, la venta queda atribuida a esa promo — y ves cuánto vendió y cuánta ganancia dejó.
      </div>

      {srcQ.isLoading && <SkeletonList rows={4} />}
      {srcQ.isSuccess && sources.length === 0 && (
        <EmptyState title="Sin códigos todavía" text="Creá el primero con “+ Nuevo código” y empezá a medir tus promos sin depender de Meta." />
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {sources.map((s) => {
          const a = s.attribution;
          return (
            <div key={s.id} className="rounded-2xl border border-ink-100 bg-white p-4 shadow-soft">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-medium text-ink-900">{s.name}</div>
                  <div className="mt-0.5 font-mono text-lg font-bold tracking-wide text-mint-700">{s.code}</div>
                </div>
                <StatusBadge tone={s.active ? 'ink' : 'coral'}>{TYPE_LABEL[s.type]}{!s.active && ' · inactivo'}</StatusBadge>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <Stat label="Ventas" value={String(a?.orders ?? 0)} />
                <Stat label="Ingresos" value={gs(a?.revenue ?? 0)} />
                <Stat label="Ganancia" value={a?.grossProfit != null ? gs(a.grossProfit) : '—'} />
              </div>
              <div className="mt-3 flex justify-end gap-3 text-xs">
                <button onClick={() => setForm({ open: true, src: s })} className="font-medium text-mint-700 hover:text-mint-600">Editar</button>
                <button onClick={() => delMut.mutate(s.id)} className="text-amber-600 hover:text-amber-700">Desactivar</button>
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
    <div className="rounded-lg bg-ink-50/60 p-2">
      <div className="text-[10px] uppercase tracking-wide text-ink-400">{label}</div>
      <div className="text-sm font-semibold text-ink-800">{value}</div>
    </div>
  );
}

function TrackingForm({ initial, saving, onCancel, onSubmit }: { initial: TrackingSource | null; saving: boolean; onCancel: () => void; onSubmit: (input: TrackingInput) => void }) {
  const [f, setF] = useState<TrackingInput>({ ...(initial ? { id: initial.id } : {}), name: initial?.name ?? '', code: initial?.code ?? '', type: initial?.type ?? 'coupon', active: initial?.active ?? true });
  const lbl = 'mb-1 block text-xs font-medium text-ink-600';
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/40 p-4">
      <form onSubmit={(e) => { e.preventDefault(); onSubmit({ ...f, name: f.name.trim() }); }} className="my-8 w-full max-w-md rounded-2xl border border-ink-100 bg-white p-6 shadow-float">
        <h2 className="mb-4 text-lg font-bold text-ink-900">{initial ? 'Editar código' : 'Nuevo código'}</h2>
        <div className="space-y-3">
          <div><label className={lbl}>Nombre de la promo *</label><input className={field} required value={f.name} onChange={(e) => setF((s) => ({ ...s, name: e.target.value }))} placeholder="Promo Verano" /></div>
          <div><label className={lbl}>Código *</label><input className={field} required value={f.code} onChange={(e) => setF((s) => ({ ...s, code: e.target.value }))} placeholder="VERANO20" /></div>
          <div><label className={lbl}>Tipo</label>
            <select className={field} value={f.type} onChange={(e) => setF((s) => ({ ...s, type: e.target.value as TrackingType }))}>
              {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink-700"><input type="checkbox" className="accent-mint-600" checked={f.active} onChange={(e) => setF((s) => ({ ...s, active: e.target.checked }))} /> Activo</label>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={onCancel} className="rounded-lg border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50">Cancelar</button>
          <button type="submit" disabled={saving} className="rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60">{saving ? 'Guardando…' : 'Guardar'}</button>
        </div>
      </form>
    </div>
  );
}
