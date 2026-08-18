/**
 * useMarkRead.test.tsx — markRead al ABRIR una conversación (ADR-0021):
 * se dispara con unread > 0, refleja el contador en 0 de forma optimista en la caché de la
 * lista, NO se repite en bucle con el mismo contador, y no dispara sin permiso ni sin unread.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Customer } from '@vpw/shared';
import type { Role } from '@/lib/auth-context';
import { useMarkRead } from './useMarkRead';

const markConversationRead = vi.fn();
vi.mock('@/lib/conversations', () => ({
  markConversationRead: (...a: unknown[]) => markConversationRead(...a),
}));

function cliente(unread: number, id = 'c1'): Customer {
  return {
    id,
    tenantId: 't1',
    whatsappPhone: '+595981',
    name: 'Cli',
    conversation: {
      lastMessageAt: null,
      lastMessagePreview: '',
      lastMessageDirection: 'in',
      state: null,
      humanTakeover: false,
      unreadForSeller: unread,
    },
  } as unknown as Customer;
}

function Probe({ customer, role }: { customer: Customer | null; role: Role | null }) {
  useMarkRead('t1', customer, role);
  return null;
}

function renderProbe(customer: Customer | null, role: Role | null = 'SELLER') {
  const qc = new QueryClient();
  qc.setQueryData<Customer[]>(['conversations', 't1'], [cliente(4)]);
  const utils = render(
    <QueryClientProvider client={qc}>
      <Probe customer={customer} role={role} />
    </QueryClientProvider>,
  );
  return { qc, ...utils };
}

beforeEach(() => {
  markConversationRead.mockReset();
  markConversationRead.mockResolvedValue({ ok: true });
});

describe('useMarkRead', () => {
  it('con unread > 0 dispara conversationMarkRead y apaga el contador en la lista (optimista)', async () => {
    const { qc } = renderProbe(cliente(4));
    await vi.waitFor(() => expect(markConversationRead).toHaveBeenCalledWith('t1', 'c1'));
    const lista = qc.getQueryData<Customer[]>(['conversations', 't1'])!;
    expect(lista[0]!.conversation!.unreadForSeller).toBe(0);
  });

  it('NO dispara con unread en 0', () => {
    renderProbe(cliente(0));
    expect(markConversationRead).not.toHaveBeenCalled();
  });

  it('NO dispara sin rol con permiso (VIEWER)', () => {
    renderProbe(cliente(4), 'TENANT_VIEWER');
    expect(markConversationRead).not.toHaveBeenCalled();
  });

  it('re-render con el MISMO contador no repite el callable (sin bucle con el polling)', async () => {
    const { rerender, qc } = renderProbe(cliente(4));
    await vi.waitFor(() => expect(markConversationRead).toHaveBeenCalledTimes(1));
    // El polling devuelve un objeto NUEVO con el mismo unread (el server aún no aplicó).
    rerender(
      <QueryClientProvider client={qc}>
        <Probe customer={cliente(4)} role="SELLER" />
      </QueryClientProvider>,
    );
    expect(markConversationRead).toHaveBeenCalledTimes(1);
  });

  it('si el cliente vuelve a escribir (unread crece) marca de nuevo', async () => {
    const { rerender, qc } = renderProbe(cliente(4));
    await vi.waitFor(() => expect(markConversationRead).toHaveBeenCalledTimes(1));
    rerender(
      <QueryClientProvider client={qc}>
        <Probe customer={cliente(6)} role="SELLER" />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(markConversationRead).toHaveBeenCalledTimes(2));
  });

  it('el fallo del callable es silencioso (logueado), nunca rompe la apertura del chat', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    markConversationRead.mockRejectedValueOnce(new Error('offline'));
    renderProbe(cliente(2));
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });
});
