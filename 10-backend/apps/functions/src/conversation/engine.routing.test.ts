import { describe, it, expect } from 'vitest';
import { ruleEngineWouldFallback, detectarGenero, buildAiHistory, esConfirmacionCorta } from './engine.js';

/**
 * Invariante AG-3 / AG-3B: el sales agent IA SOLO recibe la "cola conversacional" — los turnos que el
 * motor rule-based mandaría a su fallback genérico. Todo lo transaccional/navegacional (saludo, carrito,
 * pagar, selección por número, catálogo) NO se delega: queda 100% en las reglas. Este test fija ese
 * límite (la decisión de ruteo es pura y vive en `ruleEngineWouldFallback`).
 *
 * F1 (GROUNDING): `quiereCatalogo` se angostó — las palabras genéricas de compra (quiero/perfume/
 * tenés/busco/recomend/ver/regalo) ya NO capturan: esos turnos van a la IA, que busca con tools.
 * El catálogo rule-based queda para el pedido explícito (catálogo/mostrar/opciones) o señal clara
 * de estilo/precio.
 */
const wouldFallback = (s: string) => ruleEngineWouldFallback(s, s.toLowerCase());

describe('conversation/engine ruleEngineWouldFallback (ruteo al sales agent IA)', () => {
  it('delega al IA la cola conversacional (lo que las reglas no resuelven)', () => {
    expect(wouldFallback('¿hacen envíos al interior del país?')).toBe(true);
    expect(wouldFallback('¿dónde están ubicados?')).toBe(true);
    expect(wouldFallback('¿atienden los domingos?')).toBe(true);
  });

  it('F1: delega al IA los pedidos genéricos de compra (antes los capturaba el catálogo rule-based)', () => {
    expect(wouldFallback('quiero un perfume')).toBe(true);
    expect(wouldFallback('tenés algo para regalar?')).toBe(true);
    expect(wouldFallback('recomendame algo para mi novia')).toBe(true);
    expect(wouldFallback('tenés el Good Girl?')).toBe(true);
    expect(wouldFallback('busco una fragancia rica')).toBe(true);
  });

  it('NO delega el saludo (lo maneja el saludo rule-based)', () => {
    expect(wouldFallback('hola')).toBe(false);
    expect(wouldFallback('buenas, qué tal')).toBe(false);
  });

  it('NO delega la selección por número (ordinal → rule-based: carrito)', () => {
    expect(wouldFallback('el primero')).toBe(false);
    expect(wouldFallback('quiero el segundo')).toBe(false);
    expect(wouldFallback('dame el 3')).toBe(false);
  });

  it('F3: una PREGUNTA con número es consulta para la IA, no selección (review adversarial)', () => {
    expect(wouldFallback('¿cuánto sale el 2?')).toBe(true);
    expect(wouldFallback('¿el 1 tiene buena duración?')).toBe(true);
  });

  it('NO delega carrito / pagar / agregar (transaccional rule-based)', () => {
    expect(wouldFallback('mostrame mi carrito')).toBe(false);
    expect(wouldFallback('quiero pagar')).toBe(false);
    expect(wouldFallback('agregá la Good Girl')).toBe(false);
  });

  it('F2: sufijos pegados y confirmaciones de agregado van a reglas (antes se iban a la IA)', () => {
    expect(wouldFallback('sí, agregalo')).toBe(false);
    expect(wouldFallback('sumalo')).toBe(false);
    expect(wouldFallback('añadilo al carrito')).toBe(false);
    expect(wouldFallback('quiero ese')).toBe(false);
    expect(wouldFallback('me llevo ese')).toBe(false);
  });

  it('F2: preguntas con conjugaciones de "llevar" NO son agregar (siguen yendo a la IA)', () => {
    expect(wouldFallback('¿cuánto lleva el envío?')).toBe(true);
    expect(wouldFallback('¿el perfume lleva alcohol?')).toBe(true);
  });

  it('NO delega el catálogo explícito ni señales claras de estilo/precio (rule-based)', () => {
    expect(wouldFallback('quiero ver el catálogo')).toBe(false); // 'catálogo' explícito
    expect(wouldFallback('mostrame opciones')).toBe(false);
    expect(wouldFallback('busco algo dulce')).toBe(false); // estilo
    expect(wouldFallback('algo barato para el día')).toBe(false); // precio
    expect(wouldFallback('hasta 200 mil')).toBe(false); // precio numérico
  });
});

describe('esConfirmacionCorta (F2: "sí"/"dale"/"ok" = agregar el primero SI está mirando productos)', () => {
  it('confirma: afirmaciones cortas y combinaciones con agregar', () => {
    expect(esConfirmacionCorta('sí')).toBe(true);
    expect(esConfirmacionCorta('Sí, agregalo')).toBe(true);
    expect(esConfirmacionCorta('dale')).toBe(true);
    expect(esConfirmacionCorta('ok')).toBe(true);
    expect(esConfirmacionCorta('sí quiero')).toBe(true);
    expect(esConfirmacionCorta('dale, sumalo')).toBe(true);
  });

  it('NO confirma: pedidos con contenido, negaciones o texto largo', () => {
    expect(esConfirmacionCorta('sí, pero tenés algo más barato?')).toBe(false);
    expect(esConfirmacionCorta('no')).toBe(false);
    expect(esConfirmacionCorta('quiero pagar')).toBe(false);
    expect(esConfirmacionCorta('sí, mostrame el catálogo completo por favor')).toBe(false);
    expect(esConfirmacionCorta('')).toBe(false);
  });
});

describe('detectarGenero (F1: sin señal explícita → undefined = sin filtro)', () => {
  it('masculino explícito', () => {
    expect(detectarGenero('algo para él')).toBe('Masculino');
    expect(detectarGenero('un perfume de hombre')).toBe('Masculino');
    expect(detectarGenero('para mi novio')).toBe('Masculino');
  });

  it('femenino explícito', () => {
    expect(detectarGenero('algo para ella')).toBe('Femenino');
    expect(detectarGenero('para mi esposa')).toBe('Femenino');
    expect(detectarGenero('perfume de mujer')).toBe('Femenino');
  });

  it('sin señal → undefined (el default Femenino dejaba catálogos masculinos siempre vacíos)', () => {
    expect(detectarGenero('catálogo')).toBeUndefined();
    expect(detectarGenero('quiero un perfume')).toBeUndefined();
    expect(detectarGenero('mostrame opciones')).toBeUndefined();
  });
});

describe('buildAiHistory (F1: historial persistido → mensajes para la IA)', () => {
  it('mapea in→user / out→assistant en orden cronológico', () => {
    expect(
      buildAiHistory(
        [
          { direction: 'in', text: 'hola' },
          { direction: 'out', text: 'bienvenida' },
          { direction: 'in', text: 'quiero un perfume' },
        ],
        'quiero un perfume',
      ),
    ).toEqual([
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'bienvenida' },
      { role: 'user', content: 'quiero un perfume' },
    ]);
  });

  it('fusiona consecutivos del mismo rol (la Messages API exige alternancia)', () => {
    expect(
      buildAiHistory(
        [
          { direction: 'in', text: 'hola' },
          { direction: 'in', text: 'estás?' },
          { direction: 'out', text: 'sí, decime' },
          { direction: 'in', text: 'precio del oud' },
        ],
        'precio del oud',
      ),
    ).toEqual([
      { role: 'user', content: 'hola\nestás?' },
      { role: 'assistant', content: 'sí, decime' },
      { role: 'user', content: 'precio del oud' },
    ]);
  });

  it('descarta textos vacíos y nunca arranca en assistant', () => {
    expect(
      buildAiHistory(
        [
          { direction: 'out', text: 'mensaje viejo del bot' },
          { direction: 'in', text: '   ' },
          { direction: 'in', text: 'sigo acá' },
        ],
        'sigo acá',
      ),
    ).toEqual([{ role: 'user', content: 'sigo acá' }]);
  });

  it('historial vacío → solo el turno actual del cliente', () => {
    expect(buildAiHistory([], 'hola necesito ayuda')).toEqual([
      { role: 'user', content: 'hola necesito ayuda' },
    ]);
  });

  it('si el historial termina en assistant, agrega el turno actual como cierre user', () => {
    expect(
      buildAiHistory(
        [
          { direction: 'in', text: 'hola' },
          { direction: 'out', text: 'bienvenida' },
        ],
        'tenés oud?',
      ),
    ).toEqual([
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'bienvenida' },
      { role: 'user', content: 'tenés oud?' },
    ]);
  });
});
