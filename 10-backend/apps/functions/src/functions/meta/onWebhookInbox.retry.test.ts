import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0017 §1 — EL REINTENTO DEL WEBHOOK TIENE QUE EXISTIR EN LA DECLARACIÓN DE LA FUNCIÓN.
 * =========================================================================================
 * `process.ts` devuelve el evento a la cola cuando no puede resolver el permiso del número. Eso
 * solo sirve si la plataforma vuelve a entregarlo, y para eso hacen falta las dos mitades:
 *
 *   1. el handler tiene que FALLAR (si traga la excepción, la corrida es exitosa y no hay nada
 *      que reintentar), y
 *   2. el trigger tiene que estar declarado con `retry` (sin eso, una corrida fallida se descarta).
 *
 * La segunda mitad no se ve en ningún test de comportamiento: viaja en el despliegue. Se ata acá,
 * igual que el timeout y la memoria, para que nadie la pueda sacar sin ponerse en rojo.
 *
 * Y una sola excepción escapa: la TIPADA. Cualquier otro error se sigue tragando exactamente como
 * antes, así que habilitar `retry` no le cambia el comportamiento a ningún otro camino.
 */

vi.mock('../../lib/firebase.js', () => ({ db: () => ({}), storage: () => ({}), paths: {} }));

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../lib/logger.js', () => ({ logger }));

/** Doble del error tipado de `process.ts`: acá lo que se prueba es qué hace el trigger con él. */
const { ReintentoFalso, processWebhookEvent } = vi.hoisted(() => {
  class ReintentoFalso extends Error {}
  return { ReintentoFalso, processWebhookEvent: vi.fn(async () => undefined as void) };
});
vi.mock('../../meta/process.js', () => ({
  processWebhookEvent: (...a: unknown[]) => processWebhookEvent(...(a as [])),
  esReintentoDeWebhook: (e: unknown) => e instanceof ReintentoFalso,
}));

import { onWebhookInbox } from './onWebhookInbox.js';

/** Config REAL con la que se desplegaría (lo que firebase-functions arma para el endpoint). */
const endpoint = (onWebhookInbox as unknown as { __endpoint: { eventTrigger?: Record<string, unknown> } }).__endpoint;
/** El handler crudo, tal como lo invoca la plataforma en cada entrega. */
const correr = (eventId: string) =>
  (onWebhookInbox as unknown as { run: (e: { params: { eventId: string } }) => Promise<void> }).run({ params: { eventId } });

beforeEach(() => {
  processWebhookEvent.mockReset();
  processWebhookEvent.mockResolvedValue(undefined);
  logger.error.mockClear();
  logger.warn.mockClear();
});

describe('onWebhookInbox — la reentrega del evento existe de verdad', () => {
  it('el trigger se despliega CON reintentos: sin esto, una corrida fallida se descarta', () => {
    expect(endpoint.eventTrigger?.['retry']).toBe(true);
  });

  it('el pedido de reentrega SALE del handler (tragarlo dejaba la corrida exitosa)', async () => {
    processWebhookEvent.mockRejectedValue(new ReintentoFalso('permiso indeterminado'));
    await expect(correr('ev_1')).rejects.toBeInstanceOf(ReintentoFalso);
  });

  it('cualquier OTRO error se sigue tragando: `retry` no le cambia el camino a nadie más', async () => {
    processWebhookEvent.mockRejectedValue(new Error('cualquier otra cosa'));
    await expect(correr('ev_2')).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  it('el camino normal sigue siendo silencioso', async () => {
    await expect(correr('ev_3')).resolves.toBeUndefined();
    expect(processWebhookEvent).toHaveBeenCalledWith('ev_3');
    expect(logger.error).not.toHaveBeenCalled();
  });
});
