import { describe, it, expect } from 'vitest';
import {
  UNPAID_STATUSES, OPERATIVE_STATUSES, TERMINAL_STATUSES, PAID_ORDER_STATUSES,
  canTenantEdit, canTenantCancel, canAdvanceStatus, isTerminal, isPaidStatus,
} from './lifecycle.js';
import { ORDER_STATUS, type OrderStatus } from '@vpw/shared';

/**
 * ORDER-1: máquina de estados del ciclo de vida de pedidos. Invariantes:
 * el tenant edita/cancela SOLO sin pagar; el staff solo avanza hacia adelante;
 * pagado/enviado/entregado = registro permanente.
 */
describe('orders/lifecycle — grupos de estados', () => {
  it('los 3 grupos cubren exactamente los 9 estados, sin solaparse', () => {
    const all = [...UNPAID_STATUSES, ...OPERATIVE_STATUSES, ...TERMINAL_STATUSES].sort();
    expect(all).toEqual([...ORDER_STATUS].sort());
    expect(new Set(all).size).toBe(ORDER_STATUS.length);
  });

  it('PAID_ORDER_STATUSES = venta concretada (PAID..DELIVERED)', () => {
    expect(PAID_ORDER_STATUSES).toEqual(['PAID', 'PREPARING', 'ASSIGNED', 'IN_TRANSIT', 'DELIVERED']);
    expect(isPaidStatus('PAID')).toBe(true);
    expect(isPaidStatus('DELIVERED')).toBe(true);
    expect(isPaidStatus('PENDING_PAYMENT')).toBe(false);
    expect(isPaidStatus('CANCELLED')).toBe(false);
  });
});

describe('orders/lifecycle — permisos del tenant', () => {
  it('editar/cancelar SOLO en UNPAID', () => {
    for (const s of UNPAID_STATUSES) {
      expect(canTenantEdit(s)).toBe(true);
      expect(canTenantCancel(s)).toBe(true);
    }
    for (const s of [...OPERATIVE_STATUSES, ...TERMINAL_STATUSES]) {
      expect(canTenantEdit(s)).toBe(false);
      expect(canTenantCancel(s)).toBe(false);
    }
  });

  it('isTerminal: DELIVERED/CANCELLED/REFUNDED', () => {
    expect(isTerminal('DELIVERED')).toBe(true);
    expect(isTerminal('CANCELLED')).toBe(true);
    expect(isTerminal('REFUNDED')).toBe(true);
    expect(isTerminal('PAID')).toBe(false);
  });
});

describe('orders/lifecycle — canAdvanceStatus (forward-only)', () => {
  it('UNPAID → PAID permitido (confirmación de pago)', () => {
    expect(canAdvanceStatus('PENDING_PAYMENT', 'PAID')).toBe(true);
    expect(canAdvanceStatus('PENDING_VERIFICATION', 'PAID')).toBe(true);
  });

  it('cadena operativa hacia adelante, con saltos', () => {
    expect(canAdvanceStatus('PAID', 'PREPARING')).toBe(true);
    expect(canAdvanceStatus('PREPARING', 'ASSIGNED')).toBe(true);
    expect(canAdvanceStatus('ASSIGNED', 'IN_TRANSIT')).toBe(true);
    expect(canAdvanceStatus('IN_TRANSIT', 'DELIVERED')).toBe(true);
    expect(canAdvanceStatus('PAID', 'DELIVERED')).toBe(true); // salto forward (negocio sin tracking)
  });

  it('NUNCA retrocesos', () => {
    expect(canAdvanceStatus('DELIVERED', 'PAID')).toBe(false);
    expect(canAdvanceStatus('IN_TRANSIT', 'PREPARING')).toBe(false);
    expect(canAdvanceStatus('PAID', 'PENDING_PAYMENT')).toBe(false);
  });

  it('NUNCA hacia CANCELLED/REFUNDED (van por orderCancel/admin) ni desde terminales', () => {
    for (const from of ORDER_STATUS as readonly OrderStatus[]) {
      expect(canAdvanceStatus(from, 'CANCELLED')).toBe(false);
      expect(canAdvanceStatus(from, 'REFUNDED')).toBe(false);
    }
    expect(canAdvanceStatus('CANCELLED', 'PAID')).toBe(false);
    expect(canAdvanceStatus('REFUNDED', 'PAID')).toBe(false);
    expect(canAdvanceStatus('DELIVERED', 'DELIVERED')).toBe(false); // no-op no es transición
  });

  it('UNPAID no salta a estados operativos sin pasar por PAID', () => {
    expect(canAdvanceStatus('PENDING_PAYMENT', 'PREPARING')).toBe(false);
    expect(canAdvanceStatus('PENDING_VERIFICATION', 'DELIVERED')).toBe(false);
  });
});
