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

  if (companyLoading) return <div className="text-gray-400">Cargando…</div>;
  if (!tenantId) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
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
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-gray-900">Conversaciones</h1>

      <div className="grid h-[34rem] grid-cols-1 gap-4 md:grid-cols-3">
        {/* Lista */}
        <div className="overflow-y-auto rounded-xl border border-gray-200 bg-white md:col-span-1">
          {convsQ.isLoading && <div className="p-4 text-sm text-gray-400">Cargando…</div>}
          <label className="flex items-center gap-2 border-b border-gray-100 px-4 py-2 text-xs text-gray-600">
            <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
            Solo mis chats (asignados a mí)
          </label>
          {convsQ.isSuccess && visibleConvs.length === 0 && (
            <div className="p-6 text-center text-sm text-gray-500">
              {onlyMine ? 'No tenés conversaciones asignadas todavía.' : 'Sin conversaciones todavía. Aparecerán cuando un cliente escriba al bot.'}
            </div>
          )}
          <ul className="divide-y divide-gray-100">
            {visibleConvs.map((c) => {
              const active = c.id === selected;
              const unread = c.conversation?.unreadForSeller ?? 0;
              const mine = !!user && c.assignedSellerId === user.uid;
              return (
                <li key={c.id}>
                  <button
                    onClick={() => setSelected(c.id)}
                    className={'flex w-full flex-col gap-0.5 px-4 py-3 text-left hover:bg-gray-50 ' + (active ? 'bg-brand-50' : '')}
                  >
                    <div className="flex items-center justify-between">
                      <span className="truncate font-medium text-gray-900">{name(c)}</span>
                      <span className="ml-2 shrink-0 text-[11px] text-gray-400">{hhmm(c.conversation?.lastMessageAt)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs text-gray-500">{c.conversation?.lastMessagePreview ?? ''}</span>
                      <span className="flex shrink-0 items-center gap-1">
                        {c.assignedSellerId && (
                          <span title={'Asignado a ' + (c.assignedSellerName ?? 'un vendedor')} className={'rounded-full px-1.5 text-[10px] font-medium ' + (mine ? 'bg-brand-100 text-brand-700' : 'bg-gray-100 text-gray-500')}>{mine ? 'mío' : '👤'}</span>
                        )}
                        {c.conversation?.humanTakeover ? <span title="Atiende un vendedor">🧑‍💼</span> : <span title="Atiende el bot">🤖</span>}
                        {unread > 0 && <span className="rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white">{unread}</span>}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Chat */}
        <div className="flex flex-col rounded-xl border border-gray-200 bg-white md:col-span-2">
          {!selected && (
            <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
              Elegí una conversación de la izquierda.
            </div>
          )}
          {selected && (
            <>
              <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
                <div>
                  <div className="font-semibold text-gray-900">{current ? name(current) : selected}</div>
                  <div className="text-xs text-gray-400">
                    {isHuman ? '🧑‍💼 Lo atiende un vendedor (bot en pausa)' : '🤖 Lo atiende el bot'}
                  </div>
                </div>
                <div className="flex gap-2">
                  {isHuman ? (
                    <button
                      onClick={() => releaseMut.mutate()}
                      disabled={busy}
                      className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
                    >
                      {releaseMut.isPending ? 'Devolviendo…' : 'Devolver al bot'}
                    </button>
                  ) : (
                    <button
                      onClick={() => takeMut.mutate()}
                      disabled={busy}
                      className="rounded-lg bg-amber-500 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-60"
                    >
                      {takeMut.isPending ? 'Tomando…' : 'Tomar conversación'}
                    </button>
                  )}
                </div>
              </div>

              <div className="flex-1 space-y-2 overflow-y-auto bg-gray-50 p-4">
                {messagesQ.isLoading && <div className="text-sm text-gray-400">Cargando mensajes…</div>}
                {messagesQ.isSuccess && (messagesQ.data?.length ?? 0) === 0 && (
                  <div className="text-center text-sm text-gray-400">Sin mensajes.</div>
                )}
                {messagesQ.data?.map((m: Message) => <Bubble key={m.id} m={m} />)}
                <div ref={endRef} />
              </div>

              <div className="border-t border-gray-200 px-4 py-2 text-center text-xs text-gray-400">
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
        <span className="inline-block rounded-full bg-gray-200 px-3 py-1 text-[11px] text-gray-600">{m.text}</span>
      </div>
    );
  }
  const mine = m.direction === 'out'; // bot o vendedor (sale de nosotros)
  const tone =
    m.author === 'seller' ? 'bg-amber-500 text-white' : mine ? 'bg-brand-600 text-white' : 'bg-white text-gray-800 border border-gray-200';
  return (
    <div className={mine ? 'text-right' : 'text-left'}>
      <div className={'inline-block max-w-[80%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ' + tone}>
        {m.author === 'seller' && <div className="mb-0.5 text-[10px] font-semibold opacity-80">Vendedor</div>}
        {m.text}
      </div>
      <div className="mt-0.5 text-[10px] text-gray-400">{hhmm(m.createdAt)}</div>
    </div>
  );
}

export default function ConversationsPage() {
  return (
    <Suspense fallback={<div className="text-gray-400">Cargando…</div>}>
      <ConversationsInner />
    </Suspense>
  );
}
