/**
 * meta/manualConnect.ts — Alta MANUAL de la conexión WhatsApp por un PLATFORM_ADMIN (WM-1).
 * ============================================================================================
 * Reusa el MISMO modelo que el Embedded Signup (metaConnections/main + metaAssets + metaExternalIndex
 * + token cifrado en SecretStore), pero los datos técnicos los carga un admin en vez de venir del OAuth.
 *
 * Garantías:
 *  - El token NUNCA va a Firestore en claro ni a logs/audit: se cifra en el SecretStore y en el doc
 *    solo queda `tokenSecretRef`.
 *  - El estado NO se marca 'active' a ciegas: se escribe 'pending_review' y el estado FINAL lo decide
 *    `verifyWhatsappChannel` (Graph real: debug_token + getPhoneNumber). En emulador usa el fixture.
 *  - Antes de escribir el índice se valida COLISIÓN: un phone_number_id de otro tenant secuestraría sus
 *    webhooks → se rechaza.
 *  - No toca el flujo Embedded Signup: solo reusa helpers compartidos (writeActiveConnection,
 *    writeDiscoveredAssets, verifyWhatsappChannel).
 */
import type { MetaExternalIndexEntry } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { getSecretStore } from '../lib/secretStore.js';
import { metaTokenSecretName } from './secretName.js';
import { logger } from '../lib/logger.js';
import { writeActiveConnection } from './connectFlow.js';
import { buildMetaAssets, writeDiscoveredAssets, type DiscoveredAsset } from './discovery.js';
import { verifyWhatsappChannel } from './preflight.js';
import type { MetaGraphClient, MetaPhoneNumber } from './graphClient.js';

// ---------------- Validación PURA (testeable, sin E/S) ----------------

export interface ManualWhatsappInput {
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  businessId?: string;
  businessName?: string;
  accessToken: string;
  tokenExpiresAtMs: number | null;
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/; // ids de Meta: alfanuméricos seguros (sin '/')
const PHONE_NUMBER_ID = /^[0-9]{5,20}$/; // phone_number_id de Meta = id numérico interno (NO el +595…)

export type ParseResult = { ok: true; value: ManualWhatsappInput } | { ok: false; message: string };

/**
 * Valida y normaliza el input del admin. Solo toma los campos conocidos (ignora extras peligrosos).
 * NUNCA incluye el accessToken en los mensajes de error.
 */
export function parseManualWhatsappInput(data: unknown): ParseResult {
  const d = (data ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

  const wabaId = str(d.wabaId);
  const phoneNumberId = str(d.phoneNumberId);
  const displayPhoneNumber = str(d.displayPhoneNumber);
  const businessId = str(d.businessId) || undefined;
  const businessName = str(d.businessName) || undefined;
  const accessTokenRaw = typeof d.accessToken === 'string' ? d.accessToken.trim() : '';

  if (!wabaId) return { ok: false, message: 'Falta wabaId.' };
  if (!SAFE_ID.test(wabaId)) return { ok: false, message: 'wabaId inválido.' };
  if (!phoneNumberId) return { ok: false, message: 'Falta phoneNumberId.' };
  if (!PHONE_NUMBER_ID.test(phoneNumberId)) {
    return { ok: false, message: 'phoneNumberId inválido: debe ser el id numérico de Meta (no el número con +).' };
  }
  if (businessId && !SAFE_ID.test(businessId)) return { ok: false, message: 'businessId inválido.' };
  if (!displayPhoneNumber) return { ok: false, message: 'Falta displayPhoneNumber.' };
  if (!accessTokenRaw) return { ok: false, message: 'Falta accessToken.' };

  let tokenExpiresAtMs: number | null = null;
  if (d.tokenExpiresAt != null) {
    const n = typeof d.tokenExpiresAt === 'number' ? d.tokenExpiresAt : NaN;
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, message: 'tokenExpiresAt inválido: epoch en ms (>0) o ausente para token sin expiración.' };
    }
    tokenExpiresAtMs = n;
  }

  return {
    ok: true,
    value: { wabaId, phoneNumberId, displayPhoneNumber, businessId, businessName, accessToken: accessTokenRaw, tokenExpiresAtMs },
  };
}

/** Clave del índice global para un phone_number_id de WhatsApp (igual que discovery/connect). */
export function whatsappIndexId(phoneNumberId: string): string {
  return `whatsapp_${phoneNumberId}`;
}

// ---------------- Orquestación (E/S; deps inyectables para tests) ----------------

export interface ManualConnectDeps {
  /** Devuelve el tenantId dueño actual del índice de ese phone_number_id, o null si no existe. */
  collisionTenant: (phoneNumberId: string) => Promise<string | null>;
  /** Guarda el token cifrado y devuelve la referencia opaca (tokenSecretRef). */
  storeToken: (tenantId: string, token: string) => Promise<string>;
  writeConnection: typeof writeActiveConnection;
  writeAssets: (tenantId: string, assets: DiscoveredAsset[]) => Promise<void>;
  verify: (tenantId: string, graph: MetaGraphClient) => Promise<{ ready: boolean; reason: string; status: string; phoneNumber?: string }>;
}

const defaultDeps: ManualConnectDeps = {
  collisionTenant: async (phoneNumberId) => {
    const snap = await db().doc(paths.metaExternalIndexEntry(whatsappIndexId(phoneNumberId))).get();
    return snap.exists ? ((snap.data() as MetaExternalIndexEntry).tenantId ?? null) : null;
  },
  storeToken: (tenantId, token) => getSecretStore().set(metaTokenSecretName(tenantId), token),
  writeConnection: writeActiveConnection,
  writeAssets: (tenantId, assets) => writeDiscoveredAssets(tenantId, 'main', assets),
  verify: verifyWhatsappChannel,
};

export type ManualConnectResult =
  | { ok: true; status: string; ready: boolean; phoneNumberId: string; phoneNumber: string | null }
  | { ok: false; reason: 'phone_number_collision'; conflictTenantId: string };

/**
 * Alta manual: chequea colisión → guarda token cifrado → escribe conexión (pending) + assets + índice
 * → suscribe la app → verifica (estado final). NUNCA escribe ni loguea el token.
 */
export async function runManualWhatsappConnect(
  tenantId: string,
  input: ManualWhatsappInput,
  adminUid: string,
  graph: MetaGraphClient,
  deps: ManualConnectDeps = defaultDeps,
): Promise<ManualConnectResult> {
  // 1) Colisión: el phone_number_id no puede pertenecer a OTRO tenant (secuestraría sus webhooks).
  const owner = await deps.collisionTenant(input.phoneNumberId);
  if (owner && owner !== tenantId) {
    return { ok: false, reason: 'phone_number_collision', conflictTenantId: owner };
  }

  // 2) Token cifrado POR REFERENCIA (SecretStore). NUNCA en el doc.
  const tokenSecretRef = await deps.storeToken(tenantId, input.accessToken);

  // 3) Conexión: estado inicial 'pending_review' (NO 'active' a ciegas), source 'manual_admin'.
  await deps.writeConnection(tenantId, {
    byUid: adminUid,
    tokenSecretRef,
    tokenExpiresAtMs: input.tokenExpiresAtMs,
    scopes: [],
    businessId: input.businessId,
    businessName: input.businessName,
    status: 'pending_review',
    tokenType: 'live',
    source: 'manual_admin',
  });

  // 4) Assets + índice global (resuelve inbound por phone_number_id). Un número, selected.
  const phone: MetaPhoneNumber = {
    id: input.phoneNumberId,
    displayPhoneNumber: input.displayPhoneNumber,
    verifiedName: input.businessName ?? '',
    qualityRating: '',
    codeVerificationStatus: '',
  };
  const assets = buildMetaAssets({
    businessId: input.businessId,
    businessName: input.businessName,
    wabaId: input.wabaId,
    wabaName: input.businessName,
    phones: [phone],
    selectedPhoneNumberId: input.phoneNumberId,
  });
  await deps.writeAssets(tenantId, assets);

  // 5) Suscribir la app a la WABA (best-effort; el inbound real lo requiere en Meta).
  try {
    await graph.subscribeApp(input.wabaId, input.accessToken);
  } catch {
    logger.warn('manualConnect: subscribeApp falló (se continúa; suscribir en Meta manualmente)', { tenantId });
  }

  // 6) Verificar: el estado FINAL lo decide el verificador (active SOLO si el token valida en Graph).
  let status = 'pending_review';
  let ready = false;
  let phoneNumber: string | null = input.displayPhoneNumber;
  try {
    const v = await deps.verify(tenantId, graph);
    status = v.status;
    ready = v.ready;
    if (v.phoneNumber) phoneNumber = v.phoneNumber;
  } catch {
    logger.warn('manualConnect: verify falló (queda pending_review)', { tenantId });
  }

  logger.info('Conexión WhatsApp manual cargada', { tenantId, status, ready, source: 'manual_admin' });
  return { ok: true, status, ready, phoneNumberId: input.phoneNumberId, phoneNumber };
}
