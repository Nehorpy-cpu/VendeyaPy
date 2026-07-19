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
    expectNone('Envío gratis desde ₲150.000', 'gratuidad_condicional'));
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
  it('valor estable esperado', () => expect(PARSER_VERSION).toBe('shipping-parser-3'));
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

describe('parseShippingCost — HARDEN-1: negaciones, umbrales y aproximaciones', () => {
  it('1. "no cuesta ₲30.000" ⇒ nunca matched/free (monto_negado)', () =>
    expectNone('El envío no cuesta ₲30.000', 'monto_negado'));
  it('2. "cuesta menos de ₲30.000" ⇒ monto_no_exacto', () =>
    expectNone('El envío cuesta menos de ₲30.000', 'monto_no_exacto'));
  it('3. "cuesta hasta ₲30.000" ⇒ monto_no_exacto', () =>
    expectNone('El envío cuesta hasta ₲30.000', 'monto_no_exacto'));
  it('4. "cuesta desde ₲30.000" ⇒ monto_no_exacto', () =>
    expectNone('El envío cuesta desde ₲30.000', 'monto_no_exacto'));
  it('5. "cuesta aproximadamente ₲30.000" ⇒ monto_no_exacto', () =>
    expectNone('El envío cuesta aproximadamente ₲30.000', 'monto_no_exacto'));
  it('6. "aprox ₲30.000" ⇒ monto_no_exacto', () =>
    expectNone('El envío aprox ₲30.000', 'monto_no_exacto'));
  it('7. "- ₲30.000" ⇒ monto_invalido', () =>
    expectNone('El envío - ₲30.000', 'monto_invalido'));
  it('8. "gratis no aplica" ⇒ nunca free (gratuidad_negada)', () =>
    expectNone('El envío es gratis no aplica', 'gratuidad_negada'));
  it('9. "gratis no está disponible" ⇒ nunca free (gratuidad_negada)', () =>
    expectNone('El envío gratis no está disponible', 'gratuidad_negada'));
  it('10. "gratis desde compras superiores" ⇒ gratuidad_condicional (no free)', () =>
    expectNone('El envío gratis desde compras superiores', 'gratuidad_condicional'));
  it('11. "El envío gratis" ⇒ sigue free', () =>
    expect(parseShippingCost('El envío gratis').kind).toBe('free'));
  it('12. "No es gratis, el envío cuesta ₲30.000" ⇒ sigue matched(30000)', () =>
    expectMatched('No es gratis, el envío cuesta ₲30.000', 30000));
  // Modificador NO debe dispararse cuando la palabra es destino, no umbral:
  it('"hasta tu casa ... cuesta ₲30.000" (destino) ⇒ matched(30000)', () =>
    expectMatched('hasta tu casa el envío cuesta ₲30.000', 30000));
});

describe('parseShippingCost — HARDEN-1: negativos con espacio/símbolo (B.1)', () => {
  it('-₲30.000 (pegado) ⇒ monto_invalido', () => expectNone('el envío -₲30.000', 'monto_invalido'));
  it('- ₲30.000 (espacio) ⇒ monto_invalido', () => expectNone('el envío - ₲30.000', 'monto_invalido'));
  it('− ₲30.000 (signo menos U+2212) ⇒ monto_invalido', () => expectNone('el envío − ₲30.000', 'monto_invalido'));
});

describe('parseShippingCost — HARDEN-1: maxChargeGs inválido ⇒ limite_invalido (jamás amplía)', () => {
  const malos: Array<[string, number]> = [
    ['cero', 0],
    ['negativo', -1],
    ['decimal', 1.5],
    ['Infinity', Infinity],
    ['MAX_SAFE+1', Number.MAX_SAFE_INTEGER + 1],
  ];
  for (const [nombre, bad] of malos) {
    it(`maxChargeGs=${nombre} ⇒ none limite_invalido`, () =>
      expectNone('el envío ₲30.000', 'limite_invalido', { maxChargeGs: bad }));
  }
  it('maxChargeGs válido chico se respeta (₲30.000 > 20.000 ⇒ excede_maximo)', () =>
    expectNone('el envío ₲30.000', 'excede_maximo', { maxChargeGs: 20000 }));
  it('maxChargeGs ausente usa el default', () => expectMatched('el envío ₲30.000', 30000));
});

describe('parseShippingCost — HARDEN-1b: gratuidad lejos del contexto (>40 chars entre "envío" y "gratis")', () => {
  it('A1 "...es gratis pero no aplica actualmente" ⇒ NO free (gratuidad_negada)', () => {
    const r = parseShippingCost('El envío para esta zona, según la información que tenemos, es gratis pero no aplica actualmente.');
    expect(r.kind).toBe('none');
    if (r.kind === 'none') expect(r.reason).toBe('gratuidad_negada');
  });
  it('A2 "...gratis solo para compras superiores" ⇒ NO free (gratuidad_condicional)', () => {
    const r = parseShippingCost('El envío para esta ubicación que nos compartiste figura como gratis solo para compras superiores.');
    expect(r.kind).toBe('none');
    if (r.kind === 'none') expect(r.reason).toBe('gratuidad_condicional');
  });
  it('A3 "...gratis excepto durante fines de semana" ⇒ NO free (gratuidad_condicional)', () => {
    const r = parseShippingCost('El envío hasta esa parte del país podría aparecer gratis excepto durante fines de semana.');
    expect(r.kind).toBe('none');
    if (r.kind === 'none') expect(r.reason).toBe('gratuidad_condicional');
  });
  it('A4 "...después de revisar la ruta, es gratis." ⇒ SÍ free', () => {
    expect(parseShippingCost('El envío para tu ubicación, después de revisar la ruta, es gratis.').kind).toBe('free');
  });
});

describe('parseShippingCost — HARDEN-1b: negaciones/cotas/rangos/aprox (review)', () => {
  it('"no te cuesta ₲30.000" (pronombre) ⇒ monto_negado', () =>
    expectNone('el envío no te cuesta ₲30.000', 'monto_negado'));
  it('"no cuesta ni ₲30.000" ⇒ monto_negado', () =>
    expectNone('el envío no cuesta ni ₲30.000', 'monto_negado'));
  it('"no supera los ₲30.000" (cota) ⇒ monto_no_exacto', () =>
    expectNone('el envío no supera los ₲30.000', 'monto_no_exacto'));
  it('rango "entre ₲30.000 y ₲40.000 el envío" ⇒ monto_no_exacto', () =>
    expectNone('entre ₲30.000 y ₲40.000 el envío', 'monto_no_exacto'));
  it('"más o menos ₲30.000" ⇒ monto_no_exacto', () =>
    expectNone('el envío más o menos ₲30.000', 'monto_no_exacto'));
  it('"cuesta cerca de ₲30.000" ⇒ monto_no_exacto', () =>
    expectNone('el envío cuesta cerca de ₲30.000', 'monto_no_exacto'));
  it('"gratis ya no aplica" ⇒ gratuidad_negada', () =>
    expectNone('el envío gratis ya no aplica', 'gratuidad_negada'));
  it('"entre [lugar]" (Entre Ríos) NO es rango de dinero ⇒ matched(30000)', () =>
    expectMatched('el envío a la zona entre ríos cuesta ₲30.000', 30000));
});

describe('parseShippingCost — HARDEN-1b: negativos con espacios exóticos y guiones no-signo (review)', () => {
  it('NBSP (U+00A0) entre "-" y ₲ ⇒ monto_invalido', () =>
    expectNone('el envío -' + String.fromCharCode(0xa0) + '₲30.000', 'monto_invalido'));
  it('varios espacios ASCII entre "-" y ₲ ⇒ monto_invalido', () =>
    expectNone('el envío -    ₲30.000', 'monto_invalido'));
  it('guion de token NO-signo ("express-24") NO mata el monto ⇒ matched(30000)', () =>
    expectMatched('el envío express-24 ₲30.000', 30000));
});

describe('parseShippingCost — HARDEN-1c: gratuidad negada/condicionada con palabras intermedias (review local)', () => {
  it('"no tenemos envío gratis" ⇒ gratuidad_negada', () =>
    expectNone('perdón pero no tenemos envío gratis', 'gratuidad_negada'));
  it('"por el momento no contamos con envío gratis" ⇒ gratuidad_negada', () =>
    expectNone('por el momento no contamos con envío gratis', 'gratuidad_negada'));
  it('"ya no hacemos envío gratis" ⇒ gratuidad_negada', () =>
    expectNone('ya no hacemos envío gratis', 'gratuidad_negada'));
  it('"gratis pero ahora se cobra" ⇒ gratuidad_negada', () =>
    expectNone('antes el envío era gratis pero ahora se cobra', 'gratuidad_negada'));
  it('"gratis para la primera compra" ⇒ gratuidad_condicional', () =>
    expectNone('Envío gratis para la primera compra', 'gratuidad_condicional'));
  it('"gratis para nuevos clientes" ⇒ gratuidad_condicional', () =>
    expectNone('Envío gratis para nuevos clientes', 'gratuidad_condicional'));
  it('"gratis abonando en efectivo" ⇒ gratuidad_condicional', () =>
    expectNone('El envío es gratis abonando en efectivo', 'gratuidad_condicional'));
  it('"gratis dentro de Asunción" ⇒ gratuidad_condicional', () =>
    expectNone('envío gratis dentro de Asunción', 'gratuidad_condicional'));
  it('"gratis en todos los pedidos superiores a ₲150.000" ⇒ gratuidad_condicional', () =>
    expectNone('Envío gratis en todos los pedidos superiores a ₲150.000', 'gratuidad_condicional'));
  // Debe seguir siendo free (no sobre-bloquear):
  it('"el envío es totalmente gratis" ⇒ free', () =>
    expect(parseShippingCost('el envío es totalmente gratis').kind).toBe('free'));
  it('"envío gratis para tu ubicación" (destino, no condición) ⇒ free', () =>
    expect(parseShippingCost('el envío es gratis para tu ubicación').kind).toBe('free'));
});

describe('parseShippingCost — HARDEN-1c: negaciones de importe, rangos y cuantificadores (review local)', () => {
  it('"tampoco cuesta ₲30.000" ⇒ monto_negado', () =>
    expectNone('el envío tampoco cuesta ₲30.000', 'monto_negado'));
  it('"nunca cuesta ₲30.000" ⇒ monto_negado', () =>
    expectNone('el envío nunca cuesta ₲30.000', 'monto_negado'));
  it('"no siempre cuesta ₲30.000" ⇒ monto_negado', () =>
    expectNone('el envío no siempre cuesta ₲30.000', 'monto_negado'));
  it('"no llega a costar ₲30.000" ⇒ monto_no_exacto', () =>
    expectNone('el envío no llega a costar ₲30.000', 'monto_no_exacto'));
  it('rango "de ₲30.000 a ₲40.000 el envío" ⇒ monto_no_exacto', () =>
    expectNone('de ₲30.000 a ₲40.000 el envío', 'monto_no_exacto'));
  it('rango "de 30 a 40 mil" ⇒ NO matched(40000)', () => {
    const r = parseShippingCost('el envío de 30 a 40 mil');
    expect(r.kind).not.toBe('matched');
  });
  it('cuantificador "unos ₲30.000" ⇒ monto_no_exacto', () =>
    expectNone('el envío es de unos ₲30.000', 'monto_no_exacto'));
  it('cota "por lo menos ₲30.000" ⇒ monto_no_exacto', () =>
    expectNone('el envío es por lo menos ₲30.000', 'monto_no_exacto'));
  it('cota "mínimo ₲30.000" ⇒ monto_no_exacto', () =>
    expectNone('el envío es minimo ₲30.000', 'monto_no_exacto'));
  it('"ronda los ₲30.000" ⇒ monto_no_exacto', () =>
    expectNone('el envío ronda los ₲30.000', 'monto_no_exacto'));
  // Debe seguir matched (no sobre-bloquear con rangos de LUGAR/TIEMPO ni "de X"):
  it('"a Entre Ríos es ₲30.000" (lugar) ⇒ matched(30000)', () =>
    expectMatched('el envío a Entre Ríos es ₲30.000', 30000));
  it('"es de ₲30.000" (no rango) ⇒ matched(30000)', () =>
    expectMatched('el envío es de ₲30.000', 30000));
  // Sobre-bloqueo (2ª pasada): un rango de UMBRAL/HORARIO en la misma oración NO debe tumbar el envío único.
  it('envío único + rango de umbral de compra en misma oración ⇒ matched(30000)', () =>
    expectMatched('el envío es ₲30.000, para compras de ₲100.000 a ₲200.000 hacemos descuento', 30000));
  it('envío único + rango de horario en misma oración ⇒ matched(30000)', () =>
    expectMatched('el envío es ₲30.000 y atendemos de 800 a 1800', 30000));
  it('envío único + "entre" umbral en misma oración ⇒ matched(30000)', () =>
    expectMatched('el envío ₲30.000, entre ₲100.000 y ₲200.000 hay promo', 30000));
});

describe('parseShippingCost — HARDEN-2: negaciones comunes del importe (negador genérico en la cláusula)', () => {
  it('"no tiene un costo de ₲30.000" ⇒ monto_negado', () =>
    expectNone('El envío no tiene un costo de ₲30.000', 'monto_negado'));
  it('"no es de ₲30.000" ⇒ monto_negado', () =>
    expectNone('El envío no es de ₲30.000', 'monto_negado'));
  it('"tampoco tiene un costo de ₲30.000" ⇒ monto_negado', () =>
    expectNone('El envío tampoco tiene un costo de ₲30.000', 'monto_negado'));
  it('"nunca tuvo un costo de ₲30.000" ⇒ monto_negado', () =>
    expectNone('El envío nunca tuvo un costo de ₲30.000', 'monto_negado'));
  it('"jamás fue de ₲30.000" ⇒ monto_negado', () =>
    expectNone('El envío jamás fue de ₲30.000', 'monto_negado'));
  // Must-keep (no sobre-bloquear):
  it('"No es gratis, el envío cuesta ₲30.000" ⇒ matched(30000)', () =>
    expectMatched('No es gratis, el envío cuesta ₲30.000', 30000));
  it('"no es gratis el envío ₲30.000" (sin coma, "no" niega la gratuidad) ⇒ matched(30000)', () =>
    expectMatched('no es gratis el envío ₲30.000', 30000));
  it('"El envío cuesta ₲30.000" ⇒ matched(30000)', () =>
    expectMatched('El envío cuesta ₲30.000', 30000));
  it('"El envío no supera ₲30.000" (cota) ⇒ monto_no_exacto', () =>
    expectNone('El envío no supera ₲30.000', 'monto_no_exacto'));
});
