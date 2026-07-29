import { describe, it, expect } from 'vitest';
import type { Timestamp } from '@vpw/shared';
import type { ProductConCalidad, ProductQuality, QualityFingerprintEntry } from './catalog';
import {
  filasDeCalidad,
  filtrarFilas,
  FILTROS_CALIDAD_DEFAULT,
  esElegibleParaSync,
  razonNoElegible,
  agruparNoElegibles,
  observacionesAbiertas,
} from './catalogQuality';

// Timestamp mínimo compatible con el tipo compartido (los helpers solo miran null/no-null).
const ts = (s = 0): Timestamp =>
  ({ seconds: s, nanoseconds: 0, toDate: () => new Date(s * 1000), toMillis: () => s * 1000 }) as Timestamp;

// Objetos mínimos: los helpers solo miran id/name/status/syncToMeta/stockPendingReview/quality.
const entry = (over: Partial<QualityFingerprintEntry> = {}): QualityFingerprintEntry => ({
  code: 'brand_missing',
  severity: 'BLOCKING',
  field: 'brand',
  message: 'Falta la marca',
  action: 'Cargá la marca en el editor',
  firstSeenAt: ts(),
  lastSeenAt: ts(),
  resolvedAt: null,
  origin: 'import',
  ...over,
});

const calidad = (blocking: number, warning: number, fingerprints: Record<string, QualityFingerprintEntry> = {}): ProductQuality => ({
  blocking,
  warning,
  fingerprints,
  evaluatedAt: ts(),
});

const prod = (over: Partial<ProductConCalidad> = {}): ProductConCalidad =>
  ({
    id: 'p1',
    name: 'Producto 1',
    status: 'ACTIVE',
    ...over,
  }) as unknown as ProductConCalidad;

describe('filasDeCalidad + filtrarFilas', () => {
  const products: ProductConCalidad[] = [
    prod({
      id: 'a',
      name: 'Alfa',
      quality: calidad(1, 1, {
        'brand_missing:brand': entry(),
        'generic_name:name': entry({ code: 'generic_name', severity: 'WARNING', field: 'name', origin: 'editor' }),
      }),
    }),
    prod({
      id: 'b',
      name: 'Beta',
      quality: calidad(0, 0, {
        'price_invalid:price': entry({ code: 'price_invalid', field: 'price', resolvedAt: ts(9) }),
      }),
    }),
    prod({ id: 'c', name: 'Sin calidad' }), // sin quality → no aporta filas
  ];

  it('aplana fingerprints y marca abiertas/resueltas', () => {
    const filas = filasDeCalidad(products);
    expect(filas).toHaveLength(3);
    expect(filas.find((f) => f.productId === 'b')?.abierta).toBe(false);
    expect(filas.filter((f) => f.abierta)).toHaveLength(2);
  });

  it('ordena bloqueantes primero', () => {
    const filas = filasDeCalidad(products);
    expect(filas[0]?.entry.severity).toBe('BLOCKING');
    expect(filas[filas.length - 1]?.entry.severity).toBe('WARNING');
  });

  it('el filtro default muestra solo abiertas', () => {
    const filas = filtrarFilas(filasDeCalidad(products), FILTROS_CALIDAD_DEFAULT);
    expect(filas).toHaveLength(2);
    expect(filas.every((f) => f.abierta)).toBe(true);
  });

  it('filtra por severidad, estado, origen y código', () => {
    const filas = filasDeCalidad(products);
    expect(filtrarFilas(filas, { ...FILTROS_CALIDAD_DEFAULT, severidad: 'WARNING' })).toHaveLength(1);
    expect(filtrarFilas(filas, { ...FILTROS_CALIDAD_DEFAULT, estado: 'resueltas' })).toHaveLength(1);
    expect(filtrarFilas(filas, { ...FILTROS_CALIDAD_DEFAULT, origen: 'editor' })).toHaveLength(1);
    expect(filtrarFilas(filas, { ...FILTROS_CALIDAD_DEFAULT, codigo: 'brand_missing' })).toHaveLength(1);
    expect(filtrarFilas(filas, { ...FILTROS_CALIDAD_DEFAULT, estado: 'todas' })).toHaveLength(3);
  });
});

describe('observacionesAbiertas', () => {
  it('excluye resueltas y ordena BLOCKING primero', () => {
    const p = prod({
      quality: calidad(1, 1, {
        w: entry({ code: 'generic_name', severity: 'WARNING' }),
        b: entry({ code: 'name_missing' }),
        r: entry({ code: 'price_invalid', resolvedAt: ts(9) }),
      }),
    });
    const abiertas = observacionesAbiertas(p);
    expect(abiertas.map((e) => e.code)).toEqual(['name_missing', 'generic_name']);
  });

  it('producto sin quality → sin observaciones', () => {
    expect(observacionesAbiertas(prod())).toEqual([]);
  });
});

describe('elegibilidad para selección masiva (refleja quality, no re-implementa reglas)', () => {
  it('con quality: elegible solo si blocking === 0 y sin sync activa', () => {
    const sinBloqueos = prod({ quality: calidad(0, 2) });
    const conBloqueos = prod({ quality: calidad(1, 0) });
    expect(esElegibleParaSync(sinBloqueos)).toBe(true);
    expect(esElegibleParaSync(conBloqueos)).toBe(false);
    expect(razonNoElegible(conBloqueos)).toBe('con_bloqueos');
  });

  it('ya sincronizando → nunca elegible (aunque no tenga bloqueos)', () => {
    const p = prod({ syncToMeta: true, quality: calidad(0, 0) });
    expect(esElegibleParaSync(p)).toBe(false);
    expect(razonNoElegible(p)).toBe('ya_sincroniza');
  });

  it('sin quality: conservador — solo ACTIVE y con stock revisado', () => {
    expect(esElegibleParaSync(prod())).toBe(true);
    expect(razonNoElegible(prod({ status: 'INACTIVE' } as Partial<ProductConCalidad>))).toBe('no_activo');
    expect(razonNoElegible(prod({ stockPendingReview: true }))).toBe('stock_sin_revisar');
  });

  it('agrupa los excluidos por razón', () => {
    const grupos = agruparNoElegibles([
      prod({ syncToMeta: true }),
      prod({ syncToMeta: true }),
      prod({ quality: calidad(2, 0) }),
      prod(), // elegible: no cuenta
    ]);
    expect(grupos).toEqual({ ya_sincroniza: 2, con_bloqueos: 1 });
  });
});
