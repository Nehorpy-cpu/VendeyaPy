/**
 * ShippingQuotePreview.test.tsx — SHIPPING-CHAT-2B + HARDEN-1
 * Estados visuales, aislamiento por conversación, doble-clic, unknown con evidencia, accesibilidad,
 * ausencia de PII/input numérico, y contrato del payload. Componente presentacional puro (props controladas).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ShippingQuotePreview } from './ShippingQuotePreview';
import type { ShippingDraftContext, ShippingSendState } from '@/lib/shippingQuote';

const RID = 'covr_abc123';

const baseCtx = (over: Partial<ShippingDraftContext> = {}): ShippingDraftContext => ({
  requestId: RID,
  status: 'pending_coverage_review',
  subtotalGs: 250000,
  locationFingerprint: 'loc:abc',
  cartFingerprint: 'cart:abc',
  expiresAtMs: 10_000,
  nowMs: 5_000,
  required: true,
  flowActive: true,
  canDecide: true,
  maxChargeGs: 5_000_000,
  draft: '',
  ...over,
});

function renderPreview(opts: {
  ctx?: Partial<ShippingDraftContext>;
  send?: ShippingSendState;
  onConfirm?: (p: unknown) => void;
  onKeepEditing?: () => void;
  onShortcut?: () => void;
  onReviewHistory?: () => void;
} = {}) {
  const onConfirm = opts.onConfirm ?? vi.fn();
  const onKeepEditing = opts.onKeepEditing ?? vi.fn();
  const onShortcut = opts.onShortcut ?? vi.fn();
  const onReviewHistory = opts.onReviewHistory ?? vi.fn();
  const utils = render(
    <ShippingQuotePreview
      context={baseCtx(opts.ctx)}
      send={opts.send ?? { status: 'idle' }}
      onConfirm={onConfirm}
      onKeepEditing={onKeepEditing}
      onShortcut={onShortcut}
      onReviewHistory={onReviewHistory}
    />,
  );
  return { ...utils, onConfirm, onKeepEditing, onShortcut, onReviewHistory };
}

describe('ShippingQuotePreview — costo detectado', () => {
  it('muestra envío, productos y total; y las dos acciones', () => {
    renderPreview({ ctx: { draft: 'el envío cuesta ₲30.000' } });
    expect(screen.getByText('₲ 30.000')).toBeInTheDocument();
    expect(screen.getByText('₲ 250.000')).toBeInTheDocument();
    expect(screen.getByText('₲ 280.000')).toBeInTheDocument();
    expect(screen.getByText(/El cliente recibirá exactamente/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /enviar costo y aprobar cobertura/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /seguir editando/i })).toBeInTheDocument();
  });

  it('envío gratis ⇒ ₲ 0 y total = productos', () => {
    renderPreview({ ctx: { draft: 'envío gratis' } });
    expect(screen.getByText('₲ 0')).toBeInTheDocument();
    expect(screen.getAllByText('₲ 250.000')).toHaveLength(2);
    expect(screen.getByText('Envío sin costo')).toBeInTheDocument();
  });
});

describe('ShippingQuotePreview — bloqueos del parser', () => {
  it('ambiguo ⇒ mensaje de bloqueo (role=alert) y sin botón de aprobar', () => {
    renderPreview({ ctx: { draft: 'el envío ₲30.000 o ₲40.000' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/un solo costo claro/i);
    expect(screen.queryByRole('button', { name: /aprobar cobertura/i })).toBeNull();
    expect(screen.getByRole('button', { name: /seguir editando/i })).toBeInTheDocument();
  });

  it('maxChargeGs inválido ⇒ error de configuración, sin aprobar', () => {
    renderPreview({ ctx: { draft: 'el envío ₲30.000', maxChargeGs: 0 } });
    expect(screen.getByRole('alert')).toHaveTextContent(/configuración del máximo/i);
    expect(screen.queryByRole('button', { name: /aprobar cobertura/i })).toBeNull();
  });

  it('idle/unrelated ⇒ solo el atajo y una guía, sin aprobar', () => {
    renderPreview({ ctx: { draft: 'hola, gracias' } });
    expect(screen.getByRole('button', { name: /informar costo de envío/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /aprobar cobertura/i })).toBeNull();
  });
});

describe('ShippingQuotePreview — sin input numérico editable (decisión 10)', () => {
  it('no hay input/textarea/spinbutton en el preview', () => {
    const { container } = renderPreview({ ctx: { draft: 'el envío cuesta ₲30.000' } });
    expect(container.querySelector('input,textarea')).toBeNull();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('ShippingQuotePreview — ciclo de envío', () => {
  it('enviando ⇒ acción bloqueada, sin botón habilitado', () => {
    renderPreview({ ctx: { draft: 'el envío cuesta ₲30.000' }, send: { status: 'sending', requestId: RID } });
    const btn = screen.getByRole('button', { name: /enviando y aprobando/i });
    expect(btn).toBeDisabled();
    expect(screen.queryByRole('button', { name: /enviar costo y aprobar cobertura/i })).toBeNull();
  });

  it('éxito ⇒ confirmación estable con envío y total del resultado', () => {
    renderPreview({
      ctx: { draft: 'el envío cuesta ₲30.000' },
      send: { status: 'sent', requestId: RID, shippingGs: 30000, totalGs: 280000, canonical: 'El costo de envío para tu ubicación es ₲30.000.' },
    });
    expect(screen.getByRole('status')).toHaveTextContent(/Le enviamos el costo al cliente y aprobamos la cobertura/);
    expect(screen.getByText('₲ 30.000')).toBeInTheDocument();
    expect(screen.getByText('₲ 280.000')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /enviar costo/i })).toBeNull();
  });

  it('rechazo de Meta ⇒ texto exacto + seguir editando', () => {
    renderPreview({ ctx: { draft: 'el envío cuesta ₲30.000' }, send: { status: 'error', requestId: RID, kind: 'meta_rejected' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/WhatsApp no aceptó el mensaje/);
    expect(screen.getByRole('button', { name: /seguir editando/i })).toBeInTheDocument();
  });

  it('carrito cambiado ⇒ pide recotizar', () => {
    renderPreview({ ctx: { draft: 'el envío cuesta ₲30.000' }, send: { status: 'error', requestId: RID, kind: 'cart_changed' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/El carrito cambió/);
  });

  it('ubicación cambiada ⇒ reabre y recotiza', () => {
    renderPreview({ ctx: { draft: 'el envío cuesta ₲30.000' }, send: { status: 'error', requestId: RID, kind: 'location_changed' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/cambió su ubicación/);
  });
});

describe('ShippingQuotePreview — HARDEN-1: unknown', () => {
  const unknownSend = (): ShippingSendState => ({
    status: 'unknown',
    requestId: RID,
    shippingGs: 30000,
    totalGs: 280000,
    canonical: 'El costo de envío para tu ubicación es ₲30.000.',
  });

  it('texto EXACTO, muestra canónico + envío + total', () => {
    renderPreview({ ctx: { draft: 'el envío cuesta ₲30.000' }, send: unknownSend() });
    expect(screen.getByRole('alert')).toHaveTextContent('No pudimos confirmar el envío. Revisá el historial antes de intentar otra acción.');
    const evid = screen.getByText(/Intentaste enviar/);
    expect(evid).toHaveTextContent(/El costo de envío para tu ubicación es ₲30.000/);
    expect(evid).toHaveTextContent(/Envío ₲ 30\.000/);
    expect(evid).toHaveTextContent(/Total ₲ 280\.000/);
  });

  it('ofrece ÚNICAMENTE "Revisar historial" (sin seguir editando ni reintento)', () => {
    renderPreview({ ctx: { draft: 'el envío cuesta ₲30.000' }, send: unknownSend() });
    expect(screen.getByRole('button', { name: /revisar historial/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /seguir editando/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /aprobar|enviar costo/i })).toBeNull();
  });

  it('"Revisar historial" dispara onReviewHistory una vez', () => {
    const onReviewHistory = vi.fn();
    renderPreview({ ctx: { draft: 'el envío cuesta ₲30.000' }, send: unknownSend(), onReviewHistory });
    fireEvent.click(screen.getByRole('button', { name: /revisar historial/i }));
    expect(onReviewHistory).toHaveBeenCalledTimes(1);
  });
});

describe('ShippingQuotePreview — HARDEN-1: aislamiento por conversación', () => {
  const otherRid = 'covr_OTHER';
  it('sending de OTRO request no aparece; se ve el preview del request actual', () => {
    renderPreview({ ctx: { draft: 'el envío cuesta ₲30.000' }, send: { status: 'sending', requestId: otherRid } });
    expect(screen.queryByText(/Enviando y aprobando/)).toBeNull();
    expect(screen.getByRole('button', { name: /enviar costo y aprobar cobertura/i })).toBeInTheDocument();
  });
  it('sent de OTRO request no aparece', () => {
    renderPreview({
      ctx: { draft: 'el envío cuesta ₲30.000' },
      send: { status: 'sent', requestId: otherRid, shippingGs: 30000, totalGs: 280000, canonical: 'x' },
    });
    expect(screen.queryByText(/Le enviamos el costo/)).toBeNull();
    expect(screen.getByRole('button', { name: /enviar costo y aprobar cobertura/i })).toBeInTheDocument();
  });
  it('unknown de OTRO request no aparece', () => {
    renderPreview({
      ctx: { draft: 'el envío cuesta ₲30.000' },
      send: { status: 'unknown', requestId: otherRid, shippingGs: 30000, totalGs: 280000, canonical: 'x' },
    });
    expect(screen.queryByText(/No pudimos confirmar el envío/)).toBeNull();
    expect(screen.getByRole('button', { name: /enviar costo y aprobar cobertura/i })).toBeInTheDocument();
  });
});

describe('ShippingQuotePreview — HARDEN-1: doble clic', () => {
  it('dos clics consecutivos ⇒ onConfirm exactamente una vez', () => {
    const onConfirm = vi.fn();
    renderPreview({ ctx: { draft: 'el envío cuesta ₲30.000' }, onConfirm });
    const btn = screen.getByRole('button', { name: /enviar costo y aprobar cobertura/i });
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('la guarda se reinicia al cambiar el borrador (nuevo payload ⇒ nuevo envío)', () => {
    const onConfirm = vi.fn();
    const { rerender } = renderPreview({ ctx: { draft: 'el envío cuesta ₲30.000' }, onConfirm });
    fireEvent.click(screen.getByRole('button', { name: /enviar costo y aprobar cobertura/i }));
    // el padre cambia el borrador (mismo request) → payload distinto → se permite otro envío
    rerender(
      <ShippingQuotePreview
        context={baseCtx({ draft: 'el envío cuesta ₲45.000' })}
        send={{ status: 'idle' }}
        onConfirm={onConfirm}
        onKeepEditing={vi.fn()}
        onShortcut={vi.fn()}
        onReviewHistory={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /enviar costo y aprobar cobertura/i }));
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(onConfirm).toHaveBeenLastCalledWith(expect.objectContaining({ confirmedShippingGs: 45000 }));
  });
});

describe('ShippingQuotePreview — gates', () => {
  it('vencido ⇒ aviso, sin acciones', () => {
    renderPreview({ ctx: { draft: 'el envío cuesta ₲30.000', nowMs: 20_000 } });
    expect(screen.getByRole('status')).toHaveTextContent(/venció/);
    expect(screen.queryByRole('button', { name: /aprobar cobertura|enviar costo/i })).toBeNull();
  });
  it('flujo apagado ⇒ no renderiza nada', () => {
    const { container } = renderPreview({ ctx: { flowActive: false, draft: 'el envío cuesta ₲30.000' } });
    expect(container).toBeEmptyDOMElement();
  });
  it('sin capacidad de decidir ⇒ no renderiza nada', () => {
    const { container } = renderPreview({ ctx: { canDecide: false, draft: 'el envío cuesta ₲30.000' } });
    expect(container).toBeEmptyDOMElement();
  });
  it('subtotal corrupto ⇒ muestra el mensaje (no queda huérfano) y no permite aprobar', () => {
    renderPreview({ ctx: { draft: 'el envío cuesta ₲30.000', subtotalGs: -100 } });
    expect(screen.getByRole('alert')).toHaveTextContent(/No pude calcular el total/);
    expect(screen.queryByRole('button', { name: /enviar costo y aprobar/i })).toBeNull();
  });
  it('el éxito PERSISTE aunque la revisión ya no esté pendiente (mismo request, status approved)', () => {
    renderPreview({
      ctx: { status: 'coverage_approved', draft: 'el envío cuesta ₲30.000' },
      send: { status: 'sent', requestId: RID, shippingGs: 30000, totalGs: 280000, canonical: 'El costo de envío para tu ubicación es ₲30.000.' },
    });
    expect(screen.getByRole('status')).toHaveTextContent(/Le enviamos el costo al cliente/);
  });
});

describe('ShippingQuotePreview — contrato, PII y accesibilidad', () => {
  it('el payload de confirmación no lleva customerId/actor/subtotal/total/PII', () => {
    const onConfirm = vi.fn();
    renderPreview({ ctx: { draft: 'el envío cuesta ₲30.000' }, onConfirm });
    fireEvent.click(screen.getByRole('button', { name: /enviar costo y aprobar cobertura/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith({
      requestId: RID,
      sellerDraft: 'el envío cuesta ₲30.000',
      expectedLocationFingerprint: 'loc:abc',
      expectedCartFingerprint: 'cart:abc',
      confirmedShippingGs: 30000,
    });
  });

  it('el DOM del preview no contiene dirección, coordenadas ni datos bancarios', () => {
    const { container } = renderPreview({ ctx: { draft: 'el envío cuesta ₲30.000' } });
    const txt = (container.textContent ?? '').toLowerCase();
    for (const banned of ['calle', 'av.', 'avenida', 'lat', 'lng', 'coordenad', 'transfer', 'cuenta', 'cbu', 'banco']) {
      expect(txt).not.toContain(banned);
    }
  });

  it('el botón de aprobar está descrito por el mensaje canónico (aria-describedby)', () => {
    renderPreview({ ctx: { draft: 'el envío cuesta ₲30.000' } });
    const btn = screen.getByRole('button', { name: /enviar costo y aprobar cobertura/i });
    const describedBy = btn.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const desc = document.getElementById(describedBy!);
    expect(desc).not.toBeNull();
    expect(within(desc!).getByText(/El cliente recibirá exactamente/i)).toBeInTheDocument();
  });

  it('el bloqueo describe el botón "seguir editando" (aria-describedby → alert)', () => {
    renderPreview({ ctx: { draft: 'el envío ₲30.000 o ₲40.000' } });
    const btn = screen.getByRole('button', { name: /seguir editando/i });
    const describedBy = btn.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveAttribute('role', 'alert');
  });
});

describe('ShippingQuotePreview — callbacks', () => {
  it('“Seguir editando” dispara onKeepEditing', () => {
    const onKeepEditing = vi.fn();
    renderPreview({ ctx: { draft: 'el envío cuesta ₲30.000' }, onKeepEditing });
    fireEvent.click(screen.getByRole('button', { name: /seguir editando/i }));
    expect(onKeepEditing).toHaveBeenCalledTimes(1);
  });

  it('“Informar costo de envío” dispara onShortcut (no escribe el composer)', () => {
    const onShortcut = vi.fn();
    renderPreview({ ctx: { draft: '' }, onShortcut });
    fireEvent.click(screen.getByRole('button', { name: /informar costo de envío/i }));
    expect(onShortcut).toHaveBeenCalledTimes(1);
  });
});
