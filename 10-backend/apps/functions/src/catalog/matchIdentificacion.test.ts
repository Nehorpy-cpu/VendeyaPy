/**
 * matchIdentificacion.test.ts — identificación fail-closed de UN producto (ADR-0019, hito B+C)
 * ============================================================================================
 * Programa AI-PHASE2-MATCHER-AND-RESERVATION-HARDENING-1: la visión "identificaba" al candidato
 * único por el solo hecho de estar solo. Acá se fija el contrato correcto: la identidad se gana
 * con EVIDENCIA de nombre (score + margen) y JAMÁS con conteo, posición en la lista o precio.
 * Fixtures sintéticas de TRES verticales (perfumería, jardín, electrónica) — los mismos umbrales
 * valen para todas, sin léxicos por rubro; el único caso real es la regresión del canary.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  identificarProducto,
  UMBRAL_IDENTIFICACION,
  MARGEN_INEQUIVOCO,
  type CandidatoIdentificable,
  type Identificacion,
} from './matchIdentificacion.js';

const c = (id: string, name: string, price: number): CandidatoIdentificable => ({ id, name, price });

// Perfumería — regresión del canary (el nombre LOCAL agrega calificadores comerciales).
const odysseyLtd = c('per1', 'ARMAF ODYSSEY MEGA LIMITED EDITION EDP', 265_000);
const clubDeNuit = c('per2', 'Armaf Club de Nuit Intense', 230_000);
const auroraClasica = c('per3', 'Aurora Nocturna Clásica', 180_000);
const auroraModerna = c('per4', 'Aurora Nocturna Moderna', 210_000);

// Jardín / macetas — misma lógica, mismos umbrales, otros nombres.
const toscanaGrande = c('jar1', 'Maceta Toscana Grande', 95_000);
const toscanaChica = c('jar2', 'Maceta Toscana Chica', 55_000);
const regadera = c('jar3', 'Regadera Metálica Verde', 40_000);

// Electrónica genérica.
const nexoPro = c('ele1', 'Auricular Nexo Pro X2', 320_000);
const parlante = c('ele2', 'Parlante Bruma 300', 280_000);
const tecladoSlim = c('ele3', 'Teclado Vector Slim', 150_000);
const tecladoSlimRgb = c('ele4', 'Teclado Vector Slim RGB', 185_000);

function comoMatched(r: Identificacion): Extract<Identificacion, { tipo: 'matched' }> {
  if (r.tipo !== 'matched') throw new Error(`esperaba matched y vino ${r.tipo}`);
  return r;
}
function comoAmbiguous(r: Identificacion): Extract<Identificacion, { tipo: 'ambiguous' }> {
  if (r.tipo !== 'ambiguous') throw new Error(`esperaba ambiguous y vino ${r.tipo}`);
  return r;
}

describe('matchIdentificacion: calificadores locales no rompen la identificación (caso 1, canary)', () => {
  it('"ARMAF ODYSSEY MEGA Eau de Parfum" identifica a "ARMAF ODYSSEY MEGA LIMITED EDITION EDP"', () => {
    const r = comoMatched(identificarProducto('ARMAF ODYSSEY MEGA Eau de Parfum', [odysseyLtd, clubDeNuit]));
    expect(r.producto.id).toBe('per1');
    expect(r.evidencia.score).toBeGreaterThanOrEqual(UMBRAL_IDENTIFICACION);
    expect(r.evidencia.margen).toBeGreaterThan(0);
  });

  it('también con el candidato solo — pero por EVIDENCIA, no por estar solo', () => {
    const r = comoMatched(identificarProducto('ARMAF ODYSSEY MEGA Eau de Parfum', [odysseyLtd]));
    expect(r.producto.id).toBe('per1');
    expect(r.evidencia.score).toBeGreaterThanOrEqual(UMBRAL_IDENTIFICACION);
  });

  it('la evidencia son SOLO números — jamás texto crudo de la imagen o del catálogo', () => {
    const r = comoMatched(identificarProducto('ARMAF ODYSSEY MEGA Eau de Parfum', [odysseyLtd, clubDeNuit]));
    expect(r.evidencia).toEqual({ score: expect.any(Number), margen: expect.any(Number) });
  });
});

describe('matchIdentificacion: normalización y ruido comercial (caso 2)', () => {
  it('acentos, puntuación y palabras comerciales accesorias no rompen ("edición limitada", "ml")', () => {
    const r = comoMatched(identificarProducto('edición limitada, ARMAF ODYSSEY MEGA 100 ml.', [odysseyLtd, clubDeNuit]));
    expect(r.producto.id).toBe('per1');
  });

  it('el orden de las palabras no importa', () => {
    const r = comoMatched(identificarProducto('¡MEGA! Odyssey — Armaf', [odysseyLtd, clubDeNuit]));
    expect(r.producto.id).toBe('per1');
  });

  it('mayúsculas y tildes en otra vertical: "MACETA TOSCÁNA GRANDE!!!" gana con margen inequívoco', () => {
    // La Chica también es elegible (comparte "maceta toscana"): decide el MARGEN, no la posición.
    const r = comoMatched(identificarProducto('MACETA TOSCÁNA GRANDE!!!', [toscanaChica, toscanaGrande, regadera]));
    expect(r.producto.id).toBe('jar1');
    expect(r.evidencia.margen).toBeGreaterThanOrEqual(MARGEN_INEQUIVOCO);
  });
});

describe('matchIdentificacion: ambigüedad honesta, jamás selección arbitraria (caso 3)', () => {
  it('dos variantes igual de cercanas ⇒ ambiguous con ambas', () => {
    const r = comoAmbiguous(identificarProducto('aurora nocturna', [auroraClasica, auroraModerna]));
    expect(r.productos.map((p) => p.id).sort()).toEqual(['per3', 'per4']);
  });

  it('invertir el ORDEN del array de candidatos no cambia el resultado (la posición no identifica)', () => {
    const r1 = identificarProducto('aurora nocturna', [auroraClasica, auroraModerna]);
    const r2 = identificarProducto('aurora nocturna', [auroraModerna, auroraClasica]);
    expect(r1.tipo).toBe('ambiguous');
    expect(r2).toEqual(r1);
  });

  it('variantes cercanas de electrónica ("Slim" vs "Slim RGB") ⇒ ambiguous aunque una puntúe apenas más', () => {
    const r = comoAmbiguous(identificarProducto('teclado vector slim', [tecladoSlimRgb, tecladoSlim]));
    expect(r.productos.map((p) => p.id)).toEqual(['ele3', 'ele4']); // orden por score desc, sin elegir
  });

  it('empate masivo ⇒ tope de 3 opciones, determinístico ante cualquier orden de entrada', () => {
    const velas = [
      c('vel1', 'Vela Aromática Bosque Sereno', 60_000),
      c('vel2', 'Vela Aromática Bosque Andino', 61_000),
      c('vel3', 'Vela Aromática Bosque Nórdico', 62_000),
      c('vel4', 'Vela Aromática Bosque Austral', 63_000),
    ];
    const r1 = comoAmbiguous(identificarProducto('vela aromática bosque', velas));
    const r2 = comoAmbiguous(identificarProducto('vela aromática bosque', [...velas].reverse()));
    expect(r1.productos).toHaveLength(3);
    expect(r2.productos.map((p) => p.id)).toEqual(r1.productos.map((p) => p.id));
  });
});

describe('matchIdentificacion: no_match fail-closed (caso 4)', () => {
  it('marca/nombre incompatibles ⇒ no_match — jamás "el menos peor"', () => {
    expect(identificarProducto('Falcon Vortex 500', [odysseyLtd, clubDeNuit, toscanaGrande]).tipo).toBe('no_match');
  });

  it('un solo token flojo entre ruido no identifica (queda bajo el umbral)', () => {
    expect(identificarProducto('florero aurora ceramica', [auroraClasica, auroraModerna]).tipo).toBe('no_match');
  });

  it('consulta vacía o candidatos vacíos ⇒ no_match', () => {
    expect(identificarProducto('', [odysseyLtd]).tipo).toBe('no_match');
    expect(identificarProducto('armaf odyssey', []).tipo).toBe('no_match');
  });

  it('los umbrales del contrato quedan fijados (un token suelto = 2 pts no alcanza)', () => {
    expect(UMBRAL_IDENTIFICACION).toBe(4);
    expect(MARGEN_INEQUIVOCO).toBe(2);
  });
});

describe('matchIdentificacion: multi-vertical con la MISMA vara (caso 5)', () => {
  it('electrónica: "auricular nexo pro" identifica al Nexo Pro X2', () => {
    const r = comoMatched(identificarProducto('auricular nexo pro', [parlante, nexoPro]));
    expect(r.producto.id).toBe('ele1');
  });

  it('jardín: "maceta toscana grande" identifica a la Grande aunque la Chica sea elegible (margen)', () => {
    const r = comoMatched(identificarProducto('maceta toscana grande', [toscanaChica, toscanaGrande]));
    expect(r.producto.id).toBe('jar1');
    expect(r.evidencia.margen).toBeGreaterThanOrEqual(MARGEN_INEQUIVOCO);
  });
});

describe('matchIdentificacion: precio y posición JAMÁS desempatan (caso 6)', () => {
  it('nombres igual de cercanos con precios distintos ⇒ ambiguous (el precio no es señal de identidad)', () => {
    const r1 = comoAmbiguous(identificarProducto('maceta toscana', [toscanaGrande, toscanaChica]));
    const r2 = comoAmbiguous(identificarProducto('maceta toscana', [toscanaChica, toscanaGrande]));
    expect(r1.productos.map((p) => p.id).sort()).toEqual(['jar1', 'jar2']);
    expect(r2).toEqual(r1); // ni el precio (95k vs 55k) ni el orden de llegada eligen un ganador
  });
});

describe('matchIdentificacion: función PURA (caso 7)', () => {
  it('el módulo solo importa de ./match.js — sin firebase, DB ni red', () => {
    const src = readFileSync(new URL('./matchIdentificacion.ts', import.meta.url), 'utf8');
    const importados = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(importados).toEqual(['./match.js']);
    expect(src).not.toMatch(/firebase|firestore/i);
  });

  it('sin estado entre llamadas y sin mutar la lista del caller', () => {
    const lista = [auroraModerna, auroraClasica];
    const copia = [...lista];
    const a = identificarProducto('aurora nocturna', lista);
    const b = identificarProducto('aurora nocturna', lista);
    expect(b).toEqual(a);
    expect(lista).toEqual(copia); // el orden interno trabaja sobre una copia
  });
});

describe('evidencia estructural (review adversarial MEDIO 1: el umbral numérico solo no alcanza)', () => {
  const armaf = { id: 'p1', name: 'ARMAF ODYSSEY MEGA LIMITED EDITION EDP', price: 250_000 };
  it('un PREFIJO truncado ("odys") jamás identifica, ni con candidato único (antes: matched score 4)', () => {
    expect(identificarProducto('odys', [armaf])).toEqual({ tipo: 'no_match' });
  });
  it('la MARCA sola (un token, auto-frase) jamás identifica un modelo (antes: matched 6.5)', () => {
    expect(identificarProducto('lattafa', [{ id: 'p2', name: 'Lattafa Asad', price: 180_000 }]))
      .toEqual({ tipo: 'no_match' });
  });
  it('la rama de frase sigue viva para consultas de ≥2 tokens contenidas en el nombre', () => {
    const r = identificarProducto('aurora nocturna', [{ id: 'p3', name: 'Aurora Nocturna Clásica 50ml', price: 90_000 }]);
    expect(r.tipo).toBe('matched');
  });
});
