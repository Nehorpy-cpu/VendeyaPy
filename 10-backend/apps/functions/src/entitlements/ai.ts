/**
 * entitlements/ai.ts — Presupuesto de IA por turno (ADR-0018)
 * ===========================================================
 * Antes: assertAiBudget (check suelto) + recordAiUsage (increment ciego posterior) — el
 * check-then-act que permitió el sobregiro del 2026-07-15. Ahora: UNA operación que abre el
 * ciclo completo — feature gate + RESERVA transaccional — y devuelve el handle con el que el
 * caller liquida el uso real o libera. Los códigos de error son los mismos de siempre
 * ('failed-precondition' | 'resource-exhausted'): los mapeos estructurados de los agentes no
 * cambian.
 */
import { reservarTurnoDeIa, type ReservaDeIa } from './aiReservation.js';

/**
 * Abre el presupuesto de un turno de IA: valida feature/posture/trial y reserva capacidad
 * de forma atómica ANTES de contactar al proveedor. El caller debe cerrar el ciclo:
 * `liquidar(usoReal, costo)` tras la respuesta (o el error con consumo parcial) y
 * `liberar()` si el proveedor jamás fue contactado. Una reserva sin cerrar vence sola
 * (lease) y la recupera el mantenimiento — nunca hay doble cobro.
 */
export async function abrirPresupuestoDeIa(
  tenantId: string,
  clave: string,
  estimatedTokens: number,
  context: string,
  actorUid?: string | null,
): Promise<ReservaDeIa> {
  return reservarTurnoDeIa(tenantId, clave, estimatedTokens, { context, actorUid });
}
