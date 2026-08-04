import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0017 §2 — DE QUÉ CANAL ES ESTA CONVERSACIÓN, CUANDO NO HAY TURNO QUE LO DIGA.
 * =================================================================================
 * El webhook sabe el canal porque lo trae el evento. El panel, los callables y los jobs NO: solo
 * tienen tenant y cliente. Hasta acá resolvían el problema no resolviéndolo — escribían en
 * `sessions/active` y listo, que con dos números es «la conversación del que ya vende».
 *
 * La regla dura del programa: **jamás derivar con `whatsappSessionKey(pnid)` en un callsite
 * migrado**. Esa función devuelve `wa_{pnid}` SIEMPRE, así que aplicarla al número que hoy vende
 * mudaría de golpe todas sus conversaciones (carrito, takeover, checkout) a un documento vacío.
 * El canal se le PREGUNTA a la autoridad (`resolveAutomationMode`), que sabe que el número
 * heredado vive legítimamente en `active`.
 *
 * Y el fallback legacy es EXPLÍCITO, no un default silencioso: una conversación sin `receivedVia`
 * es anterior al multi-número y vive en `active`.
 */
vi.mock('../meta/automationMode.js', () => ({ resolveAutomationMode: vi.fn() }));

const docs = new Map<string, Record<string, unknown>>();
vi.mock('../lib/firebase.js', () => ({
  db: () => ({ doc: (path: string) => ({ path, get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }) }) }),
  paths: { customer: (t: string, c: string) => `tenants/${t}/customers/${c}` },
}));

import { resolveAutomationMode } from '../meta/automationMode.js';
import { CanalIndeterminadoError, resolverCanalDePnid, resolverCanalDeConversacion } from './canal.js';

const TENANT = 't1';
const CLIENTE = '595000001234';
const resolver = vi.mocked(resolveAutomationMode);

beforeEach(() => {
  vi.clearAllMocks();
  docs.clear();
});

describe('resolverCanalDePnid — la autoridad decide, nunca la derivación cruda', () => {
  it('el número HEREDADO sigue en `active` aunque su PNID derive `wa_…`', async () => {
    resolver.mockResolvedValue({ mode: 'live', sessionKey: 'active', origen: 'asset' } as never);

    await expect(resolverCanalDePnid(TENANT, '111222333')).resolves.toBe('active');
    expect(resolver).toHaveBeenCalledWith(TENANT, '111222333');
  });

  it('un número de Coexistence resuelve SU canal', async () => {
    resolver.mockResolvedValue({ mode: 'shadow', sessionKey: 'wa_444555666', origen: 'asset' } as never);

    await expect(resolverCanalDePnid(TENANT, '444555666')).resolves.toBe('wa_444555666');
  });

  it('sin `receivedVia` (conversación anterior al multi-número) el fallback legacy es EXPLÍCITO y no lee nada', async () => {
    await expect(resolverCanalDePnid(TENANT, null)).resolves.toBe('active');
    await expect(resolverCanalDePnid(TENANT, '   ')).resolves.toBe('active');
    expect(resolver).not.toHaveBeenCalled();
  });

  it('si la lectura del permiso se cae, NO se adivina el canal: se falla', async () => {
    resolver.mockResolvedValue({ mode: 'inactive', sessionKey: 'active', origen: 'error_lectura' } as never);

    // Caer a `active` acá sería tomar/liberar la conversación del número que está vendiendo.
    await expect(resolverCanalDePnid(TENANT, '444555666')).rejects.toBeInstanceOf(CanalIndeterminadoError);
  });
});

describe('resolverCanalDeConversacion — el canal sale del resumen del cliente', () => {
  it('usa `conversation.receivedVia` del resumen y lo pasa por la autoridad', async () => {
    docs.set(`tenants/${TENANT}/customers/${CLIENTE}`, { conversation: { receivedVia: '444555666' } });
    resolver.mockResolvedValue({ mode: 'live', sessionKey: 'wa_444555666', origen: 'asset' } as never);

    await expect(resolverCanalDeConversacion(TENANT, CLIENTE)).resolves.toBe('wa_444555666');
  });

  it('cliente sin resumen o sin `receivedVia` ⇒ canal heredado', async () => {
    await expect(resolverCanalDeConversacion(TENANT, CLIENTE)).resolves.toBe('active');
    docs.set(`tenants/${TENANT}/customers/${CLIENTE}`, { conversation: {} });
    await expect(resolverCanalDeConversacion(TENANT, CLIENTE)).resolves.toBe('active');
    expect(resolver).not.toHaveBeenCalled();
  });
});
