/**
 * meta/catalogTestHooks.ts — Hooks de pausa SOLO-EMULADOR para los tests de carreras del
 * outbox de catálogo (META-CATALOG-OUTBOX-1).
 *
 * Mismo contrato que `conversation/coverageTestHooks.ts` (el union de puntos es cerrado y de
 * otro dominio, por eso no se comparte): permiten al E2E detener la ejecución en un punto
 * exacto, mutar el estado (vencer un lease, apagar la config, editar el producto) y reanudar,
 * demostrando que la validación posterior respeta lo que cambió.
 *
 *  - En producción es un no-op inmediato (guardia por FUNCTIONS_EMULATOR, sin lecturas).
 *  - JAMÁS se invoca dentro de una transacción (una pausa adentro la haría expirar): todos los
 *    puntos viven ENTRE transacciones.
 *  - Fixture: `tenants/{t}/_debug/catalogFixtures { holdAt: '<punto>', resume?: boolean }`.
 *  - Nunca lanza: cualquier error deja seguir el flujo real.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../lib/firebase.js';

export type CatalogHoldPoint =
  | 'outbox_pre_claim'
  | 'outbox_pre_submit'
  | 'outbox_post_submit'
  | 'outbox_pre_verify'
  | 'outbox_sweep_pre_tx';

const HOLD_MAX_MS = 20_000;

export async function catalogHold(tenantId: string, point: CatalogHoldPoint): Promise<void> {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') return;
  try {
    const fxRef = db().doc(`tenants/${tenantId}/_debug/catalogFixtures`);
    const fx = await fxRef.get();
    if (fx.data()?.holdAt !== point) return;
    await db().doc(`tenants/${tenantId}/_debug/catalogHolds`).set({ point, at: Timestamp.now() }, { merge: true });
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
