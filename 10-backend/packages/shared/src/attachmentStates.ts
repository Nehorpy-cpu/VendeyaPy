/**
 * WHATSAPP-MEDIA-SAFE-FOUNDATION-1 (ADR-0016 §3/§5) — Las DOS máquinas de estados del adjunto.
 * =============================================================================================
 * ÚNICA fuente de verdad de qué transición es legal y QUIÉN puede dispararla. Funciones PURAS,
 * sin logging y sin I/O: el caller (callable o webhook) sigue siendo responsable de la
 * autorización por rol, del tenant y de la transaccionalidad.
 *
 * POR QUÉ dos ejes separados y no un único `status`: el eje de INGESTA es un hecho técnico
 * (¿tenemos los bytes?) y el eje de CLASIFICACIÓN es una interpretación de negocio (¿esto es un
 * comprobante?). Fusionarlos es exactamente el defecto que este programa corrige: alcanzaba con
 * que llegara una imagen para que un pedido se moviera solo.
 *
 * REGLA DE ORO codificada acá: toda transición que AGREGA significado de pago exige `human`;
 * las que lo QUITAN también las puede hacer el sistema, porque degradar nunca fabrica evidencia.
 */

import {
  ATTACHMENT_ACTOR,
  ATTACHMENT_CLASSIFICATION,
  ATTACHMENT_INGEST_STATE,
} from './types/attachment.types.js';
import type {
  AttachmentActor,
  AttachmentClassification,
  AttachmentIngestState,
} from './types/attachment.types.js';

/** Una arista del grafo: destino + actores autorizados a recorrerla. */
export interface AttachmentTransitionRule<S extends string> {
  readonly to: S;
  readonly actors: readonly AttachmentActor[];
}

export type AttachmentTransitionTable<S extends string> = Readonly<
  Record<S, readonly AttachmentTransitionRule<S>[]>
>;

/** Motivo del rechazo. Es un código cerrado: seguro de loguear (no lleva datos del cliente). */
export type AttachmentTransitionDenyReason =
  | 'unknown_state'
  | 'unknown_actor'
  | 'same_state'
  | 'terminal_state'
  | 'illegal_transition'
  | 'actor_not_allowed';

export type AttachmentTransitionCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: AttachmentTransitionDenyReason };

/**
 * EJE 1 — INGESTA. Todas las aristas son `system`: la ingesta es un hecho técnico y ninguna
 * persona la empuja a mano (un humano no puede declarar `stored` un archivo que no bajó).
 * `stored`, `rejected` y `download_failed` son TERMINALES: un reintento de descarga ocurre
 * ANTES de marcar `download_failed`; una vez marcado, el reproceso nace como adjunto nuevo.
 */
export const ATTACHMENT_INGEST_TRANSITIONS: AttachmentTransitionTable<AttachmentIngestState> = {
  // `received → rejected` cubre el descarte temprano: MIME declarado no admitido o tamaño
  // declarado fuera de límite. No hace falta bajar bytes para rechazar.
  received: [
    { to: 'downloading', actors: ['system'] },
    { to: 'rejected', actors: ['system'] },
  ],
  // `downloading → rejected` = corte durante el stream (excede el máximo del tenant).
  // `download_failed` = la descarga no se pudo completar por el proveedor/red: es recuperable
  // para el negocio (se le pide al cliente que reenvíe) pero terminal para ESTE documento.
  downloading: [
    { to: 'verifying', actors: ['system'] },
    { to: 'download_failed', actors: ['system'] },
    { to: 'rejected', actors: ['system'] },
  ],
  // `verifying → rejected` = los magic bytes no coinciden con ningún formato admitido
  // (incluye el caso polyglot: lo que Graph declaró como imagen en realidad es HTML/SVG).
  verifying: [
    { to: 'stored', actors: ['system'] },
    { to: 'rejected', actors: ['system'] },
  ],
  stored: [],
  rejected: [],
  download_failed: [],
};

/**
 * EJE 2 — CLASIFICACIÓN.
 * - `unclassified → generic_media | payment_receipt_candidate`: el gate determinístico corre una
 *   sola vez en la ingesta (`system`); un humano puede clasificar si el gate no llegó a correr.
 * - `generic_media → payment_receipt_candidate`: SOLO `human`. El sistema no re-propone después
 *   de haber decidido: si un job pudiera re-proponer, una foto vieja podría aparecer como
 *   sugerencia de pago sin que nadie la haya tocado.
 * - `→ payment_receipt_linked`: SOLO `human` (ADR-0016 §5, el pago siempre es humano).
 * - `payment_receipt_candidate → generic_media`: `system` también, porque degradar es seguro
 *   (vencimiento de la ventana, pedido cancelado): nunca fabrica evidencia de pago.
 * - `payment_receipt_linked → generic_media`: desmarcar, SOLO `human`. Las guardas extra
 *   (pedido no `PAID`, que esa clasificación haya producido el estado actual) son del caller
 *   transaccional, no de la máquina.
 * - `rejected` es terminal: si el archivo no existe, no hay nada que significar.
 */
export const ATTACHMENT_CLASSIFICATION_TRANSITIONS: AttachmentTransitionTable<AttachmentClassification> =
  {
    unclassified: [
      { to: 'generic_media', actors: ['system', 'human'] },
      { to: 'payment_receipt_candidate', actors: ['system', 'human'] },
      { to: 'rejected', actors: ['system'] },
    ],
    generic_media: [{ to: 'payment_receipt_candidate', actors: ['human'] }],
    payment_receipt_candidate: [
      { to: 'payment_receipt_linked', actors: ['human'] },
      { to: 'generic_media', actors: ['system', 'human'] },
    ],
    payment_receipt_linked: [{ to: 'generic_media', actors: ['human'] }],
    rejected: [],
  };

function isMember<T extends string>(values: readonly T[], candidate: unknown): candidate is T {
  return typeof candidate === 'string' && (values as readonly string[]).includes(candidate);
}

export function isAttachmentIngestState(value: unknown): value is AttachmentIngestState {
  return isMember(ATTACHMENT_INGEST_STATE, value);
}

export function isAttachmentClassification(value: unknown): value is AttachmentClassification {
  return isMember(ATTACHMENT_CLASSIFICATION, value);
}

export function isAttachmentActor(value: unknown): value is AttachmentActor {
  return isMember(ATTACHMENT_ACTOR, value);
}

const DENY = (reason: AttachmentTransitionDenyReason): AttachmentTransitionCheck => ({
  ok: false,
  reason,
});

/**
 * Núcleo compartido. Valida en RUNTIME aunque los tipos ya lo digan: estos valores suelen venir
 * de un documento de Firestore o del payload de un callable, donde el tipo es una promesa, no
 * una garantía. Fail-closed: cualquier duda ⇒ rechazo.
 */
function evaluate<S extends string>(
  table: AttachmentTransitionTable<S>,
  states: readonly S[],
  from: unknown,
  to: unknown,
  actor: unknown,
): AttachmentTransitionCheck {
  if (!isMember(states, from) || !isMember(states, to)) return DENY('unknown_state');
  if (!isAttachmentActor(actor)) return DENY('unknown_actor');
  // Una "transición" al mismo estado no es una transición: se rechaza para que un reintento
  // no parezca un avance legítimo y el caller decida explícitamente si es idempotencia.
  if (from === to) return DENY('same_state');
  const rules = table[from] ?? [];
  if (rules.length === 0) return DENY('terminal_state');
  const rule = rules.find((candidate) => candidate.to === to);
  if (!rule) return DENY('illegal_transition');
  if (!rule.actors.includes(actor)) return DENY('actor_not_allowed');
  return { ok: true };
}

/** ¿Es legal `from → to` disparada por `actor` en el eje de INGESTA? Con motivo del rechazo. */
export function checkIngestTransition(
  from: AttachmentIngestState,
  to: AttachmentIngestState,
  actor: AttachmentActor,
): AttachmentTransitionCheck {
  return evaluate(ATTACHMENT_INGEST_TRANSITIONS, ATTACHMENT_INGEST_STATE, from, to, actor);
}

/** Ídem para el eje de CLASIFICACIÓN. */
export function checkClassificationTransition(
  from: AttachmentClassification,
  to: AttachmentClassification,
  actor: AttachmentActor,
): AttachmentTransitionCheck {
  return evaluate(
    ATTACHMENT_CLASSIFICATION_TRANSITIONS,
    ATTACHMENT_CLASSIFICATION,
    from,
    to,
    actor,
  );
}

/** Azúcar booleana para guardas dentro de una transacción. */
export function canIngestTransition(
  from: AttachmentIngestState,
  to: AttachmentIngestState,
  actor: AttachmentActor,
): boolean {
  return checkIngestTransition(from, to, actor).ok;
}

export function canClassificationTransition(
  from: AttachmentClassification,
  to: AttachmentClassification,
  actor: AttachmentActor,
): boolean {
  return checkClassificationTransition(from, to, actor).ok;
}

/** Destinos legales desde `from` (vacío ⇒ terminal). Útil para el panel y para tests. */
export function nextIngestStates(from: AttachmentIngestState): readonly AttachmentIngestState[] {
  if (!isAttachmentIngestState(from)) return [];
  return (ATTACHMENT_INGEST_TRANSITIONS[from] ?? []).map((rule) => rule.to);
}

export function nextClassifications(
  from: AttachmentClassification,
): readonly AttachmentClassification[] {
  if (!isAttachmentClassification(from)) return [];
  return (ATTACHMENT_CLASSIFICATION_TRANSITIONS[from] ?? []).map((rule) => rule.to);
}

/** Actores autorizados para una arista concreta (vacío si la arista no existe). */
export function ingestTransitionActors(
  from: AttachmentIngestState,
  to: AttachmentIngestState,
): readonly AttachmentActor[] {
  if (!isAttachmentIngestState(from) || !isAttachmentIngestState(to)) return [];
  return (ATTACHMENT_INGEST_TRANSITIONS[from] ?? []).find((rule) => rule.to === to)?.actors ?? [];
}

export function classificationTransitionActors(
  from: AttachmentClassification,
  to: AttachmentClassification,
): readonly AttachmentActor[] {
  if (!isAttachmentClassification(from) || !isAttachmentClassification(to)) return [];
  return (
    (ATTACHMENT_CLASSIFICATION_TRANSITIONS[from] ?? []).find((rule) => rule.to === to)?.actors ?? []
  );
}

export function isTerminalIngestState(state: AttachmentIngestState): boolean {
  return isAttachmentIngestState(state) && (ATTACHMENT_INGEST_TRANSITIONS[state] ?? []).length === 0;
}

export function isTerminalClassification(value: AttachmentClassification): boolean {
  return (
    isAttachmentClassification(value) &&
    (ATTACHMENT_CLASSIFICATION_TRANSITIONS[value] ?? []).length === 0
  );
}

/** ¿Los bytes están efectivamente guardados? Precondición del gate de candidato (ADR-0016 §4). */
export function isAttachmentStored(state: AttachmentIngestState): boolean {
  return state === 'stored';
}

/**
 * ¿Esta clasificación implica significado de PAGO? El panel y los guards lo usan para no tratar
 * un `generic_media` como si fuera evidencia — y para no borrar lo que sí lo es.
 */
export function isPaymentRelatedClassification(value: AttachmentClassification): boolean {
  return value === 'payment_receipt_candidate' || value === 'payment_receipt_linked';
}
