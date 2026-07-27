/**
 * lib/outboxFencing.ts — Settlement con OWNERSHIP para outboxes durables
 * =======================================================================
 * Extracción del patrón probado en la saga de cotización de envío
 * (`functions/coverage/coverageQuote.ts::settleSiPropio`, SHIPPING-CHAT-3C-HARDEN-4).
 *
 * EL PROBLEMA QUE RESUELVE: un worker que perdió su claim —porque el lease venció y el sweep
 * ya normalizó el registro, o porque una persona lo reconcilió— NO puede asentar su resultado.
 * Si pudiera, un proceso zombi pisaría un estado durable posterior con información vieja.
 *
 * La condición de propiedad son DOS cosas a la vez: el registro sigue en el estado "en curso"
 * Y su generación (`attempts`) es exactamente la que fijó este claim. Cualquier otra cosa ⇒
 * CERO escrituras y la verdad la tiene el estado durable.
 *
 * Se usa desde el outbox del catálogo (META-CATALOG-OUTBOX-1). La saga de cotización conserva
 * su copia local: está desplegada y verificada en producción, y migrarla es un refactor con
 * riesgo propio que no corresponde a este programa.
 */
import { Timestamp, type DocumentReference } from 'firebase-admin/firestore';
import { db } from './firebase.js';

export interface SettleResult<S extends string> {
  /** true si este worker todavía poseía el claim y la escritura se aplicó. */
  propio: boolean;
  /** Estado que tenía el registro al momento de intentar asentar (null si ya no existe). */
  status: S | null;
}

/**
 * Asienta `patch` SOLO si el registro sigue `enCurso` con la generación `gen`.
 *
 * @param ref     documento del outbox
 * @param gen     generación inmutable que fijó el claim de este worker
 * @param enCurso estado que representa "reclamado y en vuelo"
 * @param patch   campos a escribir (se le agrega `updatedAt`)
 */
export async function settleIfOwner<S extends string>(
  ref: DocumentReference,
  gen: number,
  enCurso: S,
  patch: Record<string, unknown>,
): Promise<SettleResult<S>> {
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data() as { status?: S; attempts?: number } | undefined;
    if (!data || data.status !== enCurso || (data.attempts ?? 0) !== gen) {
      return { propio: false, status: data?.status ?? null };
    }
    tx.update(ref, { ...patch, updatedAt: Timestamp.now() });
    return { propio: true, status: data.status };
  });
}
