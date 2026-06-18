/**
 * users/manage.ts — Gestión de usuarios de una empresa (Fase 4)
 * =============================================================
 * Invitar (crear/vincular) un usuario con su rol, cambiar rol y activar/desactivar.
 * Todo vía Admin SDK: setea custom claims { tenantId, role } y el doc users/{uid}.
 * La autorización (owner/admin del tenant) la hace el callable que lo invoca.
 */
import { Timestamp } from 'firebase-admin/firestore';
import type { UserRole } from '@vpw/shared';
import { db, auth, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';

const TENANT_ROLES: UserRole[] = ['TENANT_OWNER', 'TENANT_MANAGER', 'TENANT_VIEWER', 'SELLER'];

async function assertSameTenant(tenantId: string, uid: string): Promise<void> {
  const doc = (await db().doc(paths.user(uid)).get()).data() as { tenantId?: string } | undefined;
  if (doc?.tenantId && doc.tenantId !== tenantId) throw new Error('El usuario no pertenece a esta empresa');
}

export async function inviteUser(
  tenantId: string,
  email: string,
  role: UserRole,
  name?: string,
): Promise<{ uid: string; created: boolean }> {
  if (!TENANT_ROLES.includes(role)) throw new Error('Rol inválido para una empresa');
  let uid: string;
  let created = false;
  try {
    uid = (await auth().getUserByEmail(email)).uid;
  } catch {
    uid = (await auth().createUser({ email, displayName: name })).uid;
    created = true;
  }
  await auth().setCustomUserClaims(uid, { tenantId, role });
  await db()
    .doc(paths.user(uid))
    .set({ id: uid, email, name: name ?? '', role, tenantId, status: 'ACTIVE', updatedAt: Timestamp.now() }, { merge: true });
  logger.info('Usuario invitado', { tenantId, uid, role });
  return { uid, created };
}

export async function setUserRole(tenantId: string, uid: string, role: UserRole): Promise<void> {
  if (!TENANT_ROLES.includes(role)) throw new Error('Rol inválido');
  await assertSameTenant(tenantId, uid);
  await auth().setCustomUserClaims(uid, { tenantId, role });
  await db().doc(paths.user(uid)).set({ role, updatedAt: Timestamp.now() }, { merge: true });
  logger.info('Rol de usuario actualizado', { tenantId, uid, role });
}

export async function setUserActive(tenantId: string, uid: string, active: boolean): Promise<void> {
  await assertSameTenant(tenantId, uid);
  await auth().updateUser(uid, { disabled: !active });
  await db().doc(paths.user(uid)).set({ status: active ? 'ACTIVE' : 'DISABLED', updatedAt: Timestamp.now() }, { merge: true });
  logger.info('Usuario activado/desactivado', { tenantId, uid, active });
}
