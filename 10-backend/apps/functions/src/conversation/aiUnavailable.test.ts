import { describe, it, expect, vi } from 'vitest';
import { derivarPorIaNoDisponible, type DerivarIaNoDisponibleDeps } from './aiUnavailable.js';
import type { Seller, CheckoutConfig } from '@vpw/shared';

/**
 * AI-FALLBACK-HONESTO-1: consulta que necesitaba IA + cuota agotada → derivación honesta con el
 * servicio canónico (razón ai_unavailable). Vendedores GENÉRICOS: nada hardcodeado.
 */
const vend = (name: string, active = true): Seller => ({ name, whatsapp: '+595000000000', active });
const deps = (over: Partial<DerivarIaNoDisponibleDeps> = {}): DerivarIaNoDisponibleDeps => ({
  getConfig: async () => ({ bankAccounts: [], sellers: [vend('Vendedora Uno'), vend('Vendedor Dos')] }) as CheckoutConfig,
  handoff: vi.fn(async () => ({ ok: true, already: false })),
  notify: vi.fn(async () => true),
  getAssignedSellerName: async () => null,
  ...over,
});

describe('conversation/aiUnavailable derivarPorIaNoDisponible', () => {
  it('3. persiste handoff ai_unavailable + vendedor de la config + notificación + respuesta post-persistencia', async () => {
    const d = deps();
    const r = await derivarPorIaNoDisponible('t1', '595000005678', { messageId: 'wamid.Q1' }, d);
    expect(r.takeover).toBe(true);
    expect(r.reply).toContain('Te paso con Vendedora Uno');
    expect(r.reply).not.toMatch(/token|límite|limite|plan|anthropic|error/i); // sin datos internos
    expect(d.handoff).toHaveBeenCalledWith('t1', '595000005678', expect.objectContaining({
      reason: 'ai_unavailable',
      sellerName: 'Vendedora Uno',
      sourceId: 'wamid.Q1',
      createSessionIfMissing: true,
    }));
    expect(d.notify).toHaveBeenCalledWith('t1', '595000005678', 'Vendedora Uno', 'wamid.Q1', 'ai_unavailable');
  });

  it('reutiliza el vendedor ASIGNADO si sigue activo', async () => {
    const d = deps({ getAssignedSellerName: async () => 'Vendedor Dos' });
    const r = await derivarPorIaNoDisponible('t1', '595000005678', {}, d);
    expect(r.reply).toContain('Vendedor Dos');
  });

  it('6/7. sin vendedor activo (inexistente/inactivo/placeholder) → honestidad sin promesa + aviso diario', async () => {
    for (const sellers of [[], [vend('X', false)], [vend('REEMPLAZAR-Vendedor')]]) {
      const d = deps({ getConfig: async () => ({ bankAccounts: [], sellers }) as CheckoutConfig });
      const r = await derivarPorIaNoDisponible('t1', '595000005678', { messageId: 'wamid.Q2' }, d);
      expect(r.takeover).toBe(false);
      expect(r.reply).not.toMatch(/te paso con/i);
      expect(d.handoff).not.toHaveBeenCalled();
      // Anti-flood: el aviso usa bucket por DÍA, no el wamid del mensaje.
      expect(d.notify).toHaveBeenCalledWith('t1', '595000005678', null, expect.stringMatching(/^sin-vendedor-/), 'ai_unavailable');
    }
  });

  it('9. fallo de persistencia → mensaje temporal honesto, jamás "te paso con…"', async () => {
    const d = deps({ handoff: vi.fn(async () => ({ ok: false, already: false })) });
    const r = await derivarPorIaNoDisponible('t1', '595000005678', {}, d);
    expect(r.takeover).toBe(false);
    expect(r.reply).not.toMatch(/te paso con/i);
    expect(d.notify).not.toHaveBeenCalled();
  });

  it('4/10. ya en takeover (wamid repetido/carrera) → silencio, sin re-aviso', async () => {
    const d = deps({ handoff: vi.fn(async () => ({ ok: true, already: true })) });
    const r = await derivarPorIaNoDisponible('t1', '595000005678', { messageId: 'wamid.Q3' }, d);
    expect(r).toEqual({ takeover: true, reply: '' });
    expect(d.notify).not.toHaveBeenCalled();
  });

  it('17. simulación (chat de prueba/test cases): mismo texto, CERO efectos operativos', async () => {
    const d = deps();
    const r = await derivarPorIaNoDisponible('t1', '595000005678', { messageId: 'wamid.Q4', simulation: true }, d);
    expect(r.takeover).toBe(true);
    expect(r.reply).toContain('Te paso con');
    expect(d.handoff).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
  });

  it('8/16. el vendedor sale SOLO de la config del tenant recibido (aislamiento por diseño)', async () => {
    const getConfig = vi.fn(async (tenantId: string) => ({ bankAccounts: [], sellers: [vend(`Vendedor de ${tenantId}`)] }) as CheckoutConfig);
    const d = deps({ getConfig: getConfig as unknown as DerivarIaNoDisponibleDeps['getConfig'] });
    const r = await derivarPorIaNoDisponible('tenant-a', '595000005678', {}, d);
    expect(getConfig).toHaveBeenCalledWith('tenant-a');
    expect(r.reply).toContain('Vendedor de tenant-a');
  });
});

describe('conversation/aiUnavailable — fixes del review', () => {
  it('REVIEW: acks/cortesía puros no son consulta derivable; las consultas reales sí', async () => {
    const { esConsultaDerivable } = await import('./aiUnavailable.js');
    expect(esConsultaDerivable('gracias')).toBe(false);
    expect(esConsultaDerivable('ok gracias')).toBe(false);
    expect(esConsultaDerivable('muchas gracias por todo')).toBe(false);
    expect(esConsultaDerivable('genial')).toBe(false);
    expect(esConsultaDerivable('¿hacen envíos al interior?')).toBe(true);
    expect(esConsultaDerivable('quiero un perfume para regalar')).toBe(true);
    expect(esConsultaDerivable('gracias! y hacen envios?')).toBe(true);
  });

  it('REVIEW: una excepción real (config/transacción) → mensaje temporal honesto, jamás throw', async () => {
    const d = deps({ getConfig: vi.fn(async () => { throw new Error('firestore unavailable'); }) as unknown as DerivarIaNoDisponibleDeps['getConfig'] });
    const r = await derivarPorIaNoDisponible('t1', '595000005678', {}, d);
    expect(r.takeover).toBe(false);
    expect(r.reply).toContain('no puedo completar esta consulta');
    expect(r.reply).not.toMatch(/te paso con/i);
  });

  it('REVIEW anti-flood: sin vendedor, el aviso usa bucket por DÍA (no por wamid)', async () => {
    const notify = vi.fn(async () => true);
    const d = deps({ getConfig: async () => ({ bankAccounts: [], sellers: [] }) as CheckoutConfig, notify });
    await derivarPorIaNoDisponible('t1', '595000005678', { messageId: 'wamid.A' }, d);
    await derivarPorIaNoDisponible('t1', '595000005678', { messageId: 'wamid.B' }, d);
    const sourceIds = notify.mock.calls.map((c) => c[3]);
    expect(sourceIds[0]).toBe(sourceIds[1]); // mismo bucket diario → el create() dedupea
    expect(sourceIds[0]).toMatch(/^sin-vendedor-\d{4}-\d{2}-\d{2}$/);
  });
});
