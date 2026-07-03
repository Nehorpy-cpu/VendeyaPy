/**
 * functions/meta/manualWhatsappCallables.ts — Alta MANUAL de WhatsApp (WM-1).
 * ===========================================================================
 * adminSetManualWhatsappConnection: SOLO PLATFORM_ADMIN (check literal). Un admin de la plataforma
 * carga manualmente la conexión WhatsApp de un tenant (cuando Embedded Signup está bloqueado/demorado),
 * reusando el MISMO modelo (metaConnections/main + metaAssets + metaExternalIndex + token cifrado).
 *
 * Seguridad: el accessToken va cifrado al SecretStore (nunca a Firestore legible, logs ni audit).
 * No toca connectMeta / verifyMetaChannel / selectMetaPhoneNumber / metaDisconnect / channelConfigUpdate.
 *
 * WM-2: acepta un `requestId` OPCIONAL. Si viene de una solicitud del owner (whatsappActivationRequests),
 * al cargar la conexión se marca esa solicitud como 'completed' (best-effort, no rompe la conexión).
 * La solicitud/cancelación del owner viven en functions/meta/whatsappActivationCallables.ts.
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { db, paths } from '../../lib/firebase.js';
import { META_APP_SECRET } from '../../meta/metaSecrets.js';
import { getMetaGraphClient } from '../../meta/graphClient.js';
import { assertWhatsappNumbersEntitled } from '../../entitlements/entitlements.js';
import { parseManualWhatsappInput, runManualWhatsappConnect } from '../../meta/manualConnect.js';
import { runAddWhatsappNumber, deactivateWhatsappNumber, defaultAddDeps } from '../../meta/multiNumber.js';
import { markActivationRequestCompleted } from '../../meta/activationRequests.js';
import { recordAudit } from '../../audit/audit.js';
import { logger } from '../../lib/logger.js';

/** SOLO PLATFORM_ADMIN (check literal — mismo patrón que adminSetManualWhatsappConnection). */
function requirePlatformAdmin(req: CallableRequest<unknown>): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const role = (req.auth.token as { role?: string }).role;
  if (role !== 'PLATFORM_ADMIN') {
    throw new HttpsError('permission-denied', 'Solo el administrador de la plataforma puede gestionar números de WhatsApp.');
  }
  return req.auth.uid;
}

interface ManualConnInput {
  tenantId?: string;
  wabaId?: string;
  phoneNumberId?: string;
  displayPhoneNumber?: string;
  businessId?: string;
  businessName?: string;
  accessToken?: string;
  tokenExpiresAt?: number;
  /** WM-2 (opcional): si viene de una solicitud del owner, se marca 'completed' al cargar. */
  requestId?: string;
}

// debug_token (preflight) usa el app access token → necesita META_APP_SECRET, igual que connectMeta.
export const adminSetManualWhatsappConnection = onCall<ManualConnInput>(
  { region: 'us-central1', secrets: [META_APP_SECRET] },
  async (req) => {
    // 1) Auth: SOLO PLATFORM_ADMIN (literal). owner/manager/seller/viewer → permission-denied.
    if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
    const role = (req.auth.token as { role?: string }).role;
    if (role !== 'PLATFORM_ADMIN') {
      throw new HttpsError('permission-denied', 'Solo el administrador de la plataforma puede cargar una conexión de WhatsApp manualmente.');
    }
    const adminUid = req.auth.uid;

    // 2) tenantId requerido + debe existir (no crear conexiones fantasma).
    const tenantId = typeof req.data?.tenantId === 'string' ? req.data.tenantId.trim() : '';
    if (!tenantId) throw new HttpsError('invalid-argument', 'Falta tenantId.');
    if (!(await db().doc(paths.tenant(tenantId)).get()).exists) {
      throw new HttpsError('failed-precondition', 'La empresa no existe.');
    }

    // 3) Validación estricta del resto del input (sin loguear el token).
    const parsed = parseManualWhatsappInput(req.data);
    if (!parsed.ok) throw new HttpsError('invalid-argument', parsed.message);

    // 4) Plan gate: el plan debe incluir números de WhatsApp y no estar suspendido (igual que connectMeta).
    await assertWhatsappNumbersEntitled(tenantId, { actorUid: adminUid });

    // 5) Orquestación (colisión + token cifrado + conexión/assets/índice + verify).
    const graph = await getMetaGraphClient();
    const result = await runManualWhatsappConnect(tenantId, parsed.value, adminUid, graph);
    if (!result.ok) {
      throw new HttpsError('failed-precondition', `El phone_number_id ya está asignado a otra empresa (${result.conflictTenantId}).`);
    }

    // 6) Audit SIN token: solo metadata técnica.
    await recordAudit({
      tenantId,
      action: 'meta.connected_manual',
      actorUid: adminUid,
      actorRole: 'PLATFORM_ADMIN',
      targetType: 'meta',
      summary: 'Conexión WhatsApp cargada manualmente (admin)',
      metadata: { source: 'manual_admin', phoneNumberId: parsed.value.phoneNumberId, wabaId: parsed.value.wabaId, status: result.status, ready: result.ready },
    });
    logger.info('adminSetManualWhatsappConnection ok', { tenantId, status: result.status, ready: result.ready });

    // 7) WM-2: si el alta responde a una solicitud del owner, marcarla 'completed' (best-effort:
    //    un requestId inválido/ausente NO rompe la conexión ya escrita). Solo datos NO sensibles.
    const requestId = typeof req.data?.requestId === 'string' ? req.data.requestId.trim() : '';
    if (requestId) {
      await markActivationRequestCompleted(tenantId, requestId, {
        connectionStatus: result.status, phoneNumberId: result.phoneNumberId, adminUid,
      });
    }

    return { ok: true, status: result.status, ready: result.ready, phoneNumberId: result.phoneNumberId, phoneNumber: result.phoneNumber };
  },
);

// ---------------- MULTI-NUMBER-1: números ADICIONALES por empresa ----------------

/**
 * adminAddWhatsappNumber — agrega un número ADICIONAL (no toca el principal `main`).
 * SOLO PLATFORM_ADMIN. Gate del plan (maxWhatsappNumbers contando activos), colisión
 * cross-tenant, token cifrado POR número, índice con connectionId propio.
 */
export const adminAddWhatsappNumber = onCall<ManualConnInput>(
  { region: 'us-central1', secrets: [META_APP_SECRET] },
  async (req) => {
    const adminUid = requirePlatformAdmin(req);
    const tenantId = typeof req.data?.tenantId === 'string' ? req.data.tenantId.trim() : '';
    if (!tenantId) throw new HttpsError('invalid-argument', 'Falta tenantId.');
    if (!(await db().doc(paths.tenant(tenantId)).get()).exists) {
      throw new HttpsError('failed-precondition', 'La empresa no existe.');
    }
    const parsed = parseManualWhatsappInput(req.data);
    if (!parsed.ok) throw new HttpsError('invalid-argument', parsed.message);

    const graph = await getMetaGraphClient();
    const result = await runAddWhatsappNumber(tenantId, parsed.value, adminUid, graph, {
      ...defaultAddDeps,
      assertQuota: (t, needed, actorUid) => assertWhatsappNumbersEntitled(t, { actorUid, needed }),
    });
    if (!result.ok) {
      if (result.reason === 'phone_number_collision') {
        throw new HttpsError('failed-precondition', `El phone_number_id ya está asignado a otra empresa (${result.conflictTenantId}).`);
      }
      throw new HttpsError('failed-precondition', 'Ese número ya está activo en esta empresa.');
    }

    await recordAudit({
      tenantId, action: 'meta.number_added', actorUid: adminUid, actorRole: 'PLATFORM_ADMIN', targetType: 'meta',
      targetId: result.phoneNumberId, summary: 'Número adicional de WhatsApp agregado (admin)',
      metadata: { phoneNumberId: result.phoneNumberId, wabaId: parsed.value.wabaId, status: result.status, connectionId: result.connectionId },
    });
    logger.info('adminAddWhatsappNumber ok', { tenantId, status: result.status, connectionId: result.connectionId });
    return { ok: true, status: result.status, phoneNumberId: result.phoneNumberId, phoneNumber: result.phoneNumber };
  },
);

/**
 * adminDeactivateWhatsappNumber — desactiva un número ADICIONAL: fuera del índice (deja de
 * rutear inbound), asset/conexión inactivos, token eliminado. HISTORIAL intacto.
 * El número principal no se toca por acá (reemplazo WM-1 / metaDisconnect).
 */
export const adminDeactivateWhatsappNumber = onCall<{ tenantId?: string; phoneNumberId?: string }>(
  { region: 'us-central1' },
  async (req) => {
    const adminUid = requirePlatformAdmin(req);
    const tenantId = typeof req.data?.tenantId === 'string' ? req.data.tenantId.trim() : '';
    const phoneNumberId = typeof req.data?.phoneNumberId === 'string' ? req.data.phoneNumberId.trim() : '';
    if (!tenantId || !phoneNumberId) throw new HttpsError('invalid-argument', 'Falta tenantId o phoneNumberId.');

    const result = await deactivateWhatsappNumber(tenantId, phoneNumberId);
    if (!result.ok) {
      if (result.reason === 'not_found') throw new HttpsError('not-found', 'Ese número no existe en la empresa.');
      throw new HttpsError('failed-precondition', 'El número principal no se desactiva por acá: usá reemplazo o desconexión de la conexión principal.');
    }

    await recordAudit({
      tenantId, action: 'meta.number_deactivated', actorUid: adminUid, actorRole: 'PLATFORM_ADMIN', targetType: 'meta',
      targetId: phoneNumberId, summary: 'Número adicional de WhatsApp desactivado (admin; historial intacto)',
      metadata: { phoneNumberId },
    });
    logger.info('adminDeactivateWhatsappNumber ok', { tenantId, phoneNumberId });
    return { ok: true };
  },
);
