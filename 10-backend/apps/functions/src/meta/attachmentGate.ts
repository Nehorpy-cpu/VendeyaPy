/**
 * meta/attachmentGate.ts — COSTURA del gate de clasificación de adjuntos (ADR-0016 §4)
 * =====================================================================================
 * La ingesta (hecho técnico) y la clasificación (significado de negocio) son dos ejes distintos.
 * Este archivo es el punto de encastre entre ambos: la ingesta vive en `meta/` y el gate
 * determinístico —que sabe de pedidos y de contexto de pago— vive en `orders/`. Si el webhook
 * importara `orders/` directamente, el camino de conversación volvería a depender del camino de
 * pago, que es exactamente el acoplamiento que este programa desarma.
 *
 * CÓMO SE ENCHUFA: el módulo del gate llama `setAttachmentGate(miGate)` al cargarse (registrado
 * desde `index.ts`). Mientras nadie lo registre, corre el gate por DEFECTO, que es el
 * comportamiento seguro del ADR: **una imagen fuera de un contexto explícito de pago queda como
 * medio normal aunque parezca un comprobante** — el sistema no adivina.
 *
 * El gate NUNCA cambia por sí solo el estado de un pedido, no confirma pagos y no llama a ningún
 * modelo de IA (el caption se persiste, pero no se envía — ADR-0016 §9).
 */
import { Timestamp } from 'firebase-admin/firestore';
import {
  buildAttachmentDocPath,
  canClassificationTransition,
  type Attachment,
  type AttachmentClassification,
  type MessageChannel,
} from '@vpw/shared';
import { db } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import type { AttachmentReplyReason } from './attachmentReplies.js';

export interface AttachmentGateInput {
  tenantId: string;
  /** ES el teléfono ⇒ jamás a logs. Sirve para validar que el pedido sea del MISMO cliente. */
  customerId: string;
  channel: MessageChannel;
  /** Documento del adjunto YA almacenado (`ingestState === 'stored'`). */
  attachment: Attachment;
  /** Id del mensaje del historial al que pertenece el adjunto. */
  messageId: string;
  receivedByPhoneNumberId: string | null;
  /**
   * ADR-0017 §2: CANAL de la conversación que recibió el archivo. El gate del comprobante decide
   * con dos hechos de la SESIÓN (si el checkout declaró que espera un pago y a qué pedido apunta),
   * y sin esto los leía de `active`: un comprobante que entra por otro número se evaluaba contra
   * una conversación que no es la suya y terminaba degradado a medio normal.
   *
   * Opcional y retrocompatible: omitirlo = canal heredado.
   */
  sessionKey?: string;
}

export interface AttachmentGateOutcome {
  /** Texto a responderle al cliente ('' = el gate no tiene nada que decir). */
  reply: string;
  /** Clasificación con la que quedó el adjunto (el gate ya la persistió). */
  classification: AttachmentClassification;
  /** Pedido PROPUESTO. No implica vínculo oficial ni mueve el pedido. */
  orderCandidateId: string | null;
  /**
   * POR QUÉ degradó a medio normal. Código CERRADO (seguro de loguear) que le permite al webhook
   * elegir la redacción exacta en vez de quedarse mudo — ADR-0016 §4: «un rechazo nunca bloquea la
   * conversación: se responde al cliente». Opcional: un gate que no lo informe cae en la respuesta
   * genérica, que también es honesta.
   */
  reason?: AttachmentReplyReason;
}

export type AttachmentGate = (input: AttachmentGateInput) => Promise<AttachmentGateOutcome>;

/**
 * Gate por DEFECTO: marca el adjunto como medio normal. No mira pedidos, no propone candidatos y
 * no responde nada — sin contexto de pago declarado, un archivo es simplemente un archivo.
 */
export const genericMediaGate: AttachmentGate = async ({ tenantId, attachment }) => {
  const actual = attachment.classification?.value ?? 'unclassified';
  if (actual === 'generic_media') {
    return { reply: '', classification: 'generic_media', orderCandidateId: null };
  }
  if (!canClassificationTransition(actual, 'generic_media', 'system')) {
    // No se pisa una clasificación que ya tiene dueño (p. ej. una vinculada por una persona).
    logger.info('attachmentGate: clasificación existente, no se toca', { tenantId, attachmentId: attachment.attachmentId, actual });
    return { reply: '', classification: actual, orderCandidateId: null };
  }
  await db().doc(buildAttachmentDocPath(tenantId, attachment.attachmentId)).update({
    classification: { value: 'generic_media', source: 'rule', confidence: 1, by: null, at: Timestamp.now() },
    updatedAt: Timestamp.now(),
  });
  return { reply: '', classification: 'generic_media', orderCandidateId: null };
};

let registrado: AttachmentGate | null = null;

/** Registra el gate real. `null` vuelve al de defecto (lo usan los tests para aislarse). */
export function setAttachmentGate(gate: AttachmentGate | null): void {
  registrado = gate;
}

export function getAttachmentGate(): AttachmentGate {
  return registrado ?? genericMediaGate;
}
