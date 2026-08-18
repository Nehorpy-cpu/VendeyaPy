/**
 * CustomerInfoPanel.test.tsx — panel de info honesto (ADR-0021 §2):
 * teléfono SIEMPRE enmascarado, nombres etiquetados (CRM vs perfil de WhatsApp),
 * «Información no disponible» donde falte, y acciones de vínculo/asignación según matriz §7.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Customer } from '@vpw/shared';
import { CustomerInfoPanel } from './CustomerInfoPanel';

const libMock = vi.hoisted(() => ({
  getCustomer: vi.fn(),
  unlinkConversationClient: vi.fn(),
  assignConversation: vi.fn(),
  linkConversationClient: vi.fn(),
  createAndLinkClient: vi.fn(),
  searchCustomers: vi.fn(),
}));
vi.mock('@/lib/conversations', () => libMock);

function cliente(over: Partial<Customer> = {}): Customer {
  return {
    id: '595981123456',
    tenantId: 't1',
    whatsappPhone: '+595981123456',
    name: '',
    address: null,
    stats: { totalOrders: 0, totalSpent: 0, lastOrderAt: null, firstOrderAt: null },
    tags: [],
    notes: '',
    conversation: {
      lastMessageAt: null,
      lastMessagePreview: '',
      lastMessageDirection: null,
      state: null,
      humanTakeover: false,
      unreadForSeller: 0,
      channel: 'whatsapp',
    },
    ...over,
  } as unknown as Customer;
}

function renderPanel(c: Customer, over: Partial<Parameters<typeof CustomerInfoPanel>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CustomerInfoPanel
        tenantId="t1"
        customer={c}
        role="TENANT_MANAGER"
        uid="yo"
        userName="Marco"
        sellerOptions={[{ uid: 's1', name: 'Sofi' }]}
        onClose={vi.fn()}
        onChanged={vi.fn()}
        announce={vi.fn()}
        {...over}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.values(libMock).forEach((f) => f.mockReset());
});

describe('CustomerInfoPanel — datos honestos', () => {
  it('el teléfono aparece SOLO enmascarado (prefijo + últimos 3), nunca completo', () => {
    renderPanel(cliente());
    // Sin nombre, hasta el título del panel usa el teléfono ENMASCARADO (nunca el completo).
    expect(screen.getAllByText('+595••••456').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('+595981123456')).not.toBeInTheDocument();
  });

  it('etiqueta cuál nombre es CRM y cuál es el perfil de WhatsApp', () => {
    renderPanel(cliente({ name: 'María CRM', profileName: 'Mari 🌸' }));
    expect(screen.getByText('Nombre (CRM)')).toBeInTheDocument();
    expect(screen.getByText('Nombre de perfil (WhatsApp)')).toBeInTheDocument();
    // El nombre CRM aparece como título del panel Y como campo etiquetado.
    expect(screen.getAllByText('María CRM').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Mari 🌸')).toBeInTheDocument();
  });

  it('sin datos ⇒ «Información no disponible» (sin inventar nada)', () => {
    renderPanel(cliente());
    expect(screen.getAllByText('Información no disponible').length).toBeGreaterThanOrEqual(2);
  });

  it('las notas solo aparecen si existen', () => {
    const { unmount } = renderPanel(cliente());
    expect(screen.queryByText('Notas')).not.toBeInTheDocument();
    unmount();
    renderPanel(cliente({ notes: 'Prefiere entregas de tarde' }));
    expect(screen.getByText('Notas')).toBeInTheDocument();
    expect(screen.getByText('Prefiere entregas de tarde')).toBeInTheDocument();
  });

  it('métricas si existen; si no, texto honesto', () => {
    const { unmount } = renderPanel(cliente());
    expect(screen.getByText('Sin compras registradas todavía.')).toBeInTheDocument();
    unmount();
    renderPanel(cliente({ stats: { totalOrders: 3, totalSpent: 450000, lastOrderAt: null, firstOrderAt: null } }));
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText(/450\.000|450,000/)).toBeInTheDocument();
  });
});

describe('CustomerInfoPanel — matriz de permisos §7', () => {
  it('MANAGER ve vincular y asignar', () => {
    renderPanel(cliente());
    expect(screen.getByRole('button', { name: 'Vincular cliente' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /aplicar asignación/i })).toBeInTheDocument();
  });

  it('SELLER: sin vincular ni asignar (solo lectura del estado)', () => {
    renderPanel(cliente(), { role: 'SELLER' });
    expect(screen.queryByRole('button', { name: 'Vincular cliente' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /aplicar asignación/i })).not.toBeInTheDocument();
    expect(screen.getByText('Sin asignar')).toBeInTheDocument();
  });

  it('quitar vínculo pasa por ConfirmModal y llama al callable', async () => {
    libMock.getCustomer.mockResolvedValue(cliente({ id: 'crm_1', name: 'Ficha Canónica' }));
    libMock.unlinkConversationClient.mockResolvedValue({ ok: true });
    renderPanel(cliente({ linkedClientId: 'crm_1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Quitar vínculo' }));
    // Modal accesible con reversibilidad clara. El callable NO se llamó todavía.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/no se borra ningún dato/i)).toBeInTheDocument();
    expect(libMock.unlinkConversationClient).not.toHaveBeenCalled();
    // El botón de confirmar comparte etiqueta con el del panel: el del modal es el último.
    const botones = screen.getAllByRole('button', { name: 'Quitar vínculo' });
    fireEvent.click(botones[botones.length - 1]!);
    await vi.waitFor(() => expect(libMock.unlinkConversationClient).toHaveBeenCalledWith('t1', '595981123456'));
  });

  it('asignar: elegir vendedor y aplicar llama a assignConversation con el uid', async () => {
    libMock.assignConversation.mockResolvedValue({ ok: true, sellerName: 'Sofi' });
    renderPanel(cliente());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 's1' } });
    fireEvent.click(screen.getByRole('button', { name: /aplicar asignación/i }));
    await vi.waitFor(() => expect(libMock.assignConversation).toHaveBeenCalledWith('t1', '595981123456', 's1'));
  });
});
