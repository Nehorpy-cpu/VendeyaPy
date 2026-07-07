/**
 * functions/orders/orderCallables.ts — Mutaciones de pedidos por callable (ORDER-1)
 * ==================================================================================
 * TODA mutación de pedidos pasa por acá (firestore.rules cierra el update directo).
 * La máquina de estados vive en orders/lifecycle.ts (pura); acá: auth + validación + audit.
 *
 *   - orderUpdate        (owner/manager/admin) — editar notas/dirección SOLO en UNPAID.
 *                         Items/totals BLOQUEADOS: el costo está congelado en orderFinancials
 *                         y no hay recálculo seguro hoy → cancelar y recrear el pedido.
 *   - orderCancel        (owner/manager/admin) — soft cancel a CANCELLED, SOLO en UNPAID,
 *                         con motivo obligatorio. Nunca hard-delete.
 *   - orderUpdateStatus  (staff: owner/manager/seller/admin) — avance forward. UNPAID→PAID
 *                         ENVUELVE confirmPayment (Purchase + audit + carrito/sesión).
 *   - adminOrderCorrect  (SOLO PLATFORM_ADMIN, check literal) — corrección de estados/notas
 *                         con motivo obligatorio y auditoría before/after.
 *
 * Un pedido pagado/enviado/entregado es registro permanente del negocio: alimenta stats,
 * atribución y Conversions API (eventos ya enviados, irreversibles). El tenant no lo muta.
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import { ORDER_STATUS, type Order, type OrderStatus } from '@vpw/shared';
import { db, paths } from '../../lib/firebase.js';
import { resolvePanelAuth } from '../../panel/auth.js';
import { canTenantCancel, canTenantEdit, canAdvanceStatus } from '../../orders/lifecycle.js';
import { confirmPayment } from '../../orders/confirmPayment.js';
import { resolveComprobanteView, defaultComprobanteViewDeps } from '../../orders/comprobanteView.js';
import { recordAudit } from '../../audit/audit.js';
import { logger } from '../../lib/logger.js';

const STAFF_ROLES = ['TENANT_OWNER', 'TENANT_MANAGER', 'SELLER'];
const NOTES_MAX = 1000;
const REASON_MAX = 300;
/** Resumen corto para metadata de audit (nunca payloads enteros). */
const brief = (s: unknown): string => String(s ?? '').slice(0, 120);

/** Auth manager+ (owner/manager de SU tenant; PLATFORM_ADMIN con tenantId). */
function authorizeManager(req: CallableRequest<unknown>, requestedTenantId?: string): { tenantId: string; uid: string; role: string } {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const token = req.auth.token as { role?: string; tenantId?: string };
  const r = resolvePanelAuth(token, requestedTenantId);
  if (!r.ok) throw new HttpsError(r.code, r.message);
  return { tenantId: r.tenantId, uid: req.auth.uid, role: token.role ?? '' };
}

/** Auth staff (owner/manager/SELLER de SU tenant; PLATFORM_ADMIN con tenantId). */
function authorizeStaff(req: CallableRequest<unknown>, requestedTenantId?: string): { tenantId: string; uid: string; role: string } {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const token = req.auth.token as { role?: string; tenantId?: string };
  if (token.role === 'PLATFORM_ADMIN') {
    if (!requestedTenantId) throw new HttpsError('invalid-argument', 'Falta tenantId (PLATFORM_ADMIN debe indicar la empresa).');
    return { tenantId: requestedTenantId, uid: req.auth.uid, role: token.role };
  }
  if (!token.role || !STAFF_ROLES.includes(token.role)) {
    throw new HttpsError('permission-denied', 'Tu rol no puede operar pedidos.');
  }
  if (!token.tenantId) throw new HttpsError('permission-denied', 'Tu usuario no tiene una empresa asignada.');
  // Se IGNORA cualquier tenantId pedido: el staff solo opera su propia empresa.
  return { tenantId: token.tenantId, uid: req.auth.uid, role: token.role };
}

async function loadOrder(tenantId: string, orderId: string): Promise<{ ref: FirebaseFirestore.DocumentReference; order: Order }> {
  if (!orderId || typeof orderId !== 'string') throw new HttpsError('invalid-argument', 'Falta orderId.');
  const ref = db().doc(paths.order(tenantId, orderId));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'El pedido no existe.');
  return { ref, order: snap.data() as Order };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v.trim() : undefined);

// ---------------- orderUpdate — editar datos ANTES del pago ----------------

interface OrderUpdateInput {
  tenantId?: string;
  orderId?: string;
  data?: { notes?: string; deliveryAddress?: Record<string, unknown> };
}

const ADDRESS_FIELDS = ['street', 'houseNumber', 'city', 'neighborhood', 'reference'] as const;

export const orderUpdate = onCall<OrderUpdateInput>({ region: 'us-central1' }, async (req) => {
  const { tenantId, uid, role } = authorizeManager(req, req.data?.tenantId);
  const { ref, order } = await loadOrder(tenantId, req.data?.orderId ?? '');

  if (!canTenantEdit(order.status)) {
    throw new HttpsError('failed-precondition', `El pedido está ${order.status}: ya no se puede editar (registro permanente). Contactá al administrador si hay un error.`);
  }
  const d = req.data?.data ?? {};
  if ('items' in d || 'totals' in d || 'status' in d) {
    throw new HttpsError('failed-precondition', 'Items/totales/estado no se editan por acá: cancelá el pedido y creá uno nuevo, o usá las acciones de estado.');
  }

  const patch: Record<string, unknown> = {};
  const changed: string[] = [];
  const notes = str(d.notes);
  if (notes !== undefined) {
    if (notes.length > NOTES_MAX) throw new HttpsError('invalid-argument', `Notas demasiado largas (máx ${NOTES_MAX}).`);
    patch['notes'] = notes;
    changed.push('notes');
  }
  if (d.deliveryAddress && typeof d.deliveryAddress === 'object') {
    for (const f of ADDRESS_FIELDS) {
      const v = str((d.deliveryAddress as Record<string, unknown>)[f]);
      if (v !== undefined) {
        patch[`delivery.address.${f}`] = v.slice(0, 200);
        changed.push(`delivery.address.${f}`);
      }
    }
  }
  if (changed.length === 0) throw new HttpsError('invalid-argument', 'Nada para actualizar (permitido: notes, deliveryAddress).');

  patch['updatedAt'] = Timestamp.now();
  await ref.update(patch);
  await recordAudit({
    tenantId, action: 'order.updated', actorUid: uid, actorRole: role, targetType: 'order', targetId: order.id,
    summary: `Pedido editado (${changed.join(', ')})`, metadata: { fields: changed, status: order.status },
  });
  return { ok: true, updated: changed };
});

// ---------------- orderCancel — soft cancel SOLO antes del pago ----------------

export const orderCancel = onCall<{ tenantId?: string; orderId?: string; reason?: string }>(
  { region: 'us-central1' },
  async (req) => {
    const { tenantId, uid, role } = authorizeManager(req, req.data?.tenantId);
    const { ref, order } = await loadOrder(tenantId, req.data?.orderId ?? '');

    if (order.status === 'CANCELLED') return { ok: true, status: 'CANCELLED' }; // idempotente
    if (!canTenantCancel(order.status)) {
      throw new HttpsError('failed-precondition', `El pedido está ${order.status}: no se puede cancelar (registro permanente). Solo el administrador puede corregirlo.`);
    }
    const reason = str(req.data?.reason) ?? '';
    if (reason.length < 3) throw new HttpsError('invalid-argument', 'Indicá el motivo de la cancelación.');
    if (reason.length > REASON_MAX) throw new HttpsError('invalid-argument', `Motivo demasiado largo (máx ${REASON_MAX}).`);

    const now = Timestamp.now();
    // `cancellation` es metadata adicional del doc (el type Order no lo exige; el panel lo ignora).
    await ref.update({ status: 'CANCELLED', cancellation: { reason, byUid: uid, byRole: role, at: now }, updatedAt: now });
    await recordAudit({
      tenantId, action: 'order.cancelled', actorUid: uid, actorRole: role, targetType: 'order', targetId: order.id,
      summary: `Pedido cancelado (${order.status} → CANCELLED)`, metadata: { reason: brief(reason), fromStatus: order.status, total: order.totals?.total ?? null },
    });
    logger.info('Pedido cancelado por tenant', { tenantId, orderId: order.id, fromStatus: order.status });
    return { ok: true, status: 'CANCELLED' };
  },
);

// ---------------- orderUpdateStatus — avance forward por staff ----------------

export const orderUpdateStatus = onCall<{ tenantId?: string; orderId?: string; to?: string }>(
  { region: 'us-central1' },
  async (req) => {
    const { tenantId, uid, role } = authorizeStaff(req, req.data?.tenantId);
    const to = str(req.data?.to) as OrderStatus | undefined;
    if (!to || !ORDER_STATUS.includes(to)) throw new HttpsError('invalid-argument', 'Estado destino inválido.');
    if (to === 'CANCELLED' || to === 'REFUNDED') {
      throw new HttpsError('failed-precondition', 'Cancelaciones van por orderCancel; reembolsos solo por el administrador.');
    }
    const { ref, order } = await loadOrder(tenantId, req.data?.orderId ?? '');
    if (order.status === to) return { ok: true, status: to }; // idempotente

    if (!canAdvanceStatus(order.status, to)) {
      throw new HttpsError('failed-precondition', `Transición inválida: ${order.status} → ${to} (solo avance hacia adelante).`);
    }

    if (to === 'PAID') {
      // La confirmación REAL: confirmPayment re-valida el estado, marca paidAt/paymentId,
      // vacía carrito/sesión, registra el Purchase idempotente y audita 'payment.confirmed'.
      // Devuelve ok:false (no lanza) si el estado ya no lo permite → failed-precondition.
      const res = await confirmPayment(tenantId, order.id);
      if (!res.ok) throw new HttpsError('failed-precondition', res.message);
      await recordAudit({
        tenantId, action: 'order.payment_confirmed_manual', actorUid: uid, actorRole: role, targetType: 'order', targetId: order.id,
        summary: `Pago confirmado manualmente por ${role}`, metadata: { fromStatus: order.status },
      });
      return { ok: true, status: 'PAID' };
    }

    await ref.update({ status: to, updatedAt: Timestamp.now() });
    await recordAudit({
      tenantId, action: 'order.status_changed', actorUid: uid, actorRole: role, targetType: 'order', targetId: order.id,
      summary: `Estado: ${order.status} → ${to}`, metadata: { from: order.status, to },
    });
    return { ok: true, status: to };
  },
);

// ---------------- adminOrderCorrect — SOLO PLATFORM_ADMIN (check literal) ----------------

interface AdminCorrectInput {
  tenantId?: string;
  orderId?: string;
  reason?: string;
  set?: { status?: string; notes?: string };
}

export const adminOrderCorrect = onCall<AdminCorrectInput>({ region: 'us-central1' }, async (req) => {
  // Patrón literal (igual que adminSetManualWhatsappConnection): SOLO PLATFORM_ADMIN.
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const role = (req.auth.token as { role?: string }).role;
  if (role !== 'PLATFORM_ADMIN') {
    throw new HttpsError('permission-denied', 'Solo el administrador de la plataforma puede corregir pedidos.');
  }
  const tenantId = str(req.data?.tenantId) ?? '';
  if (!tenantId) throw new HttpsError('invalid-argument', 'Falta tenantId.');

  const reason = str(req.data?.reason) ?? '';
  if (reason.length < 5) throw new HttpsError('invalid-argument', 'Motivo obligatorio (mín 5 caracteres) — queda en la auditoría.');
  if (reason.length > REASON_MAX) throw new HttpsError('invalid-argument', `Motivo demasiado largo (máx ${REASON_MAX}).`);

  const { ref, order } = await loadOrder(tenantId, req.data?.orderId ?? '');
  const set = req.data?.set ?? {};
  const patch: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};

  const newStatus = str(set.status) as OrderStatus | undefined;
  if (newStatus !== undefined) {
    if (!ORDER_STATUS.includes(newStatus)) throw new HttpsError('invalid-argument', 'Estado inválido.');
    patch['status'] = newStatus;
    before['status'] = order.status;
    after['status'] = newStatus;
  }
  const newNotes = str(set.notes);
  if (newNotes !== undefined) {
    if (newNotes.length > NOTES_MAX) throw new HttpsError('invalid-argument', `Notas demasiado largas (máx ${NOTES_MAX}).`);
    patch['notes'] = newNotes;
    before['notes'] = brief(order.notes);
    after['notes'] = brief(newNotes);
  }
  if (Object.keys(patch).length === 0) throw new HttpsError('invalid-argument', 'Nada para corregir (permitido: set.status, set.notes).');

  patch['updatedAt'] = Timestamp.now();
  await ref.update(patch);
  await recordAudit({
    tenantId, action: 'order.admin_corrected', actorUid: req.auth.uid, actorRole: 'PLATFORM_ADMIN', targetType: 'order', targetId: order.id,
    summary: `Corrección admin: ${Object.keys(after).join(', ')}`, metadata: { reason: brief(reason), before, after },
  });
  logger.info('Pedido corregido por PLATFORM_ADMIN', { tenantId, orderId: order.id, fields: Object.keys(after) });
  return { ok: true, corrected: Object.keys(after) };
});

/**
 * orderGetComprobanteViewUrl (ORDER-COMPROBANTE-VIEW-1) — enlace TEMPORAL para ver el comprobante.
 * LECTURA (no muta la orden): staff del tenant (owner/manager/seller) o PLATFORM_ADMIN.
 * La validación de la referencia y la firma viven en orders/comprobanteView.ts (pura + deps).
 * La URL firmada NO se persiste y NO se loguea (solo orden + expiración).
 */
export const orderGetComprobanteViewUrl = onCall<{ tenantId?: string; orderId?: string }>(
  { region: 'us-central1' },
  async (req) => {
    const auth = authorizeStaff(req, req.data?.tenantId);
    const { order } = await loadOrder(auth.tenantId, str(req.data?.orderId) ?? '');
    const r = await resolveComprobanteView(auth.tenantId, order.id, order.payment?.comprobanteUrl, defaultComprobanteViewDeps);
    if (!r.ok) throw new HttpsError(r.code, r.message);
    logger.info('Comprobante: enlace temporal generado', { tenantId: auth.tenantId, orderId: order.id, role: auth.role, expiresAtMs: r.expiresAtMs });
    return { ok: true, url: r.url, expiresAt: r.expiresAtMs };
  },
);
