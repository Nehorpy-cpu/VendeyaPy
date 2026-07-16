/**
 * COVERAGE-FLAG-OFF-HARDEN-1 — Contrato fuerte del feature flag de cobertura.
 * ===========================================================================
 * La cobertura solo está OPERATIVA con `enabled === true` Y un `activationId` VÁLIDO.
 * Cada activación del flujo usa un identificador opaco NUEVO (lo escribe el programa de
 * activación, jamás el código en runtime): los requests/jobs/outbox creados bajo una activación
 * anterior quedan INERTES ante una reactivación — se comparan por igualdad exacta.
 *
 * Fail-closed: ausente, enabled !== true, activationId faltante/ inválido ⇒ deshabilitado.
 * PURO y compartido: el backend (autoridad) y el panel (solo UI) validan con la MISMA regla.
 */

export interface CoverageActivation {
  enabled: boolean;
  /** Identificador opaco de la activación vigente (no sensible, no es timestamp-autoridad). */
  activationId: string | null;
}

/** Forma exigida del activationId: opaco, corto y sin datos sensibles. */
export const COVERAGE_ACTIVATION_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

const OFF: CoverageActivation = { enabled: false, activationId: null };

/**
 * Valida el bloque crudo `coverage` de `config/checkout`. Cualquier cosa rara ⇒ OFF.
 * `enabled: true` SIN activationId válido también es OFF (fail-closed, contrato ETAPA A).
 */
export function coverageActivationOf(raw: unknown): CoverageActivation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return OFF;
  if ((raw as { enabled?: unknown }).enabled !== true) return OFF;
  const id = (raw as { activationId?: unknown }).activationId;
  if (typeof id !== 'string' || !COVERAGE_ACTIVATION_ID_RE.test(id)) return OFF;
  return { enabled: true, activationId: id };
}
