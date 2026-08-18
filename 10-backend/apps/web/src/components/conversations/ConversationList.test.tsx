/**
 * ConversationList.test.tsx — filtros de la bandeja (ADR-0021 §3 + UX normativa).
 * Por defecto las archivadas y eliminadas NO aparecen; sus chips dedicados las muestran para
 * restaurar. Cada filtro vacío tiene un mensaje útil, y el buscador es client-side.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Customer } from '@vpw/shared';
import { ConversationList } from './ConversationList';

function conv(id: string, name: string, meta: Record<string, unknown> = {}, over: Record<string, unknown> = {}): Customer {
  return {
    id,
    tenantId: 't1',
    whatsappPhone: '+595981' + id,
    name,
    conversation: {
      lastMessageAt: null,
      lastMessagePreview: 'último mensaje de ' + name,
      lastMessageDirection: 'in',
      state: null,
      humanTakeover: false,
      unreadForSeller: 0,
      ...meta,
    },
    ...over,
  } as unknown as Customer;
}

const LISTA = [
  conv('1', 'Carla Activa'),
  conv('2', 'Nora NoLeida', { unreadForSeller: 2 }),
  conv('3', 'Aldo Archivado', { archived: true }),
  conv('4', 'Elsa Eliminada', { softDeleted: true }),
];

function renderLista(over: Partial<Parameters<typeof ConversationList>[0]> = {}) {
  return render(
    <ConversationList
      convs={LISTA}
      loading={false}
      error={false}
      selectedId={null}
      uid="yo"
      multiNumber={false}
      numberLabel={(p) => p}
      onSelect={vi.fn()}
      {...over}
    />,
  );
}

describe('ConversationList — filtros', () => {
  it('por defecto muestra activas y OCULTA archivadas y eliminadas', () => {
    renderLista();
    expect(screen.getByText('Carla Activa')).toBeInTheDocument();
    expect(screen.getByText('Nora NoLeida')).toBeInTheDocument();
    expect(screen.queryByText('Aldo Archivado')).not.toBeInTheDocument();
    expect(screen.queryByText('Elsa Eliminada')).not.toBeInTheDocument();
  });

  it('chip «No leídas» deja solo las de unreadForSeller > 0', () => {
    renderLista();
    fireEvent.click(screen.getByRole('button', { name: 'No leídas' }));
    expect(screen.getByText('Nora NoLeida')).toBeInTheDocument();
    expect(screen.queryByText('Carla Activa')).not.toBeInTheDocument();
  });

  it('chip «Archivadas» muestra SOLO las archivadas', () => {
    renderLista();
    fireEvent.click(screen.getByRole('button', { name: 'Archivadas' }));
    expect(screen.getByText('Aldo Archivado')).toBeInTheDocument();
    expect(screen.queryByText('Carla Activa')).not.toBeInTheDocument();
    expect(screen.queryByText('Elsa Eliminada')).not.toBeInTheDocument();
  });

  it('chip «Eliminadas» muestra SOLO las eliminadas, con su badge', () => {
    renderLista();
    fireEvent.click(screen.getByRole('button', { name: 'Eliminadas' }));
    expect(screen.getByText('Elsa Eliminada')).toBeInTheDocument();
    expect(screen.getByText('Eliminada')).toBeInTheDocument(); // badge del item
    expect(screen.queryByText('Carla Activa')).not.toBeInTheDocument();
  });

  it('cada filtro vacío tiene un mensaje útil (no un hueco)', () => {
    renderLista({ convs: [conv('1', 'Carla Activa')] });
    fireEvent.click(screen.getByRole('button', { name: 'Eliminadas' }));
    expect(screen.getByText('No hay conversaciones eliminadas.')).toBeInTheDocument();
  });

  it('el buscador filtra por nombre y muestra vacío honesto sin coincidencias', () => {
    renderLista();
    const input = screen.getByPlaceholderText(/buscar por nombre/i);
    fireEvent.change(input, { target: { value: 'nora' } });
    expect(screen.getByText('Nora NoLeida')).toBeInTheDocument();
    expect(screen.queryByText('Carla Activa')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'zzz-nadie' } });
    expect(screen.getByText(/ninguna conversación coincide/i)).toBeInTheDocument();
  });

  it('badge de no leídos accesible con el conteo', () => {
    renderLista();
    expect(screen.getByLabelText('2 mensajes sin leer')).toBeInTheDocument();
  });

  it('con UN solo mensaje el badge usa singular («1 mensaje sin leer»)', () => {
    renderLista({ convs: [conv('9', 'Uno Pendiente', { unreadForSeller: 1 })] });
    expect(screen.getByLabelText('1 mensaje sin leer')).toBeInTheDocument();
    expect(screen.queryByLabelText('1 mensajes sin leer')).not.toBeInTheDocument();
  });

  it('elegir una conversación notifica al padre con el id', () => {
    const onSelect = vi.fn();
    renderLista({ onSelect });
    fireEvent.click(screen.getByText('Carla Activa'));
    expect(onSelect).toHaveBeenCalledWith('1');
  });

  it('estados de carga y error visibles', () => {
    const { unmount } = renderLista({ convs: [], loading: true });
    expect(screen.getByRole('status', { name: /cargando conversaciones/i })).toBeInTheDocument();
    unmount();
    renderLista({ convs: [], error: true });
    expect(screen.getByRole('alert')).toHaveTextContent(/no se pudieron cargar/i);
  });
});
