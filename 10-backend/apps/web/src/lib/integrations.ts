/**
 * Capa de acceso al Centro de Integración Meta (panel · D1).
 * Lectura de la conexión + activos (solo manager+, por reglas). Conectar/desconectar
 * pasa por Cloud Functions (en demo, los endpoints dev; en prod, OAuth real).
 */

import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import type { MetaConnection, MetaAsset, MetaConversionEvent } from '@vpw/shared';
import { firebaseDb } from './firebase';

const API = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:5001/demo-aiafg/us-central1';

export async function getMetaConnection(tenantId: string): Promise<MetaConnection | null> {
  const snap = await getDoc(doc(firebaseDb(), 'tenants', tenantId, 'metaConnections', 'main'));
  return snap.exists() ? (snap.data() as MetaConnection) : null;
}

export async function listMetaAssets(tenantId: string): Promise<MetaAsset[]> {
  const snap = await getDocs(collection(firebaseDb(), 'tenants', tenantId, 'metaAssets'));
  return snap.docs.map((d) => d.data() as MetaAsset);
}

export async function connectMetaDemo(tenantId: string, byUid: string): Promise<void> {
  await fetch(`${API}/devMetaConnect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId, byUid }) });
}

export async function disconnectMeta(tenantId: string): Promise<void> {
  await fetch(`${API}/devMetaDisconnect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId }) });
}

/** Eventos enviados a la Conversions API de Meta (D6). */
export async function listConversionEvents(tenantId: string): Promise<MetaConversionEvent[]> {
  const snap = await getDocs(collection(firebaseDb(), 'tenants', tenantId, 'metaConversionEvents'));
  return snap.docs.map((d) => d.data() as MetaConversionEvent);
}

export async function processConversions(tenantId: string): Promise<void> {
  await fetch(`${API}/devProcessConversions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId }) });
}
