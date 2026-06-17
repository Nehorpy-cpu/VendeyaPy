/**
 * decisions/insights.ts — Generadores del Centro de Decisiones (P13)
 * ==================================================================
 * Reglas baratas (sin IA) que producen "acciones de hoy" en tenants/{t}/insights:
 *   - CUSTOMER_REACTIVATION: clientes dormidos/perdidos que ya compraron.
 *   - PENDING_REPLY: conversaciones con mensajes sin responder.
 * `generateAllInsights` corre además las sugerencias de promo (P8). Ver ADR-0006.
 * Idempotente: ids deterministas, no revive lo que el dueño marcó, limpia lo viejo.
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { Customer, Insight } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { generatePromotionSuggestions } from '../promotions/suggest.js';
import { generateFollowUpTasks } from '../followups/generate.js';

type NewInsight = Omit<Insight, 'id' | 'tenantId' | 'createdAt' | 'resolvedAt' | 'status' | 'generatedBy'>;
const cname = (c: Customer) => c.name?.trim() || c.whatsappPhone || c.id;

/** Sincroniza los insights PENDING de un tipo: crea/actualiza los vigentes, respeta
 *  los que el dueño ya tocó, y borra los PENDING que dejaron de aplicar. */
async function syncInsights(tenantId: string, type: string, items: Array<{ id: string; ins: NewInsight }>): Promise<number> {
  const existing = await db().collection(paths.insights(tenantId)).where('type', '==', type).get();
  const acted = new Set<string>();
  const pending = new Set<string>();
  existing.docs.forEach((d) => {
    const s = (d.data() as Insight).status;
    if (s !== 'PENDING') acted.add(d.id);
    else pending.add(d.id);
  });

  const now = Timestamp.now();
  const batch = db().batch();
  const generated = new Set<string>();
  for (const { id, ins } of items) {
    generated.add(id);
    if (acted.has(id)) continue;
    const full: Insight = { id, tenantId, ...ins, generatedBy: 'rules', status: 'PENDING', createdAt: now, resolvedAt: null };
    batch.set(db().doc(paths.insight(tenantId, id)), full);
  }
  for (const id of pending) if (!generated.has(id)) batch.delete(db().doc(paths.insight(tenantId, id)));
  await batch.commit();
  return generated.size;
}

/** Clientes dormidos/perdidos que ya compraron → reactivar. */
export async function generateReactivationInsights(tenantId: string): Promise<number> {
  const snap = await db().collection(paths.customers(tenantId)).get();
  const items = snap.docs
    .map((d) => d.data() as Customer)
    .filter((c) => (c.customerType === 'DORMANT' || c.customerType === 'LOST') && (c.stats?.totalOrders ?? 0) >= 1)
    .map((c) => ({
      id: `react-${c.id}`,
      ins: {
        type: 'CUSTOMER_REACTIVATION',
        title: `Reactivá a ${cname(c)}`,
        description: `Compró antes (${c.stats?.totalOrders ?? 0} pedido(s)) pero está ${c.customerType === 'DORMANT' ? 'dormido' : 'perdido'}.`,
        priority: c.customerType === 'DORMANT' ? 'MEDIUM' : 'LOW',
        relatedEntityType: 'customer',
        relatedEntityId: c.id,
        estimatedImpact: 'Recuperar un cliente que ya confió en vos.',
        recommendedAction: 'Escribile una oferta o novedad para traerlo de vuelta.',
      } as NewInsight,
    }));
  return syncInsights(tenantId, 'CUSTOMER_REACTIVATION', items);
}

/** Conversaciones con mensajes sin responder (el bot no atiende). */
export async function generatePendingReplyInsights(tenantId: string): Promise<number> {
  const snap = await db().collection(paths.customers(tenantId)).get();
  const items = snap.docs
    .map((d) => d.data() as Customer)
    .filter((c) => (c.conversation?.unreadForSeller ?? 0) > 0)
    .map((c) => ({
      id: `reply-${c.id}`,
      ins: {
        type: 'PENDING_REPLY',
        title: `Respondé a ${cname(c)}`,
        description: `Tiene ${c.conversation?.unreadForSeller ?? 0} mensaje(s) sin responder.`,
        priority: 'HIGH',
        relatedEntityType: 'customer',
        relatedEntityId: c.id,
        estimatedImpact: 'No perder una venta por demora en responder.',
        recommendedAction: 'Abrí la conversación y respondé al cliente.',
      } as NewInsight,
    }));
  return syncInsights(tenantId, 'PENDING_REPLY', items);
}

/** Corre TODOS los generadores de reglas (promos P8 + reactivación + sin responder). */
export async function generateAllInsights(tenantId: string): Promise<Record<string, number>> {
  const promo = await generatePromotionSuggestions(tenantId);
  const reactivation = await generateReactivationInsights(tenantId);
  const pendingReply = await generatePendingReplyInsights(tenantId);
  const followups = await generateFollowUpTasks(tenantId);
  const out = { promo, reactivation, pendingReply, followups };
  logger.info('Insights del Centro de Decisiones generados', { tenantId, ...out });
  return out;
}
