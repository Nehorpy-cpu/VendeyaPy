'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Customer, Message } from '@vpw/shared';
import { useActiveCompany } from '@/lib/active-company';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import {
  listConversations,
  getCustomer,
  getMessages,
  takeoverChat,
  releaseChat,
  sendManualMessage,
} from '@/lib/conversations';
import { listTenantWhatsappNumbers } from '@/lib/whatsapp-activation';
import { getChannelConfig } from '@/lib/channels';
import { getCustomerOpenOrder, comprobanteEstado, esMensajeImagenCliente } from '@/lib/orders';
import { composerGateActivo, COMPOSER_GATE_HELP, COMPOSER_GATE_HELP_SOLO_LECTURA, type ManualShippingGate } from '@/lib/shippingQuote';
import { ComprobanteViewer } from '@/components/ComprobanteViewer';
import { CoverageReviewCard } from '@/components/CoverageReviewCard';

const ORDER_STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: 'Esperando pago',
  PENDING_VERIFICATION: 'Comprobante por verificar',
  PAID: 'Pagado',
  PREPARING: 'Preparando',
  SHIPPED: 'Enviado',
};

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

  // MULTI-NUMBER-1: números del negocio → badge "Recibido en +…" cuando hay más de uno
  // (activo o histórico). El SELLER no puede leer metaAssets (rules) → sin badge, sin error.
  const numbersQ = useQuery({
    queryKey: ['tenantWhatsappNumbers', tenantId],
    queryFn: () => listTenantWhatsappNumbers(tenantId!).catch(() => []),
    enabled: !!tenantId,
    staleTime: 5 * 60 * 1000,
  });
  const numbers = numbersQ.data ?? [];
  const multiNumber = numbers.length > 1;
  const numberLabel = (pnid: string) =>
    numbers.find((n) => n.phoneNumberId === pnid)?.displayPhoneNumber ?? `…${pnid.slice(-4)}`;

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

  // HUMAN-HANDOFF-1: composer del vendedor (responder por WhatsApp desde el panel).
  // Los callbacks de un envío EN VUELO solo tocan el estado si el vendedor sigue en ESA
  // conversación (cambiar de chat con red lenta no puede borrar el draft ni pintar el
  // error/badge de otra charla — review adversarial).
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [lastViaMock, setLastViaMock] = useState(false);
  const selectedRef = useRef<string | null>(null);
  // HARDEN-1 (B): sincronizado DURANTE el render — los efectos del card nuevo pueden correr
  // ANTES que un efecto tardío del padre, y el filtro del gate necesita el valor fresco.
  selectedRef.current = selected;
  const sendMut = useMutation({
    mutationFn: (vars: { customerId: string; text: string }) =>
      sendManualMessage(tenantId!, vars.customerId, vars.text),
    onSuccess: (r, vars) => {
      if (vars.customerId !== selectedRef.current) return; // resolvió para otro chat: no tocar la UI
      setDraft('');
      setSendError(null);
      setLastViaMock(r.viaMock);
      refreshAll();
    },
    onError: (e, vars) => {
      if (vars.customerId !== selectedRef.current) return;
      setSendError(e instanceof Error ? e.message : 'No se pudo enviar el mensaje.');
    },
  });
  useEffect(() => { setDraft(''); setSendError(null); setLastViaMock(false); setManualGate(null); }, [selected]);

  // SHIPPING-CHAT-4B — el card publica el gate del envío manual (espejo del gate server de 3B;
  // la autoridad es el server). Solo bloquea si pertenece a la conversación SELECCIONADA. La
  // limpieza real al cambiar de chat es el efecto [selected] de arriba: la publicación de
  // desmontaje del card llega siempre con el customerId VIEJO y el filtro de abajo la ignora.
  const [manualGate, setManualGate] = useState<ManualShippingGate | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const onManualShippingGateChange = useCallback((g: ManualShippingGate) => {
    // HARDEN-1 (B): TODA publicación de otro chat se ignora — un blocked:true tardío no bloquea
    // al chat nuevo, y el cleanup blocked:false de un card viejo JAMÁS limpia el gate vigente.
    if (g.customerId !== selectedRef.current) return;
    setManualGate(g);
  }, []);
  const onFocusComposer = useCallback(() => composerRef.current?.focus(), []);
  const onReviewHistory = useCallback(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
    composerRef.current?.focus();
  }, []);
  const onSetDraft = useCallback((texto: string) => {
    // Completa la plantilla SOLO sobre un composer vacío — jamás pisa un borrador escrito.
    setDraft((actual) => (actual.trim() === '' ? texto : actual));
    composerRef.current?.focus();
  }, []);
  const gateActivo = composerGateActivo(manualGate, selected);
  const enviarManual = () => {
    if (gateActivo) return; // ayuda de UI: el server igual lo rechazaría (autoridad 3B)
    if (draft.trim() && !sendMut.isPending) sendMut.mutate({ customerId: selected!, text: draft });
  };

  // Modo de envío (para avisar mock ANTES de escribir). Si el rol no puede leer config → sin aviso previo.
  const channelQ = useQuery({
    queryKey: ['channelConfig', tenantId],
    queryFn: () => getChannelConfig(tenantId!).catch(() => null),
    enabled: !!tenantId,
    staleTime: 5 * 60 * 1000,
  });
  const isMock = channelQ.data?.whatsappSendMode === 'mock' || lastViaMock;

  // Pedido abierto del cliente (banner con link a Pedidos). El comprobante activa el handoff
  // sobre un pedido PENDING_VERIFICATION: esto le da contexto al vendedor sin salir del chat.
  const orderQ = useQuery({
    queryKey: ['customerOpenOrder', tenantId, selected],
    queryFn: () => getCustomerOpenOrder(tenantId!, selected!).catch(() => null),
    enabled: !!tenantId && !!selected,
    refetchInterval: 15000,
  });

  // Autoscroll al final cuando llegan mensajes (endRef se declara junto al gate del composer)
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

      <div className="grid h-[70vh] grid-cols-1 gap-4 md:h-[34rem] md:grid-cols-3">
        {/* Lista — en mobile se oculta cuando hay un chat abierto (patrón list-or-chat) */}
        <div className={cn('flex-col overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-soft md:col-span-1 md:flex', selected ? 'hidden md:flex' : 'flex')}>
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
                          {multiNumber && (c.conversation as { receivedVia?: string } | undefined)?.receivedVia && (
                            <span
                              title={'Recibido en ' + numberLabel((c.conversation as unknown as { receivedVia: string }).receivedVia)}
                              className="rounded-full bg-ink-50 px-1.5 text-[10px] font-medium text-ink-500"
                            >
                              📞 {numberLabel((c.conversation as unknown as { receivedVia: string }).receivedVia)}
                            </span>
                          )}
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

        {/* Chat — en mobile solo se muestra cuando hay un chat seleccionado */}
        <div className={cn('flex-col overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-soft md:col-span-2 md:flex', selected ? 'flex' : 'hidden md:flex')}>
          {!selected && (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-ink-400">
              Elegí una conversación de la izquierda.
            </div>
          )}
          {selected && (
            <>
              <div className="flex items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
                <div className="flex min-w-0 items-center gap-2">
                  <button
                    onClick={() => setSelected(null)}
                    aria-label="Volver a la lista"
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-500 transition-colors hover:bg-ink-50 md:hidden"
                  >
                    ←
                  </button>
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-ink-900">{current ? name(current) : selected}</div>
                    <div className="text-xs text-ink-400">
                      {isHuman
                        ? `🧑‍💼 ${current?.assignedSellerName ? 'Atiende ' + current.assignedSellerName : 'Lo atiende un vendedor'} · bot en pausa`
                        : '🤖 Lo atiende el bot'}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
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

              {/* COVERAGE-1C + SHIPPING-CHAT-4B: revisión de cobertura + cotización de envío */}
              {selected && tenantId && (
                <CoverageReviewCard
                  tenantId={tenantId}
                  customerId={selected}
                  draft={draft}
                  onSetDraft={onSetDraft}
                  onFocusComposer={onFocusComposer}
                  onReviewHistory={onReviewHistory}
                  onManualShippingGateChange={onManualShippingGateChange}
                />
              )}

              {/* HUMAN-HANDOFF-1: pedido abierto del cliente — contexto del comprobante sin salir del chat */}
              {orderQ.data && (
                <div className="flex items-center justify-between gap-2 border-b border-amber-100 bg-amber-50/70 px-4 py-2 text-xs">
                  <span className="min-w-0 truncate text-ink-700">
                    🧾 Pedido <span className="font-mono">{orderQ.data.id.slice(0, 12)}…</span> ·{' '}
                    <span className="font-semibold">{ORDER_STATUS_LABEL[orderQ.data.status] ?? orderQ.data.status}</span> · ₲{' '}
                    {orderQ.data.totals?.total?.toLocaleString('es-PY') ?? '—'}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {/* ORDER-COMPROBANTE-VIEW-1: la foto del pago, sin salir del chat (enlace temporal) */}
                    {comprobanteEstado(orderQ.data) === 'image' && (
                      <ComprobanteViewer tenantId={tenantId} orderId={orderQ.data.id} compact />
                    )}
                    <a href="/orders" className="font-semibold text-amber-700 hover:underline">
                      Ver en Pedidos →
                    </a>
                  </span>
                </div>
              )}

              <div className="flex-1 space-y-2 overflow-y-auto bg-ink-50/40 p-4">
                {messagesQ.isLoading && <div className="text-sm text-ink-400">Cargando mensajes…</div>}
                {messagesQ.isSuccess && (messagesQ.data?.length ?? 0) === 0 && (
                  <div className="text-center text-sm text-ink-400">Sin mensajes.</div>
                )}
                {messagesQ.data?.map((m: Message) => <Bubble key={m.id} m={m} />)}
                <div ref={endRef} />
              </div>

              {/* HUMAN-HANDOFF-1: composer del vendedor — responde por el MISMO número de WhatsApp */}
              {isHuman ? (
                <form
                  className="space-y-1.5 border-t border-ink-100 px-4 py-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    enviarManual();
                  }}
                >
                  <div className="flex items-center gap-2 text-[11px] text-ink-500">
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-700">🧑‍💼 Bot pausado — respondés vos</span>
                    {isMock && (
                      <span className="rounded-full bg-ink-100 px-2 py-0.5 text-ink-600" title="whatsappSendMode=mock">
                        Modo prueba: se guarda en el historial pero NO sale a WhatsApp
                      </span>
                    )}
                  </div>
                  <div className="flex items-end gap-2">
                    <textarea
                      ref={composerRef}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          enviarManual();
                        }
                      }}
                      rows={2}
                      maxLength={4096}
                      placeholder="Escribile al cliente… (Enter envía, Shift+Enter hace salto de línea)"
                      className="min-h-[2.5rem] flex-1 resize-y rounded-xl border border-ink-200 px-3 py-2 text-sm text-ink-900 outline-none focus:border-mint-500"
                    />
                    <button
                      type="submit"
                      disabled={!draft.trim() || sendMut.isPending || gateActivo}
                      className="shrink-0 rounded-xl bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-50"
                    >
                      {sendMut.isPending ? 'Enviando…' : 'Enviar por WhatsApp'}
                    </button>
                  </div>
                  {/* SHIPPING-CHAT-4B: ayuda NO destructiva del gate (el draft se conserva; el
                      preview de la tarjeta queda disponible para corregir o confirmar). */}
                  {gateActivo && (
                    <div className="text-xs font-medium text-sky-700" role="status">
                      {manualGate?.canQuote === false ? COMPOSER_GATE_HELP_SOLO_LECTURA : COMPOSER_GATE_HELP}
                    </div>
                  )}
                  {sendError && <div className="text-xs font-medium text-coral-600">{sendError}</div>}
                </form>
              ) : (
                <div className="border-t border-ink-100 px-4 py-2 text-center text-xs text-ink-400">
                  El bot responde automáticamente. Tomá la conversación para atender vos.
                </div>
              )}
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
  // ORDER-COMPROBANTE-VIEW-1: la imagen del cliente se muestra como card. SOLO los formatos
  // exactos del sistema (comprobanteImage.ts) — texto libre del cliente con 📷 va como burbuja
  // normal (review OCV-1: el prefijo es spoofeable). La card no afirma que sea un pago: la foto
  // real se ve con "Ver comprobante" en la barra del pedido, gateado por la orden.
  if (m.direction === 'in' && esMensajeImagenCliente(m.text)) {
    return (
      <div className="text-left">
        <div className="inline-block max-w-[80%] rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">📎 Imagen del cliente</div>
          <div className="mt-0.5 whitespace-pre-wrap">{m.text}</div>
          <div className="mt-1 text-[10px] text-amber-700/80">Si corresponde a un pedido, podés verla con “Ver comprobante” en la barra del pedido ↑</div>
        </div>
        <div className="mt-0.5 text-[10px] text-ink-400">{hhmm(m.createdAt)}</div>
      </div>
    );
  }
  const mine = m.direction === 'out'; // bot o vendedor (sale de nosotros)
  const tone =
    m.author === 'seller' ? 'bg-amber-500 text-white' : mine ? 'bg-mint-600 text-white' : 'border border-ink-100 bg-white text-ink-800';
  const authorLabel = m.author === 'seller' ? (m.senderName ?? 'Vendedor') : m.author === 'bot' ? null : null;
  return (
    <div className={mine ? 'text-right' : 'text-left'}>
      <div className={'inline-block max-w-[80%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ' + tone}>
        {authorLabel && <div className="mb-0.5 text-[10px] font-semibold opacity-80">🧑‍💼 {authorLabel}</div>}
        {m.text}
      </div>
      <div className="mt-0.5 text-[10px] text-ink-400">
        {hhmm(m.createdAt)}
        {m.author === 'seller' && m.viaMock && <span title="Modo prueba: no salió a WhatsApp"> · retenido (prueba)</span>}
      </div>
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
