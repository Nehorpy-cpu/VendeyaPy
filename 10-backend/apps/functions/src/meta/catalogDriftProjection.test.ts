import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0015 §8 — la proyección que alimenta al guard del bot y a la revalidación del checkout.
 * Une la PROPIEDAD normalizada (quién gobierna cada campo) con el ESTADO ACTUAL de la
 * reconciliación (con caducidad derivada en lectura). Verifica además la regla de higiene: lo que
 * sale es metadata SANEADA — ni un valor remoto, ni una URL, ni un token.
 */
const docs = new Map<string, Record<string, unknown>>();
/** Toda lectura que pasa por Firestore, en orden: sirve para medir el costo del camino caliente. */
const lecturas: string[] = [];
vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => ({
      get: async () => {
        lecturas.push(path);
        return { exists: docs.has(path), data: () => docs.get(path) };
      },
    }),
  }),
  paths: { product: (t: string, p: string) => `tenants/${t}/products/${p}` },
}));

import { metaDriftProjection } from './catalogDriftProjection.js';
import { clasificarDeriva, evaluarDerivaSiAplica, leerDeriva, setDriftProjection } from '../catalog/driftGuard.js';
import { Timestamp } from 'firebase-admin/firestore';

const CONFIG = 'tenants/t1/config/meta';
const P1 = 'tenants/t1/products/p1';
const TODOS = ['title', 'description', 'price', 'currency', 'availability', 'inventory', 'brand', 'category', 'image', 'url'];

/**
 * Config REAL del contrato congelado: external_managed con el feed reconocido por una persona.
 * `syncOver` pisa el bloque de EJECUCIÓN (enabled/mode/catalogId) sin tocar la PROPIEDAD: son
 * dos ejes distintos y los tests de abajo prueban justamente que no se mezclan.
 */
const configExterna = (declaredFields: string[] = TODOS, syncOver: Record<string, unknown> = {}) =>
  docs.set(CONFIG, {
    catalogSync: {
      enabled: true,
      mode: 'dry_run',
      catalogId: '1234567890',
      ...syncOver,
      ownership: {
        model: 'external_managed',
        ownedFields: [],
        external: {
          kind: 'meta_feed',
          acknowledgedSourceIds: ['feed-1'],
          declaredFields,
          fingerprint: 'huella-saneada',
          acknowledgedByUid: 'uid-owner',
          acknowledgedAt: null,
        },
        lastSourceCheckAt: null,
      },
    },
  });

/** Matriz explícita: el feed publica solo lo cosmético; lo comercial lo gobernamos nosotros. */
const configHibrida = (declaredFields: string[]) =>
  docs.set(CONFIG, {
    catalogSync: {
      enabled: true,
      mode: 'dry_run',
      catalogId: '1234567890',
      ownership: {
        model: 'hybrid',
        ownedFields: ['price', 'availability'],
        external: {
          kind: 'meta_feed',
          acknowledgedSourceIds: ['feed-1'],
          declaredFields,
          fingerprint: 'huella-saneada',
          acknowledgedByUid: 'uid-owner',
          acknowledgedAt: null,
        },
        lastSourceCheckAt: null,
      },
    },
  });

const producto = (over: Record<string, unknown> = {}) =>
  docs.set(P1, { id: 'p1', name: 'Aurora Nocturna', metaProductItemId: 'item-1', metaSyncState: 'drifted_external', metaVerifiedAt: Timestamp.now(), ...over });

beforeEach(() => {
  docs.clear();
  lecturas.length = 0;
  setDriftProjection(null);
});

/** Cuántas veces se leyó la propiedad del tenant (el doc de config). */
const lecturasDeConfig = () => lecturas.filter((p) => p === CONFIG).length;

describe('meta/catalogDriftProjection', () => {
  it('gate por tenant: activo SOLO si la fuente externa gobierna un campo COMERCIAL', async () => {
    configExterna(['price']);
    expect(await metaDriftProjection.activa('t1')).toBe(true);
    // CONTRATO CAMBIADO: con `external_managed` el gobierno externo abarca TODOS los campos
    // públicos (`ownedFields` es vacío por definición del modelo), así que declarar solo
    // cosméticos ya NO apaga el gate. Para expresar "lo comercial es nuestro" el modelo correcto
    // es `hybrid`, y ahí sí el gate queda apagado.
    configHibrida(['title', 'image']);
    expect(await metaDriftProjection.activa('t1')).toBe(false);
  });

  it('external_managed con declaredFields VACÍA sigue gobernando lo comercial (guard NO inerte)', async () => {
    // El caso real: el detector no informa columnas (no se las pedimos a Graph), así que la
    // declaración llega vacía. Con el bug la lista de campos externos viajaba vacía, la
    // clasificación cortaba y un precio divergente se leía como "sin deriva".
    configExterna([]);
    expect(await metaDriftProjection.activa('t1')).toBe(true);
    producto({ metaDrift: { fields: ['price'], owner: 'external', severity: 'commercial', observed: [] } });
    const [s] = await metaDriftProjection.snapshots('t1', ['p1']);
    expect(s!.externalFields).toContain('price');
    expect(s!.state).toBe('drifted_external');
    expect(clasificarDeriva([s!], [{ id: 'p1', name: 'Aurora Nocturna' }]).bloqueantes).toEqual([
      { productId: 'p1', productName: 'Aurora Nocturna', reason: 'drifted_external', fields: ['price'] },
    ]);
  });

  it('config ausente o legacy (fail-closed de propiedad) ⇒ gate apagado y cero snapshots', async () => {
    expect(await metaDriftProjection.activa('t1')).toBe(false);
    docs.set(CONFIG, { catalogSync: { enabled: true, mode: 'live', catalogId: 'abc', sourceOfTruth: 'vendeyapy' } });
    expect(await metaDriftProjection.activa('t1')).toBe(false);
    expect(await metaDriftProjection.snapshots('t1', ['p1'])).toEqual([]);
  });

  it('producto gobernado y divergente ⇒ snapshot con campos externos, estado y campos divergentes', async () => {
    configExterna();
    producto({ metaDrift: { fields: ['price'], owner: 'external', severity: 'commercial', observed: [{ field: 'price', local: '250000', remote: '130000', owner: 'external', severity: 'commercial' }] } });
    const [s] = await metaDriftProjection.snapshots('t1', ['p1']);
    expect(s).toMatchObject({ productId: 'p1', state: 'drifted_external', driftedFields: ['price'] });
    expect(s!.externalFields).toContain('price');
    // Higiene: los valores observados NO viajan al guard (viven en el panel, no en la conversación).
    expect(JSON.stringify(s)).not.toContain('130000');
    expect(JSON.stringify(s)).not.toContain('250000');
  });

  it('caducidad DERIVADA: una verificación vieja envejece a `stale` sin que nadie la persista', async () => {
    configExterna();
    producto({ metaSyncState: 'verified', metaVerifiedAt: Timestamp.fromMillis(Date.now() - 25 * 60 * 60 * 1000) });
    expect((await metaDriftProjection.snapshots('t1', ['p1']))[0]?.state).toBe('stale');
  });

  it('verificado dentro del TTL ⇒ `verified`: el camino sigue habilitado', async () => {
    configExterna();
    producto({ metaSyncState: 'verified', metaVerifiedAt: Timestamp.now() });
    expect((await metaDriftProjection.snapshots('t1', ['p1']))[0]?.state).toBe('verified');
  });

  it('producto SIN identidad remota ⇒ nadie de afuera lo gobierna: el precio local es la verdad', async () => {
    configExterna();
    docs.set(P1, { id: 'p1', name: 'Solo local' });
    expect(await metaDriftProjection.snapshots('t1', ['p1'])).toEqual([{ productId: 'p1', externalFields: [], state: null }]);
  });

  it('producto inexistente ⇒ snapshot inerte, jamás una excepción en el camino del cliente', async () => {
    configExterna();
    expect(await metaDriftProjection.snapshots('t1', ['fantasma'])).toEqual([{ productId: 'fantasma', externalFields: [], state: null }]);
  });
});

/**
 * APAGAR NUESTRA SINCRONIZACIÓN NO APAGA LA HONESTIDAD.
 *
 * El interruptor (`enabled`/`mode`/`catalogId`) responde «¿mandamos NOSOTROS algo a Meta?».
 * La propiedad responde «¿manda alguien de AFUERA sobre estos campos?». Mezclarlas hacía que
 * poner `mode:'off'` dejara el guard inerte: el feed del tenant seguía publicando ₲130.000 y el
 * bot volvía a cotizar ₲250.000 como confirmado, sin una sola alerta.
 */
describe('meta/catalogDriftProjection — la propiedad no depende del interruptor de sync', () => {
  const bloqueoDePrecio = [{ productId: 'p1', productName: 'Odyssey', reason: 'drifted_external', fields: ['price'] }];

  /** Camino REAL de punta a punta: guard cableado con la proyección de verdad. */
  const veredictoDeOdyssey = async () => {
    setDriftProjection(metaDriftProjection);
    producto({ name: 'Odyssey', metaDrift: { fields: ['price'], owner: 'external', severity: 'commercial', observed: [] } });
    return evaluarDerivaSiAplica('t1', [{ id: 'p1', name: 'Odyssey' }]);
  };

  it('mode:"off" con el feed reconocido ⇒ el guard SIGUE bloqueando', async () => {
    configExterna(TODOS, { mode: 'off' });
    expect(await metaDriftProjection.activa('t1')).toBe(true);
    expect((await veredictoDeOdyssey()).bloqueantes).toEqual(bloqueoDePrecio);
  });

  it('enabled:false con el feed reconocido ⇒ el guard SIGUE bloqueando', async () => {
    configExterna(TODOS, { enabled: false });
    expect(await metaDriftProjection.activa('t1')).toBe(true);
    expect((await veredictoDeOdyssey()).bloqueantes).toEqual(bloqueoDePrecio);
  });

  it('catalogId inválido (nivel 1 apagado) tampoco borra el gobierno externo', async () => {
    // Que no sepamos a qué catálogo escribir no cambia quién publica el catálogo allá afuera.
    configExterna(TODOS, { catalogId: 'no válido / con espacios' });
    expect(await metaDriftProjection.activa('t1')).toBe(true);
    expect((await veredictoDeOdyssey()).bloqueantes).toEqual(bloqueoDePrecio);
  });

  it('sin config ⇒ guard INERTE (credipower no cambia en nada)', async () => {
    setDriftProjection(metaDriftProjection);
    producto({ name: 'Odyssey', metaDrift: { fields: ['price'], owner: 'external', severity: 'commercial', observed: [] } });
    expect(await metaDriftProjection.activa('t1')).toBe(false);
    expect(await evaluarDerivaSiAplica('t1', [{ id: 'p1', name: 'Odyssey' }])).toEqual({ bloqueantes: [], advertencias: [] });
  });

  it('config inválida o propiedad sin declarar ⇒ guard INERTE (nadie declaró gobierno externo)', async () => {
    // `catalogSync` que ni siquiera es un objeto.
    docs.set(CONFIG, { catalogSync: 'no es un objeto' });
    expect(await metaDriftProjection.activa('t1')).toBe(false);
    // Propiedad malformada (modelo desconocido).
    docs.set(CONFIG, { catalogSync: { enabled: true, mode: 'dry_run', catalogId: 'abc', ownership: { model: 'lo_que_sea' } } });
    expect(await metaDriftProjection.activa('t1')).toBe(false);
    // `external_managed` SIN fuente reconocida por una persona: declaración vacía, no permiso.
    docs.set(CONFIG, { catalogSync: { enabled: true, mode: 'dry_run', catalogId: 'abc', ownership: { model: 'external_managed', ownedFields: [] } } });
    expect(await metaDriftProjection.activa('t1')).toBe(false);
    expect(await metaDriftProjection.snapshots('t1', ['p1'])).toEqual([]);
  });
});

/**
 * ¿QUIÉN ESTÁ PUBLICADO AFUERA? (hallazgo del review adversarial)
 *
 * Es la pregunta con la que el guard acota su fail-closed cuando la lectura de deriva se cae. Dos
 * propiedades la hacen usable ahí y las dos se prueban acá:
 *  · se contesta con los PRODUCTOS, no con `config/meta` — que es justo la lectura que falló, y
 *    cuya respuesta es fail-SAFE en todos lados (usarla dejaría el guard inerte en el parpadeo);
 *  · usa EXACTAMENTE el mismo criterio de identidad remota que `snapshots`, así que responde lo
 *    mismo que habría respondido la lectura normal si hubiera funcionado.
 */
describe('meta/catalogDriftProjection — identidad remota (fallback del fail-closed)', () => {
  const P2 = 'tenants/t1/products/p2';

  it('devuelve SOLO los que están mapeados a un artículo; el local puro y el inexistente quedan afuera', async () => {
    configExterna();
    producto(); // p1: mapeado por metaProductItemId
    docs.set(P2, { id: 'p2', name: 'Solo local' });
    expect(await metaDriftProjection.conIdentidadRemota!('t1', ['p1', 'p2', 'fantasma'])).toEqual(['p1']);
  });

  it.each([
    ['metaRetailerId', { metaRetailerId: 'SKU-1' }],
    ['metaProductItemId', { metaProductItemId: 'item-1' }],
    ['metaSyncState', { metaSyncState: 'unverifiable' }],
  ])('cuenta como publicado con SOLO %s (mismo criterio que `snapshots`)', async (_señal, campos) => {
    configExterna();
    docs.set(P1, { id: 'p1', name: 'Aurora Nocturna', ...campos });
    expect(await metaDriftProjection.conIdentidadRemota!('t1', ['p1'])).toEqual(['p1']);
    // Y el snapshot normal lo trata igual: gobernado (no `externalFields: []`).
    expect((await metaDriftProjection.snapshots('t1', ['p1']))[0]?.externalFields.length).toBeGreaterThan(0);
  });

  it('NO lee la config del tenant: la respuesta no depende de lo que se acaba de caer', async () => {
    // Sin `config/meta` (credipower) la respuesta sigue siendo honesta y no cuesta esa lectura.
    docs.set(P1, { id: 'p1', name: 'Solo local' });
    lecturas.length = 0;
    expect(await metaDriftProjection.conIdentidadRemota!('t1', ['p1'])).toEqual([]);
    expect(lecturasDeConfig()).toBe(0);
  });
});

/**
 * COSTURA DE FALLA INYECTADA (solo emulador). El E2E necesita que la LECTURA de la proyección
 * FALLE de verdad para probar la diferencia entre "leí y no hay deriva" y "no pude leer si la
 * hay" — que es la que hace fallar CERRADO al camino que compromete plata. Fuera del emulador
 * tiene que ser un no-op que no cueste ni una lectura.
 */
describe('meta/catalogDriftProjection — falla inyectada solo-emulador', () => {
  const FIXTURE = 'tenants/t1/_debug/driftFixtures';

  it('sin FUNCTIONS_EMULATOR no lee el fixture ni lanza (producción intacta)', async () => {
    configExterna();
    producto();
    docs.set(FIXTURE, { failAt: ['activa', 'snapshots'] });
    lecturas.length = 0;
    expect(await metaDriftProjection.activa('t1')).toBe(true);
    expect((await metaDriftProjection.snapshots('t1', ['p1']))[0]?.state).toBe('drifted_external');
    expect(lecturas).not.toContain(FIXTURE);
  });

  it('en emulador, con el fixture pedido, la lectura FALLA (y sin fixture no cambia nada)', async () => {
    const previo = process.env.FUNCTIONS_EMULATOR;
    process.env.FUNCTIONS_EMULATOR = 'true';
    try {
      configExterna();
      producto();
      // Sin fixture: comportamiento idéntico al de siempre.
      expect(await metaDriftProjection.activa('t1')).toBe(true);
      docs.set(FIXTURE, { failAt: 'snapshots' });
      await expect(metaDriftProjection.snapshots('t1', ['p1'])).rejects.toThrow(/proyección de deriva/i);
      expect(await metaDriftProjection.activa('t1')).toBe(true); // el punto pedido es UNO solo
      docs.set(FIXTURE, { failAt: ['activa'] });
      await expect(metaDriftProjection.activa('t1')).rejects.toThrow(/proyección de deriva/i);
      expect((await metaDriftProjection.snapshots('t1', ['p1']))[0]?.state).toBe('drifted_external');
    } finally {
      if (previo === undefined) delete process.env.FUNCTIONS_EMULATOR;
      else process.env.FUNCTIONS_EMULATOR = previo;
    }
  });

  /**
   * El escenario COMPLETO del hallazgo, con la proyección REAL cableada al guard: la lectura de
   * deriva se cae de verdad (no devuelve vacío) y el camino que crea la orden decide con la única
   * lectura que sí responde.
   */
  it('la lectura de deriva se CAE: sin nada publicado no se frena, con algo publicado sí, y sin poder saberlo se frena todo', async () => {
    const previo = process.env.FUNCTIONS_EMULATOR;
    process.env.FUNCTIONS_EMULATOR = 'true';
    try {
      setDriftProjection(metaDriftProjection);
      const CARRITO = [{ id: 'p1', name: 'Solo local' }];
      docs.set(FIXTURE, { failAt: 'snapshots' });

      // 1) Tenant SIN config (credipower) y producto sin identidad remota: el pedido sigue.
      docs.set(P1, { id: 'p1', name: 'Solo local' });
      expect(await leerDeriva('t1', CARRITO, { failClosed: true })).toEqual({ bloqueantes: [], advertencias: [] });

      // 2) Gobernado de afuera y PUBLICADO: se mantiene el fail-closed (no nace la orden).
      configExterna();
      producto({ name: 'Solo local' });
      const v = await leerDeriva('t1', CARRITO, { failClosed: true });
      expect(v.bloqueantes.map((b) => b.reason)).toEqual(['unverifiable']);

      // 3) Si TAMPOCO se puede leer quién está publicado, se frena igual (sobre lo consultado).
      docs.set(FIXTURE, { failAt: ['snapshots', 'identidad'] });
      docs.set(P1, { id: 'p1', name: 'Solo local' });
      expect((await leerDeriva('t1', CARRITO, { failClosed: true })).bloqueantes).toHaveLength(1);
    } finally {
      if (previo === undefined) delete process.env.FUNCTIONS_EMULATOR;
      else process.env.FUNCTIONS_EMULATOR = previo;
    }
  });
});

/**
 * COSTO DEL CAMINO CALIENTE. `activa` y `snapshots` son la misma evaluación: preguntar dos veces
 * por la propiedad del tenant era una lectura de Firestore de más en cada búsqueda del bot.
 * El memo vive DENTRO del ámbito y muere con él — no es un cache con TTL, porque la propiedad
 * decide si se puede afirmar un precio y servirla vieja sería mentir barato.
 */
describe('meta/catalogDriftProjection — memo acotado a una evaluación', () => {
  it('una evaluación completa lee la propiedad UNA sola vez', async () => {
    configExterna();
    producto();
    lecturas.length = 0;
    await metaDriftProjection.enAmbito!(async () => {
      expect(await metaDriftProjection.activa('t1')).toBe(true);
      await metaDriftProjection.snapshots('t1', ['p1']);
    });
    expect(lecturasDeConfig()).toBe(1);
    // COSTO QUE QUEDA, medido a propósito: la lectura por producto consultado sigue existiendo.
    expect(lecturas.filter((p) => p === P1)).toHaveLength(1);
  });

  it('el guard cablea el ámbito: `evaluarDerivaSiAplica` no paga la propiedad dos veces', async () => {
    configExterna();
    producto({ metaDrift: { fields: ['price'], owner: 'external', severity: 'commercial', observed: [] } });
    setDriftProjection(metaDriftProjection);
    lecturas.length = 0;
    const v = await evaluarDerivaSiAplica('t1', [{ id: 'p1', name: 'Odyssey' }]);
    expect(v.bloqueantes).toHaveLength(1); // el ámbito NO puede dejar el guard inerte
    expect(lecturasDeConfig()).toBe(1);
  });

  it('el memo muere con el ámbito: la evaluación siguiente vuelve a leer la propiedad', async () => {
    configExterna();
    producto();
    await metaDriftProjection.enAmbito!(async () => {
      await metaDriftProjection.activa('t1');
      await metaDriftProjection.activa('t1');
    });
    // Se revoca la propiedad entre evaluaciones: la siguiente TIENE que verlo.
    docs.delete(CONFIG);
    expect(await metaDriftProjection.activa('t1')).toBe(false);
  });

  it('fuera de un ámbito no hay memo: quien llama directo lee fresco', async () => {
    configExterna();
    producto();
    lecturas.length = 0;
    await metaDriftProjection.activa('t1');
    await metaDriftProjection.snapshots('t1', ['p1']);
    expect(lecturasDeConfig()).toBe(2);
  });
});
