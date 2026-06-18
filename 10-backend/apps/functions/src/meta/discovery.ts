/**
 * meta/discovery.ts — Discovery real de activos Meta + escritura del modelo (Fase 4B)
 * ==================================================================================
 * A partir del WABA y sus phone numbers (vía MetaGraphClient), construye los metaAssets
 * y los persiste junto con metaExternalIndex (para resolver inbound por phone_number_id).
 * buildMetaAssets es puro/testeable; la escritura reemplaza los assets del tenant (idempotente
 * en reconexión). Solo Admin SDK (las reglas deniegan escritura del cliente).
 */
import { Timestamp } from 'firebase-admin/firestore';
import type { MetaAssetType } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import type { MetaPhoneNumber } from './graphClient.js';

// Mapeo asset → plataforma para el índice global (igual que connect.ts demo).
const PLATFORM_BY_ASSET: Record<string, string> = {
  whatsapp_phone_number: 'whatsapp',
  instagram_account: 'instagram',
  facebook_page: 'messenger',
};

export interface DiscoveredAsset {
  externalId: string;
  assetType: MetaAssetType;
  name: string;
  selected: boolean;
}

export interface BuildAssetsInput {
  businessId?: string;
  businessName?: string;
  wabaId: string;
  wabaName?: string;
  phones: MetaPhoneNumber[];
  selectedPhoneNumberId: string;
}

/** Construye la lista de metaAssets a partir del discovery (PURO). */
export function buildMetaAssets(input: BuildAssetsInput): DiscoveredAsset[] {
  const assets: DiscoveredAsset[] = [];
  if (input.businessId) {
    assets.push({ externalId: input.businessId, assetType: 'business', name: input.businessName || 'Meta Business', selected: true });
  }
  assets.push({ externalId: input.wabaId, assetType: 'whatsapp_business_account', name: input.wabaName || 'WhatsApp Business', selected: true });
  for (const p of input.phones) {
    assets.push({
      externalId: p.id,
      assetType: 'whatsapp_phone_number',
      name: p.displayPhoneNumber || p.verifiedName || p.id,
      selected: p.id === input.selectedPhoneNumberId,
    });
  }
  return assets;
}

/** Reemplaza los activos del tenant + el índice global (Admin SDK). Idempotente en reconexión. */
export async function writeDiscoveredAssets(tenantId: string, connectionId: string, assets: DiscoveredAsset[]): Promise<void> {
  const now = Timestamp.now();
  const batch = db().batch();
  // Borra los activos previos del tenant y sus entradas de índice (reconexión limpia).
  const oldAssets = await db().collection(paths.metaAssets(tenantId)).get();
  oldAssets.docs.forEach((d) => batch.delete(d.ref));
  const oldIdx = await db().collection(paths.metaExternalIndex()).where('tenantId', '==', tenantId).get();
  oldIdx.docs.forEach((d) => batch.delete(d.ref));

  for (const a of assets) {
    batch.set(db().doc(paths.metaAsset(tenantId, a.externalId)), {
      id: a.externalId, tenantId, connectionId, assetType: a.assetType, externalId: a.externalId, name: a.name, status: 'active', selected: a.selected, createdAt: now, updatedAt: now,
    });
    const platform = PLATFORM_BY_ASSET[a.assetType];
    if (platform) {
      const id = `${platform}_${a.externalId}`;
      batch.set(db().doc(paths.metaExternalIndexEntry(id)), { id, tenantId, connectionId, assetType: a.assetType, platform, externalId: a.externalId, status: 'active', updatedAt: now });
    }
  }
  await batch.commit();
}

/** Marca un phone_number como seleccionado (y deselecciona los demás) para el envío. */
export async function selectTenantPhoneNumber(tenantId: string, phoneNumberId: string): Promise<boolean> {
  const snap = await db().collection(paths.metaAssets(tenantId)).where('assetType', '==', 'whatsapp_phone_number').get();
  const target = snap.docs.find((d) => (d.data().externalId as string) === phoneNumberId);
  if (!target) return false;
  const now = Timestamp.now();
  const batch = db().batch();
  for (const d of snap.docs) {
    batch.set(d.ref, { selected: d.id === target.id, updatedAt: now }, { merge: true });
  }
  await batch.commit();
  return true;
}
