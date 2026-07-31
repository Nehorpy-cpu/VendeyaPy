/**
 * attachments/retentionPurge.ts — Ejecución IDEMPOTENTE de la purga (ADR-0016 §D)
 * ================================================================================
 * La política vive en `retention.ts` (pura). Acá está el orquestador con dependencias
 * inyectables y, en el fondo del archivo, las deps reales contra Firestore/Storage.
 *
 * Invariantes que sostiene este orden de operaciones:
 *
 *  · APAGADA ⇒ CERO CONSULTAS. Con `purgeEnabled:false` ni siquiera se lista candidatos. Un job
 *    que "mira pero no borra" es un job que un día borra por un `if` mal editado.
 *
 *  · EL TENANT LO DICE LA RUTA, NUNCA EL DOCUMENTO. La whitelist de path se valida contra el
 *    tenant de la ruta del doc. Tomarlo del campo `tenantId` del propio documento convertiría al
 *    documento en quien elige contra qué empresa se valida —y entonces un doc sembrado en un
 *    tenant podría hacer borrar un archivo de otro—. Si el campo y la ruta discrepan es un
 *    hallazgo: se cuenta como `tenant_mismatch`, se avisa y no se toca un byte.
 *
 *  · CLAIM TRANSACCIONAL ANTES DE BORRAR. Entre listar y borrar puede pasar cualquier cosa —el
 *    caso que importa: un vendedor marcando ese mismo archivo como comprobante—. Por eso el
 *    claim RE-EVALÚA la decisión completa dentro de una transacción y recién ahí sella
 *    `purgedAt` + `storage.path = null`. Perder una carrera acá significaría borrar evidencia de
 *    un pago, que es exactamente lo que el ADR prohíbe.
 *
 *  · SI EL BORRADO FALLA, SE REVIERTE EL CLAIM. Dejar el doc marcado como purgado con los bytes
 *    todavía en el bucket es lo peor de los dos mundos: el archivo existe pero nadie puede
 *    pedirlo ni volver a intentar borrarlo. Revertir devuelve el adjunto a su estado anterior y
 *    la corrida siguiente reintenta.
 *
 *  · REEJECUTABLE. Lo ya purgado se saltea por `purgedAt`; borrar un objeto inexistente se
 *    tolera (`ignoreNotFound`).
 */

import { Timestamp } from 'firebase-admin/firestore';
import {
  buildAttachmentDocPath,
  isAttachmentId,
  sanitizeAttachmentError,
  type AttachmentClassification,
  type AttachmentIngestState,
} from '@vpw/shared';
import { db, storage } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import {
  ATTACHMENT_CONFIG_DOC,
  ATTACHMENT_RETENTION_DISABLED,
  decideAttachmentPurge,
  decideRetentionStamp,
  emptyPurgeSkipCounters,
  parseAttachmentRetentionConfig,
  type AttachmentPurgeCandidate,
  type AttachmentPurgeSkipReason,
  type AttachmentRetentionConfig,
} from './retention.js';

/** Tope por tenant y por corrida: costo acotado; lo que sobre sale en la corrida siguiente. */
export const ATTACHMENT_PURGE_BATCH_LIMIT = 200;

export type AttachmentPurgeClaim =
  | { readonly claimed: true; readonly storagePath: string }
  | { readonly claimed: false; readonly reason: AttachmentPurgeSkipReason };

export interface AttachmentPurgeDeps {
  loadRetentionConfig(tenantId: string): Promise<AttachmentRetentionConfig>;
  listCandidates(tenantId: string, nowMs: number, limit: number): Promise<AttachmentPurgeCandidate[]>;
  /** Adjuntos SIN fecha de retención todavía (`retentionUntil == null`). */
  listUnstamped(tenantId: string, limit: number): Promise<AttachmentPurgeCandidate[]>;
  /** Sella la fecha SOLO si sigue en `null` (idempotente; jamás pisa una fecha existente). */
  stampRetention(tenantId: string, attachmentId: string, retentionUntilMs: number): Promise<void>;
  /** Transacción: re-evalúa la decisión y sella `purgedAt` + `storage.path = null`. */
  claimForPurge(
    tenantId: string,
    attachmentId: string,
    config: AttachmentRetentionConfig,
    nowMs: number,
  ): Promise<AttachmentPurgeClaim>;
  deleteObject(storagePath: string): Promise<void>;
  /** Rollback del claim cuando el borrado de bytes falla (el adjunto vuelve a ser consultable). */
  releaseClaim(tenantId: string, attachmentId: string, storagePath: string): Promise<void>;
}

export interface AttachmentPurgeResult {
  /** `false` ⇒ no se consultó nada. Distinto de "0 purgados": una purga apagada no es una corrida vacía. */
  enabled: boolean;
  scanned: number;
  purged: number;
  /** Adjuntos que recibieron su `retentionUntil` en esta corrida (no se borra nada al sellar). */
  stamped: number;
  failed: number;
  skipped: Record<AttachmentPurgeSkipReason, number>;
}

export interface AttachmentPurgeInput {
  tenantId: string;
  nowMs?: number;
  limit?: number;
}

export async function runAttachmentRetentionPurge(
  input: AttachmentPurgeInput,
  deps: AttachmentPurgeDeps = defaultAttachmentPurgeDeps,
): Promise<AttachmentPurgeResult> {
  const nowMs = input.nowMs ?? Date.now();
  const limit =
    Number.isSafeInteger(input.limit) && (input.limit as number) > 0
      ? Math.min(input.limit as number, ATTACHMENT_PURGE_BATCH_LIMIT)
      : ATTACHMENT_PURGE_BATCH_LIMIT;
  const result: AttachmentPurgeResult = {
    enabled: false,
    scanned: 0,
    purged: 0,
    stamped: 0,
    failed: 0,
    skipped: emptyPurgeSkipCounters(),
  };

  const config = await deps.loadRetentionConfig(input.tenantId);
  // Corte TEMPRANO: con la purga apagada no se lista, no se lee y no se borra nada.
  if (!config.purgeEnabled) return result;
  result.enabled = true;

  const candidates = await deps.listCandidates(input.tenantId, nowMs, limit);
  for (const candidate of candidates) {
    result.scanned += 1;
    const decision = decideAttachmentPurge(config, candidate, nowMs);
    if (!decision.purge) {
      result.skipped[decision.reason] += 1;
      // Un doc que se auto-declara de otra empresa no es "un motivo más de salteo": es un dato
      // imposible. Se avisa para que alguien lo mire. Sin paths y sin el tenant declarado —el
      // hallazgo se investiga con el id del adjunto, que es opaco.
      if (decision.reason === 'tenant_mismatch') {
        logger.warn('Adjuntos: documento con tenant declarado distinto al de su ruta (no se purga)', {
          tenantId: input.tenantId,
          attachmentId: candidate.attachmentId,
        });
      }
      continue;
    }
    const claim = await deps.claimForPurge(input.tenantId, candidate.attachmentId, config, nowMs);
    if (!claim.claimed) {
      // Alguien cambió el adjunto entre listar y reclamar (p. ej. el vendedor lo marcó
      // comprobante). El motivo fresco de la transacción manda sobre el de la lista.
      result.skipped[claim.reason] += 1;
      continue;
    }
    try {
      await deps.deleteObject(claim.storagePath);
      result.purged += 1;
    } catch (e) {
      result.failed += 1;
      try {
        await deps.releaseClaim(input.tenantId, candidate.attachmentId, claim.storagePath);
      } catch (releaseError) {
        // Peor caso: doc sellado y bytes vivos. Queda registro para que una persona intervenga;
        // la corrida siguiente lo verá como `already_purged`.
        logger.error('Adjuntos: no se pudo revertir el claim de purga', undefined, {
          tenantId: input.tenantId,
          attachmentId: candidate.attachmentId,
          detalle: sanitizeAttachmentError(releaseError),
        });
      }
      // El error CRUDO no se loguea: un fallo de Storage suele traer el path del objeto (y a
      // veces la URL firmada del intento). Solo va la versión saneada.
      logger.error('Adjuntos: falló el borrado de bytes durante la purga', undefined, {
        tenantId: input.tenantId,
        attachmentId: candidate.attachmentId,
        detalle: sanitizeAttachmentError(e),
      });
    }
  }

  // SEGUNDO paso, y va DESPUÉS a propósito: sellar la fecha de retención de los adjuntos que
  // todavía no la tienen. Al ir al final, lo sellado hoy no puede purgarse hoy — queda al menos
  // una cadencia completa entre "el tenant encendió la retención" y el primer borrado, y esa
  // fecha es visible en el panel antes de que desaparezca un solo archivo.
  const unstamped = await deps.listUnstamped(input.tenantId, limit);
  for (const candidate of unstamped) {
    const decision = decideRetentionStamp(config, candidate, nowMs);
    if (!decision.stamp) {
      result.skipped[decision.reason] += 1;
      continue;
    }
    try {
      await deps.stampRetention(input.tenantId, candidate.attachmentId, decision.retentionUntilMs);
      result.stamped += 1;
    } catch (e) {
      result.failed += 1;
      logger.error('Adjuntos: no se pudo sellar la fecha de retención', undefined, {
        tenantId: input.tenantId,
        attachmentId: candidate.attachmentId,
        detalle: sanitizeAttachmentError(e),
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Deps reales (Firestore + Storage)
// ---------------------------------------------------------------------------

interface AttachmentDocShape {
  tenantId?: unknown;
  ingestState?: unknown;
  classification?: { value?: unknown } | null;
  orderCandidateId?: unknown;
  storage?: { path?: unknown } | null;
  createdAt?: { toMillis?: () => number } | null;
  retentionUntil?: { toMillis?: () => number } | null;
  purgedAt?: { toMillis?: () => number } | null;
}

const millisOf = (value: { toMillis?: () => number } | null | undefined): number | null =>
  value && typeof value.toMillis === 'function' ? value.toMillis() : null;

/** Proyección defensiva: un documento adulterado no puede colarse como "purgable". */
export function toPurgeCandidate(
  tenantId: string,
  attachmentId: string,
  data: AttachmentDocShape | undefined,
): AttachmentPurgeCandidate {
  return {
    attachmentId,
    // La AUTORIDAD es la ruta del documento (`tenants/{tenantId}/attachments/{id}`), nunca el
    // campo que el propio documento declara: si el doc eligiera el tenant contra el que se valida
    // la whitelist de path, elegiría también qué archivo se borra, y de qué empresa.
    tenantId,
    // El campo se conserva SOLO para poder detectar la discrepancia (ver `tenant_mismatch`).
    declaredTenantId: typeof data?.tenantId === 'string' ? data.tenantId : null,
    storagePath: typeof data?.storage?.path === 'string' ? data.storage.path : null,
    ingestState: (typeof data?.ingestState === 'string' ? data.ingestState : 'received') as AttachmentIngestState,
    classification: (typeof data?.classification?.value === 'string'
      ? data.classification.value
      : 'unclassified') as AttachmentClassification,
    orderCandidateId: typeof data?.orderCandidateId === 'string' ? data.orderCandidateId : null,
    createdAtMs: millisOf(data?.createdAt),
    retentionUntilMs: millisOf(data?.retentionUntil),
    purgedAtMs: millisOf(data?.purgedAt),
  };
}

export const defaultAttachmentPurgeDeps: AttachmentPurgeDeps = {
  async loadRetentionConfig(tenantId) {
    try {
      const snap = await db().doc(`tenants/${tenantId}/config/${ATTACHMENT_CONFIG_DOC}`).get();
      return parseAttachmentRetentionConfig((snap.data() as { retention?: unknown } | undefined)?.retention);
    } catch (e) {
      // Fail-closed: si no se puede leer la política, no se borra nada.
      logger.error('Adjuntos: no se pudo leer la config de retención (purga omitida)', e, { tenantId });
      return ATTACHMENT_RETENTION_DISABLED;
    }
  },
  async listCandidates(tenantId, nowMs, limit) {
    // OJO: este `<=` también matchea los docs con `retentionUntil: null` (en el orden de tipos de
    // Firestore, `null` va antes que cualquier Timestamp). No es un bug de la query: la defensa
    // real es `decideAttachmentPurge`, que exige una fecha explícita YA vencida.
    const snap = await db()
      .collection(`tenants/${tenantId}/attachments`)
      .where('retentionUntil', '<=', Timestamp.fromMillis(nowMs))
      .limit(limit)
      .get();
    return snap.docs.map((d) => toPurgeCandidate(tenantId, d.id, d.data() as AttachmentDocShape));
  },
  async listUnstamped(tenantId, limit) {
    const snap = await db()
      .collection(`tenants/${tenantId}/attachments`)
      .where('retentionUntil', '==', null)
      .limit(limit)
      .get();
    return snap.docs.map((d) => toPurgeCandidate(tenantId, d.id, d.data() as AttachmentDocShape));
  },
  async stampRetention(tenantId, attachmentId, retentionUntilMs) {
    if (!isAttachmentId(attachmentId)) return;
    const ref = db().doc(buildAttachmentDocPath(tenantId, attachmentId));
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      // Idempotencia dura: una fecha ya sellada NUNCA se pisa (ni para adelante ni para atrás).
      // Cambiar la ventana del tenant afecta a los adjuntos nuevos, no reescribe el pasado.
      if ((snap.data() as AttachmentDocShape).retentionUntil) return;
      const now = Timestamp.now();
      tx.update(ref, { retentionUntil: Timestamp.fromMillis(retentionUntilMs), updatedAt: now });
    });
  },
  async claimForPurge(tenantId, attachmentId, config, nowMs) {
    // Un doc con id fuera del formato `att_<24 hex>` haría lanzar a `buildAttachmentDocPath` y
    // tumbaría la corrida entera del tenant por un solo documento raro. Se saltea, no se rompe.
    if (!isAttachmentId(attachmentId)) return { claimed: false, reason: 'path_not_purgeable' };
    const ref = db().doc(buildAttachmentDocPath(tenantId, attachmentId));
    return db().runTransaction<AttachmentPurgeClaim>(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { claimed: false, reason: 'no_stored_bytes' };
      const fresh = toPurgeCandidate(tenantId, attachmentId, snap.data() as AttachmentDocShape);
      const decision = decideAttachmentPurge(config, fresh, nowMs);
      if (!decision.purge) return { claimed: false, reason: decision.reason };
      const now = Timestamp.fromMillis(nowMs);
      tx.update(ref, { purgedAt: now, 'storage.path': null, updatedAt: now });
      return { claimed: true, storagePath: fresh.storagePath as string };
    });
  },
  async deleteObject(storagePath) {
    await storage().bucket().file(storagePath).delete({ ignoreNotFound: true });
  },
  async releaseClaim(tenantId, attachmentId, storagePath) {
    await db()
      .doc(buildAttachmentDocPath(tenantId, attachmentId))
      .update({ purgedAt: null, 'storage.path': storagePath, updatedAt: Timestamp.now() });
  },
};
