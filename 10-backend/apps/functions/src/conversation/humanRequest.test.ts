import { describe, it, expect, vi } from 'vitest';
import {
  esPosiblePedidoHumano,
  detectarPedidoHumano,
  resolverVendedor,
  procesarPedidoHumano,
  type ProcesarPedidoHumanoDeps,
} from './humanRequest.js';
import type { Seller, CheckoutConfig } from '@vpw/shared';

/**
 * HANDOFF-2: el bug de prod — "Quiero hablar con Aaron Sosa nuevamente" fue a la IA, que
 * prometió el pase sin ejecutar nada (humanTakeover quedó false). Catálogo de vendedores
 * GENÉRICO: la lógica no conoce nombres ni tenants.
 */

const vend = (name: string, active = true): Seller => ({ name, whatsapp: '+595000000000', active });
const SELLERS = [vend('Aaron Sosa'), vend('Marta Riquelme')];
const NOMBRES = SELLERS.map((s) => s.name);

describe('conversation/humanRequest esPosiblePedidoHumano / detectarPedidoHumano', () => {
  it('1. solicitud genérica de humano', () => {
    expect(detectarPedidoHumano('quiero hablar con una persona', NOMBRES)).toEqual({ tipo: 'generico' });
    expect(detectarPedidoHumano('quiero hablar con un vendedor', NOMBRES)).toEqual({ tipo: 'generico' });
    expect(detectarPedidoHumano('pasame con alguien', NOMBRES)).toEqual({ tipo: 'generico' });
    expect(detectarPedidoHumano('¿puedo hablar con un asesor?', NOMBRES)).toEqual({ tipo: 'generico' });
  });

  it('2. solicitud por nombre configurado', () => {
    expect(detectarPedidoHumano('quiero hablar con Aaron Sosa', NOMBRES)).toEqual({
      tipo: 'nombre',
      vendedoresQueMatchean: ['Aaron Sosa'],
    });
    expect(detectarPedidoHumano('Quiero hablar nuevamente con Aaron Sosa', NOMBRES)).toEqual({
      tipo: 'nombre',
      vendedoresQueMatchean: ['Aaron Sosa'],
    });
  });

  it('4. tildes, mayúsculas y puntuación no rompen la detección', () => {
    expect(detectarPedidoHumano('¡QUIERO HABLAR CON AARÓN!', NOMBRES)?.tipo).toBe('nombre');
    expect(detectarPedidoHumano('quisiera   hablar, con una persona...', NOMBRES)?.tipo).toBe('generico');
  });

  it('5. frases negativas NO activan handoff', () => {
    expect(detectarPedidoHumano('no necesito hablar con un vendedor', NOMBRES)).toBeNull();
    expect(detectarPedidoHumano('no quiero que me pases con nadie', NOMBRES)).toBeNull();
    expect(detectarPedidoHumano('tampoco quiero hablar con una persona', NOMBRES)).toBeNull();
  });

  it('5b. mención del nombre SIN solicitud de contacto NO activa', () => {
    expect(detectarPedidoHumano('¿Aaron Sosa confirmó mi pago?', NOMBRES)).toBeNull();
    expect(detectarPedidoHumano('el pedido me lo vendió Marta', NOMBRES)).toBeNull();
  });

  it('6. nombre propio NO configurado → desconocido (nunca elegir a otro en silencio)', () => {
    expect(detectarPedidoHumano('quiero hablar con Juancho Pérez', NOMBRES)).toEqual({
      tipo: 'desconocido',
      nombre: 'Juancho Pérez',
    });
  });

  it('turnos normales de compra no disparan el pre-filtro', () => {
    expect(esPosiblePedidoHumano('quiero un perfume dulce')).toBe(false);
    expect(esPosiblePedidoHumano('¿cuánto sale el 2?')).toBe(false);
    expect(esPosiblePedidoHumano('sí, agregalo')).toBe(false);
  });
});

describe('conversation/humanRequest resolverVendedor', () => {
  it('por nombre: único activo → ok', () => {
    const r = resolverVendedor(SELLERS, { tipo: 'nombre', vendedoresQueMatchean: ['Aaron Sosa'] });
    expect(r).toEqual({ tipo: 'ok', vendedor: SELLERS[0] });
  });

  it('7. vendedor inactivo → inactivo (sin pase silencioso a otro)', () => {
    const sellers = [vend('Aaron Sosa', false), vend('Marta Riquelme')];
    const r = resolverVendedor(sellers, { tipo: 'nombre', vendedoresQueMatchean: ['Aaron Sosa'] });
    expect(r.tipo).toBe('inactivo');
  });

  it('8. nombre ambiguo (dos activos matchean) → ambiguo', () => {
    const sellers = [vend('Aaron Sosa'), vend('Aaron Benítez')];
    const r = resolverVendedor(sellers, { tipo: 'nombre', vendedoresQueMatchean: ['Aaron Sosa', 'Aaron Benítez'] });
    expect(r.tipo).toBe('ambiguo');
  });

  it('genérico: reutiliza el asignado si sigue activo; si no, el primer activo', () => {
    expect(resolverVendedor(SELLERS, { tipo: 'generico' }, 'Marta Riquelme')).toEqual({ tipo: 'ok', vendedor: SELLERS[1] });
    expect(resolverVendedor(SELLERS, { tipo: 'generico' }, 'Ex Vendedor')).toEqual({ tipo: 'ok', vendedor: SELLERS[0] });
    expect(resolverVendedor(SELLERS, { tipo: 'generico' }, null)).toEqual({ tipo: 'ok', vendedor: SELLERS[0] });
  });

  it('9. tenant sin vendedores activos → sin_vendedores', () => {
    expect(resolverVendedor([vend('X', false)], { tipo: 'generico' })).toEqual({ tipo: 'sin_vendedores' });
  });
});

const depsBase = (over: Partial<ProcesarPedidoHumanoDeps> = {}): ProcesarPedidoHumanoDeps => ({
  getConfig: async () => ({ bankAccounts: [], sellers: SELLERS }) as CheckoutConfig,
  handoff: vi.fn(async () => ({ ok: true, already: false })),
  notify: vi.fn(async () => true),
  getAssignedSellerName: async () => null,
  ...over,
});

describe('conversation/humanRequest procesarPedidoHumano (orquestación)', () => {
  it('takeover persistido → confirmación honesta + aviso idempotente con el wamid', async () => {
    const deps = depsBase();
    const r = await procesarPedidoHumano('t1', '595000001234', 'quiero hablar con Aaron Sosa', { messageId: 'wamid.X1' }, deps);
    expect(r).toEqual({ handled: true, takeover: true, reply: expect.stringContaining('Te paso con Aaron Sosa') });
    expect(deps.handoff).toHaveBeenCalledWith('t1', '595000001234', expect.objectContaining({
      reason: 'customer_requested',
      sellerName: 'Aaron Sosa',
      sourceId: 'wamid.X1',
      createSessionIfMissing: true,
    }));
    expect(deps.notify).toHaveBeenCalledWith('t1', '595000001234', 'Aaron Sosa', 'wamid.X1');
  });

  it('15. si la transición NO persiste, la respuesta jamás promete el pase (y no notifica)', async () => {
    const deps = depsBase({ handoff: vi.fn(async () => ({ ok: false, already: false })) });
    const r = await procesarPedidoHumano('t1', '595000001234', 'pasame con alguien', {}, deps);
    expect(r.takeover).toBe(false);
    expect(r.reply).not.toMatch(/te paso con|te transfiero/i);
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it('10/11. conversación YA en takeover (mensaje repetido/carrera) → silencio, sin re-aviso', async () => {
    const deps = depsBase({ handoff: vi.fn(async () => ({ ok: true, already: true })) });
    const r = await procesarPedidoHumano('t1', '595000001234', 'quiero hablar con una persona', { messageId: 'wamid.X2' }, deps);
    expect(r).toEqual({ handled: true, takeover: true, reply: '' });
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it('6b. nombre desconocido → honestidad, sin transición ni aviso', async () => {
    const deps = depsBase();
    const r = await procesarPedidoHumano('t1', '595000001234', 'quiero hablar con Juancho Pérez', {}, deps);
    expect(r.handled).toBe(true);
    expect(r.takeover).toBe(false);
    expect(r.reply).toContain('Juancho Pérez');
    expect(deps.handoff).not.toHaveBeenCalled();
  });

  it('9b. sin vendedores → honestidad, sin transición', async () => {
    const deps = depsBase({ getConfig: async () => ({ bankAccounts: [], sellers: [vend('X', false)] }) as unknown as ReturnType<ProcesarPedidoHumanoDeps['getConfig']> extends Promise<infer T> ? T : never });
    const r = await procesarPedidoHumano('t1', '595000001234', 'quiero hablar con un vendedor', {}, deps as ProcesarPedidoHumanoDeps);
    expect(r.takeover).toBe(false);
    expect(r.reply).not.toMatch(/te paso con/i);
  });

  it('turno que no es pedido de humano → handled:false y CERO lecturas de config', async () => {
    const getConfig = vi.fn();
    const deps = depsBase({ getConfig: getConfig as unknown as ProcesarPedidoHumanoDeps['getConfig'] });
    const r = await procesarPedidoHumano('t1', '595000001234', 'quiero un perfume para regalar', {}, deps);
    expect(r.handled).toBe(false);
    expect(getConfig).not.toHaveBeenCalled();
  });
});

describe('conversation/humanRequest — fixes del review adversarial', () => {
  it('REVIEW: negación en OTRA cláusula/oración SÍ deriva (la familia post-oferta del bug real)', () => {
    expect(detectarPedidoHumano('No, quiero hablar con una persona', NOMBRES)?.tipo).toBe('generico');
    expect(detectarPedidoHumano('No me sirve eso. Quiero hablar con Aaron Sosa', NOMBRES)?.tipo).toBe('nombre');
    expect(detectarPedidoHumano('Ninguno me gusta, pasame con un vendedor', NOMBRES)?.tipo).toBe('generico');
    expect(detectarPedidoHumano('sin problema, pasame con un vendedor', NOMBRES)?.tipo).toBe('generico');
  });

  it('REVIEW: la negación en la MISMA cláusula sigue vetando', () => {
    expect(detectarPedidoHumano('no necesito hablar con un vendedor', NOMBRES)).toBeNull();
    expect(detectarPedidoHumano('no quiero que me pases con nadie', NOMBRES)).toBeNull();
  });

  it('REVIEW: pedidos directos sin verbo de contacto también derivan', () => {
    expect(detectarPedidoHumano('quiero un humano', NOMBRES)?.tipo).toBe('generico');
    expect(detectarPedidoHumano('necesito un vendedor', NOMBRES)?.tipo).toBe('generico');
    expect(detectarPedidoHumano('quiero hablar con ustedes', NOMBRES)?.tipo).toBe('generico');
  });

  it('REVIEW: el nombre debe venir INTRODUCIDO (con/a) — un token suelto no dispara', () => {
    expect(detectarPedidoHumano('quiero hablar sobre el sosa que me mostraste', NOMBRES)).toBeNull();
    expect(detectarPedidoHumano('quiero hablar con Sosa', NOMBRES)?.tipo).toBe('nombre');
  });

  it('REVIEW: los placeholders del seed jamás cuentan como vendedores (→ sin_vendedores honesto + aviso)', async () => {
    const notify = vi.fn(async () => true);
    const deps = depsBase({
      getConfig: async () => ({ bankAccounts: [], sellers: [vend('REEMPLAZAR-Vendedor')] }) as CheckoutConfig,
      notify,
    });
    const r = await procesarPedidoHumano('t1', '595000001234', 'quiero hablar con un vendedor', { messageId: 'wamid.PH' }, deps);
    expect(r.takeover).toBe(false);
    expect(r.reply).not.toContain('REEMPLAZAR');
    expect(r.reply).not.toMatch(/te paso con/i);
    expect(deps.handoff).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('t1', '595000001234', null, 'wamid.PH'); // el equipo se entera igual
  });
});
