'use client';

/**
 * Header de la conversación abierta (ADR-0021, UX normativa): avatar de iniciales, nombre,
 * canal, estado bot/humano, tomar/devolver y el menú de acciones (asignar, vincular, archivar,
 * eliminar/restaurar, info) filtrado por la matriz de permisos §7 — el server manda igual.
 */

import { useEffect, useRef, useState } from 'react';
import type { Customer } from '@vpw/shared';
import type { Role } from '@/lib/auth-context';
import {
  CHANNEL_ICON,
  CHANNEL_LABEL,
  conversationDisplayName,
  puedeArchivarConversacion,
  puedeAsignarVendedor,
  puedeEliminarConversacion,
  puedeTomarConversacion,
  puedeVincularCliente,
} from '@/lib/conversationsUi';
import { cn } from '@/lib/cn';
import { InitialsAvatar } from './InitialsAvatar';

interface MenuItem {
  key: string;
  label: string;
  danger?: boolean;
  onClick: () => void;
}

export function ChatHeader({
  customer,
  customerId,
  role,
  isHuman,
  busy,
  infoOpen,
  onBack,
  onTake,
  onRelease,
  takePending,
  releasePending,
  onToggleInfo,
  onArchive,
  onUnarchive,
  onSoftDelete,
  onRestore,
  onOpenLink,
  onOpenAssign,
}: {
  customer: Customer | null;
  customerId: string;
  role: Role | null;
  isHuman: boolean;
  busy: boolean;
  infoOpen: boolean;
  onBack: () => void;
  onTake: () => void;
  onRelease: () => void;
  takePending: boolean;
  releasePending: boolean;
  onToggleInfo: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onSoftDelete: () => void;
  onRestore: () => void;
  onOpenLink: () => void;
  onOpenAssign: () => void;
}) {
  const conv = customer?.conversation;
  const canal = conv?.channel ?? 'whatsapp';
  const nombre = customer ? conversationDisplayName(customer) : customerId;
  const archivada = !!conv?.archived;
  const eliminada = !!conv?.softDeleted;

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [menuOpen]);

  // Foco al primer ítem al abrir; ↑/↓ navegan.
  useEffect(() => {
    if (menuOpen) menuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.focus();
  }, [menuOpen]);
  const navegarMenu = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    e.preventDefault();
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const items: MenuItem[] = [];
  if (puedeAsignarVendedor(role)) items.push({ key: 'asignar', label: 'Asignar vendedor…', onClick: onOpenAssign });
  if (puedeVincularCliente(role)) items.push({ key: 'vincular', label: 'Vincular cliente…', onClick: onOpenLink });
  if (puedeArchivarConversacion(role) && !eliminada) {
    items.push(
      archivada
        ? { key: 'desarchivar', label: 'Desarchivar', onClick: onUnarchive }
        : { key: 'archivar', label: 'Archivar conversación', onClick: onArchive },
    );
  }
  if (puedeEliminarConversacion(role)) {
    items.push(
      eliminada
        ? { key: 'restaurar', label: 'Restaurar conversación', onClick: onRestore }
        : { key: 'eliminar', label: 'Eliminar conversación…', danger: true, onClick: onSoftDelete },
    );
  }

  return (
    <div className="flex items-center justify-between gap-2 border-b border-ink-100 px-3 py-2.5 md:px-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Volver a la lista"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-500 transition-colors hover:bg-ink-50 md:hidden"
        >
          ←
        </button>
        <InitialsAvatar id={customerId} label={nombre} size="md" />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-semibold text-ink-900">{nombre}</span>
            <span title={CHANNEL_LABEL[canal] ?? canal} aria-hidden="true" className="text-xs">
              {CHANNEL_ICON[canal] ?? ''}
            </span>
            {archivada && !eliminada && (
              <span className="rounded-full bg-ink-100 px-1.5 text-[10px] font-medium text-ink-500">Archivada</span>
            )}
            {eliminada && (
              <span className="rounded-full bg-coral-50 px-1.5 text-[10px] font-medium text-coral-700">Eliminada</span>
            )}
          </div>
          <div className="truncate text-xs text-ink-400">
            {isHuman
              ? `🧑‍💼 ${customer?.assignedSellerName ? 'Atiende ' + customer.assignedSellerName : 'Lo atiende un vendedor'} · bot en pausa`
              : '🤖 Lo atiende el bot'}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {puedeTomarConversacion(role) && !eliminada && (
          isHuman ? (
            <button
              type="button"
              onClick={onRelease}
              disabled={busy}
              className="rounded-lg bg-mint-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60 md:text-sm"
            >
              {releasePending ? 'Devolviendo…' : 'Devolver al bot'}
            </button>
          ) : (
            <button
              type="button"
              onClick={onTake}
              disabled={busy}
              className="rounded-lg bg-amber-500 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-amber-600 disabled:opacity-60 md:text-sm"
            >
              {takePending ? 'Tomando…' : 'Tomar conversación'}
            </button>
          )
        )}
        <button
          type="button"
          onClick={onToggleInfo}
          aria-pressed={infoOpen}
          aria-label={infoOpen ? 'Cerrar información del cliente' : 'Abrir información del cliente'}
          title="Info del cliente"
          className={cn(
            'grid h-9 w-9 place-items-center rounded-lg text-base transition-colors hover:bg-ink-50',
            infoOpen ? 'bg-ink-100 text-ink-700' : 'text-ink-500',
          )}
        >
          ⓘ
        </button>
        {items.length > 0 && (
          <div ref={menuRef} className="relative" onKeyDown={navegarMenu}>
            <button
              ref={triggerRef}
              type="button"
              aria-label="Más acciones"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
              className="grid h-9 w-9 place-items-center rounded-lg text-lg text-ink-500 transition-colors hover:bg-ink-50"
            >
              ⋮
            </button>
            {menuOpen && (
              <div
                role="menu"
                aria-label="Acciones de la conversación"
                className="absolute right-0 top-full z-30 mt-1 w-56 rounded-xl border border-ink-100 bg-white py-1 shadow-float"
              >
                {items.map((it) => (
                  <button
                    key={it.key}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      it.onClick();
                    }}
                    className={cn(
                      'block w-full px-3 py-2 text-left text-sm transition-colors hover:bg-ink-50 focus-visible:bg-ink-50 focus-visible:outline-none',
                      it.danger ? 'text-coral-700' : 'text-ink-800',
                    )}
                  >
                    {it.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
