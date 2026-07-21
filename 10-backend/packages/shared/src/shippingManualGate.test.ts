import { describe, it, expect } from 'vitest';
import { parseShippingCost, DEFAULT_MAX_SHIPPING_GS } from './shippingCostParser.js';
import type { ShippingParseReason, ShippingParseResult } from './shippingCostParser.js';
import {
  MANUAL_BLOCKING_REASONS,
  blocksByParseResult,
  hasEvidentShippingAttempt,
  blocksManualShippingSend,
} from './shippingManualGate.js';
import type { ShippingQuotePolicy } from './shippingQuotePolicy.js';

const REQUIRED: ShippingQuotePolicy = { status: 'required', maxChargeGs: DEFAULT_MAX_SHIPPING_GS };
const INVALID: ShippingQuotePolicy = { status: 'invalid' };
const OFF: ShippingQuotePolicy = { status: 'off' };

const none = (reason: ShippingParseReason): ShippingParseResult => ({ kind: 'none', reason, parserVersion: 'x' });

describe('blocksByParseResult — clasificación (una sola fuente web/backend)', () => {
  it('true para matched/free', () => {
    expect(blocksByParseResult({ kind: 'matched', shippingGs: 30000, parserVersion: 'x' })).toBe(true);
    expect(blocksByParseResult({ kind: 'free', shippingGs: 0, parserVersion: 'x' })).toBe(true);
  });
  it('true para los 9 motivos de intento de costo', () => {
    for (const r of MANUAL_BLOCKING_REASONS) expect(blocksByParseResult(none(r))).toBe(true);
    expect(MANUAL_BLOCKING_REASONS.size).toBe(9);
  });
  it('false para texto común y limite_invalido', () => {
    for (const r of ['vacio', 'sin_contexto_envio', 'sin_monto', 'limite_invalido'] as ShippingParseReason[]) {
      expect(blocksByParseResult(none(r))).toBe(false);
    }
  });
});

describe('hasEvidentShippingAttempt — detección endurecida (modo gate)', () => {
  it('contexto + señal en OTRA línea/cláusula ⇒ true (el parser conservador lo dejaría pasar)', () => {
    const casos = [
      'el costo de envío es:\n₲25.000',
      'el envío ya sabés, son 25 mil como siempre',
      'te paso el delivery.\nGs. 40.000',
      'envío\n\n30.000',
    ];
    for (const c of casos) {
      expect(hasEvidentShippingAttempt(c)).toBe(true);
      // Confirmación del hueco del parser (asimetría matching vs censura):
      expect(parseShippingCost(c).kind === 'matched').toBe(false);
    }
  });
  it('dígitos crudos y comas también son señal (review 3B: "30000"/"30,000" evadían el gate)', () => {
    for (const c of ['el costo de envio es 30000', 'el envio cuesta 30,000', 'costo de envio:\n30000']) {
      expect(hasEvidentShippingAttempt(c)).toBe(true);
      expect(blocksManualShippingSend(c, REQUIRED)).toBe(true);
    }
  });
  it('sin señal monetaria ⇒ false (no sobre-bloquear conversación común)', () => {
    for (const c of ['ya te confirmo el envío', 'el envío llega el 15', 'hacemos envíos a todo el país', 'necesito envío de 3 unidades']) {
      expect(hasEvidentShippingAttempt(c)).toBe(false);
    }
  });
  it('señal sin contexto de envío ⇒ false (precio de producto solo)', () => {
    expect(hasEvidentShippingAttempt('el perfume cuesta ₲250.000')).toBe(false);
    expect(hasEvidentShippingAttempt('son 30 mil en total')).toBe(false);
  });
});

describe('blocksManualShippingSend — gate compartido por política', () => {
  it('policy off ⇒ nunca bloquea', () => {
    expect(blocksManualShippingSend('el envío cuesta ₲30.000', OFF)).toBe(false);
  });
  it('policy required ⇒ bloquea matched/free y los intentos no-limpios', () => {
    for (const t of [
      'el envío cuesta ₲30.000', // matched
      'envío gratis', // free
      'el envío ₲30.000 o ₲40.000', // ambiguo
      'el envío aprox ₲30.000', // no exacto
      'el envío no cuesta ₲30.000', // negado
      'el envío ₲0', // cero sin gratuidad
      'envío gratis desde ₲150.000', // gratuidad condicional
      'el envío gratis no aplica', // gratuidad negada
      'el envío ₲30.5', // inválido
      'el envío cuesta ₲6.000.000', // excede máximo (default)
    ]) {
      expect(blocksManualShippingSend(t, REQUIRED)).toBe(true);
    }
  });
  it('policy required ⇒ permite vacío, sin contexto y envío sin monto', () => {
    for (const t of ['', 'hola, ¿cómo estás?', 'ya te confirmo el envío', 'el perfume cuesta ₲250.000']) {
      expect(blocksManualShippingSend(t, REQUIRED)).toBe(false);
    }
  });
  it('policy invalid ⇒ re-clasifica la intención con DEFAULT (bloquea costo, permite común); jamás produce monto aprobable', () => {
    expect(blocksManualShippingSend('el envío cuesta ₲30.000', INVALID)).toBe(true);
    expect(blocksManualShippingSend('hola', INVALID)).toBe(false);
    expect(blocksManualShippingSend('te confirmo luego el envío', INVALID)).toBe(false);
    // La función devuelve boolean: no existe camino que exponga un monto con config inválida.
  });
  it('detección endurecida activa en required e invalid (multi-línea)', () => {
    expect(blocksManualShippingSend('el costo de envío es:\n₲25.000', REQUIRED)).toBe(true);
    expect(blocksManualShippingSend('el costo de envío es:\n₲25.000', INVALID)).toBe(true);
  });
  it('RESIDUAL DOCUMENTADO: montos escritos en palabras no se detectan (límite conocido)', () => {
    expect(blocksManualShippingSend('el envío sale veinticinco mil guaraníes', REQUIRED)).toBe(false);
  });
});
