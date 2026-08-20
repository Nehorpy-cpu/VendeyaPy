'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { WinningReply } from '@vpw/shared';
import { useActiveCompany } from '@/lib/active-company';
import { useAuth } from '@/lib/auth-context';
import { listReplies, upsertReply, archiveReply, generateReplies, type ReplyInput } from '@/lib/replies';
import { canRunPanelJobs, friendlyJobError } from '@/lib/entitlements';
import { SectionHeader, EmptyState, SkeletonList, StatusBadge } from '@/components/ui';
import { EstadoDeAccion } from '@/components/ui/EstadoDeAccion';
import { avisoDeLectura } from '@/lib/lectura';

const field = 'w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 transition-colors focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30';

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* */ } }} className="rounded-lg bg-mint-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-mint-700">
      {done ? '✓ Copiado' : 'Copiar'}
    </button>
  );
}

export default function RepliesPage() {
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const { claims } = useAuth();
  const canEdit = claims.role !== 'SELLER';
  // "Buscar ganadoras" llama al callable real runTenantJob('generateWinningReplies'). Visible para
  // roles que pueden ejecutar jobs (owner/manager/admin); el CRUD manual queda bajo canEdit.
  const canJobs = canRunPanelJobs(claims.role);
  const qc = useQueryClient();
  const [form, setForm] = useState<{ open: boolean; r: WinningReply | null }>({ open: false, r: null });

  const repliesQ = useQuery({ queryKey: ['winningReplies', tenantId], queryFn: () => listReplies(tenantId!), enabled: !!tenantId });
  /** H-03/H-38: el resultado de la última acción, dicho en pantalla. */
  const [msg, setMsg] = useState<{ tipo: 'ok' | 'error'; texto: string } | null>(null);
  /** El rechazo de lo que se guarda DESDE el modal se dice adentro del modal (un aviso en el
   *  cuerpo de la página queda detrás del overlay). */
  const [errorForm, setErrorForm] = useState<string | null>(null);

  // Cambiar de empresa no remonta la pantalla: sin esto el aviso anterior queda colgado.
  useEffect(() => { setMsg(null); setErrorForm(null); }, [tenantId]);
  const abrirForm = (r: WinningReply | null) => { setErrorForm(null); setMsg(null); setForm({ open: true, r }); };
  // El rechazo huérfano (el dueño cerró el modal con la mutación en vuelo) manda sobre el resto.
  const aviso = !form.open && errorForm ? ({ tipo: 'error', texto: errorForm } as const) : msg;
  const invalidate = () => qc.invalidateQueries({ queryKey: ['winningReplies', tenantId] });
  const saveMut = useMutation({ mutationFn: (input: ReplyInput) => upsertReply(tenantId!, input), onSuccess: () => { invalidate(); setForm({ open: false, r: null }); setErrorForm(null); }, onError: (e) => setErrorForm(friendlyJobError(e)) });
  const archiveMut = useMutation({ mutationFn: (id: string) => archiveReply(tenantId!, id), onSuccess: async () => { setMsg(null); await invalidate(); }, onError: (e) => setMsg({ tipo: 'error', texto: friendlyJobError(e) }) });
  const genMut = useMutation({ mutationFn: () => generateReplies(tenantId!), onSuccess: async () => { setMsg({ tipo: 'ok', texto: 'Listo: buscamos tus respuestas ganadoras.' }); await invalidate(); }, onError: (e) => setMsg({ tipo: 'error', texto: friendlyJobError(e) }) });

  if (companyLoading) return <div className="text-sm text-ink-400">Cargando…</div>;
  if (!tenantId) return <EmptyState title="Seleccioná una empresa" text="Elegí una empresa en la barra superior para ver sus respuestas ganadoras." />;

  const replies = repliesQ.data ?? [];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Respuestas ganadoras"
        subtitle="Tu biblioteca de mensajes que funcionaron: guardalos a mano y reutilizalos."
        actions={canEdit && (
          <>
            {canJobs && (
              <button onClick={() => genMut.mutate()} disabled={genMut.isPending} className="rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50 disabled:opacity-50">{genMut.isPending ? 'Buscando…' : '🏆 Buscar ganadoras'}</button>
            )}
            <button onClick={() => abrirForm(null)} className="rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700">+ Nueva</button>
          </>
        )}
      />

      {/* H-03/H-38: el resultado de la última acción, dicho en pantalla. */}
      {/* Si el modal se cerró con la mutación en vuelo, el rechazo se dice acá en vez de perderse,
          y tiene prioridad sobre cualquier mensaje de éxito anterior: un verde sobre un guardado
          que falló es peor que no decir nada. */}
      <EstadoDeAccion tipo={aviso?.tipo ?? 'ok'} mensaje={aviso?.texto} />

      {/* H-15: si la lectura falla (o no hay conexión), la pantalla lo dice en vez de quedarse muda. */}
      <EstadoDeAccion tipo="error" mensaje={avisoDeLectura(repliesQ, 'tus respuestas')} />
      {repliesQ.isLoading && <SkeletonList rows={4} />}
      {repliesQ.isSuccess && replies.length === 0 && (
        <EmptyState title="Sin respuestas todavía" text={canEdit ? (canJobs ? 'Tocá “Buscar ganadoras” o agregá una a mano.' : 'Agregá tu primera respuesta con “+ Nueva”.') : 'Aparecerán acá cuando el equipo registre mensajes que funcionaron.'} />
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {replies.map((r) => (
          <div key={r.id} className="rounded-2xl border border-ink-100 bg-white p-4 shadow-soft">
            <div className="mb-2 flex items-center gap-2">
              <StatusBadge tone="ink">{r.category}</StatusBadge>
              {r.source === 'auto' && r.conversions > 0 && <StatusBadge tone="mint">🏆 {r.conversions} ventas asociadas</StatusBadge>}
            </div>
            <div className="whitespace-pre-wrap rounded-lg bg-ink-50/60 p-3 text-sm text-ink-800">{r.text}</div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <CopyButton text={r.text} />
              <span className="flex-1" />
              {canEdit && r.source === 'manual' && <button onClick={() => abrirForm(r)} className="text-xs font-medium text-mint-700 hover:text-mint-600">Editar</button>}
              {canEdit && <button onClick={() => archiveMut.mutate(r.id)} className="text-xs text-ink-500 hover:text-ink-700">Archivar</button>}
            </div>
          </div>
        ))}
      </div>

      {form.open && canEdit && (
        <ReplyForm initial={form.r} saving={saveMut.isPending} error={errorForm} onCancel={() => { setErrorForm(null); setForm({ open: false, r: null }); }} onSubmit={(input) => saveMut.mutate(input)} />
      )}
    </div>
  );
}

function ReplyForm({ initial, saving, error, onCancel, onSubmit }: { initial: WinningReply | null; saving: boolean; error: string | null; onCancel: () => void; onSubmit: (input: ReplyInput) => void }) {
  const [f, setF] = useState<ReplyInput>({ ...(initial ? { id: initial.id } : {}), text: initial?.text ?? '', category: initial?.category ?? 'General' });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4">
      <form onSubmit={(e) => { e.preventDefault(); onSubmit({ ...f, text: f.text.trim() }); }} className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-ink-100 bg-white p-6 shadow-float">
        <h2 className="mb-4 text-lg font-bold text-ink-900">{initial ? 'Editar respuesta' : 'Nueva respuesta'}</h2>
        <div className="space-y-3">
          <div><label className="mb-1 block text-xs font-medium text-ink-600">Categoría</label><input className={field} value={f.category} onChange={(e) => setF((s) => ({ ...s, category: e.target.value }))} placeholder="Saludo, Cierre, Objeción…" /></div>
          <div><label className="mb-1 block text-xs font-medium text-ink-600">Texto *</label><textarea className={field} rows={4} required value={f.text} onChange={(e) => setF((s) => ({ ...s, text: e.target.value }))} /></div>
        </div>
        {/* H-03: el rechazo se dice DENTRO del modal; un aviso detrás del overlay no existe. */}
        <EstadoDeAccion tipo="error" mensaje={error} className="mt-4" />
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={onCancel} className="rounded-lg border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50">Cancelar</button>
          <button type="submit" disabled={saving} className="rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60">{saving ? 'Guardando…' : 'Guardar'}</button>
        </div>
      </form>
    </div>
  );
}
