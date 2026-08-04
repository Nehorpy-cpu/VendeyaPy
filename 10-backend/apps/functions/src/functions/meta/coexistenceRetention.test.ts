/**
 * coexistenceRetention.test.ts — la purga que hace REAL la retención (ADR-0017 §4)
 * ================================================================================
 * El ADR pide dos cosas para el archivo de Coexistence: TTL corto y que «su payload se anula al
 * cerrar el evento — el mismo patrón que ya se usa con la ubicación exacta». La política TTL es
 * una decisión de infraestructura que se aplica al desplegar índices; este barrido es el mecanismo
 * del repo, y existe justamente porque no se puede depender de que alguien la haya aplicado a mano.
 *
 * El orden ANULAR → BORRAR no es cosmético: si el borrado falla (permisos, contención, corte), el
 * documento ya quedó sin las conversaciones adentro. Al revés, un borrado fallido deja 180 días de
 * chats privados intactos hasta la próxima corrida.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';

interface DocFalso {
  id: string;
  collection: string;
  expiresAtMs: number | null;
  fallaBorrado?: boolean;
}

const fake = vi.hoisted(() => {
  const documentos: Array<{ id: string; collection: string; expiresAtMs: number | null; fallaBorrado?: boolean }> = [];
  const ops: string[] = [];
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const consultas: Array<{ collection: string; field: string; op: string; limit: number }> = [];

  const db = () => ({
    collection: (collection: string) => {
      const query = (field: string, op: string, valor: { toMillis(): number }) => ({
        limit: (n: number) => ({
          get: async () => {
            consultas.push({ collection, field, op, limit: n });
            const corte = valor.toMillis();
            const docs = documentos
              .filter((d) => d.collection === collection && d.expiresAtMs !== null && d.expiresAtMs <= corte)
              .slice(0, n)
              .map((d) => ({
                id: d.id,
                ref: {
                  update: async (data: Record<string, unknown>) => {
                    ops.push(`update:${d.collection}/${d.id}`);
                    updates.push({ id: d.id, data });
                  },
                  delete: async () => {
                    if (d.fallaBorrado) {
                      ops.push(`delete-falla:${d.collection}/${d.id}`);
                      throw new Error('permiso denegado');
                    }
                    ops.push(`delete:${d.collection}/${d.id}`);
                  },
                },
              }));
            return { docs, size: docs.length, empty: docs.length === 0 };
          },
        }),
      });
      return { where: query };
    },
  });

  return {
    documentos,
    ops,
    updates,
    consultas,
    db,
    reset: () => {
      documentos.length = 0;
      ops.length = 0;
      updates.length = 0;
      consultas.length = 0;
    },
  };
});

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock('../../lib/firebase.js', () => ({ db: fake.db, storage: () => ({}), paths: {} }));
vi.mock('../../lib/logger.js', () => ({ logger: log }));

import { runCoexistenceRetentionPurge, COEXISTENCE_PURGE_BATCH_LIMIT } from './coexistenceRetention.js';
import { COEXISTENCE_HISTORY_COLLECTION, COEXISTENCE_APP_STATE_COLLECTION } from './webhookHttp.js';
import { COEXISTENCE_SHADOW_COLLECTION } from '../../meta/echoConsumer.js';

const AHORA = 1_754_400_000_000;

const sembrar = (d: DocFalso) => fake.documentos.push(d);

describe('purga de retención de Coexistence', () => {
  beforeEach(() => {
    fake.reset();
    log.warn.mockClear();
    log.info.mockClear();
    log.error.mockClear();
  });

  it('barre las TRES superficies de Coexistence (historial, agenda y observación)', async () => {
    const r = await runCoexistenceRetentionPurge({ nowMs: AHORA });
    expect(fake.consultas.map((c) => c.collection).sort()).toEqual(
      [COEXISTENCE_APP_STATE_COLLECTION, COEXISTENCE_HISTORY_COLLECTION, COEXISTENCE_SHADOW_COLLECTION].sort(),
    );
    for (const c of fake.consultas) {
      expect(c.field).toBe('expiresAt');
      expect(c.op).toBe('<=');
      expect(c.limit).toBe(COEXISTENCE_PURGE_BATCH_LIMIT);
    }
    expect(r.escaneados).toBe(0);
  });

  it('un documento vencido: primero se ANULA el payload, después se borra', async () => {
    sembrar({ id: 'h1', collection: COEXISTENCE_HISTORY_COLLECTION, expiresAtMs: AHORA - 1 });
    const r = await runCoexistenceRetentionPurge({ nowMs: AHORA });

    expect(fake.ops).toEqual([
      `update:${COEXISTENCE_HISTORY_COLLECTION}/h1`,
      `delete:${COEXISTENCE_HISTORY_COLLECTION}/h1`,
    ]);
    expect(fake.updates[0]!.data['payload']).toBeNull();
    expect(fake.updates[0]!.data['processingStatus']).toBe('ignored');
    expect(fake.updates[0]!.data['processedAt']).toBeTruthy();
    expect(r).toMatchObject({ escaneados: 1, anulados: 1, borrados: 1, fallidos: 0 });
  });

  it('si el borrado falla, el payload YA quedó anulado y la corrida sigue', async () => {
    sembrar({ id: 'h1', collection: COEXISTENCE_HISTORY_COLLECTION, expiresAtMs: AHORA - 1, fallaBorrado: true });
    sembrar({ id: 'h2', collection: COEXISTENCE_HISTORY_COLLECTION, expiresAtMs: AHORA - 1 });
    const r = await runCoexistenceRetentionPurge({ nowMs: AHORA });

    expect(fake.updates.map((u) => u.id).sort()).toEqual(['h1', 'h2']);
    expect(r.anulados).toBe(2);
    expect(r.borrados).toBe(1);
    expect(r.fallidos).toBe(1);
  });

  it('un documento VIGENTE no se toca (la consulta ya lo excluye)', async () => {
    sembrar({ id: 'vigente', collection: COEXISTENCE_HISTORY_COLLECTION, expiresAtMs: AHORA + 3_600_000 });
    const r = await runCoexistenceRetentionPurge({ nowMs: AHORA });
    expect(fake.ops).toEqual([]);
    expect(r.escaneados).toBe(0);
  });

  it('la agenda del vendedor se purga con el mismo criterio', async () => {
    sembrar({ id: 'a1', collection: COEXISTENCE_APP_STATE_COLLECTION, expiresAtMs: AHORA - 1 });
    const r = await runCoexistenceRetentionPurge({ nowMs: AHORA });
    expect(fake.ops).toEqual([
      `update:${COEXISTENCE_APP_STATE_COLLECTION}/a1`,
      `delete:${COEXISTENCE_APP_STATE_COLLECTION}/a1`,
    ]);
    expect(r.anulados).toBe(1);
  });

  it('la OBSERVACIÓN de `shadow` se purga anulando los campos donde vive el dato', async () => {
    // Acá el contenido NO está en `payload` (ese documento no tiene payload): está en `text` —el
    // mensaje íntegro del cliente o del vendedor— y en `customerId` —el teléfono completo—. Un
    // `payload: null` genérico habría dejado el documento entero y el resumen habría dicho
    // "anulado": la anulación tiene que nombrar los campos que realmente guardan el dato.
    sembrar({ id: 'o1', collection: COEXISTENCE_SHADOW_COLLECTION, expiresAtMs: AHORA - 1 });
    const r = await runCoexistenceRetentionPurge({ nowMs: AHORA });

    expect(fake.ops).toEqual([
      `update:${COEXISTENCE_SHADOW_COLLECTION}/o1`,
      `delete:${COEXISTENCE_SHADOW_COLLECTION}/o1`,
    ]);
    const anulado = fake.updates[0]!.data;
    expect(anulado['text']).toBeNull();
    expect(anulado['customerId']).toBeNull();
    expect(r).toMatchObject({ escaneados: 1, anulados: 1, borrados: 1, fallidos: 0 });
  });

  it('si el borrado de una observación falla, el teléfono y el texto YA no están', async () => {
    sembrar({ id: 'o1', collection: COEXISTENCE_SHADOW_COLLECTION, expiresAtMs: AHORA - 1, fallaBorrado: true });
    const r = await runCoexistenceRetentionPurge({ nowMs: AHORA });
    expect(fake.updates[0]!.data).toMatchObject({ text: null, customerId: null });
    expect(r).toMatchObject({ anulados: 1, borrados: 0, fallidos: 1 });
  });

  it('el corte se calcula con el reloj recibido (nada de fechas mágicas)', async () => {
    sembrar({ id: 'h1', collection: COEXISTENCE_HISTORY_COLLECTION, expiresAtMs: AHORA });
    await runCoexistenceRetentionPurge({ nowMs: AHORA - 1 });
    expect(fake.ops).toEqual([]);
    await runCoexistenceRetentionPurge({ nowMs: AHORA });
    expect(fake.ops).toContain(`update:${COEXISTENCE_HISTORY_COLLECTION}/h1`);
  });

  it('los logs no llevan identificadores del cliente', async () => {
    sembrar({ id: 'h1', collection: COEXISTENCE_HISTORY_COLLECTION, expiresAtMs: AHORA - 1 });
    await runCoexistenceRetentionPurge({ nowMs: AHORA });
    const todo = JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
    expect(todo).not.toContain('h1');
  });

  it('el reloj por defecto es el del sistema (Timestamp válido)', async () => {
    sembrar({ id: 'h1', collection: COEXISTENCE_HISTORY_COLLECTION, expiresAtMs: Date.now() - 1_000 });
    const r = await runCoexistenceRetentionPurge();
    expect(r.anulados).toBe(1);
    expect(Timestamp.now().toMillis()).toBeGreaterThan(0);
  });
});
