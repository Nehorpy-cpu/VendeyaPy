/**
 * meta/ads.ts — Sincronización de Meta Ads (D3, solo lectura)
 * ==========================================================
 * En modo DEMO genera campañas/adsets/ads + snapshots diarios (últimos 7 días),
 * simulando lo que traería la sync real de Meta. Guardar snapshots evita consultar
 * Meta en cada carga del dashboard (ADR-0009). Idempotente: ids deterministas.
 * Atribución (orders/revenue/roas) la completa D5.
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { MetaCampaign, MetaAdset, MetaAd, MetaAdInsightDaily, MetaAdMetrics } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';

const DAY = 86_400_000;
const FACTORS = [1.0, 1.2, 0.9, 1.1, 0.8, 1.0, 1.0]; // variación por día (determinista)
const dayKey = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

function metrics(impr: number, clicks: number, spend: number, convs: number): MetaAdMetrics {
  return {
    impressions: impr,
    reach: Math.round(impr * 0.8),
    clicks,
    spend,
    ctr: impr ? Number(((clicks / impr) * 100).toFixed(2)) : 0,
    cpc: clicks ? Math.round(spend / clicks) : 0,
    cpm: impr ? Math.round((spend / impr) * 1000) : 0,
    conversations: convs,
  };
}

const CAMPAIGNS = [
  { id: 'camp-1', name: 'Perfumes — Día de la Madre', objective: 'MESSAGES', ad: { id: 'ad-1', name: 'Video Good Girl', creative: 'Video 15s', impr: 1260, clicks: 84, spend: 90000, convs: 18 } },
  { id: 'camp-2', name: 'Retargeting — Carrito abandonado', objective: 'MESSAGES', ad: { id: 'ad-2', name: 'Carrusel de ofertas', creative: 'Carrusel 3 productos', impr: 630, clicks: 56, spend: 45000, convs: 12 } },
];

export async function syncMetaAdsDemo(tenantId: string): Promise<{ campaigns: number; insights: number }> {
  const now = Timestamp.now();
  const batch = db().batch();
  let insights = 0;

  for (const c of CAMPAIGNS) {
    const adsetId = c.id.replace('camp', 'adset');
    const m = metrics(c.ad.impr, c.ad.clicks, c.ad.spend, c.ad.convs);

    const campaign: MetaCampaign = { id: c.id, tenantId, externalCampaignId: c.id, name: c.name, status: 'ACTIVE', objective: c.objective, adAccountId: 'act_400', dailyBudget: 50000, lifetimeBudget: null, spendCap: null, latestMetrics: m, lastSyncedAt: now, createdAt: now, updatedAt: now };
    batch.set(db().doc(paths.metaCampaign(tenantId, c.id)), campaign);

    const adset: MetaAdset = { id: adsetId, tenantId, externalAdsetId: adsetId, externalCampaignId: c.id, name: `${c.name} — Adset`, status: 'ACTIVE', budget: 50000, optimizationGoal: 'CONVERSATIONS', latestMetrics: m, lastSyncedAt: now, createdAt: now, updatedAt: now };
    batch.set(db().doc(paths.metaAdset(tenantId, adsetId)), adset);

    const ad: MetaAd = { id: c.ad.id, tenantId, externalAdId: c.ad.id, externalAdsetId: adsetId, externalCampaignId: c.id, name: c.ad.name, status: 'ACTIVE', creativeSummary: c.ad.creative, previewUrl: '', latestMetrics: m, lastSyncedAt: now, createdAt: now, updatedAt: now };
    batch.set(db().doc(paths.metaAd(tenantId, c.ad.id)), ad);

    for (let i = 0; i < 7; i++) {
      const f = FACTORS[i] ?? 1;
      const d = new Date(Date.now() - i * DAY);
      const date = dayKey(d);
      const impr = Math.round((c.ad.impr / 7) * f);
      const clicks = Math.round((c.ad.clicks / 7) * f);
      const spend = Math.round((c.ad.spend / 7) * f);
      const convs = Math.round((c.ad.convs / 7) * f);
      const id = `${date}_${c.ad.id}`;
      const ins: MetaAdInsightDaily = {
        id, date, tenantId, externalCampaignId: c.id, externalAdsetId: adsetId, externalAdId: c.ad.id, campaignName: c.name, adName: c.ad.name,
        impressions: impr, reach: Math.round(impr * 0.8), clicks, spend,
        ctr: impr ? Number(((clicks / impr) * 100).toFixed(2)) : 0, cpc: clicks ? Math.round(spend / clicks) : 0, cpm: impr ? Math.round((spend / impr) * 1000) : 0, conversations: convs,
        orders: 0, revenue: 0, productCost: null, grossProfit: null, roas: null, margin: null, // atribución: D5
        createdAt: now, updatedAt: now,
      };
      batch.set(db().doc(paths.metaAdInsightDaily(tenantId, id)), ins);
      insights++;
    }
  }

  await batch.commit();
  logger.info('Meta Ads (demo) sincronizado', { tenantId, campaigns: CAMPAIGNS.length, insights });
  return { campaigns: CAMPAIGNS.length, insights };
}
