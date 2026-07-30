/**
 * meta/catalogVerificationState.ts — Caducidad DERIVADA del estado actual (ADR-0015 §5)
 * ======================================================================================
 * PURO y deliberadamente LIVIANO: no importa Firestore, ni el cliente HTTP del catálogo, ni la
 * reconciliación. Son las veinte líneas que traducen "cuándo leímos Meta por última vez" a
 * "¿podemos seguir afirmando esto hoy?".
 *
 * Por qué vive SOLO acá y no adentro de `catalogVerification.ts`, donde nació: la proyección de
 * deriva se cablea en el arranque del proceso (index.ts) para TODAS las Cloud Functions, y de
 * toda la verificación necesita únicamente estas dos funciones. Importándolas de allá arrastraba
 * la reconciliación paginada + el cliente del catálogo (axios) al cold start de funciones que no
 * tienen nada que ver con el catálogo (pagos, webhooks, onboarding). La lógica NO se duplica:
 * `catalogVerification.ts` re-exporta desde acá, así que todos sus importadores siguen igual.
 */

import type { MetaSyncState, MetaSyncStateEffective } from '@vpw/shared';

/** Techo del TTL de verificación (ADR-0015 §5): 24 horas. */
export const VERIFICATION_MAX_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * TTL efectivo = el MENOR entre 24 h y el período de la fuente externa reconocida. Un feed
 * que publica cada 6 h invalida nuestra foto cada 6 h: sostener 24 h afirmaría un precio que
 * puede haber cambiado tres veces. El período llega del llamador porque la declaración de
 * fuente (contrato congelado) guarda metadata saneada, no el schedule tipado.
 */
export function verificationTtlMs(externalPeriodMs?: number | null): number {
  if (typeof externalPeriodMs === 'number' && Number.isFinite(externalPeriodMs) && externalPeriodMs > 0) {
    return Math.min(VERIFICATION_MAX_TTL_MS, Math.trunc(externalPeriodMs));
  }
  return VERIFICATION_MAX_TTL_MS;
}

/**
 * Estado EFECTIVO en lectura. `stale` se DERIVA acá y no se guarda nunca: si se persistiera,
 * dependería de que el job que falló vuelva a correr — exactamente el modo de falla que este
 * diseño elimina. Sin estado o sin `metaVerifiedAt` ⇒ `stale` (nunca se leyó: no se afirma
 * nada). `unverifiable` se respeta tal cual: ya es honesto por sí mismo.
 */
export function effectiveMetaSyncState(args: {
  state?: MetaSyncState | null;
  verifiedAtMs?: number | null;
  nowMs: number;
  ttlMs?: number;
}): MetaSyncStateEffective {
  if (args.state === 'unverifiable') return 'unverifiable';
  const ttl = args.ttlMs ?? VERIFICATION_MAX_TTL_MS;
  if (!args.state || typeof args.verifiedAtMs !== 'number' || !Number.isFinite(args.verifiedAtMs)) return 'stale';
  return args.nowMs - args.verifiedAtMs > ttl ? 'stale' : args.state;
}
