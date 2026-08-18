'use client';

/**
 * Lista de conversaciones de la bandeja (ADR-0021, UX normativa).
 * Buscador + chips de filtro client-side sobre la ventana cargada (deuda aceptada del ADR).
 * Por defecto EXCLUYE archivadas y eliminadas; sus chips dedicados las muestran para restaurar.
 */

import { useMemo, useRef, useState } from 'react';
import type { Customer } from '@vpw/shared';
import {
  CHANNEL_ICON,
  CHANNEL_LABEL,
  CONVERSATION_FILTERS,
  EMPTY_BY_FILTER,
  conversationDisplayName,
  filterConversations,
  smartListTime,
  type ConversationFilter,
} from '@/lib/conversationsUi';
import { cn } from '@/lib/cn';
import { InitialsAvatar } from './InitialsAvatar';

export function ConversationList({
  convs,
  loading,
  error,
  selectedId,
  uid,
  multiNumber,
  numberLabel,
  onSelect,
}: {
  convs: readonly Customer[];
  loading: boolean;
  error: boolean;
  selectedId: string | null;
  uid: string | null;
  /** MULTI-NUMBER-1: badge «Recibido en +…» solo cuando el negocio tiene más de un número. */
  multiNumber: boolean;
  numberLabel: (pnid: string) => string;
  onSelect: (customerId: string) => void;
}) {
  const [filter, setFilter] = useState<ConversationFilter>('todas');
  const [search, setSearch] = useState('');
  const listRef = useRef<HTMLUListElement>(null);

  const visibles = useMemo(
    () => filterConversations(convs, filter, search, uid),
    [convs, filter, search, uid],
  );

  // Navegación por teclado en la lista: ↑/↓ mueven el foco entre conversaciones.
  const moverFoco = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const botones = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-conv-item]') ?? [],
    );
    if (botones.length === 0) return;
    const idx = botones.indexOf(document.activeElement as HTMLButtonElement);
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? Math.min(idx + 1, botones.length - 1) : Math.max(idx - 1, 0);
    botones[idx === -1 ? 0 : next]?.focus();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 border-b border-ink-100 px-3 py-2.5">
        <label className="block">
          <span className="sr-only">Buscar conversaciones</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre, teléfono o mensaje…"
            className="w-full rounded-lg border border-ink-200 px-3 py-1.5 text-sm text-ink-800 transition-colors focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30"
          />
        </label>
        <div className="flex gap-1.5 overflow-x-auto pb-0.5" role="group" aria-label="Filtrar conversaciones">
          {CONVERSATION_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                'shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors',
                filter === f.key
                  ? 'bg-ink-900 text-white'
                  : 'bg-ink-50 text-ink-600 hover:bg-ink-100',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && (
          <div className="space-y-2 p-3" role="status" aria-label="Cargando conversaciones">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-14 animate-pulse rounded-xl bg-ink-50/80" />
            ))}
          </div>
        )}
        {error && !loading && (
          <div className="m-3 rounded-xl border border-coral-200 bg-coral-50 px-3 py-2 text-xs text-coral-700" role="alert">
            No se pudieron cargar las conversaciones. Revisá tu conexión.
          </div>
        )}
        {!loading && !error && visibles.length === 0 && (
          <div className="p-6 text-center text-sm text-ink-500">
            {search.trim()
              ? 'Ninguna conversación coincide con la búsqueda.'
              : EMPTY_BY_FILTER[filter]}
          </div>
        )}
        <ul ref={listRef} onKeyDown={moverFoco} className="divide-y divide-ink-50">
          {visibles.map((c) => (
            <ConversationListItem
              key={c.id}
              c={c}
              active={c.id === selectedId}
              uid={uid}
              multiNumber={multiNumber}
              numberLabel={numberLabel}
              onSelect={onSelect}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

function ConversationListItem({
  c,
  active,
  uid,
  multiNumber,
  numberLabel,
  onSelect,
}: {
  c: Customer;
  active: boolean;
  uid: string | null;
  multiNumber: boolean;
  numberLabel: (pnid: string) => string;
  onSelect: (customerId: string) => void;
}) {
  const conv = c.conversation;
  const unread = conv?.unreadForSeller ?? 0;
  const mine = !!uid && c.assignedSellerId === uid;
  const nombre = conversationDisplayName(c);

  return (
    <li>
      <button
        type="button"
        data-conv-item
        onClick={() => onSelect(c.id)}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-ink-50/60 focus-visible:bg-ink-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-mint-500/60',
          active && 'bg-mint-50',
        )}
      >
        <InitialsAvatar id={c.id} label={nombre} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className={cn('truncate text-sm text-ink-900', unread > 0 ? 'font-semibold' : 'font-medium')}>
              {nombre}
            </span>
            <span className="shrink-0 text-[11px] text-ink-400">{smartListTime(conv?.lastMessageAt)}</span>
          </span>
          <span className="mt-0.5 flex items-center justify-between gap-2">
            <span className={cn('truncate text-xs', unread > 0 ? 'font-medium text-ink-700' : 'text-ink-500')}>
              {conv?.lastMessagePreview ?? ''}
            </span>
            <span className="flex shrink-0 items-center gap-1">
              {conv?.archived && !conv?.softDeleted && (
                <span className="rounded-full bg-ink-100 px-1.5 text-[10px] font-medium text-ink-500">Archivada</span>
              )}
              {conv?.softDeleted && (
                <span className="rounded-full bg-coral-50 px-1.5 text-[10px] font-medium text-coral-700">Eliminada</span>
              )}
              {multiNumber && conv?.receivedVia && (
                <span
                  title={'Recibido en ' + numberLabel(conv.receivedVia)}
                  className="rounded-full bg-ink-50 px-1.5 text-[10px] font-medium text-ink-500"
                >
                  📞 {numberLabel(conv.receivedVia)}
                </span>
              )}
              {conv?.channel && (
                <span title={CHANNEL_LABEL[conv.channel] ?? conv.channel} aria-hidden="true">
                  {CHANNEL_ICON[conv.channel] ?? ''}
                </span>
              )}
              {c.assignedSellerId && (
                <span
                  title={'Asignado a ' + (c.assignedSellerName ?? 'un vendedor')}
                  className={cn(
                    'rounded-full px-1.5 text-[10px] font-medium',
                    mine ? 'bg-mint-100 text-mint-700' : 'bg-ink-100 text-ink-500',
                  )}
                >
                  {mine ? 'mío' : '👤'}
                </span>
              )}
              {conv?.humanTakeover ? (
                <span title="Atiende un vendedor" aria-hidden="true">🧑‍💼</span>
              ) : (
                <span title="Atiende el bot" aria-hidden="true">🤖</span>
              )}
              {unread > 0 && (
                <span
                  aria-label={unread === 1 ? '1 mensaje sin leer' : `${unread} mensajes sin leer`}
                  className="grid h-4 min-w-[1rem] place-items-center rounded-full bg-coral-500 px-1 text-[10px] font-bold text-white"
                >
                  {unread}
                </span>
              )}
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}
