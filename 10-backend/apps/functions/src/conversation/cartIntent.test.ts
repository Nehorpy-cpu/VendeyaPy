import { describe, it, expect } from 'vitest';
import {
  PENDING_CART_TTL_MS,
  pendingVigente,
  buildPendingConfirmation,
  tipoNegativa,
  contieneNegacion,
  esPreguntaConsulta,
  candidatosNombrados,
  eleccionPorNombre,
  alignPresentedWithReply,
  preguntaDesambiguacion,
} from './cartIntent.js';

const NOW = 1_000_000;
const ODYSSEY = { id: 'zgpG', name: 'Armaf Odyssey Mega' };
const SUPREMACY = { id: '2wWm', name: 'Perfume Supremacy Not Only Intense' };

/**
 * F3 (CART-TARGETING): fixture del bug REAL (live smoke 2026-07-03). La tool devolvió
 * [Odyssey, Supremacy] pero el texto de la IA presentó SOLO Supremacy como "1." — y el motor
 * agregó Odyssey dos veces ("sí" y "el primero"). Estos tests fijan la alineación texto↔oferta.
 */
const REPLY_REAL_PROD =
  'Perfecto, tengo lo que buscás. Mirá este:\n\n' +
  '**1. Perfume Supremacy Not Only Intense** (Afnan) — **$250.000**\n' +
  'Extrait de parfum con apertura frutal de **piña** que te pide, fondo intenso y seductor. ' +
  'Excelente proyección y duración — presencia todo el día. ✨\n\n' +
  '**Disponibilidad:** Stock vigente\n\n¿Te lo agrego?';

describe('cartIntent alignPresentedWithReply — la oferta es LO QUE EL CLIENTE LEYÓ', () => {
  it('BUG REAL: tool=[Odyssey, Supremacy] pero el texto presenta solo Supremacy → oferta=[Supremacy]', () => {
    const presentados = alignPresentedWithReply(REPLY_REAL_PROD, [ODYSSEY, SUPREMACY]);
    expect(presentados).toEqual([SUPREMACY]);
  });

  it('texto que presenta ambos → orden del TEXTO, no de la tool', () => {
    const reply = 'Mirá:\n1. Perfume Supremacy Not Only Intense — $250.000\n2. Armaf Odyssey Mega — $250.000\n¿Cuál te gusta?';
    expect(alignPresentedWithReply(reply, [ODYSSEY, SUPREMACY])).toEqual([SUPREMACY, ODYSSEY]);
  });

  it('nombre parcial con tilde/mayúsculas distintas igual matchea (≥2 tokens o ≥50%)', () => {
    const reply = 'Te recomiendo el SUPREMACY NOT ONLY, es tremendo.';
    expect(alignPresentedWithReply(reply, [ODYSSEY, SUPREMACY])).toEqual([SUPREMACY]);
  });

  it('la IA parafraseó todo (no nombra ninguno) → [] y el caller usa el orden de la tool', () => {
    expect(alignPresentedWithReply('Tengo justo lo que buscás, ¿te muestro?', [ODYSSEY, SUPREMACY])).toEqual([]);
  });

  it('una mención al pasar de UN token no presenta el producto (mega solo ≠ Odyssey Mega)', () => {
    // 'armaf' y 'odyssey' ausentes; solo 'mega' (1 token, cobertura 1/3) → no presentado.
    expect(alignPresentedWithReply('Es una fragancia mega intensa.', [ODYSSEY])).toEqual([]);
  });

  it('REVIEW: la marca compartida NO presenta al hermano (prosa sobre Yara no mete a Asad)', () => {
    const YARA = { id: 'y', name: 'Lattafa Yara' };
    const ASAD = { id: 'a', name: 'Lattafa Asad' };
    const reply = 'Te recomiendo la Yara de Lattafa, dulce y con gran duración ✨ ¿Querés que te la agregue?';
    // 'lattafa' aparece en el nombre de AMBOS → no es distintivo; solo Yara ('yara') queda.
    expect(alignPresentedWithReply(reply, [YARA, ASAD])).toEqual([YARA]);
  });

  it('REVIEW: lista numerada que la alineación no cubre entera → [] (fallback al orden de la tool, jamás numeración corrida)', () => {
    const GGS = { id: 'g', name: 'Good Girl Suprême' };
    const YARA = { id: 'y', name: 'Yara' };
    // La IA abrevió "La Suprême" (1 de 3 tokens) → no alinea; hay 2 ítems numerados y 1 alineado → [].
    expect(alignPresentedWithReply('1. La Suprême — dulce\n2. Yara — fresco\n¿Cuál preferís?', [GGS, YARA])).toEqual([]);
  });

  it('REVIEW: nombre 100% stopwords se alinea por FRASE completa (no se cae de la lista)', () => {
    const PPH = { id: 'p', name: 'Perfume para hombre' };
    const GG = { id: 'g', name: 'Good Girl' };
    const reply = '1. Perfume para hombre — ₲80.000\n2. Good Girl — ₲250.000\n¿Cuál te gusta?';
    expect(alignPresentedWithReply(reply, [PPH, GG])).toEqual([PPH, GG]);
  });
});

describe('cartIntent buildPendingConfirmation / pendingVigente — vigencia y unicidad', () => {
  it('un producto → primaryProductId y sin desambiguación', () => {
    const p = buildPendingConfirmation([SUPREMACY], 'ai_recommendation', NOW)!;
    expect(p.primaryProductId).toBe(SUPREMACY.id);
    expect(p.needsDisambiguation).toBe(false);
    expect(p.expiresAtMs).toBe(NOW + PENDING_CART_TTL_MS);
  });

  it('varios productos → needsDisambiguation y sin primary', () => {
    const p = buildPendingConfirmation([ODYSSEY, SUPREMACY], 'catalog_listing', NOW)!;
    expect(p.primaryProductId).toBeNull();
    expect(p.needsDisambiguation).toBe(true);
    expect(p.products.map((x) => x.id)).toEqual([ODYSSEY.id, SUPREMACY.id]);
  });

  it('vacío → null; vencida → no vigente; dentro del TTL → vigente', () => {
    expect(buildPendingConfirmation([], 'catalog_listing', NOW)).toBeNull();
    const p = buildPendingConfirmation([SUPREMACY], 'ai_recommendation', NOW)!;
    expect(pendingVigente(p, NOW + 1)).toBe(true);
    expect(pendingVigente(p, NOW + PENDING_CART_TTL_MS)).toBe(false); // justo al vencer, ya no
    expect(pendingVigente(null, NOW)).toBe(false);
  });
});

describe('cartIntent tipoNegativa — negativas no agregan', () => {
  it.each(['no', 'No', 'NO', 'no gracias', 'ese no', 'mejor no', 'todavía no', 'no quiero', 'no lo quiero', 'no la quiero', 'no me lo llevo'])(
    '"%s" → rechazo puro',
    (msg) => expect(tipoNegativa(msg)).toBe('rechazo'),
  );

  it.each(['mejor otro', 'tenés otro?', 'tenes otra', '¿tienen otra opción?', 'hay otro más barato'])(
    '"%s" → pide alternativa (limpia la oferta y sigue el flujo)',
    (msg) => expect(tipoNegativa(msg)).toBe('alternativa'),
  );

  it.each(['no sé si me alcanza', 'nombre raro', 'sí', 'el primero'])(
    '"%s" NO es negativa',
    (msg) => expect(tipoNegativa(msg)).toBeNull(),
  );
});

describe('cartIntent contieneNegacion — guarda dura del review adversarial', () => {
  it.each(['no lo quiero', 'no me lo llevo', 'el supremacy no me convence', 'supremacy mejor no', 'nunca uso dulces', 'ese tampoco'])(
    '"%s" contiene negación (jamás agrega)',
    (msg) => expect(contieneNegacion(msg)).toBe(true),
  );
  it.each(['sí', 'el primero', 'agregame el supremacy', 'quiero ese'])(
    '"%s" NO contiene negación',
    (msg) => expect(contieneNegacion(msg)).toBe(false),
  );
});

describe('cartIntent eleccionPorNombre — elegir ≠ mencionar (review adversarial)', () => {
  const oferta = [ODYSSEY, SUPREMACY];
  it('elección real: "El Supremacy quiero" → Supremacy (solo queda relleno al quitar el nombre)', () => {
    expect(eleccionPorNombre('El Supremacy quiero', oferta)).toEqual([SUPREMACY]);
    expect(eleccionPorNombre('el odyssey', oferta)).toEqual([ODYSSEY]);
  });

  it.each(['me encanta el supremacy pero esta caro', 'el supremacy me parece caro', 'el supremacy lo pienso'])(
    'opinión que menciona al candidato ("%s") NO es elección → va a la IA',
    (msg) => expect(eleccionPorNombre(msg, oferta)).toEqual([]),
  );

  it('negación o pregunta que nombra al candidato NO es elección', () => {
    expect(eleccionPorNombre('el supremacy no me convence', oferta)).toEqual([]);
    expect(eleccionPorNombre('supremacy mejor no', oferta)).toEqual([]);
    expect(eleccionPorNombre('¿el supremacy es dulce?', oferta)).toEqual([]);
  });

  it('empate parejo → ambos (desambiguar)', () => {
    const A = { id: 'a', name: 'Sauvage Eau' };
    const B = { id: 'b', name: 'Sauvage Elixir' };
    expect(eleccionPorNombre('el sauvage', [A, B]).length).toBe(2);
  });
});

describe('cartIntent candidatosNombrados — elección por nombre contra la oferta', () => {
  it('BUG REAL: "El Supremacy quiero" con oferta [Odyssey, Supremacy] → elige Supremacy', () => {
    expect(candidatosNombrados('El Supremacy quiero', [ODYSSEY, SUPREMACY])).toEqual([SUPREMACY]);
  });

  it('"el odyssey" → Odyssey; texto sin nombres → []', () => {
    expect(candidatosNombrados('el odyssey', [ODYSSEY, SUPREMACY])).toEqual([ODYSSEY]);
    expect(candidatosNombrados('dale', [ODYSSEY, SUPREMACY])).toEqual([]);
  });

  it('empate parejo entre dos candidatos → devuelve ambos (desambiguar, no adivinar)', () => {
    const A = { id: 'a', name: 'Sauvage Eau' };
    const B = { id: 'b', name: 'Sauvage Elixir' };
    expect(candidatosNombrados('el sauvage', [A, B]).length).toBe(2);
  });

  it('cobertura total del nombre exacto → elección clara (la variante exacta gana a la extendida)', () => {
    const A = { id: 'a', name: 'Good Girl' };
    const B = { id: 'b', name: 'Good Girl Supreme' };
    expect(candidatosNombrados('la good girl', [A, B])).toEqual([A]);
    expect(candidatosNombrados('la good girl supreme', [A, B])).toEqual([B]);
  });
});

describe('cartIntent esPreguntaConsulta — preguntas van a la IA, no al carrito', () => {
  it.each(['¿el supremacy es dulce?', 'cuanto sale el odyssey', 'que diferencia hay', 'el supremacy tiene buena duración'])(
    '"%s" es consulta',
    (msg) => expect(esPreguntaConsulta(msg)).toBe(true),
  );

  it.each(['El Supremacy quiero', 'el supremacy', 'dale el odyssey'])(
    '"%s" NO es consulta (es elección)',
    (msg) => expect(esPreguntaConsulta(msg)).toBe(false),
  );
});

describe('cartIntent preguntaDesambiguacion — la numeración la arma el MOTOR', () => {
  it('lista 1..N en el orden de la oferta, sin pedir comandos', () => {
    const q = preguntaDesambiguacion([SUPREMACY, ODYSSEY]);
    expect(q).toContain('1. Perfume Supremacy Not Only Intense');
    expect(q).toContain('2. Armaf Odyssey Mega');
    expect(q.indexOf('Supremacy')).toBeLessThan(q.indexOf('Odyssey'));
    expect(q.toLowerCase()).not.toContain('comando');
  });
});
