import { describe, it, expect } from 'vitest';
import { parseShippingCost, PARSER_VERSION, DEFAULT_MAX_SHIPPING_GS } from './shippingCostParser.js';

/** Helper: espera un `matched` con el monto dado. */
function expectMatched(text: string, gs: number, opts?: { maxChargeGs?: number }): void {
  const r = parseShippingCost(text, opts);
  expect(r.kind).toBe('matched');
  if (r.kind === 'matched') {
    expect(r.shippingGs).toBe(gs);
    expect(r.parserVersion).toBe(PARSER_VERSION);
  }
}

/** Helper: espera un `none` (opcionalmente con un reason específico). */
function expectNone(text: string, reason?: string, opts?: { maxChargeGs?: number }): void {
  const r = parseShippingCost(text, opts);
  expect(r.kind).toBe('none');
  if (r.kind === 'none') {
    expect(r.parserVersion).toBe(PARSER_VERSION);
    if (reason) expect(r.reason).toBe(reason);
  }
}

describe('parseShippingCost — formatos válidos (matched)', () => {
  it('₲30.000 con símbolo guaraní', () => expectMatched('el envío es ₲30.000', 30000));
  it('Gs. 30.000 con prefijo Gs', () => expectMatched('el envío cuesta Gs. 30.000', 30000));
  it('30000 Gs con sufijo Gs', () => expectMatched('el envío son 30000 Gs', 30000));
  it('30 mil (multiplicador con espacio)', () => expectMatched('el envío 30 mil', 30000));
  it('30mil (multiplicador pegado)', () => expectMatched('el envío 30mil', 30000));
  it('30k (multiplicador k)', () => expectMatched('el envío 30k', 30000));
  it('agrupación de miles sin marcador', () => expectMatched('el envío cuesta 30.000', 30000));
  it('contexto delivery', () => expectMatched('el delivery sale ₲45.000', 45000));
  it('contexto entrega', () => expectMatched('la entrega cuesta ₲20.000', 20000));
  it('contexto flete', () => expectMatched('el flete es ₲15.000', 15000));
  it('contexto traslado', () => expectMatched('el traslado ₲12.000', 12000));
  it('contexto plural (envios)', () => expectMatched('hacemos envios por ₲25.000', 25000));
  it('monto antes del contexto ("son ₲30.000 de envío")', () => expectMatched('son ₲30.000 de envío', 30000));
  it('monto antes con relleno "el" ("₲30.000 el envío")', () => expectMatched('₲30.000 el envío', 30000));
  it('millones con agrupación múltiple', () => expectMatched('el envío cuesta ₲1.500.000', 1500000));
  it('espaciado irregular tras ₲ (dos espacios)', () => expectMatched('el envío ₲  30000', 30000));
});

describe('parseShippingCost — acentos y mayúsculas', () => {
  it('TODO EN MAYÚSCULAS con acento', () => expectMatched('EL ENVÍO CUESTA ₲30.000', 30000));
  it('capitalización mixta', () => expectMatched('Envío ₲30.000', 30000));
  it('sin acento y en mayúsculas', () => expectMatched('el ENVIO ₲30.000', 30000));
});

describe('parseShippingCost — ejemplos obligatorios del programa', () => {
  it('precio de producto + envío con " y " ⇒ 30.000', () =>
    expectMatched('El perfume cuesta ₲250.000 y el envío ₲30.000', 30000));
  it('dos alternativas de envío ⇒ ambiguous', () =>
    expectNone('El envío puede ser ₲30.000 o ₲35.000', 'monto_ambiguo'));
  it('dirección con número + envío ⇒ 30.000', () =>
    expectMatched('Av. Eusebio Ayala 1234, el envío cuesta ₲30.000', 30000));
  it('teléfono + envío ⇒ 30.000', () =>
    expectMatched('Mi número es 0981 123 456, el envío ₲30.000', 30000));
  it('solo teléfono (sin contexto de envío) ⇒ none', () =>
    expectNone('Mi teléfono es 0981123456', 'sin_contexto_envio'));
  it('envío con dirección pero sin monto ⇒ none', () =>
    expectNone('el envío llega a Av. Ayala 1234', 'sin_monto'));
  it('envío con fecha pero sin monto ⇒ none', () =>
    expectNone('el envío es el 25/12/2026', 'sin_monto'));
  it('envío con cantidad pero sin monto ⇒ none', () =>
    expectNone('necesito envío de 3 unidades', 'sin_monto'));
  it('topónimo "Guaraní" junto a un número pelado NO fabrica monto ⇒ none', () =>
    expectNone('el envío por la ruta 2 Guaraní', 'sin_monto'));
});

describe('parseShippingCost — precio de producto junto al costo de envío (no confundir)', () => {
  it('separado por coma ⇒ toma el envío', () =>
    expectMatched('El perfume ₲250.000, el envío ₲30.000', 30000));
  it('separado por "más" ⇒ toma el envío', () =>
    expectMatched('Total ₲250.000 más envío ₲30.000', 30000));
  it('dos productos y un envío ⇒ toma el envío', () =>
    expectMatched('El shampoo sale ₲80.000 y el envío ₲25.000', 25000));
  it('producto DESPUÉS del envío separado por " y " ⇒ toma el envío', () =>
    expectMatched('el envío ₲30.000 y el perfume ₲250.000', 30000));
  // Regresiones del review adversarial (falsos positivos financieros):
  it('delivery + precio de producto tras coma ⇒ none (NO cobra el precio del producto)', () =>
    expectNone('hacemos delivery, el perfume cuesta 250.000', 'sin_monto'));
  it('envío + precio de producto tras coma ⇒ none', () =>
    expectNone('el envío, el perfume cuesta ₲250.000', 'sin_monto'));
  it('envío real + producto tras coma ⇒ toma el envío (no ambiguo)', () =>
    expectMatched('el envío ₲30.000, el perfume ₲250.000', 30000));
  it('precio de una oración ANTERIOR cerrada con punto no cruza a envío ⇒ none', () =>
    expectNone('El perfume sale ₲250.000. El envío aparte.', 'sin_monto'));
});

describe('parseShippingCost — varios candidatos ⇒ ambiguous', () => {
  it('dos montos distintos con "o"', () => expectNone('el envío ₲30.000 o ₲40.000', 'monto_ambiguo'));
  it('tres montos distintos', () => expectNone('el envío cuesta ₲30.000 o ₲35.000 o ₲40.000', 'monto_ambiguo'));
  it('mismo monto repetido NO es ambiguo', () => expectMatched('el envío ₲30.000, son ₲30.000', 30000));
});

describe('parseShippingCost — gratuidad (₲0)', () => {
  it('"envío gratis" ⇒ free', () => {
    const r = parseShippingCost('envío gratis');
    expect(r.kind).toBe('free');
    if (r.kind === 'free') expect(r.shippingGs).toBe(0);
  });
  it('"el envío es gratis" ⇒ free', () => expect(parseShippingCost('el envío es gratis').kind).toBe('free'));
  it('"sin costo de envío" ⇒ free', () => expect(parseShippingCost('sin costo de envío').kind).toBe('free'));
  it('"envío gratuito" ⇒ free', () => expect(parseShippingCost('envío gratuito').kind).toBe('free'));
  it('"envío sin cargo" ⇒ free', () => expect(parseShippingCost('el envío es sin cargo').kind).toBe('free'));
  it('"envío 0" suelto (sin frase de gratuidad) ⇒ none', () =>
    expectNone('el envío 0', 'sin_monto'));
  it('"₲0" explícito sin gratuidad ⇒ none (cero_sin_gratuidad)', () =>
    expectNone('el envío ₲0', 'cero_sin_gratuidad'));
  it('gratuidad negada ("no es gratis") con monto ⇒ toma el monto', () =>
    expectMatched('no es gratis el envío ₲30.000', 30000));
  it('promo condicional "gratis desde ₲X" ⇒ none (NO cobra el umbral de compra)', () =>
    expectNone('Envío gratis desde ₲150.000', 'gratis_con_monto'));
});

describe('parseShippingCost — seguridad: montos inválidos ⇒ none', () => {
  it('negativo con señal', () => expectNone('el envío -30.000', 'monto_invalido'));
  it('decimal con punto', () => expectNone('el envío ₲30.5', 'monto_invalido'));
  it('decimal con coma', () => expectNone('el envío ₲30,50', 'monto_invalido'));
  it('miles + decimal', () => expectNone('el envío ₲30.500,50', 'monto_invalido'));
  it('overflow (más de 12 dígitos)', () => expectNone('el envío ₲999.999.999.999.999', 'monto_invalido'));
  it('notación científica', () => expectNone('el envío ₲3e4', 'monto_invalido'));
  it('agrupación de miles mal formada (2 dígitos)', () => expectNone('el envío ₲30.00', 'monto_invalido'));
  it('agrupación de miles mal formada (4 dígitos)', () => expectNone('el envío ₲30.0000', 'monto_invalido'));
  it('unidad ajena pegada (30kg) ⇒ none (basura pegada al "k")', () => expectNone('el envío 30kg', 'monto_invalido'));
  it('agrupación con grupo líder 0 (₲0.500) ⇒ none', () => expectNone('el envío ₲0.500', 'monto_invalido'));
  it('agrupación con grupo líder 0 (₲0.030) ⇒ none', () => expectNone('el envío ₲0.030', 'monto_invalido'));
});

describe('parseShippingCost — conservador: casos límite que caen a none (dirección segura)', () => {
  it('monto pegado inmediatamente tras coma ("envío, cuesta X") ⇒ none', () =>
    expectNone('el envío, cuesta ₲30.000', 'sin_monto'));
  it('abreviatura con punto antes del monto ("aprox.") ⇒ none', () =>
    expectNone('el envío aprox. ₲30.000', 'sin_monto'));
});

describe('parseShippingCost — límite máximo', () => {
  it('exactamente en el límite por defecto ⇒ matched', () =>
    expectMatched('el envío cuesta ₲5.000.000', 5000000));
  it('excede el límite por defecto ⇒ none', () =>
    expectNone('el envío cuesta ₲6.000.000', 'excede_maximo'));
  it('excede un maxChargeGs custom ⇒ none', () =>
    expectNone('el envío ₲30.000', 'excede_maximo', { maxChargeGs: 20000 }));
  it('dentro de un maxChargeGs custom ⇒ matched', () =>
    expectMatched('el envío ₲30.000', 30000, { maxChargeGs: 50000 }));
  it('maxChargeGs inválido cae al default', () =>
    expectMatched('el envío ₲30.000', 30000, { maxChargeGs: -1 as unknown as number }));
  it('DEFAULT_MAX_SHIPPING_GS es 5.000.000', () => expect(DEFAULT_MAX_SHIPPING_GS).toBe(5_000_000));
});

describe('parseShippingCost — entradas inválidas / sin contexto', () => {
  it('string vacío ⇒ none vacio', () => expectNone('', 'vacio'));
  it('solo espacios ⇒ none vacio', () => expectNone('   ', 'vacio'));
  it('null ⇒ none vacio', () => expectNone(null as unknown as string, 'vacio'));
  it('undefined ⇒ none vacio', () => expectNone(undefined as unknown as string, 'vacio'));
  it('número (no string) ⇒ none vacio', () => expectNone(123 as unknown as string, 'vacio'));
  it('texto sin palabra de envío ⇒ none sin_contexto_envio', () =>
    expectNone('hola, quiero comprar el perfume ₲250.000', 'sin_contexto_envio'));
});

describe('parseShippingCost — estabilidad de PARSER_VERSION', () => {
  it('valor estable esperado', () => expect(PARSER_VERSION).toBe('shipping-parser-1'));
  it('presente en matched', () => {
    const r = parseShippingCost('el envío ₲30.000');
    expect(r.parserVersion).toBe(PARSER_VERSION);
  });
  it('presente en free', () => {
    const r = parseShippingCost('envío gratis');
    expect(r.parserVersion).toBe(PARSER_VERSION);
  });
  it('presente en none', () => {
    const r = parseShippingCost('');
    expect(r.parserVersion).toBe(PARSER_VERSION);
  });
});

describe('parseShippingCost — pureza (no muta ni depende de estado)', () => {
  it('llamadas repetidas con el mismo input dan el mismo resultado', () => {
    const a = parseShippingCost('el envío ₲30.000');
    const b = parseShippingCost('el envío ₲30.000');
    expect(a).toEqual(b);
  });
  it('el regex global no filtra estado entre llamadas (ambiguo sigue ambiguo)', () => {
    expectMatched('el envío ₲30.000', 30000);
    expectNone('el envío ₲30.000 o ₲40.000', 'monto_ambiguo');
    expectMatched('el envío ₲30.000', 30000);
  });
});
