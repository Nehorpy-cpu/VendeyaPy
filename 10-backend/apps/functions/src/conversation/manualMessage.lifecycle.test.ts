import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpsError } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import type { Customer } from '@vpw/shared';

/**
 * ADR-0021 §3 × §5 — CICLO DE VIDA EN EL GUARD COMPARTIDO DEL ENVÍO MANUAL.
 * ==========================================================================
 * Lo que este archivo fija:
 *  1. softDeleted === true ⇒ failed-precondition `conversation_deleted` SIN enviar ni persistir,
 *     para texto Y adjuntos (los dos pasan por `resolverEnvioManual` — un solo camino).
 *  2. archived === true ⇒ el envío PROCEDE y la conversación se DESARCHIVA (coherente con el
 *     desarchivado por mensaje entrante ya vigente en messages.ts).
 *  3. El desarchivado solo ocurre si el envío quedó AUTORIZADO: un rechazo previo del guard
 *     (canal no soportado, takeover faltante) NO desarchiva.
 *  4. Fixtures sin flags ⇒ comportamiento idéntico al vigente (suites previas siguen verdes).
 */

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// El default de `desarchivarConversacion` escribe vía lib/firebase: se dobla ese módulo SOLO para
// el test del default (los demás inyectan deps y no tocan Firestore).
const setMock = vi.fn(async () => {});
vi.mock('../lib/firebase.js', () => ({
  db: () => ({ doc: () => ({ set: setMock }) }),
  paths: {
    customer: (t: string, c: string) => `tenants/${t}/customers/${c}`,
    session: (t: string, c: string, k: string) => `tenants/${t}/customers/${c}/sessions/${k}`,
    messages: (t: string, c: string) => `tenants/${t}/customers/${c}/messages`,
  },
  storage: () => ({ bucket: () => ({ file: () => ({ save: vi.fn() }) }) }),
}));

import {
  sendManualMessage,
  defaultManualMessageDeps,
  type ManualMessageDeps,
  type ManualGateContext,
} from './manualMessage.js';
import { sendConversationAttachment, type SendAttachmentDeps } from './sendAttachment.js';

const PNID = '1251346811387904';
const TEL = '595994893000';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

const customer = (conv: Record<string, unknown> = {}): Customer =>
  ({
    id: TEL,
    tenantId: 'arfagi',
    whatsappPhone: TEL,
    conversation: { humanTakeover: true, receivedVia: PNID, ...conv },
  }) as unknown as Customer;

const gateCtx = (over: Partial<ManualGateContext> = {}): ManualGateContext => ({
  humanTakeover: true,
  coveragePointer: null,
  activation: null,
  shippingQuote: null,
  resumeDone: null,
  ...over,
});

function makeDeps(conv: Record<string, unknown> = {}, over: Partial<ManualMessageDeps> = {}) {
  const sendText = vi.fn(async () => ({ ok: true as const, outcome: 'accepted' as const, id: 'wamid.M1', viaMock: false as const }));
  const append = vi.fn(async () => ({}) as never);
  const desarchivar = vi.fn(async () => {});
  const deps: ManualMessageDeps = {
    getCustomer: async () => customer(conv),
    getGateContext: async () => gateCtx(),
    resolverCanal: async () => 'active',
    getClient: (async () => ({ sendText })) as unknown as ManualMessageDeps['getClient'],
    append: append as unknown as ManualMessageDeps['append'],
    desarchivarConversacion: desarchivar,
    ...over,
  };
  return { deps, sendText, append, desarchivar };
}

const SELLER = { uid: 'u-seller', role: 'SELLER', name: 'Vendedora' };

const kindOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
    return undefined;
  } catch (e) {
    return ((e as HttpsError).details as { kind?: string } | undefined)?.kind;
  }
};

beforeEach(() => vi.clearAllMocks());

describe('softDeleted bloquea el envío manual (texto y adjunto)', () => {
  it('texto: failed-precondition conversation_deleted, sin enviar ni persistir', async () => {
    const { deps, sendText, append, desarchivar } = makeDeps({ softDeleted: true });
    expect(await kindOf(sendManualMessage({ tenantId: 'arfagi', customerId: TEL, text: 'hola' }, SELLER, deps))).toBe('conversation_deleted');
    expect(sendText).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(desarchivar).not.toHaveBeenCalled();
  });

  it('softDeleted manda incluso si además está archivada (no se desarchiva nada)', async () => {
    const { deps, desarchivar } = makeDeps({ softDeleted: true, archived: true });
    expect(await kindOf(sendManualMessage({ tenantId: 'arfagi', customerId: TEL, text: 'hola' }, SELLER, deps))).toBe('conversation_deleted');
    expect(desarchivar).not.toHaveBeenCalled();
  });

  it('adjunto: el MISMO guard rechaza antes de reservar/subir/enviar', async () => {
    const { deps: guardDeps } = makeDeps({ softDeleted: true });
    const reserveOperation = vi.fn();
    const deps = {
      guard: guardDeps,
      reserveOperation,
      updateOperation: vi.fn(),
      releaseOperation: vi.fn(),
      saveBytes: vi.fn(),
      writeAttachmentDoc: vi.fn(),
      markAttachmentSendError: vi.fn(),
      uploadMedia: vi.fn(),
      append: vi.fn(),
      now: () => Timestamp.fromMillis(1_000_000),
    } as unknown as SendAttachmentDeps;
    const kind = await kindOf(
      sendConversationAttachment(
        {
          tenantId: 'arfagi',
          customerId: TEL,
          operationId: 'op-2026-0001-abc',
          kind: 'image',
          filename: 'foto.jpg',
          mimeType: 'image/jpeg',
          dataBase64: JPEG.toString('base64'),
        },
        SELLER,
        deps,
      ),
    );
    expect(kind).toBe('conversation_deleted');
    expect(reserveOperation).not.toHaveBeenCalled();
  });
});

describe('archived: el envío manual PROCEDE y desarchiva', () => {
  it('archived === true ⇒ envía Y llama a desarchivar con tenant/cliente', async () => {
    const { deps, sendText, append, desarchivar } = makeDeps({ archived: true });
    const r = await sendManualMessage({ tenantId: 'arfagi', customerId: TEL, text: 'hola' }, SELLER, deps);
    expect(r.ok).toBe(true);
    expect(sendText).toHaveBeenCalled();
    expect(append).toHaveBeenCalled();
    expect(desarchivar).toHaveBeenCalledWith('arfagi', TEL);
  });

  it('sin flags de ciclo de vida ⇒ NO se llama a desarchivar (fixtures viejas intactas)', async () => {
    const { deps, desarchivar } = makeDeps();
    await sendManualMessage({ tenantId: 'arfagi', customerId: TEL, text: 'hola' }, SELLER, deps);
    expect(desarchivar).not.toHaveBeenCalled();
  });

  it('un rechazo del guard (SELLER sin takeover) NO desarchiva', async () => {
    const { deps, desarchivar } = makeDeps(
      { archived: true, humanTakeover: false },
      { getGateContext: async () => gateCtx({ humanTakeover: false }) },
    );
    await expect(sendManualMessage({ tenantId: 'arfagi', customerId: TEL, text: 'hola' }, SELLER, deps)).rejects.toThrow(HttpsError);
    expect(desarchivar).not.toHaveBeenCalled();
  });

  it('conversación de otra plataforma (canal no soportado) NO desarchiva', async () => {
    const { deps, desarchivar } = makeDeps({ archived: true, channel: 'instagram' });
    expect(await kindOf(sendManualMessage({ tenantId: 'arfagi', customerId: TEL, text: 'hola' }, SELLER, deps))).toBe('channel_send_unsupported');
    expect(desarchivar).not.toHaveBeenCalled();
  });

  it('el default de desarchivarConversacion limpia archived/archivedAt/archivedBy con merge', async () => {
    await defaultManualMessageDeps.desarchivarConversacion!('arfagi', TEL);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversation: { archived: false, archivedAt: null, archivedBy: null } }),
      { merge: true },
    );
  });
});
