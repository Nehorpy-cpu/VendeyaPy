'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { WinningReply } from '@vpw/shared';
import { useActiveCompany } from '@/lib/active-company';
import { useAuth } from '@/lib/auth-context';
import { listReplies, upsertReply, archiveReply, generateReplies, type ReplyInput } from '@/lib/replies';

const field = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none';

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* */ } }} className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700">
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

  if (companyLoading) return <div className="text-gray-400">Cargando…</div>;
  if (!tenantId) return <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">Seleccioná una empresa.</div>;

  const replies = repliesQ.data ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Respuestas ganadoras</h1>
          <p className="text-sm text-gray-500">Mensajes que funcionaron — copialos y reutilizalos.</p>
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <button onClick={() => genMut.mutate()} disabled={genMut.isPending} className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">{genMut.isPending ? 'Buscando…' : '🏆 Buscar ganadoras'}</button>
            <button onClick={() => setForm({ open: true, r: null })} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">+ Nueva</button>
          </div>
        )}
      </div>

      {repliesQ.isLoading && <div className="text-gray-400">Cargando…</div>}
      {repliesQ.isSuccess && replies.length === 0 && (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
          Sin respuestas todavía. {canEdit ? 'Tocá “Buscar ganadoras” o agregá una a mano.' : ''}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {replies.map((r) => (
          <div key={r.id} className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">{r.category}</span>
              {r.source === 'auto' && r.conversions > 0 && <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-semibold text-brand-700">🏆 {r.conversions} ventas</span>}
            </div>
            <div className="whitespace-pre-wrap rounded-lg bg-gray-50 p-2 text-sm text-gray-800">{r.text}</div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <CopyButton text={r.text} />
              <span className="flex-1" />
              {canEdit && r.source === 'manual' && <button onClick={() => setForm({ open: true, r })} className="text-xs text-brand-700 hover:underline">Editar</button>}
              {canEdit && <button onClick={() => archiveMut.mutate(r.id)} className="text-xs text-gray-500 hover:underline">Archivar</button>}
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
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <form onSubmit={(e) => { e.preventDefault(); onSubmit({ ...f, text: f.text.trim() }); }} className="my-8 w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-bold text-gray-900">{initial ? 'Editar respuesta' : 'Nueva respuesta'}</h2>
        <div className="space-y-3">
          <div><label className="mb-1 block text-xs font-medium text-gray-600">Categoría</label><input className={field} value={f.category} onChange={(e) => setF((s) => ({ ...s, category: e.target.value }))} placeholder="Saludo, Cierre, Objeción…" /></div>
          <div><label className="mb-1 block text-xs font-medium text-gray-600">Texto *</label><textarea className={field} rows={4} required value={f.text} onChange={(e) => setF((s) => ({ ...s, text: e.target.value }))} /></div>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={onCancel} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100">Cancelar</button>
          <button type="submit" disabled={saving} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">{saving ? 'Guardando…' : 'Guardar'}</button>
        </div>
      </form>
    </div>
  );
}
