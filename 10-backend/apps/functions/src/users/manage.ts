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

/**
 * H-02 — Mensaje ÚNICO de rechazo, a propósito.
 *
 * El callable reenvía `e.message` al cliente (`functions/users/userManagement.ts:36`), así que un
 * mensaje distinto por causa convertiría estas funciones en un oráculo: probando invitaciones se
 * podría descubrir qué emails existen en el sistema y en qué empresa están. Mismo criterio que
 * `conversation/lifecycle.ts:191-194` («seller_not_found» para inexistente, ajeno, desactivado y
 * no asignable, sin distinguir).
 */
const DESTINO_NO_DISPONIBLE = 'Ese usuario no está disponible en esta empresa.';

/**
 * H-02 — El destino de una operación de usuarios tiene que ser de ESTA empresa. FAIL-CLOSED.
 *
 * Antes esto era `assertSameTenant` y tenía dos agujeros que la auditoría reprodujo:
 *  1. `inviteUser` ni la llamaba: resolvía el uid por email y le escribía los claims encima, así
 *     que el owner de A se llevaba al owner de B a su empresa (y la víctima perdía la suya).
 *  2. Era FAIL-OPEN: sin documento `users/{uid}` no lanzaba. El bootstrap del PLATFORM_ADMIN
 *     **no crea ese documento a propósito** (`bootstrap-platform-admin.mjs:117`: solo claims, sin
 *     `tenantId`), así que era exactamente el caso que dejaba pasar — se lo podía degradar a rol
 *     de tenant o deshabilitarle la cuenta.
 *
 * Ahora se leen SIEMPRE las dos fuentes de pertenencia (documento y claims de Auth) y recién
 * después se decide. Sólo se opera sobre un destino que declare ESTA empresa:
 *  · Documento de esta empresa y no `DISABLED` ⇒ permitido.
 *  · Documento de otra empresa, o `DISABLED` (salvo reactivación) ⇒ rechazo.
 *  · Sin documento útil, con claims de esta empresa ⇒ permitido. Es la invitación a medio camino
 *    real: `createUser` y `setCustomUserClaims` salieron bien y sólo falló la escritura del doc;
 *    reintentar tiene que poder terminar el trabajo.
 *  · Sin documento y sin claims que declaren esta empresa ⇒ **RECHAZO** (endurecido por la review
 *    del propio fix). Una cuenta de Auth "huérfana" no es tierra de nadie: el registro crea la
 *    cuenta ANTES de verificar el mail y de aprovisionar (`apps/web/src/app/register/page.tsx`),
 *    así que toda persona entre "me registré" y "verifiqué" quedaría adoptable por cualquier
 *    owner que supiera su email — el mismo secuestro de H-02 con otro conjunto de víctimas.
 *
 * El PLATFORM_ADMIN conserva su función: opera sobre los usuarios DE la empresa que indica, igual
 * que antes. Lo que no puede es que alguien lo arrastre a una empresa.
 *
 * DEUDA CONOCIDA (documentada, no cerrada acá porque excede este programa): `inviteUser` sigue
 * revelando por su resultado si un email existe en la plataforma (`created: true|false`). La cura
 * de fondo es la invitación con ACEPTACIÓN del invitado (estado pendiente + token), que además
 * elimina la adopción sin consentimiento. Ver `docs/system-audit-2026-08.md` §H-02.
 */
async function assertDestinoOperable(
  tenantId: string,
  uid: string,
  /**
   * `setUserActive` es la ÚNICA operación que puede tocar a un usuario dado de baja: es
   * literalmente la que lo reactiva. Bloquearlo ahí dejaría a los desactivados irrecuperables
   * desde el panel. La pertenencia a la empresa se sigue exigiendo igual.
   */
  opciones: { permitirDeshabilitado?: boolean } = {},
): Promise<void> {
  const doc = (await db().doc(paths.user(uid)).get()).data() as
    | { tenantId?: string; status?: string }
    | undefined;
  // Las DOS lecturas ocurren siempre, aunque el documento ya alcance para decidir: si una rama
  // hiciera una consulta más que la otra, la diferencia de latencia distinguiría los casos y
  // volvería a filtrar por el costado lo que el mensaje uniforme oculta.
  let claims: Record<string, unknown> | null = null;
  try {
    claims = ((await auth().getUser(uid)).customClaims ?? {}) as Record<string, unknown>;
  } catch {
    claims = null; // el uid no existe en Auth (o Auth está caído): se decide abajo, fail-closed
  }

  const tenantDelDoc = typeof doc?.tenantId === 'string' && doc.tenantId !== '' ? doc.tenantId : null;
  if (tenantDelDoc !== null) {
    const deshabilitadoBloquea = doc?.status === 'DISABLED' && !opciones.permitirDeshabilitado;
    if (tenantDelDoc !== tenantId || deshabilitadoBloquea) throw new Error(DESTINO_NO_DISPONIBLE);
    return;
  }

  // Documento ausente o sin `tenantId` utilizable (p.ej. un doc escrito por un `merge` parcial):
  // manda Auth. Nunca se rechaza sólo por eso — bloquear un doc sin tenant dejaría al usuario
  // intocable para SIEMPRE, incluido el PLATFORM_ADMIN.
  if (!claims) throw new Error(DESTINO_NO_DISPONIBLE);
  if (claims['role'] === 'PLATFORM_ADMIN') throw new Error(DESTINO_NO_DISPONIBLE);
  if (claims['tenantId'] !== tenantId) throw new Error(DESTINO_NO_DISPONIBLE);
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
  // H-02: el email PREEXISTENTE puede ser de otra empresa (o el PLATFORM_ADMIN). Validar antes de
  // escribirle los claims encima — eso era el secuestro. Un usuario recién creado acá no necesita
  // el guard: no tiene dueño previo posible.
  if (!created) await assertDestinoOperable(tenantId, uid);
  await auth().setCustomUserClaims(uid, { tenantId, role });
  await db()
    .doc(paths.user(uid))
    .set({ id: uid, email, name: name ?? '', role, tenantId, status: 'ACTIVE', updatedAt: Timestamp.now() }, { merge: true });
  logger.info('Usuario invitado', { tenantId, uid, role });
  return { uid, created };
}

export async function setUserRole(tenantId: string, uid: string, role: UserRole): Promise<void> {
  if (!TENANT_ROLES.includes(role)) throw new Error('Rol inválido');
  await assertDestinoOperable(tenantId, uid);
  await auth().setCustomUserClaims(uid, { tenantId, role });
  // El tenantId va SIEMPRE en el merge: un doc que quedara sin él sería intocable para todos los
  // tenants (y para el admin) en la próxima operación — regresión detectada en la review.
  await db().doc(paths.user(uid)).set({ role, tenantId, updatedAt: Timestamp.now() }, { merge: true });
  logger.info('Rol de usuario actualizado', { tenantId, uid, role });
}

export async function setUserActive(tenantId: string, uid: string, active: boolean): Promise<void> {
  await assertDestinoOperable(tenantId, uid, { permitirDeshabilitado: true });
  await auth().updateUser(uid, { disabled: !active });
  await db().doc(paths.user(uid)).set({ status: active ? 'ACTIVE' : 'DISABLED', tenantId, updatedAt: Timestamp.now() }, { merge: true });
  logger.info('Usuario activado/desactivado', { tenantId, uid, active });
}
