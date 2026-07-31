import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0016 §4 — COSTURA del gate. Mientras nadie enchufe el gate real, el comportamiento por
 * defecto tiene que ser el SEGURO del ADR: una imagen fuera de un contexto explícito de pago
 * queda como medio normal, no propone ningún pedido y no responde nada.
 */

const docs = new Map<string, Record<string, unknown>>();
const refFor = (path: string) => ({
  get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
  update: async (d: Record<string, unknown>) => docs.set(path, { ...(docs.get(path) ?? {}), ...d }),
  set: async (d: Record<string, unknown>) => docs.set(path, d),
});

vi.mock('../lib/firebase.js', () => ({ db: () => ({ doc: (p: string) => refFor(p) }) }));

import { genericMediaGate, getAttachmentGate, setAttachmentGate } from './attachmentGate.js';
import { buildAttachmentDocPath, type Attachment } from '@vpw/shared';

const TENANT = 'tnt_test01';
const ID = 'att_0123456789abcdef01234567';

const adjunto = (classification: string): Attachment =>
  ({
    attachmentId: ID,
    tenantId: TENANT,
    ingestState: 'stored',
    classification: { value: classification, source: 'rule', confidence: 0, by: null, at: null },
  }) as unknown as Attachment;

const entrada = (a: Attachment) => ({
  tenantId: TENANT,
  customerId: '595991234567',
  channel: 'whatsapp' as const,
  attachment: a,
  messageId: 'pmid_x',
  receivedByPhoneNumberId: null,
});

beforeEach(() => {
  docs.clear();
  setAttachmentGate(null);
});

describe('attachmentGate — costura y comportamiento por defecto', () => {
  it('sin gate registrado corre el de defecto: medio normal, sin candidato y sin respuesta', async () => {
    expect(getAttachmentGate()).toBe(genericMediaGate);
    const r = await getAttachmentGate()(entrada(adjunto('unclassified')));
    expect(r).toEqual({ reply: '', classification: 'generic_media', orderCandidateId: null });
    const doc = docs.get(buildAttachmentDocPath(TENANT, ID)) as Record<string, any>;
    expect(doc['classification']).toMatchObject({ value: 'generic_media', source: 'rule', confidence: 1, by: null });
  });

  it('NO pisa una clasificación puesta por una persona (comprobante vinculado)', async () => {
    const r = await genericMediaGate(entrada(adjunto('payment_receipt_linked')));
    expect(r.classification).toBe('payment_receipt_linked');
    expect(docs.get(buildAttachmentDocPath(TENANT, ID))).toBeUndefined(); // no escribió nada
  });

  it('es idempotente: un adjunto ya marcado como medio normal no se reescribe', async () => {
    const r = await genericMediaGate(entrada(adjunto('generic_media')));
    expect(r.classification).toBe('generic_media');
    expect(docs.get(buildAttachmentDocPath(TENANT, ID))).toBeUndefined();
  });

  it('el gate real se enchufa por la costura y desplaza al de defecto', async () => {
    const propio = vi.fn(async () => ({ reply: 'hola', classification: 'payment_receipt_candidate' as const, orderCandidateId: 'ord_1' }));
    setAttachmentGate(propio);
    expect(getAttachmentGate()).toBe(propio);
    setAttachmentGate(null);
    expect(getAttachmentGate()).toBe(genericMediaGate);
  });
});
