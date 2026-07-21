/**
 * ShippingQuotePreview.test.tsx — SHIPPING-CHAT-2B
 * Estados visuales, accesibilidad, ausencia de PII/input numérico, y contrato del payload de confirmación.
 * El componente es presentacional puro: sin Firebase, sin callables — se prueba con props controladas.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ShippingQuotePreview } from './ShippingQuotePreview';
import type { ShippingDraftContext, ShippingSendState } from '@/lib/shippingQuote';

const baseCtx = (over: Partial<ShippingDraftContext> = {}): ShippingDraftContext => ({
  requestId: 'covr_abc123',
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
} = {}) {
  const onConfirm = opts.onConfirm ?? vi.fn();
  const onKeepEditing = opts.onKeepEditing ?? vi.fn();
  const onShortcut = opts.onShortcut ?? vi.fn();
  const utils = render(
    <ShippingQuotePreview
      context={baseCtx(opts.ctx)}
      send={opts.send ?? { status: 'idle' }}
      onConfirm={onConfirm}
      onKeepEditing={onKeepEditing}
      onShortcut={onShortcut}
    />,
  );
  return { ...utils, onConfirm, onKeepEditing, onShortcut };
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
    // Productos y Total muestran ₲ 250.000 (envío 0 no cambia el total).
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
  it('enviando ⇒ acción bloqueada, sin botón habilitado (doble clic imposible)', () => {
    renderPreview({ ctx: { draft: 'el envío cuesta ₲30.000' }, send: { status: 'sending' } });
    expect(screen.getByText(/Enviando y aprobando…/)).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /enviando y aprobando/i });
    expect(btn).toBeDisabled();
    expect(screen.queryByRole('button', { name: /enviar costo y aprobar cobertura/i })).toBeNull();
  });

  it('éxito ⇒ confirmación estable con envío y total del resultado', () => {
    renderPreview({
      ctx: { draft: 'el envío cuesta ₲30.000' },
      send: { status: 'sent', shippingGs: 30000, totalGs: 280000, canonical: 'El costo de envío para tu ubicación es ₲30.000.' },
    });
    expect(screen.getByRole('status')).toHaveTextContent(/Le enviamos el costo al cliente y aprobamos la cobertura/);
    expect(screen.getByText('₲ 30.000')).toBeInTheDocument();
    expect(screen.getByText('₲ 280.000')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /enviar costo/i })).toBeNull();
  });

  it('rechazo de Meta ⇒ texto exacto + seguir editando', () => {
    renderPreview({ ctx: { draft: 'el envío cuesta ₲30.000' }, send: { status: 'error', kind: 'meta_rejected' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/WhatsApp no aceptó el mensaje/);
    expect(screen.getByRole('button', { name: /seguir editando/i })).toBeInTheDocument();
  });

  it('unknown ⇒ texto EXACTO, conserva canónico y total, sin reintento inmediato', () => {
    renderPreview({
      ctx: { draft: 'el envío cuesta ₲30.000' },
      send: { status: 'error', kind: 'unknown', canonical: 'El costo de envío para tu ubicación es ₲30.000.', totalGs: 280000 },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('No pudimos confirmar el envío. Revisá el historial antes de intentar otra acción.');
    expect(screen.getByText(/Intentaste enviar/)).toHaveTextContent(/El costo de envío para tu ubicación es ₲30.000/);
    expect(screen.getByText(/Intentaste enviar/)).toHaveTextContent(/280\.000/);
    // Sin reintento inmediato: no hay botón de "enviar/aprobar", solo "Seguir editando".
    expect(screen.queryByRole('button', { name: /aprobar|enviar costo/i })).toBeNull();
    expect(screen.getByRole('button', { name: /seguir editando/i })).toBeInTheDocument();
  });

  it('carrito cambiado ⇒ pide recotizar', () => {
    renderPreview({ ctx: { draft: 'el envío cuesta ₲30.000' }, send: { status: 'error', kind: 'cart_changed' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/El carrito cambió/);
  });

  it('ubicación cambiada ⇒ reabre y recotiza', () => {
    renderPreview({ ctx: { draft: 'el envío cuesta ₲30.000' }, send: { status: 'error', kind: 'location_changed' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/cambió su ubicación/);
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

  it('el éxito PERSISTE aunque la revisión ya no esté pendiente (status coverage_approved)', () => {
    renderPreview({
      ctx: { status: 'coverage_approved', draft: 'el envío cuesta ₲30.000' },
      send: { status: 'sent', shippingGs: 30000, totalGs: 280000, canonical: 'El costo de envío para tu ubicación es ₲30.000.' },
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
      requestId: 'covr_abc123',
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
