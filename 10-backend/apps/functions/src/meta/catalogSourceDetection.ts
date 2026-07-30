/**
 * meta/catalogSourceDetection.ts — Huella y comparación de FUENTES EXTERNAS (ADR-0015 §4)
 * =======================================================================================
 * El cliente (`catalogClient.listDataSources`) ya devuelve metadata SANEADA. Acá se decide lo
 * único que importa después: **¿la fuente que gobierna el catálogo sigue siendo la que un
 * humano reconoció?** Para eso:
 *
 *  - `catalogSourceFingerprint`: huella estable de la observación, calculada SOLO sobre datos
 *    no secretos —identificadores, host sin query, horario y columnas declaradas (ADR-0015 §4)—.
 *    Deliberadamente NO entra el nombre del feed (cambiarle la etiqueta no cambia quién manda),
 *    ni `detectedAt` (haría que cada verificación pareciera un cambio).
 *  - `compareCatalogSources`: función PURA que devuelve `sin_cambios` | `fuente_nueva` |
 *    `fingerprint_cambiado` con los ids afectados. Fuente desconocida o huella distinta ⇒ los
 *    gates outbound bloquean; nunca se desactiva un feed ni se cambia el modelo automáticamente.
 *  - persistencia en `tenants/{t}/metaCatalogSourceChecks/{checkId}`, cerrada al cliente por
 *    Rules, con el id DERIVADO de la huella: la misma observación repetida actualiza el mismo
 *    documento (alerta agregada e idempotente) y un cambio real abre uno nuevo.
 *
 * PRIVACIDAD: acá no entra nada crudo. Antes de escribir se vuelve a correr
 * `assertSanitizedSource` sobre cada fuente — la última barrera antes de Firestore.
 */

import { Timestamp } from 'firebase-admin/firestore';
import { db, paths } from '../lib/firebase.js';
import { assertSanitizedSource, type CatalogSourcesObservation, type SanitizedCatalogSource } from './catalogClient.js';
import { stableHash } from './catalogOutbox.js';

/** Versión de la huella: cambiarla invalida a propósito todos los reconocimientos previos. */
export const SOURCE_FINGERPRINT_VERSION = 1;

/**
 * Huella de UNA fuente. Solo los cuatro insumos del ADR: identificador, host, horario y
 * columnas. Un cambio de nombre o de fecha de creación no la mueve; un cambio de host, de
 * horario o de columnas sí, porque son los que cambian QUÉ se publica y desde dónde.
 */
export function catalogSourceFingerprintOne(s: SanitizedCatalogSource): string {
  return stableHash({
    v: SOURCE_FINGERPRINT_VERSION,
    sourceId: s.sourceId,
    host: s.host,
    schedule: s.schedule,
    fields: [...s.detectedFields].sort(),
  });
}

/**
 * Huella del CONJUNTO a partir de las huellas individuales YA calculadas. Es la ÚNICA
 * definición de "huella del conjunto" del sistema: la migración (que trabaja con la vista
 * saneada `MetaCatalogDetectedSource`, no con la del cliente) la reusa tal cual. Con dos
 * definiciones, lo que la migración RECONOCE y lo que el gate OBSERVA nunca coincidirían y
 * cada verificación reportaría `fingerprint_cambiado` sobre un feed que no cambió — un
 * bloqueo permanente indistinguible de uno real.
 *
 * Ordenada por id: el orden en que responde Meta no importa. Devuelve un hash de largo fijo,
 * así que no depende de cuántos feeds tenga el catálogo (concatenar huellas se truncaría).
 */
export function catalogSourceSetFingerprint(parts: ReadonlyArray<{ sourceId: string; fingerprint: string }>): string {
  const partes = parts
    .map((s) => ({ sourceId: s.sourceId, huella: s.fingerprint }))
    .sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
  return stableHash({ v: SOURCE_FINGERPRINT_VERSION, sources: partes });
}

/** Huella del CONJUNTO de fuentes observadas por el cliente. */
export function catalogSourceFingerprint(sources: readonly SanitizedCatalogSource[]): string {
  return catalogSourceSetFingerprint(sources.map((s) => ({ sourceId: s.sourceId, fingerprint: catalogSourceFingerprintOne(s) })));
}

export type CatalogSourceCheckStatus = 'sin_cambios' | 'fuente_nueva' | 'fingerprint_cambiado';

/**
 * Lo que un humano reconoció (vive en `ownership.external`). `sources` es opcional: si se pasa
 * la metadata saneada de la última verificación reconocida, el comparador puede decir QUÉ id
 * cambió; sin ella solo puede decir que el conjunto cambió.
 */
export interface AcknowledgedSourceRef {
  acknowledgedSourceIds: readonly string[];
  fingerprint: string;
  sources?: readonly SanitizedCatalogSource[];
}

export interface CatalogSourceComparison {
  status: CatalogSourceCheckStatus;
  /** Huella observada ahora. */
  fingerprint: string;
  acknowledgedFingerprint: string | null;
  /** Observadas que NADIE reconoció. */
  newSourceIds: string[];
  /** Reconocidas cuya huella individual cambió (host, horario o columnas). */
  changedSourceIds: string[];
  /** Reconocidas que ya no aparecen en el catálogo. */
  missingSourceIds: string[];
  /** Unión ordenada de las tres: lo que hay que mirar. */
  affectedSourceIds: string[];
  /** El listado pudo quedar incompleto ⇒ no se puede afirmar que no haya una fuente oculta. */
  incompleteListing: boolean;
}

const ordenados = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

/**
 * Compara lo observado contra lo reconocido. PURA: no lee config, no escribe, no llama a nadie.
 *
 * Precedencia deliberada: `fuente_nueva` gana sobre `fingerprint_cambiado` porque una fuente
 * que nadie reconoció es el hallazgo más grave y el más accionable. Un listado INCOMPLETO se
 * reporta también como `fuente_nueva` (con `incompleteListing`) aunque no sepamos ids: el
 * supuesto seguro es que la fuente que no llegamos a leer existe, no que no existe.
 */
export function compareCatalogSources(
  observation: CatalogSourcesObservation,
  acknowledged: AcknowledgedSourceRef | null,
): CatalogSourceComparison {
  const fingerprint = catalogSourceFingerprint(observation.sources);
  const observados = observation.sources.map((s) => s.sourceId);
  const reconocidos = new Set(acknowledged?.acknowledgedSourceIds ?? []);
  const newSourceIds = ordenados(observados.filter((id) => !reconocidos.has(id)));
  const missingSourceIds = ordenados([...reconocidos].filter((id) => !observados.includes(id)));

  // Ids que están de los dos lados y cambiaron. Con la metadata previa se identifican uno por
  // uno; sin ella solo se sabe que el conjunto cambió, así que se marcan todos los comunes —
  // impreciso pero honesto: nunca se reporta "no cambió nada" cuando la huella dice lo contrario.
  const comunes = ordenados(observados.filter((id) => reconocidos.has(id)));
  const previas = new Map((acknowledged?.sources ?? []).map((s) => [s.sourceId, catalogSourceFingerprintOne(s)]));
  const huellaDistinta = !!acknowledged && fingerprint !== acknowledged.fingerprint;
  let changedSourceIds: string[] = [];
  if (previas.size) {
    changedSourceIds = comunes.filter((id) => {
      const antes = previas.get(id);
      const ahora = observation.sources.find((s) => s.sourceId === id);
      return !!antes && !!ahora && antes !== catalogSourceFingerprintOne(ahora);
    });
  } else if (huellaDistinta && !newSourceIds.length && !missingSourceIds.length) {
    changedSourceIds = comunes;
  }

  const incompleteListing = !observation.complete;
  let status: CatalogSourceCheckStatus;
  if (incompleteListing || newSourceIds.length) status = 'fuente_nueva';
  else if (huellaDistinta || missingSourceIds.length || changedSourceIds.length) status = 'fingerprint_cambiado';
  else status = 'sin_cambios';

  return {
    status,
    fingerprint,
    acknowledgedFingerprint: acknowledged?.fingerprint ?? null,
    newSourceIds,
    changedSourceIds,
    missingSourceIds,
    affectedSourceIds: ordenados([...newSourceIds, ...changedSourceIds, ...missingSourceIds]),
    incompleteListing,
  };
}

/**
 * ¿Este resultado bloquea escrituras outbound? Cualquier cosa que no sea `sin_cambios`.
 * Se expone como función para que los gates no repitan la comparación con el literal.
 */
export const sourceCheckBlocksWrites = (status: CatalogSourceCheckStatus): boolean => status !== 'sin_cambios';

/**
 * Id DERIVADO del catálogo + la huella: la misma observación repetida cae siempre en el mismo
 * documento (la verificación periódica no infla la colección ni duplica alertas) y una fuente
 * distinta abre uno nuevo, que es justo el evento que hay que conservar.
 */
export function catalogSourceCheckId(catalogId: string, fingerprint: string): string {
  return `chk_${stableHash({ v: SOURCE_FINGERPRINT_VERSION, catalogId, fingerprint }).slice(0, 32)}`;
}

/** Documento persistido en `tenants/{t}/metaCatalogSourceChecks/{checkId}`. Todo SANEADO. */
export interface CatalogSourceCheckDoc {
  catalogId: string;
  fingerprint: string;
  acknowledgedFingerprint: string | null;
  status: CatalogSourceCheckStatus;
  incompleteListing: boolean;
  sources: SanitizedCatalogSource[];
  sourceIds: string[];
  feedCount: number | null;
  newSourceIds: string[];
  changedSourceIds: string[];
  missingSourceIds: string[];
  /** Cuántas veces se observó EXACTAMENTE esta huella (la alerta se agrega, no se duplica). */
  checkCount: number;
  firstCheckAt: Timestamp;
  lastCheckAt: Timestamp;
}

/** Construcción PURA del documento: `firstCheckAt` se conserva, `lastCheckAt` avanza. */
export function buildCatalogSourceCheckDoc(
  observation: CatalogSourcesObservation,
  comparison: CatalogSourceComparison,
  at: Timestamp,
  prev?: Pick<CatalogSourceCheckDoc, 'firstCheckAt' | 'checkCount'> | null,
): CatalogSourceCheckDoc {
  return {
    catalogId: observation.catalogId,
    fingerprint: comparison.fingerprint,
    acknowledgedFingerprint: comparison.acknowledgedFingerprint,
    status: comparison.status,
    incompleteListing: comparison.incompleteListing,
    sources: observation.sources,
    sourceIds: observation.sources.map((s) => s.sourceId).sort(),
    feedCount: observation.feedCount,
    newSourceIds: comparison.newSourceIds,
    changedSourceIds: comparison.changedSourceIds,
    missingSourceIds: comparison.missingSourceIds,
    checkCount: (prev?.checkCount ?? 0) + 1,
    firstCheckAt: prev?.firstCheckAt ?? at,
    lastCheckAt: at,
  };
}

/**
 * Persiste la verificación. Transaccional e idempotente por huella: repetirla actualiza
 * `lastCheckAt` y el contador sin crear ruido. Aislada por tenant (la ruta lleva el tenantId).
 */
export async function recordCatalogSourceCheck(args: {
  tenantId: string;
  observation: CatalogSourcesObservation;
  comparison: CatalogSourceComparison;
  now?: () => Timestamp;
}): Promise<{ checkId: string; created: boolean; checkCount: number }> {
  // ÚLTIMA BARRERA ANTES DE FIRESTORE: si algo sin sanear llegó hasta acá, no se escribe.
  for (const s of args.observation.sources) assertSanitizedSource(s);
  const checkId = catalogSourceCheckId(args.observation.catalogId, args.comparison.fingerprint);
  const ref = db().doc(paths.metaCatalogSourceCheck(args.tenantId, checkId));
  const at = (args.now ?? (() => Timestamp.now()))();
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = (snap.exists ? snap.data() : undefined) as CatalogSourceCheckDoc | undefined;
    const doc = buildCatalogSourceCheckDoc(args.observation, args.comparison, at, prev);
    tx.set(ref, doc);
    return { checkId, created: !prev, checkCount: doc.checkCount };
  });
}
