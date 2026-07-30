/**
 * catalog/driftGuard.ts — Guard determinístico de DERIVA del catálogo (ADR-0015 §8)
 * =================================================================================
 * Responde UNA sola pregunta, sin IA y sin red en el camino crítico: ¿podemos afirmar HOY el
 * precio, la disponibilidad o el stock de estos productos, o el dato público lo gobierna una
 * fuente externa que dice otra cosa?
 *
 * Por qué existe: para un tenant gobernado externamente el catálogo de Meta lo publica un feed
 * del propio sitio, y `metaSyncStatus:'synced'` es una afirmación sobre el PASADO que nada
 * caduca. El caso que lo motivó: un producto con precio local muy distinto del remoto y estado
 * "synced" — el bot cotizaba el local como definitivo y el checkout no revalidaba nada. La
 * corrección se hace EN EL ORIGEN que genera el feed (jamás escribiendo en Meta): mientras las
 * dos caras no coincidan, ese producto NO cierra una venta automática — se deriva a una persona.
 *
 * Reglas duras de este módulo:
 *  - NUNCA recibe ni expone valores remotos, URLs, query strings, tokens ni archivos crudos:
 *    solo NOMBRES de campo y el estado derivado. Lo que sale de acá puede loguearse tal cual.
 *  - NO decide vendibilidad: el filtro de ACTIVE/stock del catálogo queda intacto — un producto
 *    inactivo sigue sin ser ofrecible, esté o no en deriva.
 *  - Divergencias COSMÉTICAS (nombre, descripción, imagen, marca…) jamás cortan la conversación:
 *    generan advertencia administrativa.
 */

import { logger } from '../lib/logger.js';

/**
 * Eje ACTUAL del ADR-0015 §5 (proyección que CADUCA), distinto del histórico inmutable del job
 * del outbox. Lo DERIVA el reconciliador (área de reconciliación); acá se declara el contrato
 * mínimo que el guard consume para no acoplarse a su implementación.
 */
export const DRIFT_STATES = ['verified', 'drifted', 'drifted_external', 'remote_missing', 'unverifiable', 'stale'] as const;
export type DriftState = (typeof DRIFT_STATES)[number];

/**
 * Campos cuya divergencia CORTA la venta. `currency` viaja con `price`: una divergencia de
 * moneda cambia el significado del número, no es cosmética. El resto de los campos públicos
 * (title, description, brand, category, image, url) son cosméticos para la conversación.
 */
export const CAMPOS_CRITICOS = ['price', 'currency', 'availability', 'inventory'] as const;
export type CampoCritico = (typeof CAMPOS_CRITICOS)[number];
const CRITICOS = new Set<string>(CAMPOS_CRITICOS);

/** Estados en los que NO podemos afirmar el campo como confirmado (ADR-0015 §8). */
export const ESTADOS_BLOQUEANTES = ['drifted_external', 'remote_missing', 'unverifiable', 'stale'] as const;
export type DriftBlockReason = (typeof ESTADOS_BLOQUEANTES)[number];
const BLOQUEANTES = new Set<string>(ESTADOS_BLOQUEANTES);

/**
 * Lo que el derivador de estado le entrega al guard por producto. SANEADO por contrato: nombres
 * de campo y estado, nunca valores observados en el remoto.
 */
export interface ProductDriftSnapshot {
  productId: string;
  /**
   * Campos públicos que gobierna la fuente externa RECONOCIDA (`ownership.external` normalizada).
   * Vacío ⇒ el guard es inerte para ese producto: si mandamos nosotros, la deriva la resuelve el
   * sync de salida, no una derivación a humano.
   */
  externalFields: readonly string[];
  /**
   * Estado ACTUAL derivado. `null` ⇒ el derivador NO se pronunció y el guard NO corta: la
   * política de "nunca verificado" pertenece al derivador (ADR-0015 §5: `verified` solo tras una
   * lectura remota real y la caducidad se deriva en lectura). Acá no se inventa un veredicto.
   */
  state: DriftState | null;
  /** Campos con divergencia observada (solo NOMBRES). Irrelevante para los estados de "no sabemos". */
  driftedFields?: readonly string[];
}

export interface ProductoBloqueado {
  productId: string;
  productName: string;
  reason: DriftBlockReason;
  /** Campos críticos afectados (nombres del contrato público). */
  fields: CampoCritico[];
}

export interface ProductoAdvertido {
  productId: string;
  productName: string;
  /** Campos cosméticos divergentes: se avisa al equipo, jamás se corta la conversación. */
  fields: string[];
}

export interface VeredictoDeriva {
  /** No vacío ⇒ no se afirma precio/stock, no se crea orden, no se manda banco: se deriva. */
  bloqueantes: ProductoBloqueado[];
  /** Divergencia cosmética: advertencia administrativa. */
  advertencias: ProductoAdvertido[];
}

export const SIN_DERIVA: VeredictoDeriva = Object.freeze({
  bloqueantes: Object.freeze([]) as unknown as ProductoBloqueado[],
  advertencias: Object.freeze([]) as unknown as ProductoAdvertido[],
});

/** Producto tal como lo conoce el llamador (carrito / catálogo local). */
export interface ProductoConsultado {
  id: string;
  name: string;
}

/**
 * Clasificación PURA. Un snapshot corta SOLO si la fuente externa gobierna algún campo crítico
 * Y el estado dice que no lo podemos confirmar:
 *  - `drifted_external` ⇒ corta únicamente si la divergencia toca un campo crítico gobernado
 *    externamente; si solo divergen nombre/descripción/imagen ⇒ advertencia.
 *  - `remote_missing` / `unverifiable` / `stale` ⇒ no sabemos nada del remoto ⇒ corta sobre todos
 *    los campos críticos que esa fuente gobierna.
 *  - `drifted` (campo NUESTRO divergente) ⇒ no corta: eso lo arregla el sync de salida, no un
 *    humano en el chat.
 */
export function clasificarDeriva(
  snapshots: readonly ProductDriftSnapshot[],
  productos: readonly ProductoConsultado[] = [],
): VeredictoDeriva {
  const nombres = new Map(productos.map((p) => [p.id, p.name]));
  const bloqueantes: ProductoBloqueado[] = [];
  const advertencias: ProductoAdvertido[] = [];
  for (const s of snapshots) {
    if (!s || typeof s.productId !== 'string' || !s.productId) continue;
    const nombre = nombres.get(s.productId) ?? s.productId;
    const externos = Array.isArray(s.externalFields) ? s.externalFields.filter((f): f is string => typeof f === 'string') : [];
    if (!externos.length) continue; // no lo gobierna una fuente externa ⇒ guard inerte
    const criticosExternos = CAMPOS_CRITICOS.filter((c) => externos.includes(c));
    const divergentes = (Array.isArray(s.driftedFields) ? s.driftedFields : []).filter((f): f is string => typeof f === 'string');
    const estado = typeof s.state === 'string' ? s.state : null;

    if (estado && BLOQUEANTES.has(estado)) {
      // `drifted_external` se limita a lo que REALMENTE divergió; los estados de "no sabemos"
      // (remote_missing / unverifiable / stale) alcanzan a todo lo que la fuente gobierna.
      const afectados =
        estado === 'drifted_external'
          ? criticosExternos.filter((c) => divergentes.includes(c))
          : criticosExternos;
      if (afectados.length) {
        bloqueantes.push({ productId: s.productId, productName: nombre, reason: estado as DriftBlockReason, fields: afectados });
        continue;
      }
    }
    // Todo lo demás que divergió y no es crítico: se avisa al equipo, no se corta.
    const cosmeticos = divergentes.filter((f) => !CRITICOS.has(f));
    if (cosmeticos.length) advertencias.push({ productId: s.productId, productName: nombre, fields: cosmeticos });
  }
  return { bloqueantes, advertencias };
}

/**
 * COSTURA INYECTABLE (tipada) del derivador de estado. El eje ACTUAL (`metaSyncState` +
 * `metaDrift` + caducidad derivada por TTL) lo construye la reconciliación; este módulo no lo
 * reimplementa ni lo importa: lo recibe. Sin proyección cableada el guard queda INERTE — cero
 * cambios de comportamiento para cualquier tenant (incluido uno sin config de sync).
 *
 * Dos operaciones a propósito:
 *  - `activa`: pregunta BARATA por tenant ("¿alguien de afuera gobierna un campo comercial acá?").
 *    Los llamadores la consultan ANTES de resolver productos, así un tenant sin gobierno externo
 *    no paga ni una lectura de catálogo de más.
 *  - `snapshots`: recibe SOLO ids y devuelve SOLO nombres de campo + estado. Por contrato no
 *    puede filtrar valores remotos, URLs firmadas ni credenciales hacia la conversación.
 */
export interface DriftProjection {
  activa: (tenantId: string) => Promise<boolean>;
  snapshots: (tenantId: string, productIds: readonly string[]) => Promise<readonly ProductDriftSnapshot[]>;
  /**
   * OPCIONAL — subconjunto de `productIds` que HOY tiene IDENTIDAD REMOTA (está mapeado a un
   * artículo publicado). Es la única pregunta que queda cuando `snapshots` falla en el camino
   * fail-closed, y existe para acotar ese fail-closed a lo que de verdad puede ser contradicho:
   * un producto que nadie publicó afuera no tiene una segunda cara que pueda decir otra cosa, así
   * que su precio local es la única verdad ESTÉ COMO ESTÉ CONFIGURADO EL TENANT.
   *
   * Por qué NO se resuelve preguntando si el tenant tiene gobierno externo: esa pregunta es
   * fail-SAFE (ante un error responde "no aplica"), así que usarla como pre-gate del camino con
   * plata dejaría el guard INERTE justo cuando Firestore parpadea — el error transitorio crearía
   * la orden al precio equivocado, que es mucho peor que frenar de más. Esta pregunta, en cambio,
   * es una lectura DISTINTA de la que falló (los productos, no la config del tenant) y su
   * respuesta desconocida sigue siendo conservadora: si tampoco se puede leer, se bloquea todo.
   *
   * Devuelve SOLO ids: de acá no sale ni un valor remoto ni una URL, igual que `snapshots`.
   */
  conIdentidadRemota?: (tenantId: string, productIds: readonly string[]) => Promise<readonly string[]>;
  /**
   * OPCIONAL — ámbito de UNA evaluación. `activa` y `snapshots` preguntan por la misma propiedad
   * con milisegundos de diferencia, y sin un ámbito la proyección no tiene forma de saber que las
   * dos preguntas pertenecen al mismo pedido: paga la lectura dos veces. Acá se le da esa costura
   * para que memoice lo que leyó y lo TIRE al salir.
   *
   * A propósito NO es un cache: no hay TTL ni estado que sobreviva a la evaluación, porque la
   * propiedad decide si se puede afirmar un precio y servirla vieja sería mentir barato.
   * Es solo una optimización: si la proyección no lo implementa, se evalúa igual.
   */
  enAmbito?: <T>(fn: () => Promise<T>) => Promise<T>;
}

let proyeccion: DriftProjection | null = null;

/** Cablea la proyección real. `null` restaura el estado inerte (default y tests). */
export function setDriftProjection(p: DriftProjection | null): void {
  proyeccion = p;
}

/** ¿Hay proyección cableada? Gate sincrónico y gratis del camino caliente. */
export function driftGuardCableado(): boolean {
  return proyeccion !== null;
}

/**
 * ¿El guard aplica a ESTE tenant hoy? Barato y fail-safe: cualquier error responde `false`
 * (un parpadeo de la config no puede dejar mudo al bot; el precio cobrado sigue siendo el local).
 */
export async function derivaActivaPara(tenantId: string): Promise<boolean> {
  if (!proyeccion) return false;
  try {
    return await proyeccion.activa(tenantId);
  } catch {
    logger.warn('Deriva de catálogo: no se pudo evaluar el gobierno externo del tenant', { tenantId });
    return false;
  }
}

export interface LeerDerivaOpts {
  /**
   * ¿Un fallo de LECTURA de la proyección equivale a "no hay deriva"?
   *
   * `false` (default, camino CONVERSACIONAL): sí. Un parpadeo de Firestore no puede dejar mudo al
   * bot; el peor caso es una respuesta de más, no un pedido cobrado a ciegas.
   *
   * `true` (camino que CREA LA ORDEN, ADR-0015 §8): NO. "No hay deriva" y "no pude leer si la hay"
   * son cosas distintas y confundirlas hacía fallar ABIERTO justo donde nace el compromiso
   * comercial. Con esto, un error de proyección devuelve `unverifiable` sobre lo consultado: no se
   * crea la orden, no salen datos bancarios y se deriva con una explicación honesta.
   *
   * ACOTADO a lo que puede ser contradicho (ver `conIdentidadRemota`): el fail-closed alcanza a los
   * productos que están publicados afuera, no al carrito entero de un tenant que jamás publicó un
   * artículo. Si la respuesta a esa segunda pregunta tampoco se puede obtener, se bloquea todo.
   */
  failClosed?: boolean;
}

/** No pudimos leer la proyección: el estado honesto es "no lo podemos verificar", no "está todo bien". */
function veredictoNoVerificable(productos: readonly ProductoConsultado[]): VeredictoDeriva {
  const vistos = new Set<string>();
  const bloqueantes: ProductoBloqueado[] = [];
  for (const p of productos) {
    if (!p?.id || vistos.has(p.id)) continue;
    vistos.add(p.id);
    bloqueantes.push({ productId: p.id, productName: p.name || p.id, reason: 'unverifiable', fields: [...CAMPOS_CRITICOS] });
  }
  return { bloqueantes, advertencias: [] };
}

/**
 * ¿Cuáles de estos productos PUEDEN ser contradichos por algo publicado afuera? Se usa SOLO cuando
 * la lectura de la proyección ya falló y el llamador es fail-closed.
 *
 * `null` ⇒ no se pudo saber (la proyección no ofrece la pregunta, la segunda lectura también se
 * cayó, o contestó una forma que no es una lista): el llamador tiene que seguir siendo
 * conservador. Una lista vacía, en cambio, es una respuesta REAL: ninguno está publicado.
 */
async function idsConIdentidadRemota(tenantId: string, ids: readonly string[]): Promise<Set<string> | null> {
  const preguntar = proyeccion?.conIdentidadRemota;
  if (!preguntar) return null;
  try {
    const conId = await preguntar(tenantId, ids);
    if (!Array.isArray(conId)) return null;
    return new Set(conId.filter((x): x is string => typeof x === 'string'));
  } catch {
    // La segunda lectura tampoco respondió: "no sé" no puede volverse "está todo bien".
    return null;
  }
}

/**
 * Veredicto del camino FAIL-CLOSED cuando la proyección no se pudo leer.
 *
 * Por qué no bloquea siempre todo: "no pude leer la deriva" no obliga a frenar un producto que
 * NADIE publicó afuera. Sin identidad remota no hay una segunda cara del artículo que pueda
 * contradecir el precio local, así que el veredicto honesto es "sin deriva" — exactamente lo mismo
 * que habría devuelto la lectura si hubiera funcionado (la proyección le da `externalFields: []` a
 * los productos sin identidad y la clasificación los ignora). No es una excepción al fail-closed:
 * es la MISMA regla contestada con la única lectura que sí respondió.
 *
 * Lo que esto arregla: un tenant sin gobierno externo (credipower) más un `DEADLINE_EXCEEDED`
 * transitorio bloqueaba el carrito entero y derivaba a una persona, en un tenant que no tiene un
 * solo artículo publicado en Meta.
 */
async function veredictoFailClosed(
  tenantId: string,
  productos: readonly ProductoConsultado[],
  ids: readonly string[],
): Promise<VeredictoDeriva> {
  const conId = await idsConIdentidadRemota(tenantId, ids);
  const alcanzados = conId ? productos.filter((p) => conId.has(p.id)) : productos;
  if (!alcanzados.length) {
    logger.warn('Deriva de catálogo: la proyección no se pudo leer, pero ningún producto está publicado afuera — nada puede contradecir el precio local', {
      tenantId,
      productos: ids.length,
    });
    return SIN_DERIVA;
  }
  logger.warn('Deriva de catálogo: la proyección no se pudo leer — fail-CLOSED (no se afirma nada)', {
    tenantId,
    productos: ids.length,
    alcanzados: alcanzados.length,
    // `null` = ni siquiera se pudo saber quién está publicado ⇒ alcanza a todo lo consultado.
    identidadConocida: conId !== null,
  });
  return veredictoNoVerificable(alcanzados);
}

/**
 * Lee la deriva de un conjunto acotado de productos y la clasifica. NUNCA lanza. Qué hace ante un
 * fallo de lectura depende de `opts.failClosed` (ver arriba): el chat sigue conversando, el
 * checkout frena sobre lo que alguien de afuera puede estar publicando distinto. Sin proyección
 * cableada el resultado es SIN_DERIVA en ambos casos — un tenant que jamás enchufó esto
 * (credipower) no cambia en nada.
 */
export async function leerDeriva(
  tenantId: string,
  productos: readonly ProductoConsultado[],
  opts: LeerDerivaOpts = {},
): Promise<VeredictoDeriva> {
  const ids = [...new Set(productos.map((p) => p.id).filter((id) => typeof id === 'string' && !!id))];
  if (!ids.length || !proyeccion) return SIN_DERIVA;
  try {
    const snaps = await proyeccion.snapshots(tenantId, ids);
    return clasificarDeriva(Array.isArray(snaps) ? snaps : [], productos);
  } catch {
    if (opts.failClosed) return veredictoFailClosed(tenantId, productos, ids);
    logger.warn('Deriva de catálogo: la proyección no se pudo leer — se sigue sin veredicto', { tenantId, productos: ids.length });
    return SIN_DERIVA;
  }
}

/**
 * Gate COMPLETO para cualquier camino que esté por AFIRMARLE un precio o una disponibilidad al
 * cliente: cableado → tenant → lectura. Existe para que ningún llamador tenga que acordarse de la
 * secuencia (el hallazgo original fue justamente eso: caminos que cotizaban sin preguntar). Sin
 * proyección cableada, sin productos en juego o sin gobierno externo no cuesta ni una lectura.
 */
export async function evaluarDerivaSiAplica(
  tenantId: string,
  productos: readonly ProductoConsultado[],
): Promise<VeredictoDeriva> {
  const p = proyeccion;
  if (!p || !productos.length) return SIN_DERIVA;
  const evaluar = (): Promise<VeredictoDeriva> =>
    derivaActivaPara(tenantId).then((activa) => (activa ? leerDeriva(tenantId, productos) : SIN_DERIVA));
  try {
    // Las dos preguntas ("¿aplica acá?" y "¿qué pasa con estos productos?") son UNA evaluación:
    // se corren dentro del ámbito de la proyección para no pagar dos veces la misma lectura.
    return p.enAmbito ? await p.enAmbito(evaluar) : await evaluar();
  } catch {
    // `evaluar` no lanza; el ámbito es código ajeno a este módulo. Que una optimización rompa el
    // camino conversacional sería peor que el costo que ahorra: se sigue sin veredicto, igual que
    // ante un parpadeo de lectura (el camino que CREA LA ORDEN usa `leerDeriva` con failClosed).
    logger.warn('Deriva de catálogo: la evaluación falló — se sigue sin veredicto', { tenantId, productos: productos.length });
    return SIN_DERIVA;
  }
}

/**
 * Saca de una LISTA A MOSTRAR los productos cuyo precio/disponibilidad no podemos afirmar hoy.
 *
 * Por qué EXCLUIR y no derivar acá: un listado es una respuesta a una búsqueda genérica ("mostrame
 * algo dulce"), no una pregunta por un producto puntual. Sacarlo es exactamente lo que ya hace el
 * catálogo con lo inactivo o sin stock — el cliente sigue comprando lo demás y nadie corta la
 * conversación por un artículo entre 181. Cuando el cliente NOMBRA el producto, el guard del motor
 * lo agarra antes y ahí sí se deriva a una persona, que es lo honesto.
 */
export async function filtrarOfrecibles<T extends ProductoConsultado>(
  tenantId: string,
  productos: readonly T[],
): Promise<T[]> {
  const veredicto = await evaluarDerivaSiAplica(tenantId, productos);
  if (!veredicto.bloqueantes.length) return [...productos];
  const fuera = new Set(veredicto.bloqueantes.map((b) => b.productId));
  logger.warn('Deriva de catálogo: productos excluidos del listado (no se puede afirmar su precio)', {
    tenantId,
    ...resumenSaneado(veredicto),
  });
  return productos.filter((p) => !fuera.has(p.id));
}

/** Resumen SANEADO para logs/avisos: ids, campos y estado; jamás valores ni fuentes crudas. */
export function resumenSaneado(v: VeredictoDeriva): { productos: number; campos: string[]; estados: string[] } {
  return {
    productos: v.bloqueantes.length,
    campos: [...new Set(v.bloqueantes.flatMap((b) => b.fields))].sort(),
    estados: [...new Set(v.bloqueantes.map((b) => b.reason))].sort(),
  };
}
