/**
 * functions/config/configCallables.ts — Config sensible del tenant por callable (Fase 5C-A)
 * =========================================================================================
 * Reemplazan (con gate de backend) los writes directos del panel a:
 *   - config/checkout  → checkoutConfigUpdate  (bancos/vendedores; redirige cobros)
 *   - config/agent     → agentConfigUpdate      (comportamiento del bot)
 *   - config/channels  → channelConfigUpdate    (whatsappSendMode: activa WhatsApp REAL)
 *
 * Autorización ESTRICTA: solo TENANT_OWNER del tenant o PLATFORM_ADMIN. Nunca SELLER/MANAGER.
 * Validación estricta de payload (whitelist; nunca escribe fuera de su scope). Auditoría de cada
 * cambio (sin datos sensibles en el log). `whatsappSendMode='live'` solo si la conexión Meta del
 * tenant es resoluble (activa + número + token); si no, failed-precondition. El front NO decide live.
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import { resolveOwnerAdminAuth } from '../../lib/ownerAdminAuth.js';
import { db } from '../../lib/firebase.js';
import { recordAudit } from '../../audit/audit.js';
import { logger } from '../../lib/logger.js';
import { validateAgentConfigPatch, validateCheckoutConfig, validateChannelConfig } from '../../config/validate.js';
import { resolveTenantWhatsappCreds, type WhatsappCredsReason } from '../../messaging/resolveWhatsappCreds.js';

function authorize(req: CallableRequest<unknown>, requestedTenantId?: string): { tenantId: string; uid: string } {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const r = resolveOwnerAdminAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId, {
    deniedMessage: 'Solo el dueño de la empresa o un administrador pueden cambiar esta configuración.',
  });
  if (!r.ok) throw new HttpsError(r.code, r.message);
  return { tenantId: r.tenantId, uid: req.auth.uid };
}

const CREDS_REASON: Record<WhatsappCredsReason, string> = {
  no_tenant: 'empresa no resuelta',
  not_connected: 'la conexión de Meta no está activa',
  token_expired: 'el token de Meta venció',
  no_phone_asset: 'no hay un número de WhatsApp seleccionado',
  token_unavailable: 'el token de Meta no está disponible',
};

export const checkoutConfigUpdate = onCall<{ tenantId?: string; data?: unknown }>({ region: 'us-central1' }, async (req) => {
  const { tenantId, uid } = authorize(req, req.data?.tenantId);
  let cfg;
  try {
    cfg = validateCheckoutConfig(req.data?.data);
  } catch (e) {
    throw new HttpsError('invalid-argument', e instanceof Error ? e.message : 'Config de checkout inválida.');
  }
  await db().doc(`tenants/${tenantId}/config/checkout`).set({ ...cfg, updatedAt: Timestamp.now() }, { merge: true });
  await recordAudit({ tenantId, action: 'checkout.updated', actorUid: uid, targetType: 'config', summary: `Checkout actualizado (${cfg.bankAccounts.length} cuentas, ${cfg.sellers.length} vendedores)`, metadata: { banks: cfg.bankAccounts.length, sellers: cfg.sellers.length } });
  logger.info('config/checkout actualizado', { tenantId });
  return { ok: true };
});

export const agentConfigUpdate = onCall<{ tenantId?: string; data?: unknown }>({ region: 'us-central1' }, async (req) => {
  const { tenantId, uid } = authorize(req, req.data?.tenantId);
  let patch: Record<string, unknown>;
  try {
    patch = validateAgentConfigPatch(req.data?.data);
  } catch (e) {
    throw new HttpsError('invalid-argument', e instanceof Error ? e.message : 'Config de agente inválida.');
  }
  await db().doc(`tenants/${tenantId}/config/agent`).set({ ...patch, updatedAt: Timestamp.now() }, { merge: true });
  await recordAudit({ tenantId, action: 'agentConfig.updated', actorUid: uid, targetType: 'config', summary: `Config de agente actualizada: ${Object.keys(patch).join(', ')}`, metadata: { fields: Object.keys(patch) } });
  logger.info('config/agent actualizado', { tenantId });
  return { ok: true };
});

export const channelConfigUpdate = onCall<{ tenantId?: string; data?: unknown }>({ region: 'us-central1' }, async (req) => {
  const { tenantId, uid } = authorize(req, req.data?.tenantId);
  let cfg;
  try {
    cfg = validateChannelConfig(req.data?.data);
  } catch (e) {
    throw new HttpsError('invalid-argument', e instanceof Error ? e.message : 'Config de canales inválida.');
  }

  // 'live' solo si la conexión Meta del tenant es RESOLUBLE (activa + número + token). Nunca por el front.
  if (cfg.whatsappSendMode === 'live') {
    const creds = await resolveTenantWhatsappCreds(tenantId);
    if (!creds.ok) {
      throw new HttpsError('failed-precondition', `No podés activar WhatsApp en vivo: ${CREDS_REASON[creds.reason]}. Conectá y verificá el número primero.`);
    }
  }

  await db().doc(`tenants/${tenantId}/config/channels`).set({ whatsappSendMode: cfg.whatsappSendMode, updatedAt: Timestamp.now() }, { merge: true });
  await recordAudit({ tenantId, action: 'channelConfig.updated', actorUid: uid, targetType: 'config', summary: `whatsappSendMode → ${cfg.whatsappSendMode}`, metadata: { whatsappSendMode: cfg.whatsappSendMode } });
  logger.info('config/channels actualizado', { tenantId, whatsappSendMode: cfg.whatsappSendMode });
  return { ok: true, whatsappSendMode: cfg.whatsappSendMode };
});
