/**
 * tenants/lifecycle.ts — Estado de la empresa + gate de uso (Fase 4)
 * ==================================================================
 * Suspender/reactivar empresas (billing) y decidir si un mensaje entrante puede
 * procesarse: empresa ACTIVA y dentro del límite de mensajes del plan.
 */
import { Timestamp, FieldValue } from 'firebase-admin/firestore';
import type { TenantStatus } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';

export async function setTenantStatus(tenantId: string, status: TenantStatus): Promise<void> {
  await db().doc(paths.tenant(tenantId)).set({ status, updatedAt: Timestamp.now() }, { merge: true });
  logger.info('Estado de empresa actualizado', { tenantId, status });
}

export const suspendTenant = (tenantId: string): Promise<void> => setTenantStatus(tenantId, 'SUSPENDED');
export const reactivateTenant = (tenantId: string): Promise<void> => setTenantStatus(tenantId, 'ACTIVE');

export interface TenantGate {
  allowed: boolean;
  reason?: 'suspended' | 'message_limit';
}

/** Decide si un inbound del bot puede procesarse (empresa activa + bajo el límite). */
export async function checkTenantInboundGate(tenantId: string): Promise<TenantGate> {
  const snap = await db().doc(paths.tenant(tenantId)).get();
  const data = snap.data() as
    | { status?: TenantStatus; limits?: { maxWhatsappMessagesPerMonth?: number }; usage?: { messagesThisMonth?: number } }
    | undefined;
  if (!data) return { allowed: true }; // empresa legacy sin doc completo → no bloquear
  if (data.status === 'SUSPENDED' || data.status === 'DELETED') return { allowed: false, reason: 'suspended' };
  const max = data.limits?.maxWhatsappMessagesPerMonth;
  const used = data.usage?.messagesThisMonth ?? 0;
  if (typeof max === 'number' && max > 0 && used >= max) return { allowed: false, reason: 'message_limit' };
  return { allowed: true };
}

/** Incrementa el contador de mensajes del mes (métrica de uso del plan). */
export async function incrementMessageUsage(tenantId: string, by = 1): Promise<void> {
  await db()
    .doc(paths.tenant(tenantId))
    .set({ usage: { messagesThisMonth: FieldValue.increment(by) }, updatedAt: Timestamp.now() }, { merge: true });
}
