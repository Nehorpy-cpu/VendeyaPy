import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpsError } from 'firebase-functions/v2/https';
import type { Customer } from '@vpw/shared';

// Logger espiado: el rechazo tiene que quedar auditable SIN filtrar teléfono/PNID.
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { logger } from '../lib/logger.js';

import { sendManualMessage, type ManualMessageDeps, type ManualGateContext } from './manualMessage.js';

/**
 * H2 (Codex Security) / ADR-0017 §2 — EL TRANSPORTE TAMBIÉN ES POR CANAL, NO SOLO EL GATE.
 * =========================================================================================
 * El gate del mensaje manual ya mira la sesión del canal correcto (fix previo), pero el TRANSPORTE
 * seguía siendo `getWhatsAppClient` incondicional con `whatsappPhone`/`customerId` como destino:
 * un vendedor que respondía una conversación de INSTAGRAM filtraba el contenido a WhatsApp — a un
 * número que puede ser de OTRA persona.
 *
 * La regla que fija este archivo: dispatcher OBLIGATORIO por canal. No hay sender de IG/Messenger
 * implementado ⇒ para esas plataformas se RECHAZA fail-closed con un error honesto, sin burbuja
 * persistida y sin decirle «enviado» al vendedor. JAMÁS se reutiliza WhatsApp como fallback
 * silencioso. La decisión del canal sale de `canalDePlataformaNoWhatsapp` (canal.ts) — la MISMA
 * regla que ya usa el panel, no una copia.
 */

const TEL = '595994893000';
const PNID = '444555666';

const customer = (conversation: Record<string, unknown>): Customer =>
  ({
    id: TEL,
    tenantId: 'arfagi',
    // El cliente TAMBIÉN tiene un número de WhatsApp asociado (o el customerId lo parece): es
    // exactamente lo que hacía posible la fuga — el transporte viejo lo usaba como destino.
    whatsappPhone: TEL,
    conversation,
  }) as unknown as Customer;

const gateCtx = (): ManualGateContext => ({
  humanTakeover: true,
  coveragePointer: null,
  activation: null,
  shippingQuote: null,
  resumeDone: null,
});

function makeDeps(conversation: Record<string, unknown>, over: Partial<ManualMessageDeps> = {}) {
  const sendText = vi.fn(async () => ({ ok: true as const, outcome: 'accepted' as const, id: 'wamid.X1', viaMock: false as const }));
  const getClient = vi.fn(async () => ({ sendText }));
  const append = vi.fn(async () => ({}) as never);
  const deps: ManualMessageDeps = {
    getCustomer: async () => customer(conversation),
    getGateContext: async () => gateCtx(),
    resolverCanal: vi.fn(async () => 'active'),
    getClient: getClient as unknown as ManualMessageDeps['getClient'],
    append: append as unknown as ManualMessageDeps['append'],
    ...over,
  };
  return { deps, sendText, getClient, append };
}

const SELLER = { uid: 'u-seller', role: 'SELLER', name: 'Vendedora' };

beforeEach(() => vi.clearAllMocks());

describe('mensaje manual — dispatcher por canal (H2): IG/Messenger jamás salen por WhatsApp', () => {
  it('conversación de INSTAGRAM → rechaza fail-closed: cero WhatsApp, cero burbuja, cero «enviado»', async () => {
    const { deps, sendText, getClient, append } = makeDeps({ humanTakeover: true, channel: 'instagram', receivedVia: null });
    try {
      await sendManualMessage({ tenantId: 'arfagi', customerId: TEL, text: 'te paso el precio por acá' }, SELLER, deps);
      expect.unreachable('debió rechazar: no hay sender de Instagram');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpsError);
      const err = e as HttpsError;
      expect(err.code).toBe('failed-precondition');
      // Honesto: dice que NO se puede responder por el panel todavía y que NADA salió.
      expect(err.message).toMatch(/Instagram|Messenger/);
      expect(err.message).toMatch(/NO se envió/);
      expect((err.details as { kind?: string })?.kind).toBe('channel_send_unsupported');
    }
    // El corazón del defecto: el transporte de WhatsApp NUNCA se instancia ni se usa.
    expect(getClient).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    // Y no queda burbuja persistida mintiendo que se contestó.
    expect(append).not.toHaveBeenCalled();
  });

  it('conversación de MESSENGER → mismo rechazo fail-closed', async () => {
    const { deps, sendText, getClient, append } = makeDeps({ humanTakeover: true, channel: 'messenger' });
    await expect(
      sendManualMessage({ tenantId: 'arfagi', customerId: TEL, text: 'hola' }, SELLER, deps),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(getClient).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('el rechazo NO depende del rol: tampoco OWNER/ADMIN pueden mandar por un sender inexistente', async () => {
    for (const role of ['TENANT_OWNER', 'TENANT_MANAGER', 'PLATFORM_ADMIN']) {
      const { deps, getClient, append } = makeDeps({ humanTakeover: true, channel: 'instagram' });
      await expect(
        sendManualMessage({ tenantId: 'arfagi', customerId: TEL, text: 'hola' }, { uid: 'u', role }, deps),
      ).rejects.toMatchObject({ code: 'failed-precondition' });
      expect(getClient).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
    }
  });

  it('el log del rechazo nombra la plataforma pero jamás el teléfono', async () => {
    const { deps } = makeDeps({ humanTakeover: true, channel: 'instagram' });
    await expect(sendManualMessage({ tenantId: 'arfagi', customerId: TEL, text: 'hola' }, SELLER, deps)).rejects.toThrow();
    const warns = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(warns).toContain('instagram');
    expect(warns).not.toContain(TEL);
  });

  it('CERO REGRESIÓN: WhatsApp explícito con `receivedVia` sigue saliendo por su número', async () => {
    const { deps, sendText, getClient, append } = makeDeps(
      { humanTakeover: true, channel: 'whatsapp', receivedVia: PNID },
      { resolverCanal: vi.fn(async () => `wa_${PNID}`) },
    );
    const r = await sendManualMessage({ tenantId: 'arfagi', customerId: TEL, text: 'hola' }, SELLER, deps);
    expect(r.ok).toBe(true);
    expect(getClient).toHaveBeenCalledWith('arfagi', PNID);
    expect(sendText).toHaveBeenCalledWith(TEL, 'hola', { tenantId: 'arfagi', channel: 'whatsapp' });
    expect(append).toHaveBeenCalledWith('arfagi', TEL, expect.objectContaining({ channel: 'whatsapp', receivedVia: PNID }));
  });

  it('CERO REGRESIÓN: resumen viejo SIN `channel` y sin `receivedVia` conserva el camino legacy de WhatsApp', async () => {
    const { deps, getClient, append } = makeDeps({ humanTakeover: true });
    const r = await sendManualMessage({ tenantId: 'arfagi', customerId: TEL, text: 'hola' }, SELLER, deps);
    expect(r.ok).toBe(true);
    // Sin receivedVia el cliente resuelve el número principal del tenant (comportamiento actual).
    expect(getClient).toHaveBeenCalledWith('arfagi', null);
    expect(append).toHaveBeenCalled();
  });
});
