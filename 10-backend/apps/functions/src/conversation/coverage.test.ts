import { describe, it, expect } from 'vitest';
import {
  coverageSettings,
  locationFingerprintOf,
  cartFingerprintOf,
  clasificarTextoEnEspera,
  MENSAJE_SOLICITUD_UBICACION,
  MENSAJE_UBICACION_RECIBIDA,
  MENSAJE_DIRECCION_AMBIGUA,
  MENSAJE_UBICACION_SIN_PEDIDO,
} from './coverage.js';
import type { Cart, CheckoutConfig } from '@vpw/shared';

/**
 * COVERAGE-1B: partes PURAS de la máquina de cobertura. Nada hardcodeado de tenant/país/ciudades
 * (las ciudades de los tests son datos de prueba, no lógica).
 */
const cfgWith = (coverage: unknown): CheckoutConfig =>
  ({ bankAccounts: [], sellers: [], coverage }) as unknown as CheckoutConfig;

describe('coverage coverageSettings — config validada server-side (fail-safe a OFF)', () => {
  it('config ausente / doc sin coverage → deshabilitado', () => {
    expect(coverageSettings(undefined).enabled).toBe(false);
    expect(coverageSettings(null).enabled).toBe(false);
    expect(coverageSettings({ bankAccounts: [], sellers: [] } as CheckoutConfig).enabled).toBe(false);
  });

  it('config inválida (no-objeto, enabled no-boolean-true) → deshabilitado', () => {
    expect(coverageSettings(cfgWith('si')).enabled).toBe(false);
    expect(coverageSettings(cfgWith(['enabled'])).enabled).toBe(false);
    expect(coverageSettings(cfgWith({ enabled: 'true' })).enabled).toBe(false);
    expect(coverageSettings(cfgWith({ enabled: 1 })).enabled).toBe(false);
    expect(coverageSettings(cfgWith({})).enabled).toBe(false);
  });

  it('enabled true → habilitado con defaults (expiry 24h, mensaje default)', () => {
    const r = coverageSettings(cfgWith({ enabled: true }));
    expect(r.enabled).toBe(true);
    expect(r.expiryHours).toBe(24);
    expect(r.requestMessage).toBe(MENSAJE_SOLICITUD_UBICACION);
    expect(r.rejectedMessage).toBeNull();
  });

  it('expiryHours inválido (0, negativo, NaN, string, gigante) → default 24', () => {
    for (const bad of [0, -5, Number.NaN, '24', Number.POSITIVE_INFINITY, 24 * 31 * 24]) {
      expect(coverageSettings(cfgWith({ enabled: true, expiryHours: bad })).expiryHours).toBe(24);
    }
    expect(coverageSettings(cfgWith({ enabled: true, expiryHours: 48 })).expiryHours).toBe(48);
  });

  it('mensajes custom: trim + tope; vacíos → default/null', () => {
    const r = coverageSettings(cfgWith({ enabled: true, requestMessage: '  hola  ', rejectedMessage: 'x'.repeat(1000) }));
    expect(r.requestMessage).toBe('hola');
    expect(r.rejectedMessage).toHaveLength(600);
    expect(coverageSettings(cfgWith({ enabled: true, requestMessage: '   ' })).requestMessage).toBe(MENSAJE_SOLICITUD_UBICACION);
  });
});

describe('coverage fingerprints — la aprobación es POR UBICACIÓN, no por carrito', () => {
  it('coordenadas: redondeo a 4 decimales (~11 m) — el GPS que baila da la misma huella', () => {
    const a = locationFingerprintOf({ coordinates: { lat: -25.28646, lng: -57.647 }, addressText: null });
    const b = locationFingerprintOf({ coordinates: { lat: -25.28649, lng: -57.64701 }, addressText: null });
    const c = locationFingerprintOf({ coordinates: { lat: -25.29646, lng: -57.647 }, addressText: null });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith('geo:')).toBe(true);
  });

  it('texto: normalizado (mayúsculas/tildes/espacios) — la misma dirección da la misma huella', () => {
    const a = locationFingerprintOf({ coordinates: null, addressText: 'Av. España 1234, Luque' });
    const b = locationFingerprintOf({ coordinates: null, addressText: '  av  espana 1234   LUQUE ' });
    const c = locationFingerprintOf({ coordinates: null, addressText: 'Av. España 1234, Capiatá' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith('txt:')).toBe(true);
  });

  it('cartFingerprint es independiente del ORDEN de los ítems y distinto de locationFingerprint', () => {
    const cart1: Cart = { items: [{ productId: 'p1', name: 'A', price: 10, quantity: 1, imageUrl: '' }, { productId: 'p2', name: 'B', price: 20, quantity: 2, imageUrl: '' }], subtotal: 50 };
    const cart2: Cart = { items: [...cart1.items].reverse(), subtotal: 50 };
    const cart3: Cart = { ...cart1, items: [{ ...cart1.items[0]!, quantity: 3 }, cart1.items[1]!] };
    expect(cartFingerprintOf(cart1)).toBe(cartFingerprintOf(cart2));
    expect(cartFingerprintOf(cart1)).not.toBe(cartFingerprintOf(cart3));
    expect(cartFingerprintOf(cart1).startsWith('cart:')).toBe(true);
  });
});

describe('coverage clasificarTextoEnEspera — dirección vs. todo lo demás', () => {
  it('direcciones válidas (señal POSITIVA: léxico de calle/casa y/o números)', () => {
    expect(clasificarTextoEnEspera('Av. España 1234 casi San Martín, Luque')).toBe('direccion');
    expect(clasificarTextoEnEspera('Barrio San Vicente, calle 10 de agosto 555, porton verde')).toBe('direccion');
    expect(clasificarTextoEnEspera('Capiatá km 20 ruta 2, al lado de la despensa')).toBe('direccion');
  });

  it('REVIEW: la señal fuerte de dirección gana sobre preguntas y otras exclusiones', () => {
    expect(clasificarTextoEnEspera('Villa Elisa calle Tte Rojas Silva 123 me ubicas?')).toBe('direccion');
    expect(clasificarTextoEnEspera('Avda Mcal Lopez 1234 frente al deposito de Coca Cola')).toBe('direccion');
    expect(clasificarTextoEnEspera('Edificio Torres del Sol piso 3, dejar con el encargado')).toBe('direccion');
    expect(clasificarTextoEnEspera('Barrio San Blas, dejar con la persona del porton verde')).toBe('direccion');
  });

  it('REVIEW: charla común ≥12 chars ya NO es dirección (el default es re-pedir)', () => {
    expect(clasificarTextoEnEspera('ya te mando la ubicacion')).toBe('ambiguo');
    expect(clasificarTextoEnEspera('si dale confirmalo')).toBe('ambiguo');
    expect(clasificarTextoEnEspera('estoy en el trabajo ahora te aviso')).toBe('ambiguo');
    expect(clasificarTextoEnEspera('muchas gracias')).toBe('ambiguo');
    expect(clasificarTextoEnEspera('jajaja dale nomas')).toBe('ambiguo');
  });

  it('texto demasiado corto / ambiguo → re-pedir, no dirección', () => {
    expect(clasificarTextoEnEspera('asdf')).toBe('ambiguo');
    expect(clasificarTextoEnEspera('Luque')).toBe('ambiguo');
    expect(clasificarTextoEnEspera('123456789012345')).toBe('ambiguo'); // solo números no es dirección
    expect(clasificarTextoEnEspera('👍👍👍')).toBe('ambiguo');
    expect(clasificarTextoEnEspera('PROMO10')).toBe('ambiguo'); // código de tracking: jamás dirección
  });

  it('cancelación / negarse a compartir (incluye diferir el pago)', () => {
    expect(clasificarTextoEnEspera('mejor no, dejalo')).toBe('cancelacion');
    expect(clasificarTextoEnEspera('no quiero compartir mi ubicación')).toBe('cancelacion');
    expect(clasificarTextoEnEspera('cancelar')).toBe('cancelacion');
    expect(clasificarTextoEnEspera('ahora no, más tarde te paso')).toBe('cancelacion');
    expect(clasificarTextoEnEspera('no quiero pagar todavía')).toBe('cancelacion'); // REVIEW: sin loop de re-pedido
  });

  it('REVIEW: consulta de cobertura durante la espera → re-explicar cómo compartir', () => {
    expect(clasificarTextoEnEspera('¿Llegan a Encarnación?')).toBe('como_compartir');
    expect(clasificarTextoEnEspera('¿hacen envíos al interior?')).toBe('como_compartir');
  });

  it('pregunta sobre CÓMO compartir', () => {
    expect(clasificarTextoEnEspera('¿cómo comparto la ubicación?')).toBe('como_compartir');
    expect(clasificarTextoEnEspera('donde está el botón de ubicación')).toBe('como_compartir');
    expect(clasificarTextoEnEspera('no sé como mandar la ubicacion')).toBe('como_compartir');
  });

  it("exclusiones → 'otro' (el flujo normal atiende): vendedor, saludo, producto, carrito, pagar, reclamo, comprobante, preguntas", () => {
    expect(clasificarTextoEnEspera('quiero hablar con un vendedor')).toBe('otro');
    expect(clasificarTextoEnEspera('hola buenas')).toBe('otro');
    expect(clasificarTextoEnEspera('catálogo')).toBe('otro');
    expect(clasificarTextoEnEspera('quiero ver mi carrito')).toBe('otro');
    expect(clasificarTextoEnEspera('quiero pagar')).toBe('otro');
    expect(clasificarTextoEnEspera('listo ya podes cobrar')).toBe('otro'); // REVIEW: vocabulario de pago completo
    expect(clasificarTextoEnEspera('no me agregaste el perfume')).toBe('otro');
    expect(clasificarTextoEnEspera('ya te envié el comprobante de la transferencia')).toBe('otro');
    expect(clasificarTextoEnEspera('¿el supremacy es dulce?')).toBe('otro');
    expect(clasificarTextoEnEspera('¿tienen algún perfume árabe?')).toBe('otro');
  });
});

describe('coverage mensajes — seguros y sin promesas', () => {
  it('la solicitud SIEMPRE incluye la alternativa textual (ciudad/barrio/calle/referencia) y el botón', () => {
    expect(MENSAJE_SOLICITUD_UBICACION).toMatch(/ciudad/i);
    expect(MENSAJE_SOLICITUD_UBICACION).toMatch(/barrio/i);
    expect(MENSAJE_SOLICITUD_UBICACION).toMatch(/calle/i);
    expect(MENSAJE_SOLICITUD_UBICACION).toMatch(/referencia/i);
    expect(MENSAJE_SOLICITUD_UBICACION).toMatch(/bot[oó]n/i);
  });

  it('las confirmaciones no prometen pase ni afirman cobertura', () => {
    for (const m of [MENSAJE_UBICACION_RECIBIDA, MENSAJE_DIRECCION_AMBIGUA, MENSAJE_UBICACION_SIN_PEDIDO]) {
      expect(m).not.toMatch(/te paso con|te transfiero|llegamos a|s[ií],? hay cobertura/i);
    }
  });
});
