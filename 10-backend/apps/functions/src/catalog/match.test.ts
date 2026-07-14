import { describe, it, expect } from 'vitest';
import { normalizeText, queryTokens, productMatchScore, bestNameMatch, splitByQueryMatch, esBusquedaSimilar, tokensIdentitarios, hayConsultaDeEntidad } from './match.js';

/**
 * F1B: matcher parcial tokenizado por nombre/marca. Casos reales del catálogo de arfagi
 * (Supremacy/Armaf) y del seed del emulador (Good Girl, La Vie Est Belle, Yara).
 */

const supremacy = { name: 'Perfume Supremacy Not Only Intense', perfume: { brand: 'Afnan' } };
const odyssey = { name: 'Armaf Odyssey Mega', perfume: { brand: 'Armaf' } };
const goodGirl = { name: 'Good Girl', perfume: { brand: 'Carolina Herrera' } };
const laVie = { name: 'La Vie Est Belle', perfume: { brand: 'Lancôme' } };
const catalogo = [supremacy, odyssey, goodGirl, laVie];

describe('catalog/match normalizeText / queryTokens', () => {
  it('minúsculas, sin acentos, sin signos', () => {
    expect(normalizeText('¿Tenés el SUPREMACY?')).toBe('tenes el supremacy');
    expect(normalizeText('Lancôme  Á-É')).toBe('lancome a e');
  });

  it('las palabras genéricas de compra no identifican productos', () => {
    expect(queryTokens('quiero un perfume para regalo')).toEqual([]);
    expect(queryTokens('agregá el perfume Supremacy')).toEqual(['supremacy']);
  });

  it('F2: las confirmaciones de agregado tampoco identifican productos', () => {
    expect(queryTokens('sí, agregalo')).toEqual([]);
    expect(queryTokens('dale, sumalo')).toEqual([]);
    expect(queryTokens('añadilo')).toEqual([]);
  });

  it('F4: la cortesía es relleno, no producto ("Si, agrégalo porfa" no agregaba en prod)', () => {
    expect(queryTokens('Sí, agrégalo porfa')).toEqual([]);
    expect(queryTokens('dale, agregalo por favor')).toEqual([]);
    expect(queryTokens('ok gracias')).toEqual([]);
    expect(queryTokens('porfa')).toEqual([]);
    expect(queryTokens('yo quería el supremacy')).toEqual(['supremacy']); // el reclamo identifica al producto
  });
});

describe('catalog/match productMatchScore / bestNameMatch', () => {
  it('"Supremacy" encuentra "Perfume Supremacy Not Only Intense"', () => {
    expect(bestNameMatch('Supremacy', catalogo)).toBe(supremacy);
    expect(bestNameMatch('Tenés el perfume llamado Supremacy?', catalogo)).toBe(supremacy);
  });

  it('"Odyssey" y la marca "Armaf" encuentran el Armaf Odyssey', () => {
    expect(bestNameMatch('Odyssey', catalogo)).toBe(odyssey);
    expect(bestNameMatch('algo de Armaf', catalogo)).toBe(odyssey);
  });

  it('acentos y mayúsculas no rompen (SUPREMACY, Lancôme→lancome)', () => {
    expect(bestNameMatch('SUPRÉMACY', catalogo)).toBe(supremacy);
    expect(bestNameMatch('perfume de lancome', catalogo)).toBe(laVie);
  });

  it('nombre parcial para carrito: "agregá la belle" → La Vie Est Belle', () => {
    expect(bestNameMatch('agregá la belle', catalogo)).toBe(laVie);
    expect(bestNameMatch('quiero la good girl', catalogo)).toBe(goodGirl);
  });

  it('texto genérico NO matchea nada (umbral: 1 token exacto)', () => {
    expect(bestNameMatch('agregá el perfume', catalogo)).toBeNull();
    expect(bestNameMatch('quiero algo para regalo', catalogo)).toBeNull();
    expect(bestNameMatch('', catalogo)).toBeNull();
  });

  it('frase completa dentro del nombre puntúa más alto que un token suelto', () => {
    const s1 = productMatchScore('good girl', goodGirl);
    const s2 = productMatchScore('girl', goodGirl);
    expect(s1).toBeGreaterThan(s2);
    expect(s2).toBeGreaterThanOrEqual(2);
  });
});

describe('catalog/match fixes del review F1B (variantes, marca sola, empates)', () => {
  const goodGirlSupreme = { name: 'Good Girl Suprême', perfume: { brand: 'Carolina Herrera' } };
  const clubDeNuit = { name: 'Club de Nuit Intense Man', perfume: { brand: 'Armaf' } };
  const laVieIntens = { name: 'La Vie Est Belle Intensément', perfume: { brand: 'Lancôme' } };
  const conVariantes = [...catalogo, goodGirlSupreme, clubDeNuit, laVieIntens];

  it('H1: nombrar el producto EXACTO gana a la variante más larga (cobertura del nombre)', () => {
    expect(bestNameMatch('agregá good girl', conVariantes)).toBe(goodGirl);
    expect(bestNameMatch('quiero la vie est belle', conVariantes)).toBe(laVie);
    expect(splitByQueryMatch('good girl', conVariantes).pinned[0]).toBe(goodGirl);
  });

  it('H1: empate real → gana el nombre más corto (la variante base)', () => {
    expect(bestNameMatch('agregá la belle', [laVieIntens, laVie])).toBe(laVie);
  });

  it('H2: marca sola NO agrega al carrito (requireNameToken), pero sí rankea en la tool', () => {
    expect(bestNameMatch('sumale algo de armaf', [clubDeNuit], { requireNameToken: true })).toBeNull();
    expect(bestNameMatch('sumale algo de armaf', [clubDeNuit])).toBe(clubDeNuit); // tool: ranking OK
    // con token del NOMBRE sí agrega:
    expect(bestNameMatch('agregá el club de nuit', [clubDeNuit], { requireNameToken: true })).toBe(clubDeNuit);
  });
});

describe('catalog/match splitByQueryMatch (pinning para buscar_productos)', () => {
  it('el producto consultado va PRIMERO y el resto queda para filtros', () => {
    const { pinned, rest } = splitByQueryMatch('Supremacy', catalogo);
    expect(pinned).toEqual([supremacy]);
    expect(rest).toHaveLength(3);
    expect(rest).not.toContain(supremacy);
  });

  it('sin query → nada pinned, todo al flujo normal', () => {
    const { pinned, rest } = splitByQueryMatch(undefined, catalogo);
    expect(pinned).toEqual([]);
    expect(rest).toHaveLength(4);
  });

  it('query genérica ("un perfume dulce") → nada pinned (los estilos van por filtro, no por nombre)', () => {
    const { pinned } = splitByQueryMatch('un perfume dulce', catalogo);
    expect(pinned).toEqual([]);
  });

  it('varios matches → orden por score (marca+nombre gana a marca sola)', () => {
    const { pinned } = splitByQueryMatch('Armaf Odyssey', catalogo);
    expect(pinned[0]).toBe(odyssey);
  });
});

describe('catalog/match esBusquedaSimilar (F7)', () => {
  it('detecta pedidos de similares/alternativas', () => {
    expect(esBusquedaSimilar('algo parecido al Supremacy')).toBe(true);
    expect(esBusquedaSimilar('una alternativa al supremacy')).toBe(true);
    expect(esBusquedaSimilar('¿tenés algo SIMILAR?')).toBe(true);
    expect(esBusquedaSimilar('algo como el odyssey')).toBe(true);
    expect(esBusquedaSimilar('algo tipo good girl')).toBe(true);
    expect(esBusquedaSimilar('del estilo de la vie est belle')).toBe(true);
    expect(esBusquedaSimilar('que se parezca al invictus')).toBe(true);
  });

  it('NO detecta consultas directas por producto/marca (fidelidad estricta)', () => {
    expect(esBusquedaSimilar('¿Qué perfumes tienen que sean Supremacy?')).toBe(false);
    expect(esBusquedaSimilar('tenes supremacy?')).toBe(false);
    expect(esBusquedaSimilar('mostrame los armaf')).toBe(false);
    expect(esBusquedaSimilar('quiero ver el odyssey')).toBe(false);
    expect(esBusquedaSimilar('un perfume dulce para regalar')).toBe(false);
  });
});

describe('catalog/match esBusquedaSimilar — F7 review: jerga real y negación', () => {
  it('jerga perfumera de similares (tipo/clon/huela como/igual al/versión)', () => {
    expect(esBusquedaSimilar('quiero un perfume tipo invictus')).toBe(true);
    expect(esBusquedaSimilar('un clon del invictus')).toBe(true);
    expect(esBusquedaSimilar('que huela como el invictus')).toBe(true);
    expect(esBusquedaSimilar('algo igual al invictus')).toBe(true);
    expect(esBusquedaSimilar('el mismo olor que el invictus')).toBe(true);
    expect(esBusquedaSimilar('una versión del invictus')).toBe(true);
  });

  it('la negación de similitud es consulta DIRECTA (fidelidad estricta)', () => {
    expect(esBusquedaSimilar('no quiero nada parecido, quiero el supremacy original')).toBe(false);
    expect(esBusquedaSimilar('nada similar, el original')).toBe(false);
    expect(esBusquedaSimilar('¿no tenés algo parecido al invictus?')).toBe(true); // pregunta real de similares
  });
});

describe('catalog/match tokensIdentitarios / hayConsultaDeEntidad (F7 review)', () => {
  it('las palabras de estilo/ocasión no identifican entidades', () => {
    expect(tokensIdentitarios('algo dulce para la noche')).toEqual([]);
    expect(tokensIdentitarios('¿tenés supremacy?')).toEqual(['supremacy']);
  });

  it('gate de entidad: estilo que colisiona con el nombre NO es entidad; el nombre real SÍ', () => {
    const dulce = { name: 'Dulce Tentación', perfume: { brand: 'Lumen' } };
    expect(hayConsultaDeEntidad('algo dulce', [dulce])).toBe(false);
    expect(hayConsultaDeEntidad('tenes la tentacion dulce?', [dulce])).toBe(true);
    expect(hayConsultaDeEntidad('tenes supremacy', [supremacy])).toBe(true);
    expect(hayConsultaDeEntidad('mostrame los lumen', [dulce])).toBe(true); // marca también es entidad
  });
});
