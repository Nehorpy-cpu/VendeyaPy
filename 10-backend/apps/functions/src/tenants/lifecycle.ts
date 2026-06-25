/**
 * tenants/lifecycle.ts — Estado de la empresa + gate de uso (Fase 4)
 * ==================================================================
 * Suspender/reactivar empresas (billing) y decidir si un mensaje entrante puede
 * procesarse: empresa ACTIVA y dentro del límite de mensajes del plan.
 */
import { Timestamp } from 'firebase-admin/firestore';
import type { TenantStatus } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { recordAudit } from '../audit/audit.js';
import { checkQuota, meterUsage } from '../entitlements/entitlements.js';

export async function setTenantStatus(tenantId: string, status: TenantStatus): Promise<void> {
  await db().doc(paths.tenant(tenantId)).set({ status, updatedAt: Timestamp.now() }, { merge: true });
  const action = status === 'SUSPENDED' ? 'tenant.suspended' : status === 'ACTIVE' ? 'tenant.reactivated' : null;
  if (action) await recordAudit({ tenantId, action, targetType: 'tenant', summary: `Empresa ${status}` });
  logger.info('Estado de empresa actualizado', { tenantId, status });
}

export const suspendTenant = (tenantId: string): Promise<void> => setTenantStatus(tenantId, 'SUSPENDED');
export const reactivateTenant = (tenantId: string): Promise<void> => setTenantStatus(tenantId, 'ACTIVE');

export interface TenantGate {
  allowed: boolean;
  reason?: 'suspended' | 'message_limit' | 'trial_expired';
}

/**
 * Decide si un inbound del bot puede procesarse: empresa no suspendida + bajo el límite de
 * mensajes del plan (vía entitlements, con lazy-reset del período). Empresa legacy sin doc
 * → no bloquear.
 */
export async function checkTenantInboundGate(tenantId: string): Promise<TenantGate> {
  const snap = await db().doc(paths.tenant(tenantId)).get();
  if (!snap.exists) return { allowed: true };
  const status = snap.data()?.status as TenantStatus | undefined;
  if (status === 'SUSPENDED' || status === 'DELETED') return { allowed: false, reason: 'suspended' };
  // TRIAL-ENFORCEMENT-1A: checkQuota ya bloquea por prueba vencida (reason 'trial_expired'). El bot no
  // responde; el motivo solo va al log (NUNCA se le revela al cliente final que el plan/trial venció).
  const q = await checkQuota(tenantId, 'messages');
  if (!q.allowed) return { allowed: false, reason: q.reason === 'suspended' ? 'suspended' : q.reason === 'trial_expired' ? 'trial_expired' : 'message_limit' };
  return { allowed: true };
}

/** Incrementa el contador de mensajes del mes (delega en meterUsage → lazy-reset). */
export async function incrementMessageUsage(tenantId: string, by = 1): Promise<void> {
  await meterUsage(tenantId, 'messages', by);
}
