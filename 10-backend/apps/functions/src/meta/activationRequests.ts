/**
 * meta/activationRequests.ts — Solicitudes de activación asistida de WhatsApp (WM-2).
 * ====================================================================================
 * El TENANT_OWNER pide ayuda para activar WhatsApp ('pending'); el PLATFORM_ADMIN carga la conexión
 * manual (WM-1, adminSetManualWhatsappConnection) y la solicitud queda 'completed', o se 'cancelled'.
 * Viven en tenants/{tenantId}/whatsappActivationRequests/{requestId}.
 *
 * IMPORTANTE: acá NUNCA hay token de acceso. El token solo lo maneja WM-1 (cifrado en SecretStore).
 * Este módulo solo mueve metadatos NO sensibles (nota, contacto, estado, phone_number_id).
 *
 * Las partes PURAS (sanitize/build/completion) son testeables sin E/S; markActivationRequestCompleted
 * hace la escritura best-effort y se cubre en el e2e del emulador.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../lib/firebase.js';
import { recordAudit } from '../audit/audit.js';
import { logger } from '../lib/logger.js';

export const COLL = (t: string): string => `tenants/${t}/whatsappActivationRequests`;
export const DOC = (t: string, id: string): string => `tenants/${t}/whatsappActivationRequests/${id}`;

// Contacto: dígitos + separadores comunes de teléfono. Solo informativo (no se usa para enviar nada).
const SAFE_CONTACT = /^[0-9+()\s-]{4,32}$/;

export interface ActivationRequestInput {
  note: string | null;
  contactPhone: string | null;
}

/** Sanitiza los campos NO sensibles de la solicitud (no hay token acá). Pura, sin E/S. */
export function sanitizeActivationRequestInput(data: unknown): ActivationRequestInput {
  const d = (data ?? {}) as Record<string, unknown>;
  const note = typeof d.note === 'string' && d.note.trim() ? d.note.trim().slice(0, 1000) : null;
  const raw = typeof d.contactPhone === 'string' ? d.contactPhone.trim() : '';
  // Si el contacto no tiene forma de teléfono, se descarta en silencio (no se rechaza toda la solicitud).
  const contactPhone = raw && SAFE_CONTACT.test(raw) ? raw : null;
  return { note, contactPhone };
}

export interface BuildRequestArgs {
  id: string;
  tenantId: string;
  uid: string;
  role: string;
  businessName: string | null;
  input: ActivationRequestInput;
  now: Timestamp;
}

/** Documento inicial de la solicitud ('pending'). Pura. NUNCA contiene token. */
export function buildActivationRequestDoc(a: BuildRequestArgs) {
  return {
    id: a.id,
    tenantId: a.tenantId,
    status: 'pending' as const,
    requestedByUid: a.uid,
    requestedByRole: a.role,
    requestedAt: a.now,
    businessName: a.businessName,
    contactPhone: a.input.contactPhone,
    note: a.input.note,
    reviewedByUid: null,
    reviewedAt: null,
    connectionStatus: null,
    phoneNumberId: null,
    cancelReason: null,
  };
}

export interface CompletionArgs {
  connectionStatus: string;
  phoneNumberId: string;
  adminUid: string;
  now: Timestamp;
}

/** Campos de actualización al COMPLETAR una solicitud (WM-1 cargó la conexión). Pura. NO incluye token. */
export function activationCompletionFields(a: CompletionArgs) {
  return {
    status: 'completed' as const,
    connectionStatus: a.connectionStatus,
    phoneNumberId: a.phoneNumberId,
    reviewedByUid: a.adminUid,
    reviewedAt: a.now,
  };
}

/**
 * Marca 'completed' la solicitud pendiente cuando el admin carga la conexión (WM-1).
 * BEST-EFFORT: si no existe (carga directa sin solicitud) o ya no está pendiente, loguea y sigue —
 * la conexión ya quedó escrita y NO debe romperse por esto. Solo pasa datos NO sensibles.
 */
export async function markActivationRequestCompleted(
  tenantId: string,
  requestId: string,
  fields: { connectionStatus: string; phoneNumberId: string; adminUid: string },
): Promise<void> {
  try {
    const ref = db().doc(DOC(tenantId, requestId));
    const snap = await ref.get();
    if (!snap.exists) {
      logger.warn('markActivationRequestCompleted: solicitud inexistente (se omite)', { tenantId, requestId });
      return;
    }
    if ((snap.data() as { status?: string }).status !== 'pending') {
      logger.info('markActivationRequestCompleted: solicitud no pendiente (se omite)', { tenantId, requestId });
      return;
    }
    await ref.update(activationCompletionFields({ ...fields, now: Timestamp.now() }));
    // Audit del cierre del ciclo de la solicitud (sin token; solo estado/phone id).
    await recordAudit({
      tenantId, action: 'whatsapp.activation_completed', actorUid: fields.adminUid, actorRole: 'PLATFORM_ADMIN',
      targetType: 'meta', targetId: requestId, summary: 'Solicitud de activación de WhatsApp completada',
      metadata: { connectionStatus: fields.connectionStatus, phoneNumberId: fields.phoneNumberId },
    });
    logger.info('Solicitud de activación WhatsApp completada', { tenantId, requestId, connectionStatus: fields.connectionStatus });
  } catch (err) {
    logger.warn('markActivationRequestCompleted falló (best-effort)', { tenantId, requestId, err: (err as Error).message });
  }
}
