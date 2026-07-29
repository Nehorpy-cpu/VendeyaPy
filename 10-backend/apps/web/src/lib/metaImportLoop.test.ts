/**
 * metaImportLoop.test.ts — Política del loop de importación paginada (HARDEN-1).
 * Fija los comportamientos que bloquearon la review adversarial: cuota agotada y error remoto
 * DETIENEN el loop (una sola invocación), already_running no loopea, el progreso solo avanza
 * con datos reales (guard de no-progreso) y el tope defensivo corta con mensaje honesto.
 */
import { describe, it, expect, vi } from 'vitest';
import type { MetaCatalogImportRunState } from './catalog';
import { correrImportacionPaginada, errTextImport } from './metaImportLoop';

const estado = (over: Partial<MetaCatalogImportRunState> = {}): MetaCatalogImportRunState => ({
  status: 'running',
  runId: 'run-1',
  cursor: null,
  more: false,
  pagesDone: 0,
  procesados: 0,
  contadores: {
    imported: 0,
    alreadyLinked: 0,
    alreadyImported: 0,
    ambiguous: 0,
    conflicted: 0,
    skipped: 0,
    unclassified: 0,
  },
  cursorResets: 0,
  ...over,
});

/** invocar que devuelve estados en secuencia (la última respuesta se repite si el loop sigue). */
const invocarSecuencia = (estados: MetaCatalogImportRunState[]) => {
  let i = 0;
  return vi.fn(async () => estados[Math.min(i++, estados.length - 1)]!);
};

describe('correrImportacionPaginada — cortes que NO deben loopear', () => {
  it('cuota agotada (stopReason quota) DETIENE el loop: una sola invocación, sin re-invocar', async () => {
    const invocar = invocarSecuencia([estado({ stopReason: 'quota', more: true, pagesDone: 2 })]);
    const out = await correrImportacionPaginada(false, { invocar });
    expect(invocar).toHaveBeenCalledTimes(1);
    expect(out.invocaciones).toBe(1);
    expect(out.fase).toBe('cortado');
    expect(out.errorMsg).toContain('límite del plan');
  });

  it('error remoto (stopReason remote_error) detiene el loop con mensaje de reanudar', async () => {
    const invocar = invocarSecuencia([estado({ stopReason: 'remote_error', more: true, pagesDone: 1 })]);
    const out = await correrImportacionPaginada(false, { invocar });
    expect(invocar).toHaveBeenCalledTimes(1);
    expect(out.fase).toBe('cortado');
    expect(out.errorMsg).toContain('Meta no respondió bien');
  });

  it('lastError sin pages_budget también corta (el mensaje del backend manda)', async () => {
    const invocar = invocarSecuencia([estado({ lastError: 'Token vencido', more: true })]);
    const out = await correrImportacionPaginada(false, { invocar });
    expect(invocar).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ fase: 'cortado', errorMsg: 'Token vencido' });
  });

  it('lastError CON stopReason pages_budget NO corta (es avance normal): sigue hasta completar', async () => {
    const invocar = invocarSecuencia([
      estado({ stopReason: 'pages_budget', lastError: 'reintento interno', more: true, pagesDone: 1 }),
      estado({ status: 'completed', pagesDone: 2, procesados: 40 }),
    ]);
    const out = await correrImportacionPaginada(false, { invocar });
    expect(invocar).toHaveBeenCalledTimes(2);
    expect(out.fase).toBe('completado');
  });

  it('already_running: muestra el run vigente vía onAvance y NO loopea', async () => {
    const vigente = estado({
      status: 'already_running',
      pagesDone: 7,
      procesados: 140,
      contadores: { imported: 12, alreadyLinked: 3, alreadyImported: 0, ambiguous: 1, conflicted: 0, skipped: 2, unclassified: 4 },
    });
    const invocar = invocarSecuencia([vigente]);
    const avance = vi.fn();
    const out = await correrImportacionPaginada(false, { invocar, onAvance: avance });
    expect(invocar).toHaveBeenCalledTimes(1);
    expect(out.fase).toBe('ocupado');
    expect(out.errorMsg).toBeNull();
    // Los contadores REALES del run vigente llegan a la UI (no ceros del nivel superior).
    expect(avance).toHaveBeenCalledWith(vigente);
    expect(out.ultimo?.contadores.imported).toBe(12);
  });

  it('failed: una invocación y fase fallado (el render usa lastError del run)', async () => {
    const invocar = invocarSecuencia([estado({ status: 'failed', lastError: 'explotó' })]);
    const out = await correrImportacionPaginada(false, { invocar });
    expect(invocar).toHaveBeenCalledTimes(1);
    expect(out.fase).toBe('fallado');
    expect(out.ultimo?.lastError).toBe('explotó');
  });
});

describe('correrImportacionPaginada — guard de no-progreso y avance real', () => {
  it('sin avance real (mismas páginas, sin more) corta tras 3 invocaciones estancadas', async () => {
    // 1ª invocación fija paginasPrevias=5; las 3 siguientes no avanzan → corte.
    const invocar = invocarSecuencia([estado({ pagesDone: 5, more: false })]);
    const out = await correrImportacionPaginada(false, { invocar });
    expect(invocar).toHaveBeenCalledTimes(4);
    expect(out.fase).toBe('cortado');
    expect(out.errorMsg).toContain('no está avanzando');
  });

  it('el progreso solo avanza con datos reales: páginas que crecen resetean el guard', async () => {
    const invocar = invocarSecuencia([
      estado({ pagesDone: 1, more: false }),
      estado({ pagesDone: 1, more: false }), // estancada (1)
      estado({ pagesDone: 2, more: false }), // avanza → resetea el guard
      estado({ pagesDone: 2, more: false }), // estancada (1)
      estado({ status: 'completed', pagesDone: 3, procesados: 60 }),
    ]);
    const avance: number[] = [];
    const out = await correrImportacionPaginada(false, {
      invocar,
      onAvance: (r) => avance.push(r.pagesDone),
    });
    expect(out.fase).toBe('completado');
    // Cada estado pintado vino del backend (nunca se inventa avance en el cliente).
    expect(avance).toEqual([1, 1, 2, 2, 3]);
  });

  it('more=true re-invoca con resume=true a partir de la segunda invocación', async () => {
    const invocar = invocarSecuencia([
      estado({ more: true, pagesDone: 1 }),
      estado({ status: 'completed', pagesDone: 2 }),
    ]);
    await correrImportacionPaginada(false, { invocar });
    expect(invocar).toHaveBeenNthCalledWith(1, { resume: false });
    expect(invocar).toHaveBeenNthCalledWith(2, { resume: true });
  });

  it('reanudar=true manda resume=true desde la PRIMERA invocación', async () => {
    const invocar = invocarSecuencia([estado({ status: 'completed' })]);
    await correrImportacionPaginada(true, { invocar });
    expect(invocar).toHaveBeenNthCalledWith(1, { resume: true });
  });

  it('tope defensivo de invocaciones: corta con mensaje honesto (jamás bucle infinito)', async () => {
    let paginas = 0;
    const invocar = vi.fn(async (_v: { resume: boolean }) => estado({ more: true, pagesDone: ++paginas }));
    const out = await correrImportacionPaginada(false, { invocar, maxInvocaciones: 5 });
    expect(invocar).toHaveBeenCalledTimes(5);
    expect(out.fase).toBe('cortado');
    expect(out.errorMsg).toContain('catálogo muy grande');
  });

  it('excepción del backend → cortado con el mensaje del error (reanudable)', async () => {
    const invocar = vi.fn(async () => {
      throw new Error('permission-denied');
    });
    const out = await correrImportacionPaginada(false, { invocar });
    expect(out.fase).toBe('cortado');
    expect(out.errorMsg).toBe('permission-denied');
  });

  it('desmontado a mitad → abortado sin tocar más estado (no llama onAvance)', async () => {
    const invocar = invocarSecuencia([estado({ more: true, pagesDone: 1 })]);
    const avance = vi.fn();
    const out = await correrImportacionPaginada(false, { invocar, onAvance: avance, montado: () => false });
    expect(out.fase).toBe('abortado');
    expect(avance).not.toHaveBeenCalled();
  });
});

describe('errTextImport', () => {
  it('usa el message del error; fallback claro si no hay', () => {
    expect(errTextImport(new Error('claro'))).toBe('claro');
    expect(errTextImport({})).toContain('Error inesperado');
    expect(errTextImport(null)).toContain('Error inesperado');
  });
});
