/**
 * Capa de acceso a Meta Ads (panel · D3). Lee los snapshots ya sincronizados
 * (no consulta Meta en cada carga). Solo manager+ (datos de gasto). Sync = job dev.
 */

import { collection, getDocs } from 'firebase/firestore';
import type { MetaCampaign, MetaAdInsightDaily } from '@vpw/shared';
import { firebaseDb } from './firebase';

const API = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:5001/demo-aiafg/us-central1';

export async function listCampaigns(tenantId: string): Promise<MetaCampaign[]> {
  const snap = await getDocs(collection(firebaseDb(), 'tenants', tenantId, 'metaCampaigns'));
  return snap.docs.map((d) => d.data() as MetaCampaign);
}

export async function listAdInsights(tenantId: string): Promise<MetaAdInsightDaily[]> {
  const snap = await getDocs(collection(firebaseDb(), 'tenants', tenantId, 'metaAdInsightsDaily'));
  return snap.docs.map((d) => d.data() as MetaAdInsightDaily);
}

export async function syncAds(tenantId: string): Promise<void> {
  await fetch(`${API}/devSyncMetaAds`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId }) });
}
