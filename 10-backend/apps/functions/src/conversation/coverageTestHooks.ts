/**
 * COVERAGE-KILL-SWITCH-ATOMICITY-1 — Hooks de pausa SOLO-EMULADOR para tests de carreras.
 * =======================================================================================
 * Permiten a los E2E detener la ejecución en un punto exacto, cambiar el flag y reanudar,
 * demostrando que la validación EN-TRANSACCIÓN posterior respeta el kill-switch.
 *
 * El mecanismo nació con el kill-switch de cobertura pero es GENÉRICO (pausar, mutar estado,
 * reanudar): ADR-0016 §12 lo reusa para la carrera takeover→envío en vez de duplicar 50 líneas
 * de hook. Un punto nuevo es un miembro más de la unión de abajo, nada más.
 *
 * Contrato:
 *  - En producción es un no-op inmediato (guardia por FUNCTIONS_EMULATOR, sin lecturas).
 *  - JAMÁS se invoca dentro de una transacción (una pausa dentro de una tx la haría expirar):
 *    todos los checkpoints viven ENTRE transacciones, antes de la validación que se testea.
 *  - Fixture: `tenants/{t}/_debug/coverageFixtures { holdAt: '<punto>', resume?: boolean }`.
 *    Al alcanzar el punto se escribe `_debug/coverageHolds { point, at }` (señal para el test)
 *    y se espera `resume: true` (o el cambio/limpieza de holdAt), con tope de 20 s.
 *  - Nunca lanza: cualquier error deja seguir el flujo real.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../lib/firebase.js';

export type CoverageHoldPoint =
  | 'gate_pre_tx'
  | 'ubicacion_pre_tx'
  | 'pre_handoff'
  | 'reply_pre_send'
  /**
   * ADR-0016 §12: la respuesta YA está construida y el cliente de WhatsApp YA está resuelto; lo
   * único que falta es el chequeo autoritativo de silencio y el POST. Pausar acá es lo que
   * permite activar `humanTakeover` en el medio y probar que el bot no le pisa el chat al
   * vendedor. Se dispara en TODA respuesta automática, sea de cobertura o no.
   */
  | 'bot_reply_pre_send'
  | 'resume_pre_liberar'
  | 'resume_pre_orden'
  | 'resume_pre_awaiting'
  | 'outbox_pre_claim'
  | 'outbox_pre_meta'
  | 'outbox_post_meta'
  | 'mant_pre_reencolar'
  | 'sweep_pre_tx';

const HOLD_MAX_MS = 20_000;

export async function coverageHold(tenantId: string, point: CoverageHoldPoint): Promise<void> {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') return;
  try {
    const fxRef = db().doc(`tenants/${tenantId}/_debug/coverageFixtures`);
    const fx = await fxRef.get();
    if (fx.data()?.holdAt !== point) return;
    await db().doc(`tenants/${tenantId}/_debug/coverageHolds`).set({ point, at: Timestamp.now() }, { merge: true });
    const deadline = Date.now() + HOLD_MAX_MS;
    while (Date.now() < deadline) {
      const f = (await fxRef.get()).data();
      if (!f || f.holdAt !== point || f.resume === true) return;
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch {
    // El hook jamás rompe el flujo real.
  }
}
