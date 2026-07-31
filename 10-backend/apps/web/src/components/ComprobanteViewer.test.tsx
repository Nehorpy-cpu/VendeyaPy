/**
 * ComprobanteViewer.test.tsx — Tests frontend de ORDER-COMPROBANTE-VIEW-1.
 * Cubre: botón visible, click abre modal con imagen (URL temporal del callable),
 * errores de permisos/archivo mostrados sin romper la UI, y el helper comprobanteEstado
 * (pedido sin comprobante → sin botón; media:/simulado → 'pending' con texto seguro).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ComprobanteViewer } from './ComprobanteViewer';
import { comprobanteEstado } from '@/lib/orders';
import type { Order } from '@vpw/shared';

const getComprobanteViewUrl = vi.fn();
vi.mock('@/lib/orders', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/orders')>();
  return {
    ...real,
    getComprobanteViewUrl: (...a: unknown[]) => getComprobanteViewUrl(...a),
  };
});

const orderCon = (ref: string | null): Pick<Order, 'payment'> =>
  ({ payment: { method: 'BANCARD', paymentId: '', paidAt: null, comprobanteUrl: ref } }) as Pick<Order, 'payment'>;

describe('comprobanteEstado — qué muestra la UI', () => {
  it("pedido con foto en Storage → 'image' (botón Ver comprobante)", () => {
    expect(comprobanteEstado(orderCon('tenants/arfagi/orders/o1/comprobantes/x.jpg'))).toBe('image');
  });
  it("sin comprobante → 'none' (sin sección ni botón)", () => {
    expect(comprobanteEstado(orderCon(null))).toBe('none');
    expect(comprobanteEstado(orderCon(''))).toBe('none');
  });
  it("media:/simulado → 'pending' (texto seguro, sin botón)", () => {
    expect(comprobanteEstado(orderCon('media:MEDIA123'))).toBe('pending');
    expect(comprobanteEstado(orderCon('comprobante-simulado'))).toBe('pending');
  });
});

// ADR-0016: los tests de `esMensajeImagenCliente` se movieron —y se endurecieron— a
// `components/conversations/MessageBubble.test.tsx`: ahora NINGÚN texto, ni el que generaba
// nuestro backend, dibuja una tarjeta de adjunto. El único origen de verdad es `attachmentIds`.

describe('ComprobanteViewer', () => {
  beforeEach(() => getComprobanteViewUrl.mockReset());

  it('muestra el botón y al hacer click abre el modal con la imagen (URL temporal)', async () => {
    getComprobanteViewUrl.mockResolvedValueOnce({ url: 'https://firmada.example/comprobante.jpg', expiresAt: Date.now() + 600000 });
    render(<ComprobanteViewer tenantId="arfagi" orderId="ord_1" />);
    const btn = screen.getByRole('button', { name: /ver comprobante/i });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(screen.getByText(/comprobante recibido/i)).toBeInTheDocument(); // modal abierto
    await waitFor(() => expect(screen.getByAltText(/comprobante de pago/i)).toBeInTheDocument());
    expect((screen.getByAltText(/comprobante de pago/i) as HTMLImageElement).src).toContain('firmada.example');
    expect(getComprobanteViewUrl).toHaveBeenCalledWith('arfagi', 'ord_1');
    expect(screen.getByText(/enlace temporal y seguro/i)).toBeInTheDocument();
  });

  it('error del callable (permiso/archivo) → mensaje amable sin romper la UI', async () => {
    getComprobanteViewUrl.mockRejectedValueOnce({ code: 'functions/permission-denied', message: 'No tenés acceso a esta empresa.' });
    render(<ComprobanteViewer tenantId="arfagi" orderId="ord_1" />);
    fireEvent.click(screen.getByRole('button', { name: /ver comprobante/i }));
    await waitFor(() => expect(screen.getByText(/no tenés acceso/i)).toBeInTheDocument());
    expect(screen.queryByAltText(/comprobante de pago/i)).not.toBeInTheDocument();
    // El modal sigue operable: cerrar no explota.
    fireEvent.click(screen.getByRole('button', { name: /cerrar/i }));
    expect(screen.queryByText(/comprobante recibido/i)).not.toBeInTheDocument();
  });

  it('archivo inexistente → error claro del backend mostrado tal cual', async () => {
    getComprobanteViewUrl.mockRejectedValueOnce({ code: 'functions/not-found', message: 'El archivo del comprobante no se encontró en el almacenamiento.' });
    render(<ComprobanteViewer tenantId="arfagi" orderId="ord_2" />);
    fireEvent.click(screen.getByRole('button', { name: /ver comprobante/i }));
    await waitFor(() => expect(screen.getByText(/no se encontró/i)).toBeInTheDocument());
  });
});
