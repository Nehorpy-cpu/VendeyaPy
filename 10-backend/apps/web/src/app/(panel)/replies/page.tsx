'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { WinningReply } from '@vpw/shared';
import { useActiveCompany } from '@/lib/active-company';
import { useAuth } from '@/lib/auth-context';
import { listReplies, upsertReply, archiveReply, generateReplies, type ReplyInput } from '@/lib/replies';
import { SectionHeader, EmptyState, SkeletonList, StatusBadge } from '@/components/ui';

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
  const qc = useQueryClient();
  const [form, setForm] = useState<{ open: boolean; r: WinningReply | null }>({ open: false, r: null });

  const repliesQ = useQuery({ queryKey: ['winningReplies', tenantId], queryFn: () => listReplies(tenantId!), enabled: !!tenantId });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['winningReplies', tenantId] });
  const saveMut = useMutation({ mutationFn: (input: ReplyInput) => upsertReply(tenantId!, input), onSuccess: () => { invalidate(); setForm({ open: false, r: null }); } });
  const archiveMut = useMutation({ mutationFn: (id: string) => archiveReply(tenantId!, id), onSuccess: invalidate });
  const genMut = useMutation({ mutationFn: () => generateReplies(tenantId!), onSuccess: invalidate });

  if (companyLoading) return <div className="text-sm text-ink-400">Cargando…</div>;
  if (!tenantId) return <EmptyState title="Seleccioná una empresa" text="Elegí una empresa en la barra superior para ver sus respuestas ganadoras." />;

  const replies = repliesQ.data ?? [];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Respuestas ganadoras"
        subtitle="Mensajes que funcionaron — copialos y reutilizalos."
        actions={canEdit && (
          <>
            <button onClick={() => genMut.mutate()} disabled={genMut.isPending} className="rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50 disabled:opacity-50">{genMut.isPending ? 'Buscando…' : '🏆 Buscar ganadoras'}</button>
            <button onClick={() => setForm({ open: true, r: null })} className="rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700">+ Nueva</button>
          </>
        )}
      />

      {repliesQ.isLoading && <SkeletonList rows={4} />}
      {repliesQ.isSuccess && replies.length === 0 && (
        <EmptyState title="Sin respuestas todavía" text={canEdit ? 'Tocá “Buscar ganadoras” o agregá una a mano.' : 'Aparecerán acá cuando se registren mensajes que cerraron ventas.'} />
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {replies.map((r) => (
          <div key={r.id} className="rounded-2xl border border-ink-100 bg-white p-4 shadow-soft">
            <div className="mb-2 flex items-center gap-2">
              <StatusBadge tone="ink">{r.category}</StatusBadge>
              {r.source === 'auto' && r.conversions > 0 && <StatusBadge tone="mint">🏆 {r.conversions} ventas</StatusBadge>}
            </div>
            <div className="whitespace-pre-wrap rounded-lg bg-ink-50/60 p-3 text-sm text-ink-800">{r.text}</div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <CopyButton text={r.text} />
              <span className="flex-1" />
              {canEdit && r.source === 'manual' && <button onClick={() => setForm({ open: true, r })} className="text-xs font-medium text-mint-700 hover:text-mint-600">Editar</button>}
              {canEdit && <button onClick={() => archiveMut.mutate(r.id)} className="text-xs text-ink-500 hover:text-ink-700">Archivar</button>}
            </div>
          </div>
        ))}
      </div>

      {form.open && canEdit && (
        <ReplyForm initial={form.r} saving={saveMut.isPending} onCancel={() => setForm({ open: false, r: null })} onSubmit={(input) => saveMut.mutate(input)} />
      )}
    </div>
  );
}

function ReplyForm({ initial, saving, onCancel, onSubmit }: { initial: WinningReply | null; saving: boolean; onCancel: () => void; onSubmit: (input: ReplyInput) => void }) {
  const [f, setF] = useState<ReplyInput>({ ...(initial ? { id: initial.id } : {}), text: initial?.text ?? '', category: initial?.category ?? 'General' });
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/40 p-4">
      <form onSubmit={(e) => { e.preventDefault(); onSubmit({ ...f, text: f.text.trim() }); }} className="my-8 w-full max-w-lg rounded-2xl border border-ink-100 bg-white p-6 shadow-float">
        <h2 className="mb-4 text-lg font-bold text-ink-900">{initial ? 'Editar respuesta' : 'Nueva respuesta'}</h2>
        <div className="space-y-3">
          <div><label className="mb-1 block text-xs font-medium text-ink-600">Categoría</label><input className={field} value={f.category} onChange={(e) => setF((s) => ({ ...s, category: e.target.value }))} placeholder="Saludo, Cierre, Objeción…" /></div>
          <div><label className="mb-1 block text-xs font-medium text-ink-600">Texto *</label><textarea className={field} rows={4} required value={f.text} onChange={(e) => setF((s) => ({ ...s, text: e.target.value }))} /></div>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={onCancel} className="rounded-lg border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50">Cancelar</button>
          <button type="submit" disabled={saving} className="rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60">{saving ? 'Guardando…' : 'Guardar'}</button>
        </div>
      </form>
    </div>
  );
}
