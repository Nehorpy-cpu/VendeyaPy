import { describe, it, expect, vi } from 'vitest';
import { derivarPorDerivaCritica, mensajeDeriva, type DerivarPorDerivaDeps } from './driftHandoff.js';
import type { VeredictoDeriva } from '../catalog/driftGuard.js';
import type { Seller, CheckoutConfig } from '@vpw/shared';

/**
 * ADR-0015 §8 — derivación por deriva crítica con el servicio CANÓNICO (razón `catalog_drift`),
 * aviso idempotente y CERO afirmaciones de precio. Vendedores y productos genéricos: nada
 * hardcodeado de ningún rubro.
 */
const vend = (name: string, active = true): Seller => ({ name, whatsapp: '+595000000000', active });
const deps = (over: Partial<DerivarPorDerivaDeps> = {}): DerivarPorDerivaDeps => ({
  getConfig: async () => ({ bankAccounts: [], sellers: [vend('Vendedora Uno'), vend('Vendedor Dos')] }) as CheckoutConfig,
  handoff: vi.fn(async () => ({ ok: true, already: false })),
  notify: vi.fn(async () => true),
  getAssignedSellerName: async () => null,
  ...over,
});

const VEREDICTO: VeredictoDeriva = {
  bloqueantes: [{ productId: 'p1', productName: 'Producto Uno', reason: 'drifted_external', fields: ['price'] }],
  advertencias: [],
};

describe('conversation/driftHandoff derivarPorDerivaCritica', () => {
  it('persiste el handoff catalog_drift con sourceId de la DERIVA + aviso + respuesta post-persistencia', async () => {
    const d = deps();
    const r = await derivarPorDerivaCritica('t1', '595000005678', VEREDICTO, { messageId: 'wamid.D1' }, d);
    expect(r.takeover).toBe(true);
    expect(r.reply).toContain('Te paso con Vendedora Uno');
    expect(d.handoff).toHaveBeenCalledWith('t1', '595000005678', expect.objectContaining({
      reason: 'catalog_drift',
      sellerName: 'Vendedora Uno',
      sourceId: 'deriva-p1', // la DERIVA es el evento, no el mensaje
      createSessionIfMissing: true,
    }));
    expect(d.notify).toHaveBeenCalledWith('t1', '595000005678', 'Vendedora Uno', 'deriva-p1', 'catalog_drift');
  });

  it('el mensaje al cliente NO cotiza, no promete stock y no menciona sistemas internos', () => {
    for (const vendedor of ['Vendedora Uno', null]) {
      const m = mensajeDeriva(['Producto Uno'], vendedor);
      expect(m).not.toMatch(/\d/); // ni un número: jamás un precio "definitivo"
      expect(m).not.toMatch(/meta|feed|catálogo externo|sync|drift|deriva/i);
      expect(m).toMatch(/confirmar/i);
      expect(m).toContain('carrito queda guardado'); // el carrito se conserva
    }
  });

  it('idempotencia: el mismo producto genera el MISMO sourceId aunque cambie el mensaje entrante', async () => {
    const d = deps();
    await derivarPorDerivaCritica('t1', '595000005678', VEREDICTO, { messageId: 'wamid.A' }, d);
    await derivarPorDerivaCritica('t1', '595000005678', VEREDICTO, { messageId: 'wamid.B' }, d);
    const ids = vi.mocked(d.notify).mock.calls.map((c) => c[3]);
    expect(ids[0]).toBe(ids[1]); // el create() determinístico dedupea el aviso
  });

  it('varios productos ⇒ sourceId estable e independiente del orden en que llegaron', async () => {
    const d = deps();
    const orden1: VeredictoDeriva = { bloqueantes: [VEREDICTO.bloqueantes[0]!, { productId: 'p2', productName: 'Dos', reason: 'stale', fields: ['price'] }], advertencias: [] };
    const orden2: VeredictoDeriva = { bloqueantes: [orden1.bloqueantes[1]!, orden1.bloqueantes[0]!], advertencias: [] };
    await derivarPorDerivaCritica('t1', '595000005678', orden1, {}, d);
    await derivarPorDerivaCritica('t1', '595000005678', orden2, {}, d);
    const ids = vi.mocked(d.notify).mock.calls.map((c) => c[3]);
    expect(ids[0]).toBe('deriva-p1-p2');
    expect(ids[1]).toBe('deriva-p1-p2');
  });

  it('ya en takeover (turno repetido / carrera) ⇒ silencio y CERO re-aviso', async () => {
    const d = deps({ handoff: vi.fn(async () => ({ ok: true, already: true })) });
    const r = await derivarPorDerivaCritica('t1', '595000005678', VEREDICTO, {}, d);
    expect(r).toEqual({ takeover: true, reply: '' });
    expect(d.notify).not.toHaveBeenCalled();
  });

  it('sin vendedor activo ⇒ honestidad sin promesa, sin takeover, PERO el equipo se entera', async () => {
    for (const sellers of [[], [vend('X', false)], [vend('REEMPLAZAR-Vendedor')]]) {
      const d = deps({ getConfig: async () => ({ bankAccounts: [], sellers }) as CheckoutConfig });
      const r = await derivarPorDerivaCritica('t1', '595000005678', VEREDICTO, {}, d);
      expect(r.takeover).toBe(false);
      expect(r.reply).not.toMatch(/te paso con/i);
      expect(r.reply).not.toMatch(/\d/);
      expect(d.handoff).not.toHaveBeenCalled();
      expect(d.notify).toHaveBeenCalledWith('t1', '595000005678', null, 'deriva-p1', 'catalog_drift');
    }
  });

  it('fallo de persistencia ⇒ jamás "te paso con…" y jamás un precio', async () => {
    const d = deps({ handoff: vi.fn(async () => ({ ok: false, already: false })) });
    const r = await derivarPorDerivaCritica('t1', '595000005678', VEREDICTO, {}, d);
    expect(r.takeover).toBe(false);
    expect(r.reply).not.toMatch(/te paso con/i);
    expect(d.notify).not.toHaveBeenCalled();
  });

  it('una excepción real (config/transacción) no revienta el turno', async () => {
    const d = deps({ getConfig: vi.fn(async () => { throw new Error('firestore unavailable'); }) as unknown as DerivarPorDerivaDeps['getConfig'] });
    const r = await derivarPorDerivaCritica('t1', '595000005678', VEREDICTO, {}, d);
    expect(r.takeover).toBe(false);
    expect(r.reply).toMatch(/confirmar/i);
  });

  it('simulación (chat de prueba): mismo texto, CERO efectos operativos', async () => {
    const d = deps();
    const r = await derivarPorDerivaCritica('t1', '595000005678', VEREDICTO, { simulation: true }, d);
    expect(r.takeover).toBe(true);
    expect(d.handoff).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
  });

  it('veredicto sin bloqueantes ⇒ no hay nada que derivar (cero efectos)', async () => {
    const d = deps();
    const r = await derivarPorDerivaCritica('t1', '595000005678', { bloqueantes: [], advertencias: [] }, {}, d);
    expect(r).toEqual({ takeover: false, reply: '' });
    expect(d.handoff).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
  });

  it('el vendedor sale SOLO de la config del tenant recibido (aislamiento por diseño)', async () => {
    const getConfig = vi.fn(async (tenantId: string) => ({ bankAccounts: [], sellers: [vend(`Vendedor de ${tenantId}`)] }) as CheckoutConfig);
    const d = deps({ getConfig: getConfig as unknown as DerivarPorDerivaDeps['getConfig'] });
    const r = await derivarPorDerivaCritica('tenant-a', '595000005678', VEREDICTO, {}, d);
    expect(getConfig).toHaveBeenCalledWith('tenant-a');
    expect(r.reply).toContain('Vendedor de tenant-a');
  });

  it('reutiliza el vendedor ASIGNADO si sigue activo', async () => {
    const d = deps({ getAssignedSellerName: async () => 'Vendedor Dos' });
    expect((await derivarPorDerivaCritica('t1', '595000005678', VEREDICTO, {}, d)).reply).toContain('Vendedor Dos');
  });
});
