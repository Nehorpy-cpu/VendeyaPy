/**
 * meta/catalogSourceGate.ts — Cableado REAL de la detección de fuentes externas (ADR-0015 §4)
 * ============================================================================================
 * `catalogClient.listDataSources` sabe LEER las fuentes y devolverlas saneadas;
 * `catalogSourceDetection` sabe COMPARARLAS contra lo que un humano reconoció y persistir la
 * verificación. Faltaba el cable entre las dos y el resto del sistema: sin él, la detección
 * era una capacidad que nadie ejercía — la migración siempre reportaba `detection_unavailable`
 * (jamás podía proponer `external_managed`) y ningún camino de escritura miraba si el feed que
 * gobierna el catálogo sigue siendo el reconocido.
 *
 * Acá viven las tres piezas del cable, y nada más:
 *   1. `detectedSourceOf`  — vista del cliente → vista de la migración/panel (metadata saneada).
 *   2. `checkCatalogSources` — leer + comparar + persistir la verificación (idempotente por huella).
 *   3. `metaExternalSourceDetector` — el detector que consume la migración (`setExternalSourceDetector`).
 *   4. `alertarFuenteDelCatalogo` — campana AGREGADA e idempotente: un solo aviso vivo por tenant.
 *
 * PRIVACIDAD (invariante duro): de la URL firmada del feed no sobrevive nada más que el
 * hostname, y eso ya lo garantiza el cliente. Acá no se lee el archivo, no se reconstruye la
 * URL y no se loguea ni un fragmento de su query string. Lo único que se persiste es lo que
 * `assertSanitizedSource` deja pasar.
 *
 * ⚠️ SOLO LEE (GET). Jamás desactiva un feed, jamás cambia el modelo de propiedad y jamás
 * escribe en Meta: reconocer una fuente es una decisión humana (el apply de la migración).
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { MetaCatalogDetectedSource } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import {
  getMetaCatalogClientForTenant,
  type CatalogSourcesObservation,
  type MetaCatalogClient,
  type SanitizedCatalogSource,
} from './catalogClient.js';
import type { EffectiveOwnership } from './catalogOwnership.js';
import { setExternalSourceDetector, type ExternalSourceDetection } from './catalogOwnershipMigration.js';
import {
  catalogSourceFingerprintOne,
  compareCatalogSources,
  recordCatalogSourceCheck,
  sourceCheckBlocksWrites,
  type CatalogSourceComparison,
} from './catalogSourceDetection.js';
import { normalizeCatalogSyncConfig } from './catalogSyncConfig.js';

// ---------------------------------------------------------------------------
// 1) Vista del cliente → vista de la migración / del panel
// ---------------------------------------------------------------------------

/**
 * Horario legible del feed ('DAILY 03:33'). Texto CORTO y sin URL: es lo que se muestra y lo
 * que se persiste en el run de la migración. El horario ya viene validado por el cliente
 * (hora 0-23, minuto 0-59) — acá solo se formatea.
 */
export function scheduleLabel(s: SanitizedCatalogSource): string | null {
  const sch = s.schedule;
  if (!sch) return null;
  if (typeof sch.hour !== 'number') return sch.interval;
  const mm = typeof sch.minute === 'number' ? sch.minute : 0;
  return `${sch.interval} ${String(sch.hour).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * Traducción entre las dos vistas saneadas del mismo hecho. La huella individual se calcula
 * con `catalogSourceFingerprintOne` — la MISMA que usa el comparador — para que lo que el
 * apply reconoce sea exactamente lo que la verificación previa al POST vuelve a mirar.
 *
 * `deletesMissingItems` e `itemCount` quedan en `null` a propósito: el contrato de lectura que
 * pedimos no los expone y afirmar `false` sería inventar que el feed no borra (justo el dato
 * que más importa). `null` es "no lo sabemos", que es la verdad.
 */
export function detectedSourceOf(s: SanitizedCatalogSource): MetaCatalogDetectedSource {
  const visto = Date.parse(s.detectedAt);
  return {
    kind: s.kind,
    sourceId: s.sourceId,
    name: s.nombreSaneado,
    host: s.host ?? '',
    schedule: scheduleLabel(s),
    timezone: s.schedule?.timezone ?? null,
    deletesMissingItems: null,
    detectedFields: [...s.detectedFields],
    itemCount: null,
    fingerprint: catalogSourceFingerprintOne(s),
    lastSeenAtMs: Number.isFinite(visto) ? visto : null,
  };
}

// ---------------------------------------------------------------------------
// 2) Verificación: leer + comparar + persistir
// ---------------------------------------------------------------------------

export interface CatalogSourceCheckOutcome {
  observation: CatalogSourcesObservation;
  comparison: CatalogSourceComparison;
  /** Las fuentes observadas en la vista del panel/migración (metadata saneada). */
  sources: MetaCatalogDetectedSource[];
  /** Doc `metaCatalogSourceChecks/{checkId}` donde quedó la evidencia. */
  checkId: string;
  /** true ⇒ hay una fuente que nadie reconoció, o la reconocida cambió de forma. */
  blocksWrites: boolean;
}

/**
 * Verifica las fuentes externas del catálogo contra lo que la propiedad RECONOCE. Solo GET.
 * La evidencia se persiste con id derivado de la huella: la misma observación repetida
 * actualiza el mismo documento (no infla la colección ni duplica el hallazgo).
 */
export async function checkCatalogSources(args: {
  tenantId: string;
  catalogId: string;
  ownership: EffectiveOwnership;
  /** Cliente ya construido (el outbox reusa el suyo para no duplicar el costo del token). */
  client?: Pick<MetaCatalogClient, 'listDataSources'>;
  now?: () => Timestamp;
}): Promise<CatalogSourceCheckOutcome> {
  const client = args.client ?? (await getMetaCatalogClientForTenant(args.tenantId));
  const observation = await client.listDataSources(args.catalogId);
  const reconocida = args.ownership.externalSource;
  const comparison = compareCatalogSources(
    observation,
    reconocida
      ? { acknowledgedSourceIds: reconocida.acknowledgedSourceIds, fingerprint: reconocida.fingerprint }
      : null,
  );
  const { checkId } = await recordCatalogSourceCheck({
    tenantId: args.tenantId,
    observation,
    comparison,
    ...(args.now ? { now: args.now } : {}),
  });
  return {
    observation,
    comparison,
    sources: observation.sources.map(detectedSourceOf),
    checkId,
    blocksWrites: sourceCheckBlocksWrites(comparison.status),
  };
}

// ---------------------------------------------------------------------------
// 3) Detector que consume la migración de propiedad (ADR-0015 §9)
// ---------------------------------------------------------------------------

/**
 * Detector REAL. `available:false` cuando no se pudo mirar (sin config de catálogo, sin token
 * o la lectura falló): la migración lo traduce a `detection_unavailable` y NUNCA propone
 * `external_managed` a ciegas — reconocer una fuente que nadie vio sería firmar en blanco.
 *
 * Un tenant SIN `catalogSync` (credipower) sale por el primer `return`: ni una llamada.
 */
export async function detectCatalogSourcesForTenant(tenantId: string): Promise<ExternalSourceDetection> {
  const cfgDoc = await db().doc(`tenants/${tenantId}/config/meta`).get();
  const cfg = normalizeCatalogSyncConfig((cfgDoc.data() as { catalogSync?: unknown } | undefined)?.catalogSync);
  if (!cfg.enabled || !cfg.catalogId) return { available: false, sources: [] };
  const r = await checkCatalogSources({ tenantId, catalogId: cfg.catalogId, ownership: cfg.ownership });
  // Un listado INCOMPLETO no es una detección: si el propio catálogo declara más feeds de los
  // que pudimos enumerar, afirmar "estas son las fuentes" habilitaría un reconocimiento parcial.
  if (!r.observation.complete) return { available: false, sources: r.sources };
  return { available: true, sources: r.sources };
}

/** Registra el detector real. Se llama UNA vez desde `index.ts` (único punto de cableado). */
export function wireCatalogSourceDetector(): void {
  setExternalSourceDetector(detectCatalogSourcesForTenant);
}

// ---------------------------------------------------------------------------
// 4) Alerta AGREGADA e idempotente
// ---------------------------------------------------------------------------

/** Id determinístico de la campana: UNA sola viva por tenant (mismo patrón que la de calidad). */
export const catalogSourceNotificationId = (tenantId: string): string => `catalog-source-${tenantId}`;

const listaCorta = (ids: readonly string[]): string => (ids.length ? ids.slice(0, 3).join(', ') : 'sin identificar');

/** Texto del aviso. PURO: solo ids NO secretos de feed — jamás host, URL ni query string. */
export function catalogSourceAlertText(c: CatalogSourceComparison): { title: string; body: string } {
  if (c.status === 'fuente_nueva') {
    return {
      title: '⚠️ Hay una fuente de datos del catálogo sin reconocer',
      body: c.incompleteListing
        ? 'No se pudo enumerar por completo qué fuentes publican tu catálogo en Meta. Hasta confirmarlo, las escrituras hacia Meta quedan detenidas.'
        : `Apareció una fuente que publica tu catálogo en Meta y que nadie reconoció todavía (${listaCorta(c.newSourceIds)}). Hasta que la revises, las escrituras hacia Meta quedan detenidas.`,
    };
  }
  return {
    title: '⚠️ La fuente de datos del catálogo cambió',
    body: `La fuente reconocida que publica tu catálogo cambió de configuración (${listaCorta(c.affectedSourceIds)}). Revisá quién administra cada campo antes de volver a escribir en Meta.`,
  };
}

/**
 * Campana AGREGADA del gobierno del catálogo. Idempotente por doc-id: repetir la verificación
 * (un drenaje por minuto) NO genera un aviso nuevo — actualiza el mismo y solo lo REABRE si el
 * hallazgo cambió de huella. Se AUTOCIERRA cuando todo vuelve a estar reconocido, igual que la
 * campana de calidad: el historial de que hubo un bloqueo vale más que borrarlo.
 *
 * Best-effort: un fallo acá jamás rompe el drenaje (el bloqueo de escritura ya ocurrió).
 */
export async function alertarFuenteDelCatalogo(tenantId: string, c: CatalogSourceComparison, checkId: string): Promise<void> {
  try {
    const id = catalogSourceNotificationId(tenantId);
    const ref = db().doc(`${paths.notifications(tenantId)}/${id}`);
    const prev = (await ref.get()).data() as
      | { createdAt?: Timestamp; resolvedAt?: Timestamp | null; sourceCheckId?: string }
      | undefined;
    const now = Timestamp.now();
    if (!sourceCheckBlocksWrites(c.status)) {
      // Sin hallazgo: solo se cierra un aviso ABIERTO. Jamás se crea uno vacío.
      if (!prev || prev.resolvedAt) return;
      await ref.set(
        {
          read: true,
          readAt: now,
          resolvedAt: now,
          title: '✅ Las fuentes del catálogo están reconocidas',
          body: 'Las fuentes que publican tu catálogo en Meta coinciden con las que declaraste.',
        },
        { merge: true },
      );
      return;
    }
    const { title, body } = catalogSourceAlertText(c);
    // Reabre solo si el hallazgo es OTRO (otra huella observada): el mismo hallazgo repetido
    // no vuelve a saltar sobre un aviso que alguien ya leyó.
    const reabre = !prev || !!prev.resolvedAt || prev.sourceCheckId !== checkId;
    await ref.set(
      {
        id,
        tenantId,
        category: 'catalog_source',
        type: 'catalog_source_changed',
        title,
        body,
        dedupeKey: id,
        status: c.status,
        // Solo ids NO secretos: el doc lo lee el panel y queda para siempre.
        sourceIds: c.affectedSourceIds.slice(0, 10),
        sourceCheckId: checkId,
        resolvedAt: null,
        createdAt: prev?.createdAt ?? now,
        ...(reabre ? { read: false, readAt: null } : {}),
      },
      { merge: true },
    );
  } catch (e) {
    logger.warn('No se pudo actualizar el aviso de fuentes del catálogo', {
      tenantId,
      error: e instanceof Error ? e.message.slice(0, 200) : 'desconocido',
    });
  }
}
