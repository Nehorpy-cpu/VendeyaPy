import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * CORRECTIVO ADR-0017 — EL PANEL NO PUEDE RESOLVER `active` PARA UNA CONVERSACIÓN DE OTRA PLATAFORMA.
 * ==================================================================================================
 * Instagram y Messenger dejaron de compartir el canal mutable `active`: el motor les escribe en
 * `ig` / `msgr` (claves de `sessionKeyDePlataforma`). Pero el panel resolvía el canal SOLO por
 * `conversation.receivedVia` — un campo que únicamente WhatsApp escribe. Para una conversación de
 * Instagram, `receivedVia` es null ⇒ el panel caía al fallback legacy `active`: tomar ese chat
 * silenciaba al bot en el canal del número de WhatsApp que vende, y NO en el de Instagram.
 *
 * La regla del correctivo es literal: «ningún canal mutable compartido por plataformas distintas».
 * El resumen del cliente ahora registra también `conversation.channel`, y el panel resuelve por
 * plataforma ANTES de mirar `receivedVia`.
 */
vi.mock('../meta/automationMode.js', () => ({ resolveAutomationMode: vi.fn() }));

const docs = new Map<string, Record<string, unknown>>();
vi.mock('../lib/firebase.js', () => ({
  db: () => ({ doc: (path: string) => ({ path, get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }) }) }),
  paths: { customer: (t: string, c: string) => `tenants/${t}/customers/${c}` },
}));

import { resolveAutomationMode } from '../meta/automationMode.js';
import { resolverCanalDeConversacion } from './canal.js';

const TENANT = 't1';
const CLIENTE = 'ig_9988776655';
const RESUMEN = `tenants/${TENANT}/customers/${CLIENTE}`;
const resolver = vi.mocked(resolveAutomationMode);

beforeEach(() => {
  vi.clearAllMocks();
  docs.clear();
});

describe('resolverCanalDeConversacion — la plataforma decide antes que el número receptor', () => {
  it('una conversación de INSTAGRAM resuelve `ig`, jamás `active`', async () => {
    docs.set(RESUMEN, { conversation: { channel: 'instagram', receivedVia: null } });

    await expect(resolverCanalDeConversacion(TENANT, CLIENTE)).resolves.toBe('ig');
    // Y no consulta la autoridad de WhatsApp: no hay PNID que autorizar en Instagram.
    expect(resolver).not.toHaveBeenCalled();
  });

  it('una conversación de MESSENGER resuelve `msgr`', async () => {
    docs.set(RESUMEN, { conversation: { channel: 'messenger' } });

    await expect(resolverCanalDeConversacion(TENANT, CLIENTE)).resolves.toBe('msgr');
  });

  it('CERO REGRESIÓN: whatsapp con `receivedVia` sigue preguntándole a la autoridad', async () => {
    resolver.mockResolvedValue({ mode: 'live', sessionKey: 'active', origen: 'asset' } as never);
    docs.set(RESUMEN, { conversation: { channel: 'whatsapp', receivedVia: '111222333' } });

    await expect(resolverCanalDeConversacion(TENANT, CLIENTE)).resolves.toBe('active');
    expect(resolver).toHaveBeenCalledWith(TENANT, '111222333');
  });

  it('CERO REGRESIÓN: resumen sin `channel` (conversación anterior a este cambio) conserva el camino por `receivedVia`', async () => {
    resolver.mockResolvedValue({ mode: 'shadow', sessionKey: 'wa_444555666', origen: 'asset' } as never);
    docs.set(RESUMEN, { conversation: { receivedVia: '444555666' } });

    await expect(resolverCanalDeConversacion(TENANT, CLIENTE)).resolves.toBe('wa_444555666');
  });

  it('CERO REGRESIÓN: sin `channel` y sin `receivedVia` → fallback legacy explícito', async () => {
    docs.set(RESUMEN, { conversation: {} });

    await expect(resolverCanalDeConversacion(TENANT, CLIENTE)).resolves.toBe('active');
  });
});
