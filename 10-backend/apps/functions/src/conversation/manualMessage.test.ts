import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpsError } from 'firebase-functions/v2/https';
import type { Customer } from '@vpw/shared';

// HUMAN-HANDOFF-1 requisito "no llama IA": si alguien cablea la IA acá, este mock lo delata.
vi.mock('../ai/salesAgent.js', () => ({ runSalesAgent: vi.fn() }));
import { runSalesAgent } from '../ai/salesAgent.js';
// SHIPPING-CHAT-3B: logger espiado para verificar el ENMASCARADO de teléfonos en logs.
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { logger } from '../lib/logger.js';

import {
  sendManualMessage,
  MANUAL_MESSAGE_MAX_CHARS,
  type ManualMessageDeps,
  type ManualGateContext,
} from './manualMessage.js';
import { MENSAJE_MAS_INFORMACION } from '../functions/coverage/coverageCallables.js';
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

/** Contexto del gate por defecto: handoff activo, SIN cobertura (comportamiento pre-3B). */
const gateCtx = (over: Partial<ManualGateContext> = {}): ManualGateContext => ({
  humanTakeover: true,
  coveragePointer: null,
  activation: null,
  shippingQuote: null,
  resumeDone: null,
  ...over,
});

/** Contexto con cobertura ACTIVA en revisión + cotización obligatoria (max ₲5.000.000). */
const gateCoverage = (over: Partial<ManualGateContext> = {}): ManualGateContext =>
  gateCtx({
    coveragePointer: { requestId: 'covr_abc123DEF456', status: 'pending_coverage_review' },
    activation: { enabled: true, activationId: 'act-test-000001' },
    shippingQuote: { status: 'required', maxChargeGs: 5_000_000 },
    ...over,
  });

function makeDeps(over: Partial<ManualMessageDeps> = {}) {
  const sendText = vi.fn(async () => ({ ok: true as const, outcome: 'accepted' as const, id: 'wamid.MANUAL-1', viaMock: false as const }));
  const append = vi.fn(async () => ({}) as never);
  const getClient = vi.fn(async () => ({ sendText }));
  const deps: ManualMessageDeps = {
    getCustomer: async () => customer(),
    getGateContext: async () => gateCtx(), // sesión con handoff activo (default de los tests)
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
      getGateContext: async () => gateCtx({ humanTakeover: false }),
      getCustomer: async () => customer({ conversation: { humanTakeover: false, receivedVia: PNID } }),
    });
    await expect(sendManualMessage({ tenantId: 'arfagi', customerId: 'c', text: 'hola' }, SELLER, deps)).rejects.toThrow(/Tomar conversación/);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('7b. OWNER/MANAGER/ADMIN pueden escribir sin handoff (override manual)', async () => {
    for (const role of ['TENANT_OWNER', 'TENANT_MANAGER', 'PLATFORM_ADMIN']) {
      const { deps, append } = makeDeps({
        getGateContext: async () => gateCtx({ humanTakeover: false }),
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
      getGateContext: async () => gateCtx({ humanTakeover: true }), // sesión: handoff activo (fuente de verdad)
      getCustomer: async () => customer({ conversation: { humanTakeover: false, receivedVia: PNID } }), // resumen viejo
    });
    const r = await sendManualMessage({ tenantId: 'arfagi', customerId: 'c', text: 'hola' }, SELLER, deps);
    expect(r.ok).toBe(true);
    expect(append).toHaveBeenCalled();
  });

  it('7d. sin sesión (conversación vieja) → decide el resumen del customer', async () => {
    const { deps } = makeDeps({
      getGateContext: async () => gateCtx({ humanTakeover: null }),
      getCustomer: async () => customer({ conversation: { humanTakeover: false, receivedVia: PNID } }),
    });
    await expect(sendManualMessage({ tenantId: 'arfagi', customerId: 'c', text: 'hola' }, SELLER, deps)).rejects.toThrow(/Tomar conversación/);
  });

  it('8. conversación inexistente → not-found', async () => {
    const { deps } = makeDeps({ getCustomer: async () => null });
    await expect(sendManualMessage({ tenantId: 'arfagi', customerId: 'nadie', text: 'hola' }, SELLER, deps)).rejects.toThrow(/no existe/);
  });

  it('9. RECHAZO CONFIRMADO de Meta → unavailable kind whatsapp_send_rejected y NADA se persiste', async () => {
    const sendText = vi.fn(async () => ({ ok: false as const, outcome: 'rejected' as const, providerCode: 131047 }));
    const { deps, append } = makeDeps({ getClient: async () => ({ sendText }) as never });
    try {
      await sendManualMessage({ tenantId: 'arfagi', customerId: '595994893000', text: 'hola' }, SELLER, deps);
      expect.unreachable('debió fallar');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpsError);
      expect((e as HttpsError).message).toMatch(/no aceptó/);
      expect(((e as HttpsError).details as { kind?: string })?.kind).toBe('whatsapp_send_rejected');
    }
    expect(append).not.toHaveBeenCalled();
    // El log dice rechazo CONFIRMADO, con teléfono enmascarado.
    const warns = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(warns).toContain('confirmado');
    expect(warns).not.toContain('595994893000');
  });

  it('9b. resultado DESCONOCIDO → kind whatsapp_send_unknown, mensaje honesto SIN afirmar rechazo ni sugerir reenvío ciego; nada se persiste', async () => {
    const sendText = vi.fn(async () => ({ ok: false as const, outcome: 'unknown' as const }));
    const { deps, append } = makeDeps({ getClient: async () => ({ sendText }) as never });
    try {
      await sendManualMessage({ tenantId: 'arfagi', customerId: '595994893000', text: 'hola' }, SELLER, deps);
      expect.unreachable('debió fallar');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpsError);
      const msg = (e as HttpsError).message;
      expect(msg).toBe('No pudimos confirmar si el mensaje salió. Revisá el chat de WhatsApp antes de reenviarlo.');
      expect(msg).not.toMatch(/rechaz|no aceptó/i); // jamás afirmar rechazo
      expect(msg).not.toMatch(/probá de nuevo/i); // jamás sugerir reintento ciego
      expect(((e as HttpsError).details as { kind?: string })?.kind).toBe('whatsapp_send_unknown');
    }
    expect(append).not.toHaveBeenCalled();
    // El log dice "desconocido" (jamás "rechazó") y no filtra texto/teléfono/PNID.
    const warns = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(warns).toContain('desconocido');
    expect(warns).not.toMatch(/rechaz/);
    expect(warns).not.toContain('595994893000');
    expect(warns).not.toContain('hola');
    expect(warns).not.toContain(PNID);
  });

  it('10. conversación vieja sin receivedVia → resuelve el número principal (pnid null)', async () => {
    const { deps, getClient } = makeDeps({ getCustomer: async () => customer({ conversation: { humanTakeover: true } }) });
    await sendManualMessage({ tenantId: 'arfagi', customerId: 'c', text: 'hola' }, SELLER, deps);
    expect(getClient).toHaveBeenCalledWith('arfagi', null);
  });

  it('11. LOGS: customerId (teléfono) y phoneNumberId (PNID) van ENMASCARADOS en el log de éxito', async () => {
    const { deps } = makeDeps();
    await sendManualMessage({ tenantId: 'arfagi', customerId: '595994893000', text: 'hola' }, SELLER, deps);
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      'Mensaje manual enviado',
      expect.objectContaining({ customerId: '…3000', phoneNumberId: '…7904' }),
    );
    // Jamás el teléfono ni el PNID completos en NINGÚN log de este camino.
    for (const call of vi.mocked(logger.info).mock.calls) {
      expect(JSON.stringify(call)).not.toContain('595994893000');
      expect(JSON.stringify(call)).not.toContain(PNID);
    }
  });
});

describe('SHIPPING-CHAT-3B — gate server-side del mensaje manual', () => {
  const COSTO = 'el costo de envío para tu ubicación es ₲30.000';

  it('G1. cobertura en revisión + policy required + texto con costo → failed-precondition kind shipping_quote_required; NADA se envía/persiste', async () => {
    const { deps, sendText, append, getClient } = makeDeps({ getGateContext: async () => gateCoverage() });
    try {
      await sendManualMessage({ tenantId: 'arfagi', customerId: 'c', text: COSTO }, SELLER, deps);
      expect.unreachable('debió bloquear');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpsError);
      expect((e as HttpsError).message).toMatch(/costo de envío/);
      expect(((e as HttpsError).details as { kind?: string })?.kind).toBe('shipping_quote_required');
    }
    expect(getClient).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('G2. el gate aplica a TODOS los roles por igual (incl. PLATFORM_ADMIN y OWNER)', async () => {
    for (const role of ['TENANT_OWNER', 'TENANT_MANAGER', 'PLATFORM_ADMIN']) {
      const { deps, sendText } = makeDeps({ getGateContext: async () => gateCoverage() });
      await expect(sendManualMessage({ tenantId: 'arfagi', customerId: 'c', text: COSTO }, { uid: 'u', role }, deps)).rejects.toThrow(/costo de envío/);
      expect(sendText).not.toHaveBeenCalled();
    }
  });

  it('G3. texto común sobre envío SIN importe → permitido (no sobre-bloquear)', async () => {
    const { deps, append } = makeDeps({ getGateContext: async () => gateCoverage() });
    const r = await sendManualMessage({ tenantId: 'arfagi', customerId: 'c', text: 'ya te confirmo el envío en un rato' }, SELLER, deps);
    expect(r.ok).toBe(true);
    expect(append).toHaveBeenCalled();
  });

  it('G4. MENSAJE_MAS_INFORMACION (coverageRequestInfo) pasa el gate (sin monto)', async () => {
    const { deps, append } = makeDeps({ getGateContext: async () => gateCoverage() });
    const r = await sendManualMessage({ tenantId: 'arfagi', customerId: 'c', text: MENSAJE_MAS_INFORMACION }, SELLER, deps);
    expect(r.ok).toBe(true);
    expect(append).toHaveBeenCalled();
  });

  it('G5. detección ENDURECIDA: monto en otra línea/cláusula también se bloquea', async () => {
    const { deps, sendText } = makeDeps({ getGateContext: async () => gateCoverage() });
    await expect(
      sendManualMessage({ tenantId: 'arfagi', customerId: 'c', text: 'el costo de envío es:\n₲25.000' }, SELLER, deps),
    ).rejects.toThrow(/costo de envío/);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('G6. policy INVALID → re-clasifica intención (bloquea costo, permite texto común)', async () => {
    const invalid = () => gateCoverage({ shippingQuote: { status: 'invalid' } });
    const bloqueado = makeDeps({ getGateContext: async () => invalid() });
    await expect(sendManualMessage({ tenantId: 'arfagi', customerId: 'c', text: COSTO }, SELLER, bloqueado.deps)).rejects.toThrow(/costo de envío/);
    const permitido = makeDeps({ getGateContext: async () => invalid() });
    const r = await sendManualMessage({ tenantId: 'arfagi', customerId: 'c', text: 'hola, ¿cómo estás?' }, SELLER, permitido.deps);
    expect(r.ok).toBe(true);
  });

  it('G7. awaiting_location también está gateado; approved con resume TERMINADO no', async () => {
    const awaiting = makeDeps({
      getGateContext: async () => gateCoverage({ coveragePointer: { requestId: 'covr_abc123DEF456', status: 'awaiting_location' } }),
    });
    await expect(sendManualMessage({ tenantId: 'arfagi', customerId: 'c', text: COSTO }, SELLER, awaiting.deps)).rejects.toThrow(/costo de envío/);
    const done = makeDeps({
      getGateContext: async () => gateCoverage({ coveragePointer: { requestId: 'covr_abc123DEF456', status: 'coverage_approved' }, resumeDone: true }),
    });
    const r = await sendManualMessage({ tenantId: 'arfagi', customerId: 'c', text: COSTO }, SELLER, done.deps);
    expect(r.ok).toBe(true); // reanudación terminada ⇒ chat normal
  });

  it('G8. approved con resume NO terminado → gateado (el canónico sigue en juego)', async () => {
    const { deps } = makeDeps({
      getGateContext: async () => gateCoverage({ coveragePointer: { requestId: 'covr_abc123DEF456', status: 'coverage_approved' }, resumeDone: false }),
    });
    await expect(sendManualMessage({ tenantId: 'arfagi', customerId: 'c', text: COSTO }, SELLER, deps)).rejects.toThrow(/costo de envío/);
  });

  it('G9. policy OFF o Coverage apagado o sin pointer → comportamiento actual (sin gate)', async () => {
    const casos: ManualGateContext[] = [
      gateCoverage({ shippingQuote: { status: 'off' } }),
      gateCoverage({ activation: { enabled: false, activationId: null } }),
      gateCtx(), // sin pointer de cobertura
    ];
    for (const g of casos) {
      const { deps, append } = makeDeps({ getGateContext: async () => g });
      const r = await sendManualMessage({ tenantId: 'arfagi', customerId: 'c', text: COSTO }, SELLER, deps);
      expect(r.ok).toBe(true);
      expect(append).toHaveBeenCalled();
    }
  });

  it('G10. el texto/monto bloqueado JAMÁS aparece en logs', async () => {
    const { deps } = makeDeps({ getGateContext: async () => gateCoverage() });
    await expect(sendManualMessage({ tenantId: 'arfagi', customerId: 'c', text: COSTO }, SELLER, deps)).rejects.toThrow();
    const todo = JSON.stringify([vi.mocked(logger.info).mock.calls, vi.mocked(logger.warn).mock.calls, vi.mocked(logger.error).mock.calls]);
    expect(todo).not.toContain('30.000');
    expect(todo).not.toContain(COSTO);
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
