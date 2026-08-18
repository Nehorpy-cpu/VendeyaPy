'use client';

/**
 * Bandeja de conversaciones profesional (ADR-0021).
 * Desktop XL: tres paneles (lista | conversación | info del cliente colapsable).
 * MD: lista + chat. Mobile: pantallas apiladas con «volver» claro.
 *
 * La página ORQUESTA (queries, mutaciones, estado compartido del draft y del gate); la UI vive
 * en componentes: ConversationList, ChatHeader, MessageHistory, Composer, CustomerInfoPanel.
 * Permisos: espejo de la matriz del ADR §7 (el server manda igual).
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  archiveConversation,
  unarchiveConversation,
  softDeleteConversation,
  restoreConversation,
} from '@/lib/conversations';
import {
  clearDraft,
  loadDraft,
  mergeMessageWindows,
  puedeArchivarConversacion,
  puedeEliminarConversacion,
  puedeVerConversaciones,
  saveDraft,
} from '@/lib/conversationsUi';
import { listTenantWhatsappNumbers } from '@/lib/whatsapp-activation';
import { getChannelConfig } from '@/lib/channels';
import { listCustomerOpenOrders, comprobanteEstado, ORDER_STATUS_LABEL } from '@/lib/orders';
import { listConversationAttachments, indexAttachments } from '@/lib/attachments';
import { composerGateActivo, COMPOSER_GATE_HELP, COMPOSER_GATE_HELP_SOLO_LECTURA, type ManualShippingGate } from '@/lib/shippingQuote';
import { ComprobanteViewer } from '@/components/ComprobanteViewer';
import { CoverageReviewCard } from '@/components/CoverageReviewCard';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { ConversationList } from '@/components/conversations/ConversationList';
import { ChatHeader } from '@/components/conversations/ChatHeader';
import { MessageHistory } from '@/components/conversations/MessageHistory';
import { Composer } from '@/components/conversations/Composer';
import { CustomerInfoPanel, type SellerOption } from '@/components/conversations/CustomerInfoPanel';
import { LinkClientModal } from '@/components/conversations/LinkClientModal';
import { useMarkRead } from '@/components/conversations/useMarkRead';

/** Ventana viva del historial (polling) y tamaño de página de la paginación hacia atrás. */
const MESSAGES_WINDOW = 200;
const OLDER_PAGE = 100;

function ConversationsInner() {
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const { user, claims } = useAuth();
  const qc = useQueryClient();
  const params = useSearchParams();
  const [selected, setSelected] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);

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
  const numbers = useMemo(() => numbersQ.data ?? [], [numbersQ.data]);
  const multiNumber = numbers.length > 1;
  const numberLabel = useCallback(
    (pnid: string) => numbers.find((n) => n.phoneNumberId === pnid)?.displayPhoneNumber ?? `…${pnid.slice(-4)}`,
    [numbers],
  );

  const customerQ = useQuery({
    queryKey: ['customer', tenantId, selected],
    queryFn: () => getCustomer(tenantId!, selected!),
    enabled: !!tenantId && !!selected,
  });

  const messagesQ = useQuery({
    queryKey: ['messages', tenantId, selected],
    queryFn: () => getMessages(tenantId!, selected!, MESSAGES_WINDOW),
    enabled: !!tenantId && !!selected,
    refetchInterval: 4000,
  });

  /**
   * ADR-0016: los adjuntos viven en `tenants/{t}/attachments` (raíz del tenant), NO adentro del
   * mensaje. Se leen por conversación y cada burbuja resuelve sus punteros contra este índice.
   * Si la lectura falla (permisos, red), la burbuja muestra el error con reintento — nunca una
   * tarjeta a medias ni un adjunto inventado desde el texto.
   */
  const attachmentsQ = useQuery({
    queryKey: ['attachments', tenantId, selected],
    queryFn: () => listConversationAttachments(tenantId!, selected!),
    enabled: !!tenantId && !!selected,
    refetchInterval: 10000,
  });
  const attachmentsById = useMemo(() => indexAttachments(attachmentsQ.data ?? []), [attachmentsQ.data]);

  const refreshAll = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['messages', tenantId, selected] });
    qc.invalidateQueries({ queryKey: ['customer', tenantId, selected] });
    qc.invalidateQueries({ queryKey: ['conversations', tenantId] });
    qc.invalidateQueries({ queryKey: ['customers', tenantId] });
  }, [qc, tenantId, selected]);

  /** Después de una acción humana sobre un adjunto: adjunto + pedidos del cliente. */
  const refreshAttachments = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['attachments', tenantId, selected] });
    qc.invalidateQueries({ queryKey: ['customerOpenOrders', tenantId, selected] });
    qc.invalidateQueries({ queryKey: ['orders', tenantId] });
  }, [qc, tenantId, selected]);
  // `refetch` es estable en react-query: se aísla para que el reintento no cambie de identidad
  // en cada render y no re-renderice todas las burbujas.
  const refetchAttachments = attachmentsQ.refetch;
  const retryAttachments = useCallback(() => { void refetchAttachments(); }, [refetchAttachments]);

  /**
   * Los mensajes se refrescan más seguido que los adjuntos: un mensaje con punteros puede llegar
   * ANTES que su adjunto a esta caché y, sin esto, la burbuja mostraría un error alarmante
   * ("no encontramos el archivo") durante la ventana entre un refresco y el otro.
   * Se fuerza UNA sola relectura por id nuevo faltante (el Set corta cualquier bucle de refetch);
   * si después de eso sigue sin aparecer, entonces sí es un faltante real y se informa.
   */
  const idsReintentados = useRef<Set<string>>(new Set());
  useEffect(() => { idsReintentados.current = new Set(); }, [selected]);
  useEffect(() => {
    if (!attachmentsQ.isSuccess || attachmentsQ.isFetching) return;
    const faltantes = (messagesQ.data ?? [])
      .flatMap((m) => m.attachmentIds ?? [])
      .filter((id) => !attachmentsById.has(id) && !idsReintentados.current.has(id));
    if (faltantes.length === 0) return;
    faltantes.forEach((id) => idsReintentados.current.add(id));
    void refetchAttachments();
  }, [messagesQ.data, attachmentsById, attachmentsQ.isSuccess, attachmentsQ.isFetching, refetchAttachments]);

  // ── Anuncios accesibles + feedback visible de acciones ──────────────────────
  const [actionMsg, setActionMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const announceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announce = useCallback((text: string, kind: 'ok' | 'error' = 'ok') => {
    setActionMsg({ kind, text });
    if (announceTimer.current) clearTimeout(announceTimer.current);
    announceTimer.current = setTimeout(() => setActionMsg(null), 5000);
  }, []);
  useEffect(() => () => { if (announceTimer.current) clearTimeout(announceTimer.current); }, []);

  const takeMut = useMutation({
    mutationFn: () => takeoverChat(tenantId!, selected!),
    onSuccess: () => { announce('Tomaste la conversación: el bot quedó en pausa.'); refreshAll(); },
    onError: (e) => announce(e instanceof Error ? e.message : 'No se pudo tomar la conversación.', 'error'),
  });
  const releaseMut = useMutation({
    mutationFn: () => releaseChat(tenantId!, selected!),
    onSuccess: () => { announce('Devolviste la conversación al bot.'); refreshAll(); },
    onError: (e) => announce(e instanceof Error ? e.message : 'No se pudo devolver la conversación.', 'error'),
  });

  // ── Ciclo de vida (ADR-0021 §3): archivar / eliminar lógico, siempre reversibles ──
  const archiveMut = useMutation({
    mutationFn: () => archiveConversation(tenantId!, selected!),
    onSuccess: () => { announce('Conversación archivada. Un mensaje nuevo del cliente la desarchiva.'); refreshAll(); },
    onError: (e) => announce(e instanceof Error ? e.message : 'No se pudo archivar.', 'error'),
  });
  const unarchiveMut = useMutation({
    mutationFn: () => unarchiveConversation(tenantId!, selected!),
    onSuccess: () => { announce('Conversación desarchivada.'); refreshAll(); },
    onError: (e) => announce(e instanceof Error ? e.message : 'No se pudo desarchivar.', 'error'),
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteMut = useMutation({
    mutationFn: () => softDeleteConversation(tenantId!, selected!),
    onSuccess: () => {
      setConfirmDelete(false);
      announce('Conversación eliminada. Es reversible desde el filtro «Eliminadas».');
      refreshAll();
    },
  });
  const restoreMut = useMutation({
    mutationFn: () => restoreConversation(tenantId!, selected!),
    onSuccess: () => { announce('Conversación restaurada.'); refreshAll(); },
    onError: (e) => announce(e instanceof Error ? e.message : 'No se pudo restaurar.', 'error'),
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
  const [scrollSignal, setScrollSignal] = useState(0);
  const bumpScroll = useCallback(() => setScrollSignal((s) => s + 1), []);

  const sendMut = useMutation({
    mutationFn: (vars: { customerId: string; text: string }) =>
      sendManualMessage(tenantId!, vars.customerId, vars.text),
    onSuccess: (r, vars) => {
      if (vars.customerId !== selectedRef.current) return; // resolvió para otro chat: no tocar la UI
      setDraft('');
      if (tenantId) clearDraft(tenantId, vars.customerId); // borrador local: limpiar al enviar OK
      setSendError(null);
      setLastViaMock(r.viaMock);
      refreshAll();
      bumpScroll();
    },
    onError: (e, vars) => {
      if (vars.customerId !== selectedRef.current) return;
      setSendError(e instanceof Error ? e.message : 'No se pudo enviar el mensaje.');
    },
  });

  // Al cambiar de chat: restaurar el BORRADOR local de esa conversación (ADR-0021 UX).
  useEffect(() => {
    setDraft(tenantId && selected ? loadDraft(tenantId, selected) : '');
    setSendError(null);
    setLastViaMock(false);
    setManualGate(null);
  }, [selected, tenantId]);

  // El borrador se persiste en el MOMENTO en que el usuario escribe (no en un efecto): así el
  // cambio de chat jamás guarda el texto de una conversación bajo la clave de otra.
  const handleDraftChange = useCallback((texto: string) => {
    setDraft(texto);
    if (tenantId && selectedRef.current) saveDraft(tenantId, selectedRef.current, texto);
  }, [tenantId]);

  // SHIPPING-CHAT-4B — el card publica el gate del envío manual (espejo del gate server de 3B;
  // la autoridad es el server). Solo bloquea si pertenece a la conversación SELECCIONADA. La
  // limpieza real al cambiar de chat es el efecto [selected] de arriba: la publicación de
  // desmontaje del card llega siempre con el customerId VIEJO y el filtro de abajo la ignora.
  const [manualGate, setManualGate] = useState<ManualShippingGate | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const onManualShippingGateChange = useCallback((g: ManualShippingGate) => {
    // HARDEN-1 (B): TODA publicación de otro chat se ignora — un blocked:true tardío no bloquea
    // al chat nuevo, y el cleanup blocked:false de un card viejo JAMÁS limpia el gate vigente.
    if (g.customerId !== selectedRef.current) return;
    setManualGate(g);
  }, []);
  const onFocusComposer = useCallback(() => composerRef.current?.focus(), []);
  const onReviewHistory = useCallback(() => {
    bumpScroll();
    composerRef.current?.focus();
  }, [bumpScroll]);
  const onSetDraft = useCallback((texto: string) => {
    // Completa la plantilla SOLO sobre un composer vacío — jamás pisa un borrador escrito.
    setDraft((actual) => {
      const siguiente = actual.trim() === '' ? texto : actual;
      if (siguiente !== actual && tenantId && selectedRef.current) {
        saveDraft(tenantId, selectedRef.current, siguiente);
      }
      return siguiente;
    });
    composerRef.current?.focus();
  }, [tenantId]);
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

  // Pedidos abiertos del cliente (banner con link a Pedidos). El comprobante activa el handoff
  // sobre un pedido PENDING_VERIFICATION: esto le da contexto al vendedor sin salir del chat.
  // ADR-0016: se lee la LISTA, no solo el primero — las acciones de adjunto necesitan saber si
  // hay ambigüedad entre pedidos para obligar a una elección explícita.
  const orderQ = useQuery({
    queryKey: ['customerOpenOrders', tenantId, selected],
    queryFn: () => listCustomerOpenOrders(tenantId!, selected!).catch(() => []),
    enabled: !!tenantId && !!selected,
    refetchInterval: 15000,
  });
  const openOrders = useMemo(() => orderQ.data ?? [], [orderQ.data]);
  const openOrder = openOrders[0] ?? null;

  // ── Paginación hacia atrás del historial (ADR-0021): páginas viejas + ventana viva ──
  const [older, setOlder] = useState<Message[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [noMore, setNoMore] = useState(false);
  useEffect(() => {
    setOlder([]);
    setLoadingOlder(false);
    setOlderError(null);
    setNoMore(false);
  }, [selected]);
  const latest = useMemo(() => messagesQ.data ?? [], [messagesQ.data]);
  const combined = useMemo(() => mergeMessageWindows(older, latest), [older, latest]);
  const hasMore = !noMore && latest.length >= MESSAGES_WINDOW;

  const cargarAnteriores = useCallback(async () => {
    const chatId = selectedRef.current;
    const primero = combined[0];
    if (!tenantId || !chatId || !primero || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const page = await getMessages(tenantId, chatId, OLDER_PAGE, primero.createdAt);
      if (selectedRef.current !== chatId) return; // cambió de chat con la página en vuelo
      if (page.length < OLDER_PAGE) setNoMore(true);
      setOlder((prev) => mergeMessageWindows(page, prev));
    } catch {
      if (selectedRef.current === chatId) setOlderError('No se pudieron cargar los mensajes anteriores. Probá de nuevo.');
    } finally {
      if (selectedRef.current === chatId) setLoadingOlder(false);
    }
  }, [tenantId, combined, loadingOlder]);

  // aria-live: avisar la llegada de mensajes nuevos del cliente con el chat abierto.
  const prevCountRef = useRef<{ chat: string | null; count: number }>({ chat: null, count: 0 });
  useEffect(() => {
    const prev = prevCountRef.current;
    const ultimo = combined[combined.length - 1];
    if (prev.chat === selected && combined.length > prev.count && ultimo?.direction === 'in') {
      announce('Nuevo mensaje del cliente.');
    }
    prevCountRef.current = { chat: selected, count: combined.length };
  }, [combined, selected, announce]);

  const convs = useMemo(() => convsQ.data ?? [], [convsQ.data]);
  const current: Customer | null = customerQ.data ?? convs.find((c) => c.id === selected) ?? null;
  const conv = current?.conversation;
  const isHuman = conv?.humanTakeover ?? false;
  const archivada = !!conv?.archived;
  const eliminada = !!conv?.softDeleted;
  const busy = takeMut.isPending || releaseMut.isPending;
  const role = claims.role;

  // markRead al abrir (fire-and-forget + reflejo optimista en la lista).
  useMarkRead(tenantId, current, role);

  // Vendedores vistos en la ventana (no hay roster server-side: opciones honestas del cliente).
  const sellerOptions: SellerOption[] = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of convs) {
      if (c.assignedSellerId) map.set(c.assignedSellerId, c.assignedSellerName ?? 'Vendedor');
    }
    return Array.from(map, ([uid, name]) => ({ uid, name }));
  }, [convs]);

  const [linkOpen, setLinkOpen] = useState(false);

  if (companyLoading) return <div className="text-sm text-ink-400">Cargando…</div>;
  if (!tenantId) {
    return (
      <div className="rounded-2xl border border-dashed border-ink-200 bg-white p-10 text-center text-sm text-ink-500">
        Seleccioná una empresa para ver sus conversaciones.
      </div>
    );
  }
  if (role && !puedeVerConversaciones(role)) {
    return (
      <div className="rounded-2xl border border-dashed border-ink-200 bg-white p-10 text-center text-sm text-ink-500">
        Tu rol no tiene acceso al módulo de conversaciones.
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100dvh-9.5rem)] min-h-[28rem] flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">Conversaciones</h1>
          <p className="mt-0.5 text-sm text-ink-500">La bandeja de tu negocio. Tomá una charla para atenderla vos.</p>
        </div>
        {/* Resultado de la última acción: visible y anunciado (aria-live). */}
        <div aria-live="polite" role="status">
          {actionMsg && (
            <span
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium',
                actionMsg.kind === 'ok' ? 'bg-mint-50 text-mint-700' : 'bg-coral-50 text-coral-700',
              )}
            >
              {actionMsg.text}
            </span>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        {/* Lista — en mobile se oculta cuando hay un chat abierto (patrón list-or-chat) */}
        <div
          className={cn(
            'w-full flex-col overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-soft md:flex md:w-72 md:shrink-0 lg:w-80',
            selected ? 'hidden md:flex' : 'flex',
          )}
        >
          <ConversationList
            convs={convs}
            loading={convsQ.isLoading}
            error={convsQ.isError}
            selectedId={selected}
            uid={user?.uid ?? null}
            multiNumber={multiNumber}
            numberLabel={numberLabel}
            onSelect={setSelected}
          />
        </div>

        {/* Chat — en mobile solo se muestra cuando hay un chat seleccionado */}
        <div
          className={cn(
            'min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-soft md:flex',
            selected ? 'flex' : 'hidden md:flex',
          )}
        >
          {!selected && (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-ink-400">
              Elegí una conversación de la izquierda.
            </div>
          )}
          {selected && (
            <>
              <ChatHeader
                customer={current}
                customerId={selected}
                role={role}
                isHuman={isHuman}
                busy={busy}
                infoOpen={infoOpen}
                onBack={() => setSelected(null)}
                onTake={() => takeMut.mutate()}
                onRelease={() => releaseMut.mutate()}
                takePending={takeMut.isPending}
                releasePending={releaseMut.isPending}
                onToggleInfo={() => setInfoOpen((v) => !v)}
                onArchive={() => archiveMut.mutate()}
                onUnarchive={() => unarchiveMut.mutate()}
                onSoftDelete={() => setConfirmDelete(true)}
                onRestore={() => restoreMut.mutate()}
                onOpenLink={() => setLinkOpen(true)}
                onOpenAssign={() => setInfoOpen(true)}
              />

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
              {openOrder && (
                <div className="flex items-center justify-between gap-2 border-b border-amber-100 bg-amber-50/70 px-4 py-2 text-xs">
                  <span className="min-w-0 truncate text-ink-700">
                    🧾 Pedido <span className="font-mono">{openOrder.id.slice(0, 12)}…</span> ·{' '}
                    <span className="font-semibold">{ORDER_STATUS_LABEL[openOrder.status] ?? openOrder.status}</span> · ₲{' '}
                    {openOrder.totals?.total?.toLocaleString('es-PY') ?? '—'}
                    {openOrders.length > 1 && (
                      <span className="ml-1 text-ink-500">(+{openOrders.length - 1} abiertos)</span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {/* ORDER-COMPROBANTE-VIEW-1: comprobantes LEGACY (ruta vieja del pedido) — siguen
                        abriendo con su visor. ADR-0016 §7: compatibilidad aditiva, no se reescribe historia. */}
                    {comprobanteEstado(openOrder) === 'image' && (
                      <ComprobanteViewer tenantId={tenantId} orderId={openOrder.id} compact />
                    )}
                    <a href="/orders" className="font-semibold text-amber-700 hover:underline">
                      Ver en Pedidos →
                    </a>
                  </span>
                </div>
              )}

              {/* Prefijo por componente en la key: la MISMA key en dos hermanos hace que React
                  apile instancias sin desmontar (bug real medido: 41 MessageHistory en el DOM).
                  La semántica se conserva: cambiar de chat resetea scroll/paginación/adjunto. */}
              <MessageHistory
                key={`hist-${selected}`}
                tenantId={tenantId}
                messages={combined}
                loading={messagesQ.isLoading}
                hasMore={hasMore}
                loadingOlder={loadingOlder}
                olderError={olderError}
                onLoadOlder={() => void cargarAnteriores()}
                scrollToEndSignal={scrollSignal}
                attachmentsById={attachmentsById}
                attachmentsLoading={attachmentsQ.isLoading || attachmentsQ.isFetching}
                attachmentsFailed={attachmentsQ.isError}
                onRetryAttachments={retryAttachments}
                role={role}
                orders={openOrders}
                onAttachmentChanged={refreshAttachments}
              />

              <Composer
                key={`comp-${selected}`}
                tenantId={tenantId}
                customerId={selected}
                value={draft}
                onChange={handleDraftChange}
                textareaRef={composerRef}
                channel={conv?.channel}
                archived={archivada}
                softDeleted={eliminada}
                isHuman={isHuman}
                role={role}
                gateActivo={gateActivo}
                gateHelp={manualGate?.canQuote === false ? COMPOSER_GATE_HELP_SOLO_LECTURA : COMPOSER_GATE_HELP}
                isMock={isMock}
                sending={sendMut.isPending}
                sendError={sendError}
                onSubmit={enviarManual}
                canRestore={eliminada ? puedeEliminarConversacion(role) : puedeArchivarConversacion(role)}
                onRestore={() => (eliminada ? restoreMut.mutate() : unarchiveMut.mutate())}
                restorePending={restoreMut.isPending || unarchiveMut.isPending}
                onAttachmentSent={(viaMock) => {
                  setLastViaMock(viaMock);
                  announce(viaMock ? 'Archivo guardado en el historial (modo prueba: no salió a WhatsApp).' : 'Archivo enviado.');
                  refreshAll();
                  refreshAttachments();
                  bumpScroll();
                }}
              />
            </>
          )}
        </div>

        {/* Info del cliente — columna colapsable en XL; drawer sobre el contenido por debajo */}
        {selected && current && infoOpen && (
          <>
            <div
              className="fixed inset-0 z-40 bg-ink-950/30 xl:hidden"
              aria-hidden="true"
              onClick={() => setInfoOpen(false)}
            />
            <aside
              aria-label="Información del cliente"
              className="fixed inset-y-0 right-0 z-40 flex w-80 max-w-[90vw] flex-col border-l border-ink-100 bg-white shadow-float xl:static xl:z-auto xl:w-80 xl:max-w-none xl:shrink-0 xl:rounded-2xl xl:border xl:shadow-soft"
            >
              <CustomerInfoPanel
                tenantId={tenantId}
                customer={current}
                role={role}
                uid={user?.uid ?? null}
                userName={user?.displayName ?? user?.email ?? null}
                sellerOptions={sellerOptions}
                onClose={() => setInfoOpen(false)}
                onChanged={refreshAll}
                announce={announce}
              />
            </aside>
          </>
        )}
      </div>

      {confirmDelete && selected && (
        <ConfirmModal
          title="Eliminar conversación"
          confirmLabel="Eliminar"
          danger
          pending={deleteMut.isPending}
          error={deleteMut.isError ? (deleteMut.error instanceof Error ? deleteMut.error.message : 'No se pudo eliminar.') : null}
          onConfirm={() => deleteMut.mutate()}
          onCancel={() => setConfirmDelete(false)}
        >
          La conversación se oculta de la bandeja. Es <strong>reversible</strong>: los mensajes,
          adjuntos y comprobantes no se borran, y podés restaurarla cuando quieras desde el filtro
          «Eliminadas».
        </ConfirmModal>
      )}

      {linkOpen && selected && (
        <LinkClientModal
          tenantId={tenantId}
          customerId={selected}
          onClose={() => setLinkOpen(false)}
          onLinked={(msg) => {
            announce(msg);
            refreshAll();
          }}
        />
      )}
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
