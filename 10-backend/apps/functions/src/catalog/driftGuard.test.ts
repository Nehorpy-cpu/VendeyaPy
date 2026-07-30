import { describe, it, expect, afterEach } from 'vitest';
import {
  clasificarDeriva,
  leerDeriva,
  driftGuardCableado,
  derivaActivaPara,
  evaluarDerivaSiAplica,
  filtrarOfrecibles,
  setDriftProjection,
  resumenSaneado,
  CAMPOS_CRITICOS,
  type ProductDriftSnapshot,
} from './driftGuard.js';

/**
 * ADR-0015 §8 — clasificación PURA de la deriva. El caso que lo motivó: un producto gobernado por
 * un feed externo con el precio local muy distinto del publicado y estado "synced" heredado. Nada
 * de valores remotos acá: el guard solo ve NOMBRES de campo y el estado derivado.
 */
const snap = (over: Partial<ProductDriftSnapshot> = {}): ProductDriftSnapshot => ({
  productId: 'p1',
  externalFields: ['title', 'description', 'price', 'currency', 'availability', 'inventory'],
  state: 'drifted_external',
  driftedFields: ['price'],
  ...over,
});
const PRODUCTOS = [{ id: 'p1', name: 'Producto Uno' }];

afterEach(() => setDriftProjection(null));

describe('catalog/driftGuard clasificarDeriva', () => {
  it('precio divergente en un producto gobernado externamente ⇒ BLOQUEA con el campo y la razón', () => {
    const v = clasificarDeriva([snap()], PRODUCTOS);
    expect(v.bloqueantes).toHaveLength(1);
    expect(v.bloqueantes[0]).toMatchObject({ productId: 'p1', productName: 'Producto Uno', reason: 'drifted_external', fields: ['price'] });
    expect(v.advertencias).toHaveLength(0);
  });

  it.each(['remote_missing', 'unverifiable', 'stale'] as const)(
    '%s ⇒ no sabemos NADA del remoto: bloquea sobre todos los campos críticos que gobierna la fuente',
    (state) => {
      const v = clasificarDeriva([snap({ state, driftedFields: [] })], PRODUCTOS);
      expect(v.bloqueantes[0]?.reason).toBe(state);
      expect(v.bloqueantes[0]?.fields).toEqual([...CAMPOS_CRITICOS]);
    },
  );

  it('divergencia COSMÉTICA (nombre/descripción) ⇒ advertencia administrativa, NO bloquea', () => {
    const v = clasificarDeriva([snap({ driftedFields: ['title', 'description'] })], PRODUCTOS);
    expect(v.bloqueantes).toHaveLength(0);
    expect(v.advertencias[0]).toMatchObject({ productId: 'p1', fields: ['title', 'description'] });
  });

  it('la moneda viaja con el precio: divergencia de currency ⇒ bloquea (no es cosmética)', () => {
    const v = clasificarDeriva([snap({ driftedFields: ['currency'] })], PRODUCTOS);
    expect(v.bloqueantes[0]?.fields).toEqual(['currency']);
  });

  it('sin fuente externa que gobierne (externalFields vacío) ⇒ guard INERTE, aunque el estado grite', () => {
    for (const state of ['drifted_external', 'remote_missing', 'unverifiable', 'stale'] as const) {
      const v = clasificarDeriva([snap({ externalFields: [], state })], PRODUCTOS);
      expect(v.bloqueantes).toHaveLength(0);
      expect(v.advertencias).toHaveLength(0);
    }
  });

  it('la fuente externa gobierna SOLO campos cosméticos ⇒ jamás bloquea el precio', () => {
    const v = clasificarDeriva([snap({ externalFields: ['title', 'image'], driftedFields: ['price', 'title'] })], PRODUCTOS);
    expect(v.bloqueantes).toHaveLength(0);
    expect(v.advertencias[0]?.fields).toEqual(['title']);
  });

  it('verified ⇒ el camino sigue habilitado (ambos lados coinciden tras reconciliar)', () => {
    expect(clasificarDeriva([snap({ state: 'verified', driftedFields: [] })], PRODUCTOS).bloqueantes).toHaveLength(0);
  });

  it('`drifted` (campo NUESTRO) no deriva a un humano: eso lo resuelve el sync de salida', () => {
    const v = clasificarDeriva([snap({ state: 'drifted', externalFields: ['title'], driftedFields: ['price'] })], PRODUCTOS);
    expect(v.bloqueantes).toHaveLength(0);
  });

  it('state null (el derivador no se pronunció) ⇒ NO corta: la política de "nunca verificado" es suya', () => {
    expect(clasificarDeriva([snap({ state: null, driftedFields: [] })], PRODUCTOS).bloqueantes).toHaveLength(0);
  });

  it('sin nombre local conocido cae al id (nunca undefined en el mensaje al cliente)', () => {
    expect(clasificarDeriva([snap()], []).bloqueantes[0]?.productName).toBe('p1');
  });

  it('entradas basura del derivador no rompen la clasificación (fail-safe)', () => {
    const basura = [null, undefined, {}, { productId: '' }, { productId: 'p2', externalFields: 'price', state: 'drifted_external' }];
    expect(() => clasificarDeriva(basura as never, PRODUCTOS)).not.toThrow();
    expect(clasificarDeriva(basura as never, PRODUCTOS).bloqueantes).toHaveLength(0);
  });
});

describe('catalog/driftGuard — costura inyectable', () => {
  it('sin proyección cableada el guard es INERTE: ni gate activo ni veredicto', async () => {
    expect(driftGuardCableado()).toBe(false);
    expect(await derivaActivaPara('t1')).toBe(false);
    expect(await leerDeriva('t1', PRODUCTOS)).toEqual({ bloqueantes: [], advertencias: [] });
  });

  it('cableada: recibe SOLO ids deduplicados del tenant pedido y devuelve el veredicto clasificado', async () => {
    const visto: Array<{ tenantId: string; ids: readonly string[] }> = [];
    setDriftProjection({
      activa: async () => true,
      snapshots: async (tenantId, ids) => { visto.push({ tenantId, ids }); return [snap()]; },
    });
    expect(driftGuardCableado()).toBe(true);
    const v = await leerDeriva('tenant-a', [...PRODUCTOS, { id: 'p1', name: 'Producto Uno' }]);
    expect(visto).toEqual([{ tenantId: 'tenant-a', ids: ['p1'] }]);
    expect(v.bloqueantes).toHaveLength(1);
  });

  it('el gate por tenant es fail-safe: si no se puede evaluar, el guard no interviene', async () => {
    setDriftProjection({ activa: async () => { throw new Error('config unavailable'); }, snapshots: async () => [] });
    expect(await derivaActivaPara('t1')).toBe(false);
  });

  it('un fallo de la proyección NO deja mudo al bot ni rompe el checkout: se sigue sin veredicto', async () => {
    setDriftProjection({ activa: async () => true, snapshots: async () => { throw new Error('firestore unavailable'); } });
    await expect(leerDeriva('t1', PRODUCTOS)).resolves.toEqual({ bloqueantes: [], advertencias: [] });
  });

  it('sin productos en juego no se consulta a la proyección', async () => {
    let llamado = 0;
    setDriftProjection({ activa: async () => true, snapshots: async () => { llamado += 1; return []; } });
    await leerDeriva('t1', []);
    expect(llamado).toBe(0);
  });

  it('failClosed: un fallo de la proyección NO es "no hay deriva" — devuelve unverifiable sobre lo consultado', async () => {
    setDriftProjection({ activa: async () => true, snapshots: async () => { throw new Error('firestore unavailable'); } });
    const v = await leerDeriva('t1', [...PRODUCTOS, { id: 'p2', name: 'Producto Dos' }], { failClosed: true });
    expect(v.bloqueantes.map((b) => b.productId)).toEqual(['p1', 'p2']);
    expect(v.bloqueantes[0]).toMatchObject({ reason: 'unverifiable', productName: 'Producto Uno', fields: [...CAMPOS_CRITICOS] });
  });

  it('failClosed sin proyección cableada sigue INERTE: un tenant que nunca la enchufó no cambia', async () => {
    setDriftProjection(null);
    await expect(leerDeriva('t1', PRODUCTOS, { failClosed: true })).resolves.toEqual({ bloqueantes: [], advertencias: [] });
  });

  it('el resumen para logs es SANEADO: cantidades, campos y estados — jamás valores', () => {
    const v = clasificarDeriva([snap(), snap({ productId: 'p2', state: 'stale', driftedFields: [] })], PRODUCTOS);
    const r = resumenSaneado(v);
    expect(r).toEqual({ productos: 2, campos: ['availability', 'currency', 'inventory', 'price'], estados: ['drifted_external', 'stale'] });
    expect(JSON.stringify(r)).not.toMatch(/\d{5,}/); // ni un precio se cuela
  });
});

/**
 * FAIL-CLOSED ACOTADO A LO QUE PUEDE SER CONTRADICHO (hallazgo del review adversarial).
 *
 * El fail-closed anterior alcanzaba al carrito ENTERO de cualquier tenant: un `DEADLINE_EXCEEDED`
 * transitorio en la lectura frenaba el pedido de un tenant que no tiene un solo artículo publicado
 * en Meta (credipower), contradiciendo la promesa del módulo ("un tenant que jamás enchufó esto no
 * cambia en nada").
 *
 * La tensión que NO se resuelve con la config: preguntar "¿este tenant tiene gobierno externo?"
 * como pre-gate es fail-SAFE (ante un error responde `false`), así que el mismo parpadeo que
 * disparó el fail-closed dejaría el guard INERTE y crearía la orden al precio equivocado en el
 * tenant que SÍ está gobernado de afuera. Eso es mucho peor que frenar de más.
 *
 * La señal que se usa es de los PRODUCTOS (identidad remota), una lectura distinta de la que falló:
 * sin identidad no hay artículo publicado que pueda contradecir el precio local, esté como esté
 * configurado el tenant. Y si esa segunda lectura tampoco responde, se vuelve a bloquear todo.
 */
describe('catalog/driftGuard — el fail-closed alcanza SOLO a lo publicado afuera', () => {
  const CARRITO = [
    { id: 'p1', name: 'Producto Uno' },
    { id: 'p2', name: 'Producto Dos' },
  ];
  const proyeccionCaida = (conIdentidadRemota?: (t: string, ids: readonly string[]) => Promise<readonly string[]>) =>
    setDriftProjection({
      activa: async () => true,
      snapshots: async () => { throw new Error('DEADLINE_EXCEEDED'); },
      ...(conIdentidadRemota ? { conIdentidadRemota } : {}),
    });

  it('NINGÚN producto publicado afuera ⇒ "sin deriva": el pedido sigue (credipower no cambia)', async () => {
    proyeccionCaida(async () => []);
    await expect(leerDeriva('credipower', CARRITO, { failClosed: true })).resolves.toEqual({ bloqueantes: [], advertencias: [] });
  });

  it('con identidad remota el fail-closed se mantiene: el tenant gobernado de afuera NO cierra venta', async () => {
    proyeccionCaida(async (_t, ids) => ids);
    const v = await leerDeriva('arfagi', CARRITO, { failClosed: true });
    expect(v.bloqueantes.map((b) => b.productId)).toEqual(['p1', 'p2']);
    expect(v.bloqueantes[0]).toMatchObject({ reason: 'unverifiable', fields: [...CAMPOS_CRITICOS] });
  });

  it('carrito MIXTO ⇒ el desenlace conservador cae solo sobre los que sí están publicados', async () => {
    proyeccionCaida(async (_t, ids) => ids.filter((id) => id === 'p2'));
    const v = await leerDeriva('arfagi', CARRITO, { failClosed: true });
    expect(v.bloqueantes.map((b) => b.productId)).toEqual(['p2']);
    expect(v.bloqueantes[0]?.productName).toBe('Producto Dos');
  });

  it('si la SEGUNDA lectura también se cae ⇒ se bloquea todo: "no sé" jamás es "está todo bien"', async () => {
    proyeccionCaida(async () => { throw new Error('DEADLINE_EXCEEDED'); });
    const v = await leerDeriva('arfagi', CARRITO, { failClosed: true });
    expect(v.bloqueantes.map((b) => b.productId)).toEqual(['p1', 'p2']);
  });

  it('una respuesta con forma inválida se trata como "no sé" (fail-closed), no como lista vacía', async () => {
    proyeccionCaida(async () => 'p1' as unknown as readonly string[]);
    expect((await leerDeriva('arfagi', CARRITO, { failClosed: true })).bloqueantes).toHaveLength(2);
  });

  it('una proyección SIN la pregunta (contrato viejo) sigue bloqueando todo: nadie afloja por omisión', async () => {
    proyeccionCaida();
    expect((await leerDeriva('arfagi', CARRITO, { failClosed: true })).bloqueantes).toHaveLength(2);
  });

  it('la pregunta cuesta CERO cuando no hay falla: ni en el camino feliz ni en el fail-open', async () => {
    let preguntas = 0;
    setDriftProjection({
      activa: async () => true,
      snapshots: async () => [],
      conIdentidadRemota: async (_t, ids) => { preguntas += 1; return ids; },
    });
    await leerDeriva('t1', CARRITO, { failClosed: true }); // lectura OK ⇒ no hace falta preguntar
    setDriftProjection({
      activa: async () => true,
      snapshots: async () => { throw new Error('firestore unavailable'); },
      conIdentidadRemota: async (_t, ids) => { preguntas += 1; return ids; },
    });
    await leerDeriva('t1', CARRITO); // fail-OPEN (conversacional): tampoco pregunta
    expect(preguntas).toBe(0);
  });
});

/**
 * Cobertura del guard en los caminos que MUESTRAN productos (hallazgo del review: el listado y la
 * IA seguían cotizando el precio divergente porque el guard solo miraba lo que el turno nombraba).
 */
describe('catalog/driftGuard — evaluarDerivaSiAplica / filtrarOfrecibles', () => {
  const LISTA = [
    { id: 'p1', name: 'Producto Uno' },
    { id: 'p2', name: 'Producto Dos' },
  ];

  it('el gate barato corre PRIMERO: sin gobierno externo no se consulta la deriva de ningún producto', async () => {
    let consultas = 0;
    setDriftProjection({ activa: async () => false, snapshots: async () => { consultas += 1; return []; } });
    expect(await evaluarDerivaSiAplica('t1', LISTA)).toEqual({ bloqueantes: [], advertencias: [] });
    expect(await filtrarOfrecibles('t1', LISTA)).toEqual(LISTA);
    expect(consultas).toBe(0);
  });

  it('sin productos en juego no se pregunta nada (ni el gate por tenant)', async () => {
    let gates = 0;
    setDriftProjection({ activa: async () => { gates += 1; return true; }, snapshots: async () => [] });
    expect(await evaluarDerivaSiAplica('t1', [])).toEqual({ bloqueantes: [], advertencias: [] });
    expect(gates).toBe(0);
  });

  it('el producto en deriva CRÍTICA sale del listado y el resto se sigue mostrando', async () => {
    setDriftProjection({
      activa: async () => true,
      snapshots: async (_t, ids) => ids.map((productId) => snap({ productId, ...(productId === 'p2' ? { state: 'verified', driftedFields: [] } : {}) })),
    });
    expect(await filtrarOfrecibles('t1', LISTA)).toEqual([{ id: 'p2', name: 'Producto Dos' }]);
  });

  it('la divergencia COSMÉTICA no saca a nadie del listado: se muestra igual', async () => {
    setDriftProjection({
      activa: async () => true,
      snapshots: async (_t, ids) => ids.map((productId) => snap({ productId, driftedFields: ['title', 'image'] })),
    });
    expect(await filtrarOfrecibles('t1', LISTA)).toEqual(LISTA);
  });

  it('sin proyección cableada el listado queda EXACTAMENTE como estaba (cero cambio de comportamiento)', async () => {
    setDriftProjection(null);
    expect(await filtrarOfrecibles('t1', LISTA)).toEqual(LISTA);
  });

  it('un fallo de la proyección no vacía el listado (fail-open del camino conversacional)', async () => {
    setDriftProjection({ activa: async () => true, snapshots: async () => { throw new Error('firestore unavailable'); } });
    expect(await filtrarOfrecibles('t1', LISTA)).toEqual(LISTA);
  });
});
