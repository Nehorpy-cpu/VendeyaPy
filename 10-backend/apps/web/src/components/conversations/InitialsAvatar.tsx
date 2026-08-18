'use client';

/**
 * Avatar de iniciales (ADR-0021 §2). La WhatsApp Cloud API no entrega la foto de perfil del
 * consumidor, así que el avatar es SIEMPRE de iniciales: color determinístico por id (el mismo
 * cliente siempre se ve igual) con pares fondo/texto de contraste AA.
 */

import { AVATAR_PALETTE, avatarPaletteIndex, initialsFor } from '@/lib/conversationsUi';
import { cn } from '@/lib/cn';

const SIZE = {
  sm: 'h-9 w-9 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-16 w-16 text-xl',
} as const;

export function InitialsAvatar({
  id,
  label,
  size = 'md',
  className,
}: {
  /** Id estable del cliente (define el color). */
  id: string;
  /** Nombre a mostrar (define las iniciales; con teléfono usa los últimos dígitos). */
  label: string;
  size?: keyof typeof SIZE;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid shrink-0 select-none place-items-center rounded-full font-semibold',
        SIZE[size],
        AVATAR_PALETTE[avatarPaletteIndex(id)],
        className,
      )}
    >
      {initialsFor(label)}
    </span>
  );
}
