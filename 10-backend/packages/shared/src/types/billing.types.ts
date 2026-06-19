/**
 * billing.types — Billing manual por WhatsApp (MB).
 * Solicitud de activación manual de un plan: el TENANT_OWNER la crea (status='pending'), el
 * PLATFORM_ADMIN la aprueba (activa el plan vía applySubscriptionUpdate, provider='manual_whatsapp')
 * o la cancela. Vive en tenants/{tenantId}/manualActivationRequests/{requestId}.
 * ESCRITURA SOLO por callable (Admin SDK); read: owner (las suyas) o platform admin.
 */
import type { ManualActivationStatus, ManualPaymentMethod } from '../enums.js';
import type { Timestamp } from './common.types.js';

export interface ManualActivationRequest {
  id: string;
  tenantId: string;
  /** Plan solicitado (id de plans/{planId}); el backend valida que exista y no sea 'free'. */
  planId: string;
  status: ManualActivationStatus;
  /** Método de pago acordado por WhatsApp (informativo). */
  method: ManualPaymentMethod;
  /** Quién creó la solicitud (uid del owner/admin) y su rol al momento de crearla. */
  requestedByUid: string;
  requestedByRole: string;
  requestedAt: Timestamp;
  /** Nota opcional del owner (ej. detalle del pago). */
  note: string | null;
  /** Referencia del pago que carga el admin al aprobar (comprobante/operación). */
  paymentReference: string | null;
  /** Quién revisó (aprobó/canceló) y cuándo. */
  reviewedByUid: string | null;
  reviewedAt: Timestamp | null;
  /** Motivo de cancelación (si status='cancelled'). */
  cancelReason: string | null;
}
