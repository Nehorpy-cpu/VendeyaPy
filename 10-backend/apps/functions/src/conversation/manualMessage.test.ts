import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpsError } from 'firebase-functions/v2/https';
import type { Customer } from '@vpw/shared';

// HUMAN-HANDOFF-1 requisito "no llama IA": si alguien cablea la IA acá, este mock lo delata.
vi.mock('../ai/salesAgent.js', () => ({ runSalesAgent: vi.fn() }));
import { runSalesAgent } from '../ai/salesAgent.js';

import {
  sendManualMessage,
  MANUAL_MESSAGE_MAX_CHARS,
  type ManualMessageDeps,
} from './manualMessage.js';
import { assertStaffAccess } from '../functions/conversation/staffAuth.js';

const PNID = '1251346811387904';

const customer = (over: Partial<Record<string, unknown>> = {}): Customer =>
  ({
    id: '595994893000',
    tenantId: 'arfagi',
    whatsappPhone: '595994893000',
    conversation: { humanTakeover: true, receivedVia: PNID, ...((over['conversation'] as object) ?? {}) },
    ...over,
  }) as unknown as Customer;

function makeDeps(over: Partial<ManualMessageDeps> = {}) {
  const sendText = vi.fn(async () => ({ ok: true as const, id: 'wamid.MANUAL-1' }));
  const append = vi.fn(async () => ({}) as never);
  const getClient = vi.fn(async () => ({ sendText }));
  const deps: ManualMessageDeps = {
    getCustomer: async () => customer(),
    getTakeover: async () => true, // sesión con handoff activo (default de los tests)
    getClient: getClient as unknown as ManualMessageDeps['getClient'],
    append: append as unknown as ManualMessageDeps['append'],
    ...over,
  };
  return { deps, sendText, append, getClient };
}

const SELLER = { uid: 'u-seller', role: 'SELLER', name: 'Vendedora' };

beforeEach(() => vi.clearAllMocks());

describe('conversation/manualMessage sendManualMessage', () => {
  it('1. seller con handoff activo → envía y persiste author seller con metadata completa', async () => {
    const { deps, sendText, append, getClient } = makeDeps();
    const r = await sendManualMessage({ tenantId: 'arfagi', customerId: '595994893000', text: '  Hola! Ya verifico tu pago 🙌  ' }, SELLER, deps);
    expect(r).toEqual({ ok: true, viaMock: false, waMessageId: 'wamid.MANUAL-1' });
    // 5. multi-número: el cliente de WhatsApp se resuelve con el MISMO pnid que recibió el chat.
    expect(getClient).toHaveBeenCalledWith('arfagi', PNID);
    expect(sendText).toHaveBeenCalledWith('595994893000', 'Hola! Ya verifico tu pago 🙌', { tenantId: 'arfagi', channel: 'whatsapp' });
    expect(append).toHaveBeenCalledWith('arfagi', '595994893000', expect.objectContaining({
      direction: 'out', author: 'seller', text: 'Hola! Ya verifico tu pago 🙌',
      receivedVia: PNID, senderUid: 'u-seller', senderName: 'Vendedora', waMessageId: 'wamid.MANUAL-1', viaMock: false,
    }));
  });

  it('2. texto vacío o solo espacios → invalid-argument, sin enviar ni persistir', async () => {
    const { deps, sendText, append } = makeDeps();
    await expect(sendManualMessage({ tenantId: 'arfagi', customerId: 'c', text: '   ' }, SELLER, deps)).rejects.toThrow(HttpsError);
    expect(sendText).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('3. texto más largo que el tope de la Cloud API → invalid-argument', async () => {
    const { deps } = makeDeps();
    const larguisimo = 'a'.repeat(MANUAL_MESSAGE_MAX_CHARS + 1);
    await expect(sendManualMessage({ tenantId: 'arfagi', customerId: 'c', text: larguisimo }, SELLER, deps)).rejects.toThrow(/largo/);
  });

  it('4. modo mock (viaMock) → NO llama a Meta pero el mensaje SÍ persiste, marcado', async () => {
    const sendText = vi.fn(async () => ({ ok: true as const, viaMock: true }));
    const { deps, append } = makeDeps({ getClient: async () => ({ sendText }) as never });
    const r = await sendManualMessage({ tenantId: 'arfagi', customerId: 'c', text: 'hola' }, SELLER, deps);
    expect(r.viaMock).toBe(true);
    expect(r.waMessageId).toBeNull();
    expect(append).toHaveBeenCalledWith('arfagi', 'c', expect.objectContaining({ viaMock: true, waMessageId: null }));
  });

  it('6. jamás llama a la IA', async () => {
    const { deps } = makeDeps();
    await sendManualMessage({ tenantId: 'arfagi', customerId: 'c', text: 'hola' }, SELLER, deps);
    expect(vi.mocked(runSalesAgent)).not.toHaveBeenCalled();
  });

  it('7a. SELLER sin handoff activo → failed-precondition (primero tiene que tomar el chat)', async () => {
    const { deps, sendText } = makeDeps({
      getTakeover: async () => false,
      getCustomer: async () => customer({ conversation: { humanTakeover: false, receivedVia: PNID } }),
    });
    await expect(sendManualMessage({ tenantId: 'arfagi', customerId: 'c', text: 'hola' }, SELLER, deps)).rejects.toThrow(/Tomar conversación/);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('7b. OWNER/MANAGER/ADMIN pueden escribir sin handoff (override manual)', async () => {
    for (const role of ['TENANT_OWNER', 'TENANT_MANAGER', 'PLATFORM_ADMIN']) {
      const { deps, append } = makeDeps({
        getTakeover: async () => false,
        getCustomer: async () => customer({ conversation: { humanTakeover: false, receivedVia: PNID } }),
      });
      const r = await sendManualMessage({ tenantId: 'arfagi', customerId: 'c', text: 'hola' }, { uid: 'u', role }, deps);
      expect(r.ok).toBe(true);
      expect(append).toHaveBeenCalled();
    }
  });

  it('7c. BUG REAL: la SESIÓN manda — resumen desfasado (false) pero sesión en handoff → el seller SÍ puede', async () => {
    // submitComprobante solo actualiza la sesión; el resumen queda viejo hasta el próximo append.
    const { deps, append } = makeDeps({
      getTakeover: async () => true, // sesión: handoff activo (fuente de verdad)
      getCustomer: async () => customer({ conversation: { humanTakeover: false, receivedVia: PNID } }), // resumen viejo
    });
    const r = await sendManualMessage({ tenantId: 'arfagi', customerId: 'c', text: 'hola' }, SELLER, deps);
    expect(r.ok).toBe(true);
    expect(append).toHaveBeenCalled();
  });

  it('7d. sin sesión (conversación vieja) → decide el resumen del customer', async () => {
    const { deps } = makeDeps({
      getTakeover: async () => null,
      getCustomer: async () => customer({ conversation: { humanTakeover: false, receivedVia: PNID } }),
    });
    await expect(sendManualMessage({ tenantId: 'arfagi', customerId: 'c', text: 'hola' }, SELLER, deps)).rejects.toThrow(/Tomar conversación/);
  });

  it('8. conversación inexistente → not-found', async () => {
    const { deps } = makeDeps({ getCustomer: async () => null });
    await expect(sendManualMessage({ tenantId: 'arfagi', customerId: 'nadie', text: 'hola' }, SELLER, deps)).rejects.toThrow(/no existe/);
  });

  it('9. Meta rechaza el envío (live) → unavailable y NADA se persiste (el historial no miente)', async () => {
    const sendText = vi.fn(async () => ({ ok: false as const, error: 'error 131047' }));
    const { deps, append } = makeDeps({ getClient: async () => ({ sendText }) as never });
    await expect(sendManualMessage({ tenantId: 'arfagi', customerId: 'c', text: 'hola' }, SELLER, deps)).rejects.toThrow(/no aceptó/);
    expect(append).not.toHaveBeenCalled();
  });

  it('10. conversación vieja sin receivedVia → resuelve el número principal (pnid null)', async () => {
    const { deps, getClient } = makeDeps({ getCustomer: async () => customer({ conversation: { humanTakeover: true } }) });
    await sendManualMessage({ tenantId: 'arfagi', customerId: 'c', text: 'hola' }, SELLER, deps);
    expect(getClient).toHaveBeenCalledWith('arfagi', null);
  });
});

describe('functions/conversation/staffAuth assertStaffAccess (autorización pura)', () => {
  const auth = (role: string, tenantId?: string) =>
    ({ uid: 'u1', token: { role, tenantId, name: 'Test' } });

  it('staff del tenant correcto pasa; devuelve actor con uid/rol/nombre', () => {
    const a = assertStaffAccess(auth('SELLER', 'arfagi'), 'arfagi');
    expect(a).toMatchObject({ uid: 'u1', role: 'SELLER', name: 'Test', isPlatformAdmin: false });
  });

  it('CROSS-TENANT: seller de otra empresa → permission-denied (nunca puede escribirle a clientes ajenos)', () => {
    expect(() => assertStaffAccess(auth('SELLER', 'boutique-demo'), 'arfagi')).toThrow(/No tenés acceso/);
    expect(() => assertStaffAccess(auth('TENANT_OWNER', 'boutique-demo'), 'arfagi')).toThrow(/No tenés acceso/);
  });

  it('PLATFORM_ADMIN entra a cualquier tenant; roles no-staff y anónimos no entran', () => {
    expect(assertStaffAccess(auth('PLATFORM_ADMIN'), 'arfagi').isPlatformAdmin).toBe(true);
    expect(() => assertStaffAccess(auth('VIEWER', 'arfagi'), 'arfagi')).toThrow(/rol/);
    expect(() => assertStaffAccess(null, 'arfagi')).toThrow(/sesión/);
  });
});
