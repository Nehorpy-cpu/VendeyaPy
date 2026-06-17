/**
 * promotions/suggest.ts — Sugerencias de promoción por REGLAS (P8)
 * ================================================================
 * Mira productos + costo (productFinancials) + ventas y propone promos con
 * reglas simples (sin IA cara). Escribe en tenants/{t}/insights con
 * type=PROMO_SUGGESTION. Idempotente: ids deterministas; NO revive las que el
 * dueño ya descartó/aceptó; limpia las PENDING que dejaron de aplicar. Ver ADR-0006.
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { Product, ProductFinancials, Order, Insight } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';

const PAID = ['PAID', 'PREPARING', 'ASSIGNED', 'IN_TRANSIT', 'DELIVERED'];
const GS = (n: number) => '₲ ' + Math.round(n).toLocaleString('es-PY');

type NewInsight = Omit<Insight, 'id' | 'tenantId' | 'createdAt' | 'resolvedAt' | 'status' | 'generatedBy'>;

export async function generatePromotionSuggestions(tenantId: string): Promise<number> {
  const [prodSnap, finSnap, ordSnap, insSnap] = await Promise.all([
    db().collection(paths.products(tenantId)).get(),
    db().collection(paths.productFinancials(tenantId)).get(),
    db().collection(paths.orders(tenantId)).get(),
    db().collection(paths.insights(tenantId)).where('type', '==', 'PROMO_SUGGESTION').get(),
  ]);

  const products = prodSnap.docs.map((d) => d.data() as Product);
  const costOf = new Map<string, number | null>();
  finSnap.docs.forEach((d) => costOf.set(d.id, (d.data() as ProductFinancials).costPrice ?? null));

  const soldUnits = new Map<string, number>();
  ordSnap.docs
    .map((d) => d.data() as Order)
    .filter((o) => PAID.includes(o.status))
    .forEach((o) => o.items.forEach((it) => soldUnits.set(it.productId, (soldUnits.get(it.productId) ?? 0) + it.quantity)));

  // Qué ya decidió el dueño (no revivir) vs PENDING actuales (para limpiar las que ya no aplican).
  const acted = new Set<string>();
  const existingPending = new Set<string>();
  insSnap.docs.forEach((d) => {
    const s = (d.data() as Insight).status;
    if (s !== 'PENDING') acted.add(d.id);
    else existingPending.add(d.id);
  });

  const now = Timestamp.now();
  const batch = db().batch();
  const generated = new Set<string>();
  const add = (id: string, ins: NewInsight) => {
    generated.add(id);
    if (acted.has(id)) return; // el dueño ya lo aceptó/descartó
    const full: Insight = { id, tenantId, ...ins, generatedBy: 'rules', status: 'PENDING', createdAt: now, resolvedAt: null };
    batch.set(db().doc(paths.insight(tenantId, id)), full);
  };

  for (const p of products) {
    if (p.status !== 'ACTIVE') continue;
    const stock = p.inventory?.stock ?? 0;
    const cost = costOf.get(p.id) ?? null;
    const margin = cost != null && p.price > 0 ? ((p.price - cost) / p.price) * 100 : null;
    const sold = soldUnits.get(p.id) ?? 0;

    // Regla "estrella oculta": buen margen + stock, pero no está destacado.
    if (margin != null && margin >= 30 && stock >= 5 && !p.featured) {
      add(`promo-estrella-${p.id}`, {
        type: 'PROMO_SUGGESTION',
        title: `Destacá "${p.name}"`,
        description: `Buen margen (${Math.round(margin)}%) y stock (${stock} u.), pero no está destacado.`,
        priority: 'MEDIUM',
        relatedEntityType: 'product',
        relatedEntityId: p.id,
        estimatedImpact: `Producto rentable: ganás ${GS(p.price - (cost ?? 0))} por unidad.`,
        recommendedAction: 'Destacalo en el catálogo o armá una promo para empujarlo.',
      });
    }

    // Regla "stock parado": mucho stock y sin ventas.
    if (stock >= 15 && sold === 0) {
      add(`promo-parado-${p.id}`, {
        type: 'PROMO_SUGGESTION',
        title: `Mové el stock de "${p.name}"`,
        description: `Tenés ${stock} unidades y todavía no se vendió ninguna.`,
        priority: 'HIGH',
        relatedEntityType: 'product',
        relatedEntityId: p.id,
        estimatedImpact: `Rotar ~${stock} unidades y liberar capital.`,
        recommendedAction: 'Creá una promo (descuento o 2x1) para moverlo.',
      });
    }
  }

  // Limpiar las sugerencias PENDING que ya no aplican (ej: el producto se vendió).
  for (const id of existingPending) if (!generated.has(id)) batch.delete(db().doc(paths.insight(tenantId, id)));

  await batch.commit();
  logger.info('Sugerencias de promo generadas', { tenantId, generadas: generated.size });
  return generated.size;
}
