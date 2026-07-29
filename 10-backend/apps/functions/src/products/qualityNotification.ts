/**
 * products/qualityNotification.ts — Campana AGREGADA del centro de calidad
 * ========================================================================
 * (META-CATALOG-GENERIC-ONBOARDING-QUALITY-1) UNA sola notificación viva por tenant con el
 * resumen de calidad del catálogo. Sigue el patrón de idempotencia de la campana existente
 * (id determinístico = dedupeKey, como `handoff-...` en conversation/handoff.ts y el job de
 * trial), pero con la actualización/autocierre que esos flujos create-only no necesitan:
 *
 *  - el contador se REFRESCA sobre el MISMO doc (set merge server-side; el cliente solo
 *    puede tocar read/readAt por rules);
 *  - si aparecen bloqueos NUEVOS después de leída, se REABRE (read:false);
 *  - cuando blocking+warning llegan a 0, se AUTOCIERRA (read:true + resolvedAt) — jamás
 *    se borra: el historial de que hubo un problema y se resolvió vale.
 *
 * Best-effort SIEMPRE: un fallo acá jamás rompe el guardado del producto ni el import.
 */

import { Timestamp } from 'firebase-admin/firestore';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';

/** Tope de las queries de agregado: suficiente para el panel, honesto si se supera. */
const MAX_COUNT = 500;

export interface CatalogQualityAggregate {
  /** Productos con al menos un BLOCKING activo (topeado en MAX_COUNT). */
  blocking: number;
  /** Productos con al menos un WARNING activo (topeado en MAX_COUNT). */
  warning: number;
  truncated: boolean;
}

/** Cuenta productos con pendientes de calidad (2 queries con select — sin traer docs). */
export async function countCatalogQuality(tenantId: string): Promise<CatalogQualityAggregate> {
  const col = db().collection(paths.products(tenantId));
  const [b, w] = await Promise.all([
    col.where('quality.blocking', '>', 0).select().limit(MAX_COUNT).get(),
    col.where('quality.warning', '>', 0).select().limit(MAX_COUNT).get(),
  ]);
  return { blocking: b.size, warning: w.size, truncated: b.size >= MAX_COUNT || w.size >= MAX_COUNT };
}

const plural = (n: number, truncated: boolean): string => `${n}${truncated ? ' o más' : ''}`;

/** Estado previo mínimo de la campana que la decisión necesita. */
export interface CatalogQualityPrev {
  blockingCount?: number;
  read?: boolean;
  createdAt?: Timestamp;
  resolvedAt?: Timestamp | null;
}

/**
 * Decisión PURA de la campana agregada (extraída para poder testearla sin Firestore):
 * dado el agregado vivo y el doc previo, devuelve el patch a escribir o null (no tocar).
 * Reglas: en 0/0 solo se AUTOCIERRA un aviso abierto (jamás se crea uno vacío); la
 * reapertura exige que los bloqueos SUBAN respecto del último aviso leído (bajar no
 * despierta a nadie). Best-effort por diseño (ADR-0014 §4b): last-writer-wins.
 */
export function decideCatalogQualityPatch(
  tenantId: string,
  agg: CatalogQualityAggregate,
  prev: CatalogQualityPrev | undefined,
  now: Timestamp,
): Record<string, unknown> | null {
  const id = `catalog-quality-${tenantId}`;
  if (agg.blocking + agg.warning === 0) {
    if (!prev || prev.resolvedAt) return null;
    return {
      read: true,
      readAt: now,
      resolvedAt: now,
      blockingCount: 0,
      warningCount: 0,
      title: '✅ Catálogo sin pendientes de calidad',
      body: 'Se resolvieron todas las observaciones del catálogo.',
    };
  }
  const title = agg.blocking > 0 ? '🛒 Tu catálogo tiene productos con bloqueos' : '🛒 Tu catálogo tiene advertencias de calidad';
  const body =
    agg.blocking > 0
      ? `${plural(agg.blocking, agg.truncated)} producto(s) con bloqueos y ${plural(agg.warning, agg.truncated)} con advertencias. Revisalos desde Catálogo para poder venderlos y sincronizarlos.`
      : `${plural(agg.warning, agg.truncated)} producto(s) con advertencias de calidad. Revisalos desde Catálogo.`;
  const reabre = !prev || (prev.read === true && agg.blocking > (prev.blockingCount ?? 0));
  return {
    id,
    tenantId,
    category: 'catalog_quality',
    type: 'catalog_quality_summary',
    title,
    body,
    dedupeKey: id,
    blockingCount: agg.blocking,
    warningCount: agg.warning,
    resolvedAt: null,
    createdAt: prev?.createdAt ?? now,
    ...(reabre ? { read: false, readAt: null } : {}),
  };
}

/**
 * Recomputa el agregado y upsertea la notificación `catalog-quality-{tenantId}`.
 * Llamar al terminar una invocación del import run y tras un productUpsert que cambió los
 * contadores del producto (aproximación barata de "cambió el agregado").
 */
export async function refreshCatalogQualityNotification(tenantId: string): Promise<void> {
  try {
    const agg = await countCatalogQuality(tenantId);
    // sourceId FIJO por tenant: la clave de idempotencia de la campana agregada.
    const id = `catalog-quality-${tenantId}`;
    const ref = db().doc(`${paths.notifications(tenantId)}/${id}`);
    const prev = (await ref.get()).data() as CatalogQualityPrev | undefined;
    const patch = decideCatalogQualityPatch(tenantId, agg, prev, Timestamp.now());
    if (patch) await ref.set(patch, { merge: true });
  } catch (e) {
    // La campana es un aviso, no un invariante: jamás rompe el flujo que la dispara.
    logger.warn('No se pudo refrescar la notificación de calidad del catálogo', {
      tenantId,
      error: e instanceof Error ? e.message.slice(0, 200) : 'desconocido',
    });
  }
}
