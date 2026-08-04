import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Customer } from '@vpw/shared';
import { sendManualMessage, type ManualMessageDeps, type ManualGateContext } from './manualMessage.js';

/**
 * ADR-0017 §2 — EL MENSAJE MANUAL SE GATEA CONTRA LA CONVERSACIÓN QUE EL VENDEDOR ESTÁ MIRANDO.
 * ==============================================================================================
 * `sendManualMessage` ya elige el número de SALIDA por `conversation.receivedVia`, pero el gate
 * (¿hay takeover?, ¿hay cobertura en revisión?) lo leía de `sessions/active`. Con dos números eso
 * da los dos errores posibles, y ninguno es benigno:
 *
 *  · el vendedor tomó el chat del número NUEVO y el gate mira el heredado: le rebota su propio
 *    mensaje con «tocá Tomar conversación» sobre un chat que ya tomó;
 *  · o al revés: el chat heredado está tomado y el gate lo da por bueno para escribirle al
 *    cliente por el número nuevo, salteando el gate de cotización de envío.
 *
 * El canal se resuelve con la MISMA autoridad que el resto (`resolverCanalDePnid`), nunca
 * derivando `wa_{pnid}` a mano.
 */
const PNID_NUEVO = '444555666';

const customer = (over: Record<string, unknown> = {}): Customer =>
  ({
    id: '595994893000',
    tenantId: 't1',
    whatsappPhone: '595994893000',
    conversation: { humanTakeover: true, receivedVia: PNID_NUEVO },
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

function makeDeps(over: Partial<ManualMessageDeps> = {}) {
  const sendText = vi.fn(async () => ({ ok: true as const, outcome: 'accepted' as const, id: 'wamid.M1', viaMock: false as const }));
  const getGateContext = vi.fn(async () => gateCtx());
  const deps: ManualMessageDeps = {
    getCustomer: async () => customer(),
    getGateContext: getGateContext as unknown as ManualMessageDeps['getGateContext'],
    resolverCanal: vi.fn(async () => 'wa_444555666'),
    getClient: (async () => ({ sendText })) as unknown as ManualMessageDeps['getClient'],
    append: (async () => ({}) as never) as unknown as ManualMessageDeps['append'],
    ...over,
  };
  return { deps, getGateContext, sendText };
}

const SELLER = { uid: 'u1', role: 'SELLER', name: 'Vendedora' };

beforeEach(() => vi.clearAllMocks());

describe('mensaje manual — el gate mira la sesión del canal de la conversación', () => {
  it('el contexto del gate se pide para el canal resuelto del `receivedVia`, no para `active`', async () => {
    const { deps, getGateContext } = makeDeps();

    await sendManualMessage({ tenantId: 't1', customerId: '595994893000', text: 'Hola, ya te confirmo' }, SELLER, deps);

    expect(deps.resolverCanal).toHaveBeenCalledWith('t1', PNID_NUEVO);
    expect(getGateContext).toHaveBeenCalledWith('t1', '595994893000', 'wa_444555666');
  });

  it('conversación sin `receivedVia`: el canal heredado sigue siendo `active`', async () => {
    const { deps, getGateContext } = makeDeps({
      getCustomer: async () => customer({ conversation: { humanTakeover: true, receivedVia: null } }),
      resolverCanal: vi.fn(async () => 'active'),
    });

    await sendManualMessage({ tenantId: 't1', customerId: '595994893000', text: 'Hola' }, SELLER, deps);

    expect(getGateContext).toHaveBeenCalledWith('t1', '595994893000', 'active');
  });
});
