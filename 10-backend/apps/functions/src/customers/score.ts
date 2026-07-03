/**
 * customers/score.ts — Score y segmentación de clientes por REGLAS (P12)
 * =====================================================================
 * Calcula, por cliente, un tipo (nuevo/caliente/comprador/recurrente/premium/
 * dormido/perdido) y un puntaje 0-100 (RFM-lite: recencia + frecuencia + monto),
 * a partir de pedidos PAID + última interacción. Escribe en el doc del cliente.
 * Sin IA: reglas baratas (ADR-0006). En prod corre como job programado.
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { Customer, Order, CustomerType } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { PAID_ORDER_STATUSES } from '../orders/lifecycle.js';

const PAID = PAID_ORDER_STATUSES; // fuente única (ORDER-1): orders/lifecycle.ts
const DAY = 86_400_000;
const PREMIUM_SPENT = 1_000_000; // ₲ — umbral "premium" (configurable a futuro)

const ms = (ts: unknown): number => (ts as { toDate?: () => Date } | null)?.toDate?.()?.getTime() ?? 0;

export async function recomputeCustomerScores(tenantId: string): Promise<number> {
  const [custSnap, ordSnap] = await Promise.all([
    db().collection(paths.customers(tenantId)).get(),
    db().collection(paths.orders(tenantId)).get(),
  ]);
  const nowMs = Date.now();
  const now = Timestamp.now();

  // Agregar pedidos PAID por cliente.
  const agg = new Map<string, { orders: number; spent: number; lastOrderMs: number }>();
  ordSnap.docs
    .map((d) => d.data() as Order)
    .filter((o) => PAID.includes(o.status))
    .forEach((o) => {
      const e = agg.get(o.customerId) ?? { orders: 0, spent: 0, lastOrderMs: 0 };
      e.orders += 1;
      e.spent += o.totals.total;
      e.lastOrderMs = Math.max(e.lastOrderMs, ms(o.createdAt));
      agg.set(o.customerId, e);
    });

  const batch = db().batch();
  let count = 0;
  for (const doc of custSnap.docs) {
    const c = doc.data() as Customer;
    const a = agg.get(c.id) ?? { orders: 0, spent: 0, lastOrderMs: 0 };
    const interactionMs = ms(c.conversation?.lastMessageAt) || ms(c.updatedAt);
    const dInteraction = interactionMs ? (nowMs - interactionMs) / DAY : Infinity;

    // Tipo (cascada de prioridad).
    let type: CustomerType;
    if (dInteraction > 90) type = 'LOST';
    else if (dInteraction > 30) type = 'DORMANT';
    else if (a.spent >= PREMIUM_SPENT) type = 'PREMIUM';
    else if (a.orders >= 2) type = 'RECURRING';
    else if (a.orders === 1) type = 'BUYER';
    else if (dInteraction <= 7) type = 'HOT';
    else type = 'NEW';

    // Score 0-100 (RFM-lite).
    const recency = dInteraction === Infinity ? 0 : Math.max(0, 100 - dInteraction * 2);
    const frequency = Math.min(100, a.orders * 30);
    const monetary = Math.min(100, (a.spent / PREMIUM_SPENT) * 100);
    const score = Math.round(0.4 * recency + 0.3 * frequency + 0.3 * monetary);

    batch.set(
      doc.ref,
      {
        customerType: type,
        customerScore: score,
        stats: {
          totalOrders: a.orders,
          totalSpent: a.spent,
          lastOrderAt: a.lastOrderMs ? Timestamp.fromMillis(a.lastOrderMs) : null,
          firstOrderAt: c.stats?.firstOrderAt ?? null,
        },
        updatedAt: now,
      },
      { merge: true },
    );
    count++;
  }
  await batch.commit();
  logger.info('Scores de clientes recalculados', { tenantId, clientes: count });
  return count;
}
