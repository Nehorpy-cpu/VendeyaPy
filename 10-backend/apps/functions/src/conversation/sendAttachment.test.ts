import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpsError } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import type { Customer } from '@vpw/shared';
import { ATTACHMENT_ID_RE } from '@vpw/shared';

// Jamás IA en un envío humano (mismo canario que manualMessage.test.ts).
vi.mock('../ai/salesAgent.js', () => ({ runSalesAgent: vi.fn() }));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { logger } from '../lib/logger.js';

import type { ManualGateContext, EnvioManualGuardDeps } from './manualMessage.js';
import {
  sendConversationAttachment,
  maxBase64LengthForBytes,
  decidirReservaDeOperacion,
  OUTBOUND_OP_LEASE_MS,
  SEND_ATTACHMENT_IMAGE_MAX_BYTES,
  SEND_ATTACHMENT_DOCUMENT_MAX_BYTES,
  type SendAttachmentDeps,
  type SendAttachmentInput,
  type OutboundOpDoc,
} from './sendAttachment.js';

const PNID = '1251346811387904';
const TEL = '595994893000';

// ---- fixtures binarios REALES (pasan/reprueban el sniffing de verdad) ----
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'utf8');
const EXE = Buffer.concat([Buffer.from('MZ', 'ascii'), Buffer.alloc(64)]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>', 'utf8');

const customer = (over: Partial<Record<string, unknown>> = {}): Customer =>
  ({
    id: TEL,
    tenantId: 'arfagi',
    whatsappPhone: TEL,
    conversation: { humanTakeover: true, receivedVia: PNID, ...((over['conversation'] as object) ?? {}) },
    ...over,
  }) as unknown as Customer;

const gateCtx = (over: Partial<ManualGateContext> = {}): ManualGateContext => ({
  humanTakeover: true,
  coveragePointer: null,
  activation: null,
  shippingQuote: null,
  resumeDone: null,
  ...over,
});

interface MakeOpts {
  guard?: Partial<EnvioManualGuardDeps>;
  transport?: 'live' | 'mock';
  deps?: Partial<SendAttachmentDeps>;
}

function makeDeps(opts: MakeOpts = {}) {
  const ops = new Map<string, OutboundOpDoc>();
  const sendImage = vi.fn(async () => ({ ok: true as const, outcome: 'accepted' as const, id: 'wamid.ATT-1', viaMock: false as const }));
  const sendDocument = vi.fn(async () => ({ ok: true as const, outcome: 'accepted' as const, id: 'wamid.ATT-2', viaMock: false as const }));
  const client = {
    transportInfo: opts.transport === 'mock' ? { transport: 'mock', mode: 'mock', reason: null, tokenPresent: false } : { transport: 'live', credentials: 'tenant' },
    sendText: vi.fn(),
    sendLocationRequest: vi.fn(),
    sendImage,
    sendDocument,
  };
  const getClient = vi.fn(async () => client);
  const guard: EnvioManualGuardDeps = {
    getCustomer: async () => customer(),
    getGateContext: async () => gateCtx(),
    resolverCanal: async () => 'active',
    getClient: getClient as unknown as EnvioManualGuardDeps['getClient'],
    ...opts.guard,
  };
  // Mismas reglas que la implementación real (helper puro compartido): create / reclamo de
  // lease vencido / rechazo. El mapa es atómico por llamada, como la transacción de Firestore.
  const reserveOperation = vi.fn(async (_t: string, op: string, doc: OutboundOpDoc) => {
    const existing = ops.get(op) ?? null;
    const decision = decidirReservaDeOperacion(existing, doc);
    if (decision.accion === 'crear') {
      ops.set(op, doc);
      return { created: true as const, existing: null };
    }
    if (decision.accion === 'reclamar') {
      ops.set(op, {
        ...(existing as OutboundOpDoc),
        actorUid: doc.actorUid,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        state: 'pending',
        result: null,
        lastError: null,
      });
      return { created: true as const, existing: null };
    }
    return { created: false as const, existing };
  });
  const updateOperation = vi.fn(async (_t: string, op: string, patch: Record<string, unknown>) => {
    ops.set(op, { ...(ops.get(op) as OutboundOpDoc), ...patch } as OutboundOpDoc);
  });
  const releaseOperation = vi.fn(async (_t: string, op: string) => {
    ops.delete(op);
  });
  const saveBytes = vi.fn(async () => {});
  const writeAttachmentDoc = vi.fn(async () => {});
  const markAttachmentSendError = vi.fn(async () => {});
  const uploadMedia = vi.fn(async () => ({ ok: true as const, mediaId: 'MEDIA-1' }));
  const append = vi.fn(async () => ({}) as never);
  const deps: SendAttachmentDeps = {
    guard,
    reserveOperation: reserveOperation as unknown as SendAttachmentDeps['reserveOperation'],
    updateOperation: updateOperation as unknown as SendAttachmentDeps['updateOperation'],
    releaseOperation,
    saveBytes,
    writeAttachmentDoc: writeAttachmentDoc as unknown as SendAttachmentDeps['writeAttachmentDoc'],
    markAttachmentSendError,
    uploadMedia: uploadMedia as unknown as SendAttachmentDeps['uploadMedia'],
    append: append as unknown as SendAttachmentDeps['append'],
    now: () => Timestamp.fromMillis(1_000_000),
    ...opts.deps,
  };
  return { deps, ops, sendImage, sendDocument, getClient, reserveOperation, updateOperation, releaseOperation, saveBytes, writeAttachmentDoc, markAttachmentSendError, uploadMedia, append };
}

const input = (over: Partial<SendAttachmentInput> = {}): SendAttachmentInput => ({
  tenantId: 'arfagi',
  customerId: TEL,
  operationId: 'op-2026-0001-abc',
  kind: 'image',
  filename: 'foto.jpg',
  mimeType: 'image/jpeg',
  dataBase64: JPEG.toString('base64'),
  ...over,
});

const SELLER = { uid: 'u-seller', role: 'SELLER', name: 'Vendedora' };

/** El reloj del fake `now()` de makeDeps. */
const NOW_MS = 1_000_000;

/** Reserva pre-existente COHERENTE con `input()` (mismo customerId/kind), a edad elegida. */
const reservaPrevia = (over: Partial<OutboundOpDoc> = {}, ageMs = 1_000): OutboundOpDoc =>
  ({
    operationId: 'op-2026-0001-abc',
    tenantId: 'arfagi',
    customerId: TEL,
    kind: 'image',
    actorUid: 'u-anterior',
    attachmentId: 'att_0123456789abcdef01234567',
    state: 'pending',
    result: null,
    lastError: null,
    createdAt: Timestamp.fromMillis(NOW_MS - ageMs),
    updatedAt: Timestamp.fromMillis(NOW_MS - ageMs),
    ...over,
  }) as OutboundOpDoc;

const sinEfectos = (m: ReturnType<typeof makeDeps>) => {
  expect(m.reserveOperation).not.toHaveBeenCalled();
  expect(m.saveBytes).not.toHaveBeenCalled();
  expect(m.writeAttachmentDoc).not.toHaveBeenCalled();
  expect(m.uploadMedia).not.toHaveBeenCalled();
  expect(m.sendImage).not.toHaveBeenCalled();
  expect(m.sendDocument).not.toHaveBeenCalled();
  expect(m.append).not.toHaveBeenCalled();
};

beforeEach(() => vi.clearAllMocks());

describe('conversation/sendAttachment — camino feliz', () => {
  it('imagen live: valida, guarda, sube a Meta, envía, persiste burbuja con punteros y cierra el op', async () => {
    const m = makeDeps();
    const r = await sendConversationAttachment(input({ caption: '  mirá el perfume 🌸  ' }), SELLER, m.deps);
    expect(r.ok).toBe(true);
    expect(r.viaMock).toBe(false);
    expect(r.waMessageId).toBe('wamid.ATT-1');
    expect(r.attachmentId).toMatch(ATTACHMENT_ID_RE);

    // Storage: ruta opaca derivada del attachmentId + MIME VERIFICADO.
    const [path, buf, contentType] = m.saveBytes.mock.calls[0]!;
    expect(path).toBe(`tenants/arfagi/attachments/${r.attachmentId.slice(4, 6)}/${r.attachmentId}`);
    expect(Buffer.compare(buf as Buffer, JPEG)).toBe(0);
    expect(contentType).toBe('image/jpeg');

    // Doc de adjunto compatible con el visor del panel (proyección toPanelAttachment).
    const doc = m.writeAttachmentDoc.mock.calls[0]![2] as Record<string, unknown>;
    expect(doc).toMatchObject({
      attachmentId: r.attachmentId,
      tenantId: 'arfagi',
      customerId: TEL,
      class: 'image',
      direction: 'out',
      author: 'seller',
      origin: 'panel',
      uploadedByUid: 'u-seller',
      ingestState: 'stored',
      caption: 'mirá el perfume 🌸', // saneado, vive en el DOC (no en el texto del mensaje)
      filename: 'foto.jpg',
      bytes: JPEG.length,
      orderCandidateId: null,
    });
    expect((doc['mime'] as { verified: string }).verified).toBe('image/jpeg');
    // JAMÁS clasificado como comprobante ni candidato: nace generic_media y sin pedido.
    expect((doc['classification'] as { value: string }).value).toBe('generic_media');
    expect((doc['storage'] as { path: string }).path).toBe(path);

    // Envío por el cliente resuelto (PNID de receivedVia) con el media id subido y el caption.
    expect(m.getClient).toHaveBeenCalledWith('arfagi', PNID);
    expect(m.uploadMedia).toHaveBeenCalledWith('arfagi', PNID, expect.objectContaining({ mimeType: 'image/jpeg' }));
    expect(m.sendImage).toHaveBeenCalledWith(TEL, { mediaId: 'MEDIA-1', caption: 'mirá el perfume 🌸' }, { tenantId: 'arfagi', channel: 'whatsapp' });

    // Burbuja: author seller, SIN texto (el caption no entra al historial ⇒ no llega a la IA).
    expect(m.append).toHaveBeenCalledWith('arfagi', TEL, expect.objectContaining({
      direction: 'out',
      author: 'seller',
      text: '',
      channel: 'whatsapp',
      receivedVia: PNID,
      senderUid: 'u-seller',
      waMessageId: 'wamid.ATT-1',
      viaMock: false,
      attachmentIds: [r.attachmentId],
    }));

    // Reserva cerrada en done con el resultado.
    const op = m.ops.get('op-2026-0001-abc')!;
    expect(op.state).toBe('done');
    expect(op.result).toMatchObject({ viaMock: false, waMessageId: 'wamid.ATT-1', attachmentId: r.attachmentId });
  });

  it('documento live: sendDocument con filename y sin caption', async () => {
    const m = makeDeps();
    const r = await sendConversationAttachment(
      input({ kind: 'document', filename: 'lista de precios.pdf', mimeType: 'application/pdf', dataBase64: PDF.toString('base64') }),
      SELLER,
      m.deps,
    );
    expect(r.ok).toBe(true);
    expect(m.sendDocument).toHaveBeenCalledWith(TEL, { mediaId: 'MEDIA-1', filename: 'lista de precios.pdf' }, { tenantId: 'arfagi', channel: 'whatsapp' });
    expect(m.sendImage).not.toHaveBeenCalled();
  });
});

describe('validación fail-closed ANTES de cualquier efecto', () => {
  it('MIME declarado ≠ magic bytes (png declarado, bytes MZ/EXE) ⇒ invalid-argument sin efectos', async () => {
    const m = makeDeps();
    await expect(
      sendConversationAttachment(input({ mimeType: 'image/png', dataBase64: EXE.toString('base64') }), SELLER, m.deps),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    sinEfectos(m);
  });

  it('formatos prohibidos: svg declarado, zip con MIME pdf, html con MIME png ⇒ rechazo sin efectos', async () => {
    for (const bad of [
      input({ mimeType: 'image/svg+xml', dataBase64: HTML.toString('base64') }),
      input({ kind: 'document', mimeType: 'application/pdf', filename: 'x.pdf', dataBase64: ZIP.toString('base64') }),
      input({ mimeType: 'image/png', dataBase64: HTML.toString('base64') }),
    ]) {
      const m = makeDeps();
      await expect(sendConversationAttachment(bad, SELLER, m.deps)).rejects.toMatchObject({ code: 'invalid-argument' });
      sinEfectos(m);
    }
  });

  it('oversize base64 (imagen): el string se rechaza ANTES de decodificar', async () => {
    const m = makeDeps();
    const cap = maxBase64LengthForBytes(SEND_ATTACHMENT_IMAGE_MAX_BYTES);
    await expect(
      sendConversationAttachment(input({ dataBase64: 'A'.repeat(cap + 4) }), SELLER, m.deps),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    sinEfectos(m);
  });

  it('oversize REAL: imagen de 5MB+1 bytes ⇒ invalid-argument sin efectos', async () => {
    const m = makeDeps();
    const grande = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(SEND_ATTACHMENT_IMAGE_MAX_BYTES - 3)]);
    expect(grande.length).toBe(SEND_ATTACHMENT_IMAGE_MAX_BYTES + 1);
    await expect(
      sendConversationAttachment(input({ dataBase64: grande.toString('base64') }), SELLER, m.deps),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    sinEfectos(m);
  });

  it('oversize REAL: documento de 7MB+1 bytes ⇒ invalid-argument sin efectos', async () => {
    const m = makeDeps();
    const head = Buffer.from('%PDF-1.4\n', 'utf8');
    const grande = Buffer.concat([head, Buffer.alloc(SEND_ATTACHMENT_DOCUMENT_MAX_BYTES + 1 - head.length)]);
    await expect(
      sendConversationAttachment(
        input({ kind: 'document', filename: 'x.pdf', mimeType: 'application/pdf', dataBase64: grande.toString('base64') }),
        SELLER,
        m.deps,
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    sinEfectos(m);
  });

  it('operationId con forma inválida ⇒ invalid-argument sin efectos', async () => {
    for (const opId of ['', 'ab', 'x'.repeat(80), 'con/slash', 'con espacio', '../etc']) {
      const m = makeDeps();
      await expect(sendConversationAttachment(input({ operationId: opId }), SELLER, m.deps)).rejects.toMatchObject({ code: 'invalid-argument' });
      sinEfectos(m);
    }
  });
});

describe('guard compartido (canal / takeover / gate / PNID)', () => {
  it('conversación de Instagram ⇒ channel_send_unsupported sin reserva ni envío', async () => {
    const m = makeDeps({
      guard: { getCustomer: async () => customer({ conversation: { humanTakeover: true, channel: 'instagram', receivedVia: null } }) },
    });
    try {
      await sendConversationAttachment(input(), SELLER, m.deps);
      expect.unreachable('debió rechazar');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpsError);
      expect(((e as HttpsError).details as { kind?: string })?.kind).toBe('channel_send_unsupported');
    }
    sinEfectos(m);
  });

  it('SELLER sin takeover ⇒ failed-precondition; MANAGER (override) pasa', async () => {
    const sinTakeover = {
      getGateContext: async () => gateCtx({ humanTakeover: false }),
      getCustomer: async () => customer({ conversation: { humanTakeover: false, receivedVia: PNID } }),
    };
    const bloqueado = makeDeps({ guard: sinTakeover });
    await expect(sendConversationAttachment(input(), SELLER, bloqueado.deps)).rejects.toThrow(/Tomar conversación/);
    sinEfectos(bloqueado);

    const permitido = makeDeps({ guard: sinTakeover });
    const r = await sendConversationAttachment(input(), { uid: 'u-mgr', role: 'TENANT_MANAGER', name: 'Manager' }, permitido.deps);
    expect(r.ok).toBe(true);
    expect(permitido.append).toHaveBeenCalled();
  });

  it('gate de cotización: caption con costo de envío y cobertura en revisión ⇒ shipping_quote_required', async () => {
    const m = makeDeps({
      guard: {
        getGateContext: async () =>
          gateCtx({
            coveragePointer: { requestId: 'covr_abc123DEF456', status: 'pending_coverage_review' },
            activation: { enabled: true, activationId: 'act-test-000001' },
            shippingQuote: { status: 'required', maxChargeGs: 5_000_000 },
          }),
      },
    });
    try {
      await sendConversationAttachment(input({ caption: 'el costo de envío es ₲30.000' }), SELLER, m.deps);
      expect.unreachable('debió bloquear');
    } catch (e) {
      expect(((e as HttpsError).details as { kind?: string })?.kind).toBe('shipping_quote_required');
    }
    sinEfectos(m);
  });
});

describe('idempotencia por operationId', () => {
  it('mismo operationId dos veces ⇒ UN solo envío; la segunda devuelve el resultado previo', async () => {
    const m = makeDeps();
    const r1 = await sendConversationAttachment(input(), SELLER, m.deps);
    const r2 = await sendConversationAttachment(input(), SELLER, m.deps);
    expect(m.sendImage).toHaveBeenCalledTimes(1);
    expect(m.uploadMedia).toHaveBeenCalledTimes(1);
    expect(m.append).toHaveBeenCalledTimes(1);
    expect(r2).toMatchObject({ ok: true, viaMock: false, waMessageId: r1.waMessageId, attachmentId: r1.attachmentId, duplicate: true });
  });

  it('operación todavía pending (lease FRESCO) ⇒ failed-precondition operation_in_flight sin envío', async () => {
    const m = makeDeps();
    m.ops.set('op-2026-0001-abc', reservaPrevia({}, 1_000));
    try {
      await sendConversationAttachment(input(), SELLER, m.deps);
      expect.unreachable('debió rechazar');
    } catch (e) {
      expect(((e as HttpsError).details as { kind?: string })?.kind).toBe('operation_in_flight');
    }
    expect(m.sendImage).not.toHaveBeenCalled();
    expect(m.append).not.toHaveBeenCalled();
  });
});

describe('B1 — lease de la reserva pending (runtime muerto a mitad de envío)', () => {
  it('pending con lease VENCIDO se reclama: el envío procede y sale UNA sola vez', async () => {
    const m = makeDeps();
    m.ops.set('op-2026-0001-abc', reservaPrevia({}, OUTBOUND_OP_LEASE_MS + 1));
    const r = await sendConversationAttachment(input(), SELLER, m.deps);
    expect(r.ok).toBe(true);
    expect(m.sendImage).toHaveBeenCalledTimes(1);
    expect(m.append).toHaveBeenCalledTimes(1);
    const op = m.ops.get('op-2026-0001-abc')!;
    expect(op.state).toBe('done');
    expect(op.actorUid).toBe('u-seller'); // el reclamo transfiere la reserva al actor nuevo
  });

  it('carrera: dos reclamos simultáneos del MISMO op vencido ⇒ solo uno gana (semántica tx)', async () => {
    const m = makeDeps();
    m.ops.set('op-2026-0001-abc', reservaPrevia({}, OUTBOUND_OP_LEASE_MS + 1));
    // El envío del ganador es LENTO: el perdedor llega a la reserva mientras el otro sigue en vuelo.
    m.sendImage.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { ok: true as const, outcome: 'accepted' as const, id: 'wamid.ATT-1', viaMock: false as const };
    });
    const [a, b] = await Promise.allSettled([
      sendConversationAttachment(input(), SELLER, m.deps),
      sendConversationAttachment(input(), SELLER, m.deps),
    ]);
    const resultados = [a, b];
    const ganadores = resultados.filter((r) => r.status === 'fulfilled');
    const perdedores = resultados.filter((r) => r.status === 'rejected');
    expect(ganadores).toHaveLength(1);
    expect(perdedores).toHaveLength(1);
    const err = (perdedores[0] as PromiseRejectedResult).reason as HttpsError;
    expect((err.details as { kind?: string })?.kind).toBe('operation_in_flight');
    expect(m.sendImage).toHaveBeenCalledTimes(1); // UN solo envío pese a la carrera
  });

  it('decidirReservaDeOperacion (pura): fresca ⇒ rechazar; vencida ⇒ reclamar; reclamada ⇒ vuelve a rechazar; done ⇒ rechazar aunque sea vieja', () => {
    const doc = reservaPrevia({ actorUid: 'u-seller' }, 0); // el doc "nuevo" que intenta reservar
    expect(decidirReservaDeOperacion(null, doc)).toEqual({ accion: 'crear' });
    expect(decidirReservaDeOperacion(reservaPrevia({}, 1_000), doc)).toEqual({ accion: 'rechazar' });
    expect(decidirReservaDeOperacion(reservaPrevia({}, OUTBOUND_OP_LEASE_MS + 1), doc)).toEqual({ accion: 'reclamar' });
    // Después del reclamo el lease queda renovado: el perdedor de la carrera ve una pending fresca.
    expect(decidirReservaDeOperacion(reservaPrevia({}, 0), doc)).toEqual({ accion: 'rechazar' });
    expect(decidirReservaDeOperacion(reservaPrevia({ state: 'done' }, OUTBOUND_OP_LEASE_MS * 10), doc)).toEqual({ accion: 'rechazar' });
    expect(decidirReservaDeOperacion(reservaPrevia({ state: 'unknown' }, OUTBOUND_OP_LEASE_MS * 10), doc)).toEqual({ accion: 'rechazar' });
  });

  it('una reserva vencida de OTRO envío (customerId/kind distintos) NO se reclama', () => {
    const doc = reservaPrevia({ actorUid: 'u-seller' }, 0);
    expect(decidirReservaDeOperacion(reservaPrevia({ customerId: '595990000000' }, OUTBOUND_OP_LEASE_MS + 1), doc)).toEqual({ accion: 'rechazar' });
    expect(decidirReservaDeOperacion(reservaPrevia({ kind: 'document' }, OUTBOUND_OP_LEASE_MS + 1), doc)).toEqual({ accion: 'rechazar' });
  });
});

describe('B2 — coherencia del replay: el operationId nombra UN envío concreto', () => {
  const donePrevio = (over: Partial<OutboundOpDoc> = {}) =>
    reservaPrevia(
      {
        state: 'done',
        result: { viaMock: false, waMessageId: 'wamid.PREV', attachmentId: 'att_0123456789abcdef01234567' },
        ...over,
      },
      1_000,
    );

  it('reserva done de OTRO customerId ⇒ invalid-argument (jamás un duplicate:true mentiroso)', async () => {
    const m = makeDeps();
    m.ops.set('op-2026-0001-abc', donePrevio({ customerId: '595990000000' }));
    try {
      await sendConversationAttachment(input(), SELLER, m.deps);
      expect.unreachable('debió rechazar');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpsError);
      expect((e as HttpsError).code).toBe('invalid-argument');
      expect(((e as HttpsError).details as { kind?: string })?.kind).toBe('operation_mismatch');
    }
    expect(m.sendImage).not.toHaveBeenCalled();
    expect(m.append).not.toHaveBeenCalled();
  });

  it('reserva done de OTRO kind ⇒ invalid-argument (mismo guard, otro eje)', async () => {
    const m = makeDeps();
    m.ops.set('op-2026-0001-abc', donePrevio({ kind: 'document' }));
    await expect(sendConversationAttachment(input(), SELLER, m.deps)).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(m.sendImage).not.toHaveBeenCalled();
  });

  it('reserva coherente sigue devolviendo el resultado previo (la idempotencia no se rompe)', async () => {
    const m = makeDeps();
    m.ops.set('op-2026-0001-abc', donePrevio());
    const r = await sendConversationAttachment(input(), SELLER, m.deps);
    expect(r).toMatchObject({ ok: true, waMessageId: 'wamid.PREV', attachmentId: 'att_0123456789abcdef01234567', duplicate: true });
    expect(m.sendImage).not.toHaveBeenCalled();
  });
});

describe('desenlaces del envío', () => {
  it('mock: NO se sube a Meta, viaMock true y la burbuja queda marcada', async () => {
    const m = makeDeps({ transport: 'mock' });
    m.sendImage.mockResolvedValueOnce({ ok: true, outcome: 'mock', viaMock: true, id: 'mock-abc' } as never);
    const r = await sendConversationAttachment(input(), SELLER, m.deps);
    expect(r.viaMock).toBe(true);
    expect(m.uploadMedia).not.toHaveBeenCalled();
    expect(m.append).toHaveBeenCalledWith('arfagi', TEL, expect.objectContaining({ viaMock: true }));
    expect(m.ops.get('op-2026-0001-abc')!.state).toBe('done');
  });

  it('canal BLOQUEADO ⇒ compensación (op liberado + adjunto marcado) y error accionable; sin burbuja', async () => {
    const m = makeDeps({ transport: 'mock' });
    m.sendImage.mockResolvedValueOnce({ ok: false, outcome: 'blocked', reason: 'automation_shadow' } as never);
    try {
      await sendConversationAttachment(input(), SELLER, m.deps);
      expect.unreachable('debió fallar');
    } catch (e) {
      expect(((e as HttpsError).details as { kind?: string })?.kind).toBe('whatsapp_channel_blocked');
    }
    expect(m.append).not.toHaveBeenCalled();
    expect(m.releaseOperation).toHaveBeenCalled();
    expect(m.markAttachmentSendError).toHaveBeenCalled();
    expect(m.ops.has('op-2026-0001-abc')).toBe(false); // reintento posible
  });

  it('rechazo CONFIRMADO de Meta ⇒ sin burbuja, reserva liberada y reintento posible', async () => {
    const m = makeDeps();
    m.sendImage.mockResolvedValueOnce({ ok: false, outcome: 'rejected', providerCode: 131047 } as never);
    await expect(sendConversationAttachment(input(), SELLER, m.deps)).rejects.toMatchObject({ code: 'unavailable' });
    expect(m.append).not.toHaveBeenCalled();
    expect(m.ops.has('op-2026-0001-abc')).toBe(false);

    // Reintento del MISMO operationId: la reserva se re-crea y esta vez sale.
    const r = await sendConversationAttachment(input(), SELLER, m.deps);
    expect(r.ok).toBe(true);
    expect(m.append).toHaveBeenCalledTimes(1);
  });

  it('resultado DESCONOCIDO ⇒ sin burbuja, la reserva queda en unknown y el MISMO op NO se reintenta a ciegas', async () => {
    const m = makeDeps();
    m.sendImage.mockResolvedValueOnce({ ok: false, outcome: 'unknown' } as never);
    try {
      await sendConversationAttachment(input(), SELLER, m.deps);
      expect.unreachable('debió fallar');
    } catch (e) {
      expect(((e as HttpsError).details as { kind?: string })?.kind).toBe('whatsapp_send_unknown');
    }
    expect(m.append).not.toHaveBeenCalled();
    expect(m.ops.get('op-2026-0001-abc')!.state).toBe('unknown');

    // El mismo operationId no vuelve a enviar: rebota con un error honesto.
    try {
      await sendConversationAttachment(input(), SELLER, m.deps);
      expect.unreachable('debió rechazar el reintento ciego');
    } catch (e) {
      expect(((e as HttpsError).details as { kind?: string })?.kind).toBe('operation_unknown_outcome');
    }
    expect(m.sendImage).toHaveBeenCalledTimes(1);
  });

  it('falla de SUBIDA a Meta (nunca llegó al cliente) ⇒ compensación completa y reintento seguro', async () => {
    const m = makeDeps();
    m.uploadMedia.mockResolvedValueOnce({ ok: false, outcome: 'unknown', detail: 'subida status 503' } as never);
    await expect(sendConversationAttachment(input(), SELLER, m.deps)).rejects.toMatchObject({ code: 'unavailable' });
    expect(m.sendImage).not.toHaveBeenCalled();
    expect(m.append).not.toHaveBeenCalled();
    expect(m.ops.has('op-2026-0001-abc')).toBe(false);
  });

  it('los logs jamás llevan el teléfono ni el PNID completos', async () => {
    const m = makeDeps();
    await sendConversationAttachment(input(), SELLER, m.deps);
    const todo = JSON.stringify([vi.mocked(logger.info).mock.calls, vi.mocked(logger.warn).mock.calls, vi.mocked(logger.error).mock.calls]);
    expect(todo).not.toContain(TEL);
    expect(todo).not.toContain(PNID);
  });
});
