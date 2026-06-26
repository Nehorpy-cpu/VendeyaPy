'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Customer, Message } from '@vpw/shared';
import { useActiveCompany } from '@/lib/active-company';
import { useAuth } from '@/lib/auth-context';
import {
  listConversations,
  getCustomer,
  getMessages,
  takeoverChat,
  releaseChat,
} from '@/lib/conversations';

function hhmm(ts: unknown): string {
  try {
    const d = (ts as { toDate?: () => Date } | null)?.toDate?.();
    return d ? d.toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit' }) : '';
  } catch {
    return '';
  }
}

function name(c: Customer): string {
  return c.name?.trim() || c.whatsappPhone || c.id;
}

const CHANNEL_ICON: Record<string, string> = { whatsapp: '🟢', instagram: '📸', messenger: '📨' };
// El canal es solo un label de origen: hoy únicamente WhatsApp tiene respuesta saliente. IG/Messenger se
// reciben pero NO se responden desde el panel → se marcan "(próximamente)" para no prometer atención saliente.
const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram (entrante · respuesta próximamente)',
  messenger: 'Messenger (entrante · respuesta próximamente)',
};

function ConversationsInner() {
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const { user } = useAuth();
  const qc = useQueryClient();
  const params = useSearchParams();
  const [selected, setSelected] = useState<string | null>(null);
  const [onlyMine, setOnlyMine] = useState(false);

  // Preselección desde ?c= (link "Ver chat" de Clientes)
  useEffect(() => {
    const c = params.get('c');
    if (c) setSelected(c);
  }, [params]);

  const convsQ = useQuery({
    queryKey: ['conversations', tenantId],
    queryFn: () => listConversations(tenantId!),
    enabled: !!tenantId,
    refetchInterval: 8000,
  });

  const customerQ = useQuery({
    queryKey: ['customer', tenantId, selected],
    queryFn: () => getCustomer(tenantId!, selected!),
    enabled: !!tenantId && !!selected,
  });

  const messagesQ = useQuery({
    queryKey: ['messages', tenantId, selected],
    queryFn: () => getMessages(tenantId!, selected!),
    enabled: !!tenantId && !!selected,
    refetchInterval: 4000,
  });

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['messages', tenantId, selected] });
    qc.invalidateQueries({ queryKey: ['customer', tenantId, selected] });
    qc.invalidateQueries({ queryKey: ['conversations', tenantId] });
    qc.invalidateQueries({ queryKey: ['customers', tenantId] });
  };

  const takeMut = useMutation({
    mutationFn: () => takeoverChat(tenantId!, selected!),
    onSuccess: refreshAll,
  });
  const releaseMut = useMutation({
    mutationFn: () => releaseChat(tenantId!, selected!),
    onSuccess: refreshAll,
  });

  // Autoscroll al final cuando llegan mensajes
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messagesQ.data]);

  if (companyLoading) return <div className="text-sm text-ink-400">Cargando…</div>;
  if (!tenantId) {
    return (
      <div className="rounded-2xl border border-dashed border-ink-200 bg-white p-10 text-center text-sm text-ink-500">
        Seleccioná una empresa para ver sus conversaciones.
      </div>
    );
  }

  const convs = convsQ.data ?? [];
  const visibleConvs = onlyMine && user ? convs.filter((c) => c.assignedSellerId === user.uid) : convs;
  const current = customerQ.data ?? convs.find((c) => c.id === selected) ?? null;
  const isHuman = current?.conversation?.humanTakeover ?? false;
  const busy = takeMut.isPending || releaseMut.isPending;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink-900">Conversaciones</h1>
        <p className="mt-1 text-sm text-ink-500">La bandeja de tu bot en WhatsApp. Tomá una charla para atenderla vos.</p>
      </div>

      <div className="grid h-[34rem] grid-cols-1 gap-4 md:grid-cols-3">
        {/* Lista */}
        <div className="flex flex-col overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-soft md:col-span-1">
          <label className="flex items-center gap-2 border-b border-ink-100 px-4 py-2.5 text-xs text-ink-600">
            <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} className="accent-mint-600" />
            Solo mis chats (asignados a mí)
          </label>
          <div className="flex-1 overflow-y-auto">
            {convsQ.isLoading && <div className="p-4 text-sm text-ink-400">Cargando…</div>}
            {convsQ.isSuccess && visibleConvs.length === 0 && (
              <div className="p-6 text-center text-sm text-ink-500">
                {onlyMine ? 'No tenés conversaciones asignadas todavía.' : 'Sin conversaciones todavía. Aparecerán cuando un cliente escriba al bot.'}
              </div>
            )}
            <ul className="divide-y divide-ink-50">
              {visibleConvs.map((c) => {
                const active = c.id === selected;
                const unread = c.conversation?.unreadForSeller ?? 0;
                const mine = !!user && c.assignedSellerId === user.uid;
                return (
                  <li key={c.id}>
                    <button
                      onClick={() => setSelected(c.id)}
                      className={'flex w-full flex-col gap-0.5 px-4 py-3 text-left transition-colors hover:bg-ink-50/60 ' + (active ? 'bg-mint-50' : '')}
                    >
                      <div className="flex items-center justify-between">
                        <span className="truncate font-medium text-ink-900">{name(c)}</span>
                        <span className="ml-2 shrink-0 text-[11px] text-ink-400">{hhmm(c.conversation?.lastMessageAt)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs text-ink-500">{c.conversation?.lastMessagePreview ?? ''}</span>
                        <span className="flex shrink-0 items-center gap-1">
                          {c.conversation?.channel && <span title={CHANNEL_LABEL[c.conversation.channel] ?? c.conversation.channel}>{CHANNEL_ICON[c.conversation.channel] ?? ''}</span>}
                          {c.assignedSellerId && (
                            <span title={'Asignado a ' + (c.assignedSellerName ?? 'un vendedor')} className={'rounded-full px-1.5 text-[10px] font-medium ' + (mine ? 'bg-mint-100 text-mint-700' : 'bg-ink-100 text-ink-500')}>{mine ? 'mío' : '👤'}</span>
                          )}
                          {c.conversation?.humanTakeover ? <span title="Atiende un vendedor">🧑‍💼</span> : <span title="Atiende el bot">🤖</span>}
                          {unread > 0 && <span className="rounded-full bg-coral-500 px-1.5 text-[10px] font-bold text-white">{unread}</span>}
                        </span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>

        {/* Chat */}
        <div className="flex flex-col overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-soft md:col-span-2">
          {!selected && (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-ink-400">
              Elegí una conversación de la izquierda.
            </div>
          )}
          {selected && (
            <>
              <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
                <div>
                  <div className="font-semibold text-ink-900">{current ? name(current) : selected}</div>
                  <div className="text-xs text-ink-400">
                    {isHuman ? '🧑‍💼 Lo atiende un vendedor (bot en pausa)' : '🤖 Lo atiende el bot'}
                  </div>
                </div>
                <div className="flex gap-2">
                  {isHuman ? (
                    <button
                      onClick={() => releaseMut.mutate()}
                      disabled={busy}
                      className="rounded-lg bg-mint-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60"
                    >
                      {releaseMut.isPending ? 'Devolviendo…' : 'Devolver al bot'}
                    </button>
                  ) : (
                    <button
                      onClick={() => takeMut.mutate()}
                      disabled={busy}
                      className="rounded-lg bg-amber-500 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-600 disabled:opacity-60"
                    >
                      {takeMut.isPending ? 'Tomando…' : 'Tomar conversación'}
                    </button>
                  )}
                </div>
              </div>

              <div className="flex-1 space-y-2 overflow-y-auto bg-ink-50/40 p-4">
                {messagesQ.isLoading && <div className="text-sm text-ink-400">Cargando mensajes…</div>}
                {messagesQ.isSuccess && (messagesQ.data?.length ?? 0) === 0 && (
                  <div className="text-center text-sm text-ink-400">Sin mensajes.</div>
                )}
                {messagesQ.data?.map((m: Message) => <Bubble key={m.id} m={m} />)}
                <div ref={endRef} />
              </div>

              <div className="border-t border-ink-100 px-4 py-2 text-center text-xs text-ink-400">
                {isHuman
                  ? 'Respondé al cliente desde tu WhatsApp. Cuando termines, tocá “Devolver al bot”.'
                  : 'El bot responde automáticamente. Tomá la conversación para atender vos.'}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Bubble({ m }: { m: Message }) {
  if (m.author === 'system') {
    return (
      <div className="text-center">
        <span className="inline-block rounded-full bg-ink-100 px-3 py-1 text-[11px] text-ink-600">{m.text}</span>
      </div>
    );
  }
  const mine = m.direction === 'out'; // bot o vendedor (sale de nosotros)
  const tone =
    m.author === 'seller' ? 'bg-amber-500 text-white' : mine ? 'bg-mint-600 text-white' : 'border border-ink-100 bg-white text-ink-800';
  return (
    <div className={mine ? 'text-right' : 'text-left'}>
      <div className={'inline-block max-w-[80%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ' + tone}>
        {m.author === 'seller' && <div className="mb-0.5 text-[10px] font-semibold opacity-80">Vendedor</div>}
        {m.text}
      </div>
      <div className="mt-0.5 text-[10px] text-ink-400">{hhmm(m.createdAt)}</div>
    </div>
  );
}

export default function ConversationsPage() {
  return (
    <Suspense fallback={<div className="text-sm text-ink-400">Cargando…</div>}>
      <ConversationsInner />
    </Suspense>
  );
}
