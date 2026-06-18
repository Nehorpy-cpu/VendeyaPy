/**
 * tracking/tracking.ts — Tracking propio sin Meta (P11)
 * =====================================================
 * captureTrackingCode: el motor detecta un código (cupón/QR/link) en el mensaje y
 * atribuye al cliente a esa fuente propia (first-touch: no pisa una atribución previa).
 * computeTrackingAttribution: agrega ventas/ingresos/ganancia por código. Ver ADR-0009.
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { Order, OrderFinancials, TrackingSource, CampaignAttribution } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';

const PAID = ['PAID', 'PREPARING', 'ASSIGNED', 'IN_TRANSIT', 'DELIVERED'];

/** Si el mensaje contiene un código activo, atribuye el cliente a esa fuente. */
export async function captureTrackingCode(tenantId: string, customerId: string, text: string): Promise<string | null> {
  if (!text) return null;
  const lower = text.toLowerCase();
  const snap = await db().collection(paths.trackingSources(tenantId)).where('active', '==', true).get();
  const match = snap.docs.map((d) => d.data() as TrackingSource).find((s) => s.code && lower.includes(s.code.toLowerCase()));
  if (!match) return null;

  // First-touch: no pisar una atribución ya existente (ej: vino de un anuncio de Meta).
  const cust = (await db().doc(paths.customer(tenantId, customerId)).get()).data() as { attribution?: { campaignId?: string | null } } | undefined;
  if (cust?.attribution?.campaignId) return null;

  await db().doc(paths.customer(tenantId, customerId)).set(
    { attribution: { campaignId: match.id, adId: null, type: 'coupon_match', confidence: 0.9, platform: null }, updatedAt: Timestamp.now() },
    { merge: true },
  );
  logger.info('Código de tracking capturado', { tenantId, customerId, code: match.code });
  return match.id;
}

/** Agrega por código las ventas atribuidas (ventas/ingresos/ganancia). */
export async function computeTrackingAttribution(tenantId: string): Promise<number> {
  const [ordSnap, finSnap, srcSnap] = await Promise.all([
    db().collection(paths.orders(tenantId)).get(),
    db().collection(paths.orderFinancials(tenantId)).get(),
    db().collection(paths.trackingSources(tenantId)).get(),
  ]);
  const fins = new Map<string, OrderFinancials>();
  finSnap.docs.forEach((d) => fins.set(d.id, d.data() as OrderFinancials));

  const byId = new Map<string, { orders: number; revenue: number; grossProfit: number; profitKnown: boolean }>();
  ordSnap.docs
    .map((d) => d.data() as Order)
    .filter((o) => PAID.includes(o.status) && o.attribution?.campaignId)
    .forEach((o) => {
      const cid = o.attribution!.campaignId as string;
      const fin = fins.get(o.id);
      const e = byId.get(cid) ?? { orders: 0, revenue: 0, grossProfit: 0, profitKnown: true };
      e.orders += 1;
      e.revenue += o.totals.total;
      if (fin?.grossProfit == null) e.profitKnown = false;
      else e.grossProfit += fin.grossProfit;
      byId.set(cid, e);
    });

  const now = Timestamp.now();
  const batch = db().batch();
  let withSales = 0;
  for (const src of srcSnap.docs) {
    const e = byId.get(src.id) ?? { orders: 0, revenue: 0, grossProfit: 0, profitKnown: true };
    const grossProfit = e.orders === 0 ? 0 : e.profitKnown ? e.grossProfit : null;
    const attribution: CampaignAttribution = {
      orders: e.orders, revenue: e.revenue, grossProfit,
      roas: null, // las campañas propias no tienen gasto de ads
      margin: grossProfit != null && e.revenue > 0 ? Number(((grossProfit / e.revenue) * 100).toFixed(1)) : null,
      updatedAt: now,
    };
    batch.set(src.ref, { attribution }, { merge: true });
    if (e.orders > 0) withSales++;
  }
  await batch.commit();
  logger.info('Atribución de tracking propio calculada', { tenantId, conVentas: withSales });
  return withSales;
}
