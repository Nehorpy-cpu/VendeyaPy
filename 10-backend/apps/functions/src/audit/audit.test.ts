import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * audit.test.ts — el id determinístico opcional (H-05).
 *
 * `recordAudit` usaba SIEMPRE un id automático, así que repetir la misma acción duplicaba la
 * entrada — y eso volvía imposible reintentar un audit que no se había llegado a escribir. H-05
 * necesita reintentarlo: un pago confirmado sin auditoría es un pago que el sistema no puede
 * explicar después.
 *
 * Lo que se fija acá:
 *   - sin `id`, el comportamiento es EXACTAMENTE el de antes (los ~100 llamadores no cambian);
 *   - con `id`, la entrada es idempotente y la ORIGINAL manda: una repetición no puede
 *     reescribirle el `at`, que es justo el dato que el fix existe para proteger.
 */

const creados: Array<{ path: string; data: Record<string, unknown> }> = [];
const seteados: Array<{ path: string; data: Record<string, unknown> }> = [];
const existentes = new Set<string>();
let autoId = 0;
/** Simula un fallo de Firestore que NO es «ya existe» (permisos, red, etc.). */
let fallaDistinta = false;

const yaExiste = (path: string) =>
  Object.assign(new Error(`6 ALREADY_EXISTS: entity already exists: ${path}`), { code: 6 });

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    collection: (col: string) => ({
      doc: (id?: string) => {
        const realId = id ?? `auto_${++autoId}`;
        const path = `${col}/${realId}`;
        return {
          id: realId,
          path,
          create: async (d: Record<string, unknown>) => {
            if (fallaDistinta) throw Object.assign(new Error('7 PERMISSION_DENIED'), { code: 7 });
            if (existentes.has(path)) throw yaExiste(path);
            existentes.add(path);
            creados.push({ path, data: d });
          },
          set: async (d: Record<string, unknown>) => {
            existentes.add(path);
            seteados.push({ path, data: d });
          },
        };
      },
    }),
  }),
}));

import { recordAudit } from './audit.js';
import { logger } from '../lib/logger.js';

const TENANT = 't1';
const COL = `tenants/${TENANT}/auditLogs`;

beforeEach(() => {
  vi.clearAllMocks();
  creados.length = 0;
  seteados.length = 0;
  existentes.clear();
  autoId = 0;
  fallaDistinta = false; // si un test falla, el flag no se filtra al siguiente
});

describe('recordAudit · sin id (NO REGRESIÓN: los ~100 llamadores)', () => {
  it('usa id automático y escribe con set, como siempre', async () => {
    await recordAudit({ tenantId: TENANT, action: 'order.updated', summary: 'x' });

    expect(seteados).toHaveLength(1);
    expect(creados).toHaveLength(0);
    expect(seteados[0]!.path).toBe(`${COL}/auto_1`);
    expect(seteados[0]!.data.id).toBe('auto_1'); // el id del contenido = el del documento
  });

  it('dos llamadas iguales generan DOS entradas (el comportamiento de siempre)', async () => {
    await recordAudit({ tenantId: TENANT, action: 'order.updated', summary: 'x' });
    await recordAudit({ tenantId: TENANT, action: 'order.updated', summary: 'x' });

    expect(seteados).toHaveLength(2);
    expect(seteados[0]!.path).not.toBe(seteados[1]!.path);
  });
});

describe('recordAudit · con id determinístico (H-05)', () => {
  it('escribe en el id pedido', async () => {
    await recordAudit({ id: 'payment-confirmed-ord_1', tenantId: TENANT, action: 'payment.confirmed', summary: 'pago' });

    expect(creados).toHaveLength(1);
    expect(creados[0]!.path).toBe(`${COL}/payment-confirmed-ord_1`);
    expect(creados[0]!.data.id).toBe('payment-confirmed-ord_1');
  });

  it('repetirlo NO duplica NI reescribe la entrada original', async () => {
    await recordAudit({ id: 'payment-confirmed-ord_1', tenantId: TENANT, action: 'payment.confirmed', summary: 'original' });
    await recordAudit({ id: 'payment-confirmed-ord_1', tenantId: TENANT, action: 'payment.confirmed', summary: 'reparación meses después' });

    // Una sola escritura: la segunda choca con ALREADY_EXISTS y se ignora.
    expect(creados).toHaveLength(1);
    expect(seteados).toHaveLength(0);
    expect(creados[0]!.data.summary).toBe('original'); // el `at` original queda intacto
  });

  it('un «ya existe» NO se reporta como error: es el resultado esperado de repetir', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    await recordAudit({ id: 'payment-confirmed-ord_1', tenantId: TENANT, action: 'payment.confirmed', summary: 'a' });
    await recordAudit({ id: 'payment-confirmed-ord_1', tenantId: TENANT, action: 'payment.confirmed', summary: 'a' });

    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('cualquier OTRO fallo se sigue reportando, y jamás rompe al llamador', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    // Un fallo que NO es «ya existe» (permisos, red): el mock lo tira con código 7.
    fallaDistinta = true;

    await expect(
      recordAudit({ id: 'payment-confirmed-ord_2', tenantId: TENANT, action: 'payment.confirmed', summary: 'a' }),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
