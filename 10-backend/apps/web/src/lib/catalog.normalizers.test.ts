/**
 * catalog.normalizers.test.ts — Bordes de normalización del catálogo (HARDEN-1).
 * Fija: (a) already_running trae el avance REAL en el `run` anidado (sin esto la fase
 * "ocupado" mostraba contadores en cero); (b) el summary de calidad admite las DOS formas
 * del callable (porCodigo objeto {severity,count} vs número; muestras name/codes vs
 * productName/codigos) sin "[object Object]" ni crash con codigos undefined.
 */
import { describe, it, expect } from 'vitest';
import { normalizarImportRun, normalizarQualitySummary } from './catalog';

describe('normalizarImportRun — run anidado de already_running', () => {
  it('already_running: los contadores reales salen del `run` anidado, no del nivel superior', () => {
    const r = normalizarImportRun({
      status: 'already_running',
      run: {
        status: 'running',
        runId: 'run-7',
        pagesDone: 9,
        procesados: 180,
        contadores: { imported: 33, alreadyLinked: 5, alreadyImported: 2, ambiguous: 1, conflicted: 0, skipped: 4, unclassified: 6 },
        cursorResets: 1,
      },
    });
    expect(r.status).toBe('already_running');
    expect(r.runId).toBe('run-7');
    expect(r.pagesDone).toBe(9);
    expect(r.procesados).toBe(180);
    expect(r.contadores.imported).toBe(33);
    expect(r.contadores.unclassified).toBe(6);
    expect(r.cursorResets).toBe(1);
  });

  it('already_running sin `run` anidado: no crashea, contadores en cero honestos', () => {
    const r = normalizarImportRun({ status: 'already_running' });
    expect(r.status).toBe('already_running');
    expect(r.pagesDone).toBe(0);
    expect(r.contadores.imported).toBe(0);
  });

  it('acepta la ortografía compartida (@vpw/shared): processed/counters con cursorResets adentro/hasCursor', () => {
    const r = normalizarImportRun({
      status: 'running',
      runId: 'run-2',
      pagesDone: 3,
      processed: 55,
      counters: { imported: 10, cursorResets: 2 },
      hasCursor: true,
    });
    expect(r.procesados).toBe(55);
    expect(r.contadores.imported).toBe(10);
    expect(r.cursorResets).toBe(2);
    expect(r.more).toBe(true); // running + hasCursor → quedan páginas
  });

  it('cancelled → failed reanudable con aviso; estados desconocidos → failed', () => {
    const c = normalizarImportRun({ status: 'cancelled', runId: 'run-3' });
    expect(c.status).toBe('failed');
    expect(c.lastError).toContain('cancelada');
    expect(normalizarImportRun({ status: 'batman' }).status).toBe('failed');
    expect(normalizarImportRun(null).status).toBe('failed');
  });

  it('valores no numéricos en contadores → 0 (nunca NaN en la UI)', () => {
    const r = normalizarImportRun({
      status: 'running',
      pagesDone: 'tres',
      contadores: { imported: 'muchos', skipped: null },
    });
    expect(r.pagesDone).toBe(0);
    expect(r.contadores.imported).toBe(0);
    expect(r.contadores.skipped).toBe(0);
  });
});

describe('normalizarQualitySummary — las DOS formas del callable', () => {
  it('porCodigo como objeto {severity, count} → número plano (sin "[object Object]")', () => {
    const s = normalizarQualitySummary({
      conBloqueos: 3,
      conAdvertencias: 1,
      porCodigo: {
        brand_missing: { severity: 'BLOCKING', count: 3 },
        generic_name: { severity: 'WARNING', count: 1 },
      },
      muestras: [],
      truncated: false,
    });
    expect(s.porCodigo).toEqual({ brand_missing: 3, generic_name: 1 });
    for (const v of Object.values(s.porCodigo)) expect(typeof v).toBe('number');
  });

  it('porCodigo ya numérico se preserva; formas rotas → 0', () => {
    const s = normalizarQualitySummary({ porCodigo: { brand_missing: 4, raro: 'x', peor: {} } });
    expect(s.porCodigo).toEqual({ brand_missing: 4, raro: 0, peor: 0 });
  });

  it('muestras con name/codes (forma del callable) → productName/codigos (forma del panel)', () => {
    const s = normalizarQualitySummary({
      muestras: [{ productId: 'p1', name: 'Perfume X', blocking: 2, warning: 1, codes: ['brand_missing', 'price_invalid'] }],
    });
    expect(s.muestras).toEqual([
      { productId: 'p1', productName: 'Perfume X', blocking: 2, warning: 1, codigos: ['brand_missing', 'price_invalid'] },
    ]);
  });

  it('muestras con productName/codigos (forma del panel) se preservan', () => {
    const s = normalizarQualitySummary({
      muestras: [{ productId: 'p2', productName: 'Crema Y', blocking: 0, warning: 2, codigos: ['generic_name'] }],
    });
    expect(s.muestras[0]?.productName).toBe('Crema Y');
    expect(s.muestras[0]?.codigos).toEqual(['generic_name']);
  });

  it('codigos undefined → [] (el fallback del centro de calidad no crashea)', () => {
    const s = normalizarQualitySummary({ muestras: [{ productId: 'p3', name: 'Sin códigos' }] });
    expect(s.muestras[0]?.codigos).toEqual([]);
    expect(s.muestras[0]?.blocking).toBe(0);
    expect(s.muestras[0]?.warning).toBe(0);
  });

  it('respuesta vacía/rota → summary vacío usable (nunca crash)', () => {
    const s = normalizarQualitySummary(null);
    expect(s).toEqual({ conBloqueos: 0, conAdvertencias: 0, sinEvaluar: 0, porCodigo: {}, muestras: [], truncated: false });
    expect(normalizarQualitySummary({ muestras: 'no-array' }).muestras).toEqual([]);
  });
});
