'use client';

/**
 * markRead al ABRIR una conversación (ADR-0021): si tiene `unreadForSeller > 0`, se dispara
 * `conversationMarkRead` fire-and-forget (error silencioso pero LOGUEADO) y la lista se refleja
 * optimista en la caché — el polling del server confirma después.
 *
 * Extraído de la página para poder testearlo solo (¿se disparó? ¿una sola vez? ¿optimista?).
 */

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Customer } from '@vpw/shared';
import type { Role } from '@/lib/auth-context';
import { markConversationRead } from '@/lib/conversations';
import { puedeMarcarLeido } from '@/lib/conversationsUi';

export function useMarkRead(
  tenantId: string | null,
  customer: Customer | null,
  role: Role | null,
): void {
  const qc = useQueryClient();
  // Último contador que se intentó marcar, por conversación: si el cliente vuelve a escribir
  // (unread crece) se marca de nuevo; si el callable falla y el polling repite el MISMO contador,
  // NO se reintenta en bucle caliente.
  const ultimoIntento = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!tenantId || !customer) return;
    const unread = customer.conversation?.unreadForSeller ?? 0;
    if (unread <= 0) {
      ultimoIntento.current.delete(customer.id);
      return;
    }
    if (!puedeMarcarLeido(role)) return;
    if (ultimoIntento.current.get(customer.id) === unread) return;
    ultimoIntento.current.set(customer.id, unread);

    // Reflejo optimista en la lista: el contador se apaga al abrir, como espera el vendedor.
    qc.setQueryData<Customer[]>(['conversations', tenantId], (prev) =>
      prev?.map((c) =>
        c.id === customer.id && c.conversation
          ? { ...c, conversation: { ...c.conversation, unreadForSeller: 0 } }
          : c,
      ),
    );

    markConversationRead(tenantId, customer.id).catch((e) => {
      // Silencioso para el usuario (abrir el chat no puede fallar por esto), pero logueado.
      console.warn('[conversations] conversationMarkRead falló', e);
    });
  }, [tenantId, customer, role, qc]);
}
