/**
 * conversation/lifecycle.ts — Ciclo de vida de la conversación + asignación manual (ADR-0021 §3/§7)
 * ==================================================================================================
 * Archivar/desarchivar, eliminación LÓGICA reversible y asignación de vendedor sobre el resumen
 * denormalizado `customers/{c}.conversation`. Reglas que este módulo sostiene:
 *
 *  1. MATRIZ DE PERMISOS (§7, normativa): archivar/desarchivar = cualquier staff; softDelete/
 *     restore y asignar = solo TENANT_MANAGER/TENANT_OWNER/PLATFORM_ADMIN. El corte de VIEWER y
 *     de cross-tenant lo hace `assertStaffAccess` ANTES de llegar acá; este módulo re-verifica el
 *     ROL porque staffAuth solo garantiza "es staff del tenant", no "puede esta acción".
 *  2. JAMÁS un delete físico: ni mensajes, ni adjuntos, ni audits, ni el doc del cliente. Los dos
 *     flags son reversibles y ORTOGONALES (softDelete no toca `archived` ni viceversa).
 *  3. TRANSACCIONAL E IDEMPOTENTE: se relee el doc dentro de la tx y repetir la acción vigente es
 *     un no-op honesto (`changed:false`) — sin escritura y sin re-auditar (el wrapper audita solo
 *     acciones efectivas; re-firmar `archivedBy` en cada click repetido ensuciaría la bitácora).
 *  4. ASIGNAR ≠ TOMAR: la asignación jamás toca `humanTakeover` (eso es del handoff).
 *  5. FAIL-CLOSED en assign: el destino tiene que ser un usuario staff ACTIVO del MISMO tenant
 *     (doc `users/{uid}`); cualquier otra cosa ⇒ `seller_not_found` sin escritura.
 *
 * `db` viaja como parámetro (patrón de deliveryStatus.ts) para testear sin emulador.
 */
import { HttpsError } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { maskPhone } from '@vpw/shared';

export interface ConversationActor {
  uid: string;
  role: string;
  name?: string;
}

export type ConversationLifecycleAction = 'archive' | 'unarchive' | 'softDelete' | 'restore';

export interface LifecycleResult {
  ok: true;
  /** false = la acción ya estaba vigente (no-op idempotente, sin escritura ni audit). */
  changed: boolean;
}

/** Roles que pueden softDelete/restore/asignar/vincular (matriz §7). */
export const PRIVILEGED_CONVERSATION_ROLES: ReadonlySet<string> = new Set([
  'TENANT_MANAGER',
  'TENANT_OWNER',
  'PLATFORM_ADMIN',
]);

/** Acciones de ciclo de vida reservadas a manager+ (archivar es de cualquier staff). */
const ACCIONES_PRIVILEGIADAS: ReadonlySet<ConversationLifecycleAction> = new Set(['softDelete', 'restore']);

export function assertRolPrivilegiado(actor: ConversationActor, queCosa: string): void {
  if (!PRIVILEGED_CONVERSATION_ROLES.has(actor.role)) {
    throw new HttpsError('permission-denied', `Tu rol no puede ${queCosa}.`);
  }
}

interface ConvFlags {
  archived?: unknown;
  softDeleted?: unknown;
}

/**
 * Aplica una acción de ciclo de vida sobre la conversación. Transaccional: relee el doc y decide
 * contra el estado REAL (dos clicks simultáneos no duplican el efecto ni el audit).
 */
export async function applyConversationLifecycle(
  dbi: Firestore,
  tenantId: string,
  customerId: string,
  action: ConversationLifecycleAction,
  actor: ConversationActor,
): Promise<LifecycleResult> {
  if (ACCIONES_PRIVILEGIADAS.has(action)) {
    assertRolPrivilegiado(actor, action === 'softDelete' ? 'eliminar conversaciones' : 'restaurar conversaciones');
  }

  const ref = dbi.doc(paths.customer(tenantId, customerId));
  const now = Timestamp.now();

  const changed = await dbi.runTransaction<boolean>(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Esa conversación no existe.');
    const conv = ((snap.data() as { conversation?: ConvFlags } | undefined)?.conversation ?? {}) as ConvFlags;

    // No-ops idempotentes: la acción ya está vigente ⇒ ok sin escritura (y sin re-firmar actor).
    if (action === 'archive' && conv.archived === true) return false;
    if (action === 'unarchive' && conv.archived !== true) return false;
    if (action === 'softDelete' && conv.softDeleted === true) return false;
    if (action === 'restore' && conv.softDeleted !== true) return false;

    // Cada acción escribe SOLO su terna de campos: los flags son ortogonales por contrato (§3).
    const patch: Record<string, unknown> =
      action === 'archive'
        ? { archived: true, archivedAt: now, archivedBy: actor.uid }
        : action === 'unarchive'
          ? { archived: false, archivedAt: null, archivedBy: null }
          : action === 'softDelete'
            ? { softDeleted: true, softDeletedAt: now, softDeletedBy: actor.uid }
            : { softDeleted: false, softDeletedAt: null, softDeletedBy: null };

    tx.set(ref, { id: customerId, tenantId, updatedAt: now, conversation: patch }, { merge: true });
    return true;
  });

  if (changed) {
    logger.info('Ciclo de vida de conversación aplicado', {
      tenantId,
      customerId: maskPhone(customerId),
      action,
    });
  }
  return { ok: true, changed };
}

/**
 * Marca la conversación como leída (resetea `unreadForSeller`) SOLO si el cliente EXISTE.
 * El `set(merge)` pelado de messages.ts es correcto para el motor (el cliente ya existe cuando
 * llega un mensaje), pero expuesto a un callable dejaba crear docs stub `customers/{idArbitrario}`
 * desde el navegador. Transaccional: releer y escribir en un solo acto — jamás upsert.
 */
export async function markConversationReadExisting(
  dbi: Firestore,
  tenantId: string,
  customerId: string,
): Promise<{ ok: true }> {
  const ref = dbi.doc(paths.customer(tenantId, customerId));
  await dbi.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new HttpsError('not-found', 'Esa conversación no existe.', { kind: 'customer_not_found' });
    }
    tx.set(ref, { conversation: { unreadForSeller: 0 } }, { merge: true });
  });
  return { ok: true };
}

export interface AssignSellerResult {
  ok: true;
  changed: boolean;
  /** Nombre legible persistido (null cuando se quitó la asignación). */
  sellerName: string | null;
}

/** Roles de `users/{uid}` asignables como vendedor de una conversación del tenant. */
const ROLES_ASIGNABLES: ReadonlySet<string> = new Set(['SELLER', 'TENANT_MANAGER', 'TENANT_OWNER']);

interface UserDoc {
  tenantId?: unknown;
  role?: unknown;
  status?: unknown;
  name?: unknown;
  email?: unknown;
}

/**
 * Asigna (o des-asigna con `sellerUid: null`) el vendedor de la conversación. NO toca
 * `humanTakeover`: asignar es organizar la bandeja, tomar es pausar el bot — dos actos distintos.
 */
export async function assignConversationSeller(
  dbi: Firestore,
  tenantId: string,
  customerId: string,
  sellerUid: string | null,
  actor: ConversationActor,
): Promise<AssignSellerResult> {
  assertRolPrivilegiado(actor, 'asignar vendedores');

  const custRef = dbi.doc(paths.customer(tenantId, customerId));
  const now = Timestamp.now();

  return dbi.runTransaction<AssignSellerResult>(async (tx) => {
    const custSnap = await tx.get(custRef);
    if (!custSnap.exists) throw new HttpsError('not-found', 'Esa conversación no existe.');
    const cust = custSnap.data() as { assignedSellerId?: string | null; assignedSellerName?: string | null } | undefined;

    let sellerName: string | null = null;
    if (sellerUid !== null) {
      // FAIL-CLOSED: el destino tiene que ser staff ACTIVO del MISMO tenant. Un uid inexistente,
      // de otra empresa, desactivado o VIEWER recibe el MISMO error — no se filtra si el uid
      // existe en otra empresa (enumeración de usuarios).
      const userSnap = await tx.get(dbi.doc(paths.user(sellerUid)));
      const user = (userSnap.exists ? userSnap.data() : undefined) as UserDoc | undefined;
      const esAsignable =
        !!user &&
        user.tenantId === tenantId &&
        typeof user.role === 'string' &&
        ROLES_ASIGNABLES.has(user.role) &&
        user.status !== 'DISABLED';
      if (!esAsignable) {
        throw new HttpsError('not-found', 'Ese vendedor no está disponible en esta empresa.', {
          kind: 'seller_not_found',
        });
      }
      sellerName =
        (typeof user.name === 'string' && user.name.trim() !== '' ? user.name.trim() : null) ??
        (typeof user.email === 'string' && user.email !== '' ? user.email : null);
    }

    // Idempotente: asignar lo ya asignado (o limpiar lo ya limpio) ⇒ ok sin escritura ni audit.
    const vigente = cust?.assignedSellerId ?? null;
    if (vigente === sellerUid && (cust?.assignedSellerName ?? null) === sellerName) {
      return { ok: true, changed: false, sellerName };
    }

    tx.set(
      custRef,
      { id: customerId, tenantId, assignedSellerId: sellerUid, assignedSellerName: sellerName, updatedAt: now },
      { merge: true },
    );
    return { ok: true, changed: true, sellerName };
  });
}
