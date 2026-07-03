/**
 * meta/attribution.ts — Atribución anuncio → pedido → ganancia real (D5)
 * =====================================================================
 * Agrega, por campaña, los pedidos PAID atribuidos a ella: ventas, ingresos,
 * ganancia (de orderFinancials) y ROAS (ingresos / gasto). Es el DIFERENCIAL:
 * muestra qué campaña deja plata de verdad, no solo las métricas de Meta. Ver ADR-0009.
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { Order, OrderFinancials, MetaCampaign, CampaignAttribution } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { PAID_ORDER_STATUSES } from '../orders/lifecycle.js';

const PAID = PAID_ORDER_STATUSES; // fuente única (ORDER-1): orders/lifecycle.ts

export async function computeAttribution(tenantId: string): Promise<number> {
  const [ordSnap, finSnap, campSnap] = await Promise.all([
    db().collection(paths.orders(tenantId)).get(),
    db().collection(paths.orderFinancials(tenantId)).get(),
    db().collection(paths.metaCampaigns(tenantId)).get(),
  ]);
  const fins = new Map<string, OrderFinancials>();
  finSnap.docs.forEach((d) => fins.set(d.id, d.data() as OrderFinancials));

  // Agregar por campaña los pedidos vendidos atribuidos.
  const byCampaign = new Map<string, { orders: number; revenue: number; grossProfit: number; profitKnown: boolean }>();
  ordSnap.docs
    .map((d) => d.data() as Order)
    .filter((o) => PAID.includes(o.status) && o.attribution?.campaignId)
    .forEach((o) => {
      const cid = o.attribution!.campaignId as string;
      const fin = fins.get(o.id);
      const e = byCampaign.get(cid) ?? { orders: 0, revenue: 0, grossProfit: 0, profitKnown: true };
      e.orders += 1;
      e.revenue += o.totals.total;
      if (fin?.grossProfit == null) e.profitKnown = false;
      else e.grossProfit += fin.grossProfit;
      byCampaign.set(cid, e);
    });

  const now = Timestamp.now();
  const batch = db().batch();
  for (const camp of campSnap.docs) {
    const c = camp.data() as MetaCampaign;
    const e = byCampaign.get(c.externalCampaignId) ?? { orders: 0, revenue: 0, grossProfit: 0, profitKnown: true };
    const spend = c.latestMetrics?.spend ?? 0;
    const grossProfit = e.orders === 0 ? 0 : e.profitKnown ? e.grossProfit : null;
    const attribution: CampaignAttribution = {
      orders: e.orders,
      revenue: e.revenue,
      grossProfit,
      roas: spend > 0 ? Number((e.revenue / spend).toFixed(2)) : null,
      margin: grossProfit != null && e.revenue > 0 ? Number(((grossProfit / e.revenue) * 100).toFixed(1)) : null,
      updatedAt: now,
    };
    batch.set(camp.ref, { attribution }, { merge: true });
  }
  await batch.commit();
  logger.info('Atribución calculada', { tenantId, campañasConVentas: byCampaign.size });
  return byCampaign.size;
}
