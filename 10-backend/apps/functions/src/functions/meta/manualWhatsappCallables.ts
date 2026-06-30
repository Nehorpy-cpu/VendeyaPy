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
 * NOTA WM-1: el callable owner `requestWhatsappActivation` (solicitud) queda para WM-2 — requiere una
 * subcolección nueva + su regla, que se agrega junto con la UI del owner. Ver docs/whatsapp-manual-onboarding.md.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { db, paths } from '../../lib/firebase.js';
import { META_APP_SECRET } from '../../meta/metaSecrets.js';
import { getMetaGraphClient } from '../../meta/graphClient.js';
import { assertWhatsappNumbersEntitled } from '../../entitlements/entitlements.js';
import { parseManualWhatsappInput, runManualWhatsappConnect } from '../../meta/manualConnect.js';
import { recordAudit } from '../../audit/audit.js';
import { logger } from '../../lib/logger.js';

interface ManualConnInput {
  tenantId?: string;
  wabaId?: string;
  phoneNumberId?: string;
  displayPhoneNumber?: string;
  businessId?: string;
  businessName?: string;
  accessToken?: string;
  tokenExpiresAt?: number;
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

    return { ok: true, status: result.status, ready: result.ready, phoneNumberId: result.phoneNumberId, phoneNumber: result.phoneNumber };
  },
);
