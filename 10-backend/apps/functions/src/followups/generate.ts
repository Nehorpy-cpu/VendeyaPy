/**
 * followups/generate.ts — Tareas de seguimiento por REGLAS (P14)
 * ==============================================================
 * Reglas baratas (sin IA) que crean tareas para el vendedor con un MENSAJE
 * SUGERIDO listo para enviar a mano (no se envía nada automático). En
 * tenants/{t}/followUpTasks. Idempotente: ids deterministas, no revive lo
 * que el vendedor ya tocó, limpia las que dejan de aplicar. Ver ADR-0006.
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { Customer, Order, FollowUpTask } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';

const DAY = 86_400_000;
const cname = (c?: Customer) => c?.name?.trim() || c?.whatsappPhone || c?.id || 'el cliente';
const hi = (c?: Customer) => `¡Hola${c?.name ? ' ' + c.name : ''}!`;
const ms = (ts: unknown): number => (ts as { toDate?: () => Date } | null)?.toDate?.()?.getTime() ?? 0;

type NewTask = Omit<FollowUpTask, 'id' | 'tenantId' | 'createdAt' | 'completedAt' | 'status'>;

async function syncTasks(tenantId: string, items: Array<{ id: string; task: NewTask }>): Promise<number> {
  const existing = await db().collection(paths.followUpTasks(tenantId)).get();
  const acted = new Set<string>();
  const pending = new Set<string>();
  existing.docs.forEach((d) => {
    const s = (d.data() as FollowUpTask).status;
    if (s !== 'PENDING') acted.add(d.id);
    else pending.add(d.id);
  });
  const now = Timestamp.now();
  const batch = db().batch();
  const gen = new Set<string>();
  for (const { id, task } of items) {
    gen.add(id);
    if (acted.has(id)) continue;
    const full: FollowUpTask = { id, tenantId, ...task, status: 'PENDING', createdAt: now, completedAt: null };
    batch.set(db().doc(paths.followUpTask(tenantId, id)), full);
  }
  for (const id of pending) if (!gen.has(id)) batch.delete(db().doc(paths.followUpTask(tenantId, id)));
  await batch.commit();
  return gen.size;
}

export async function generateFollowUpTasks(tenantId: string): Promise<number> {
  const [custSnap, ordSnap] = await Promise.all([
    db().collection(paths.customers(tenantId)).get(),
    db().collection(paths.orders(tenantId)).get(),
  ]);
  const customers = new Map<string, Customer>();
  custSnap.docs.forEach((d) => customers.set(d.id, d.data() as Customer));
  const orders = ordSnap.docs.map((d) => d.data() as Order);
  const nowMs = Date.now();
  const due = Timestamp.fromMillis(nowMs + DAY);
  const items: Array<{ id: string; task: NewTask }> = [];

  // Por pedido: pago pendiente / comprobante a verificar.
  for (const o of orders) {
    const c = customers.get(o.customerId);
    const sellerId = c?.assignedSellerId ?? null;
    if (o.status === 'PENDING_PAYMENT') {
      items.push({ id: `fu-pay-${o.id}`, task: { customerId: o.customerId, conversationId: o.customerId, sellerId, type: 'PAYMENT_PENDING', title: `Seguí el pago de ${cname(c)}`, suggestedMessage: `${hi(c)} ¿Pudiste hacer la transferencia? Cualquier cosa te ayudo 😊`, priority: 'HIGH', dueAt: due } });
    } else if (o.status === 'PENDING_VERIFICATION') {
      items.push({ id: `fu-verify-${o.id}`, task: { customerId: o.customerId, conversationId: o.customerId, sellerId, type: 'VERIFY_RECEIPT', title: `Verificá el comprobante de ${cname(c)}`, suggestedMessage: 'Revisá el comprobante recibido y confirmá el pago para liberar el pedido.', priority: 'HIGH', dueAt: due } });
    }
  }

  // Por cliente: preguntó y no compró (caliente) / recompra.
  for (const c of customers.values()) {
    const sellerId = c.assignedSellerId ?? null;
    if (c.customerType === 'HOT') {
      items.push({ id: `fu-engage-${c.id}`, task: { customerId: c.id, conversationId: c.id, sellerId, type: 'ENGAGE', title: `Escribile a ${cname(c)}`, suggestedMessage: `${hi(c)} ¿Seguís interesada? Tengo algo que te puede encantar 🌸`, priority: 'MEDIUM', dueAt: due } });
    }
    const lastOrderMs = ms(c.stats?.lastOrderAt);
    if ((c.stats?.totalOrders ?? 0) >= 1 && lastOrderMs && nowMs - lastOrderMs >= 30 * DAY) {
      items.push({ id: `fu-repurchase-${c.id}`, task: { customerId: c.id, conversationId: c.id, sellerId, type: 'REPURCHASE', title: `Ofrecé una recompra a ${cname(c)}`, suggestedMessage: `${hi(c)} Llegaron novedades que te pueden gustar. ¿Te muestro? 💖`, priority: 'LOW', dueAt: due } });
    }
  }

  const n = await syncTasks(tenantId, items);
  logger.info('Follow-ups generados', { tenantId, tareas: n });
  return n;
}
