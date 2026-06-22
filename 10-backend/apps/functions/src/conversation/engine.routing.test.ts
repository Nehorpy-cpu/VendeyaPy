import { describe, it, expect } from 'vitest';
import { ruleEngineWouldFallback } from './engine.js';

/**
 * Invariante AG-3 / AG-3B: el sales agent IA SOLO recibe la "cola conversacional" — los turnos que el
 * motor rule-based mandaría a su fallback genérico. Todo lo transaccional/navegacional (saludo, carrito,
 * pagar, selección por número, catálogo) NO se delega: queda 100% en las reglas. Este test fija ese
 * límite (la decisión de ruteo es pura y vive en `ruleEngineWouldFallback`).
 */
const wouldFallback = (s: string) => ruleEngineWouldFallback(s, s.toLowerCase());

describe('conversation/engine ruleEngineWouldFallback (ruteo al sales agent IA)', () => {
  it('delega al IA la cola conversacional (lo que las reglas no resuelven)', () => {
    expect(wouldFallback('¿hacen envíos al interior del país?')).toBe(true);
    expect(wouldFallback('¿dónde están ubicados?')).toBe(true);
    expect(wouldFallback('¿atienden los domingos?')).toBe(true);
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

  it('NO delega carrito / pagar / agregar (transaccional rule-based)', () => {
    expect(wouldFallback('mostrame mi carrito')).toBe(false);
    expect(wouldFallback('quiero pagar')).toBe(false);
    expect(wouldFallback('agregá la Good Girl')).toBe(false);
  });

  it('NO delega el catálogo / búsqueda (rule-based muestra lista numerada + lastShownSkus)', () => {
    expect(wouldFallback('quiero ver el catálogo')).toBe(false);
    expect(wouldFallback('busco algo dulce')).toBe(false);
    expect(wouldFallback('tenés algo para regalar?')).toBe(false);
  });
});
