import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Timestamp, FieldValue } from 'firebase-admin/firestore';

/**
 * H7 (Codex Security) / ADR-0017 §2 — EL RESUMEN DE CONVERSACIÓN ES MONOTÓNICO.
 * ==============================================================================
 * `appendMessage` escribía el mensaje y DESPUÉS el resumen (`conversation.channel`,
 * `conversation.receivedVia`, `lastMessageAt`…) sin comparar versión: una operación VIEJA que
 * termina tarde reemplazaba el canal vigente. Ese resumen no es cosmético — es lo que lee
 * `resolverCanalDeConversacion` para decidir por dónde SALE la próxima respuesta manual: un
 * resumen pisado con el canal viejo rutea al vendedor contra la conversación equivocada.
 *
 * La regla que fija este archivo: los campos de «última actividad» (lastMessageAt, preview,
 * dirección, channel, receivedVia) solo se pisan si el mensaje es MÁS NUEVO O IGUAL que el
 * `lastMessageAt` vigente. En EMPATE exacto de timestamp gana la operación que termina última:
 * es el comportamiento vigente para los pares in/out agrupados con el MISMO reloj (`input.now`
 * compartido), donde el out se escribe segundo y debe quedar como último mensaje del resumen.
 * Lo que NO es última actividad (unread con increment, state/humanTakeover explícitos) se aplica
 * igual: son decisiones del llamador, no derivados del orden de llegada.
 */

const docs = new Map<string, Record<string, unknown>>();
let autoId = 0;

/** ¿Mapa plano mergeable? (los Timestamp y sentinels de Firestore son hojas, no mapas). */
const esPlano = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  typeof (v as { toMillis?: unknown }).toMillis !== 'function' &&
  !(v instanceof FieldValue);

/**
 * Merge profundo estilo `set(..., {merge:true})` de Firestore, con soporte de increment(1).
 *
 * UN MAPA VACÍO **REEMPLAZA**, no fusiona. No es un detalle del doble: es la semántica REAL del
 * SDK, verificada contra `@google-cloud/firestore@7.11.6` — `set({conversation:{}},{merge:true})`
 * serializa `updateMask: ["conversation"]` con `mapValue:{}` (reemplazo del mapa entero), mientras
 * que `{conversation:{state:'X'}}` serializa `updateMask: ["conversation.state"]` (merge de hoja).
 * Un doble que fusionara el vacío haría pasar en verde un borrado total del resumen del cliente.
 */
function fusionar(base: Record<string, unknown>, data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(data)) {
    if (v instanceof FieldValue) {
      // appendMessage solo usa FieldValue.increment(1): alcanza con emular exactamente eso.
      out[k] = (typeof out[k] === 'number' ? (out[k] as number) : 0) + 1;
    } else if (esPlano(v) && Object.keys(v).length === 0) {
      out[k] = {}; // updateMask apunta al mapa entero ⇒ reemplazo
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

const T_VIEJO = Timestamp.fromMillis(1_000_000);
const T_NUEVO = Timestamp.fromMillis(2_000_000);

const conv = () => (docs.get(RESUMEN) as { conversation?: Record<string, unknown> } | undefined)?.conversation;
const mensajesPersistidos = () => [...docs.keys()].filter((p) => p.startsWith(`${RESUMEN}/messages/`)).length;

beforeEach(() => {
  docs.clear();
  autoId = 0;
});

describe('appendMessage — el resumen es monotónico (H7)', () => {
  it('una finalización VIEJA que termina última NO pisa canal/receivedVia del más nuevo', async () => {
    // El más NUEVO termina primero: la conversación vigente es de Instagram (sin receivedVia).
    await appendMessage(TENANT, CLIENTE, { direction: 'out', author: 'bot', text: 'respuesta vigente', channel: 'instagram', now: T_NUEVO });
    // La operación VIEJA (WhatsApp, con número receptor) termina DESPUÉS.
    await appendMessage(TENANT, CLIENTE, { direction: 'in', author: 'customer', text: 'mensaje viejo', channel: 'whatsapp', receivedVia: 'PN_VIEJO', now: T_VIEJO });

    const c = conv();
    // El corazón del defecto: el canal vigente del resumen es el del mensaje MÁS NUEVO.
    expect(c?.['channel']).toBe('instagram');
    expect(c?.['receivedVia']).toBeUndefined();
    expect((c?.['lastMessageAt'] as Timestamp).toMillis()).toBe(T_NUEVO.toMillis());
    expect(c?.['lastMessagePreview']).toBe('respuesta vigente');
    expect(c?.['lastMessageDirection']).toBe('out');
    // El mensaje viejo SÍ persiste en el historial — solo el resumen es monotónico.
    expect(mensajesPersistidos()).toBe(2);
  });

  it('dos números de WhatsApp: el `receivedVia` vigente sobrevive a la finalización vieja', async () => {
    await appendMessage(TENANT, CLIENTE, { direction: 'in', author: 'customer', text: 'nuevo', channel: 'whatsapp', receivedVia: 'PN_NUEVO', now: T_NUEVO });
    await appendMessage(TENANT, CLIENTE, { direction: 'in', author: 'customer', text: 'viejo', channel: 'whatsapp', receivedVia: 'PN_VIEJO', now: T_VIEJO });

    // El mensaje manual posterior rutea por este campo: tiene que ser el del número MÁS NUEVO.
    expect(conv()?.['receivedVia']).toBe('PN_NUEVO');
  });

  it('EMPATE de timestamp: gana la operación que termina última (pares in/out con el mismo reloj)', async () => {
    const reloj = Timestamp.fromMillis(1_500_000);
    await appendMessage(TENANT, CLIENTE, { direction: 'in', author: 'customer', text: 'pregunta', channel: 'whatsapp', now: reloj });
    await appendMessage(TENANT, CLIENTE, { direction: 'out', author: 'bot', text: 'respuesta', channel: 'whatsapp', now: reloj });

    // El motor agrupa in/out con el MISMO `now`: el out (segundo) debe quedar como último.
    expect(conv()?.['lastMessageDirection']).toBe('out');
    expect(conv()?.['lastMessagePreview']).toBe('respuesta');
  });

  it('lo que NO es última actividad se aplica igual en una finalización vieja: unread, state y humanTakeover', async () => {
    await appendMessage(TENANT, CLIENTE, { direction: 'out', author: 'bot', text: 'vigente', channel: 'instagram', now: T_NUEVO });
    await appendMessage(TENANT, CLIENTE, {
      direction: 'in', author: 'customer', text: 'viejo', channel: 'whatsapp', now: T_VIEJO,
      countUnread: true, state: 'IDLE', humanTakeover: true,
    });

    const c = conv();
    // El contador es un increment (conmutativo) y state/humanTakeover son decisiones del llamador.
    expect(c?.['unreadForSeller']).toBe(1);
    expect(c?.['state']).toBe('IDLE');
    expect(c?.['humanTakeover']).toBe(true);
    // Pero la última actividad sigue siendo la del mensaje más nuevo.
    expect((c?.['lastMessageAt'] as Timestamp).toMillis()).toBe(T_NUEVO.toMillis());
    expect(c?.['channel']).toBe('instagram');
  });

  it('CERO REGRESIÓN: en orden normal (viejo primero, nuevo después) el resumen refleja el último', async () => {
    await appendMessage(TENANT, CLIENTE, { direction: 'in', author: 'customer', text: 'viejo', channel: 'whatsapp', receivedVia: 'PN_VIEJO', now: T_VIEJO });
    await appendMessage(TENANT, CLIENTE, { direction: 'in', author: 'customer', text: 'nuevo', channel: 'whatsapp', receivedVia: 'PN_NUEVO', now: T_NUEVO });

    const c = conv();
    expect(c?.['receivedVia']).toBe('PN_NUEVO');
    expect((c?.['lastMessageAt'] as Timestamp).toMillis()).toBe(T_NUEVO.toMillis());
    expect(c?.['lastMessagePreview']).toBe('nuevo');
  });

  it('CERO REGRESIÓN: primer mensaje de un cliente sin resumen previo escribe todo', async () => {
    await appendMessage(TENANT, CLIENTE, { direction: 'in', author: 'customer', text: 'hola', channel: 'whatsapp', receivedVia: 'PN_1', now: T_VIEJO });

    const c = conv();
    expect(c?.['channel']).toBe('whatsapp');
    expect(c?.['receivedVia']).toBe('PN_1');
    expect(c?.['lastMessagePreview']).toBe('hola');
  });
});

describe('un mensaje VIEJO sin decisiones no puede BORRAR el resumen (CRITICAL de la review final)', () => {
  it('el resumen conserva receivedVia, channel, humanTakeover, state y unreadForSeller', async () => {
    // Estado real de una conversación viva: el vendedor la tomó, entra por un número concreto.
    docs.set(RESUMEN, {
      id: CLIENTE,
      tenantId: TENANT,
      conversation: {
        lastMessageAt: T_VIEJO,
        channel: 'whatsapp',
        receivedVia: 'PN_QUE_VENDE',
        humanTakeover: true,
        state: 'AWAITING_PAYMENT',
        unreadForSeller: 3,
      },
    });

    // Un appendMessage VIEJO y sin decisiones explícitas: es exactamente la forma que usan el
    // mensaje manual del panel y la ingesta de adjuntos (capturan `now` y escriben dos
    // round-trips después). Con el guard monotónico, `conv` queda VACÍO — y un mapa vacío con
    // merge REEMPLAZA: el resumen entero se borraba, dejando la conversación sin número receptor
    // (el mensaje manual siguiente saldría por el número equivocado) y sin takeover.
    await appendMessage(TENANT, CLIENTE, { direction: 'out', author: 'seller', text: 'hola', now: Timestamp.fromMillis(999_000) });

    const c = conv() ?? {};
    expect(c['receivedVia']).toBe('PN_QUE_VENDE');
    expect(c['channel']).toBe('whatsapp');
    expect(c['humanTakeover']).toBe(true);
    expect(c['state']).toBe('AWAITING_PAYMENT');
    expect(c['unreadForSeller']).toBe(3);
    // Y lo que el guard SÍ tiene que impedir: que el mensaje viejo se declare el último.
    expect((c['lastMessageAt'] as Timestamp).toMillis()).toBe(T_VIEJO.toMillis());
  });
});
