'use client';

/**
 * Picker de emojis Unicode PROPIO (ADR-0021: sin dependencias nuevas, sin assets de terceros).
 * Popover accesible: Escape cierra y devuelve el foco, click afuera cierra, los emojis son
 * botones navegables por teclado (el lector de pantalla anuncia el emoji nativamente).
 */

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

const CATEGORIAS: { key: string; label: string; emojis: string[] }[] = [
  {
    key: 'caras',
    label: 'Caras',
    emojis: ['😀', '😄', '😁', '😂', '🤣', '😊', '😉', '😍', '🥰', '😘', '😎', '🤗', '🤔', '😅', '😇', '🙂', '😌', '😢', '😭', '😡', '😴', '🤤', '🥳', '🤩'],
  },
  {
    key: 'gestos',
    label: 'Gestos',
    emojis: ['👍', '👎', '👌', '✌️', '🤝', '🙏', '👏', '💪', '🤞', '👋', '🫶', '👉', '👈', '☝️', '✋', '🤙'],
  },
  {
    key: 'corazones',
    label: 'Corazones',
    emojis: ['❤️', '🩷', '💛', '💚', '💙', '💜', '🖤', '🤍', '💕', '💖', '💘', '💝', '💗', '💞'],
  },
  {
    key: 'compras',
    label: 'Compras',
    emojis: ['🛍️', '🎁', '💐', '🌹', '🌸', '✨', '⭐', '🎉', '🎊', '💄', '👜', '💎', '🧴', '🕯️', '📦', '🚚', '💳', '💵', '🧾', '🏷️'],
  },
  {
    key: 'simbolos',
    label: 'Símbolos',
    emojis: ['✅', '❌', '⚠️', '❓', '❗', '💬', '📍', '📅', '⏰', '🔥', '💯', '🆗', '🔜', '🙌', '📸', '📞'],
  },
];

export function EmojiPicker({
  onPick,
  onClose,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const [cat, setCat] = useState(CATEGORIAS[0]!.key);
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape cierra; click fuera del panel cierra.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [onClose]);

  // Foco inicial dentro del popover (primer tab de categoría).
  useEffect(() => {
    panelRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);

  const activa = CATEGORIAS.find((c) => c.key === cat) ?? CATEGORIAS[0]!;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Elegir emoji"
      className="absolute bottom-full left-0 z-30 mb-2 w-72 max-w-[calc(100vw-2rem)] rounded-2xl border border-ink-100 bg-white p-2 shadow-float"
    >
      <div className="flex gap-1 border-b border-ink-100 pb-1.5" role="tablist" aria-label="Categorías de emojis">
        {CATEGORIAS.map((c) => (
          <button
            key={c.key}
            type="button"
            role="tab"
            aria-selected={c.key === cat}
            onClick={() => setCat(c.key)}
            className={cn(
              'rounded-lg px-2 py-1 text-[11px] font-semibold transition-colors',
              c.key === cat ? 'bg-ink-900 text-white' : 'text-ink-500 hover:bg-ink-50',
            )}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="mt-1.5 grid max-h-40 grid-cols-8 gap-0.5 overflow-y-auto" role="tabpanel">
        {activa.emojis.map((e) => (
          <button
            key={e}
            type="button"
            onClick={() => onPick(e)}
            className="grid h-8 w-8 place-items-center rounded-lg text-lg transition-colors hover:bg-ink-50 focus-visible:bg-ink-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint-500/60"
          >
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}
