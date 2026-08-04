/**
 * backupSerialize.test.ts — Un backup que degrada tipos no es un backup.
 * ======================================================================
 * El defecto auditado: `export-tenant.mjs` arma cada documento con `{ id, ...d.data() }` y lo pasa
 * por `JSON.stringify`. Ahí un `Timestamp` se convierte en `{_seconds,_nanoseconds}`, un `GeoPoint`
 * en `{_latitude,_longitude}` y unos `Bytes` en un objeto raro — todos indistinguibles de un mapa
 * cualquiera que el negocio hubiera escrito así. Al volver a entrar, el campo **deja de ser una
 * fecha**: las consultas por rango dejan de encontrarlo, los ordenamientos se rompen y las políticas
 * TTL —que se aplican sobre un `Timestamp`, no sobre un mapa— dejan de purgar. Y nadie se entera,
 * porque el documento "está".
 *
 * Estos tests cablean la propiedad que hace que la restauración sea fiel: **round-trip exacto**.
 */
import { describe, it, expect } from 'vitest';
import { Timestamp, GeoPoint } from 'firebase-admin/firestore';
import { codificar, decodificar, canonico, hashDoc, huella } from '../../scripts/backup-lib.mjs';

/** Documento con TODOS los tipos que Firestore sabe guardar y JSON no sabe representar. */
const DOC_COMPLETO = {
  texto: 'Odyssey',
  entero: 250000,
  flotante: 1.5,
  booleano: true,
  nulo: null,
  fecha: Timestamp.fromMillis(1_770_000_000_123),
  fechaConNanos: new Timestamp(1_770_000_000, 456_789_000),
  ubicacion: new GeoPoint(-25.2637, -57.5759),
  binario: Buffer.from([0x00, 0x01, 0xfe, 0xff]),
  lista: [1, 'dos', Timestamp.fromMillis(0)],
  anidado: { nivel2: { cuando: Timestamp.fromMillis(999), donde: new GeoPoint(0, 0) } },
};

describe('serialización tipada — round-trip exacto', () => {
  it('un Timestamp vuelve como Timestamp, no como mapa (el defecto del exportador)', () => {
    const vuelta = decodificar(codificar(DOC_COMPLETO.fecha)) as Timestamp;
    expect(vuelta).toBeInstanceOf(Timestamp);
    expect(vuelta.isEqual(DOC_COMPLETO.fecha)).toBe(true);
  });

  it('preserva los NANOSEGUNDOS, no solo los milisegundos', () => {
    const vuelta = decodificar(codificar(DOC_COMPLETO.fechaConNanos)) as Timestamp;
    expect(vuelta.nanoseconds).toBe(456_789_000);
    expect(vuelta.seconds).toBe(1_770_000_000);
  });

  it('un GeoPoint vuelve como GeoPoint', () => {
    const vuelta = decodificar(codificar(DOC_COMPLETO.ubicacion)) as GeoPoint;
    expect(vuelta).toBeInstanceOf(GeoPoint);
    expect(vuelta.latitude).toBeCloseTo(-25.2637, 6);
    expect(vuelta.longitude).toBeCloseTo(-57.5759, 6);
  });

  it('los Bytes vuelven byte a byte', () => {
    const vuelta = decodificar(codificar(DOC_COMPLETO.binario)) as Buffer;
    expect(Buffer.isBuffer(vuelta)).toBe(true);
    expect([...vuelta]).toEqual([0x00, 0x01, 0xfe, 0xff]);
  });

  it('el documento ENTERO sobrevive a JSON y vuelve idéntico', () => {
    const ida = JSON.parse(JSON.stringify(codificar(DOC_COMPLETO)));
    const vuelta = decodificar(ida) as Record<string, unknown>;
    // La comparación se hace sobre la forma CODIFICADA: es la que el archivo guarda de verdad.
    expect(canonico(codificar(vuelta))).toBe(canonico(codificar(DOC_COMPLETO)));
  });

  it('una DocumentReference se reconstruye contra la base DESTINO, no contra la de origen', () => {
    // El backup guarda la RUTA; quién la resuelve lo decide el restore. Sin esto, restaurar en otra
    // base dejaría referencias apuntando a un proyecto que ya no es el de esos datos.
    const codificado = { $vpw: 'ref', path: 'tenants/t1/orders/o1' };
    const rehecha = decodificar(codificado, { refFactory: (p: string) => `DESTINO:${p}` });
    expect(rehecha).toBe('DESTINO:tenants/t1/orders/o1');
  });

  it('NaN e Infinity no se vuelven `null` (que es lo que haría JSON a secas)', () => {
    expect(JSON.parse(JSON.stringify({ x: NaN })).x).toBeNull(); // el comportamiento que se evita
    expect(decodificar(JSON.parse(JSON.stringify(codificar(NaN))))).toBeNaN();
    expect(decodificar(JSON.parse(JSON.stringify(codificar(Infinity))))).toBe(Infinity);
    expect(decodificar(JSON.parse(JSON.stringify(codificar(-Infinity))))).toBe(-Infinity);
  });

  it('un mapa del NEGOCIO que ya contenía la clave de escape no se confunde con un tipo', () => {
    // Sin escape, un dato inocente con la clave `$vpw` haría que el decoder intentara interpretarlo
    // como un Timestamp y la restauración se cayera (o, peor, produjera basura).
    const trampa = { $vpw: 'ts', s: 1, ns: 2, otroCampo: 'dato real del negocio' };
    const vuelta = decodificar(JSON.parse(JSON.stringify(codificar(trampa)))) as Record<string, unknown>;
    expect(vuelta).toEqual(trampa);
    expect(vuelta).not.toBeInstanceOf(Timestamp);
  });
});

describe('hash canónico — comparar contenido, no orden', () => {
  it('el orden de los campos no cambia el hash (Firestore no lo garantiza)', () => {
    const a = codificar({ uno: 1, dos: 2, tres: { a: 1, b: 2 } });
    const b = codificar({ tres: { b: 2, a: 1 }, dos: 2, uno: 1 });
    expect(hashDoc(a)).toBe(hashDoc(b));
  });

  it('un solo campo distinto cambia el hash (si no, no detectaría deriva)', () => {
    expect(hashDoc(codificar({ precio: 190000 }))).not.toBe(hashDoc(codificar({ precio: 130000 })));
  });

  it('dos Timestamp distintos por nanosegundos dan hashes distintos', () => {
    expect(hashDoc(codificar(new Timestamp(1, 0)))).not.toBe(hashDoc(codificar(new Timestamp(1, 1))));
  });
});

describe('huella — se puede loguear sin filtrar', () => {
  it('es estable e irreversible en longitud (12 hex)', () => {
    const h = huella('595986440752');
    expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(h).toBe(huella('595986440752'));
  });

  it('NO contiene el valor original: es lo que permite loguear identificadores', () => {
    expect(huella('595986440752')).not.toContain('440752');
    expect(huella('arfagi')).not.toContain('arfagi');
  });
});
