import { describe, it, expect } from 'vitest';
import { newId, isValidId, getPrefix, ID_PREFIX, newOrderId, newTenantId } from './ids.js';

describe('ids', () => {
  it('genera IDs con el prefijo correcto', () => {
    const id = newId(ID_PREFIX.ORDER);
    expect(id).toMatch(/^ord_[0-9a-zA-Z]{12}$/);
  });

  it('genera IDs únicos en llamadas sucesivas', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newOrderId()));
    expect(ids.size).toBe(1000);
  });

  it('valida correctamente un ID bien formado', () => {
    const id = newTenantId();
    expect(isValidId(id, ID_PREFIX.TENANT)).toBe(true);
  });

  it('rechaza ID con prefijo incorrecto', () => {
    const id = newOrderId();
    expect(isValidId(id, ID_PREFIX.TENANT)).toBe(false);
  });

  it('rechaza ID con caracteres inválidos', () => {
    expect(isValidId('ord_!!!aaa12345', ID_PREFIX.ORDER)).toBe(false);
  });

  it('rechaza ID con longitud incorrecta', () => {
    expect(isValidId('ord_abc', ID_PREFIX.ORDER)).toBe(false);
  });

  it('extrae el prefijo correctamente', () => {
    expect(getPrefix('ord_abc123def456')).toBe('ord');
    expect(getPrefix('invalid')).toBe(null);
  });

  it('SHIPPING-CHAT-3C: quoteAttemptId con prefijo qat propio (jamás reutiliza checkoutAttemptId)', async () => {
    const { newQuoteAttemptId } = await import('./ids.js');
    const id = newQuoteAttemptId();
    expect(id).toMatch(/^qat_[0-9a-zA-Z]{12}$/);
    expect(id.startsWith('atm_')).toBe(false);
    expect(id.startsWith('pay_')).toBe(false);
  });
});
