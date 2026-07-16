import { describe, it, expect } from 'vitest';
import { esConsultaCobertura, RESPUESTA_COBERTURA_SEGURA } from './coverageGuard.js';

/**
 * COVERAGE-GUARD-1: consultas de cobertura/costo/plazo logístico → respuesta segura determinística
 * (jamás la IA, que extrapolaba la FAQ genérica de envíos a cobertura geográfica). El detector es
 * PURO: solo texto — nada de tenant, país, ciudades ni vendedores hardcodeados.
 */
describe('conversation/coverageGuard esConsultaCobertura — intercepta consultas logísticas', () => {
  it('1. cobertura de envío al interior', () => {
    expect(esConsultaCobertura('¿Hacen envíos al interior del país?')).toBe(true);
  });

  it('2. ¿llegan a [lugar]?', () => {
    expect(esConsultaCobertura('¿Llegan a Encarnación?')).toBe(true);
    expect(esConsultaCobertura('¿me lo pueden enviar a Luque?')).toBe(true);
    expect(esConsultaCobertura('¿reparten en mi ciudad?')).toBe(true);
  });

  it('3. cobertura en una ubicación', () => {
    expect(esConsultaCobertura('¿Tienen cobertura en mi barrio?')).toBe(true);
    expect(esConsultaCobertura('¿qué zonas de entrega tienen?')).toBe(true);
    expect(esConsultaCobertura('¿cubren la zona sur?')).toBe(true);
  });

  it('4. costo de envío', () => {
    expect(esConsultaCobertura('¿Cuánto cuesta el envío?')).toBe(true);
    expect(esConsultaCobertura('cuanto sale el envio')).toBe(true);
    expect(esConsultaCobertura('¿el envío es gratis?')).toBe(true);
  });

  it('5. plazo de entrega', () => {
    expect(esConsultaCobertura('¿Cuánto tarda en llegar?')).toBe(true);
    expect(esConsultaCobertura('¿en cuántos días llega?')).toBe(true);
    expect(esConsultaCobertura('que demora de entrega manejan')).toBe(true);
  });

  it('6. variantes con tildes, mayúsculas y puntuación', () => {
    expect(esConsultaCobertura('HACEN ENVIOS AL INTERIOR???')).toBe(true);
    expect(esConsultaCobertura('llegan a encarnacion')).toBe(true);
    expect(esConsultaCobertura('¡¿Envían hasta Ciudad del Este?!')).toBe(true);
    expect(esConsultaCobertura('tienen delivery')).toBe(true);
  });

  it('REVIEW: la contracción "al" no escapa (la forma más frecuente del incidente original)', () => {
    expect(esConsultaCobertura('¿envían al interior?')).toBe(true);
    expect(esConsultaCobertura('llegan al chaco?')).toBe(true);
    expect(esConsultaCobertura('me pueden mandar al chaco?')).toBe(true);
  });

  it('REVIEW: formulaciones coloquiales frecuentes', () => {
    expect(esConsultaCobertura('hasta donde llegan?')).toBe(true);
    expect(esConsultaCobertura('envios hacen?')).toBe(true);
    expect(esConsultaCobertura('y el delivery?')).toBe(true);
    expect(esConsultaCobertura('demora mucho el envio?')).toBe(true);
    expect(esConsultaCobertura('envian por encomienda?')).toBe(true);
    expect(esConsultaCobertura('si pido hoy llega mañana?')).toBe(true);
    expect(esConsultaCobertura('cuanto me sale mandar hasta itaugua?')).toBe(true);
  });

  it('7. la respuesta segura no afirma cobertura, costo ni plazo', () => {
    expect(RESPUESTA_COBERTURA_SEGURA).not.toMatch(/llegamos|s[ií],? hacemos|todo el pa[ií]s|gratis|24 ?h/i);
    expect(RESPUESTA_COBERTURA_SEGURA).toContain('deben ser confirmados');
    expect(RESPUESTA_COBERTURA_SEGURA).toContain('vendedor');
    // Invita al pase pero NO lo promete (HANDOFF-2 hace el pase real cuando el cliente lo pide).
    expect(RESPUESTA_COBERTURA_SEGURA).not.toMatch(/te paso|te transfiero|le aviso/i);
  });
});

describe('conversation/coverageGuard — falsos positivos que NO se interceptan', () => {
  it('seguimiento de un pedido existente', () => {
    expect(esConsultaCobertura('¿cuándo llega mi pedido?')).toBe(false);
    expect(esConsultaCobertura('estado de mi pedido por favor')).toBe(false);
    expect(esConsultaCobertura('¿cómo va mi compra?')).toBe(false);
  });

  it('envío de comprobante', () => {
    expect(esConsultaCobertura('ya te envié el comprobante')).toBe(false);
    expect(esConsultaCobertura('te mando el comprobante de la transferencia')).toBe(false);
    expect(esConsultaCobertura('le envío la captura del depósito')).toBe(false);
  });

  it('mensajes sobre enviar una foto / pedir imágenes', () => {
    expect(esConsultaCobertura('enviame imágenes del producto')).toBe(false);
    expect(esConsultaCobertura('¿me podés mandar las fotos del perfume?')).toBe(false);
    expect(esConsultaCobertura('pasame el catálogo')).toBe(false);
  });

  it('palabras aisladas sin intención logística', () => {
    expect(esConsultaCobertura('envío')).toBe(false);
    expect(esConsultaCobertura('interior')).toBe(false);
    expect(esConsultaCobertura('zona')).toBe(false);
  });

  it('"cobertura" de maquillaje no es logística', () => {
    expect(esConsultaCobertura('¿esta base tiene buena cobertura?')).toBe(false);
  });

  it('performance/packaging de producto no es logística', () => {
    expect(esConsultaCobertura('¿el perfume llega a durar 8 horas?')).toBe(false);
    expect(esConsultaCobertura('¿cuánto tarda en hacer efecto?')).toBe(false);
    expect(esConsultaCobertura('¿llega a proyectarse bien?')).toBe(false);
    expect(esConsultaCobertura('¿llega en su caja original?')).toBe(false);
  });

  it('REVIEW: pedidos de datos de pago/retiro no son cobertura (el checkout gana)', () => {
    expect(esConsultaCobertura('¿me podés mandar el QR para pagar?')).toBe(false);
    expect(esConsultaCobertura('¿me pueden enviar el link para pagar?')).toBe(false);
    expect(esConsultaCobertura('¿me pueden mandar la dirección para pasar a retirar?')).toBe(false);
  });

  it('REVIEW: citar el claim del anuncio con intención de compra no se intercepta', () => {
    expect(esConsultaCobertura('Hola, quiero la promo con envío gratis que vi en el anuncio')).toBe(false);
    // …pero la PREGUNTA por el costo sí:
    expect(esConsultaCobertura('¿el envío es gratis?')).toBe(true);
  });

  it('pedido de humano no es logística (lo maneja HANDOFF-2)', () => {
    expect(esConsultaCobertura('quiero hablar con un vendedor')).toBe(false);
  });

  it('saludos y turnos de compra normales', () => {
    expect(esConsultaCobertura('hola buenas')).toBe(false);
    expect(esConsultaCobertura('quiero un perfume para regalar')).toBe(false);
    expect(esConsultaCobertura('agregá el 2 al carrito')).toBe(false);
    expect(esConsultaCobertura('quiero pagar')).toBe(false);
  });
});
