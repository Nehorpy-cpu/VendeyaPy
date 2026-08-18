/**
 * MessageHistory.test.tsx — separadores de fecha (Hoy/Ayer/fecha es-PY) y paginación hacia
 * atrás («Ver mensajes anteriores»). El scroll fino no se puede medir en jsdom; acá se fija el
 * CONTRATO renderizado: qué separadores aparecen y cuándo se ofrece cargar más.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Message } from '@vpw/shared';
import { MessageHistory } from './MessageHistory';

const ts = (d: Date) => ({ toDate: () => d, toMillis: () => d.getTime() }) as unknown as Message['createdAt'];

function msg(id: string, date: Date, over: Partial<Message> = {}): Message {
  return {
    id,
    tenantId: 't1',
    customerId: 'c1',
    direction: 'in',
    author: 'customer',
    text: 'texto ' + id,
    createdAt: ts(date),
    ...over,
  } as Message;
}

function renderHistorial(messages: Message[], over: Partial<Parameters<typeof MessageHistory>[0]> = {}) {
  return render(
    <MessageHistory
      tenantId="t1"
      messages={messages}
      loading={false}
      hasMore={false}
      loadingOlder={false}
      olderError={null}
      onLoadOlder={vi.fn()}
      scrollToEndSignal={0}
      attachmentsById={new Map()}
      attachmentsLoading={false}
      attachmentsFailed={false}
      onRetryAttachments={vi.fn()}
      role="SELLER"
      orders={[]}
      onAttachmentChanged={vi.fn()}
      {...over}
    />,
  );
}

describe('separadores de fecha', () => {
  it('mensajes de hoy, ayer y un día viejo ⇒ Hoy / Ayer / fecha es-PY', () => {
    const hoy = new Date();
    const ayer = new Date(hoy);
    ayer.setDate(ayer.getDate() - 1);
    const viejo = new Date(hoy);
    viejo.setDate(viejo.getDate() - 30);

    renderHistorial([msg('m1', viejo), msg('m2', ayer), msg('m3', hoy)]);

    expect(screen.getByText('Hoy')).toBeInTheDocument();
    expect(screen.getByText('Ayer')).toBeInTheDocument();
    expect(
      screen.getByText(viejo.toLocaleDateString('es-PY', { day: 'numeric', month: 'long', year: 'numeric' })),
    ).toBeInTheDocument();
  });

  it('dos mensajes del MISMO día ⇒ UN solo separador', () => {
    const hoy = new Date();
    renderHistorial([msg('m1', hoy), msg('m2', hoy)]);
    expect(screen.getAllByText('Hoy')).toHaveLength(1);
  });

  it('sin mensajes ⇒ estado vacío honesto', () => {
    renderHistorial([]);
    expect(screen.getByText('Sin mensajes.')).toBeInTheDocument();
  });

  it('cargando ⇒ estado visible', () => {
    renderHistorial([], { loading: true });
    expect(screen.getByRole('status')).toHaveTextContent(/cargando mensajes/i);
  });
});

describe('paginación hacia atrás', () => {
  it('con hasMore ofrece «Ver mensajes anteriores» y delega en onLoadOlder', () => {
    const onLoadOlder = vi.fn();
    renderHistorial([msg('m1', new Date())], { hasMore: true, onLoadOlder });
    const btn = screen.getByRole('button', { name: /ver mensajes anteriores/i });
    fireEvent.click(btn);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('mientras carga la página anterior el botón queda deshabilitado', () => {
    renderHistorial([msg('m1', new Date())], { hasMore: true, loadingOlder: true });
    expect(screen.getByRole('button', { name: /cargando/i })).toBeDisabled();
  });

  it('sin hasMore NO se ofrece el botón (no se promete lo que no hay)', () => {
    renderHistorial([msg('m1', new Date())]);
    expect(screen.queryByRole('button', { name: /ver mensajes anteriores/i })).not.toBeInTheDocument();
  });

  it('el error de paginación se dice con reintento posible (el botón sigue)', () => {
    renderHistorial([msg('m1', new Date())], { hasMore: true, olderError: 'No se pudieron cargar los mensajes anteriores. Probá de nuevo.' });
    expect(screen.getByRole('alert')).toHaveTextContent(/no se pudieron cargar/i);
    expect(screen.getByRole('button', { name: /ver mensajes anteriores/i })).toBeInTheDocument();
  });
});
