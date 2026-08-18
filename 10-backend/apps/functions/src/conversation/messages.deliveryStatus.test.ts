import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Timestamp, FieldValue } from 'firebase-admin/firestore';

/**
 * ADR-0021 — DOS REGLAS NUEVAS DE `appendMessage`, SIN TOCAR LAS VIGENTES.
 * =========================================================================
 * 1. §1 — ESTADO INICIAL DE ENTREGA: una burbuja saliente ACEPTADA por un proveedor real
 *    (author bot|seller, sin viaMock) nace `deliveryStatus:'pending'` («enviando»). Los viaMock
 *    NO llevan estado —nada salió a ningún proveedor—, los 'system' tampoco (son eventos
 *    internos) y los entrantes jamás tienen estado de entrega.
 * 2. §3 — DESARCHIVADO AUTOMÁTICO: un mensaje ENTRANTE sobre una conversación archivada limpia
 *    `archived/archivedAt/archivedBy` en la MISMA actualización del resumen (comportamiento
 *    WhatsApp). `softDeleted` NUNCA se toca en silencio.
 * El resto del contrato (id determinístico, create() idempotente, resumen monotónico,
 * unreadForSeller) lo fija `messages.monotonico.test.ts` y sigue vigente.
 */

const docs = new Map<string, Record<string, unknown>>();
let autoId = 0;
let escriturasResumen = 0;

const esPlano = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  typeof (v as { toMillis?: unknown }).toMillis !== 'function' &&
  !(v instanceof FieldValue);

/** Mismo doble de merge que messages.monotonico.test.ts (mapa vacío REEMPLAZA; increment emulado). */
function fusionar(base: Record<string, unknown>, data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(data)) {
    if (v instanceof FieldValue) {
      out[k] = (typeof out[k] === 'number' ? (out[k] as number) : 0) + 1;
    } else if (esPlano(v) && Object.keys(v).length === 0) {
      out[k] = {};
    } else if (esPlano(v) && esPlano(out[k])) {
      out[k] = fusionar(out[k] as Record<string, unknown>, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const refFor = (path: string) => ({
  id: path.split('/').pop() ?? '',
  path,
  get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
  set: async (d: Record<string, unknown>, o?: { merge?: boolean }) => {
    if (!path.includes('/messages/')) escriturasResumen++;
    docs.set(path, o?.merge === true ? fusionar(docs.get(path) ?? {}, d) : { ...d });
  },
  create: async (d: Record<string, unknown>) => {
    if (docs.has(path)) throw Object.assign(new Error('already exists'), { code: 6 });
    docs.set(path, { ...d });
  },
});

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => refFor(path),
    collection: (path: string) => ({ doc: (id?: string) => refFor(`${path}/${id ?? `auto_${++autoId}`}`) }),
  }),
  paths: {
    messages: (t: string, c: string) => `tenants/${t}/customers/${c}/messages`,
    customer: (t: string, c: string) => `tenants/${t}/customers/${c}`,
  },
}));

import { appendMessage } from './messages.js';

const TENANT = 't1';
const CLIENTE = '595000001234';
const RESUMEN = `tenants/${TENANT}/customers/${CLIENTE}`;
const T0 = Timestamp.fromMillis(1_000_000);

const conv = () => (docs.get(RESUMEN) as { conversation?: Record<string, unknown> } | undefined)?.conversation;
const burbujas = () => [...docs.entries()].filter(([p]) => p.startsWith(`${RESUMEN}/messages/`)).map(([, d]) => d);

beforeEach(() => {
  docs.clear();
  autoId = 0;
  escriturasResumen = 0;
});

describe('appendMessage — estado inicial de entrega (ADR-0021 §1)', () => {
  it('saliente del bot que salió a un proveedor real nace pending', async () => {
    await appendMessage(TENANT, CLIENTE, { direction: 'out', author: 'bot', text: 'hola', waMessageId: 'wamid.1' });
    expect(burbujas()[0]!['deliveryStatus']).toBe('pending');
  });

  it('saliente del vendedor (panel, live) también nace pending', async () => {
    await appendMessage(TENANT, CLIENTE, { direction: 'out', author: 'seller', text: 'hola', senderUid: 'u1', waMessageId: 'wamid.2' });
    expect(burbujas()[0]!['deliveryStatus']).toBe('pending');
  });

  it('viaMock NO lleva estado: nada salió a ningún proveedor', async () => {
    await appendMessage(TENANT, CLIENTE, { direction: 'out', author: 'bot', text: 'hola', viaMock: true });
    expect(burbujas()[0]!['deliveryStatus']).toBeUndefined();
  });

  it('los eventos de sistema y los entrantes no tienen estado de entrega', async () => {
    await appendMessage(TENANT, CLIENTE, { direction: 'out', author: 'system', text: 'el vendedor tomó el chat' });
    await appendMessage(TENANT, CLIENTE, { direction: 'in', author: 'customer', text: 'hola' });
    for (const b of burbujas()) expect(b['deliveryStatus']).toBeUndefined();
  });
});

describe('appendMessage — desarchivado automático (ADR-0021 §3)', () => {
  const archivada = (extra: Record<string, unknown> = {}) => {
    docs.set(RESUMEN, {
      id: CLIENTE,
      tenantId: TENANT,
      conversation: {
        lastMessageAt: T0,
        channel: 'whatsapp',
        archived: true,
        archivedAt: T0,
        archivedBy: 'uid_manager',
        unreadForSeller: 0,
        ...extra,
      },
    });
  };

  it('un entrante sobre conversación archivada la desarchiva en la MISMA actualización del resumen', async () => {
    archivada();
    escriturasResumen = 0;
    await appendMessage(TENANT, CLIENTE, { direction: 'in', author: 'customer', text: 'volví!', now: Timestamp.fromMillis(2_000_000) });
    const c = conv()!;
    expect(c['archived']).toBe(false);
    expect(c['archivedAt']).toBeNull();
    expect(c['archivedBy']).toBeNull();
    // Una sola escritura del resumen: el desarchivado no es un segundo round-trip.
    expect(escriturasResumen).toBe(1);
    // Y la última actividad refleja el entrante nuevo, como siempre.
    expect(c['lastMessagePreview']).toBe('volví!');
  });

  it('softDeleted NUNCA se revierte en silencio: el entrante desarchiva pero no restaura', async () => {
    archivada({ softDeleted: true, softDeletedAt: T0, softDeletedBy: 'uid_owner' });
    await appendMessage(TENANT, CLIENTE, { direction: 'in', author: 'customer', text: 'hola?' });
    const c = conv()!;
    expect(c['archived']).toBe(false);
    expect(c['softDeleted']).toBe(true);
    expect(c['softDeletedAt']).toStrictEqual(T0);
    expect(c['softDeletedBy']).toBe('uid_owner');
  });

  it('un SALIENTE no desarchiva (solo la vuelta del cliente lo hace)', async () => {
    archivada();
    await appendMessage(TENANT, CLIENTE, { direction: 'out', author: 'seller', text: 'te escribo yo' });
    expect(conv()!['archived']).toBe(true);
    expect(conv()!['archivedBy']).toBe('uid_manager');
  });

  it('un entrante sobre conversación NO archivada no escribe flags de archivo', async () => {
    await appendMessage(TENANT, CLIENTE, { direction: 'in', author: 'customer', text: 'hola' });
    const c = conv()!;
    expect('archived' in c).toBe(false);
    expect('archivedAt' in c).toBe(false);
  });

  it('el desarchivado aplica AUNQUE el mensaje sea viejo para el resumen (no es «última actividad»)', async () => {
    archivada({ lastMessageAt: Timestamp.fromMillis(5_000_000), lastMessagePreview: 'vigente' });
    await appendMessage(TENANT, CLIENTE, { direction: 'in', author: 'customer', text: 'entrante viejo', now: T0 });
    const c = conv()!;
    expect(c['archived']).toBe(false); // el hecho "el cliente volvió a escribir" no depende del reloj
    expect(c['lastMessagePreview']).toBe('vigente'); // pero el resumen sigue siendo monotónico
  });
});
