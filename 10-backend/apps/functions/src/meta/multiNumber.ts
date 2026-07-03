/**
 * meta/multiNumber.ts — Múltiples números de WhatsApp por empresa (MULTI-NUMBER-1)
 * =================================================================================
 * Modelo: una CONEXIÓN por número. El principal conserva `metaConnections/main` +
 * asset `selected: true` (compat total con el flujo actual). Los adicionales viven en
 * `metaConnections/wa_{phoneNumberId}` con su PROPIO token cifrado
 * (`meta-token-{tenant}-{pnid}`), su asset (`selected: false`) y su entrada de índice
 * `metaExternalIndex/whatsapp_{pnid}` con `connectionId` → el inbound resuelve tenant
 * Y número receptor, y la respuesta sale por el MISMO número (whatsappClient).
 *
 * Reglas:
 *  - Agregar: gate del plan (maxWhatsappNumbers, contando activos), colisión cross-tenant,
 *    re-alta idempotente del mismo número en el mismo tenant. NUNCA pisa al principal.
 *  - Desactivar: SOLO números adicionales (el principal se gestiona con reemplazo WM-1 /
 *    metaDisconnect). Borra el índice (deja de rutear), marca asset/conexión inactivos y
 *    elimina el secreto del token. El HISTORIAL (conversaciones/mensajes) queda intacto.
 *  - El token jamás se escribe en Firestore ni en logs: solo tokenSecretRef.
 */
import { Timestamp } from 'firebase-admin/firestore';
import type { MetaAsset, MetaConnection } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { getSecretStore } from '../lib/secretStore.js';
import { metaNumberTokenSecretName } from './secretName.js';
import { logger } from '../lib/logger.js';
import type { MetaGraphClient } from './graphClient.js';
import type { ManualWhatsappInput } from './manualConnect.js';
import { whatsappIndexId } from './manualConnect.js';

/** Id determinístico de la conexión de un número ADICIONAL. */
export function waConnectionId(phoneNumberId: string): string {
  return `wa_${phoneNumberId}`;
}

export interface AddNumberDeps {
  collisionTenant: (phoneNumberId: string) => Promise<string | null>;
  getAsset: (tenantId: string, phoneNumberId: string) => Promise<MetaAsset | null>;
  countActiveNumbers: (tenantId: string) => Promise<number>;
  assertQuota: (tenantId: string, needed: number, actorUid: string | null) => Promise<void>;
  storeToken: (name: string, token: string) => Promise<string>;
}

export const defaultAddDeps: Omit<AddNumberDeps, 'assertQuota'> = {
  collisionTenant: async (phoneNumberId) => {
    const snap = await db().doc(paths.metaExternalIndexEntry(whatsappIndexId(phoneNumberId))).get();
    return snap.exists ? ((snap.data() as { tenantId?: string }).tenantId ?? null) : null;
  },
  getAsset: async (tenantId, phoneNumberId) =>
    ((await db().doc(paths.metaAsset(tenantId, phoneNumberId)).get()).data() as MetaAsset | undefined) ?? null,
  countActiveNumbers: async (tenantId) => {
    const snap = await db().collection(paths.metaAssets(tenantId)).where('assetType', '==', 'whatsapp_phone_number').get();
    return snap.docs.filter((d) => (d.data() as MetaAsset).status === 'active').length;
  },
  storeToken: (name, token) => getSecretStore().set(name, token),
};

export type AddNumberResult =
  | { ok: true; status: string; phoneNumberId: string; phoneNumber: string | null; connectionId: string }
  | { ok: false; reason: 'phone_number_collision'; conflictTenantId: string }
  | { ok: false; reason: 'already_active' };

/**
 * Agrega un número ADICIONAL: gate de plan → colisión → token cifrado propio → conexión
 * wa_{pnid} + asset (selected:false) + índice → subscribeApp (best-effort) → verificación
 * real (debug_token + getPhoneNumber) que decide el estado final.
 */
export async function runAddWhatsappNumber(
  tenantId: string,
  input: ManualWhatsappInput,
  adminUid: string,
  graph: MetaGraphClient,
  deps: AddNumberDeps,
): Promise<AddNumberResult> {
  const pnid = input.phoneNumberId;

  // 1) Colisión: otro tenant ya rutea este número → jamás secuestrar webhooks.
  const owner = await deps.collisionTenant(pnid);
  if (owner && owner !== tenantId) return { ok: false, reason: 'phone_number_collision', conflictTenantId: owner };

  // 2) Mismo tenant: activo → error claro; inactivo/inexistente → alta (re-alta reactiva limpio).
  const existing = await deps.getAsset(tenantId, pnid);
  if (existing && existing.status === 'active') return { ok: false, reason: 'already_active' };

  // 3) Gate del plan: activos actuales + este.
  const actives = await deps.countActiveNumbers(tenantId);
  await deps.assertQuota(tenantId, actives + 1, adminUid);

  // 4) Token cifrado POR NÚMERO. Nunca en Firestore/logs.
  const tokenSecretRef = await deps.storeToken(metaNumberTokenSecretName(tenantId, pnid), input.accessToken);

  // 5) Conexión + asset + índice (batch atómico).
  const connectionId = waConnectionId(pnid);
  const now = Timestamp.now();
  const batch = db().batch();
  batch.set(db().doc(paths.metaConnection(tenantId, connectionId)), {
    id: connectionId,
    tenantId,
    metaBusinessId: input.businessId ?? '',
    metaBusinessName: input.businessName ?? '',
    connectedUserId: adminUid,
    tokenSecretRef,
    tokenType: 'live',
    tokenExpiresAt: input.tokenExpiresAtMs ? Timestamp.fromMillis(input.tokenExpiresAtMs) : null,
    scopes: [],
    status: 'pending_review', // el estado FINAL lo decide la verificación de abajo
    source: 'manual_admin',
    // metadata segura del número (MULTI-NUMBER-1); sin tokens.
    wabaId: input.wabaId,
    displayPhoneNumber: input.displayPhoneNumber,
    lastVerifiedAt: now,
    errorMessage: '',
    createdAt: (existing ? undefined : now) ?? now,
    updatedAt: now,
  } as Partial<MetaConnection> & Record<string, unknown>);
  batch.set(db().doc(paths.metaAsset(tenantId, pnid)), {
    id: pnid, tenantId, connectionId, assetType: 'whatsapp_phone_number', externalId: pnid,
    name: input.displayPhoneNumber, status: 'active', selected: false, createdAt: now, updatedAt: now,
  });
  batch.set(db().doc(paths.metaExternalIndexEntry(whatsappIndexId(pnid))), {
    id: whatsappIndexId(pnid), tenantId, connectionId, assetType: 'whatsapp_phone_number',
    platform: 'whatsapp', externalId: pnid, status: 'active', updatedAt: now,
  });
  await batch.commit();

  // 6) Suscribir la app a la WABA (best-effort; el inbound real lo requiere en Meta).
  try {
    await graph.subscribeApp(input.wabaId, input.accessToken);
  } catch {
    logger.warn('multiNumber: subscribeApp falló (continuar; suscribir en Meta manualmente)', { tenantId, connectionId });
  }

  // 7) Verificación real por NÚMERO: token válido + el pnid resuelve.
  let status = 'pending_review';
  let phoneNumber: string | null = input.displayPhoneNumber;
  try {
    const dbg = await graph.debugToken(input.accessToken);
    const phone = dbg.isValid ? await graph.getPhoneNumber(pnid, input.accessToken) : null;
    status = dbg.isValid && phone ? 'active' : 'error';
    if (phone?.displayPhoneNumber) phoneNumber = phone.displayPhoneNumber;
  } catch {
    logger.warn('multiNumber: verificación falló (queda pending_review)', { tenantId, connectionId });
  }
  await db().doc(paths.metaConnection(tenantId, connectionId)).set({ status, lastVerifiedAt: Timestamp.now(), updatedAt: Timestamp.now() }, { merge: true });

  logger.info('Número adicional de WhatsApp agregado', { tenantId, connectionId, status });
  return { ok: true, status, phoneNumberId: pnid, phoneNumber, connectionId };
}

export type DeactivateResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'is_default' | 'is_main' };

/**
 * Desactiva un número ADICIONAL: fuera del índice (deja de rutear), asset/conexión inactivos,
 * secreto del token eliminado. Historial de conversaciones/mensajes: INTACTO.
 */
export async function deactivateWhatsappNumber(tenantId: string, phoneNumberId: string): Promise<DeactivateResult> {
  const assetRef = db().doc(paths.metaAsset(tenantId, phoneNumberId));
  const asset = (await assetRef.get()).data() as MetaAsset | undefined;
  if (!asset || asset.assetType !== 'whatsapp_phone_number') return { ok: false, reason: 'not_found' };
  if (asset.selected) return { ok: false, reason: 'is_default' };
  const connectionId = (asset as MetaAsset & { connectionId?: string }).connectionId ?? 'main';
  if (connectionId === 'main') return { ok: false, reason: 'is_main' };

  const connRef = db().doc(paths.metaConnection(tenantId, connectionId));
  const conn = (await connRef.get()).data() as MetaConnection | undefined;

  const now = Timestamp.now();
  const batch = db().batch();
  batch.set(assetRef, { status: 'inactive', selected: false, updatedAt: now }, { merge: true });
  batch.delete(db().doc(paths.metaExternalIndexEntry(whatsappIndexId(phoneNumberId))));
  batch.set(connRef, { status: 'disconnected', updatedAt: now }, { merge: true });
  await batch.commit();

  // Higiene: el token deja de existir (revocarlo en Meta sigue siendo recomendable).
  if (conn?.tokenSecretRef) {
    try {
      await getSecretStore().remove(conn.tokenSecretRef);
    } catch {
      logger.warn('multiNumber: no se pudo borrar el secreto del token (conexión igual desactivada)', { tenantId, connectionId });
    }
  }
  logger.info('Número adicional de WhatsApp desactivado', { tenantId, connectionId, phoneNumberId });
  return { ok: true };
}
