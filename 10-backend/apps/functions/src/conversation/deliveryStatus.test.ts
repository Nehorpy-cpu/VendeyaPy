import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';

/**
 * ADR-0021 §1 — APLICACIÓN DE UN RECIBO DE ENTREGA SOBRE LA BURBUJA SALIENTE.
 * ============================================================================
 * Lo que este archivo fija, en orden de importancia:
 *  1. MONOTONÍA: pending=0 < sent=1 < delivered=2 < read=3. Un evento con rango ≤ al vigente es
 *     un no-op — los recibos repetidos o tardíos jamás retroceden el estado.
 *  2. `failed` solo aplica si el rango vigente es < delivered (un mensaje que el cliente ya
 *     recibió o leyó no puede volverse "falló"), y una vez `failed` es TERMINAL.
 *  3. Correlación por wamid dentro del cliente derivado de `recipientId` con la MISMA
 *     sanitización a dígitos que usa `process.ts` para `customerId`.
 *  4. Evento huérfano (wamid sin burbuja: viaMock, histórico) ⇒ no-op suave, sin escrituras.
 *  5. Los timestamps escritos son DEL PROVEEDOR (timestampSeconds), nunca del servidor.
 * Todo determinístico: cero IA, cero cuota.
 */

const docs = new Map<string, Record<string, unknown>>();

/** Escritura con claves con punto (update de Firestore): `deliveryAt.read` es merge de hoja. */
function escribir(path: string, data: Record<string, unknown>): void {
  const base: Record<string, unknown> = { ...(docs.get(path) ?? {}) };
  for (const [k, v] of Object.entries(data)) {
    if (k.includes('.')) {
      const partes = k.split('.');
      let cur = base;
      for (const p of partes.slice(0, -1)) {
        cur[p] = { ...((cur[p] as Record<string, unknown>) ?? {}) };
        cur = cur[p] as Record<string, unknown>;
      }
      cur[partes[partes.length - 1]!] = v;
    } else {
      base[k] = v;
    }
  }
  docs.set(path, base);
}

let escriturasDeUpdate = 0;

const refFor = (path: string) => ({
  id: path.split('/').pop() ?? '',
  path,
  get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
  update: async (d: Record<string, unknown>) => {
    escriturasDeUpdate++;
    escribir(path, d);
  },
});

/** Doble de Firestore con lo único que usa el módulo: query por campo + transacción. */
const fakeDb = {
  doc: (path: string) => refFor(path),
  collection: (path: string) => ({
    where: (field: string, _op: string, value: unknown) => ({
      limit: (n: number) => ({
        get: async () => {
          const hijos = [...docs.entries()]
            .filter(([p, d]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/') && d[field] === value)
            .slice(0, n)
            .map(([p, d]) => ({ id: p.split('/').pop(), ref: refFor(p), data: () => d }));
          return { empty: hijos.length === 0, docs: hijos };
        },
      }),
    }),
  }),
  runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
      update: (ref: { update: (d: Record<string, unknown>) => Promise<void> }, d: Record<string, unknown>) => void ref.update(d),
    }),
} as unknown as Firestore;

vi.mock('../lib/firebase.js', () => ({
  db: () => fakeDb,
  paths: {
    messages: (t: string, c: string) => `tenants/${t}/customers/${c}/messages`,
    customer: (t: string, c: string) => `tenants/${t}/customers/${c}`,
  },
}));

import { aplicarReciboDeEntrega } from './deliveryStatus.js';
import type { NormalizedDeliveryStatus } from '../meta/parseWebhook.js';

const TENANT = 't1';
const CLIENTE = '595991234567';
const P_MSG = `tenants/${TENANT}/customers/${CLIENTE}/messages/m1`;

const burbuja = (extra: Record<string, unknown> = {}) => ({
  id: 'm1',
  tenantId: TENANT,
  customerId: CLIENTE,
  direction: 'out',
  author: 'bot',
  text: 'hola',
  waMessageId: 'wamid.OUT1',
  deliveryStatus: 'pending',
  ...extra,
});

const recibo = (extra: Partial<NormalizedDeliveryStatus> = {}): NormalizedDeliveryStatus => ({
  waMessageId: 'wamid.OUT1',
  status: 'delivered',
  timestampSeconds: 1716750400,
  recipientId: CLIENTE,
  receivedVia: 'PNID_1',
  ...extra,
});

const msg = () => docs.get(P_MSG) as Record<string, unknown> & { deliveryAt?: Record<string, { toMillis: () => number }> };

beforeEach(() => {
  docs.clear();
  escriturasDeUpdate = 0;
});

describe('aplicarReciboDeEntrega — avance monotónico', () => {
  it('delivered sobre pending: aplica, con el timestamp DEL PROVEEDOR', async () => {
    docs.set(P_MSG, burbuja());
    const r = await aplicarReciboDeEntrega(fakeDb, TENANT, recibo());
    expect(r).toEqual({ aplicado: true, motivo: 'aplicado' });
    expect(msg()['deliveryStatus']).toBe('delivered');
    expect(msg().deliveryAt!['delivered']!.toMillis()).toBe(1716750400_000);
  });

  it('una burbuja HISTÓRICA sin deliveryStatus cuenta como pending: sent aplica', async () => {
    docs.set(P_MSG, burbuja({ deliveryStatus: undefined }));
    const r = await aplicarReciboDeEntrega(fakeDb, TENANT, recibo({ status: 'sent', timestampSeconds: 100 }));
    expect(r.aplicado).toBe(true);
    expect(msg()['deliveryStatus']).toBe('sent');
  });

  it('un sent TARDÍO no retrocede un delivered', async () => {
    docs.set(P_MSG, burbuja({ deliveryStatus: 'delivered' }));
    const r = await aplicarReciboDeEntrega(fakeDb, TENANT, recibo({ status: 'sent' }));
    expect(r.aplicado).toBe(false);
    expect(msg()['deliveryStatus']).toBe('delivered');
    expect(escriturasDeUpdate).toBe(0);
  });

  it('el MISMO evento repetido (reintento del webhook) es idempotente', async () => {
    docs.set(P_MSG, burbuja());
    await aplicarReciboDeEntrega(fakeDb, TENANT, recibo({ status: 'read', timestampSeconds: 300 }));
    const escriturasTrasPrimera = escriturasDeUpdate;
    const r2 = await aplicarReciboDeEntrega(fakeDb, TENANT, recibo({ status: 'read', timestampSeconds: 300 }));
    expect(r2.aplicado).toBe(false);
    expect(escriturasDeUpdate).toBe(escriturasTrasPrimera); // cero escrituras nuevas
    expect(msg()['deliveryStatus']).toBe('read');
  });

  it('cada estado alcanzado conserva su timestamp: sent → delivered → read acumula deliveryAt', async () => {
    docs.set(P_MSG, burbuja());
    await aplicarReciboDeEntrega(fakeDb, TENANT, recibo({ status: 'sent', timestampSeconds: 100 }));
    await aplicarReciboDeEntrega(fakeDb, TENANT, recibo({ status: 'delivered', timestampSeconds: 200 }));
    await aplicarReciboDeEntrega(fakeDb, TENANT, recibo({ status: 'read', timestampSeconds: 300 }));
    expect(msg()['deliveryStatus']).toBe('read');
    expect(msg().deliveryAt!['sent']!.toMillis()).toBe(100_000);
    expect(msg().deliveryAt!['delivered']!.toMillis()).toBe(200_000);
    expect(msg().deliveryAt!['read']!.toMillis()).toBe(300_000);
  });

  it('timestamp del proveedor ausente: el estado avanza pero deliveryAt NO se inventa', async () => {
    docs.set(P_MSG, burbuja());
    const r = await aplicarReciboDeEntrega(fakeDb, TENANT, recibo({ timestampSeconds: null }));
    expect(r.aplicado).toBe(true);
    expect(msg()['deliveryStatus']).toBe('delivered');
    expect(msg().deliveryAt?.['delivered']).toBeUndefined();
  });
});

describe('aplicarReciboDeEntrega — failed', () => {
  it('failed sobre sent: aplica, con el error SANEADO del proveedor', async () => {
    docs.set(P_MSG, burbuja({ deliveryStatus: 'sent' }));
    const r = await aplicarReciboDeEntrega(fakeDb, TENANT, recibo({
      status: 'failed', timestampSeconds: 500, error: { code: '470', detail: 'Re-engagement message' },
    }));
    expect(r.aplicado).toBe(true);
    expect(msg()['deliveryStatus']).toBe('failed');
    expect(msg()['deliveryError']).toEqual({ code: '470', detail: 'Re-engagement message' });
    expect(msg().deliveryAt!['failed']!.toMillis()).toBe(500_000);
  });

  it('failed sin error del proveedor escribe deliveryError null (no inventa detalle)', async () => {
    docs.set(P_MSG, burbuja());
    await aplicarReciboDeEntrega(fakeDb, TENANT, recibo({ status: 'failed' }));
    expect(msg()['deliveryStatus']).toBe('failed');
    expect(msg()['deliveryError']).toBeNull();
  });

  it('failed NO aplica sobre delivered ni sobre read: lo recibido no "des-sucede"', async () => {
    for (const vigente of ['delivered', 'read'] as const) {
      docs.set(P_MSG, burbuja({ deliveryStatus: vigente }));
      const r = await aplicarReciboDeEntrega(fakeDb, TENANT, recibo({ status: 'failed' }));
      expect(r.aplicado).toBe(false);
      expect(msg()['deliveryStatus']).toBe(vigente);
    }
  });

  it('failed es TERMINAL: un delivered posterior no lo revive', async () => {
    docs.set(P_MSG, burbuja({ deliveryStatus: 'failed' }));
    const r = await aplicarReciboDeEntrega(fakeDb, TENANT, recibo({ status: 'delivered' }));
    expect(r.aplicado).toBe(false);
    expect(msg()['deliveryStatus']).toBe('failed');
  });
});

describe('aplicarReciboDeEntrega — correlación e higiene', () => {
  it('recipientId con formato del proveedor se sanitiza a dígitos (misma regla que process.ts)', async () => {
    docs.set(P_MSG, burbuja());
    const r = await aplicarReciboDeEntrega(fakeDb, TENANT, recibo({ recipientId: '+595 991-234.567' }));
    expect(r.aplicado).toBe(true);
    expect(msg()['deliveryStatus']).toBe('delivered');
  });

  it('evento HUÉRFANO (wamid sin burbuja: viaMock o histórico): no-op suave, cero escrituras', async () => {
    docs.set(P_MSG, burbuja({ waMessageId: 'wamid.OTRO' }));
    const r = await aplicarReciboDeEntrega(fakeDb, TENANT, recibo());
    expect(r).toEqual({ aplicado: false, motivo: 'huerfano' });
    expect(escriturasDeUpdate).toBe(0);
    expect(msg()['deliveryStatus']).toBe('pending');
  });

  it('sin recipientId con dígitos o sin wamid: no-op declarado, sin consulta rara', async () => {
    const r1 = await aplicarReciboDeEntrega(fakeDb, TENANT, recibo({ recipientId: 'abc' }));
    expect(r1).toEqual({ aplicado: false, motivo: 'sin_datos' });
    const r2 = await aplicarReciboDeEntrega(fakeDb, TENANT, recibo({ waMessageId: '' }));
    expect(r2).toEqual({ aplicado: false, motivo: 'sin_datos' });
  });

  it('DEFENSIVO: un doc que matchee el wamid pero no sea saliente no se toca', async () => {
    docs.set(P_MSG, burbuja({ direction: 'in', author: 'customer' }));
    const r = await aplicarReciboDeEntrega(fakeDb, TENANT, recibo());
    expect(r.aplicado).toBe(false);
    expect(escriturasDeUpdate).toBe(0);
  });
});
