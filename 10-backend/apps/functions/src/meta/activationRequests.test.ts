import { describe, it, expect } from 'vitest';
import type { Timestamp } from 'firebase-admin/firestore';
import {
  sanitizeActivationRequestInput,
  buildActivationRequestDoc,
  activationCompletionFields,
  COLL,
  DOC,
} from './activationRequests.js';

// Timestamp falso (import de tipo → borrado en runtime; no toca firebase-admin ni initializeApp).
const NOW = { seconds: 1, nanoseconds: 0 } as unknown as Timestamp;

describe('sanitizeActivationRequestInput', () => {
  it('normaliza nota y contacto válidos', () => {
    const r = sanitizeActivationRequestInput({ note: '  necesito ayuda  ', contactPhone: ' +595 99 123 456 ' });
    expect(r.note).toBe('necesito ayuda');
    expect(r.contactPhone).toBe('+595 99 123 456');
  });

  it('sin datos → nulls', () => {
    expect(sanitizeActivationRequestInput({})).toEqual({ note: null, contactPhone: null });
    expect(sanitizeActivationRequestInput(undefined)).toEqual({ note: null, contactPhone: null });
    expect(sanitizeActivationRequestInput({ note: '   ' })).toEqual({ note: null, contactPhone: null });
  });

  it('trunca la nota a 1000 chars', () => {
    const r = sanitizeActivationRequestInput({ note: 'a'.repeat(3000) });
    expect(r.note?.length).toBe(1000);
  });

  it('descarta contacto con forma inválida (letras / muy corto) sin fallar', () => {
    expect(sanitizeActivationRequestInput({ contactPhone: 'llamame' }).contactPhone).toBeNull();
    expect(sanitizeActivationRequestInput({ contactPhone: '12' }).contactPhone).toBeNull();
  });
});

describe('buildActivationRequestDoc', () => {
  it('arma el doc inicial pending, sin campos de revisión y SIN token', () => {
    const doc = buildActivationRequestDoc({
      id: 'r1', tenantId: 't1', uid: 'u1', role: 'TENANT_OWNER', businessName: 'Acme',
      input: { note: 'hola', contactPhone: '+1 234 5678' }, now: NOW,
    });
    expect(doc.status).toBe('pending');
    expect(doc.id).toBe('r1');
    expect(doc.tenantId).toBe('t1');
    expect(doc.requestedByUid).toBe('u1');
    expect(doc.requestedByRole).toBe('TENANT_OWNER');
    expect(doc.businessName).toBe('Acme');
    expect(doc.note).toBe('hola');
    expect(doc.contactPhone).toBe('+1 234 5678');
    expect(doc.reviewedByUid).toBeNull();
    expect(doc.reviewedAt).toBeNull();
    expect(doc.connectionStatus).toBeNull();
    expect(doc.phoneNumberId).toBeNull();
    expect(doc.cancelReason).toBeNull();
    // El doc de solicitud jamás debe contener secretos.
    expect(JSON.stringify(doc)).not.toMatch(/token|secret|accessToken/i);
  });
});

describe('activationCompletionFields', () => {
  it('marca completed con el estado resultante de la conexión (sin token)', () => {
    const f = activationCompletionFields({ connectionStatus: 'active', phoneNumberId: '109876543210987', adminUid: 'admin-1', now: NOW });
    expect(f).toMatchObject({ status: 'completed', connectionStatus: 'active', phoneNumberId: '109876543210987', reviewedByUid: 'admin-1' });
    expect(JSON.stringify(f)).not.toMatch(/token|secret/i);
  });
});

describe('paths', () => {
  it('COLL/DOC apuntan a la subcolección del tenant', () => {
    expect(COLL('t1')).toBe('tenants/t1/whatsappActivationRequests');
    expect(DOC('t1', 'r1')).toBe('tenants/t1/whatsappActivationRequests/r1');
  });
});
